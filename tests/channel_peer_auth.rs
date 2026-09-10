//! Run with a channel provider listening and M2M_TEST_ROOT set to its deployment.
use anyhow::{Context, Result, ensure};
use iroh::SecretKey;
use m2m::{
    channel_protocol::{ALPN, Envelope, MAX_FRAME, METHOD, Message, Ticket, VERSION},
    protocol::{Address, hash},
    store, transport,
};
use serde_json::Value;
use std::{path::PathBuf, time::Duration};
use tokio::time::timeout;

#[tokio::test]
#[ignore = "requires a running channel provider and local deployment"]
async fn unrelated_endpoint_cannot_request_offer_as_registered_buyer() -> Result<()> {
    let root = PathBuf::from(std::env::var("M2M_TEST_ROOT").context("set M2M_TEST_ROOT")?);
    let buyer: Value = store::read(&root.join("buyer/identity.json"))?;
    let ticket: Ticket = store::read(&root.join("channel-ticket.json"))?;
    let attacker =
        transport::endpoint_with_alpns(SecretKey::generate(), false, false, vec![ALPN.to_vec()])
            .await?;
    let conn = timeout(
        Duration::from_secs(10),
        attacker.connect(ticket.endpoint, ALPN),
    )
    .await??;
    let envelope = Envelope {
        version: VERSION,
        method: METHOD.into(),
        buyer: buyer["agent"].as_str().context("buyer Agent ID")?.parse()?,
        provider: ticket.agent,
        agreement_id: Address::ZERO,
        request_id: String::new(),
        message: Message::OfferRequest {
            opening_nonce: SecretKey::generate().public().as_bytes().to_vec(),
            result_hash: hash(include_bytes!("../fixtures/hello.txt")),
            jobs: 1,
            max_unit_price: 1000,
            deposit: 2000,
        },
    };
    envelope.validate()?;
    let (mut send, mut recv) = conn.open_bi().await?;
    send.write_all(&serde_json::to_vec(&envelope)?).await?;
    send.finish()?;
    let raw = timeout(Duration::from_secs(30), recv.read_to_end(MAX_FRAME)).await??;
    let response: Envelope = serde_json::from_slice(&raw)?;
    ensure!(
        matches!(response.message, Message::Error { ref code, .. } if code == "unauthorized"),
        "expected unauthorized rejection, got {:?}",
        response.message
    );
    conn.close(0u32.into(), b"test complete");
    attacker.close().await;
    Ok(())
}
