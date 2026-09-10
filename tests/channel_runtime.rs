use iroh::SecretKey;
use m2m::{
    chain::Config,
    channel_runtime::{self, BuyOptions, ChannelIdentity, ServeOptions},
    protocol::Address,
    store::Store,
};
use std::{fs, path::PathBuf};

fn identity() -> ChannelIdentity {
    ChannelIdentity {
        agent: Address::new([1; 32]),
        chain: Config {
            rpc_url: "http://127.0.0.1:9000".into(),
            network: "localnet".into(),
            chain_id: "test".into(),
            package_id: Address::new([2; 32]),
            deployment: Address::new([3; 32]),
        },
        key: SecretKey::from_bytes(&[4; 32]),
    }
}

#[tokio::test]
async fn buy_rejects_unsafe_session_before_network_or_file_access() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().to_owned()).unwrap();
    let result = channel_runtime::buy(
        &store,
        &identity(),
        BuyOptions {
            provider: Address::new([5; 32]),
            ticket: PathBuf::from("does-not-exist.json"),
            expected_file: PathBuf::from("does-not-exist.txt"),
            signer: PathBuf::from("does-not-exist-signer.json"),
            session: "bad/session".into(),
            jobs: 1,
            deposit: 1,
            max_unit_price: 1,
            relay: false,
            relay_only: false,
            stop_after: None,
            close: false,
        },
    )
    .await;
    assert!(result.is_err());
}

#[tokio::test]
async fn buy_refuses_a_durable_reservation_without_a_session_journal() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().to_owned()).unwrap();
    let expected_file = dir.path().join("expected.bin");
    fs::write(&expected_file, b"fixture").unwrap();
    store
        .write(
            "channels/sessions/reserved.reservation.json",
            &serde_json::json!({
                "version": 1,
                "role": "buyer",
                "session": "reserved",
                "buyer": Address::new([1; 32]),
                "provider": Address::new([5; 32]),
                "opening_nonce": vec![9; 32],
                "requested_jobs": 1,
                "requested_deposit": 1,
                "max_unit_price": 1,
                "expected_result_hash": vec![7; 32]
            }),
        )
        .unwrap();
    let result = channel_runtime::buy(
        &store,
        &identity(),
        BuyOptions {
            provider: Address::new([5; 32]),
            ticket: dir.path().join("missing-ticket.json"),
            expected_file,
            signer: dir.path().join("missing-signer.json"),
            session: "reserved".into(),
            jobs: 1,
            deposit: 1,
            max_unit_price: 1,
            relay: false,
            relay_only: false,
            stop_after: None,
            close: false,
        },
    )
    .await;
    assert!(result.is_err());
}

#[tokio::test]
async fn buy_refuses_transaction_history_without_a_session_journal() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().to_owned()).unwrap();
    let expected_file = dir.path().join("expected.bin");
    fs::write(&expected_file, b"fixture").unwrap();
    fs::create_dir_all(dir.path().join("channels/tx")).unwrap();
    fs::write(dir.path().join("channels/tx/history.open.tx.json"), b"{}").unwrap();
    let result = channel_runtime::buy(
        &store,
        &identity(),
        BuyOptions {
            provider: Address::new([5; 32]),
            ticket: dir.path().join("missing-ticket.json"),
            expected_file,
            signer: dir.path().join("missing-signer.json"),
            session: "history".into(),
            jobs: 1,
            deposit: 1,
            max_unit_price: 1,
            relay: false,
            relay_only: false,
            stop_after: None,
            close: false,
        },
    )
    .await;
    assert!(result.is_err());
}

#[tokio::test]
async fn serve_rejects_a_runtime_grace_below_the_protocol_floor() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::open(dir.path().to_owned()).unwrap();
    let result = channel_runtime::serve(
        &store,
        &identity(),
        ServeOptions {
            file: dir.path().join("missing-fixture"),
            gas_signer: dir.path().join("missing-gas"),
            ticket: dir.path().join("ticket.json"),
            unit_price: 1,
            max_jobs: 1,
            work_ms: 10_000,
            grace_ms: 9_999,
            relay: false,
            relay_only: false,
            fault: None,
        },
    )
    .await;
    assert!(result.is_err());
}
