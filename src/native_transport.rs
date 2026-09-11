//! Iroh binding and service dispatch for the native core; no payment dependency.
use crate::native_core::*;
use anyhow::{Context, Result, bail, ensure};
use iroh::{
    Endpoint, EndpointAddr, SecretKey,
    endpoint::{Connection, QuicTransportConfig, RecvStream, SendStream, presets},
};
use std::{collections::BTreeMap, time::Duration};
use tokio::time::timeout;
pub const IO_TIMEOUT: Duration = Duration::from_secs(10);

pub async fn endpoint(key: SecretKey, relay: bool) -> Result<Endpoint> {
    let builder = if relay {
        Endpoint::builder(presets::N0)
    } else {
        Endpoint::builder(presets::Minimal)
    };
    Ok(builder
        .secret_key(key)
        .alpns(vec![ALPN.to_vec()])
        .transport_config(
            QuicTransportConfig::builder()
                .max_concurrent_bidi_streams(1u32.into())
                .max_concurrent_uni_streams(0u32.into())
                .stream_receive_window((MAX_FRAME as u32 + 4).into())
                .receive_window((2 * MAX_FRAME as u32 + 8).into())
                .send_window(2 * MAX_FRAME as u64 + 8)
                .build(),
        )
        .bind()
        .await?)
}
pub async fn write_frame(send: &mut SendStream, bytes: &[u8]) -> Result<()> {
    ensure!(
        !bytes.is_empty() && bytes.len() <= MAX_FRAME,
        "invalid_message: frame size"
    );
    timeout(IO_TIMEOUT, async {
        send.write_all(&(bytes.len() as u32).to_be_bytes()).await?;
        send.write_all(bytes).await?;
        Ok::<_, anyhow::Error>(())
    })
    .await
    .context("frame write timeout; outcome uncertain")??;
    Ok(())
}
pub async fn read_frame(recv: &mut RecvStream) -> Result<Vec<u8>> {
    timeout(IO_TIMEOUT, async {
        let mut prefix = [0; 4];
        recv.read_exact(&mut prefix).await?;
        let size = u32::from_be_bytes(prefix) as usize;
        ensure!(size > 0 && size <= MAX_FRAME, "invalid_message: frame size");
        let mut bytes = vec![0; size];
        recv.read_exact(&mut bytes).await?;
        Ok(bytes)
    })
    .await
    .context("frame read timeout; outcome uncertain")?
}
pub async fn write_message(send: &mut SendStream, message: &SignedEnvelope) -> Result<()> {
    write_frame(send, &serde_json::to_vec(message)?).await
}
pub async fn read_message(recv: &mut RecvStream) -> Result<SignedEnvelope> {
    parse(&read_frame(recv).await?)
}

pub struct Session {
    pub connection: Connection,
    pub send: SendStream,
    pub recv: RecvStream,
    pub id: Vec<u8>,
    pub local: Authorization,
    pub remote: Authorization,
    pub selected: Vec<String>,
}
fn resolve_pair(
    identity: &Identity,
    peer: &AgentRef,
    actual: &[u8],
    resolver: &dyn Resolver,
    now: u64,
) -> Result<(Authorization, Authorization)> {
    let local = resolver.resolve(&identity.agent, now)?;
    local.validate(&identity.agent, now)?;
    let remote = resolver.resolve(peer, now)?;
    remote.validate(peer, now)?;
    ensure!(
        local.transport_key == identity.key.public().as_bytes() && remote.transport_key == actual,
        "unauthorized: actual Iroh key not authorized"
    );
    Ok((local, remote))
}
fn verify(
    message: &SignedEnvelope,
    auth: &Authorization,
    local: &Authorization,
    actual: &[u8],
    kind: &str,
    correlation: Option<&[u8]>,
    now: u64,
) -> Result<()> {
    message.verify(auth, &local.agent, actual, now)?;
    ensure!(
        message.message.kind == kind && message.message.correlation.as_deref() == correlation,
        "invalid_message: handshake kind or correlation"
    );
    Ok(())
}
pub async fn connect(
    endpoint: &Endpoint,
    address: EndpointAddr,
    identity: &Identity,
    peer: &AgentRef,
    resolver: &dyn Resolver,
    features: &Features,
) -> Result<Session> {
    features.validate()?;
    let now = now_ms()?;
    let (local, remote) = resolve_pair(identity, peer, address.id.as_bytes(), resolver, now)?;
    let connection = timeout(IO_TIMEOUT, endpoint.connect(address, ALPN)).await??;
    ensure!(
        connection.remote_id().as_bytes() == remote.transport_key.as_slice(),
        "unauthorized: connected endpoint differs"
    );
    let (mut send, mut recv) = timeout(IO_TIMEOUT, connection.open_bi()).await??;
    let hello = identity.sign(
        peer,
        local.generation,
        "core.hello",
        None,
        &Hello {
            challenge: random_id(),
            required: features.required.clone(),
            optional: features.optional.clone(),
        },
        now,
    )?;
    write_message(&mut send, &hello).await?;
    let welcome = read_message(&mut recv).await?;
    verify(
        &welcome,
        &remote,
        &local,
        connection.remote_id().as_bytes(),
        "core.welcome",
        Some(&hello.message.id),
        now_ms()?,
    )?;
    let body: Welcome = parse(&welcome.message.payload)?;
    ensure!(
        body.challenge.len() == 32 && body.hello_hash == hello.message.digest()?,
        "invalid_message: welcome challenge or hello binding"
    );
    let selected = features.select(&body.features())?;
    ensure!(
        body.selected == selected,
        "unsupported_feature: invalid feature selection"
    );
    let id = session_id(&hello.message, &welcome.message)?;
    let confirm = identity.sign(
        peer,
        local.generation,
        "core.confirm",
        Some(welcome.message.id.clone()),
        &SessionBody {
            session: id.clone(),
        },
        now_ms()?,
    )?;
    write_message(&mut send, &confirm).await?;
    let ready = read_message(&mut recv).await?;
    verify(
        &ready,
        &remote,
        &local,
        connection.remote_id().as_bytes(),
        "core.ready",
        Some(&confirm.message.id),
        now_ms()?,
    )?;
    ensure!(
        parse::<SessionBody>(&ready.message.payload)?.session == id,
        "invalid_message: ready transcript"
    );
    Ok(Session {
        connection,
        send,
        recv,
        id,
        local,
        remote,
        selected,
    })
}
pub async fn accept(
    connection: Connection,
    identity: &Identity,
    resolver: &dyn Resolver,
    features: &Features,
) -> Result<Session> {
    features.validate()?;
    let (mut send, mut recv) = timeout(IO_TIMEOUT, connection.accept_bi()).await??;
    let hello = read_message(&mut recv).await?;
    let now = now_ms()?;
    let (local, remote) = resolve_pair(
        identity,
        &hello.message.sender,
        connection.remote_id().as_bytes(),
        resolver,
        now,
    )?;
    verify(
        &hello,
        &remote,
        &local,
        connection.remote_id().as_bytes(),
        "core.hello",
        None,
        now,
    )?;
    let body: Hello = parse(&hello.message.payload)?;
    ensure!(
        body.challenge.len() == 32,
        "invalid_message: hello challenge"
    );
    let selected = match features.select(&body.features()) {
        Ok(selected) => selected,
        Err(error) => {
            let rejection = identity.sign(
                &remote.agent,
                local.generation,
                "core.error",
                Some(hello.message.id.clone()),
                &ErrorBody {
                    session: None,
                    code: ErrorCode::UnsupportedFeature,
                    detail: "mandatory feature not supported".into(),
                },
                now,
            )?;
            write_message(&mut send, &rejection).await?;
            send.finish()?;
            let _ = timeout(IO_TIMEOUT, send.stopped()).await;
            return Err(error);
        }
    };
    let welcome = identity.sign(
        &remote.agent,
        local.generation,
        "core.welcome",
        Some(hello.message.id.clone()),
        &Welcome {
            hello_hash: hello.message.digest()?,
            challenge: random_id(),
            required: features.required.clone(),
            optional: features.optional.clone(),
            selected: selected.clone(),
        },
        now,
    )?;
    write_message(&mut send, &welcome).await?;
    let id = session_id(&hello.message, &welcome.message)?;
    let confirm = read_message(&mut recv).await?;
    verify(
        &confirm,
        &remote,
        &local,
        connection.remote_id().as_bytes(),
        "core.confirm",
        Some(&welcome.message.id),
        now_ms()?,
    )?;
    ensure!(
        parse::<SessionBody>(&confirm.message.payload)?.session == id,
        "invalid_message: confirm transcript"
    );
    let ready = identity.sign(
        &remote.agent,
        local.generation,
        "core.ready",
        Some(confirm.message.id.clone()),
        &SessionBody {
            session: id.clone(),
        },
        now_ms()?,
    )?;
    write_message(&mut send, &ready).await?;
    Ok(Session {
        connection,
        send,
        recv,
        id,
        local,
        remote,
        selected,
    })
}
impl Session {
    pub fn refresh(
        &self,
        identity: &Identity,
        resolver: &dyn Resolver,
        now: u64,
    ) -> Result<(Authorization, Authorization)> {
        let (local, remote) = resolve_pair(
            identity,
            &self.remote.agent,
            self.connection.remote_id().as_bytes(),
            resolver,
            now,
        )?;
        ensure!(
            local.agent == self.local.agent
                && local.generation == self.local.generation
                && remote.generation == self.remote.generation,
            "unauthorized: generation changed; reconnect required"
        );
        Ok((local, remote))
    }
    pub fn verify_incoming(
        &self,
        message: &SignedEnvelope,
        identity: &Identity,
        resolver: &dyn Resolver,
        now: u64,
    ) -> Result<()> {
        let (local, remote) = self.refresh(identity, resolver, now)?;
        message.verify(
            &remote,
            &local.agent,
            self.connection.remote_id().as_bytes(),
            now,
        )?;
        let session = match message.message.kind.as_str() {
            "agent.describe" => parse::<SessionBody>(&message.message.payload)?.session,
            "agent.description" => parse::<DescriptionBody>(&message.message.payload)?.session,
            "message.send" => parse::<MessageBody>(&message.message.payload)?.session,
            "message.receipt" => parse::<ReceiptBody>(&message.message.payload)?.session,
            "core.error" => parse::<ErrorBody>(&message.message.payload)?
                .session
                .context("invalid_message: missing established session")?,
            kind if kind.starts_with("extension.") => {
                ensure!(
                    self.selected
                        .iter()
                        .any(|feature| kind == format!("extension.{feature}")),
                    "unsupported_feature: extension not negotiated"
                );
                parse::<ExtensionBody>(&message.message.payload)?.session
            }
            _ => bail!("invalid_message: unknown established kind"),
        };
        ensure!(session == self.id, "invalid_message: session mismatch");
        Ok(())
    }
    pub fn message(
        &self,
        identity: &Identity,
        service: &str,
        content_type: &str,
        content: Vec<u8>,
        now: u64,
    ) -> Result<SignedEnvelope> {
        identity.sign(
            &self.remote.agent,
            self.local.generation,
            "message.send",
            None,
            &MessageBody {
                session: self.id.clone(),
                service: service.into(),
                content_type: content_type.into(),
                content,
            },
            now,
        )
    }
    pub fn rebind(&self, identity: &Identity, saved: &SignedEnvelope) -> Result<SignedEnvelope> {
        ensure!(
            saved.message.sender == self.local.agent
                && saved.message.recipient == self.remote.agent,
            "unauthorized: retry parties"
        );
        let mut message = saved.message.clone();
        message.payload = match message.kind.as_str() {
            "message.send" => {
                let mut body: MessageBody = parse(&message.payload)?;
                body.session = self.id.clone();
                serde_json::to_vec(&body)?
            }
            "agent.describe" => serde_json::to_vec(&SessionBody {
                session: self.id.clone(),
            })?,
            kind if kind.starts_with("extension.") => {
                let mut body: ExtensionBody = parse(&message.payload)?;
                body.session = self.id.clone();
                serde_json::to_vec(&body)?
            }
            _ => bail!("invalid_message: unsupported retry kind"),
        };
        message.generation = self.local.generation;
        message.sign(&identity.key)
    }
    pub async fn exchange(
        &mut self,
        identity: &Identity,
        resolver: &dyn Resolver,
        message: &SignedEnvelope,
    ) -> Result<SignedEnvelope> {
        let (local, remote) = self.refresh(identity, resolver, now_ms()?)?;
        // Validate the outbound statement as rigorously as an inbound statement.
        message.verify(
            &local,
            &remote.agent,
            identity.key.public().as_bytes(),
            now_ms()?,
        )?;
        write_message(&mut self.send, message).await?;
        let response = read_message(&mut self.recv).await?;
        self.verify_incoming(&response, identity, resolver, now_ms()?)?;
        ensure!(
            response.message.correlation.as_ref() == Some(&message.message.id),
            "invalid_message: response correlation"
        );
        ensure!(
            response.message.kind == "core.error"
                || (message.message.kind == "agent.describe"
                    && response.message.kind == "agent.description")
                || (message.message.kind != "agent.describe"
                    && response.message.kind == "message.receipt"),
            "invalid_message: unexpected response kind"
        );
        if response.message.kind == "message.receipt" {
            let receipt: ReceiptBody = parse(&response.message.payload)?;
            ensure!(
                receipt.message_id == message.message.id
                    && receipt.commitment == logical_commitment(&message.message)?,
                "invalid_message: receipt commitment"
            );
            ensure!(
                (receipt.state == DeliveryState::Completed) == receipt.result.is_some()
                    && receipt
                        .result
                        .as_ref()
                        .is_none_or(|result| result.len() <= MAX_PAYLOAD),
                "invalid_message: inconsistent receipt state"
            );
        }
        Ok(response)
    }
}

#[derive(Default)]
pub struct Services {
    services: BTreeMap<String, Box<dyn ServiceHandler>>,
    extensions: BTreeMap<String, Box<dyn ExtensionHandler>>,
}
impl Services {
    pub fn free() -> Self {
        let mut services = Self::default();
        services.register(Box::new(Echo));
        services.register(Box::new(Blake2));
        services
    }
    pub fn register(&mut self, handler: Box<dyn ServiceHandler>) {
        self.services
            .insert(handler.description().id.clone(), handler);
    }
    pub fn register_extension(&mut self, handler: Box<dyn ExtensionHandler>) {
        self.extensions.insert(handler.feature().into(), handler);
    }
    pub fn describe(&self) -> Vec<ServiceDescription> {
        self.services
            .values()
            .map(|handler| handler.description())
            .collect()
    }
    fn dispatch(
        &self,
        session: &Session,
        message: &SignedEnvelope,
        inbox: &mut Inbox,
        now: u64,
    ) -> Result<ReceiptBody> {
        let envelope = &message.message;
        let (content, content_type, service, extension) = if envelope.kind == "message.send" {
            let body: MessageBody = parse(&envelope.payload)?;
            ensure!(
                body.service.len() <= 128
                    && body.content_type.len() <= 128
                    && body.content.len() <= MAX_PAYLOAD,
                "invalid_message: service input bounds"
            );
            if !self.services.contains_key(&body.service) {
                return Err(failure(ErrorCode::UnknownService, "service unavailable"));
            }
            (body.content, body.content_type, body.service, false)
        } else if let Some(feature) = envelope.kind.strip_prefix("extension.") {
            if !session.selected.iter().any(|f| f == feature)
                || !self.extensions.contains_key(feature)
            {
                return Err(failure(
                    ErrorCode::UnsupportedFeature,
                    "no negotiated extension handler",
                ));
            }
            let body: ExtensionBody = parse(&envelope.payload)?;
            (
                body.content,
                "application/octet-stream".into(),
                feature.into(),
                true,
            )
        } else {
            bail!("invalid_message: expected application request");
        };
        let (mut record, fresh) = inbox.accept(envelope, now)?;
        if fresh {
            inbox.dispatching(&envelope.sender, &envelope.id)?;
            let context = RequestContext {
                sender: &envelope.sender,
                message_id: &envelope.id,
                content_type: &content_type,
            };
            let result = if extension {
                self.extensions[&service].execute(&context, &content)
            } else {
                self.services[&service].execute(&context, &content)
            };
            match result {
                Ok(bytes) if bytes.len() <= MAX_PAYLOAD => inbox
                    .complete(&envelope.sender, &envelope.id, bytes)
                    .map_err(|_| {
                        failure(
                            ErrorCode::StorageFailure,
                            "dispatch result persistence failed; reconcile",
                        )
                    })?,
                _ => inbox.uncertain(&envelope.sender, &envelope.id)?,
            }
            record = inbox
                .get(&envelope.sender, &envelope.id)?
                .context("storage_failure: disappeared record")?;
        }
        Ok(ReceiptBody {
            session: session.id.clone(),
            message_id: record.id,
            commitment: record.commitment,
            state: record.state,
            result: record.result,
        })
    }
    pub async fn serve_one(
        &self,
        session: &mut Session,
        identity: &Identity,
        resolver: &dyn Resolver,
        inbox: &mut Inbox,
    ) -> Result<()> {
        let message = read_message(&mut session.recv).await?;
        session.verify_incoming(&message, identity, resolver, now_ms()?)?;
        let now = now_ms()?;
        let response = if message.message.kind == "agent.describe" {
            identity.sign(
                &session.remote.agent,
                session.local.generation,
                "agent.description",
                Some(message.message.id.clone()),
                &DescriptionBody {
                    session: session.id.clone(),
                    services: self.describe(),
                },
                now,
            )?
        } else {
            match self.dispatch(session, &message, inbox, now) {
                Ok(receipt) => identity.sign(
                    &session.remote.agent,
                    session.local.generation,
                    "message.receipt",
                    Some(message.message.id.clone()),
                    &receipt,
                    now,
                )?,
                Err(error) => {
                    let code = error
                        .downcast_ref::<Failure>()
                        .map(|failure| failure.code.clone())
                        .unwrap_or(ErrorCode::InvalidMessage);
                    identity.sign(&session.remote.agent,session.local.generation,"core.error",Some(message.message.id.clone()),&ErrorBody {session:Some(session.id.clone()),code,detail:"request rejected; recover identical logical request if outcome is uncertain".into()},now)?
                }
            }
        };
        write_message(&mut session.send, &response).await
    }
}
