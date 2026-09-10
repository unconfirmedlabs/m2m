use crate::protocol::{Address, Quote, decimal};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    path::Path,
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::{io::AsyncWriteExt, process::Command, time::timeout};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Config {
    pub rpc_url: String,
    pub network: String,
    pub chain_id: String,
    pub package_id: Address,
    pub deployment: Address,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Agent {
    pub id: Address,
    pub deployment: Address,
    pub controller: Address,
    pub endpoint_key: Vec<u8>,
    #[serde(with = "decimal")]
    pub next_nonce: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Escrow {
    pub id: Address,
    pub quote: Quote,
    #[serde(with = "decimal")]
    pub funds: u64,
    pub status: u8,
    pub terminal_digest: Option<String>,
}
#[derive(Clone, Debug)]
pub struct Chain(pub Config);
impl Chain {
    pub async fn call<T: DeserializeOwned>(&self, mut args: Value) -> Result<T> {
        let started = Instant::now();
        ensure!(
            matches!(self.0.network.as_str(), "localnet" | "testnet"),
            "unsupported network"
        );
        args["config"] = serde_json::to_value(&self.0)?;
        let mut child = Command::new("node")
            .args(["--import", "tsx", "scripts/chain.ts"])
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .context("start Sui adapter; run npm ci first")?;
        let mut stdin = child.stdin.take().context("missing adapter stdin")?;
        stdin.write_all(&serde_json::to_vec(&args)?).await?;
        drop(stdin);
        let output = timeout(Duration::from_secs(90), child.wait_with_output())
            .await
            .context(
                "Sui adapter timed out; outcome may be pending, reconcile before retrying",
            )??;
        if !output.status.success() {
            bail!(
                "Sui operation failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        let value =
            serde_json::from_slice(&output.stdout).context("invalid Sui adapter response")?;
        eprintln!(
            "{}",
            json!({"event":"chain_operation", "action":args["action"], "elapsed_ms":started.elapsed().as_millis()})
        );
        Ok(value)
    }
    pub async fn agent(&self, id: Address) -> Result<Agent> {
        self.call(json!({"action":"agent","id":id})).await
    }
    pub async fn escrow(&self, id: Address) -> Result<Escrow> {
        self.call(json!({"action":"escrow","id":id})).await
    }
    pub async fn clock(&self) -> Result<u64> {
        #[derive(Deserialize)]
        struct Clock {
            #[serde(with = "decimal")]
            timestamp_ms: u64,
        }
        Ok(self
            .call::<Clock>(json!({"action":"clock"}))
            .await?
            .timestamp_ms)
    }
    pub async fn lookup(&self, buyer: Address, nonce: u64) -> Result<Option<Address>> {
        #[derive(Deserialize)]
        struct Lookup {
            escrow: Option<Address>,
        }
        Ok(self
            .call::<Lookup>(json!({"action":"lookup","buyer":buyer,"nonce":nonce.to_string()}))
            .await?
            .escrow)
    }
    pub async fn refund(&self, id: Address, signer: &Path, journal: &Path) -> Result<Value> {
        self.call(json!({"action":"refund","id":id,"signer_file":signer,"journal":journal}))
            .await
    }
}
