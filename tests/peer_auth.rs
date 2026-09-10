use iroh::SecretKey;
use m2m::{
    chain::Chain,
    protocol::*,
    store,
    transport::{self, Ticket},
};
use serde_json::Value;
use std::path::PathBuf;

#[tokio::test]
#[ignore = "requires a running local provider; set M2M_TEST_ROOT"]
async fn unauthorized_endpoint_cannot_claim_registered_buyer() -> anyhow::Result<()> {
    let root = PathBuf::from(std::env::var("M2M_TEST_ROOT")?);
    let ticket: Ticket = store::read(&root.join("provider-ticket.json"))?;
    let identity: Value = store::read(&root.join("buyer/identity.json"))?;
    let buyer: Address = identity["agent"].as_str().unwrap().parse()?;
    let chain = Chain(serde_json::from_value(identity["chain"].clone())?);
    let endpoint = transport::endpoint(SecretKey::generate(), false).await?;
    let expected_key = ticket.endpoint.id.as_bytes().to_vec();
    let req = Request::Quote {
        version: VERSION,
        buyer,
        nonce: chain.agent(buyer).await?.next_nonce,
        result_hash: hash(include_bytes!("../fixtures/hello.txt")),
    };
    let result = transport::request(&endpoint, &ticket, &expected_key, &req).await;
    endpoint.close().await;
    let error = result.expect_err("forged identity must fail");
    assert!(
        error
            .to_string()
            .contains("not the registered buyer endpoint"),
        "{error:#}"
    );
    Ok(())
}
