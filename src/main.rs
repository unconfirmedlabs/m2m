use anyhow::{Context, Result, bail, ensure};
use clap::{Parser, Subcommand};
use iroh::SecretKey;
use m2m::{
    chain::{Chain, Config},
    protocol::*,
    service::FixedFile,
    store::{self, Store},
    transport::{self, Provider, Ticket},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    path::PathBuf,
    time::{Duration, Instant},
};

#[derive(Parser)]
#[command(about = "Experimental Iroh + Sui paid-file exchange")]
struct Cli {
    #[arg(long, default_value = ".m2m/buyer", global = true)]
    state: PathBuf,
    #[command(subcommand)]
    command: Commands,
}
#[derive(Subcommand)]
enum Commands {
    Init {
        #[arg(long)]
        chain: PathBuf,
        #[arg(long)]
        signer: PathBuf,
    },
    /// Print public identity, never private key material.
    Identity,
    Serve {
        #[arg(long)]
        file: PathBuf,
        #[arg(long)]
        gas_signer: PathBuf,
        #[arg(long)]
        ticket: PathBuf,
        #[arg(long, default_value_t = 1000)]
        price: u64,
        #[arg(long, default_value_t = 300_000)]
        lifetime_ms: u64,
        #[arg(long)]
        relay: bool,
        /// Disable direct IP paths to exercise relay transport explicitly.
        #[arg(long)]
        relay_only: bool,
        #[arg(long)]
        drop_after_delivery: bool,
        #[arg(long)]
        drop_after_settle: bool,
    },
    Buy {
        #[arg(long)]
        provider: Address,
        #[arg(long)]
        ticket: PathBuf,
        #[arg(long)]
        expected_file: PathBuf,
        #[arg(long)]
        signer: PathBuf,
        #[arg(long)]
        request: String,
        #[arg(long, default_value_t = 1000)]
        max_price: u64,
        #[arg(long)]
        relay: bool,
        #[arg(long)]
        relay_only: bool,
        /// Inject a stop, then rerun the same request to recover.
        #[arg(long, value_parser=["funded","accepted"])]
        stop_after: Option<String>,
    },
    Status {
        #[arg(long)]
        request: String,
    },
    Refund {
        #[arg(long)]
        request: String,
        #[arg(long)]
        gas_signer: PathBuf,
    },
    /// Fixed public signing vectors; deterministic keys never fund a wallet.
    Vectors,
}
#[derive(Clone, Serialize, Deserialize)]
struct Identity {
    agent: Address,
    endpoint: String,
    chain: Config,
}
#[derive(Serialize, Deserialize)]
struct KeyFile {
    secret: String,
}
#[derive(Serialize, Deserialize)]
struct Purchase {
    provider: Address,
    result_hash: Vec<u8>,
    #[serde(with = "decimal")]
    max_price: u64,
    #[serde(with = "decimal")]
    nonce: u64,
    quote: Option<SignedQuote>,
    escrow: Option<Address>,
    receipt: Option<SignedAcceptance>,
    settlement: Option<String>,
}
fn job_name(id: &str) -> Result<String> {
    ensure!(
        !id.is_empty()
            && id.len() <= 64
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        "request ID must be 1-64 ASCII letters, digits, '-' or '_'"
    );
    Ok(format!("purchases/{id}.json"))
}
fn load_key(s: &Store) -> Result<SecretKey> {
    let file: KeyFile = s.read("endpoint-key.json")?;
    let bytes: [u8; 32] = hex::decode(file.secret)?
        .try_into()
        .map_err(|_| anyhow::anyhow!("invalid private endpoint key"))?;
    Ok(SecretKey::from_bytes(&bytes))
}
fn output(value: impl Serialize) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(&value)?);
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let cli = Cli::parse();
    if matches!(cli.command, Commands::Vectors) {
        return vectors();
    }
    let s = Store::open(cli.state)?;
    if let Commands::Init { chain, signer } = &cli.command {
        ensure!(
            !s.path("identity.json").exists(),
            "identity already initialized"
        );
        let config: Config = store::read(chain)?;
        let key = if s.path("endpoint-key.json").exists() {
            load_key(&s)?
        } else {
            let key = SecretKey::generate();
            s.write(
                "endpoint-key.json",
                &KeyFile {
                    secret: hex::encode(key.to_bytes()),
                },
            )?;
            key
        };
        let journal = s.path("registration.tx.json");
        let agent = if journal.exists() {
            let tx: Value = store::read(&journal)?;
            ensure!(
                tx["state"] == "confirmed",
                "registration outcome uncertain; inspect registration.tx.json before retrying"
            );
            tx["created"]
                .as_array()
                .context("missing registration effects")?
                .iter()
                .find(|o| {
                    o["type"]
                        .as_str()
                        .is_some_and(|t| t.ends_with("::exchange::Agent"))
                })
                .and_then(|o| o["id"].as_str())
                .context("missing registered Agent")?
                .parse()?
        } else {
            let response: Value = Chain(config.clone()).call(json!({"action":"register", "endpoint":key.public().as_bytes().to_vec(),
                "signer_file":fs::canonicalize(signer)?, "journal":fs::canonicalize(&s.root)?.join("registration.tx.json")})).await?;
            response["agent"]
                .as_str()
                .context("missing Agent ID")?
                .parse()?
        };
        let identity = Identity {
            agent,
            endpoint: key.public().to_string(),
            chain: config,
        };
        s.write("identity.json", &identity)?;
        return output(identity);
    }
    let identity: Identity = s.read("identity.json")?;
    let chain = Chain(identity.chain.clone());
    let key = load_key(&s)?;
    match cli.command {
        Commands::Identity => output(identity)?,
        Commands::Serve {
            file,
            gas_signer,
            ticket,
            price,
            lifetime_ms,
            relay,
            relay_only,
            drop_after_delivery,
            drop_after_settle,
        } => {
            let bytes = fs::read(file)?;
            ensure!(bytes.len() <= MAX_FILE, "fixture exceeds 64 KiB");
            ensure!(
                price > 0 && (10_000..=3_600_000).contains(&lifetime_ms),
                "invalid price/lifetime"
            );
            let agent = chain.agent(identity.agent).await?;
            ensure!(
                agent.endpoint_key == key.public().as_bytes(),
                "local endpoint is not the registered provider"
            );
            let endpoint = transport::endpoint_with_mode(key.clone(), relay, relay_only).await?;
            if relay || relay_only {
                tokio::time::timeout(Duration::from_secs(30), endpoint.online()).await?;
            }
            let advertised = Ticket {
                version: VERSION,
                agent: identity.agent,
                endpoint: endpoint.addr(),
            };
            store::write(&ticket, &advertised)?;
            output(
                json!({"ready":true,"agent":identity.agent,"ticket":ticket,"result_hash":hex::encode(hash(&bytes))}),
            )?;
            let provider = Provider {
                chain,
                agent: identity.agent,
                key,
                service: Box::new(FixedFile::new(bytes)?),
                price,
                lifetime_ms,
                state: fs::canonicalize(&s.root)?,
                gas_signer: fs::canonicalize(gas_signer)?,
                drop_after_delivery,
                drop_after_settle,
            };
            loop {
                tokio::select! {
                    _ = tokio::signal::ctrl_c() => break,
                    incoming = endpoint.accept() => {
                        let Some(incoming) = incoming else { break };
                        match tokio::time::timeout(Duration::from_secs(10), incoming).await {
                            Ok(Ok(conn)) => if let Err(error) = provider.connection(conn).await { eprintln!("connection failed: {error:#}"); },
                            other => eprintln!("handshake failed: {other:?}"),
                        }
                    }
                }
            }
            endpoint.close().await;
        }
        Commands::Buy {
            provider,
            ticket,
            expected_file,
            signer,
            request,
            max_price,
            relay,
            relay_only,
            stop_after,
        } => {
            let start = Instant::now();
            let name = job_name(&request)?;
            let expected = fs::read(expected_file)?;
            ensure!(expected.len() <= MAX_FILE, "expected file exceeds 64 KiB");
            let result_hash = hash(&expected);
            let mut job: Purchase = if s.path(&name).exists() {
                s.read(&name)?
            } else {
                let agent = chain.agent(identity.agent).await?;
                let value = Purchase {
                    provider,
                    result_hash: result_hash.clone(),
                    max_price,
                    nonce: agent.next_nonce,
                    quote: None,
                    escrow: None,
                    receipt: None,
                    settlement: None,
                };
                s.write(&name, &value)?;
                value
            };
            ensure!(
                job.provider == provider
                    && job.result_hash == result_hash
                    && job.max_price == max_price,
                "request ID already belongs to different purchase parameters"
            );
            if let Some(id) = chain.lookup(identity.agent, job.nonce).await? {
                let escrow = chain.escrow(id).await?;
                let quote = job
                    .quote
                    .as_ref()
                    .context("onchain nonce exists without this request's persisted quote")?;
                ensure!(
                    escrow.quote == quote.quote,
                    "onchain nonce belongs to a different agreement"
                );
                job.escrow = Some(id);
                if escrow.status == 1 {
                    job.settlement = escrow.terminal_digest;
                    s.write(&name, &job)?;
                    return output(
                        json!({"request":request,"escrow":id,"status":"settled","digest":job.settlement,"recovered":true}),
                    );
                }
                ensure!(escrow.status == 0, "purchase was refunded");
                s.write(&name, &job)?;
            }
            let ticket: Ticket = store::read(&ticket)?;
            ensure!(
                ticket.agent == provider,
                "ticket advertises a different Agent"
            );
            let endpoint = transport::endpoint_with_mode(key.clone(), relay, relay_only).await?;
            if job.quote.is_none() {
                let p = chain.agent(provider).await?;
                let b = chain.agent(identity.agent).await?;
                ensure!(
                    b.endpoint_key == key.public().as_bytes(),
                    "buyer key is no longer registered"
                );
                let response = transport::request(
                    &endpoint,
                    &ticket,
                    &p.endpoint_key,
                    &Request::Quote {
                        version: VERSION,
                        buyer: identity.agent,
                        nonce: job.nonce,
                        result_hash: result_hash.clone(),
                    },
                )
                .await?;
                let Response::Quote { signed } = response else {
                    bail!("expected quote")
                };
                let q = &signed.quote;
                q.validate()?;
                verify(q, &signed.signature, &p.endpoint_key)?;
                ensure!(
                    q.network == chain.0.chain_id.as_bytes()
                        && q.package_id == chain.0.package_id
                        && q.deployment == chain.0.deployment,
                    "quote domain mismatch"
                );
                ensure!(
                    q.buyer == identity.agent
                        && q.provider == provider
                        && q.buyer_key == b.endpoint_key
                        && q.provider_key == p.endpoint_key,
                    "quote parties mismatch"
                );
                ensure!(
                    q.refund == b.controller && q.payee == p.controller,
                    "quote destinations mismatch"
                );
                ensure!(
                    q.nonce == job.nonce && q.result_hash == result_hash && q.amount <= max_price,
                    "quote exceeds requested terms"
                );
                job.quote = Some(*signed);
                s.write(&name, &job)?;
            }
            let signed = job.quote.as_ref().context("missing quote")?.clone();
            if job.escrow.is_none() {
                ensure!(
                    chain.clock().await? < signed.quote.quote_expires_ms,
                    "unfunded quote expired; use a new request ID"
                );
                let funded: Value = chain.call(json!({"action":"fund","quote":signed.quote,"signature":signed.signature,
                    "signer_file":fs::canonicalize(signer)?, "journal":fs::canonicalize(&s.root)?.join(format!("purchases/{request}.fund.tx.json"))})).await?;
                job.escrow = Some(
                    funded["escrow"]
                        .as_str()
                        .context("missing funded escrow")?
                        .parse()?,
                );
                s.write(&name, &job)?;
            }
            let id = job.escrow.context("missing escrow")?;
            if stop_after.as_deref() == Some("funded") {
                return output(json!({"request":request,"escrow":id,"stopped_after":"funded"}));
            }
            if job.receipt.is_none() {
                let response = transport::request(
                    &endpoint,
                    &ticket,
                    &signed.quote.provider_key,
                    &Request::Deliver {
                        version: VERSION,
                        escrow: id,
                    },
                )
                .await?;
                let Response::Result { escrow, bytes } = response else {
                    bail!("expected result")
                };
                ensure!(
                    escrow == id && bytes == expected && hash(&bytes) == signed.quote.result_hash,
                    "result verification failed"
                );
                s.write(&format!("purchases/{request}.result.json"), &bytes)?;
                let acceptance = signed.quote.acceptance(id)?;
                job.receipt = Some(SignedAcceptance {
                    signature: sign(&acceptance, &key)?,
                    acceptance,
                });
                s.write(&name, &job)?;
            }
            if stop_after.as_deref() == Some("accepted") {
                return output(json!({"request":request,"escrow":id,"stopped_after":"accepted"}));
            }
            let reply = transport::request(
                &endpoint,
                &ticket,
                &signed.quote.provider_key,
                &Request::Accept {
                    version: VERSION,
                    receipt: job.receipt.clone().context("missing receipt")?,
                },
            )
            .await;
            let confirmed = chain.escrow(id).await?;
            ensure!(confirmed.quote == signed.quote, "escrow terms changed");
            if confirmed.status != 1 {
                reply?;
                bail!("settlement not confirmed; retry this request");
            }
            job.settlement = confirmed.terminal_digest;
            s.write(&name, &job)?;
            endpoint.close().await;
            output(
                json!({"request":request,"escrow":id,"status":"settled","digest":job.settlement,"elapsed_ms":start.elapsed().as_millis()}),
            )?;
        }
        Commands::Status { request } => {
            let job: Purchase = s.read(&job_name(&request)?)?;
            let id = chain.lookup(identity.agent, job.nonce).await?;
            if let Some(id) = id {
                let escrow = chain.escrow(id).await?;
                ensure!(
                    job.quote.as_ref().is_some_and(|q| q.quote == escrow.quote),
                    "nonce belongs to a different agreement"
                );
                output(escrow)?;
            } else {
                output(json!({"status":"not_funded","request":request}))?;
            }
        }
        Commands::Refund {
            request,
            gas_signer,
        } => {
            let job: Purchase = s.read(&job_name(&request)?)?;
            let id = chain
                .lookup(identity.agent, job.nonce)
                .await?
                .context("request was never funded")?;
            let e = chain.escrow(id).await?;
            ensure!(
                job.quote.as_ref().is_some_and(|q| q.quote == e.quote),
                "nonce belongs to a different agreement"
            );
            if e.status == 2 {
                output(e)?;
            } else {
                output(
                    chain
                        .refund(
                            id,
                            &fs::canonicalize(gas_signer)?,
                            &fs::canonicalize(&s.root)?
                                .join(format!("purchases/{request}.refund.tx.json")),
                        )
                        .await?,
                )?;
            }
        }
        Commands::Init { .. } | Commands::Vectors => unreachable!(),
    }
    Ok(())
}

fn vectors() -> Result<()> {
    let buyer = SecretKey::from_bytes(&[1; 32]);
    let provider = SecretKey::from_bytes(&[2; 32]);
    let result_hash = hash(include_bytes!("../fixtures/hello.txt"));
    let q = Quote {
        purpose: b"m2m/quote/v1".to_vec(),
        network: b"test-vector".to_vec(),
        package_id: Address::new([3; 32]),
        deployment: Address::new([4; 32]),
        buyer: Address::new([5; 32]),
        provider: Address::new([6; 32]),
        buyer_key: buyer.public().as_bytes().to_vec(),
        provider_key: provider.public().as_bytes().to_vec(),
        refund: Address::new([7; 32]),
        payee: Address::new([8; 32]),
        nonce: 9,
        request_hash: request_hash(&result_hash),
        result_hash,
        amount: 1000,
        quote_expires_ms: 1_800_000_000_000,
        deadline_ms: 1_800_000_300_000,
    };
    let a = q.acceptance(Address::new([10; 32]))?;
    output(
        json!({"quote":q,"quote_bcs":hex::encode(bcs::to_bytes(&q)?),"quote_signature":hex::encode(sign(&q,&provider)?),
        "acceptance":a,"acceptance_bcs":hex::encode(bcs::to_bytes(&a)?),"acceptance_signature":hex::encode(sign(&a,&buyer)?)}),
    )
}
