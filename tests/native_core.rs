use anyhow::Result;
use iroh::{Endpoint, SecretKey};
use m2m::{
    native_core::*,
    native_transport::{self, Services, Session},
};
use serde_json::json;

fn agent(value: u8) -> AgentRef {
    AgentRef {
        network: b"sui:testnet".to_vec(),
        package_id: Address::from_bytes([8; 32]).unwrap(),
        domain: Address::from_bytes([9; 32]).unwrap(),
        agent: Address::from_bytes([value; 32]).unwrap(),
    }
}
fn identity(value: u8) -> Identity {
    Identity {
        agent: agent(value),
        key: SecretKey::from_bytes(&[value; 32]),
    }
}
fn auth(identity: &Identity, now: u64) -> Authorization {
    Authorization {
        agent: identity.agent.clone(),
        controller: Address::from_bytes([7; 32]).unwrap(),
        transport_key: identity.key.public().as_bytes().to_vec(),
        economic_key: SecretKey::from_bytes(&[identity.agent.agent.as_bytes()[0] + 10; 32])
            .public()
            .as_bytes()
            .to_vec(),
        generation: 0,
        read_at_ms: now,
        valid_until_ms: now + MAX_LEASE_MS,
    }
}
fn signed(now: u64) -> SignedEnvelope {
    let a = identity(1);
    a.sign(
        &agent(2),
        0,
        "message.send",
        None,
        &MessageBody {
            session: vec![3; 32],
            service: "echo".into(),
            content_type: "application/octet-stream".into(),
            content: b"hello".to_vec(),
        },
        now,
    )
    .unwrap()
}
async fn paired(
    a: &Identity,
    b: &Identity,
    resolver: &dyn Resolver,
    features: &Features,
) -> Result<(Endpoint, Endpoint, Session, Session)> {
    let ea = native_transport::endpoint(a.key.clone(), false).await?;
    let eb = native_transport::endpoint(b.key.clone(), false).await?;
    let connector = native_transport::connect(&ea, eb.addr(), a, &b.agent, resolver, features);
    let acceptor = async {
        native_transport::accept(eb.accept().await.unwrap().await?, b, resolver, features).await
    };
    let (sa, sb) = tokio::try_join!(connector, acceptor)?;
    Ok((ea, eb, sa, sb))
}

#[test]
fn strict_encoding_signature_authority_and_bounds() -> Result<()> {
    let a = identity(1);
    let s = signed(1000);
    let authorization = auth(&a, 1000);
    s.verify(&authorization, &agent(2), a.key.public().as_bytes(), 1000)?;
    let encoded = serde_json::to_vec(&s)?;
    let parsed: SignedEnvelope = parse(&encoded)?;
    assert_eq!(s, parsed);
    assert_eq!(s.message.signing_bytes()?, bcs::to_bytes(&s.message)?);
    let mut value = serde_json::to_value(&s)?;
    value["message"]["generation"] = json!(0);
    assert!(parse::<SignedEnvelope>(&serde_json::to_vec(&value)?).is_err());
    value = serde_json::to_value(&s)?;
    value["message"]["generation"] = json!("00");
    assert!(parse::<SignedEnvelope>(&serde_json::to_vec(&value)?).is_err());
    value = serde_json::to_value(&s)?;
    value["message"]["recipient"]["agent"] = json!("0x2");
    assert!(parse::<SignedEnvelope>(&serde_json::to_vec(&value)?).is_err());
    value = serde_json::to_value(&s)?;
    value["extra"] = json!(true);
    assert!(parse::<SignedEnvelope>(&serde_json::to_vec(&value)?).is_err());
    value = serde_json::to_value(&s)?;
    value["message"]
        .as_object_mut()
        .unwrap()
        .remove("correlation");
    assert!(parse::<SignedEnvelope>(&serde_json::to_vec(&value)?).is_err());
    let duplicate = String::from_utf8(encoded)?.replacen(
        "\"generation\":\"0\"",
        "\"generation\":\"0\",\"generation\":\"0\"",
        1,
    );
    assert!(parse::<SignedEnvelope>(duplicate.as_bytes()).is_err());
    assert!(
        parse::<MessageBody>(
            br#"{"session":[],"service":"echo","service":"echo","content_type":"x","content":[]}"#
        )
        .is_err()
    );
    let mut changed = s.clone();
    changed.message.payload.push(0);
    assert!(
        changed
            .verify(&authorization, &agent(2), a.key.public().as_bytes(), 1000)
            .is_err()
    );
    assert!(
        s.verify(&authorization, &agent(3), a.key.public().as_bytes(), 1000)
            .is_err()
    );
    assert!(
        s.verify(
            &authorization,
            &agent(2),
            identity(3).key.public().as_bytes(),
            1000
        )
        .is_err()
    );
    let mut wrong_network = agent(1);
    wrong_network.network = b"sui:mainnet".to_vec();
    assert!(authorization.validate(&wrong_network, 1000).is_err());
    assert!(authorization.validate(&a.agent, 999).is_err());
    assert!(authorization.validate(&a.agent, 31000).is_err());
    let mut same_key = authorization.clone();
    same_key.economic_key = same_key.transport_key.clone();
    assert!(same_key.validate(&a.agent, 1000).is_err());
    let mut weak = authorization.clone();
    weak.transport_key = vec![0; 32];
    weak.transport_key[0] = 1;
    assert!(weak.validate(&a.agent, 1000).is_err());
    let mut rotated = authorization.clone();
    rotated.generation += 1;
    assert!(
        s.verify(&rotated, &agent(2), a.key.public().as_bytes(), 1000)
            .is_err()
    );
    let mut too_large = s.clone();
    too_large.message.payload = vec![0; MAX_PAYLOAD + 1];
    assert!(too_large.message.validate(1000).is_err());
    assert!(s.message.validate(s.message.expires_ms).is_err());
    Ok(())
}

#[tokio::test]
async fn malformed_frame_lengths_rejected_before_body_read() -> Result<()> {
    for length in [0, MAX_FRAME as u32 + 1] {
        let ea = native_transport::endpoint(identity(1).key, false).await?;
        let eb = native_transport::endpoint(identity(2).key, false).await?;
        let client = async {
            let connection = ea.connect(eb.addr(), ALPN).await?;
            let (mut send, _recv) = connection.open_bi().await?;
            send.write_all(&length.to_be_bytes()).await?;
            send.finish()?;
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), send.stopped()).await;
            Ok::<_, anyhow::Error>(())
        };
        let server = async {
            let connection = eb.accept().await.unwrap().await?;
            let (_send, mut recv) = connection.accept_bi().await?;
            assert!(native_transport::read_frame(&mut recv).await.is_err());
            Ok::<_, anyhow::Error>(())
        };
        tokio::try_join!(client, server)?;
        ea.close().await;
        eb.close().await;
    }
    Ok(())
}

#[tokio::test]
async fn signed_welcome_must_bind_exact_hello_and_feature_selection() -> Result<()> {
    for wrong_hash in [true, false] {
        let a = identity(1);
        let b = identity(2);
        let now = now_ms()?;
        let resolver = SnapshotResolver(vec![auth(&a, now), auth(&b, now)]);
        let ea = native_transport::endpoint(a.key.clone(), false).await?;
        let eb = native_transport::endpoint(b.key.clone(), false).await?;
        let features = Features {
            required: vec![],
            optional: vec!["example.echo.v1".into()],
        };
        let client = native_transport::connect(&ea, eb.addr(), &a, &b.agent, &resolver, &features);
        let server = async {
            let connection = eb.accept().await.unwrap().await?;
            let (mut send, mut recv) = connection.accept_bi().await?;
            let hello = native_transport::read_message(&mut recv).await?;
            let body = Welcome {
                hello_hash: if wrong_hash {
                    vec![0; 32]
                } else {
                    hello.message.digest()?
                },
                challenge: random_id(),
                required: vec![],
                optional: features.optional.clone(),
                selected: if wrong_hash {
                    features.optional.clone()
                } else {
                    vec![]
                },
            };
            let welcome = b.sign(
                &a.agent,
                0,
                "core.welcome",
                Some(hello.message.id.clone()),
                &body,
                now_ms()?,
            )?;
            native_transport::write_message(&mut send, &welcome).await?;
            send.finish()?;
            let _ = tokio::time::timeout(std::time::Duration::from_secs(2), send.stopped()).await;
            Ok::<_, anyhow::Error>(())
        };
        let (client, server) = tokio::join!(client, server);
        server?;
        assert!(client.is_err());
        ea.close().await;
        eb.close().await;
    }
    Ok(())
}

#[test]
fn feature_negotiation_rejects_downgrades_and_ambiguous_lists() -> Result<()> {
    let required = Features {
        required: vec!["payment.sui.streaming.v1".into()],
        optional: vec![],
    };
    assert!(required.select(&Features::default()).is_err());
    assert_eq!(
        required.select(&Features {
            required: vec![],
            optional: required.required.clone()
        })?,
        required.required
    );
    assert!(
        Features {
            required: vec!["a".into(), "a".into()],
            optional: vec![]
        }
        .validate()
        .is_err()
    );
    assert!(
        Features {
            required: vec!["a".into()],
            optional: vec!["a".into()]
        }
        .validate()
        .is_err()
    );
    assert!(
        Features {
            required: vec!["BAD".into()],
            optional: vec![]
        }
        .validate()
        .is_err()
    );
    Ok(())
}

#[test]
fn published_vectors_verify_and_bind_handshake_and_receipt() -> Result<()> {
    let corpus: serde_json::Value = serde_json::from_str(include_str!(
        "../examples/messages/native-core/vectors.json"
    ))?;
    let messages = corpus["messages"].as_array().unwrap();
    assert_eq!(messages.len(), 10);
    let mut signed = Vec::new();
    for vector in messages {
        let message: SignedEnvelope = serde_json::from_value(vector["signed"].clone())?;
        let wire_path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("examples/messages/native-core")
            .join(format!("{}.json", message.message.kind));
        let wire: SignedEnvelope = parse(&std::fs::read(wire_path)?)?;
        assert_eq!(
            wire, message,
            "per-kind wire fixture differs from signed vector"
        );
        let sender = identity(if message.message.sender == agent(1) {
            1
        } else {
            2
        });
        message.verify(
            &auth(&sender, 1000),
            &message.message.recipient,
            sender.key.public().as_bytes(),
            1000,
        )?;
        assert_eq!(
            hex::encode(message.message.signing_bytes()?),
            vector["signing_bytes_hex"]
        );
        match message.message.kind.as_str() {
            "core.hello" => {
                let _: Hello = parse(&message.message.payload)?;
            }
            "core.welcome" => {
                let _: Welcome = parse(&message.message.payload)?;
            }
            "core.confirm" | "core.ready" | "agent.describe" => {
                let _: SessionBody = parse(&message.message.payload)?;
            }
            "agent.description" => {
                let _: DescriptionBody = parse(&message.message.payload)?;
            }
            "message.send" => {
                let _: MessageBody = parse(&message.message.payload)?;
            }
            "message.receipt" => {
                let _: ReceiptBody = parse(&message.message.payload)?;
            }
            "core.error" => {
                let _: ErrorBody = parse(&message.message.payload)?;
            }
            _ => {
                let _: ExtensionBody = parse(&message.message.payload)?;
            }
        }
        signed.push(message);
    }
    assert_eq!(
        parse::<Welcome>(&signed[1].message.payload)?.hello_hash,
        signed[0].message.digest()?
    );
    let session = session_id(&signed[0].message, &signed[1].message)?;
    assert_eq!(
        parse::<SessionBody>(&signed[2].message.payload)?.session,
        session
    );
    assert_eq!(
        parse::<SessionBody>(&signed[3].message.payload)?.session,
        session
    );
    let receipt: ReceiptBody = parse(&signed[7].message.payload)?;
    assert_eq!(receipt.message_id, signed[6].message.id);
    assert_eq!(receipt.commitment, logical_commitment(&signed[6].message)?);
    Ok(())
}

struct Extension;
impl ExtensionHandler for Extension {
    fn feature(&self) -> &str {
        "example.echo.v1"
    }
    fn execute(&self, _: &RequestContext<'_>, content: &[u8]) -> Result<Vec<u8>> {
        Ok(content.to_vec())
    }
}
#[tokio::test]
async fn negotiated_extension_uses_same_unpaid_delivery_engine() -> Result<()> {
    let a = identity(1);
    let b = identity(2);
    let now = now_ms()?;
    let resolver = SnapshotResolver(vec![auth(&a, now), auth(&b, now)]);
    let feature = Features {
        required: vec!["example.echo.v1".into()],
        optional: vec![],
    };
    let (ea, eb, mut sa, mut sb) = paired(&a, &b, &resolver, &feature).await?;
    let dir = tempfile::tempdir()?;
    let mut inbox = Inbox::open(dir.path().into(), b.agent.clone(), 32, 1_000_000)?;
    let mut services = Services::free();
    services.register_extension(Box::new(Extension));
    let message = a.sign(
        &b.agent,
        0,
        "extension.example.echo.v1",
        None,
        &ExtensionBody {
            session: sa.id.clone(),
            content: b"extension input".to_vec(),
        },
        now_ms()?,
    )?;
    let (receipt, ()) = tokio::try_join!(
        sa.exchange(&a, &resolver, &message),
        services.serve_one(&mut sb, &b, &resolver, &mut inbox)
    )?;
    assert_eq!(
        parse::<ReceiptBody>(&receipt.message.payload)?.result,
        Some(b"extension input".to_vec())
    );
    let mut unnegotiated = message.message.clone();
    unnegotiated.kind = "extension.payment.sui.streaming.v1".into();
    assert!(
        sb.verify_incoming(&unnegotiated.sign(&a.key)?, &b, &resolver, now_ms()?)
            .is_err()
    );
    drop(sa);
    drop(sb);
    ea.close().await;
    eb.close().await;
    Ok(())
}

#[test]
fn durable_restart_uncertain_dispatch_conflicts_and_capacity() -> Result<()> {
    let dir = tempfile::tempdir()?;
    let request = signed(1000);
    let mut inbox = Inbox::open(dir.path().into(), agent(2), 1, 1_000_000)?;
    assert!(Inbox::open(dir.path().into(), agent(2), 1, 1_000_000).is_err());
    let (accepted, fresh) = inbox.accept(&request.message, 1000)?;
    assert!(fresh);
    assert_eq!(accepted.state, DeliveryState::Accepted);
    inbox.dispatching(&agent(1), &request.message.id)?;
    drop(inbox);
    let mut inbox = Inbox::open(dir.path().into(), agent(2), 1, 1_000_000)?;
    let mut retry = request.message.clone();
    let mut body: MessageBody = parse(&retry.payload)?;
    body.session = vec![4; 32];
    retry.payload = serde_json::to_vec(&body)?;
    retry.generation = 5;
    let (uncertain, fresh) = inbox.accept(&retry, 1001)?;
    assert!(!fresh);
    assert_eq!(uncertain.state, DeliveryState::Dispatching);
    assert!(inbox.dispatching(&agent(1), &request.message.id).is_err());
    let mut conflict = retry.clone();
    let mut body: MessageBody = parse(&conflict.payload)?;
    body.content.push(0);
    conflict.payload = serde_json::to_vec(&body)?;
    assert_eq!(
        inbox
            .accept(&conflict, 1001)
            .unwrap_err()
            .downcast_ref::<Failure>()
            .unwrap()
            .code,
        ErrorCode::MessageConflict
    );
    let mut second = retry.clone();
    second.id = vec![8; 32];
    assert_eq!(
        inbox
            .accept(&second, 1001)
            .unwrap_err()
            .downcast_ref::<Failure>()
            .unwrap()
            .code,
        ErrorCode::Overloaded
    );
    assert!(inbox.accept(&retry, request.message.expires_ms).is_err());
    inbox.complete(&agent(1), &request.message.id, b"saved".to_vec())?;
    drop(inbox);
    let mut inbox = Inbox::open(dir.path().into(), agent(2), 1, 1_000_000)?;
    assert_eq!(
        inbox.accept(&retry, 1002)?.0.result,
        Some(b"saved".to_vec())
    );
    drop(inbox);
    std::fs::rename(
        dir.path().join("native-inbox.json"),
        dir.path().join("simulated-disk-loss.json"),
    )?;
    assert!(Inbox::open(dir.path().into(), agent(2), 1, 1_000_000).is_err());
    Ok(())
}

#[tokio::test]
async fn real_iroh_unpaid_services_symmetric_exchange_and_restart_retry() -> Result<()> {
    let a = identity(1);
    let b = identity(2);
    let now = now_ms()?;
    let resolver = SnapshotResolver(vec![auth(&a, now), auth(&b, now)]);
    let dir_a = tempfile::tempdir()?;
    let dir_b = tempfile::tempdir()?;
    let mut inbox_a = Inbox::open(dir_a.path().into(), a.agent.clone(), 32, 1_000_000)?;
    let mut inbox_b = Inbox::open(dir_b.path().into(), b.agent.clone(), 32, 1_000_000)?;
    let services = Services::free();
    let (ea, eb, mut sa, mut sb) = paired(&a, &b, &resolver, &Features::default()).await?;
    assert_eq!(sa.id, sb.id);
    assert!(sa.selected.is_empty());
    let describe = a.sign(
        &b.agent,
        0,
        "agent.describe",
        None,
        &SessionBody {
            session: sa.id.clone(),
        },
        now_ms()?,
    )?;
    let (description, ()) = tokio::try_join!(
        sa.exchange(&a, &resolver, &describe),
        services.serve_one(&mut sb, &b, &resolver, &mut inbox_b)
    )?;
    assert_eq!(
        parse::<DescriptionBody>(&description.message.payload)?
            .services
            .len(),
        2
    );
    let request = sa.message(
        &a,
        "echo",
        "application/octet-stream",
        b"unpaid input".to_vec(),
        now_ms()?,
    )?;
    inbox_a.save_outbox(&request)?;
    let (receipt, ()) = tokio::try_join!(
        sa.exchange(&a, &resolver, &request),
        services.serve_one(&mut sb, &b, &resolver, &mut inbox_b)
    )?;
    assert_eq!(
        parse::<ReceiptBody>(&receipt.message.payload)?.result,
        Some(b"unpaid input".to_vec())
    );
    // The connection acceptor is also an application sender.
    let reverse = sb.message(
        &b,
        "blake2b-256",
        "application/octet-stream",
        b"reverse".to_vec(),
        now_ms()?,
    )?;
    let (receipt, ()) = tokio::try_join!(
        sb.exchange(&b, &resolver, &reverse),
        services.serve_one(&mut sa, &a, &resolver, &mut inbox_a)
    )?;
    assert_eq!(
        parse::<ReceiptBody>(&receipt.message.payload)?.result,
        Some(hash(b"reverse"))
    );
    drop(sa);
    drop(sb);
    ea.close().await;
    eb.close().await;
    drop(inbox_b);
    drop(inbox_a);
    let mut inbox_b = Inbox::open(dir_b.path().into(), b.agent.clone(), 32, 1_000_000)?;
    let inbox_a = Inbox::open(dir_a.path().into(), a.agent.clone(), 32, 1_000_000)?;
    let (ea, eb, mut sa, mut sb) = paired(&a, &b, &resolver, &Features::default()).await?;
    let saved = inbox_a.outbox(&request.message.id)?.unwrap();
    let retry = sa.rebind(&a, &saved)?;
    assert_ne!(retry.message.payload, request.message.payload);
    assert_eq!(
        logical_commitment(&retry.message)?,
        logical_commitment(&request.message)?
    );
    let (receipt, ()) = tokio::try_join!(
        sa.exchange(&a, &resolver, &retry),
        services.serve_one(&mut sb, &b, &resolver, &mut inbox_b)
    )?;
    assert_eq!(
        parse::<ReceiptBody>(&receipt.message.payload)?.result,
        Some(b"unpaid input".to_vec())
    );
    let mut conflict = retry.message.clone();
    let mut body: MessageBody = parse(&conflict.payload)?;
    body.content = b"changed".to_vec();
    conflict.payload = serde_json::to_vec(&body)?;
    let conflict = conflict.sign(&a.key)?;
    let (error, ()) = tokio::try_join!(
        sa.exchange(&a, &resolver, &conflict),
        services.serve_one(&mut sb, &b, &resolver, &mut inbox_b)
    )?;
    assert_eq!(
        parse::<ErrorBody>(&error.message.payload)?.code,
        ErrorCode::MessageConflict
    );
    drop(sa);
    drop(sb);
    ea.close().await;
    eb.close().await;
    Ok(())
}

#[tokio::test]
async fn real_iroh_unsupported_feature_fails_admission() -> Result<()> {
    let a = identity(1);
    let b = identity(2);
    let now = now_ms()?;
    let resolver = SnapshotResolver(vec![auth(&a, now), auth(&b, now)]);
    let ea = native_transport::endpoint(a.key.clone(), false).await?;
    let eb = native_transport::endpoint(b.key.clone(), false).await?;
    let feature = Features {
        required: vec!["unknown.v1".into()],
        optional: vec![],
    };
    let client = native_transport::connect(&ea, eb.addr(), &a, &b.agent, &resolver, &feature);
    let server = async {
        native_transport::accept(
            eb.accept().await.unwrap().await?,
            &b,
            &resolver,
            &Features::default(),
        )
        .await
    };
    let (client, server) = tokio::join!(client, server);
    assert!(client.is_err());
    assert!(server.is_err());
    ea.close().await;
    eb.close().await;
    Ok(())
}

#[tokio::test]
async fn independent_typescript_peer_over_real_iroh() -> Result<()> {
    use tokio::{
        process::Command,
        time::{Duration, timeout},
    };
    for mode in ["echo", "unsupported"] {
        let a = identity(1);
        let b = identity(2);
        let now = now_ms()?;
        let dir = tempfile::tempdir()?;
        let auth_file = dir.path().join("auth.json");
        let key_file = dir.path().join("key.json");
        let ticket = dir.path().join("ticket.json");
        m2m::store::write(&auth_file, &vec![auth(&a, now), auth(&b, now)])?;
        m2m::store::write(&key_file, &json!({"secret_key":vec![1;32]}))?;
        let resolver = SnapshotResolver(vec![auth(&a, now), auth(&b, now)]);
        let endpoint = native_transport::endpoint(b.key.clone(), false).await?;
        m2m::store::write(&ticket, &endpoint.addr())?;
        let mut node = Command::new("node");
        node.args(["--import", "tsx", "scripts/test-native-peer.ts", "--client"])
            .arg(&ticket)
            .arg(&key_file)
            .arg(&auth_file)
            .arg(mode)
            .env("M2M_NATIVE_BRIDGE", env!("CARGO_BIN_EXE_native-bridge"))
            .kill_on_drop(true);
        let process = async {
            let output = node.output().await?;
            anyhow::ensure!(
                output.status.success(),
                "independent {mode} peer failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            Ok::<_, anyhow::Error>(())
        };
        let serving = async {
            let connection = timeout(Duration::from_secs(15), endpoint.accept())
                .await
                .map_err(|_| anyhow::anyhow!("independent {mode}: connection timeout"))?
                .unwrap()
                .await?;
            let session =
                native_transport::accept(connection, &b, &resolver, &Features::default()).await;
            if mode == "unsupported" {
                assert!(session.is_err());
                return Ok::<_, anyhow::Error>(());
            }
            let mut session = session?;
            let mut inbox = Inbox::open(dir.path().join("inbox"), b.agent.clone(), 32, 1_000_000)?;
            for _ in 0..5 {
                Services::free()
                    .serve_one(&mut session, &b, &resolver, &mut inbox)
                    .await?;
            }
            // The Node peer exits only after consuming the final response.
            let _ = timeout(Duration::from_secs(10), session.connection.closed()).await;
            Ok(())
        };
        timeout(Duration::from_secs(25), async {
            tokio::try_join!(process, serving)
        })
        .await
        .map_err(|_| anyhow::anyhow!("independent {mode}: exchange timeout"))??;
        endpoint.close().await;
    }
    Ok(())
}

#[tokio::test]
async fn independent_peers_restart_both_processes_and_recover_saved_request() -> Result<()> {
    use tokio::{
        process::Command,
        time::{Duration, timeout},
    };
    let a = identity(1);
    let b = identity(2);
    let dir = tempfile::tempdir()?;
    let auth_file = dir.path().join("auth.json");
    let client_key = dir.path().join("client-key.json");
    let server_key = dir.path().join("server-key.json");
    let state = dir.path().join("server-state");
    let outbox = dir.path().join("client-outbox.json");
    m2m::store::write(&client_key, &json!({"secret_key":vec![1;32]}))?;
    m2m::store::write(&server_key, &json!({"secret_key":vec![2;32]}))?;
    let mut original: Option<SignedEnvelope> = None;
    for mode in ["save", "replay"] {
        let now = now_ms()?;
        m2m::store::write(&auth_file, &vec![auth(&a, now), auth(&b, now)])?;
        let ticket = dir.path().join(format!("{mode}-ticket.json"));
        let mut server = Command::new(env!("CARGO_BIN_EXE_native-core"));
        server
            .args(["serve", "--key-file"])
            .arg(&server_key)
            .arg("--auth-file")
            .arg(&auth_file)
            .arg("--agent")
            .arg(b.agent.agent.to_string())
            .arg("--ticket")
            .arg(&ticket)
            .arg("--state")
            .arg(&state)
            .arg("--requests")
            .arg("1")
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let child = server.spawn()?;
        timeout(Duration::from_secs(10), async {
            while !ticket.exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await?;
        let output = timeout(
            Duration::from_secs(20),
            Command::new("node")
                .args(["--import", "tsx", "scripts/test-native-peer.ts", "--client"])
                .arg(&ticket)
                .arg(&client_key)
                .arg(&auth_file)
                .arg(mode)
                .arg(&outbox)
                .env("M2M_NATIVE_BRIDGE", env!("CARGO_BIN_EXE_native-bridge"))
                .kill_on_drop(true)
                .output(),
        )
        .await??;
        assert!(
            output.status.success(),
            "independent {mode} failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let server = timeout(Duration::from_secs(12), child.wait_with_output()).await??;
        assert!(
            server.status.success(),
            "Rust {mode} host failed: {}",
            String::from_utf8_lossy(&server.stderr)
        );
        let saved: SignedEnvelope = m2m::store::read(&outbox)?;
        if let Some(original) = &original {
            assert_eq!(saved.message.id, original.message.id);
            assert_eq!(
                logical_commitment(&saved.message)?,
                logical_commitment(&original.message)?
            );
            assert_ne!(saved.message.payload, original.message.payload);
        }
        let journal: serde_json::Value = m2m::store::read(&state.join("native-inbox.json"))?;
        assert_eq!(journal["records"].as_object().unwrap().len(), 1);
        assert_eq!(
            journal["records"]
                .as_object()
                .unwrap()
                .values()
                .next()
                .unwrap()["state"],
            "completed"
        );
        original = Some(saved);
    }
    Ok(())
}
