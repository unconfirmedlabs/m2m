//! Runtime for the signed cumulative payment-channel profile.
//!
//! This module deliberately keeps the channel bridge separate from the original
//! escrow bridge.  The channel runtime owns the off-chain state machine and
//! only asks Sui for admission, opening, reconciliation, and settlement.

use crate::{
    chain::Config,
    channel_protocol as cp,
    protocol::{self, Address, MAX_FILE, MAX_FRAME},
    service::{FixedFile, ServiceHandler},
    store::{self, Store},
};
use anyhow::{Context, Result, bail, ensure};
use iroh::{
    Endpoint, SecretKey,
    endpoint::{Connection, presets},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio::{io::AsyncWriteExt, process::Command, sync::Mutex, time::timeout};

const OPENING_NONCE_LEN: usize = 32;
const MIN_GRACE_MS: u64 = 10_000;
const MAX_LIFETIME_MS: u64 = 3_600_000;
const MAX_DIAGNOSTIC: usize = 1024;
const DEFAULT_POLL_MS: u64 = 5_000;
const ZERO: Address = Address::ZERO;

/// Opt-in test hook: both peer adapters reject real RPC calls while this exists.
/// No file is created during normal operation.
struct JobsRpcGuard(Option<PathBuf>);
impl JobsRpcGuard {
    fn begin(network: &str) -> Result<Self> {
        let Some(path) = std::env::var_os("M2M_CHANNEL_RPC_DENY_FILE").map(PathBuf::from) else {
            return Ok(Self(None));
        };
        ensure!(
            network == "localnet",
            "RPC-denial test hook requires localnet"
        );
        ensure!(path.is_absolute(), "RPC-denial path must be absolute");
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&path)
            .context("activate RPC-denial test guard")?;
        std::io::Write::write_all(&mut file, b"admitted jobs: RPC disabled\n")?;
        file.sync_all()?;
        Ok(Self(Some(path)))
    }

    fn finish(mut self) -> Result<()> {
        if let Some(path) = &self.0 {
            fs::remove_file(path).context("release RPC-denial test guard")?;
        }
        self.0 = None;
        Ok(())
    }
}
impl Drop for JobsRpcGuard {
    fn drop(&mut self) {
        if let Some(path) = &self.0
            && let Err(error) = fs::remove_file(path)
        {
            eprintln!("RPC-denial guard cleanup failed: {error}");
        }
    }
}

#[derive(Clone, Debug)]
pub struct ChannelIdentity {
    pub agent: Address,
    pub chain: Config,
    pub key: SecretKey,
}

#[derive(Clone, Debug)]
pub struct ServeOptions {
    pub file: PathBuf,
    pub gas_signer: PathBuf,
    pub ticket: PathBuf,
    pub unit_price: u64,
    pub max_jobs: u64,
    pub work_ms: u64,
    pub grace_ms: u64,
    pub relay: bool,
    pub relay_only: bool,
    pub fault: Option<String>,
}

#[derive(Clone, Debug)]
pub struct BuyOptions {
    pub provider: Address,
    pub ticket: PathBuf,
    pub expected_file: PathBuf,
    pub signer: PathBuf,
    pub session: String,
    pub jobs: u64,
    pub deposit: u64,
    pub max_unit_price: u64,
    pub relay: bool,
    pub relay_only: bool,
    pub stop_after: Option<String>,
    pub close: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct JobRecord {
    request: cp::RequestDescriptor,
    credit: cp::Signed<cp::Credit>,
    ack: Option<cp::Signed<cp::Ack>>,
    result: Option<cp::Signed<cp::ResultStatement>>,
    result_file: Option<String>,
    transcript_after: Option<Vec<u8>>,
    completed: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionJournal {
    version: u8,
    role: String,
    session: String,
    buyer: Address,
    provider: Address,
    opening_nonce: Vec<u8>,
    requested_jobs: u64,
    requested_deposit: u64,
    max_unit_price: u64,
    expected_result_hash: Vec<u8>,
    terms: Option<cp::FixtureTerms>,
    offer: Option<cp::Signed<cp::Offer>>,
    channel: Option<Address>,
    jobs: Vec<JobRecord>,
    transcript_hash: Option<Vec<u8>>,
    frozen: bool,
    close: Option<cp::Signed<cp::Close>>,
    certificate: Option<cp::CloseCertificate>,
    chain_state: Option<Value>,
    chain_digest: Option<String>,
    anchor_upper_ms: Option<u64>,
    recovery_started: bool,
    #[serde(default)]
    ticket_path: String,
    #[serde(default)]
    relay: bool,
    #[serde(default)]
    relay_only: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
struct SessionReservation {
    version: u8,
    role: String,
    session: String,
    buyer: Address,
    provider: Address,
    opening_nonce: Vec<u8>,
    requested_jobs: u64,
    requested_deposit: u64,
    max_unit_price: u64,
    expected_result_hash: Vec<u8>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProviderJournal {
    version: u8,
    role: String,
    session: String,
    buyer: Address,
    provider: Address,
    offer: cp::Signed<cp::Offer>,
    terms: cp::FixtureTerms,
    channel: Address,
    jobs: Vec<JobRecord>,
    transcript_hash: Vec<u8>,
    frozen: bool,
    close: Option<cp::Signed<cp::Close>>,
    certificate: Option<cp::CloseCertificate>,
    chain_state: Option<Value>,
    chain_digest: Option<String>,
    anchor_upper_ms: u64,
    recovery_started: bool,
    #[serde(default)]
    clock_untrusted: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct OfferJournal {
    version: u8,
    offer: cp::Signed<cp::Offer>,
    terms: cp::FixtureTerms,
    channel: Option<Address>,
}

#[derive(Clone, Debug)]
struct ClockAnchor {
    upper_ms: u64,
    sampled_local_ms: u64,
    sampled_mono: Instant,
}

#[derive(Clone, Debug)]
struct ProviderAdmission {
    peer: Vec<u8>,
    anchor: ClockAnchor,
}

impl ClockAnchor {
    fn new(sampled_chain_ms: u64, started: Instant, received_local_ms: u64) -> Result<Self> {
        let round_trip_ms = u64::try_from(started.elapsed().as_millis())?;
        ensure!(
            round_trip_ms <= 10_000,
            "chain clock admission took too long"
        );
        let skew = sampled_chain_ms.abs_diff(received_local_ms);
        ensure!(
            skew <= 10_000,
            "chain clock differs too far from local clock"
        );
        let upper_ms = sampled_chain_ms
            .saturating_add(round_trip_ms)
            .max(received_local_ms)
            .checked_add(5_000)
            .context("clock anchor overflow")?;
        Ok(Self {
            upper_ms,
            sampled_local_ms: received_local_ms,
            sampled_mono: Instant::now(),
        })
    }

    fn upper_now(&self) -> Result<u64> {
        let elapsed = u64::try_from(self.sampled_mono.elapsed().as_millis())?;
        let wall = now_ms()?;
        let monotonic = self
            .upper_ms
            .checked_add(elapsed)
            .context("clock overflow")?;
        let expected_wall = self.sampled_local_ms.saturating_add(elapsed);
        let drift = wall.abs_diff(expected_wall);
        ensure!(
            drift <= 5_000,
            "wall and monotonic clocks drifted; re-admission required"
        );
        Ok(monotonic.max(wall.checked_add(5_000).context("local clock overflow")?))
    }
}

fn now_ms() -> Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock before unix epoch")?
        .as_millis()
        .try_into()?)
}

fn safe_session(session: &str) -> Result<()> {
    ensure!(
        !session.is_empty()
            && session.len() <= 64
            && session
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        "session must be 1-64 ASCII letters, digits, '-' or '_'"
    );
    Ok(())
}

fn session_path(root: &Path, session: &str) -> PathBuf {
    root.join("channels")
        .join("sessions")
        .join(format!("{session}.json"))
}

fn reservation_path(root: &Path, session: &str) -> PathBuf {
    root.join("channels")
        .join("sessions")
        .join(format!("{session}.reservation.json"))
}

fn provider_path(root: &Path, channel: Address) -> PathBuf {
    root.join("channels")
        .join("live")
        .join(format!("{channel}.json"))
}

fn offer_path(root: &Path, offer: &cp::Offer) -> Result<PathBuf> {
    Ok(root
        .join("channels")
        .join("offers")
        .join(format!("{}.json", hex::encode(cp::offer_hash(offer)?))))
}

fn result_path(root: &Path, session: &str, sequence: u64) -> PathBuf {
    root.join("channels")
        .join("results")
        .join(session)
        .join(format!("{sequence}.bin"))
}

fn persist_session(root: &Path, session: &SessionJournal) -> Result<()> {
    store::write(&session_path(root, &session.session), session)
}

fn persist_provider(root: &Path, journal: &ProviderJournal) -> Result<()> {
    store::write(&provider_path(root, journal.channel), journal)
}

fn reservation_from_session(session: &SessionJournal) -> SessionReservation {
    SessionReservation {
        version: session.version,
        role: session.role.clone(),
        session: session.session.clone(),
        buyer: session.buyer,
        provider: session.provider,
        opening_nonce: session.opening_nonce.clone(),
        requested_jobs: session.requested_jobs,
        requested_deposit: session.requested_deposit,
        max_unit_price: session.max_unit_price,
        expected_result_hash: session.expected_result_hash.clone(),
    }
}

fn validate_reservation(reservation: &SessionReservation, session: &str) -> Result<()> {
    safe_session(session)?;
    ensure!(
        reservation.version == cp::VERSION,
        "unsupported session reservation version"
    );
    ensure!(
        reservation.role == "buyer",
        "invalid session reservation role"
    );
    ensure!(
        reservation.session == session,
        "session reservation name mismatch"
    );
    ensure!(reservation.buyer != ZERO && reservation.provider != ZERO);
    ensure!(reservation.opening_nonce.len() == OPENING_NONCE_LEN);
    ensure!(reservation.requested_jobs > 0 && reservation.requested_jobs <= 1_000);
    ensure!(reservation.requested_deposit > 0 && reservation.max_unit_price > 0);
    ensure!(reservation.expected_result_hash.len() == 32);
    Ok(())
}

fn session_has_history(root: &Path, session: &str) -> Result<bool> {
    let prefix = format!("{session}.");
    let tx_dir = root.join("channels").join("tx");
    if tx_dir.exists() {
        for entry in fs::read_dir(tx_dir)? {
            let entry = entry?;
            if entry.file_name().to_string_lossy().starts_with(&prefix) {
                return Ok(true);
            }
        }
    }
    let results_dir = root.join("channels").join("results").join(session);
    if results_dir.exists() {
        for entry in fs::read_dir(results_dir)? {
            if entry?.path().is_file() {
                return Ok(true);
            }
        }
    }
    Ok(false)
}

fn reserve_session(
    root: &Path,
    identity: &ChannelIdentity,
    opts: &BuyOptions,
    expected_hash: &[u8],
) -> Result<SessionReservation> {
    let journal = session_path(root, &opts.session);
    let marker = reservation_path(root, &opts.session);
    if journal.exists() {
        let session = read_session(root, &opts.session)?;
        ensure!(
            session.buyer == identity.agent,
            "session belongs to another buyer"
        );
        let expected = reservation_from_session(&session);
        validate_reservation(&expected, &opts.session)?;
        if marker.exists() {
            let saved: SessionReservation = store::read(&marker)?;
            validate_reservation(&saved, &opts.session)?;
            ensure!(
                saved == expected,
                "session reservation differs from journal"
            );
        } else {
            // A valid journal from before reservations were introduced may be
            // adopted once.  The marker is retained if the journal later goes
            // missing, preventing a fresh nonce from being invented.
            store::write(&marker, &expected)?;
        }
        return Ok(expected);
    }
    ensure!(
        !marker.exists(),
        "session journal is missing but its durable reservation remains"
    );
    ensure!(
        !session_has_history(root, &opts.session)?,
        "session journal is missing but transaction or result history remains"
    );
    let reservation = SessionReservation {
        version: cp::VERSION,
        role: "buyer".to_owned(),
        session: opts.session.clone(),
        buyer: identity.agent,
        provider: opts.provider,
        opening_nonce: random_nonce(),
        requested_jobs: opts.jobs,
        requested_deposit: opts.deposit,
        max_unit_price: opts.max_unit_price,
        expected_result_hash: expected_hash.to_vec(),
    };
    validate_reservation(&reservation, &opts.session)?;
    store::write(&marker, &reservation)?;
    Ok(reservation)
}

fn read_session(root: &Path, id: &str) -> Result<SessionJournal> {
    let value: SessionJournal = store::read(&session_path(root, id))?;
    ensure!(value.session == id, "session journal name mismatch");
    ensure!(
        value.version == cp::VERSION,
        "unsupported session journal version"
    );
    validate_session_journal(&value)?;
    Ok(value)
}

fn read_provider(root: &Path, channel: Address) -> Result<ProviderJournal> {
    let value: ProviderJournal = store::read(&provider_path(root, channel))?;
    ensure!(value.channel == channel, "channel journal name mismatch");
    ensure!(
        value.version == cp::VERSION,
        "unsupported channel journal version"
    );
    validate_provider_journal(&value)?;
    Ok(value)
}

fn provider_admission_key(channel: Address) -> Vec<u8> {
    channel.as_bytes().to_vec()
}

fn random_nonce() -> Vec<u8> {
    SecretKey::generate().to_bytes().to_vec()
}

fn canonical_path(path: &Path) -> Result<PathBuf> {
    path.canonicalize()
        .with_context(|| format!("canonicalize {}", path.display()))
}

fn address(value: &Value, name: &str) -> Result<Address> {
    serde_json::from_value(
        value
            .get(name)
            .cloned()
            .context(format!("missing {name}"))?,
    )
    .with_context(|| format!("invalid {name}"))
}

fn string(value: &Value, name: &str) -> Result<String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .with_context(|| format!("missing {name}"))
}

fn u64_value(value: &Value, name: &str) -> Result<u64> {
    let s = string(value, name)?;
    let result = s.parse::<u64>()?;
    ensure!(result.to_string() == s, "noncanonical chain integer {name}");
    Ok(result)
}

fn state_u64(value: &Value, name: &str) -> u64 {
    value
        .get(name)
        .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
        .unwrap_or(0)
}

fn agent_field(parties: &Value, role: &str, field: &str) -> Result<Value> {
    parties
        .get(role)
        .and_then(|v| v.get(field))
        .cloned()
        .with_context(|| format!("missing {role}.{field}"))
}

fn agent_address(parties: &Value, role: &str, field: &str) -> Result<Address> {
    serde_json::from_value(agent_field(parties, role, field)?).context("invalid agent address")
}

fn agent_bytes(parties: &Value, role: &str, field: &str) -> Result<Vec<u8>> {
    serde_json::from_value(agent_field(parties, role, field)?).context("invalid agent bytes")
}

fn timestamp(parties: &Value) -> Result<u64> {
    u64_value(parties, "timestamp_ms")
}

fn verify_statement<T: Serialize>(value: &T, signature: &[u8], key: &[u8]) -> Result<()> {
    protocol::verify(value, signature, key).context("invalid application signature")
}

fn validate_offer_journal(journal: &OfferJournal) -> Result<()> {
    ensure!(
        journal.version == cp::VERSION,
        "unsupported offer journal version"
    );
    validate_offer_context(&journal.offer.payload, &journal.terms)?;
    verify_statement(
        &journal.offer.payload,
        &journal.offer.signature,
        &journal.offer.payload.provider_key,
    )?;
    if let Some(channel) = journal.channel {
        ensure!(channel != ZERO, "invalid bound offer channel");
    }
    Ok(())
}

fn validate_offer_context(offer: &cp::Offer, terms: &cp::FixtureTerms) -> Result<()> {
    offer.validate()?;
    terms.validate()?;
    ensure!(
        offer.terms_hash == cp::terms_hash(terms)?,
        "offer terms mismatch"
    );
    ensure!(terms.result_hash.len() == 32, "invalid fixture result hash");
    ensure!(
        terms.max_unfulfilled_jobs == 1,
        "unsupported unfulfilled-job budget"
    );
    ensure!(
        terms.max_jobs > 0 && terms.max_jobs <= 1_000,
        "invalid channel job limit"
    );
    ensure!(terms.unit_price > 0, "zero channel unit price");
    ensure!(offer.deposit >= terms.unit_price, "deposit below one job");
    ensure!(
        offer.buyer_key.len() == 32 && offer.provider_key.len() == 32,
        "invalid endpoint key"
    );
    ensure!(
        offer.opening_nonce.len() == OPENING_NONCE_LEN,
        "invalid opening nonce"
    );
    ensure!(offer.offer_expires_ms < offer.work_deadline_ms);
    ensure!(offer.work_deadline_ms < offer.claim_deadline_ms);
    ensure!(offer.claim_deadline_ms - offer.work_deadline_ms >= MIN_GRACE_MS);
    ensure!(
        offer.claim_deadline_ms.saturating_sub(now_ms()?) <= MAX_LIFETIME_MS,
        "claim deadline too far away"
    );
    Ok(())
}

fn credit_for(
    offer: &cp::Offer,
    channel: Address,
    request_hash: Vec<u8>,
    sequence: u64,
    amount: u64,
    previous: Vec<u8>,
) -> Result<cp::Credit> {
    Ok(cp::Credit {
        purpose: b"m2m/channel/credit/v1".to_vec(),
        method: cp::METHOD.as_bytes().to_vec(),
        version: cp::VERSION,
        network: offer.network.clone(),
        package_id: offer.package_id,
        deployment: offer.deployment,
        buyer: offer.buyer,
        provider: offer.provider,
        channel,
        offer_hash: cp::offer_hash(offer)?,
        sequence,
        cumulative_amount: amount,
        request_hash,
        previous_transcript_hash: previous,
    })
}

fn ack_for(
    offer: &cp::Offer,
    channel: Address,
    credit: &cp::Credit,
    credit_hash: Vec<u8>,
) -> cp::Ack {
    cp::Ack {
        purpose: b"m2m/channel/ack/v1".to_vec(),
        method: cp::METHOD.as_bytes().to_vec(),
        version: cp::VERSION,
        network: offer.network.clone(),
        package_id: offer.package_id,
        deployment: offer.deployment,
        buyer: offer.buyer,
        provider: offer.provider,
        channel,
        offer_hash: credit.offer_hash.clone(),
        sequence: credit.sequence,
        cumulative_amount: credit.cumulative_amount,
        credit_hash,
    }
}

fn result_for(
    offer: &cp::Offer,
    channel: Address,
    request: &cp::RequestDescriptor,
    credit: &cp::Credit,
    result_hash: Vec<u8>,
) -> Result<cp::ResultStatement> {
    Ok(cp::ResultStatement {
        purpose: b"m2m/channel/result/v1".to_vec(),
        method: cp::METHOD.as_bytes().to_vec(),
        version: cp::VERSION,
        network: offer.network.clone(),
        package_id: offer.package_id,
        deployment: offer.deployment,
        buyer: offer.buyer,
        provider: offer.provider,
        channel,
        offer_hash: credit.offer_hash.clone(),
        request_hash: cp::request_hash(request)?,
        credit_hash: cp::credit_hash(credit)?,
        result_hash,
    })
}

fn close_for(
    offer: &cp::Offer,
    channel: Address,
    sequence: u64,
    amount: u64,
    transcript_hash: Vec<u8>,
) -> Result<cp::Close> {
    Ok(cp::Close {
        purpose: b"m2m/channel/close/v1".to_vec(),
        method: cp::METHOD.as_bytes().to_vec(),
        version: cp::VERSION,
        network: offer.network.clone(),
        package_id: offer.package_id,
        deployment: offer.deployment,
        buyer: offer.buyer,
        provider: offer.provider,
        channel,
        offer_hash: cp::offer_hash(offer)?,
        final_sequence: sequence,
        final_amount: amount,
        transcript_hash,
    })
}

fn envelope(
    buyer: Address,
    provider: Address,
    agreement_id: Address,
    request_id: &[u8],
    message: cp::Message,
) -> cp::Envelope {
    cp::Envelope {
        version: cp::VERSION,
        method: cp::METHOD.to_owned(),
        buyer,
        provider,
        agreement_id,
        request_id: String::from_utf8_lossy(request_id).into_owned(),
        message,
    }
}

fn message_name(message: &cp::Message) -> &'static str {
    match message {
        cp::Message::OfferRequest { .. } => "payment.offer_request",
        cp::Message::Offer { .. } => "payment.offer",
        cp::Message::Resume {} => "session.resume",
        cp::Message::Ready { .. } => "session.ready",
        cp::Message::Authorize { .. } => "payment.authorize",
        cp::Message::Acknowledge { .. } => "payment.acknowledge",
        cp::Message::Get { .. } => "work.get",
        cp::Message::Result { .. } => "work.result",
        cp::Message::Close { .. } => "payment.close",
        cp::Message::CloseAcknowledge { .. } => "payment.close_acknowledge",
        cp::Message::Settlement { .. } => "payment.settlement",
        cp::Message::Error { .. } => "error",
    }
}

fn validate_envelope_context(value: &cp::Envelope) -> Result<()> {
    match &value.message {
        cp::Message::Offer { offer, .. } => {
            ensure!(offer.payload.buyer == value.buyer && offer.payload.provider == value.provider);
        }
        cp::Message::Ready {
            highest_credit,
            certificate,
            ..
        } => {
            if let Some(credit) = highest_credit {
                ensure!(
                    credit.payload.buyer == value.buyer
                        && credit.payload.provider == value.provider
                        && credit.payload.channel == value.agreement_id
                );
            }
            if let Some(certificate) = certificate {
                ensure!(
                    certificate.close.buyer == value.buyer
                        && certificate.close.provider == value.provider
                        && certificate.close.channel == value.agreement_id
                );
            }
        }
        cp::Message::Authorize { request, credit } => {
            ensure!(request.channel == value.agreement_id);
            ensure!(
                credit.payload.buyer == value.buyer
                    && credit.payload.provider == value.provider
                    && credit.payload.channel == value.agreement_id
            );
            ensure!(value.request_id.as_bytes() == request.request_id.as_slice());
        }
        cp::Message::Acknowledge { ack } => {
            ensure!(
                ack.payload.buyer == value.buyer
                    && ack.payload.provider == value.provider
                    && ack.payload.channel == value.agreement_id
            );
        }
        cp::Message::Result { result, .. } => {
            ensure!(
                result.payload.buyer == value.buyer
                    && result.payload.provider == value.provider
                    && result.payload.channel == value.agreement_id
            );
        }
        cp::Message::Close { close } => {
            ensure!(
                close.payload.buyer == value.buyer
                    && close.payload.provider == value.provider
                    && close.payload.channel == value.agreement_id
            );
        }
        cp::Message::CloseAcknowledge { certificate } => {
            ensure!(
                certificate.close.buyer == value.buyer
                    && certificate.close.provider == value.provider
                    && certificate.close.channel == value.agreement_id
            );
        }
        cp::Message::OfferRequest { .. }
        | cp::Message::Resume {}
        | cp::Message::Get { .. }
        | cp::Message::Settlement { .. }
        | cp::Message::Error { .. } => {}
    }
    Ok(())
}

fn validate_response_context(request: &cp::Envelope, response: &cp::Envelope) -> Result<()> {
    ensure!(response.version == request.version);
    ensure!(response.method == request.method);
    ensure!(response.buyer == request.buyer);
    ensure!(response.provider == request.provider);
    ensure!(response.agreement_id == request.agreement_id);
    ensure!(response.request_id == request.request_id);
    validate_envelope_context(response)
}

fn error_message(code: &str, message: impl Into<String>) -> cp::Message {
    let mut message = message.into();
    if message.len() > MAX_DIAGNOSTIC {
        let mut end = MAX_DIAGNOSTIC;
        while !message.is_char_boundary(end) {
            end -= 1;
        }
        message.truncate(end);
    }
    cp::Message::Error {
        code: code.to_owned(),
        message,
    }
}

async fn connect(
    ticket_path: &Path,
    key: SecretKey,
    relay: bool,
    relay_only: bool,
) -> Result<(Endpoint, Connection, cp::Ticket)> {
    let ticket: cp::Ticket = store::read(ticket_path)?;
    ticket.validate()?;
    let mut builder = if relay || relay_only {
        Endpoint::builder(presets::N0)
    } else {
        Endpoint::builder(presets::Minimal)
    };
    if relay_only {
        builder = builder.clear_ip_transports();
    }
    let endpoint = builder
        .secret_key(key)
        .alpns(vec![cp::ALPN.to_vec()])
        .bind()
        .await?;
    if relay || relay_only {
        timeout(Duration::from_secs(30), endpoint.online()).await?;
    }
    let started = Instant::now();
    let connection = timeout(
        Duration::from_secs(30),
        endpoint.connect(ticket.endpoint.clone(), cp::ALPN),
    )
    .await??;
    ensure!(
        connection.remote_id().as_bytes() == ticket.endpoint.id.as_bytes(),
        "connected peer differs from ticket endpoint"
    );
    eprintln!(
        "{}",
        json!({"event":"channel_connected", "peer":connection.remote_id().to_string(), "elapsed_ms":started.elapsed().as_millis(), "timestamp_ms":now_ms()?, "paths":format!("{:?}", connection.paths())})
    );
    Ok((endpoint, connection, ticket))
}

async fn exchange(connection: &Connection, request: &cp::Envelope) -> Result<cp::Envelope> {
    request.validate()?;
    validate_envelope_context(request)?;
    let (mut send, mut recv) = timeout(Duration::from_secs(10), connection.open_bi()).await??;
    send.write_all(&serde_json::to_vec(request)?).await?;
    send.finish()?;
    let raw = timeout(Duration::from_secs(180), recv.read_to_end(MAX_FRAME)).await??;
    let response: cp::Envelope =
        serde_json::from_slice(&raw).context("invalid channel response")?;
    response.validate()?;
    validate_response_context(request, &response)?;
    if let cp::Message::Error { code, message } = &response.message {
        bail!("channel peer {code}: {message}");
    }
    Ok(response)
}

struct ChannelBridge {
    config: Config,
    calls: AtomicU64,
}

impl ChannelBridge {
    fn new(config: Config) -> Self {
        Self {
            config,
            calls: AtomicU64::new(0),
        }
    }

    async fn call(&self, mut args: Value, phase: &str) -> Result<Value> {
        let operation = args
            .get("action")
            .and_then(Value::as_str)
            .unwrap_or("unknown")
            .to_owned();
        let call_count = self.calls.fetch_add(1, Ordering::Relaxed) + 1;
        let started = Instant::now();
        args["config"] = serde_json::to_value(&self.config)?;
        let mut child = Command::new("node")
            .args(["--import", "tsx", "scripts/channel-chain.ts"])
            .current_dir(env!("CARGO_MANIFEST_DIR"))
            .env("M2M_CHANNEL_RPC_PHASE", phase)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .context("start channel Sui adapter; run npm ci first")?;
        let mut stdin = child
            .stdin
            .take()
            .context("missing channel adapter stdin")?;
        stdin.write_all(&serde_json::to_vec(&args)?).await?;
        drop(stdin);
        let output = timeout(Duration::from_secs(90), child.wait_with_output())
            .await
            .context("channel adapter timed out; outcome may be pending")??;
        let stderr = String::from_utf8_lossy(&output.stderr);
        let mut rpc_calls = 0u64;
        for line in stderr.lines() {
            if let Ok(event) = serde_json::from_str::<Value>(line)
                && event["event"] == "channel_rpc"
            {
                if event["result"] == "started" || event["result"] == "denied" {
                    rpc_calls += 1;
                }
                eprintln!("{line}");
            }
        }
        if !output.status.success() {
            let message = stderr.to_string();
            eprintln!(
                "{}",
                json!({"event":"channel_bridge","operation":operation,"phase":phase,"result":"error","call_count":call_count,"rpc_calls":rpc_calls,"elapsed_ms":started.elapsed().as_millis()})
            );
            bail!("channel operation failed: {message}");
        }
        let value: Value =
            serde_json::from_slice(&output.stdout).context("invalid channel adapter response")?;
        eprintln!(
            "{}",
            json!({"event":"channel_bridge","operation":operation,"phase":phase,"result":"ok","call_count":call_count,"rpc_calls":rpc_calls,"elapsed_ms":started.elapsed().as_millis()})
        );
        Ok(value)
    }
}

fn parse_mutation(value: &Value) -> Result<(Address, Option<String>, Value, bool)> {
    Ok((
        address(value, "channel")?,
        value
            .get("digest")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        value
            .get("state")
            .cloned()
            .context("missing channel state")?,
        value
            .get("recovered")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    ))
}

fn state_status(value: &Value) -> u8 {
    value
        .get("status")
        .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
        .unwrap_or(0) as u8
}

fn journal_jobs(jobs: &[JobRecord]) -> Result<(u64, u64)> {
    let completed = jobs.iter().filter(|job| job.completed).count() as u64;
    let amount = jobs
        .iter()
        .map(|job| {
            ensure!(
                job.credit.payload.sequence > 0,
                "invalid saved credit sequence"
            );
            Ok(job.credit.payload.cumulative_amount)
        })
        .collect::<Result<Vec<_>>>()?
        .into_iter()
        .max()
        .unwrap_or(0);
    Ok((completed, amount))
}

fn validate_close_binding(
    offer: &cp::Offer,
    channel: Address,
    jobs: &[JobRecord],
    transcript_hash: &[u8],
    close: &cp::Close,
) -> Result<()> {
    close.validate()?;
    ensure!(
        close.channel == channel,
        "close channel differs from journal"
    );
    ensure!(close.offer_hash == cp::offer_hash(offer)?);
    ensure!(
        close.method == offer.method
            && close.version == offer.version
            && close.network == offer.network
            && close.package_id == offer.package_id
            && close.deployment == offer.deployment,
        "close domain differs from offer"
    );
    ensure!(
        close.buyer == offer.buyer && close.provider == offer.provider,
        "close parties differ from offer"
    );
    let (_, amount) = journal_jobs(jobs)?;
    ensure!(
        close.final_sequence == jobs.len() as u64 && close.final_amount == amount,
        "close is not the highest saved credit"
    );
    ensure!(close.transcript_hash == transcript_hash);
    Ok(())
}

fn validate_close_certificate_binding(
    offer: &cp::Offer,
    channel: Address,
    jobs: &[JobRecord],
    transcript_hash: &[u8],
    certificate: &cp::CloseCertificate,
) -> Result<()> {
    certificate.validate()?;
    validate_close_binding(offer, channel, jobs, transcript_hash, &certificate.close)?;
    verify_statement(
        &certificate.close,
        &certificate.buyer_signature,
        &offer.buyer_key,
    )?;
    verify_statement(
        &certificate.close,
        &certificate.provider_signature,
        &offer.provider_key,
    )?;
    Ok(())
}

fn highest_credit(jobs: &[JobRecord]) -> Option<cp::Signed<cp::Credit>> {
    jobs.iter()
        .max_by_key(|job| job.credit.payload.sequence)
        .map(|job| job.credit.clone())
}

fn find_job<'a>(jobs: &'a [JobRecord], request_hash: &[u8]) -> Option<&'a JobRecord> {
    jobs.iter().find(|job| {
        cp::request_hash(&job.request)
            .map(|hash| hash == request_hash)
            .unwrap_or(false)
    })
}

fn find_job_mut<'a>(jobs: &'a mut [JobRecord], request_hash: &[u8]) -> Option<&'a mut JobRecord> {
    jobs.iter_mut().find(|job| {
        cp::request_hash(&job.request)
            .map(|hash| hash == request_hash)
            .unwrap_or(false)
    })
}

fn check_job_context(
    offer: &cp::Offer,
    channel: Address,
    request: &cp::RequestDescriptor,
    credit: &cp::Credit,
    previous: &[u8],
) -> Result<()> {
    request.validate()?;
    credit.validate()?;
    ensure!(
        credit.method == offer.method && credit.version == offer.version,
        "credit method/version differs from offer"
    );
    ensure!(
        credit.network == offer.network
            && credit.package_id == offer.package_id
            && credit.deployment == offer.deployment,
        "credit domain differs from offer"
    );
    ensure!(
        credit.buyer == offer.buyer && credit.provider == offer.provider,
        "credit parties differ from offer"
    );
    ensure!(
        request.channel == channel && credit.channel == channel,
        "wrong channel binding"
    );
    ensure!(
        request.terms_hash == offer.terms_hash,
        "wrong terms binding"
    );
    ensure!(
        credit.offer_hash == cp::offer_hash(offer)?,
        "wrong offer binding"
    );
    ensure!(
        credit.request_hash == cp::request_hash(request)?,
        "wrong request binding"
    );
    ensure!(
        credit.previous_transcript_hash == previous,
        "wrong transcript predecessor"
    );
    ensure!(
        request.request_sequence == credit.sequence,
        "request and credit sequence differ"
    );
    ensure!(!request.request_id.is_empty(), "empty request ID");
    Ok(())
}

fn validate_result(
    offer: &cp::Offer,
    expected_result_hash: &[u8],
    request: &cp::RequestDescriptor,
    credit: &cp::Credit,
    result: &cp::Signed<cp::ResultStatement>,
    bytes: &[u8],
    provider_key: &[u8],
) -> Result<()> {
    result.payload.validate()?;
    verify_statement(&result.payload, &result.signature, provider_key)?;
    ensure!(bytes.len() <= MAX_FILE, "channel result exceeds 64 KiB");
    ensure!(
        protocol::hash(bytes) == result.payload.result_hash,
        "channel result hash mismatch"
    );
    ensure!(
        result.payload.result_hash == expected_result_hash,
        "channel result differs from fixture terms"
    );
    ensure!(result.payload.offer_hash == cp::offer_hash(offer)?);
    ensure!(
        result.payload.method == offer.method && result.payload.version == offer.version,
        "result method/version differs from offer"
    );
    ensure!(
        result.payload.network == offer.network
            && result.payload.package_id == offer.package_id
            && result.payload.deployment == offer.deployment,
        "result domain differs from offer"
    );
    ensure!(
        result.payload.buyer == offer.buyer
            && result.payload.provider == offer.provider
            && result.payload.channel == credit.channel,
        "result parties differ from offer"
    );
    ensure!(result.payload.request_hash == cp::request_hash(request)?);
    ensure!(result.payload.credit_hash == cp::credit_hash(credit)?);
    ensure!(
        result.payload.result_hash.len() == 32,
        "invalid result hash"
    );
    Ok(())
}

fn validate_records(
    offer: &cp::Offer,
    terms: &cp::FixtureTerms,
    channel: Address,
    jobs: &[JobRecord],
) -> Result<Vec<u8>> {
    let mut transcript = cp::transcript_start(channel, offer)?;
    let mut expected_sequence = 1u64;
    let mut request_ids = HashSet::new();
    let mut pending = false;
    for job in jobs {
        job.request.validate()?;
        job.credit.validate()?;
        ensure!(
            job.request.request_sequence == expected_sequence,
            "saved job sequence has a gap or duplicate"
        );
        ensure!(
            request_ids.insert(job.request.request_id.clone()),
            "saved request ID is reused"
        );
        check_job_context(
            offer,
            channel,
            &job.request,
            &job.credit.payload,
            &transcript,
        )?;
        verify_statement(&job.credit.payload, &job.credit.signature, &offer.buyer_key)?;
        ensure!(
            job.credit.payload.cumulative_amount
                == terms
                    .unit_price
                    .checked_mul(expected_sequence)
                    .context("saved credit amount overflow")?,
            "saved credit amount is inconsistent"
        );
        if let Some(ack) = &job.ack {
            ack.validate()?;
            validate_ack(offer, channel, &job.credit, ack, &offer.provider_key)?;
        }
        if let Some(result) = &job.result {
            let path = Path::new(
                job.result_file
                    .as_deref()
                    .context("saved result has no file")?,
            );
            let bytes =
                store::read::<Vec<u8>>(path).context("saved result bytes are unreadable")?;
            validate_result(
                offer,
                &terms.result_hash,
                &job.request,
                &job.credit.payload,
                result,
                &bytes,
                &offer.provider_key,
            )?;
            ensure!(job.ack.is_some(), "saved result has no acknowledgement");
        }
        if job.completed {
            ensure!(!pending, "completed job follows an unfulfilled credit");
            ensure!(
                job.ack.is_some() && job.result.is_some(),
                "completed job is missing a durable record"
            );
            let next = cp::transcript_next(
                &transcript,
                &job.request,
                &job.credit.payload,
                &job.ack.as_ref().context("missing acknowledgement")?.payload,
                &job.result.as_ref().context("missing result")?.payload,
            )?;
            ensure!(
                job.transcript_after.as_deref() == Some(next.as_slice()),
                "completed job transcript is inconsistent"
            );
            transcript = next;
        } else {
            ensure!(!pending, "more than one unfulfilled credit is saved");
            pending = true;
            ensure!(
                job.transcript_after.is_none(),
                "pending job has a transcript advancement"
            );
        }
        expected_sequence = expected_sequence
            .checked_add(1)
            .context("saved sequence overflow")?;
    }
    Ok(transcript)
}

fn validate_session_journal(session: &SessionJournal) -> Result<()> {
    ensure!(session.role == "buyer", "invalid session role");
    ensure!(
        session.opening_nonce.len() == OPENING_NONCE_LEN,
        "invalid saved opening nonce"
    );
    ensure!(
        session.expected_result_hash.len() == 32,
        "invalid saved fixture hash"
    );
    if let Some(offer) = &session.offer {
        validate_offer_context(
            &offer.payload,
            session.terms.as_ref().context("saved offer has no terms")?,
        )?;
        verify_statement(
            &offer.payload,
            &offer.signature,
            &offer.payload.provider_key,
        )?;
        if let Some(channel) = session.channel {
            let root_hash = validate_records(
                &offer.payload,
                session.terms.as_ref().context("saved offer has no terms")?,
                channel,
                &session.jobs,
            )?;
            if let Some(saved_root) = &session.transcript_hash {
                ensure!(
                    saved_root == &root_hash,
                    "saved transcript root is inconsistent"
                );
            }
        } else {
            ensure!(
                session.jobs.is_empty(),
                "session has jobs before channel opening"
            );
        }
    } else {
        ensure!(
            session.terms.is_none() && session.channel.is_none() && session.jobs.is_empty(),
            "session has state without an offer"
        );
    }
    if let Some(close) = &session.close {
        let offer = session.offer.as_ref().context("saved close has no offer")?;
        let channel = session.channel.context("saved close has no channel")?;
        let transcript = session
            .transcript_hash
            .as_deref()
            .context("saved close has no transcript")?;
        validate_close_binding(
            &offer.payload,
            channel,
            &session.jobs,
            transcript,
            &close.payload,
        )?;
        verify_statement(&close.payload, &close.signature, &offer.payload.buyer_key)?;
        ensure!(session.frozen, "saved close did not freeze session");
    }
    if let Some(certificate) = &session.certificate {
        let offer = session
            .offer
            .as_ref()
            .context("saved certificate has no offer")?;
        let channel = session
            .channel
            .context("saved certificate has no channel")?;
        let transcript = session
            .transcript_hash
            .as_deref()
            .context("saved certificate has no transcript")?;
        validate_close_certificate_binding(
            &offer.payload,
            channel,
            &session.jobs,
            transcript,
            certificate,
        )?;
        ensure!(
            Some(certificate.close.clone())
                == session.close.as_ref().map(|close| close.payload.clone()),
            "saved certificate differs from close candidate"
        );
        ensure!(session.frozen, "saved certificate did not freeze session");
    }
    Ok(())
}

fn validate_provider_journal(journal: &ProviderJournal) -> Result<()> {
    ensure!(journal.role == "provider", "invalid provider journal role");
    ensure!(journal.channel != ZERO, "invalid provider channel ID");
    validate_offer_context(&journal.offer.payload, &journal.terms)?;
    ensure!(
        journal.offer.payload.buyer == journal.buyer
            && journal.offer.payload.provider == journal.provider,
        "provider journal parties mismatch"
    );
    verify_statement(
        &journal.offer.payload,
        &journal.offer.signature,
        &journal.offer.payload.provider_key,
    )?;
    let root_hash = validate_records(
        &journal.offer.payload,
        &journal.terms,
        journal.channel,
        &journal.jobs,
    )?;
    ensure!(
        root_hash == journal.transcript_hash,
        "provider transcript root is inconsistent"
    );
    if let Some(close) = &journal.close {
        validate_close_binding(
            &journal.offer.payload,
            journal.channel,
            &journal.jobs,
            &journal.transcript_hash,
            &close.payload,
        )?;
        verify_statement(
            &close.payload,
            &close.signature,
            &journal.offer.payload.buyer_key,
        )?;
        ensure!(
            journal.frozen,
            "saved provider close did not freeze channel"
        );
    }
    if let Some(certificate) = &journal.certificate {
        validate_close_certificate_binding(
            &journal.offer.payload,
            journal.channel,
            &journal.jobs,
            &journal.transcript_hash,
            certificate,
        )?;
        ensure!(
            Some(certificate.close.clone())
                == journal.close.as_ref().map(|close| close.payload.clone()),
            "provider certificate differs from close candidate"
        );
    }
    Ok(())
}

fn stop_requested(stop: &Option<String>, point: &str) -> bool {
    stop.as_deref() == Some(point)
}

fn summary(session: &SessionJournal) -> Result<Value> {
    let (completed, authorized) = journal_jobs(&session.jobs)?;
    let status = session.chain_state.as_ref().map(state_status);
    let phase = match status {
        Some(1) => "closed",
        Some(2) => "refunded",
        _ if session.frozen => "frozen",
        _ => "active",
    };
    Ok(json!({
        "session": session.session,
        "channel": session.channel,
        "phase": phase,
        "requested_jobs": session.requested_jobs,
        "completed_jobs": completed,
        "authorized": authorized,
        "redeemed": session.chain_state.as_ref().and_then(|v| v.get("redeemed_amount")).cloned().unwrap_or(Value::from(0)),
        "residual": session.chain_state.as_ref().and_then(|v| v.get("funds")).cloned().unwrap_or(Value::Null),
        "terminal": status.map(|s| s != 0).unwrap_or(false),
        "digest": session.chain_digest,
    }))
}

async fn buyer_open(
    root: &Path,
    bridge: &ChannelBridge,
    identity: &ChannelIdentity,
    session: &mut SessionJournal,
    signer: &Path,
    stop: &Option<String>,
) -> Result<bool> {
    let offer = session.offer.as_ref().context("missing saved offer")?;
    let open_journal = root
        .join("channels")
        .join("tx")
        .join(format!("{}.open.tx.json", session.session));
    if session.channel.is_none() {
        let result = bridge
            .call(
                json!({
                    "action":"channel_open",
                    "offer":offer.payload,
                    "signature":offer.signature,
                    "signer_file":canonical_path(signer)?,
                    "journal":open_journal,
                }),
                "open",
            )
            .await;
        let value = match result {
            Ok(value) => value,
            Err(error) => {
                let lookup = bridge
                    .call(
                        json!({
                            "action":"channel_lookup",
                            "buyer":session.buyer,
                            "opening_nonce":session.opening_nonce,
                        }),
                        "open-reconcile",
                    )
                    .await?;
                if let Some(id) = lookup
                    .get("channel")
                    .and_then(|v| serde_json::from_value(v.clone()).ok())
                {
                    let snapshot = bridge
                        .call(
                            json!({"action":"channel_snapshot","id":id}),
                            "open-reconcile",
                        )
                        .await?;
                    let state = snapshot
                        .get("channel")
                        .cloned()
                        .context("missing channel state while reconciling open")?;
                    let onchain_offer: cp::Offer = serde_json::from_value(
                        state
                            .get("offer")
                            .cloned()
                            .context("channel snapshot omits offer")?,
                    )?;
                    ensure!(
                        onchain_offer == offer.payload,
                        "nonce mapping belongs to a different offer"
                    );
                    session.channel = Some(id);
                    session.chain_state = Some(state.clone());
                    persist_session(root, session)?;
                    id_value(id, state)
                } else {
                    return Err(error)
                        .context("channel open outcome unknown; no nonce mapping found");
                }
            }
        };
        let (channel, digest, state, recovered) = parse_mutation(&value)?;
        ensure!(channel != ZERO, "channel open returned zero ID");
        let onchain_offer: cp::Offer = serde_json::from_value(
            state
                .get("offer")
                .cloned()
                .context("channel open response omits offer")?,
        )?;
        ensure!(
            onchain_offer == offer.payload,
            "channel open returned a different offer"
        );
        session.channel = Some(channel);
        session.chain_state = Some(state);
        session.chain_digest = digest;
        persist_session(root, session)?;
        eprintln!(
            "{}",
            json!({"event":"channel_admitted","session":session.session,"channel":channel,"recovered":recovered})
        );
    }
    if stop_requested(stop, "opened") {
        return Ok(true);
    }
    let _ = identity;
    Ok(false)
}

fn id_value(id: Address, state: Value) -> Value {
    json!({"channel":id,"digest":null,"state":state,"recovered":true})
}

async fn buyer_jobs(
    root: &Path,
    identity: &ChannelIdentity,
    session: &mut SessionJournal,
    connection: &Connection,
    expected: &[u8],
    opts: &BuyOptions,
    anchor: &ClockAnchor,
) -> Result<Option<&'static str>> {
    let offer = session.offer.clone().context("missing offer")?;
    let terms = session.terms.clone().context("missing terms")?;
    let channel = session.channel.context("missing channel")?;
    ensure!(
        opts.jobs > 0 && opts.jobs <= terms.max_jobs,
        "requested jobs exceed offer"
    );
    ensure!(
        terms.unit_price <= opts.max_unit_price,
        "provider price exceeds local maximum"
    );
    ensure!(
        opts.deposit
            >= terms
                .unit_price
                .checked_mul(opts.jobs)
                .context("deposit overflow")?,
        "deposit does not cover requested jobs"
    );
    let expected_hash = protocol::hash(expected);
    ensure!(
        expected_hash == terms.result_hash,
        "expected file differs from offer"
    );
    let rpc_guard = JobsRpcGuard::begin(&identity.chain.network)?;
    let start = Instant::now();
    eprintln!(
        "{}",
        json!({"event":"channel_jobs_begin","session":session.session,"channel":channel,"jobs":opts.jobs,"timestamp_ms":now_ms()?})
    );
    let mut next = session
        .jobs
        .iter()
        .filter(|job| !job.completed)
        .map(|job| job.request.request_sequence)
        .min()
        .unwrap_or_else(|| {
            session
                .jobs
                .iter()
                .map(|job| job.request.request_sequence)
                .max()
                .unwrap_or(0)
                + 1
        });
    while next <= opts.jobs {
        let job_started = Instant::now();
        ensure!(!session.frozen, "channel is frozen");
        let upper = anchor.upper_now()?;
        ensure!(
            upper < offer.payload.work_deadline_ms,
            "channel work deadline reached"
        );
        if let Some(existing) = session
            .jobs
            .iter()
            .find(|job| job.request.request_sequence == next && !job.completed)
            .cloned()
        {
            recover_pending_buyer_job(root, session, connection, &offer, existing, expected, true)
                .await?;
            let completed = session
                .jobs
                .iter()
                .find(|job| job.request.request_sequence == next)
                .context("completed job missing")?;
            eprintln!(
                "{}",
                json!({"event":"channel_job_complete","session":session.session,"sequence":completed.request.request_sequence,"cumulative_amount":completed.credit.payload.cumulative_amount,"elapsed_us":job_started.elapsed().as_micros()})
            );
            next += 1;
            continue;
        }
        let request_id = format!("job-{next:04}");
        let request = cp::RequestDescriptor {
            purpose: b"m2m/channel/request/v1".to_vec(),
            channel,
            terms_hash: offer.payload.terms_hash.clone(),
            request_id: request_id.as_bytes().to_vec(),
            request_sequence: next,
        };
        request.validate()?;
        let amount = terms
            .unit_price
            .checked_mul(next)
            .context("channel amount overflow")?;
        ensure!(amount <= offer.payload.deposit, "channel budget exceeded");
        let credit = credit_for(
            &offer.payload,
            channel,
            cp::request_hash(&request)?,
            next,
            amount,
            session
                .transcript_hash
                .clone()
                .context("missing transcript root")?,
        )?;
        credit.validate()?;
        let signed_credit = cp::Signed {
            payload: credit.clone(),
            signature: protocol::sign(&credit, &identity.key)?,
        };
        let record = JobRecord {
            request: request.clone(),
            credit: signed_credit.clone(),
            ack: None,
            result: None,
            result_file: None,
            transcript_after: None,
            completed: false,
        };
        session.jobs.push(record);
        persist_session(root, session)?;
        if stop_requested(&opts.stop_after, "credit-saved") {
            return Ok(Some("credit-saved"));
        }
        let response = exchange(
            connection,
            &envelope(
                session.buyer,
                session.provider,
                channel,
                request_id.as_bytes(),
                cp::Message::Authorize {
                    request: request.clone(),
                    credit: signed_credit.clone(),
                },
            ),
        )
        .await?;
        let ack = match response.message {
            cp::Message::Acknowledge { ack } => ack,
            _ => bail!("provider returned unexpected authorize response"),
        };
        validate_ack(
            &offer.payload,
            channel,
            &signed_credit,
            &ack,
            &offer.payload.provider_key,
        )?;
        session.jobs.last_mut().context("missing saved job")?.ack = Some(ack.clone());
        persist_session(root, session)?;
        if stop_requested(&opts.stop_after, "acknowledged") {
            return Ok(Some("acknowledged"));
        }
        let save_only = stop_requested(&opts.stop_after, "result-saved");
        recover_pending_buyer_job(
            root,
            session,
            connection,
            &offer,
            session.jobs.last().cloned().context("missing job")?,
            expected,
            !save_only,
        )
        .await?;
        if save_only {
            return Ok(Some("result-saved"));
        }
        let completed = session
            .jobs
            .iter()
            .find(|job| job.request.request_sequence == next)
            .context("completed job missing")?;
        eprintln!(
            "{}",
            json!({"event":"channel_job_complete","session":session.session,"sequence":completed.request.request_sequence,"cumulative_amount":completed.credit.payload.cumulative_amount,"elapsed_us":job_started.elapsed().as_micros()})
        );
        next += 1;
    }
    eprintln!(
        "{}",
        json!({"event":"channel_jobs_end","session":session.session,"channel":channel,"jobs":opts.jobs,"elapsed_ms":start.elapsed().as_millis(),"timestamp_ms":now_ms()?,"paths":format!("{:?}", connection.paths())})
    );
    rpc_guard.finish()?;
    Ok(None)
}

fn validate_ack(
    offer: &cp::Offer,
    channel: Address,
    credit: &cp::Signed<cp::Credit>,
    ack: &cp::Signed<cp::Ack>,
    provider_key: &[u8],
) -> Result<()> {
    ack.payload.validate()?;
    verify_statement(&ack.payload, &ack.signature, provider_key)?;
    ensure!(ack.payload.channel == channel);
    ensure!(
        ack.payload.method == offer.method && ack.payload.version == offer.version,
        "ack method/version differs from offer"
    );
    ensure!(
        ack.payload.network == offer.network
            && ack.payload.package_id == offer.package_id
            && ack.payload.deployment == offer.deployment,
        "ack domain differs from offer"
    );
    ensure!(
        ack.payload.buyer == offer.buyer && ack.payload.provider == offer.provider,
        "ack parties differ from offer"
    );
    ensure!(ack.payload.offer_hash == cp::offer_hash(offer)?);
    ensure!(ack.payload.sequence == credit.payload.sequence);
    ensure!(ack.payload.cumulative_amount == credit.payload.cumulative_amount);
    ensure!(ack.payload.credit_hash == cp::credit_hash(&credit.payload)?);
    Ok(())
}

async fn recover_pending_buyer_job(
    root: &Path,
    session: &mut SessionJournal,
    connection: &Connection,
    offer: &cp::Signed<cp::Offer>,
    mut record: JobRecord,
    expected: &[u8],
    finalize: bool,
) -> Result<()> {
    let channel = session.channel.context("missing channel")?;
    let request_hash = cp::request_hash(&record.request)?;
    if record.ack.is_none() {
        let response = exchange(
            connection,
            &envelope(
                session.buyer,
                session.provider,
                channel,
                &record.request.request_id,
                cp::Message::Authorize {
                    request: record.request.clone(),
                    credit: record.credit.clone(),
                },
            ),
        )
        .await?;
        let ack = match response.message {
            cp::Message::Acknowledge { ack } => ack,
            _ => bail!("missing provider acknowledgement"),
        };
        validate_ack(
            &offer.payload,
            channel,
            &record.credit,
            &ack,
            &offer.payload.provider_key,
        )?;
        record.ack = Some(ack);
        *find_job_mut(&mut session.jobs, &request_hash).context("saved credit disappeared")? =
            record.clone();
        persist_session(root, session)?;
    }
    if record.result.is_none() {
        let response = exchange(
            connection,
            &envelope(
                session.buyer,
                session.provider,
                channel,
                &record.request.request_id,
                cp::Message::Get {
                    request_hash: request_hash.clone(),
                },
            ),
        )
        .await?;
        let (result, bytes) = match response.message {
            cp::Message::Result { result, bytes } => (result, bytes),
            _ => bail!("missing provider result"),
        };
        validate_result(
            &offer.payload,
            &session
                .terms
                .as_ref()
                .context("missing fixture terms")?
                .result_hash,
            &record.request,
            &record.credit.payload,
            &result,
            &bytes,
            &offer.payload.provider_key,
        )?;
        let path = result_path(root, &session.session, record.request.request_sequence);
        store::write(&path, &bytes)?;
        record.result_file = Some(path.to_string_lossy().into_owned());
        record.result = Some(result);
    }
    let ack = record.ack.clone().context("missing acknowledgement")?;
    let result = record.result.clone().context("missing result")?;
    let bytes = store::read::<Vec<u8>>(Path::new(
        record
            .result_file
            .as_deref()
            .context("missing result file")?,
    ))?;
    ensure!(
        bytes == expected,
        "provider returned unexpected fixture bytes"
    );
    let previous = session
        .transcript_hash
        .clone()
        .context("missing transcript root")?;
    let next_root = cp::transcript_next(
        &previous,
        &record.request,
        &record.credit.payload,
        &ack.payload,
        &result.payload,
    )?;
    if let Some(existing) = session.jobs.iter().find(|job| {
        job.request.request_sequence == record.request.request_sequence && job.completed
    }) {
        ensure!(
            existing.transcript_after.as_deref() == Some(next_root.as_slice()),
            "conflicting completed transcript"
        );
        return Ok(());
    }
    if !finalize {
        record.transcript_after = None;
        record.completed = false;
        if let Some(existing) = find_job_mut(&mut session.jobs, &request_hash) {
            *existing = record;
        }
        persist_session(root, session)?;
        return Ok(());
    }
    record.transcript_after = Some(next_root.clone());
    record.completed = true;
    if let Some(existing) = find_job_mut(&mut session.jobs, &request_hash) {
        *existing = record;
    } else {
        session.jobs.push(record);
    }
    session.transcript_hash = Some(next_root);
    persist_session(root, session)?;
    Ok(())
}

async fn close_buyer(
    root: &Path,
    bridge: &ChannelBridge,
    identity: &ChannelIdentity,
    session: &mut SessionJournal,
    signer: &Path,
    connection: Option<&Connection>,
    stop: &Option<String>,
) -> Result<Value> {
    if let Some(cert) = session.certificate.clone() {
        return submit_close(root, bridge, session, signer, &cert).await;
    }
    let offer = session.offer.clone().context("missing offer")?;
    let channel = session.channel.context("missing channel")?;
    let transcript = session
        .transcript_hash
        .as_deref()
        .context("missing transcript root")?;
    let signed = if let Some(saved) = session.close.clone() {
        validate_close_binding(
            &offer.payload,
            channel,
            &session.jobs,
            transcript,
            &saved.payload,
        )?;
        verify_statement(&saved.payload, &saved.signature, &offer.payload.buyer_key)?;
        saved
    } else {
        let (_, amount) = journal_jobs(&session.jobs)?;
        let sequence = session
            .jobs
            .iter()
            .map(|job| job.credit.payload.sequence)
            .max()
            .unwrap_or(0);
        let close = close_for(
            &offer.payload,
            channel,
            sequence,
            amount,
            session
                .transcript_hash
                .clone()
                .context("missing transcript root")?,
        )?;
        validate_close_binding(&offer.payload, channel, &session.jobs, transcript, &close)?;
        let signature = protocol::sign(&close, &identity.key)?;
        let signed = cp::Signed {
            payload: close,
            signature,
        };
        session.frozen = true;
        session.close = Some(signed.clone());
        persist_session(root, session)?;
        signed
    };
    validate_close_binding(
        &offer.payload,
        channel,
        &session.jobs,
        transcript,
        &signed.payload,
    )?;
    session.frozen = true;
    session.close = Some(signed.clone());
    persist_session(root, session)?;
    if stop_requested(stop, "close-signed") {
        return Ok(json!({"stopped":"close-signed","session":session.session,"channel":channel}));
    }
    let conn = connection.context("provider connection required to complete close handshake")?;
    let response = exchange(
        conn,
        &envelope(
            session.buyer,
            session.provider,
            channel,
            b"",
            cp::Message::Close { close: signed },
        ),
    )
    .await?;
    let cert = match response.message {
        cp::Message::CloseAcknowledge { certificate } => *certificate,
        _ => bail!("provider returned unexpected close response"),
    };
    validate_close_certificate_binding(&offer.payload, channel, &session.jobs, transcript, &cert)?;
    ensure!(
        cert.close
            == session
                .close
                .as_ref()
                .context("missing saved close")?
                .payload,
        "provider close differs from saved candidate"
    );
    session.certificate = Some(cert.clone());
    persist_session(root, session)?;
    if stop_requested(stop, "close-certificate") {
        return Ok(
            json!({"stopped":"close-certificate","session":session.session,"channel":channel}),
        );
    }
    submit_close(root, bridge, session, signer, &cert).await
}

async fn submit_close(
    root: &Path,
    bridge: &ChannelBridge,
    session: &mut SessionJournal,
    signer: &Path,
    cert: &cp::CloseCertificate,
) -> Result<Value> {
    let offer = session.offer.as_ref().context("session has no offer")?;
    let channel = session.channel.context("session has no channel")?;
    let transcript = session
        .transcript_hash
        .as_deref()
        .context("session has no transcript")?;
    validate_close_certificate_binding(&offer.payload, channel, &session.jobs, transcript, cert)?;
    let result = bridge.call(json!({
        "action":"channel_close",
        "certificate":cert,
        "signer_file":canonical_path(signer)?,
        "journal":root.join("channels").join("tx").join(format!("{}.close.tx.json",session.session)),
    }), "close").await?;
    let (channel, digest, state, recovered) = parse_mutation(&result)?;
    ensure!(
        Some(channel) == session.channel,
        "close returned wrong channel"
    );
    session.chain_state = Some(state);
    session.chain_digest = digest;
    session.certificate = Some(cert.clone());
    persist_session(root, session)?;
    eprintln!(
        "{}",
        json!({"event":"channel_terminal","session":session.session,"channel":channel,"status":"closed","recovered":recovered})
    );
    Ok(
        json!({"session":session.session,"channel":channel,"status":"closed","digest":session.chain_digest,"recovered":recovered}),
    )
}

async fn buyer_admit_and_resume(
    root: &Path,
    bridge: &ChannelBridge,
    session: &mut SessionJournal,
    connection: &Connection,
) -> Result<ClockAnchor> {
    let channel = session.channel.context("missing channel")?;
    let started = Instant::now();
    let snapshot = bridge
        .call(
            json!({"action":"channel_snapshot","id":channel}),
            "admission",
        )
        .await?;
    let timestamp = u64_value(&snapshot, "timestamp_ms")?;
    let state = snapshot
        .get("channel")
        .cloned()
        .context("missing channel snapshot")?;
    let onchain_offer: cp::Offer = serde_json::from_value(
        state
            .get("offer")
            .cloned()
            .context("channel snapshot omits offer")?,
    )?;
    ensure!(
        Some(onchain_offer) == session.offer.as_ref().map(|offer| offer.payload.clone()),
        "onchain offer differs from saved offer"
    );
    let anchor = ClockAnchor::new(timestamp, started, now_ms()?)?;
    if session.transcript_hash.is_none() {
        ensure!(session.jobs.is_empty(), "missing transcript for saved jobs");
        session.transcript_hash = Some(cp::transcript_start(
            channel,
            &session.offer.as_ref().context("missing offer")?.payload,
        )?);
    }
    session.chain_state = Some(state);
    session.anchor_upper_ms = Some(anchor.upper_ms);
    persist_session(root, session)?;
    let response = exchange(
        connection,
        &envelope(
            session.buyer,
            session.provider,
            channel,
            b"",
            cp::Message::Resume {},
        ),
    )
    .await?;
    match response.message {
        cp::Message::Ready { phase, .. } => {
            let status = session.chain_state.as_ref().map(state_status).unwrap_or(0);
            ensure!(
                match phase.as_str() {
                    "active" | "frozen" => status == 0,
                    "closed" => status == 1,
                    "refunded" => status == 2,
                    _ => false,
                },
                "provider phase differs from the fresh channel snapshot; retry reconciliation"
            );
            Ok(anchor)
        }
        _ => bail!("provider did not admit channel session"),
    }
}

pub async fn buy(store: &Store, identity: &ChannelIdentity, opts: BuyOptions) -> Result<Value> {
    safe_session(&opts.session)?;
    ensure!(
        opts.jobs > 0 && opts.jobs <= 1_000,
        "invalid requested job count"
    );
    ensure!(
        opts.deposit > 0 && opts.max_unit_price > 0,
        "invalid channel budget"
    );
    let root = canonical_path(&store.root)?;
    let expected = fs::read(&opts.expected_file)?;
    ensure!(expected.len() <= MAX_FILE, "expected file exceeds 64 KiB");
    let expected_hash = protocol::hash(&expected);
    let bridge = ChannelBridge::new(identity.chain.clone());
    let reservation = reserve_session(&root, identity, &opts, &expected_hash)?;
    let mut session = if session_path(&root, &opts.session).exists() {
        read_session(&root, &opts.session)?
    } else {
        let created = SessionJournal {
            version: cp::VERSION,
            role: "buyer".to_owned(),
            session: opts.session.clone(),
            buyer: identity.agent,
            provider: opts.provider,
            opening_nonce: reservation.opening_nonce.clone(),
            requested_jobs: opts.jobs,
            requested_deposit: opts.deposit,
            max_unit_price: opts.max_unit_price,
            expected_result_hash: expected_hash.clone(),
            terms: None,
            offer: None,
            channel: None,
            jobs: Vec::new(),
            transcript_hash: None,
            frozen: false,
            close: None,
            certificate: None,
            chain_state: None,
            chain_digest: None,
            anchor_upper_ms: None,
            recovery_started: false,
            ticket_path: canonical_path(&opts.ticket)?.to_string_lossy().into_owned(),
            relay: opts.relay,
            relay_only: opts.relay_only,
        };
        persist_session(&root, &created)?;
        created
    };
    ensure!(session.role == "buyer", "session belongs to provider");
    ensure!(
        session.provider == opts.provider
            && session.requested_jobs == opts.jobs
            && session.requested_deposit == opts.deposit
            && session.max_unit_price == opts.max_unit_price
            && session.expected_result_hash == expected_hash,
        "session parameters conflict with saved journal"
    );
    let current_ticket = canonical_path(&opts.ticket)?;
    if session.ticket_path.is_empty() {
        session.ticket_path = current_ticket.to_string_lossy().into_owned();
        session.relay = opts.relay;
        session.relay_only = opts.relay_only;
        persist_session(&root, &session)?;
    } else {
        ensure!(
            session.ticket_path == current_ticket.to_string_lossy(),
            "session routing ticket differs from saved journal"
        );
        ensure!(
            session.relay == opts.relay && session.relay_only == opts.relay_only,
            "session routing mode differs from saved journal"
        );
    }
    if session.frozen {
        let channel = session.channel.context("frozen session has no channel")?;
        let snapshot = bridge
            .call(
                json!({"action":"channel_snapshot","id":channel}),
                "reconcile",
            )
            .await?;
        let state = snapshot
            .get("channel")
            .cloned()
            .context("missing channel state")?;
        let onchain_offer: cp::Offer = serde_json::from_value(
            state
                .get("offer")
                .cloned()
                .context("channel snapshot omits offer")?,
        )?;
        ensure!(
            Some(onchain_offer) == session.offer.as_ref().map(|offer| offer.payload.clone()),
            "onchain offer differs from saved offer"
        );
        session.chain_state = Some(state.clone());
        persist_session(&root, &session)?;
        if state_status(&state) != 0 {
            return summary(&session);
        }
        if let Some(cert) = session.certificate.clone() {
            return submit_close(&root, &bridge, &mut session, &opts.signer, &cert).await;
        }
        ensure!(
            session.close.is_some(),
            "session is frozen without a saved close candidate"
        );
        let (endpoint, connection, ticket) = connect(
            Path::new(&session.ticket_path),
            identity.key.clone(),
            session.relay,
            session.relay_only,
        )
        .await?;
        ensure!(
            ticket.agent == opts.provider,
            "ticket advertises another provider"
        );
        ensure!(
            connection.remote_id().as_bytes()
                == session
                    .offer
                    .as_ref()
                    .context("frozen session has no offer")?
                    .payload
                    .provider_key
                    .as_slice(),
            "connected peer is not the saved provider endpoint"
        );
        let _anchor = buyer_admit_and_resume(&root, &bridge, &mut session, &connection).await?;
        let value = close_buyer(
            &root,
            &bridge,
            identity,
            &mut session,
            &opts.signer,
            Some(&connection),
            &opts.stop_after,
        )
        .await?;
        connection.close(0u32.into(), b"channel close recovered");
        endpoint.close().await;
        return Ok(value);
    }
    let (endpoint, connection, ticket) = connect(
        Path::new(&session.ticket_path),
        identity.key.clone(),
        session.relay,
        session.relay_only,
    )
    .await?;
    ensure!(
        ticket.agent == opts.provider,
        "ticket advertises another provider"
    );
    if let Some(offer) = &session.offer {
        ensure!(
            connection.remote_id().as_bytes() == offer.payload.provider_key.as_slice(),
            "connected peer is not the saved provider endpoint"
        );
    }
    if session.offer.is_none() {
        let response = exchange(
            &connection,
            &envelope(
                session.buyer,
                session.provider,
                ZERO,
                b"",
                cp::Message::OfferRequest {
                    opening_nonce: session.opening_nonce.clone(),
                    result_hash: expected_hash.clone(),
                    jobs: opts.jobs,
                    max_unit_price: opts.max_unit_price,
                    deposit: opts.deposit,
                },
            ),
        )
        .await?;
        let (signed, terms) = match response.message {
            cp::Message::Offer { offer, terms } => (*offer, terms),
            _ => bail!("provider returned unexpected offer response"),
        };
        validate_offer_context(&signed.payload, &terms)?;
        ensure!(signed.payload.buyer == identity.agent && signed.payload.provider == opts.provider);
        ensure!(signed.payload.network == identity.chain.chain_id.as_bytes());
        ensure!(
            signed.payload.package_id == identity.chain.package_id
                && signed.payload.deployment == identity.chain.deployment
        );
        ensure!(
            signed.payload.buyer_key == identity.key.public().as_bytes(),
            "offer is for another buyer endpoint"
        );
        verify_statement(
            &signed.payload,
            &signed.signature,
            &signed.payload.provider_key,
        )?;
        ensure!(
            terms.result_hash == expected_hash
                && terms.unit_price <= opts.max_unit_price
                && terms.max_jobs >= opts.jobs
        );
        session.terms = Some(terms);
        session.offer = Some(signed);
        // The offer has no channel field. The transcript root is derived after open.
        session.transcript_hash = None;
        persist_session(&root, &session)?;
    }
    if buyer_open(
        &root,
        &bridge,
        identity,
        &mut session,
        &opts.signer,
        &opts.stop_after,
    )
    .await?
    {
        return Ok(json!({"stopped":"opened","session":session.session}));
    }
    let channel = session.channel.context("missing opened channel")?;
    if session.transcript_hash.is_none() {
        session.transcript_hash = Some(cp::transcript_start(
            channel,
            &session.offer.as_ref().context("missing offer")?.payload,
        )?);
        persist_session(&root, &session)?;
    }
    let anchor = buyer_admit_and_resume(&root, &bridge, &mut session, &connection).await?;
    if session
        .chain_state
        .as_ref()
        .is_some_and(|state| state_status(state) != 0)
    {
        // Terminal sessions may replay only authorizations already persisted.
        // The provider can return cached bytes, but cannot perform new work.
        for job in session
            .jobs
            .iter()
            .filter(|job| !job.completed)
            .cloned()
            .collect::<Vec<_>>()
        {
            let offer = session.offer.clone().context("missing offer")?;
            recover_pending_buyer_job(
                &root,
                &mut session,
                &connection,
                &offer,
                job,
                &expected,
                true,
            )
            .await?;
        }
        connection.close(0u32.into(), b"terminal replay complete");
        endpoint.close().await;
        return summary(&session);
    }
    ensure!(
        anchor.upper_now()?
            < session
                .offer
                .as_ref()
                .context("missing offer")?
                .payload
                .work_deadline_ms,
        "channel work deadline reached during admission"
    );
    eprintln!(
        "{}",
        json!({"event":"channel_admitted","session":session.session,"channel":channel})
    );
    let stopped = buyer_jobs(
        &root,
        identity,
        &mut session,
        &connection,
        &expected,
        &opts,
        &anchor,
    )
    .await?;
    if let Some(boundary) = stopped {
        connection.close(0u32.into(), b"durable boundary");
        endpoint.close().await;
        let mut value = summary(&session)?;
        value["stopped"] = json!(boundary);
        return Ok(value);
    }
    if opts.close {
        let value = close_buyer(
            &root,
            &bridge,
            identity,
            &mut session,
            &opts.signer,
            Some(&connection),
            &opts.stop_after,
        )
        .await?;
        connection.close(0u32.into(), b"channel complete");
        endpoint.close().await;
        return Ok(value);
    }
    connection.close(0u32.into(), b"channel jobs complete");
    endpoint.close().await;
    summary(&session)
}

fn parse_offer_files(root: &Path) -> Result<HashMap<Vec<u8>, OfferJournal>> {
    let dir = root.join("channels").join("offers");
    let mut result = HashMap::new();
    if !dir.exists() {
        return Ok(result);
    }
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let value = store::read::<OfferJournal>(&path).context("corrupt channel offer journal")?;
        validate_offer_journal(&value).context("invalid channel offer journal")?;
        let mut key = value.offer.payload.buyer.as_bytes().to_vec();
        key.extend_from_slice(&value.offer.payload.opening_nonce);
        result.insert(key, value);
    }
    Ok(result)
}

fn all_provider_journals(root: &Path) -> Result<Vec<ProviderJournal>> {
    let dir = root.join("channels").join("live");
    let mut result = Vec::new();
    if !dir.exists() {
        return Ok(result);
    }
    for entry in fs::read_dir(dir)? {
        let path = entry?.path();
        if path.extension().and_then(|x| x.to_str()) != Some("json") {
            continue;
        }
        let channel: Address = serde_json::from_value(Value::String(
            path.file_stem()
                .and_then(|value| value.to_str())
                .context("provider journal has no channel name")?
                .to_owned(),
        ))
        .context("provider journal has invalid channel name")?;
        result.push(read_provider(root, channel).context("corrupt provider channel journal")?);
    }
    Ok(result)
}

fn recovery_due(work_deadline_ms: u64, now_ms: u64) -> bool {
    now_ms >= work_deadline_ms
}

struct ProviderCore {
    root: PathBuf,
    bridge: ChannelBridge,
    identity: ChannelIdentity,
    service: Arc<dyn ServiceHandler>,
    gas_signer: PathBuf,
    unit_price: u64,
    max_jobs: u64,
    work_ms: u64,
    grace_ms: u64,
    fault: Option<String>,
    state_lock: Mutex<()>,
    recovery_anchors: Mutex<HashMap<Vec<u8>, ClockAnchor>>,
}

async fn provider_parties(core: &ProviderCore, buyer: Address) -> Result<Value> {
    core.bridge
        .call(
            json!({"action":"channel_parties","buyer":buyer,"provider":core.identity.agent}),
            "admission",
        )
        .await
}

fn load_matching_offer(
    root: &Path,
    buyer: Address,
    provider: Address,
    offer_hash: &[u8],
) -> Result<OfferJournal> {
    for value in parse_offer_files(root)?.into_values() {
        if value.offer.payload.buyer == buyer
            && value.offer.payload.provider == provider
            && cp::offer_hash(&value.offer.payload)? == offer_hash
        {
            return Ok(value);
        }
    }
    bail!("saved offer not found")
}

fn provider_ready(journal: &ProviderJournal, state: &Value) -> cp::Message {
    let status = state_status(state);
    let phase = if status == 1 {
        "closed"
    } else if status == 2 {
        "refunded"
    } else if journal.frozen || journal.clock_untrusted {
        "frozen"
    } else {
        "active"
    };
    cp::Message::Ready {
        phase: phase.to_owned(),
        highest_credit: highest_credit(&journal.jobs),
        completed_jobs: journal.jobs.iter().filter(|j| j.completed).count() as u64,
        transcript_hash: journal.transcript_hash.clone(),
        certificate: journal.certificate.clone().map(Box::new),
        redeemed_amount: state_u64(state, "redeemed_amount"),
    }
}

async fn provider_connection(core: Arc<ProviderCore>, connection: Connection) -> Result<()> {
    let peer = connection.remote_id().as_bytes().to_vec();
    let mut admitted: HashMap<Vec<u8>, ProviderAdmission> = HashMap::new();
    loop {
        let (mut send, mut recv) =
            match timeout(Duration::from_secs(180), connection.accept_bi()).await {
                Ok(Ok(streams)) => streams,
                Ok(Err(error)) => return Err(error.into()),
                Err(_) => return Ok(()),
            };
        let raw = timeout(Duration::from_secs(10), recv.read_to_end(MAX_FRAME)).await??;
        let request: cp::Envelope =
            serde_json::from_slice(&raw).context("invalid channel request")?;
        eprintln!(
            "{}",
            json!({
                "event":"channel_request",
                "channel":request.agreement_id,
                "buyer":request.buyer,
                "request_id":request.request_id,
                "message":message_name(&request.message),
                "timestamp_ms":now_ms()?
            })
        );
        let response = {
            let _guard = core.state_lock.lock().await;
            provider_message(&core, &request, &peer, &mut admitted).await
        };
        let (response, drop_reply) = match response {
            Ok((message, drop_reply)) => (
                envelope(
                    request.buyer,
                    request.provider,
                    request.agreement_id,
                    request.request_id.as_bytes(),
                    message,
                ),
                drop_reply,
            ),
            Err(error) => {
                let text = error.to_string();
                let code = if text.contains("peer")
                    || text.contains("endpoint")
                    || text.contains("authorized")
                {
                    "unauthorized"
                } else if text.contains("deadline") || text.contains("expired") {
                    "expired"
                } else if text.contains("frozen") {
                    "frozen"
                } else if text.contains("terminal") {
                    "terminal"
                } else if text.contains("budget") || text.contains("deposit") {
                    "budget_exceeded"
                } else if text.contains("conflict") || text.contains("repeated") {
                    "conflict"
                } else {
                    "invalid_message"
                };
                (
                    envelope(
                        request.buyer,
                        request.provider,
                        request.agreement_id,
                        request.request_id.as_bytes(),
                        error_message(code, text),
                    ),
                    false,
                )
            }
        };
        if drop_reply {
            connection.close(1u32.into(), b"injected channel fault");
            return Ok(());
        }
        send.write_all(&serde_json::to_vec(&response)?).await?;
        send.finish()?;
    }
}

async fn provider_message(
    core: &ProviderCore,
    request: &cp::Envelope,
    peer: &[u8],
    admitted: &mut HashMap<Vec<u8>, ProviderAdmission>,
) -> Result<(cp::Message, bool)> {
    request.validate()?;
    validate_envelope_context(request)?;
    ensure!(
        request.provider == core.identity.agent,
        "wrong provider envelope"
    );
    match &request.message {
        cp::Message::OfferRequest {
            opening_nonce,
            result_hash,
            jobs,
            max_unit_price,
            deposit,
        } => {
            ensure!(request.agreement_id == ZERO && request.request_id.is_empty());
            ensure!(opening_nonce.len() == OPENING_NONCE_LEN);
            ensure!(
                result_hash == &core.service.result_hash(),
                "fixture hash is unavailable"
            );
            ensure!(
                *jobs > 0 && *jobs <= core.max_jobs,
                "provider job limit exceeded"
            );
            ensure!(
                *max_unit_price >= core.unit_price,
                "provider price exceeds buyer budget"
            );
            ensure!(
                *deposit
                    >= core
                        .unit_price
                        .checked_mul(*jobs)
                        .context("deposit overflow")?,
                "deposit below requested budget"
            );
            let parties = provider_parties(core, request.buyer).await?;
            ensure!(agent_address(&parties, "buyer", "id")? == request.buyer);
            ensure!(agent_address(&parties, "provider", "id")? == core.identity.agent);
            ensure!(
                agent_bytes(&parties, "buyer", "endpoint_key")? == peer,
                "peer is not buyer endpoint"
            );
            ensure!(
                agent_bytes(&parties, "provider", "endpoint_key")?
                    == core.identity.key.public().as_bytes(),
                "provider endpoint has changed"
            );
            for saved in parse_offer_files(&core.root)?.into_values() {
                if saved.offer.payload.buyer == request.buyer
                    && saved.offer.payload.provider == core.identity.agent
                    && saved.offer.payload.opening_nonce == *opening_nonce
                {
                    ensure!(
                        saved.terms.result_hash == *result_hash,
                        "opening nonce conflicts with fixture"
                    );
                    ensure!(
                        saved.terms.max_jobs == *jobs,
                        "opening nonce conflicts with job count"
                    );
                    ensure!(
                        saved.offer.payload.deposit == *deposit,
                        "opening nonce conflicts with deposit"
                    );
                    ensure!(
                        saved.terms.unit_price <= *max_unit_price,
                        "opening nonce conflicts with price budget"
                    );
                    return Ok((
                        cp::Message::Offer {
                            offer: Box::new(saved.offer),
                            terms: saved.terms,
                        },
                        false,
                    ));
                }
            }
            let now = timestamp(&parties)?;
            let work = now
                .checked_add(core.work_ms)
                .context("work deadline overflow")?;
            let claim = work
                .checked_add(core.grace_ms)
                .context("claim deadline overflow")?;
            let offer_expires = now
                .checked_add(60_000.min(core.work_ms / 2))
                .context("offer deadline overflow")?;
            ensure!(
                core.grace_ms >= MIN_GRACE_MS
                    && core.work_ms >= 10_000
                    && core.work_ms.saturating_add(core.grace_ms) <= MAX_LIFETIME_MS
            );
            let terms = cp::FixtureTerms {
                purpose: b"m2m/channel/fixture-terms/v1".to_vec(),
                result_hash: result_hash.clone(),
                unit_price: core.unit_price,
                max_jobs: *jobs,
                max_unfulfilled_jobs: 1,
            };
            let offer = cp::Offer {
                purpose: b"m2m/channel/offer/v1".to_vec(),
                method: cp::METHOD.as_bytes().to_vec(),
                version: cp::VERSION,
                network: core.identity.chain.chain_id.as_bytes().to_vec(),
                package_id: core.identity.chain.package_id,
                deployment: core.identity.chain.deployment,
                buyer: request.buyer,
                provider: core.identity.agent,
                buyer_key: peer.to_vec(),
                provider_key: core.identity.key.public().as_bytes().to_vec(),
                refund: agent_address(&parties, "buyer", "controller")?,
                payee: agent_address(&parties, "provider", "controller")?,
                opening_nonce: opening_nonce.clone(),
                terms_hash: cp::terms_hash(&terms)?,
                deposit: *deposit,
                offer_expires_ms: offer_expires,
                work_deadline_ms: work,
                claim_deadline_ms: claim,
            };
            offer.validate()?;
            terms.validate()?;
            let signed = cp::Signed {
                payload: offer.clone(),
                signature: protocol::sign(&offer, &core.identity.key)?,
            };
            let path = offer_path(&core.root, &offer)?;
            if path.exists() {
                let old: OfferJournal = store::read(&path)?;
                validate_offer_journal(&old)?;
                ensure!(
                    old.offer.payload == offer,
                    "opening nonce conflicts with saved offer"
                );
                return Ok((
                    cp::Message::Offer {
                        offer: Box::new(old.offer),
                        terms: old.terms,
                    },
                    false,
                ));
            }
            store::write(
                &path,
                &OfferJournal {
                    version: cp::VERSION,
                    offer: signed.clone(),
                    terms: terms.clone(),
                    channel: None,
                },
            )?;
            Ok((
                cp::Message::Offer {
                    offer: Box::new(signed),
                    terms,
                },
                false,
            ))
        }
        cp::Message::Resume {} => {
            let channel = request.agreement_id;
            ensure!(channel != ZERO && request.request_id.is_empty());
            let snapshot_started = Instant::now();
            let snapshot = core
                .bridge
                .call(
                    json!({"action":"channel_snapshot","id":channel}),
                    "admission",
                )
                .await?;
            let state = snapshot
                .get("channel")
                .cloned()
                .context("missing channel state")?;
            let offer_value = state
                .get("offer")
                .cloned()
                .context("channel snapshot omits offer")?;
            let offer: cp::Offer = serde_json::from_value(offer_value)?;
            ensure!(offer.buyer == request.buyer && offer.provider == core.identity.agent);
            ensure!(offer.provider_key == core.identity.key.public().as_bytes());
            ensure!(offer.buyer_key == peer, "resume peer is not opening buyer");
            let mut saved = load_matching_offer(
                &core.root,
                request.buyer,
                core.identity.agent,
                &cp::offer_hash(&offer)?,
            )?;
            ensure!(
                saved.offer.payload == offer,
                "onchain offer differs from saved offer"
            );
            let path = provider_path(&core.root, channel);
            let live_exists = path.exists();
            let first_admission = saved.channel.is_none();
            if let Some(bound) = saved.channel {
                ensure!(bound == channel, "saved offer is bound to another channel");
            } else {
                ensure!(
                    !live_exists,
                    "provider offer is unbound but a channel journal already exists"
                );
                saved.channel = Some(channel);
                store::write(&offer_path(&core.root, &saved.offer.payload)?, &saved)?;
            }
            ensure!(
                first_admission || live_exists,
                "bound provider channel journal is missing"
            );
            let mut journal = if live_exists {
                read_provider(&core.root, channel)?
            } else {
                let journal = ProviderJournal {
                    version: cp::VERSION,
                    role: "provider".to_owned(),
                    session: hex::encode(&offer.opening_nonce),
                    buyer: offer.buyer,
                    provider: offer.provider,
                    offer: saved.offer.clone(),
                    terms: saved.terms.clone(),
                    channel,
                    jobs: Vec::new(),
                    transcript_hash: cp::transcript_start(channel, &offer)?,
                    frozen: false,
                    close: None,
                    certificate: None,
                    chain_state: Some(state.clone()),
                    chain_digest: None,
                    anchor_upper_ms: 0,
                    recovery_started: false,
                    clock_untrusted: false,
                };
                ensure!(saved.channel == Some(channel));
                journal
            };
            ensure!(journal.buyer == request.buyer && journal.offer.payload == offer);
            let fresh_anchor = ClockAnchor::new(
                u64_value(&snapshot, "timestamp_ms")?,
                snapshot_started,
                now_ms()?,
            )?;
            let key = provider_admission_key(channel);
            let mut anchor = fresh_anchor;
            if let Some(previous) = admitted.get(&key) {
                ensure!(previous.peer == peer, "channel is admitted to another peer");
                anchor.upper_ms = anchor.upper_ms.max(previous.anchor.upper_ms);
            }
            if journal.clock_untrusted
                && !journal.recovery_started
                && journal.close.is_none()
                && journal.certificate.is_none()
            {
                journal.frozen = false;
            }
            journal.clock_untrusted = false;
            if state_status(&state) != 0 {
                journal.frozen = true;
            }
            journal.anchor_upper_ms = anchor.upper_ms;
            journal.chain_state = Some(state.clone());
            persist_provider(&core.root, &journal)?;
            core.recovery_anchors
                .lock()
                .await
                .insert(key.clone(), anchor.clone());
            admitted.insert(
                key,
                ProviderAdmission {
                    peer: peer.to_vec(),
                    anchor,
                },
            );
            Ok((provider_ready(&journal, &state), false))
        }
        cp::Message::Authorize {
            request: descriptor,
            credit,
        } => {
            let channel = request.agreement_id;
            ensure!(
                channel != ZERO
                    && request.request_id.as_bytes() == descriptor.request_id.as_slice()
            );
            let admission_key = provider_admission_key(channel);
            let admission = admitted
                .get(&admission_key)
                .cloned()
                .context("channel has not been admitted on this connection")?;
            ensure!(
                admission.peer == peer,
                "channel admission belongs to another peer"
            );
            let mut journal = read_provider(&core.root, channel)?;
            ensure!(
                journal.buyer == request.buyer
                    && credit.payload.provider == core.identity.agent
                    && credit.payload.buyer == request.buyer
            );
            ensure!(
                peer == journal.offer.payload.buyer_key.as_slice(),
                "authorize peer is not saved buyer endpoint"
            );
            verify_statement(
                &credit.payload,
                &credit.signature,
                &journal.offer.payload.buyer_key,
            )?;
            if let Some(existing) = journal
                .jobs
                .iter()
                .find(|j| j.request.request_sequence == descriptor.request_sequence)
            {
                ensure!(
                    existing.request == *descriptor && existing.credit == *credit,
                    "conflicting repeated credit"
                );
                return Ok((
                    cp::Message::Acknowledge {
                        ack: existing
                            .ack
                            .clone()
                            .context("saved credit missing acknowledgement")?,
                    },
                    false,
                ));
            }
            ensure!(
                journal
                    .jobs
                    .iter()
                    .all(|job| job.request.request_id != descriptor.request_id),
                "request ID was already used by another sequence"
            );
            let next = journal.jobs.len() as u64 + 1;
            check_job_context(
                &journal.offer.payload,
                channel,
                descriptor,
                &credit.payload,
                &journal.transcript_hash,
            )?;
            ensure!(
                credit.payload.sequence == next,
                "credit sequence is not next"
            );
            ensure!(
                next <= journal.terms.max_jobs,
                "channel job budget exceeded"
            );
            ensure!(
                credit.payload.cumulative_amount
                    == journal
                        .terms
                        .unit_price
                        .checked_mul(next)
                        .context("credit amount overflow")?
            );
            ensure!(
                journal
                    .jobs
                    .iter()
                    .all(|j| j.completed || j.credit.payload.sequence == credit.payload.sequence),
                "a prior credit remains unfulfilled"
            );
            ensure!(!journal.frozen, "channel is frozen");
            ensure!(
                !journal.clock_untrusted,
                "provider clock requires re-admission"
            );
            let anchor_now = match admission.anchor.upper_now() {
                Ok(value) => value,
                Err(error) => {
                    journal.clock_untrusted = true;
                    journal.frozen = true;
                    persist_provider(&core.root, &journal)?;
                    admitted.remove(&admission_key);
                    return Err(error)
                        .context("provider clock anchor invalid; re-admission required");
                }
            };
            ensure!(
                anchor_now < journal.offer.payload.work_deadline_ms,
                "channel work deadline reached"
            );
            let ack_payload = ack_for(
                &journal.offer.payload,
                channel,
                &credit.payload,
                cp::credit_hash(&credit.payload)?,
            );
            let ack = cp::Signed {
                payload: ack_payload.clone(),
                signature: protocol::sign(&ack_payload, &core.identity.key)?,
            };
            journal.jobs.push(JobRecord {
                request: descriptor.clone(),
                credit: credit.clone(),
                ack: Some(ack.clone()),
                result: None,
                result_file: None,
                transcript_after: None,
                completed: false,
            });
            persist_provider(&core.root, &journal)?;
            let drop_reply = core.fault.as_deref() == Some("after-credit");
            Ok((cp::Message::Acknowledge { ack }, drop_reply))
        }
        cp::Message::Get { request_hash } => {
            let channel = request.agreement_id;
            ensure!(channel != ZERO && !request.request_id.is_empty());
            let admission_key = provider_admission_key(channel);
            let admission = admitted
                .get(&admission_key)
                .cloned()
                .context("channel has not been admitted on this connection")?;
            ensure!(
                admission.peer == peer,
                "channel admission belongs to another peer"
            );
            let mut journal = read_provider(&core.root, channel)?;
            ensure!(request.buyer == journal.buyer, "wrong buyer envelope");
            ensure!(peer == journal.offer.payload.buyer_key.as_slice());
            let job = find_job(&journal.jobs, request_hash)
                .cloned()
                .context("request has no saved credit")?;
            ensure!(job.request.request_id.as_slice() == request.request_id.as_bytes());
            if journal.frozen && job.result.is_none() {
                bail!("channel is frozen before result");
            }
            if job.result.is_none() {
                ensure!(
                    !journal.clock_untrusted,
                    "provider clock requires re-admission"
                );
                let upper_now = match admission.anchor.upper_now() {
                    Ok(value) => value,
                    Err(error) => {
                        journal.clock_untrusted = true;
                        journal.frozen = true;
                        persist_provider(&core.root, &journal)?;
                        admitted.remove(&admission_key);
                        return Err(error)
                            .context("provider clock anchor invalid; re-admission required");
                    }
                };
                ensure!(
                    upper_now < journal.offer.payload.work_deadline_ms,
                    "channel work deadline reached"
                );
            }
            let mut job = job;
            if job.result.is_none() {
                let bytes = core.service.execute()?;
                ensure!(
                    bytes.len() <= MAX_FILE && protocol::hash(&bytes) == journal.terms.result_hash,
                    "fixture output differs from terms"
                );
                let result_payload = result_for(
                    &journal.offer.payload,
                    channel,
                    &job.request,
                    &job.credit.payload,
                    protocol::hash(&bytes),
                )?;
                let result = cp::Signed {
                    payload: result_payload.clone(),
                    signature: protocol::sign(&result_payload, &core.identity.key)?,
                };
                let root = core
                    .root
                    .join("channels")
                    .join("results")
                    .join(&journal.session)
                    .join(format!("{}.bin", job.request.request_sequence));
                store::write(&root, &bytes)?;
                job.result_file = Some(root.to_string_lossy().into_owned());
                job.result = Some(result);
                let next_root = cp::transcript_next(
                    &journal.transcript_hash,
                    &job.request,
                    &job.credit.payload,
                    &job.ack.as_ref().context("missing ack")?.payload,
                    &job.result.as_ref().context("missing result")?.payload,
                )?;
                job.transcript_after = Some(next_root.clone());
                job.completed = true;
                journal.transcript_hash = next_root;
                if let Some(existing) = find_job_mut(&mut journal.jobs, request_hash) {
                    *existing = job.clone();
                }
                persist_provider(&core.root, &journal)?;
            } else {
                let path = Path::new(
                    job.result_file
                        .as_deref()
                        .context("saved result missing file")?,
                );
                ensure!(
                    path.exists(),
                    "saved result file is missing; refusing reconstruction"
                );
            }
            let bytes = store::read::<Vec<u8>>(Path::new(
                job.result_file.as_deref().context("missing result file")?,
            ))?;
            ensure!(bytes.len() <= MAX_FILE, "saved result exceeds 64 KiB");
            ensure!(
                protocol::hash(&bytes) == journal.terms.result_hash,
                "saved result differs from fixture terms"
            );
            let drop_reply = core.fault.as_deref() == Some("after-result");
            Ok((
                cp::Message::Result {
                    result: job.result.context("missing saved result")?,
                    bytes,
                },
                drop_reply,
            ))
        }
        cp::Message::Close { close } => {
            let channel = request.agreement_id;
            ensure!(channel != ZERO && request.request_id.is_empty());
            let admission_key = provider_admission_key(channel);
            let admission = admitted
                .get(&admission_key)
                .cloned()
                .context("channel has not been admitted on this connection")?;
            ensure!(
                admission.peer == peer,
                "channel admission belongs to another peer"
            );
            let mut journal = read_provider(&core.root, channel)?;
            ensure!(request.buyer == journal.buyer, "wrong buyer envelope");
            ensure!(peer == journal.offer.payload.buyer_key.as_slice());
            verify_statement(
                &close.payload,
                &close.signature,
                &journal.offer.payload.buyer_key,
            )?;
            validate_close_binding(
                &journal.offer.payload,
                channel,
                &journal.jobs,
                &journal.transcript_hash,
                &close.payload,
            )?;
            if let Some(cert) = &journal.certificate {
                ensure!(cert.close == close.payload, "conflicting repeated close");
                return Ok((
                    cp::Message::CloseAcknowledge {
                        certificate: Box::new(cert.clone()),
                    },
                    false,
                ));
            }
            let provider_signature = protocol::sign(&close.payload, &core.identity.key)?;
            let certificate = cp::CloseCertificate {
                close: close.payload.clone(),
                buyer_signature: close.signature.clone(),
                provider_signature,
            };
            journal.frozen = true;
            journal.close = Some(close.clone());
            journal.certificate = Some(certificate.clone());
            persist_provider(&core.root, &journal)?;
            let drop_reply = core.fault.as_deref() == Some("after-close-certificate");
            Ok((
                cp::Message::CloseAcknowledge {
                    certificate: Box::new(certificate),
                },
                drop_reply,
            ))
        }
        _ => bail!("message is not valid in provider role"),
    }
}

fn recovery_attempt_timeout(core: &ProviderCore) -> Duration {
    Duration::from_millis((core.grace_ms / 4).clamp(1_000, 5_000))
}

async fn recovery_call(core: &ProviderCore, args: Value) -> Result<Value> {
    timeout(
        recovery_attempt_timeout(core),
        core.bridge.call(args, "recovery"),
    )
    .await
    .context("provider recovery bridge attempt timed out")?
}

fn claim_attempt_timeout(
    core: &ProviderCore,
    anchor: &ClockAnchor,
    deadline: u64,
) -> Result<Duration> {
    let remaining = deadline.saturating_sub(anchor.upper_now()?);
    ensure!(
        remaining > 0,
        "claim deadline reached before recovery mutation"
    );
    Ok(recovery_attempt_timeout(core).min(Duration::from_millis(remaining)))
}

async fn claim_recovery_call(
    core: &ProviderCore,
    args: Value,
    anchor: &ClockAnchor,
    deadline: u64,
) -> Result<Value> {
    timeout(
        claim_attempt_timeout(core, anchor, deadline)?,
        core.bridge.call(args, "recovery"),
    )
    .await
    .context("claim recovery attempt timed out; reconcile saved transaction")?
}

async fn provider_recovery(core: &ProviderCore) -> Result<()> {
    for saved in all_provider_journals(&core.root)? {
        let guard = core.state_lock.lock().await;
        let mut journal = read_provider(&core.root, saved.channel)?;
        if journal
            .chain_state
            .as_ref()
            .is_some_and(|state| state_status(state) != 0)
        {
            continue;
        }
        let anchor_key = provider_admission_key(journal.channel);
        let cached = core.recovery_anchors.lock().await.get(&anchor_key).cloned();
        if !journal.clock_untrusted
            && !journal.recovery_started
            && let Some(anchor) = cached
            && let Ok(upper_now) = anchor.upper_now()
            && !recovery_due(journal.offer.payload.work_deadline_ms, upper_now)
        {
            continue;
        }
        // Freeze this channel before releasing the process-wide state lock.
        // Network I/O must not block request handling on unrelated channels.
        journal.clock_untrusted = true;
        journal.frozen = true;
        persist_provider(&core.root, &journal)?;
        drop(guard);
        let snapshot_started = Instant::now();
        let snapshot = match recovery_call(
            core,
            json!({"action":"channel_snapshot","id":journal.channel}),
        )
        .await
        {
            Ok(value) => value,
            Err(error) => {
                eprintln!(
                    "{}",
                    json!({"event":"channel_recovery","channel":journal.channel,"phase":"retry","result":"unknown","message":error.to_string()})
                );
                continue;
            }
        };
        let guard = core.state_lock.lock().await;
        // A peer can supply a close certificate while RPC is in flight. Merge
        // into the latest journal instead of overwriting its durable consent.
        journal = read_provider(&core.root, saved.channel)?;
        let state = snapshot
            .get("channel")
            .cloned()
            .context("recovery snapshot lacks channel")?;
        let chain_now = u64_value(&snapshot, "timestamp_ms")?;
        let fresh_anchor = match ClockAnchor::new(chain_now, snapshot_started, now_ms()?) {
            Ok(anchor) => anchor,
            Err(error) => {
                eprintln!(
                    "{}",
                    json!({"event":"channel_recovery","channel":journal.channel,"phase":"retry","result":"clock_untrusted","message":error.to_string()})
                );
                continue;
            }
        };
        let upper_now = fresh_anchor.upper_now()?;
        core.recovery_anchors
            .lock()
            .await
            .insert(anchor_key, fresh_anchor.clone());
        journal.anchor_upper_ms = fresh_anchor.upper_ms;
        journal.chain_state = Some(state.clone());
        journal.clock_untrusted = false;
        let status = state_status(&state);
        if status != 0 {
            journal.frozen = true;
            persist_provider(&core.root, &journal)?;
            continue;
        }
        if !journal.recovery_started
            && !recovery_due(journal.offer.payload.work_deadline_ms, upper_now)
        {
            journal.frozen = journal.close.is_some() || journal.certificate.is_some();
            persist_provider(&core.root, &journal)?;
            continue;
        }
        if !journal.recovery_started {
            eprintln!(
                "{}",
                json!({"event":"channel_recovery","channel":journal.channel,"phase":"begin"})
            );
        }
        journal.recovery_started = true;
        journal.frozen = true;
        persist_provider(&core.root, &journal)?;
        drop(guard);
        let deadline = journal.offer.payload.claim_deadline_ms;
        let mut mutation: Option<Value> = None;
        // Use the actual sampled chain time for refunds. A conservative upper
        // bound reaching expiry is not evidence that a refund is already legal.
        if chain_now >= deadline {
            match recovery_call(core, json!({"action":"channel_refund","id":journal.channel,"signer_file":canonical_path(&core.gas_signer)?,"journal":core.root.join("channels/tx").join(format!("{}.recovery-refund.tx.json",journal.channel))})).await {
                Ok(value) => mutation = Some(value),
                Err(error) => eprintln!("{}", json!({"event":"channel_recovery","channel":journal.channel,"phase":"refund_retry","message":error.to_string()})),
            }
        } else if let Some(cert) = journal.certificate.clone() {
            validate_close_certificate_binding(
                &journal.offer.payload,
                journal.channel,
                &journal.jobs,
                &journal.transcript_hash,
                &cert,
            )?;
            match claim_recovery_call(core, json!({"action":"channel_close","certificate":cert,"signer_file":canonical_path(&core.gas_signer)?,"journal":core.root.join("channels/tx").join(format!("{}.recovery-close.tx.json",journal.channel))}), &fresh_anchor, deadline).await {
                Ok(value) => mutation = Some(value),
                Err(error) => eprintln!("{}", json!({"event":"channel_recovery","channel":journal.channel,"phase":"close_retry","message":error.to_string()})),
            }
        }
        // Recheck the advancing monotonic clock after the close attempt.
        if mutation.is_none()
            && fresh_anchor.upper_now()? < deadline
            && let Some(credit) = highest_credit(&journal.jobs)
            && state_u64(&state, "redeemed_amount") < credit.payload.cumulative_amount
        {
            match claim_recovery_call(core, json!({"action":"channel_redeem","credit":credit.payload,"signature":credit.signature,"signer_file":canonical_path(&core.gas_signer)?,"journal":core.root.join("channels/tx").join(format!("{}.recovery-redeem.tx.json",journal.channel))}), &fresh_anchor, deadline).await {
                Ok(value) => mutation = Some(value),
                Err(error) => eprintln!("{}", json!({"event":"channel_recovery","channel":journal.channel,"phase":"redeem_retry","message":error.to_string()})),
            }
        }
        let _guard = core.state_lock.lock().await;
        journal = read_provider(&core.root, saved.channel)?;
        if let Some(value) = mutation {
            journal.chain_state = value.get("state").cloned().or(journal.chain_state);
            journal.chain_digest = value
                .get("digest")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
                .or(journal.chain_digest);
        }
        persist_provider(&core.root, &journal)?;
        eprintln!(
            "{}",
            json!({"event":"channel_recovery","channel":journal.channel,"phase":"end","status":journal.chain_state.as_ref().map(state_status).unwrap_or(0)})
        );
    }
    Ok(())
}

pub async fn serve(store: &Store, identity: &ChannelIdentity, opts: ServeOptions) -> Result<()> {
    ensure!(
        opts.unit_price > 0 && opts.max_jobs > 0 && opts.max_jobs <= 1_000,
        "invalid provider channel terms"
    );
    ensure!(
        opts.work_ms >= 10_000
            && opts.grace_ms >= MIN_GRACE_MS
            && opts.work_ms.saturating_add(opts.grace_ms) <= MAX_LIFETIME_MS,
        "invalid provider lifetime"
    );
    let bytes = fs::read(&opts.file)?;
    let service: Arc<dyn ServiceHandler> = Arc::new(FixedFile::new(bytes.clone())?);
    let root = canonical_path(&store.root)?;
    let mut builder = if opts.relay || opts.relay_only {
        Endpoint::builder(presets::N0)
    } else {
        Endpoint::builder(presets::Minimal)
    };
    if opts.relay_only {
        builder = builder.clear_ip_transports();
    }
    let endpoint = builder
        .secret_key(identity.key.clone())
        .alpns(vec![cp::ALPN.to_vec()])
        .bind()
        .await?;
    if opts.relay || opts.relay_only {
        timeout(Duration::from_secs(30), endpoint.online()).await?;
    }
    let ticket = cp::Ticket {
        version: cp::VERSION,
        method: cp::METHOD.to_owned(),
        agent: identity.agent,
        endpoint: endpoint.addr(),
    };
    let core = Arc::new(ProviderCore {
        root,
        bridge: ChannelBridge::new(identity.chain.clone()),
        identity: identity.clone(),
        service,
        gas_signer: canonical_path(&opts.gas_signer)?,
        unit_price: opts.unit_price,
        max_jobs: opts.max_jobs,
        work_ms: opts.work_ms,
        grace_ms: opts.grace_ms,
        fault: opts.fault,
        state_lock: Mutex::new(()),
        recovery_anchors: Mutex::new(HashMap::new()),
    });
    provider_recovery(&core).await?;
    ticket.validate()?;
    store::write(&opts.ticket, &ticket)?;
    println!(
        "{}",
        json!({"ready":true,"agent":identity.agent,"ticket":opts.ticket,"result_hash":hex::encode(protocol::hash(&bytes))})
    );
    let poll_ms = DEFAULT_POLL_MS.min(opts.grace_ms / 4).max(250);
    let recovery_core = core.clone();
    let recovery_task = tokio::spawn(async move {
        let mut ticks = tokio::time::interval(Duration::from_millis(poll_ms));
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        ticks.tick().await;
        loop {
            ticks.tick().await;
            if let Err(error) = provider_recovery(&recovery_core).await {
                eprintln!(
                    "{}",
                    json!({"event":"channel_recovery","phase":"error","message":error.to_string()})
                );
            }
        }
    });
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            incoming = endpoint.accept() => {
                let Some(incoming) = incoming else { break; };
                let task_core = core.clone();
                tokio::spawn(async move {
                    match timeout(Duration::from_secs(10), incoming).await {
                        Ok(Ok(connection)) => if let Err(error) = provider_connection(task_core, connection).await { eprintln!("channel connection failed: {error:#}"); },
                        Ok(Err(error)) => eprintln!("channel handshake failed: {error:#}"),
                        Err(error) => eprintln!("channel handshake timed out: {error:#}"),
                    }
                });
            }
        }
    }
    recovery_task.abort();
    let _ = recovery_task.await;
    endpoint.close().await;
    Ok(())
}

pub async fn status(store: &Store, identity: &ChannelIdentity, session: &str) -> Result<Value> {
    safe_session(session)?;
    let root = canonical_path(&store.root)?;
    let mut value = read_session(&root, session)?;
    let bridge = ChannelBridge::new(identity.chain.clone());
    if let Some(channel) = value.channel {
        let snapshot = bridge
            .call(json!({"action":"channel_snapshot","id":channel}), "status")
            .await
            .context("channel status is unknown because reconciliation failed")?;
        let state = snapshot
            .get("channel")
            .cloned()
            .context("missing channel state")?;
        let onchain_offer: cp::Offer = serde_json::from_value(
            state
                .get("offer")
                .cloned()
                .context("channel snapshot omits offer")?,
        )?;
        ensure!(
            Some(onchain_offer) == value.offer.as_ref().map(|offer| offer.payload.clone()),
            "onchain offer differs from saved offer"
        );
        value.chain_state = Some(state);
        persist_session(&root, &value)?;
    }
    summary(&value)
}

pub async fn close(
    store: &Store,
    identity: &ChannelIdentity,
    session: &str,
    gas_signer: &Path,
) -> Result<Value> {
    safe_session(session)?;
    let root = canonical_path(&store.root)?;
    let mut value = read_session(&root, session)?;
    ensure!(value.buyer == identity.agent, "close caller is not buyer");
    let bridge = ChannelBridge::new(identity.chain.clone());
    if let Some(cert) = value.certificate.clone() {
        return submit_close(&root, &bridge, &mut value, gas_signer, &cert).await;
    }
    ensure!(
        value.channel.is_some(),
        "cannot close before channel is opened"
    );
    ensure!(
        !value.ticket_path.is_empty(),
        "saved session has no provider routing ticket"
    );
    let (endpoint, connection, ticket) = connect(
        Path::new(&value.ticket_path),
        identity.key.clone(),
        value.relay,
        value.relay_only,
    )
    .await?;
    ensure!(
        ticket.agent == value.provider,
        "ticket advertises another provider"
    );
    ensure!(
        connection.remote_id().as_bytes()
            == value
                .offer
                .as_ref()
                .context("session has no saved offer")?
                .payload
                .provider_key
                .as_slice(),
        "connected peer is not the saved provider endpoint"
    );
    let _anchor = buyer_admit_and_resume(&root, &bridge, &mut value, &connection).await?;
    let result = close_buyer(
        &root,
        &bridge,
        identity,
        &mut value,
        gas_signer,
        Some(&connection),
        &None::<String>,
    )
    .await?;
    connection.close(0u32.into(), b"channel close complete");
    endpoint.close().await;
    Ok(result)
}

pub async fn redeem(
    store: &Store,
    identity: &ChannelIdentity,
    channel: Address,
    gas_signer: &Path,
) -> Result<Value> {
    let root = canonical_path(&store.root)?;
    let journal = read_provider(&root, channel)?;
    ensure!(
        journal.provider == identity.agent,
        "redeem caller is not provider"
    );
    let credit = highest_credit(&journal.jobs).context("provider has no saved credit")?;
    let bridge = ChannelBridge::new(identity.chain.clone());
    let value = bridge.call(json!({"action":"channel_redeem","credit":credit.payload,"signature":credit.signature,"signer_file":canonical_path(gas_signer)?,"journal":root.join("channels").join("tx").join(format!("{channel}.redeem.tx.json"))}), "redeem").await?;
    Ok(value)
}

pub async fn refund(
    store: &Store,
    identity: &ChannelIdentity,
    session: &str,
    gas_signer: &Path,
) -> Result<Value> {
    safe_session(session)?;
    let root = canonical_path(&store.root)?;
    let mut value = read_session(&root, session)?;
    ensure!(value.buyer == identity.agent, "refund caller is not buyer");
    let channel = value.channel.context("missing channel")?;
    let bridge = ChannelBridge::new(identity.chain.clone());
    let result = bridge.call(json!({"action":"channel_refund","id":channel,"signer_file":canonical_path(gas_signer)?,"journal":root.join("channels").join("tx").join(format!("{session}.refund.tx.json"))}), "refund").await?;
    value.chain_state = result.get("state").cloned();
    value.chain_digest = result
        .get("digest")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);
    persist_session(&root, &value)?;
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reservation_identity() -> ChannelIdentity {
        ChannelIdentity {
            agent: Address::new([21; 32]),
            chain: Config {
                rpc_url: "http://127.0.0.1:1".into(),
                network: "localnet".into(),
                chain_id: "test".into(),
                package_id: Address::new([22; 32]),
                deployment: Address::new([23; 32]),
            },
            key: SecretKey::from_bytes(&[24; 32]),
        }
    }

    fn reservation_options(session: &str, provider: Address) -> BuyOptions {
        BuyOptions {
            provider,
            ticket: PathBuf::from("ticket.json"),
            expected_file: PathBuf::from("expected.bin"),
            signer: PathBuf::from("signer.json"),
            session: session.to_owned(),
            jobs: 2,
            deposit: 2_000,
            max_unit_price: 1_000,
            relay: false,
            relay_only: false,
            stop_after: None,
            close: false,
        }
    }

    fn fresh_vector_offer() -> Result<(cp::Offer, cp::FixtureTerms)> {
        let vectors = cp::signing_vectors()?;
        let mut offer: cp::Offer =
            serde_json::from_value(vectors["statements"]["offer"]["payload"].clone())?;
        let terms: cp::FixtureTerms =
            serde_json::from_value(vectors["statements"]["terms"]["payload"].clone())?;
        let now = now_ms()?;
        offer.offer_expires_ms = now + 10_000;
        offer.work_deadline_ms = now + 60_000;
        offer.claim_deadline_ms = now + 70_000;
        Ok((offer, terms))
    }

    #[test]
    fn reservation_is_a_durable_tombstone_before_session_creation() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let identity = reservation_identity();
        let opts = reservation_options("reserved", Address::new([25; 32]));
        let expected_hash = vec![26; 32];
        let reservation = reserve_session(dir.path(), &identity, &opts, &expected_hash)?;
        assert_eq!(
            store::read::<SessionReservation>(&reservation_path(dir.path(), "reserved"))?,
            reservation
        );
        let error = reserve_session(dir.path(), &identity, &opts, &expected_hash)
            .expect_err("a missing journal must not get a fresh nonce");
        assert!(error.to_string().contains("durable reservation"));
        Ok(())
    }

    #[test]
    fn old_valid_session_registers_one_reservation_marker() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let identity = reservation_identity();
        let opts = reservation_options("old", Address::new([25; 32]));
        let session = SessionJournal {
            version: cp::VERSION,
            role: "buyer".into(),
            session: opts.session.clone(),
            buyer: identity.agent,
            provider: opts.provider,
            opening_nonce: vec![27; OPENING_NONCE_LEN],
            requested_jobs: opts.jobs,
            requested_deposit: opts.deposit,
            max_unit_price: opts.max_unit_price,
            expected_result_hash: vec![28; 32],
            terms: None,
            offer: None,
            channel: None,
            jobs: vec![],
            transcript_hash: None,
            frozen: false,
            close: None,
            certificate: None,
            chain_state: None,
            chain_digest: None,
            anchor_upper_ms: None,
            recovery_started: false,
            ticket_path: String::new(),
            relay: false,
            relay_only: false,
        };
        persist_session(dir.path(), &session)?;
        let _reservation = reserve_session(dir.path(), &identity, &opts, &[28; 32])?;
        assert_eq!(
            store::read::<SessionReservation>(&reservation_path(dir.path(), "old"))?,
            reservation_from_session(&session)
        );
        Ok(())
    }

    #[test]
    fn missing_session_history_cannot_start_a_new_reservation() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let identity = reservation_identity();
        let opts = reservation_options("history", Address::new([25; 32]));
        let tx_dir = dir.path().join("channels").join("tx");
        fs::create_dir_all(&tx_dir)?;
        fs::write(tx_dir.join("history.open.tx.json"), b"{}").unwrap();
        let error = reserve_session(dir.path(), &identity, &opts, &[29; 32])
            .expect_err("transaction history without a journal is ambiguous");
        assert!(error.to_string().contains("transaction or result history"));
        Ok(())
    }

    #[test]
    fn offer_index_keeps_same_nonce_for_different_buyers() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let (base, terms) = fresh_vector_offer()?;
        for (buyer, nonce) in [(Address::new([31; 32]), 32), (Address::new([32; 32]), 33)] {
            let mut offer = base.clone();
            offer.buyer = buyer;
            offer.opening_nonce = vec![nonce; OPENING_NONCE_LEN];
            let path = offer_path(dir.path(), &offer)?;
            let signature = protocol::sign(&offer, &SecretKey::from_bytes(&[2; 32]))?;
            let signed_offer = cp::Signed {
                payload: offer,
                signature,
            };
            store::write(
                &path,
                &OfferJournal {
                    version: cp::VERSION,
                    offer: signed_offer,
                    terms: terms.clone(),
                    channel: None,
                },
            )?;
        }
        let offers = parse_offer_files(dir.path())?;
        assert_eq!(offers.len(), 2);
        Ok(())
    }

    #[test]
    fn completed_history_after_pending_credit_is_rejected() -> Result<()> {
        let dir = tempfile::tempdir()?;
        let (offer, terms) = fresh_vector_offer()?;
        let vectors = cp::signing_vectors()?;
        let payload = |name: &str| vectors["statements"][name]["payload"].clone();
        let channel = serde_json::from_value::<cp::RequestDescriptor>(payload("request"))?.channel;
        let t0 = cp::transcript_start(channel, &offer)?;
        let mut request1: cp::RequestDescriptor = serde_json::from_value(payload("request"))?;
        request1.terms_hash = cp::terms_hash(&terms)?;
        let mut credit1: cp::Credit = serde_json::from_value(payload("credit"))?;
        credit1.offer_hash = cp::offer_hash(&offer)?;
        credit1.request_hash = cp::request_hash(&request1)?;
        credit1.previous_transcript_hash = t0.clone();
        let credit1_signature = protocol::sign(&credit1, &SecretKey::from_bytes(&[1; 32]))?;
        let mut ack1: cp::Ack = serde_json::from_value(payload("ack"))?;
        ack1.offer_hash = credit1.offer_hash.clone();
        ack1.credit_hash = cp::credit_hash(&credit1)?;
        let ack1_signature = protocol::sign(&ack1, &SecretKey::from_bytes(&[2; 32]))?;

        let mut request2 = request1.clone();
        request2.request_id = b"job-0002".to_vec();
        request2.request_sequence = 2;
        let mut credit2 = credit1.clone();
        credit2.sequence = 2;
        credit2.cumulative_amount = 2_000;
        credit2.request_hash = cp::request_hash(&request2)?;
        let credit2_signature = protocol::sign(&credit2, &SecretKey::from_bytes(&[1; 32]))?;
        let mut ack2 = ack1.clone();
        ack2.sequence = 2;
        ack2.cumulative_amount = 2_000;
        ack2.credit_hash = cp::credit_hash(&credit2)?;
        let ack2_signature = protocol::sign(&ack2, &SecretKey::from_bytes(&[2; 32]))?;
        let mut result2_payload: cp::ResultStatement = serde_json::from_value(payload("result"))?;
        result2_payload.offer_hash = credit2.offer_hash.clone();
        result2_payload.request_hash = cp::request_hash(&request2)?;
        result2_payload.credit_hash = cp::credit_hash(&credit2)?;
        result2_payload.result_hash = terms.result_hash.clone();
        let result2 = cp::Signed {
            signature: protocol::sign(&result2_payload, &SecretKey::from_bytes(&[2; 32]))?,
            payload: result2_payload,
        };
        let result_file = dir.path().join("result.bin");
        store::write(
            &result_file,
            &include_bytes!("../fixtures/hello.txt").to_vec(),
        )?;
        let transcript_after =
            cp::transcript_next(&t0, &request2, &credit2, &ack2, &result2.payload)?;
        let jobs = vec![
            JobRecord {
                request: request1,
                credit: cp::Signed {
                    payload: credit1,
                    signature: credit1_signature,
                },
                ack: Some(cp::Signed {
                    payload: ack1,
                    signature: ack1_signature,
                }),
                result: None,
                result_file: None,
                transcript_after: None,
                completed: false,
            },
            JobRecord {
                request: request2,
                credit: cp::Signed {
                    payload: credit2,
                    signature: credit2_signature,
                },
                ack: Some(cp::Signed {
                    payload: ack2,
                    signature: ack2_signature,
                }),
                result: Some(result2),
                result_file: Some(result_file.to_string_lossy().into_owned()),
                transcript_after: Some(transcript_after),
                completed: true,
            },
        ];
        let error = validate_records(&offer, &terms, channel, &jobs)
            .expect_err("a completed job cannot follow an unfulfilled credit");
        assert!(error.to_string().contains("completed job follows"));
        Ok(())
    }

    #[test]
    fn close_binding_rejects_channel_and_domain_mismatch() -> Result<()> {
        let (offer, terms) = fresh_vector_offer()?;
        let channel = Address::new([34; 32]);
        let transcript = cp::transcript_start(channel, &offer)?;
        let mut close = close_for(&offer, channel, 0, 0, transcript.clone())?;
        close.channel = Address::new([35; 32]);
        assert!(validate_close_binding(&offer, channel, &[], &transcript, &close).is_err());
        let mut close = close_for(&offer, channel, 0, 0, transcript.clone())?;
        close.network = b"other-domain".to_vec();
        assert!(validate_close_binding(&offer, channel, &[], &transcript, &close).is_err());
        assert_eq!(terms.max_unfulfilled_jobs, 1);
        Ok(())
    }

    #[test]
    fn response_context_rejects_a_mismatched_buyer() -> Result<()> {
        let request = envelope(
            Address::new([36; 32]),
            Address::new([37; 32]),
            Address::new([38; 32]),
            b"",
            cp::Message::Resume {},
        );
        let mut response = envelope(
            request.buyer,
            request.provider,
            request.agreement_id,
            b"",
            cp::Message::Ready {
                phase: "active".into(),
                highest_credit: None,
                completed_jobs: 0,
                transcript_hash: vec![39; 32],
                certificate: None,
                redeemed_amount: 0,
            },
        );
        response.buyer = Address::new([40; 32]);
        assert!(validate_response_context(&request, &response).is_err());
        Ok(())
    }

    #[test]
    fn unicode_error_messages_are_truncated_at_a_character_boundary() {
        let input = format!("{}é", "a".repeat(MAX_DIAGNOSTIC - 1));
        let cp::Message::Error { message, .. } = error_message("internal", input) else {
            panic!("expected error message");
        };
        assert!(message.len() <= MAX_DIAGNOSTIC);
        assert!(message.is_char_boundary(message.len()));
    }

    #[test]
    fn recovery_attempt_timeout_stays_within_the_grace_window() {
        let core = ProviderCore {
            root: PathBuf::from("."),
            bridge: ChannelBridge::new(Config {
                rpc_url: "http://127.0.0.1:1".into(),
                network: "localnet".into(),
                chain_id: "test".into(),
                package_id: Address::new([41; 32]),
                deployment: Address::new([42; 32]),
            }),
            identity: reservation_identity(),
            service: Arc::new(FixedFile::new(b"fixture".to_vec()).unwrap()),
            gas_signer: PathBuf::from("signer"),
            unit_price: 1,
            max_jobs: 1,
            work_ms: 10_000,
            grace_ms: 90_000,
            fault: None,
            state_lock: Mutex::new(()),
            recovery_anchors: Mutex::new(HashMap::new()),
        };
        assert_eq!(recovery_attempt_timeout(&core), Duration::from_secs(5));
        let now = now_ms().unwrap();
        let anchor = ClockAnchor::new(now, Instant::now(), now).unwrap();
        let deadline = anchor.upper_now().unwrap() + 250;
        assert!(
            claim_attempt_timeout(&core, &anchor, deadline).unwrap() <= Duration::from_millis(250)
        );
        assert!(claim_attempt_timeout(&core, &anchor, anchor.upper_ms).is_err());
    }

    #[tokio::test]
    async fn saved_credit_replays_exact_ack_even_after_freeze() -> Result<()> {
        let vectors = cp::signing_vectors()?;
        let payload = |name: &str| vectors["statements"][name]["payload"].clone();
        let signature = |name: &str| -> Result<Vec<u8>> {
            Ok(hex::decode(
                vectors["statements"][name]["signature_hex"]
                    .as_str()
                    .unwrap(),
            )?)
        };
        let mut offer = cp::Signed {
            payload: serde_json::from_value::<cp::Offer>(payload("offer"))?,
            signature: signature("offer")?,
        };
        let mut credit = cp::Signed {
            payload: serde_json::from_value::<cp::Credit>(payload("credit"))?,
            signature: signature("credit")?,
        };
        let mut ack = cp::Signed {
            payload: serde_json::from_value::<cp::Ack>(payload("ack"))?,
            signature: signature("ack")?,
        };
        let descriptor: cp::RequestDescriptor = serde_json::from_value(payload("request"))?;
        let terms: cp::FixtureTerms = serde_json::from_value(payload("terms"))?;
        let channel = credit.payload.channel;
        let now = now_ms()?;
        offer.payload.offer_expires_ms = now - 300_000;
        offer.payload.work_deadline_ms = now - 100_000;
        offer.payload.claim_deadline_ms = now - 40_000;
        offer.signature = protocol::sign(&offer.payload, &SecretKey::from_bytes(&[2; 32]))?;
        credit.payload.offer_hash = cp::offer_hash(&offer.payload)?;
        credit.payload.previous_transcript_hash = cp::transcript_start(channel, &offer.payload)?;
        credit.signature = protocol::sign(&credit.payload, &SecretKey::from_bytes(&[1; 32]))?;
        ack.payload.offer_hash = credit.payload.offer_hash.clone();
        ack.payload.credit_hash = cp::credit_hash(&credit.payload)?;
        ack.signature = protocol::sign(&ack.payload, &SecretKey::from_bytes(&[2; 32]))?;
        let dir = tempfile::tempdir()?;
        let journal = ProviderJournal {
            version: cp::VERSION,
            role: "provider".into(),
            session: "replay".into(),
            buyer: offer.payload.buyer,
            provider: offer.payload.provider,
            transcript_hash: cp::transcript_start(channel, &offer.payload)?,
            offer: offer.clone(),
            terms,
            channel,
            jobs: vec![JobRecord {
                request: descriptor.clone(),
                credit: credit.clone(),
                ack: Some(ack.clone()),
                result: None,
                result_file: None,
                transcript_after: None,
                completed: false,
            }],
            frozen: true,
            close: None,
            certificate: None,
            chain_state: None,
            chain_digest: None,
            anchor_upper_ms: 0,
            recovery_started: true,
            clock_untrusted: false,
        };
        persist_provider(dir.path(), &journal)?;
        let config = Config {
            rpc_url: "http://127.0.0.1:1".into(),
            network: "localnet".into(),
            chain_id: String::from_utf8(offer.payload.network.clone())?,
            package_id: offer.payload.package_id,
            deployment: offer.payload.deployment,
        };
        let core = ProviderCore {
            root: dir.path().to_owned(),
            bridge: ChannelBridge::new(config.clone()),
            identity: ChannelIdentity {
                agent: offer.payload.provider,
                chain: config,
                key: SecretKey::from_bytes(&[2; 32]),
            },
            service: Arc::new(FixedFile::new(b"fixture".to_vec())?),
            gas_signer: dir.path().join("unused"),
            unit_price: 1000,
            max_jobs: 10,
            work_ms: 300_000,
            grace_ms: 60_000,
            fault: None,
            state_lock: Mutex::new(()),
            recovery_anchors: Mutex::new(HashMap::new()),
        };
        let mut request = envelope(
            offer.payload.buyer,
            offer.payload.provider,
            channel,
            &descriptor.request_id,
            cp::Message::Authorize {
                request: descriptor.clone(),
                credit: credit.clone(),
            },
        );
        let mut admitted = HashMap::from([(
            provider_admission_key(channel),
            ProviderAdmission {
                peer: offer.payload.buyer_key.clone(),
                anchor: ClockAnchor::new(now, Instant::now(), now)?,
            },
        )]);
        let before = fs::read(provider_path(dir.path(), channel))?;
        for _ in 0..2 {
            let (message, drop_reply) =
                provider_message(&core, &request, &offer.payload.buyer_key, &mut admitted).await?;
            match message {
                cp::Message::Acknowledge { ack: replayed } => assert_eq!(replayed, ack),
                _ => panic!("expected saved Ack"),
            }
            assert!(!drop_reply);
        }
        assert_eq!(fs::read(provider_path(dir.path(), channel))?, before);
        // A new sequence cannot reuse a durable request ID, even if all other
        // fields and signatures are valid. Reject before changing the journal.
        let mut duplicate_descriptor = descriptor.clone();
        duplicate_descriptor.request_sequence = 2;
        let mut duplicate_credit = credit.clone();
        duplicate_credit.payload.sequence = 2;
        duplicate_credit.payload.cumulative_amount = 2_000;
        duplicate_credit.payload.request_hash = cp::request_hash(&duplicate_descriptor)?;
        duplicate_credit.signature =
            protocol::sign(&duplicate_credit.payload, &SecretKey::from_bytes(&[1; 32]))?;
        let duplicate = envelope(
            offer.payload.buyer,
            offer.payload.provider,
            channel,
            &descriptor.request_id,
            cp::Message::Authorize {
                request: duplicate_descriptor,
                credit: duplicate_credit,
            },
        );
        let error = provider_message(&core, &duplicate, &offer.payload.buyer_key, &mut admitted)
            .await
            .expect_err("duplicate request ID must fail");
        assert!(error.to_string().contains("request ID was already used"));
        assert_eq!(fs::read(provider_path(dir.path(), channel))?, before);
        let mut next_descriptor = descriptor.clone();
        next_descriptor.request_id = b"job-0002".to_vec();
        next_descriptor.request_sequence = 2;
        let mut next_credit_payload = credit.payload.clone();
        next_credit_payload.sequence = 2;
        next_credit_payload.cumulative_amount = 2_000;
        next_credit_payload.request_hash = cp::request_hash(&next_descriptor)?;
        next_credit_payload.previous_transcript_hash = journal.transcript_hash.clone();
        let next_credit = cp::Signed {
            signature: protocol::sign(&next_credit_payload, &SecretKey::from_bytes(&[1; 32]))?,
            payload: next_credit_payload,
        };
        let next_request_id = next_descriptor.request_id.clone();
        let new_authorize = envelope(
            offer.payload.buyer,
            offer.payload.provider,
            channel,
            &next_request_id,
            cp::Message::Authorize {
                request: next_descriptor,
                credit: next_credit,
            },
        );
        assert!(
            provider_message(
                &core,
                &new_authorize,
                &offer.payload.buyer_key,
                &mut admitted,
            )
            .await
            .is_err()
        );
        let pending_get = envelope(
            offer.payload.buyer,
            offer.payload.provider,
            channel,
            &descriptor.request_id,
            cp::Message::Get {
                request_hash: cp::request_hash(&descriptor)?,
            },
        );
        assert!(
            provider_message(&core, &pending_get, &offer.payload.buyer_key, &mut admitted,)
                .await
                .is_err()
        );
        // Terminal settlement still permits replay of the exact cached bytes.
        let mut terminal = journal.clone();
        let bytes = include_bytes!("../fixtures/hello.txt").to_vec();
        let result_payload = result_for(
            &offer.payload,
            channel,
            &descriptor,
            &credit.payload,
            protocol::hash(&bytes),
        )?;
        let result = cp::Signed {
            signature: protocol::sign(&result_payload, &SecretKey::from_bytes(&[2; 32]))?,
            payload: result_payload,
        };
        let result_file = dir.path().join("cached-result.json");
        store::write(&result_file, &bytes)?;
        let transcript = cp::transcript_next(
            &terminal.transcript_hash,
            &descriptor,
            &credit.payload,
            &ack.payload,
            &result.payload,
        )?;
        terminal.jobs[0].result = Some(result.clone());
        terminal.jobs[0].result_file = Some(result_file.to_string_lossy().into_owned());
        terminal.jobs[0].transcript_after = Some(transcript.clone());
        terminal.jobs[0].completed = true;
        terminal.transcript_hash = transcript;
        for status in [1, 2] {
            terminal.chain_state = Some(json!({"status":status}));
            persist_provider(dir.path(), &terminal)?;
            let before = fs::read(provider_path(dir.path(), channel))?;
            let (replayed, _) =
                provider_message(&core, &pending_get, &offer.payload.buyer_key, &mut admitted)
                    .await?;
            assert_eq!(
                replayed,
                cp::Message::Result {
                    result: result.clone(),
                    bytes: bytes.clone()
                }
            );
            let (replayed, _) =
                provider_message(&core, &request, &offer.payload.buyer_key, &mut admitted).await?;
            assert_eq!(replayed, cp::Message::Acknowledge { ack: ack.clone() });
            assert_eq!(fs::read(provider_path(dir.path(), channel))?, before);
        }
        assert!(
            provider_message(&core, &request, &[7; 32], &mut admitted)
                .await
                .is_err()
        );
        if let cp::Message::Authorize { credit, .. } = &mut request.message {
            credit.payload.cumulative_amount += 1;
            credit.signature = protocol::sign(&credit.payload, &SecretKey::from_bytes(&[1; 32]))?;
        }
        assert!(
            provider_message(&core, &request, &offer.payload.buyer_key, &mut admitted,)
                .await
                .is_err()
        );
        Ok(())
    }

    #[test]
    fn clock_anchor_is_conservative_and_rejects_skew() {
        let started = Instant::now();
        let local = now_ms().unwrap();
        let anchor = ClockAnchor::new(local, started, local).unwrap();
        assert!(anchor.upper_ms >= local + 5_000);
        assert!(ClockAnchor::new(local + 10_001, started, local).is_err());
    }

    #[test]
    fn session_names_and_result_paths_are_bounded() {
        assert!(safe_session("job_0001").is_ok());
        assert!(safe_session("").is_err());
        assert!(safe_session(&"x".repeat(65)).is_err());
        let path = result_path(Path::new("/tmp/m2m-test"), "abc", 1);
        assert!(path.ends_with("channels/results/abc/1.bin"));
    }

    #[test]
    fn store_writes_survive_a_new_reader_and_corrupt_records_are_not_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let session = SessionJournal {
            version: cp::VERSION,
            role: "buyer".into(),
            session: "s".into(),
            buyer: ZERO,
            provider: ZERO,
            opening_nonce: vec![1; 32],
            requested_jobs: 1,
            requested_deposit: 1,
            max_unit_price: 1,
            expected_result_hash: vec![2; 32],
            terms: None,
            offer: None,
            channel: None,
            jobs: vec![],
            transcript_hash: None,
            frozen: false,
            close: None,
            certificate: None,
            chain_state: None,
            chain_digest: None,
            anchor_upper_ms: None,
            recovery_started: false,
            ticket_path: String::new(),
            relay: false,
            relay_only: false,
        };
        persist_session(dir.path(), &session).unwrap();
        assert_eq!(
            read_session(dir.path(), "s").unwrap().opening_nonce,
            vec![1; 32]
        );
        let path = session_path(dir.path(), "s");
        fs::write(&path, b"{}").unwrap();
        assert!(read_session(dir.path(), "s").is_err());
    }

    #[test]
    fn recovery_scheduler_boundary_uses_injected_clock() {
        assert!(!recovery_due(10_000, 9_999));
        assert!(recovery_due(10_000, 10_000));
        assert!(recovery_due(10_000, 10_001));
    }
}
