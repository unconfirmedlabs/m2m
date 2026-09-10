use crate::{chain::Chain, protocol::*, service::ServiceHandler, store};
use anyhow::{Context, Result, bail, ensure};
use iroh::{
    Endpoint, EndpointAddr, SecretKey,
    endpoint::{Connection, presets},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
use tokio::time::timeout;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Ticket {
    pub version: u8,
    pub agent: Address,
    pub endpoint: EndpointAddr,
}

pub async fn endpoint(key: SecretKey, relay: bool) -> Result<Endpoint> {
    endpoint_with_mode(key, relay, false).await
}

pub async fn endpoint_with_mode(key: SecretKey, relay: bool, relay_only: bool) -> Result<Endpoint> {
    let mut builder = if relay || relay_only {
        Endpoint::builder(presets::N0)
    } else {
        Endpoint::builder(presets::Minimal)
    };
    if relay_only {
        builder = builder.clear_ip_transports();
    }
    Ok(builder
        .secret_key(key)
        .alpns(vec![ALPN.to_vec()])
        .bind()
        .await?)
}

pub async fn request(
    endpoint: &Endpoint,
    ticket: &Ticket,
    expected_key: &[u8],
    req: &Request,
) -> Result<Response> {
    req.validate()?;
    ensure!(ticket.version == VERSION, "unsupported ticket version");
    ensure!(
        ticket.endpoint.id.as_bytes().as_slice() == expected_key,
        "ticket does not match authorized endpoint"
    );
    let start = Instant::now();
    let conn = timeout(
        Duration::from_secs(30),
        endpoint.connect(ticket.endpoint.clone(), ALPN),
    )
    .await??;
    ensure!(
        conn.remote_id().as_bytes().as_slice() == expected_key,
        "connected peer has wrong key"
    );
    eprintln!(
        "{}",
        json!({"event":"connected", "elapsed_ms":start.elapsed().as_millis(), "peer": conn.remote_id().to_string(), "paths":format!("{:?}",conn.paths())})
    );
    let result = timeout(Duration::from_secs(180), async {
        let (mut send, mut recv) = conn.open_bi().await?;
        send.write_all(&serde_json::to_vec(req)?).await?;
        send.finish()?;
        let bytes = recv.read_to_end(MAX_FRAME).await?;
        let response: Response = serde_json::from_slice(&bytes)?;
        if let Response::Error { code, message } = &response {
            bail!("provider {code}: {message}");
        }
        Ok::<_, anyhow::Error>(response)
    })
    .await
    .context("provider timed out; recover the existing agreement")?;
    conn.close(0u32.into(), b"complete");
    result
}

pub struct Provider {
    pub chain: Chain,
    pub agent: Address,
    pub key: SecretKey,
    pub service: Box<dyn ServiceHandler>,
    pub price: u64,
    pub lifetime_ms: u64,
    pub state: PathBuf,
    pub gas_signer: PathBuf,
    pub drop_after_delivery: bool,
    pub drop_after_settle: bool,
}
impl Provider {
    async fn escrow_for_peer(&self, id: Address, peer: &[u8]) -> Result<crate::chain::Escrow> {
        let escrow = self.chain.escrow(id).await?;
        ensure!(
            escrow.quote.provider == self.agent,
            "escrow belongs to another provider"
        );
        ensure!(
            escrow.quote.buyer_key == peer,
            "peer is not the escrow buyer"
        );
        ensure!(
            escrow.quote.provider_key == self.key.public().as_bytes(),
            "provider key is not authorized for this escrow"
        );
        escrow.quote.validate()?;
        Ok(escrow)
    }
    pub async fn handle(&self, req: Request, peer: &[u8]) -> Result<Response> {
        req.validate()?;
        match req {
            Request::Quote {
                buyer,
                nonce,
                result_hash,
                ..
            } => {
                ensure!(
                    result_hash == self.service.result_hash(),
                    "fixture hash is not available"
                );
                let b = self.chain.agent(buyer).await?;
                let p = self.chain.agent(self.agent).await?;
                ensure!(
                    b.endpoint_key == peer,
                    "peer is not the registered buyer endpoint"
                );
                ensure!(
                    p.endpoint_key == self.key.public().as_bytes(),
                    "provider endpoint has been replaced"
                );
                ensure!(
                    nonce == b.next_nonce,
                    "buyer nonce is not current; recover existing purchase"
                );
                let now = self.chain.clock().await?;
                let q = Quote {
                    purpose: b"m2m/quote/v1".to_vec(),
                    network: self.chain.0.chain_id.as_bytes().to_vec(),
                    package_id: self.chain.0.package_id,
                    deployment: self.chain.0.deployment,
                    buyer,
                    provider: self.agent,
                    buyer_key: b.endpoint_key,
                    provider_key: p.endpoint_key,
                    refund: b.controller,
                    payee: p.controller,
                    nonce,
                    request_hash: request_hash(&result_hash),
                    result_hash,
                    amount: self.price,
                    quote_expires_ms: now
                        .checked_add(self.lifetime_ms / 2)
                        .context("deadline overflow")?,
                    deadline_ms: now
                        .checked_add(self.lifetime_ms)
                        .context("deadline overflow")?,
                };
                q.validate()?;
                let signature = sign(&q, &self.key)?;
                Ok(Response::Quote {
                    signed: Box::new(SignedQuote {
                        quote: q,
                        signature,
                    }),
                })
            }
            Request::Deliver { escrow: id, .. } => {
                let escrow = self.escrow_for_peer(id, peer).await?;
                ensure!(escrow.status == 0, "escrow is terminal");
                ensure!(
                    self.chain.clock().await? < escrow.quote.deadline_ms,
                    "escrow expired"
                );
                let path = self.state.join("results").join(format!("{id}.json"));
                let start = Instant::now();
                let cached = path.exists();
                let bytes: Vec<u8> = if cached {
                    store::read(&path)?
                } else {
                    ensure!(
                        self.service.result_hash() == escrow.quote.result_hash,
                        "current fixture differs from agreement"
                    );
                    let bytes = self.service.execute()?;
                    ensure!(
                        bytes.len() <= MAX_FILE && hash(&bytes) == escrow.quote.result_hash,
                        "handler result differs from agreement"
                    );
                    store::write(&path, &bytes)?;
                    bytes
                };
                ensure!(
                    hash(&bytes) == escrow.quote.result_hash && bytes.len() <= MAX_FILE,
                    "cached result is corrupt"
                );
                eprintln!(
                    "{}",
                    json!({"event":"service_result", "escrow":id,
                    "cached":cached, "elapsed_us":start.elapsed().as_micros()})
                );
                Ok(Response::Result { escrow: id, bytes })
            }
            Request::Accept { receipt, .. } => {
                let id = receipt.acceptance.escrow;
                let escrow = self.escrow_for_peer(id, peer).await?;
                ensure!(
                    receipt.acceptance == escrow.quote.acceptance(id)?,
                    "receipt does not match agreement"
                );
                verify(
                    &receipt.acceptance,
                    &receipt.signature,
                    &escrow.quote.buyer_key,
                )?;
                if escrow.status == 1 {
                    return Ok(Response::Settled {
                        escrow: id,
                        digest: escrow
                            .terminal_digest
                            .context("missing settlement digest")?,
                    });
                }
                ensure!(escrow.status == 0, "escrow was refunded");
                let dir = self.state.join("receipts");
                store::write(&dir.join(format!("{id}.json")), &receipt)?;
                let result: Result<Value> = self
                    .chain
                    .call(json!({
                        "action":"settle", "id":id, "result_hash":receipt.acceptance.result_hash,
                        "signature":receipt.signature, "signer_file":self.gas_signer,
                        "journal":dir.join(format!("{id}.tx.json")),
                    }))
                    .await;
                match result {
                    Ok(tx) => Ok(Response::Settled {
                        escrow: id,
                        digest: tx["digest"]
                            .as_str()
                            .context("missing tx digest")?
                            .to_owned(),
                    }),
                    Err(error) => {
                        let recovered = self.chain.escrow(id).await?;
                        if recovered.status == 1 {
                            Ok(Response::Settled {
                                escrow: id,
                                digest: recovered.terminal_digest.context("missing digest")?,
                            })
                        } else {
                            Err(error)
                        }
                    }
                }
            }
        }
    }

    /// Serial handling keeps the PoC gas signer and per-job persistence race-free.
    pub async fn connection(&self, conn: Connection) -> Result<()> {
        let (mut send, mut recv) = timeout(Duration::from_secs(10), conn.accept_bi()).await??;
        let response = async {
            let raw = timeout(Duration::from_secs(10), recv.read_to_end(MAX_FRAME)).await??;
            let req: Request = serde_json::from_slice(&raw)?;
            let should_drop = (self.drop_after_delivery && matches!(req, Request::Deliver { .. }))
                || (self.drop_after_settle && matches!(req, Request::Accept { .. }));
            let response = self.handle(req, conn.remote_id().as_bytes()).await?;
            Ok::<_, anyhow::Error>((response, should_drop))
        }
        .await;
        let (response, drop_reply) = match response {
            Ok(value) => value,
            Err(error) => {
                eprintln!("provider request error: {error:#}");
                (
                    Response::Error {
                        code: "request_failed".into(),
                        message: error.to_string(),
                    },
                    false,
                )
            }
        };
        if drop_reply {
            conn.close(1u32.into(), b"injected lost reply");
            return Ok(());
        }
        send.write_all(&serde_json::to_vec(&response)?).await?;
        send.finish()?;
        let _ = timeout(Duration::from_secs(5), conn.closed()).await;
        Ok(())
    }
}
