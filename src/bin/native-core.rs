//! Small embeddable-core host for independent-peer conformance.
use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use iroh::SecretKey;
use m2m::{
    native_core::*,
    native_transport::{self, Services},
};
use std::path::PathBuf;
#[derive(Parser)]
struct Args {
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    Serve {
        #[arg(long)]
        key_file: PathBuf,
        #[arg(long)]
        agent_file: Option<PathBuf>,
        #[arg(long)]
        agent: Option<Address>,
        #[arg(long = "auth-file", alias = "authorizations")]
        authorizations: PathBuf,
        #[arg(long)]
        ticket: PathBuf,
        #[arg(long)]
        state: PathBuf,
        #[arg(long, default_value_t = 1)]
        requests: usize,
        #[arg(long, default_value_t = 1)]
        connections: usize,
        #[arg(long)]
        relay: bool,
    },
    Vectors,
}
struct Files(PathBuf);
impl Resolver for Files {
    fn resolve(&self, agent: &AgentRef, now: u64) -> Result<Authorization> {
        let snapshots: Vec<Authorization> = m2m::store::read(&self.0)?;
        SnapshotResolver(snapshots).resolve(agent, now)
    }
}
fn reference(byte: u8) -> AgentRef {
    AgentRef {
        network: b"sui:testnet".to_vec(),
        package_id: Address::from_bytes([8; 32]).unwrap(),
        domain: Address::from_bytes([9; 32]).unwrap(),
        agent: Address::from_bytes([byte; 32]).unwrap(),
    }
}
#[tokio::main]
async fn main() -> Result<()> {
    match Args::parse().command {
        Command::Serve {
            key_file,
            agent_file,
            agent,
            authorizations,
            ticket,
            state,
            requests,
            connections,
            relay,
        } => {
            let key = load_transport_key(&key_file)?;
            let reference = if let Some(path) = agent_file {
                m2m::store::read(&path)?
            } else {
                let snapshots: Vec<Authorization> = m2m::store::read(&authorizations)?;
                snapshots
                    .into_iter()
                    .find(|snapshot| Some(snapshot.agent.agent) == agent)
                    .context("--agent must select one trusted authorization snapshot")?
                    .agent
            };
            let identity = Identity {
                agent: reference,
                key: key.clone(),
            };
            let resolver = Files(authorizations);
            let mut inbox = Inbox::open(state, identity.agent.clone(), 1024, 16 * 1024 * 1024)?;
            let endpoint = native_transport::endpoint(key, relay).await?;
            if relay {
                endpoint.online().await;
            }
            m2m::store::write(&ticket, &endpoint.addr())?;
            println!(
                "{}",
                serde_json::json!({"event":"listening","endpoint":endpoint.addr()})
            );
            let services = Services::free();
            for _ in 0..connections {
                let connection = endpoint.accept().await.context("endpoint closed")?.await?;
                let mut session = native_transport::accept(
                    connection,
                    &identity,
                    &resolver,
                    &Features::default(),
                )
                .await?;
                for _ in 0..requests {
                    services
                        .serve_one(&mut session, &identity, &resolver, &mut inbox)
                        .await?;
                }
                session.send.finish()?;
                // Wait for peer acknowledgement of stream completion before endpoint shutdown.
                let _ = tokio::time::timeout(
                    std::time::Duration::from_secs(10),
                    session.send.stopped(),
                )
                .await;
            }
            endpoint.close().await;
        }
        Command::Vectors => {
            let a = Identity {
                agent: reference(1),
                key: SecretKey::from_bytes(&[1; 32]),
            };
            let b = Identity {
                agent: reference(2),
                key: SecretKey::from_bytes(&[2; 32]),
            };
            let mut messages = Vec::new();
            let payloads: Vec<(&str, serde_json::Value)> = vec![
                (
                    "core.hello",
                    serde_json::to_value(Hello {
                        challenge: vec![1; 32],
                        required: vec![],
                        optional: vec!["example.echo.v1".into()],
                    })?,
                ),
                (
                    "core.welcome",
                    serde_json::to_value(Welcome {
                        hello_hash: vec![0; 32],
                        challenge: vec![2; 32],
                        required: vec![],
                        optional: vec!["example.echo.v1".into()],
                        selected: vec!["example.echo.v1".into()],
                    })?,
                ),
                (
                    "core.confirm",
                    serde_json::to_value(SessionBody {
                        session: vec![3; 32],
                    })?,
                ),
                (
                    "core.ready",
                    serde_json::to_value(SessionBody {
                        session: vec![3; 32],
                    })?,
                ),
                (
                    "agent.describe",
                    serde_json::to_value(SessionBody {
                        session: vec![3; 32],
                    })?,
                ),
                (
                    "agent.description",
                    serde_json::to_value(DescriptionBody {
                        session: vec![3; 32],
                        services: Services::free().describe(),
                    })?,
                ),
                (
                    "message.send",
                    serde_json::to_value(MessageBody {
                        session: vec![3; 32],
                        service: "echo".into(),
                        content_type: "application/octet-stream".into(),
                        content: b"hello, native m2m".to_vec(),
                    })?,
                ),
                (
                    "message.receipt",
                    serde_json::to_value(ReceiptBody {
                        session: vec![3; 32],
                        message_id: vec![7; 32],
                        commitment: vec![0; 32],
                        state: DeliveryState::Completed,
                        result: Some(b"hello, native m2m".to_vec()),
                    })?,
                ),
                (
                    "core.error",
                    serde_json::to_value(ErrorBody {
                        session: Some(vec![3; 32]),
                        code: ErrorCode::MessageConflict,
                        detail: "existing ID has different logical content".into(),
                    })?,
                ),
                (
                    "extension.example.echo.v1",
                    serde_json::to_value(ExtensionBody {
                        session: vec![3; 32],
                        content: b"extension bytes".to_vec(),
                    })?,
                ),
            ];
            let mut session = vec![3; 32];
            for (index, (kind, mut payload)) in payloads.into_iter().enumerate() {
                if index == 1 {
                    payload["hello_hash"] = serde_json::to_value(
                        messages
                            .first()
                            .map(|m: &SignedEnvelope| m.message.digest())
                            .transpose()?
                            .unwrap(),
                    )?;
                }
                if index >= 2 {
                    payload["session"] = serde_json::to_value(&session)?;
                }
                if index == 7 {
                    payload["commitment"] =
                        serde_json::to_value(logical_commitment(&messages[6].message)?)?;
                }
                let from_b = [1, 3, 5, 7, 8].contains(&index);
                let (sender, recipient) = if from_b {
                    (&b, &a.agent)
                } else {
                    (&a, &b.agent)
                };
                let correlation = match index {
                    0 => None,
                    1..=3 => Some(vec![index as u8; 32]),
                    5 => Some(vec![5; 32]),
                    7 | 8 => Some(vec![7; 32]),
                    _ => None,
                };
                let envelope = Envelope {
                    purpose: PURPOSE.to_vec(),
                    sender: sender.agent.clone(),
                    recipient: recipient.clone(),
                    generation: 0,
                    id: vec![index as u8 + 1; 32],
                    correlation,
                    created_ms: 1000,
                    expires_ms: 31000,
                    kind: kind.into(),
                    payload: serde_json::to_vec(&payload)?,
                };
                messages.push(envelope.sign(&sender.key)?);
                if index == 1 {
                    session = session_id(&messages[0].message, &messages[1].message)?;
                }
            }
            let vectors:Vec<_>=messages.iter().map(|message|Ok(serde_json::json!({"kind":message.message.kind,"signed":message,"signing_bytes_hex":hex::encode(message.message.signing_bytes()?),"public_key":if message.message.sender==a.agent{a.key.public().as_bytes().to_vec()}else{b.key.public().as_bytes().to_vec()}}))).collect::<Result<_>>()?;
            println!(
                "{}",
                serde_json::to_string_pretty(
                    &serde_json::json!({"version":1,"status":"experimental native core; public deterministic test keys only","checked_ms":"1000","messages":vectors})
                )?
            );
        }
    }
    Ok(())
}
