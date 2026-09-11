//! Experimental native communication contract. See docs/NATIVE_CORE_SPEC.md.
use anyhow::{Context, Result, bail, ensure};
use blake2::{Blake2b, Digest, digest::consts::U32};
use ed25519_dalek::{Signature, VerifyingKey};
use iroh::SecretKey;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use std::{collections::BTreeMap, path::PathBuf};
pub use sui_sdk_types::Address;

pub const ALPN: &[u8] = b"m2m/core/1";
pub const PURPOSE: &[u8] = b"m2m/core/message/v1";
pub const MAX_FRAME: usize = 1_048_576;
pub const MAX_PAYLOAD: usize = 65_536;
pub const MAX_LEASE_MS: u64 = 30_000;
pub const MAX_LIFETIME_MS: u64 = 86_400_000;

pub mod decimal {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};
    pub fn serialize<S: Serializer>(value: &u64, s: S) -> Result<S::Ok, S::Error> {
        if s.is_human_readable() {
            s.serialize_str(&value.to_string())
        } else {
            s.serialize_u64(*value)
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
        if !d.is_human_readable() {
            return u64::deserialize(d);
        }
        let text = String::deserialize(d)?;
        let value = text.parse::<u64>().map_err(D::Error::custom)?;
        if value.to_string() != text {
            return Err(D::Error::custom("noncanonical u64"));
        }
        Ok(value)
    }
}

fn address<'de, D: serde::Deserializer<'de>>(d: D) -> std::result::Result<Address, D::Error> {
    if !d.is_human_readable() {
        return Address::deserialize(d);
    }
    let text = String::deserialize(d)?;
    if text.len() != 66
        || !text.starts_with("0x")
        || !text[2..]
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(serde::de::Error::custom(
            "expected full lowercase Sui address",
        ));
    }
    text.parse().map_err(serde::de::Error::custom)
}
fn required_option<'de, D: serde::Deserializer<'de>, T: Deserialize<'de>>(
    d: D,
) -> std::result::Result<Option<T>, D::Error> {
    Option::<T>::deserialize(d)
}

pub fn hash(bytes: &[u8]) -> Vec<u8> {
    Blake2b::<U32>::digest(bytes).to_vec()
}
pub fn random_id() -> Vec<u8> {
    SecretKey::generate().public().as_bytes().to_vec()
}
pub fn load_transport_key(path: &std::path::Path) -> Result<SecretKey> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct KeyFile {
        secret_key: Vec<u8>,
    }
    let raw = std::fs::read(path).context("read transport key file")?;
    let bytes = if raw.first() == Some(&b'{') {
        serde_json::from_slice::<KeyFile>(&raw)
            .map_err(|_| anyhow::anyhow!("invalid transport key file shape"))?
            .secret_key
    } else {
        hex::decode(
            std::str::from_utf8(&raw)
                .map_err(|_| anyhow::anyhow!("invalid transport key file encoding"))?
                .trim(),
        )
        .map_err(|_| anyhow::anyhow!("invalid transport key encoding"))?
    };
    Ok(SecretKey::from_bytes(
        &bytes
            .as_slice()
            .try_into()
            .context("transport seed must be 32 bytes")?,
    ))
}
fn strict_point(bytes: &[u8]) -> Result<VerifyingKey> {
    let point = VerifyingKey::from_bytes(bytes.try_into()?)?;
    ensure!(
        !point.is_weak()
            && point.to_edwards().is_torsion_free()
            && point.to_edwards().compress().as_bytes().as_slice() == bytes,
        "unauthorized: canonical nonzero prime-order Ed25519 point required"
    );
    Ok(point)
}
pub fn now_ms() -> Result<u64> {
    Ok(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_millis()
        .try_into()?)
}
pub fn parse<T: DeserializeOwned>(bytes: &[u8]) -> Result<T> {
    ensure!(bytes.len() <= MAX_FRAME, "invalid_message: oversized JSON");
    Ok(serde_json::from_slice(bytes)?)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
pub struct AgentRef {
    pub network: Vec<u8>,
    #[serde(deserialize_with = "address")]
    pub package_id: Address,
    #[serde(deserialize_with = "address")]
    pub domain: Address,
    #[serde(deserialize_with = "address")]
    pub agent: Address,
}
impl AgentRef {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            !self.network.is_empty() && self.network.len() <= 64,
            "invalid_message: network length"
        );
        std::str::from_utf8(&self.network).context("invalid_message: network UTF-8")?;
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Authorization {
    pub agent: AgentRef,
    #[serde(deserialize_with = "address")]
    pub controller: Address,
    pub transport_key: Vec<u8>,
    pub economic_key: Vec<u8>,
    #[serde(with = "decimal")]
    pub generation: u64,
    #[serde(with = "decimal")]
    pub read_at_ms: u64,
    #[serde(with = "decimal")]
    pub valid_until_ms: u64,
}
impl Authorization {
    pub fn validate(&self, expected: &AgentRef, now: u64) -> Result<()> {
        self.agent.validate()?;
        ensure!(
            &self.agent == expected,
            "unauthorized: qualified Agent mismatch"
        );
        ensure!(
            self.transport_key.len() == 32
                && self.economic_key.len() == 32
                && self.transport_key != self.economic_key,
            "unauthorized: distinct Ed25519 keys required"
        );
        strict_point(&self.transport_key)?;
        strict_point(&self.economic_key)?;
        ensure!(
            self.read_at_ms <= now
                && now < self.valid_until_ms
                && now - self.read_at_ms <= MAX_LEASE_MS
                && self.valid_until_ms - self.read_at_ms <= MAX_LEASE_MS,
            "stale_authority: snapshot outside freshness lease"
        );
        Ok(())
    }
}

/// Implementations must independently authenticate chain/deployment/type and expiry.
pub trait Resolver: Send + Sync {
    fn resolve(&self, agent: &AgentRef, now_ms: u64) -> Result<Authorization>;
}
/// Explicitly supplied trusted snapshots. No peer-supplied authority is accepted.
#[derive(Clone, Default)]
pub struct SnapshotResolver(pub Vec<Authorization>);
impl Resolver for SnapshotResolver {
    fn resolve(&self, agent: &AgentRef, now: u64) -> Result<Authorization> {
        let auth = self
            .0
            .iter()
            .find(|a| &a.agent == agent)
            .context("unauthorized: unknown Agent")?
            .clone();
        auth.validate(agent, now)?;
        Ok(auth)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub purpose: Vec<u8>,
    pub sender: AgentRef,
    pub recipient: AgentRef,
    #[serde(with = "decimal")]
    pub generation: u64,
    pub id: Vec<u8>,
    #[serde(deserialize_with = "required_option")]
    pub correlation: Option<Vec<u8>>,
    #[serde(with = "decimal")]
    pub created_ms: u64,
    #[serde(with = "decimal")]
    pub expires_ms: u64,
    pub kind: String,
    pub payload: Vec<u8>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct SignedEnvelope {
    pub message: Envelope,
    pub signature: Vec<u8>,
}
impl Envelope {
    pub fn validate(&self, now: u64) -> Result<()> {
        self.sender.validate()?;
        self.recipient.validate()?;
        ensure!(
            self.purpose == PURPOSE
                && self.id.len() == 32
                && self.correlation.as_ref().is_none_or(|id| id.len() == 32),
            "invalid_message: purpose or ID"
        );
        ensure!(
            !self.kind.is_empty()
                && self.kind.len() <= 128
                && self.kind.is_ascii()
                && self.payload.len() <= MAX_PAYLOAD,
            "invalid_message: kind or payload bounds"
        );
        ensure!(
            self.created_ms <= now
                && now < self.expires_ms
                && self.expires_ms > self.created_ms
                && self.expires_ms - self.created_ms <= MAX_LIFETIME_MS,
            "expired: invalid message lifetime"
        );
        Ok(())
    }
    pub fn signing_bytes(&self) -> Result<Vec<u8>> {
        Ok(bcs::to_bytes(self)?)
    }
    pub fn digest(&self) -> Result<Vec<u8>> {
        Ok(hash(&self.signing_bytes()?))
    }
    pub fn sign(self, key: &SecretKey) -> Result<SignedEnvelope> {
        let signature = key.sign(&self.signing_bytes()?).to_bytes().to_vec();
        Ok(SignedEnvelope {
            message: self,
            signature,
        })
    }
}
impl SignedEnvelope {
    pub fn verify(
        &self,
        auth: &Authorization,
        recipient: &AgentRef,
        actual_transport: &[u8],
        now: u64,
    ) -> Result<()> {
        self.message.validate(now)?;
        auth.validate(&self.message.sender, now)?;
        ensure!(
            &self.message.recipient == recipient
                && self.message.generation == auth.generation
                && auth.transport_key == actual_transport,
            "unauthorized: recipient, generation, or actual Iroh endpoint"
        );
        ensure!(
            self.signature.len() == 64,
            "invalid_message: signature length"
        );
        strict_point(&self.signature[..32])?;
        strict_point(&auth.transport_key)?.verify_strict(
            &self.message.signing_bytes()?,
            &Signature::from_slice(&self.signature)?,
        )?;
        Ok(())
    }
}

#[derive(Clone)]
pub struct Identity {
    pub agent: AgentRef,
    pub key: SecretKey,
}
impl Identity {
    pub fn sign<T: Serialize>(
        &self,
        recipient: &AgentRef,
        generation: u64,
        kind: &str,
        correlation: Option<Vec<u8>>,
        payload: &T,
        now: u64,
    ) -> Result<SignedEnvelope> {
        let message = Envelope {
            purpose: PURPOSE.to_vec(),
            sender: self.agent.clone(),
            recipient: recipient.clone(),
            generation,
            id: random_id(),
            correlation,
            created_ms: now,
            expires_ms: now
                .checked_add(MAX_LEASE_MS)
                .context("timestamp overflow")?,
            kind: kind.into(),
            payload: serde_json::to_vec(payload)?,
        };
        message.validate(now)?;
        message.sign(&self.key)
    }
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Features {
    pub required: Vec<String>,
    pub optional: Vec<String>,
}
fn valid_features(items: &[String]) -> bool {
    items.len() <= 16
        && items.windows(2).all(|w| w[0] < w[1])
        && items.iter().all(|s| {
            !s.is_empty()
                && s.len() <= 96
                && s.bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._/-".contains(&b))
        })
}
impl Features {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            valid_features(&self.required)
                && valid_features(&self.optional)
                && self.required.iter().all(|f| !self.optional.contains(f)),
            "invalid_message: feature lists"
        );
        Ok(())
    }
    pub fn select(&self, other: &Self) -> Result<Vec<String>> {
        self.validate()?;
        other.validate()?;
        let all = |f: &Features| {
            f.required
                .iter()
                .chain(&f.optional)
                .cloned()
                .collect::<std::collections::BTreeSet<_>>()
        };
        let selected: Vec<_> = all(self).intersection(&all(other)).cloned().collect();
        ensure!(
            self.required
                .iter()
                .chain(&other.required)
                .all(|f| selected.contains(f)),
            "unsupported_feature: mandatory feature not shared"
        );
        Ok(selected)
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Hello {
    pub challenge: Vec<u8>,
    pub required: Vec<String>,
    pub optional: Vec<String>,
}
impl Hello {
    pub fn features(&self) -> Features {
        Features {
            required: self.required.clone(),
            optional: self.optional.clone(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Welcome {
    pub hello_hash: Vec<u8>,
    pub challenge: Vec<u8>,
    pub required: Vec<String>,
    pub optional: Vec<String>,
    pub selected: Vec<String>,
}
impl Welcome {
    pub fn features(&self) -> Features {
        Features {
            required: self.required.clone(),
            optional: self.optional.clone(),
        }
    }
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SessionBody {
    pub session: Vec<u8>,
}
pub fn session_id(hello: &Envelope, welcome: &Envelope) -> Result<Vec<u8>> {
    Ok(hash(&bcs::to_bytes(&(
        b"m2m/core/session/v1".to_vec(),
        hello,
        welcome,
    ))?))
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct MessageBody {
    pub session: Vec<u8>,
    pub service: String,
    pub content_type: String,
    pub content: Vec<u8>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ExtensionBody {
    pub session: Vec<u8>,
    pub content: Vec<u8>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ServiceDescription {
    pub id: String,
    pub description: String,
    pub input_media_type: String,
    pub output_media_type: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct DescriptionBody {
    pub session: Vec<u8>,
    pub services: Vec<ServiceDescription>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DeliveryState {
    Accepted,
    Dispatching,
    Completed,
    Uncertain,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ReceiptBody {
    pub session: Vec<u8>,
    pub message_id: Vec<u8>,
    pub commitment: Vec<u8>,
    pub state: DeliveryState,
    #[serde(deserialize_with = "required_option")]
    pub result: Option<Vec<u8>>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ErrorCode {
    InvalidMessage,
    Unauthorized,
    StaleAuthority,
    UnsupportedFeature,
    MessageConflict,
    Expired,
    Overloaded,
    UnknownService,
    UncertainDispatch,
    StorageFailure,
    Internal,
}
#[derive(Debug)]
pub struct Failure {
    pub code: ErrorCode,
    pub detail: String,
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{:?}: {}", self.code, self.detail)
    }
}
impl std::error::Error for Failure {}
pub fn failure(code: ErrorCode, detail: &str) -> anyhow::Error {
    Failure {
        code,
        detail: detail.into(),
    }
    .into()
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ErrorBody {
    #[serde(deserialize_with = "required_option")]
    pub session: Option<Vec<u8>>,
    pub code: ErrorCode,
    pub detail: String,
}

pub fn logical_commitment(message: &Envelope) -> Result<Vec<u8>> {
    let logical = match message.kind.as_str() {
        "message.send" => {
            let b: MessageBody = parse(&message.payload)?;
            bcs::to_bytes(&(b.service, b.content_type, b.content))?
        }
        "agent.describe" => {
            let _: SessionBody = parse(&message.payload)?;
            Vec::new()
        }
        kind if kind.starts_with("extension.") => {
            let b: ExtensionBody = parse(&message.payload)?;
            bcs::to_bytes(&b.content)?
        }
        _ => bail!("invalid_message: kind has no durable request semantics"),
    };
    Ok(hash(&bcs::to_bytes(&(
        b"m2m/core/logical/v1".to_vec(),
        &message.sender,
        &message.recipient,
        &message.id,
        &message.correlation,
        message.created_ms,
        message.expires_ms,
        &message.kind,
        logical,
    ))?))
}

pub struct RequestContext<'a> {
    pub sender: &'a AgentRef,
    pub message_id: &'a [u8],
    pub content_type: &'a str,
}
pub trait ServiceHandler: Send + Sync {
    fn description(&self) -> ServiceDescription;
    fn execute(&self, context: &RequestContext<'_>, content: &[u8]) -> Result<Vec<u8>>;
}
pub trait ExtensionHandler: Send + Sync {
    fn feature(&self) -> &str;
    fn execute(&self, context: &RequestContext<'_>, content: &[u8]) -> Result<Vec<u8>>;
}
pub struct Echo;
pub struct Blake2;
fn description(id: &str, text: &str) -> ServiceDescription {
    ServiceDescription {
        id: id.into(),
        description: text.into(),
        input_media_type: "application/octet-stream".into(),
        output_media_type: "application/octet-stream".into(),
    }
}
impl ServiceHandler for Echo {
    fn description(&self) -> ServiceDescription {
        description("echo", "Return supplied bytes")
    }
    fn execute(&self, context: &RequestContext<'_>, content: &[u8]) -> Result<Vec<u8>> {
        ensure!(
            context.content_type == "application/octet-stream",
            "unsupported content type"
        );
        Ok(content.to_vec())
    }
}
impl ServiceHandler for Blake2 {
    fn description(&self) -> ServiceDescription {
        description("blake2b-256", "BLAKE2b-256 of supplied bytes")
    }
    fn execute(&self, context: &RequestContext<'_>, content: &[u8]) -> Result<Vec<u8>> {
        ensure!(
            context.content_type == "application/octet-stream",
            "unsupported content type"
        );
        Ok(hash(content))
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct InboxRecord {
    pub sender: AgentRef,
    pub id: Vec<u8>,
    pub commitment: Vec<u8>,
    pub state: DeliveryState,
    pub result: Option<Vec<u8>>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Journal {
    version: u8,
    owner: AgentRef,
    records: BTreeMap<String, InboxRecord>,
    outbox: BTreeMap<String, SignedEnvelope>,
}
/// Exclusive local writer. Never point two endpoints at independent journals for one Agent.
pub struct Inbox {
    store: crate::store::Store,
    journal: Journal,
    max_records: usize,
    max_bytes: usize,
    poisoned: bool,
}
impl Inbox {
    pub fn open(
        root: PathBuf,
        owner: AgentRef,
        max_records: usize,
        max_bytes: usize,
    ) -> Result<Self> {
        owner.validate()?;
        let store = crate::store::Store::open(root)?;
        if store.path("native-owner.json").exists() && !store.path("native-inbox.json").exists() {
            return Err(failure(
                ErrorCode::StorageFailure,
                "existing inbox disappeared; restore or reconcile",
            ));
        }
        if store.path("native-inbox.json").exists() {
            ensure!(
                std::fs::metadata(store.path("native-inbox.json"))?.len() <= max_bytes as u64,
                "overloaded: journal exceeds byte bound"
            );
        }
        let journal = if store.path("native-inbox.json").exists() {
            store.read::<Journal>("native-inbox.json")?
        } else {
            Journal {
                version: 1,
                owner: owner.clone(),
                records: BTreeMap::new(),
                outbox: BTreeMap::new(),
            }
        };
        ensure!(
            journal.version == 1 && journal.owner == owner,
            "storage_failure: journal version or Agent mismatch"
        );
        ensure!(
            journal.records.len() + journal.outbox.len() <= max_records
                && serde_json::to_vec_pretty(&journal)?.len() <= max_bytes,
            "overloaded: journal exceeds configured bounds"
        );
        for (key, r) in &journal.records {
            ensure!(
                key == &Self::key(&r.sender, &r.id)?
                    && r.id.len() == 32
                    && r.commitment.len() == 32
                    && r.result.as_ref().is_none_or(|r| r.len() <= MAX_PAYLOAD)
                    && (r.state == DeliveryState::Completed) == r.result.is_some(),
                "storage_failure: corrupt inbox record"
            );
        }
        if !store.path("native-owner.json").exists() {
            if !store.path("native-inbox.json").exists() {
                store.write("native-inbox.json", &journal)?;
            }
            store.write("native-owner.json", &owner)?;
        } else {
            ensure!(
                store.read::<AgentRef>("native-owner.json")? == owner,
                "storage_failure: owner marker mismatch"
            );
        }
        Ok(Self {
            store,
            journal,
            max_records,
            max_bytes,
            poisoned: false,
        })
    }
    fn key(sender: &AgentRef, id: &[u8]) -> Result<String> {
        Ok(hex::encode(hash(&bcs::to_bytes(&(sender, id))?)))
    }
    fn commit(&mut self, journal: Journal) -> Result<()> {
        if self.poisoned {
            return Err(failure(
                ErrorCode::StorageFailure,
                "prior write uncertain; reopen and reconcile",
            ));
        }
        if journal.records.len() + journal.outbox.len() > self.max_records
            || serde_json::to_vec_pretty(&journal)?.len() > self.max_bytes
        {
            return Err(failure(ErrorCode::Overloaded, "inbox capacity"));
        }
        if self.store.write("native-inbox.json", &journal).is_err() {
            self.poisoned = true;
            return Err(failure(
                ErrorCode::StorageFailure,
                "durable write outcome uncertain",
            ));
        }
        self.journal = journal;
        Ok(())
    }
    /// Storage boundary only: the caller must authenticate the signed envelope
    /// and its session first. `Services::serve_one` performs those checks.
    pub fn accept(&mut self, message: &Envelope, now: u64) -> Result<(InboxRecord, bool)> {
        ensure!(!self.poisoned, "storage_failure: journal poisoned");
        message.validate(now)?;
        ensure!(
            message.recipient == self.journal.owner,
            "unauthorized: wrong inbox Agent"
        );
        let key = Self::key(&message.sender, &message.id)?;
        let commitment = logical_commitment(message)?;
        if let Some(record) = self.journal.records.get(&key) {
            if record.commitment != commitment {
                return Err(failure(
                    ErrorCode::MessageConflict,
                    "existing ID has different logical content",
                ));
            }
            return Ok((record.clone(), false));
        }
        let record = InboxRecord {
            sender: message.sender.clone(),
            id: message.id.clone(),
            commitment,
            state: DeliveryState::Accepted,
            result: None,
        };
        let mut journal = self.journal.clone();
        journal.records.insert(key, record.clone());
        self.commit(journal)?;
        Ok((record, true))
    }
    pub fn dispatching(&mut self, sender: &AgentRef, id: &[u8]) -> Result<()> {
        self.transition(sender, id, DeliveryState::Dispatching, None)
    }
    pub fn complete(&mut self, sender: &AgentRef, id: &[u8], result: Vec<u8>) -> Result<()> {
        ensure!(result.len() <= MAX_PAYLOAD, "overloaded: result too large");
        self.transition(sender, id, DeliveryState::Completed, Some(result))
    }
    pub fn uncertain(&mut self, sender: &AgentRef, id: &[u8]) -> Result<()> {
        self.transition(sender, id, DeliveryState::Uncertain, None)
    }
    fn transition(
        &mut self,
        sender: &AgentRef,
        id: &[u8],
        state: DeliveryState,
        result: Option<Vec<u8>>,
    ) -> Result<()> {
        let mut journal = self.journal.clone();
        let record = journal
            .records
            .get_mut(&Self::key(sender, id)?)
            .context("storage_failure: missing accepted message")?;
        ensure!(
            (record.state == DeliveryState::Accepted && state == DeliveryState::Dispatching)
                || (record.state == DeliveryState::Dispatching
                    && matches!(state, DeliveryState::Completed | DeliveryState::Uncertain)),
            "storage_failure: invalid dispatch transition"
        );
        record.state = state;
        record.result = result;
        self.commit(journal)
    }
    pub fn get(&self, sender: &AgentRef, id: &[u8]) -> Result<Option<InboxRecord>> {
        Ok(self.journal.records.get(&Self::key(sender, id)?).cloned())
    }
    pub fn save_outbox(&mut self, message: &SignedEnvelope) -> Result<()> {
        ensure!(
            message.message.sender == self.journal.owner,
            "unauthorized: wrong outbox Agent"
        );
        let key = Self::key(&message.message.sender, &message.message.id)?;
        if let Some(saved) = self.journal.outbox.get(&key) {
            ensure!(
                logical_commitment(&saved.message)? == logical_commitment(&message.message)?,
                "message_conflict: outbox ID conflict"
            );
            return Ok(());
        }
        let mut journal = self.journal.clone();
        journal.outbox.insert(key, message.clone());
        self.commit(journal)
    }
    pub fn outbox(&self, id: &[u8]) -> Result<Option<SignedEnvelope>> {
        Ok(self
            .journal
            .outbox
            .get(&Self::key(&self.journal.owner, id)?)
            .cloned())
    }
}
