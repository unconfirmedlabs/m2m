//! Raw Iroh framing bridge. Core parsing/signing/state intentionally belong to the caller.
use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use iroh::EndpointAddr;
use m2m::native_core::{ALPN, MAX_FRAME};
use serde::Deserialize;
use serde_json::json;
use std::{path::PathBuf, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt},
    time::timeout,
};

#[derive(Parser)]
struct Args {
    #[command(subcommand)]
    command: Mode,
}
#[derive(Subcommand)]
enum Mode {
    Listen {
        #[arg(long)]
        key_file: PathBuf,
        #[arg(long)]
        ticket: PathBuf,
        #[arg(long)]
        relay: bool,
    },
    Connect {
        #[arg(long)]
        key_file: PathBuf,
        #[arg(long)]
        ticket: PathBuf,
        #[arg(long)]
        relay: bool,
    },
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Command {
    command: String,
    bytes: Vec<u8>,
}
fn event(value: serde_json::Value) -> Result<()> {
    use std::io::Write;
    let mut stdout = std::io::stdout().lock();
    serde_json::to_writer(&mut stdout, &value)?;
    stdout.write_all(b"\n")?;
    stdout.flush()?;
    Ok(())
}
#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let (key_file, ticket, relay, listen) = match args.command {
        Mode::Listen {
            key_file,
            ticket,
            relay,
        } => (key_file, ticket, relay, true),
        Mode::Connect {
            key_file,
            ticket,
            relay,
        } => (key_file, ticket, relay, false),
    };
    let key = m2m::native_core::load_transport_key(&key_file)?;
    let endpoint = m2m::native_transport::endpoint(key, relay).await?;
    if relay {
        endpoint.online().await;
    }
    let connection = if listen {
        let address = endpoint.addr();
        m2m::store::write(&ticket, &address)?;
        event(json!({"event":"listening","endpoint":address}))?;
        timeout(Duration::from_secs(180), endpoint.accept())
            .await?
            .context("listener closed")?
            .await?
    } else {
        let address: EndpointAddr = m2m::store::read(&ticket)?;
        timeout(Duration::from_secs(30), endpoint.connect(address, ALPN)).await??
    };
    event(json!({"event":"connected","remote_key":connection.remote_id().as_bytes()}))?;
    let (mut send, mut recv) = if listen {
        timeout(Duration::from_secs(180), connection.accept_bi()).await??
    } else {
        connection.open_bi().await?
    };
    let writer = tokio::spawn(async move {
        let mut input = tokio::io::BufReader::new(tokio::io::stdin());
        loop {
            let mut line = Vec::new();
            // Bound the diagnostic expansion of a 1-MiB array before JSON parsing.
            let mut read = (&mut input).take((MAX_FRAME * 5 + 128) as u64);
            if read.read_until(b'\n', &mut line).await? == 0 {
                send.finish()?;
                return Ok::<_, anyhow::Error>(());
            }
            ensure!(line.last() == Some(&b'\n'), "oversized bridge command");
            let command: Command = serde_json::from_slice(&line)?;
            ensure!(
                command.command == "send"
                    && !command.bytes.is_empty()
                    && command.bytes.len() <= MAX_FRAME,
                "invalid bridge command"
            );
            timeout(Duration::from_secs(180), async {
                send.write_all(&(command.bytes.len() as u32).to_be_bytes())
                    .await?;
                send.write_all(&command.bytes).await?;
                Ok::<_, anyhow::Error>(())
            })
            .await??;
        }
    });
    let reader = tokio::spawn(async move {
        loop {
            let bytes = timeout(Duration::from_secs(180), async {
                let mut prefix = [0; 4];
                recv.read_exact(&mut prefix).await?;
                let size = u32::from_be_bytes(prefix) as usize;
                ensure!(size > 0 && size <= MAX_FRAME, "invalid bridge frame size");
                let mut bytes = vec![0; size];
                recv.read_exact(&mut bytes).await?;
                Ok::<_, anyhow::Error>(bytes)
            })
            .await??;
            event(json!({"event":"frame","bytes":bytes}))?;
        }
        #[allow(unreachable_code)]
        Ok::<_, anyhow::Error>(())
    });
    let mut writer = writer;
    let mut reader = reader;
    let result = tokio::select! {result=&mut writer=>result?,result=&mut reader=>result?};
    writer.abort();
    reader.abort();
    if result.is_err() {
        event(json!({"event":"error","message":"transport closed"}))?;
    }
    connection.close(0u32.into(), b"bridge finished");
    endpoint.close().await;
    // Tokio's blocking stdin reader cannot be aborted; avoid retaining a dead
    // bridge solely for that thread after its connection has terminated.
    std::process::exit(if result.is_ok() { 0 } else { 1 })
}
