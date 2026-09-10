//! Canonical wire and signing types for the `sui.channel.v1` settlement method.
//!
//! The channel protocol deliberately keeps its application signatures separate from
//! Sui transaction signatures.  Statements are signed over their BCS representation,
//! while JSON is only the diagnostic/wire representation used by the PoC.

use crate::protocol::{self, Address, decimal};
use anyhow::{Result, ensure};
use iroh::EndpointAddr;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::ops::Deref;

pub const ALPN: &[u8] = b"m2m/payment/1";
pub const METHOD: &str = "sui.channel.v1";
pub const VERSION: u8 = 1;
pub const MAX_FILE: usize = 65_536;
pub const MAX_FRAME: usize = 1_048_576;

const OFFER_PURPOSE: &[u8] = b"m2m/channel/offer/v1";
const CREDIT_PURPOSE: &[u8] = b"m2m/channel/credit/v1";
const ACK_PURPOSE: &[u8] = b"m2m/channel/ack/v1";
const RESULT_PURPOSE: &[u8] = b"m2m/channel/result/v1";
const CLOSE_PURPOSE: &[u8] = b"m2m/channel/close/v1";
const TERMS_PURPOSE: &[u8] = b"m2m/channel/fixture-terms/v1";
const REQUEST_PURPOSE: &[u8] = b"m2m/channel/request/v1";
const TRANSCRIPT_START_PURPOSE: &[u8] = b"m2m/channel/transcript-start/v1";
const TRANSCRIPT_STEP_PURPOSE: &[u8] = b"m2m/channel/transcript-step/v1";
const ZERO: Address = Address::ZERO;

/// Deserializes only the normalized 0x-prefixed, 64-hex-digit address form.
///
/// sui-sdk-types intentionally accepts shortened addresses for convenient CLI
/// input.  Protocol JSON is persisted and signed across implementations, so the
/// channel wire rejects that convenient form at the boundary.
fn strict_address<'de, D>(deserializer: D) -> std::result::Result<Address, D::Error>
where
    D: serde::Deserializer<'de>,
{
    if deserializer.is_human_readable() {
        let text = String::deserialize(deserializer)?;
        if text.len() != 66
            || !text.starts_with("0x")
            || text[2..]
                .bytes()
                .any(|b| !b.is_ascii_hexdigit() || b.is_ascii_uppercase())
        {
            return Err(serde::de::Error::custom(
                "address must be normalized 0x followed by 64 lowercase hex digits",
            ));
        }
        text.parse::<Address>().map_err(serde::de::Error::custom)
    } else {
        Address::deserialize(deserializer)
    }
}

fn strict_endpoint_addr<'de, D>(deserializer: D) -> std::result::Result<EndpointAddr, D::Error>
where
    D: serde::Deserializer<'de>,
{
    if !deserializer.is_human_readable() {
        return EndpointAddr::deserialize(deserializer);
    }

    let value = Value::deserialize(deserializer)?;
    let object = value.as_object().ok_or_else(|| {
        serde::de::Error::custom("endpoint must be an object with exactly id and addrs")
    })?;
    if object.len() != 2 || !object.contains_key("id") || !object.contains_key("addrs") {
        return Err(serde::de::Error::custom(
            "endpoint has unknown or missing fields",
        ));
    }
    let addrs = object["addrs"]
        .as_array()
        .ok_or_else(|| serde::de::Error::custom("endpoint addrs must be an array"))?;
    for address in addrs {
        let address_object = address
            .as_object()
            .ok_or_else(|| serde::de::Error::custom("transport address must be a tagged object"))?;
        if address_object.len() != 1 {
            return Err(serde::de::Error::custom(
                "transport address has unknown or missing fields",
            ));
        }
        if let Some(custom) = address_object.get("Custom") {
            let custom_object = custom.as_object().ok_or_else(|| {
                serde::de::Error::custom("custom transport address must be an object")
            })?;
            if custom_object.len() != 2
                || !custom_object.contains_key("id")
                || !custom_object.contains_key("data")
            {
                return Err(serde::de::Error::custom(
                    "custom transport address has unknown or missing fields",
                ));
            }
        } else if !address_object.contains_key("Relay") && !address_object.contains_key("Ip") {
            return Err(serde::de::Error::custom(
                "unsupported transport address type",
            ));
        }
    }
    serde_json::from_value(value).map_err(serde::de::Error::custom)
}

fn valid_address(address: &Address, name: &str) -> Result<()> {
    ensure!(*address != ZERO, "{name} must not be the zero address");
    Ok(())
}

fn valid_hash(bytes: &[u8], name: &str) -> Result<()> {
    ensure!(bytes.len() == 32, "{name} must be exactly 32 bytes");
    Ok(())
}

// Mirrors the deliberately flat, canonical signed domain prefix.
#[allow(clippy::too_many_arguments)]
fn valid_prefix(
    purpose: &[u8],
    expected_purpose: &[u8],
    method: &[u8],
    version: u8,
    network: &[u8],
    package_id: &Address,
    deployment: &Address,
    buyer: &Address,
    provider: &Address,
) -> Result<()> {
    ensure!(purpose == expected_purpose, "wrong signing purpose");
    ensure!(method == METHOD.as_bytes(), "wrong channel method");
    ensure!(version == VERSION, "unsupported channel version");
    ensure!(
        !network.is_empty() && network.len() <= 64,
        "invalid network"
    );
    valid_address(package_id, "package_id")?;
    valid_address(deployment, "deployment")?;
    valid_address(buyer, "buyer")?;
    valid_address(provider, "provider")?;
    ensure!(buyer != provider, "buyer and provider must differ");
    Ok(())
}

fn valid_request_id(bytes: &[u8]) -> Result<()> {
    ensure!(
        !bytes.is_empty() && bytes.len() <= 64,
        "invalid request id length"
    );
    ensure!(
        bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')),
        "request id must use safe ASCII characters"
    );
    Ok(())
}

fn valid_phase(phase: &str) -> Result<()> {
    ensure!(
        matches!(phase, "active" | "frozen" | "closed" | "refunded"),
        "invalid session phase"
    );
    Ok(())
}

fn valid_error_code(code: &str) -> Result<()> {
    ensure!(
        matches!(
            code,
            "unsupported_version"
                | "unsupported_method"
                | "invalid_message"
                | "unauthorized"
                | "conflict"
                | "budget_exceeded"
                | "expired"
                | "frozen"
                | "terminal"
                | "chain_unavailable"
                | "internal"
        ),
        "invalid channel error code"
    );
    Ok(())
}

/// A signed channel opening offer.  The prefix is flat and its field order is
/// part of the BCS signing contract.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Offer {
    pub purpose: Vec<u8>,
    pub method: Vec<u8>,
    pub version: u8,
    pub network: Vec<u8>,
    #[serde(deserialize_with = "strict_address")]
    pub package_id: Address,
    #[serde(deserialize_with = "strict_address")]
    pub deployment: Address,
    #[serde(deserialize_with = "strict_address")]
    pub buyer: Address,
    #[serde(deserialize_with = "strict_address")]
    pub provider: Address,
    pub buyer_key: Vec<u8>,
    pub provider_key: Vec<u8>,
    #[serde(deserialize_with = "strict_address")]
    pub refund: Address,
    #[serde(deserialize_with = "strict_address")]
    pub payee: Address,
    pub opening_nonce: Vec<u8>,
    pub terms_hash: Vec<u8>,
    #[serde(with = "decimal")]
    pub deposit: u64,
    #[serde(with = "decimal")]
    pub offer_expires_ms: u64,
    #[serde(with = "decimal")]
    pub work_deadline_ms: u64,
    #[serde(with = "decimal")]
    pub claim_deadline_ms: u64,
}

impl Offer {
    pub fn validate(&self) -> Result<()> {
        valid_prefix(
            &self.purpose,
            OFFER_PURPOSE,
            &self.method,
            self.version,
            &self.network,
            &self.package_id,
            &self.deployment,
            &self.buyer,
            &self.provider,
        )?;
        ensure!(self.buyer_key.len() == 32, "invalid buyer endpoint key");
        ensure!(
            self.provider_key.len() == 32,
            "invalid provider endpoint key"
        );
        valid_address(&self.refund, "refund")?;
        valid_address(&self.payee, "payee")?;
        ensure!(self.opening_nonce.len() == 32, "invalid opening nonce");
        valid_hash(&self.terms_hash, "terms_hash")?;
        ensure!(self.deposit > 0, "deposit must be positive");
        ensure!(
            self.offer_expires_ms > 0
                && self.offer_expires_ms < self.work_deadline_ms
                && self.work_deadline_ms < self.claim_deadline_ms,
            "invalid channel deadlines"
        );
        ensure!(
            self.claim_deadline_ms - self.work_deadline_ms >= 10_000,
            "recovery grace must be at least 10000ms"
        );
        Ok(())
    }
}

/// A buyer-signed cumulative payment authorization.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Credit {
    pub purpose: Vec<u8>,
    pub method: Vec<u8>,
    pub version: u8,
    pub network: Vec<u8>,
    #[serde(deserialize_with = "strict_address")]
    pub package_id: Address,
    #[serde(deserialize_with = "strict_address")]
    pub deployment: Address,
    #[serde(deserialize_with = "strict_address")]
    pub buyer: Address,
    #[serde(deserialize_with = "strict_address")]
    pub provider: Address,
    #[serde(deserialize_with = "strict_address")]
    pub channel: Address,
    pub offer_hash: Vec<u8>,
    #[serde(with = "decimal")]
    pub sequence: u64,
    #[serde(with = "decimal")]
    pub cumulative_amount: u64,
    pub request_hash: Vec<u8>,
    pub previous_transcript_hash: Vec<u8>,
}

impl Credit {
    pub fn validate(&self) -> Result<()> {
        valid_prefix(
            &self.purpose,
            CREDIT_PURPOSE,
            &self.method,
            self.version,
            &self.network,
            &self.package_id,
            &self.deployment,
            &self.buyer,
            &self.provider,
        )?;
        valid_address(&self.channel, "channel")?;
        valid_hash(&self.offer_hash, "offer_hash")?;
        ensure!(self.sequence > 0, "credit sequence must be positive");
        ensure!(self.cumulative_amount > 0, "credit amount must be positive");
        valid_hash(&self.request_hash, "request_hash")?;
        valid_hash(&self.previous_transcript_hash, "previous_transcript_hash")?;
        Ok(())
    }
}

/// A provider-signed durable receipt for a credit.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Ack {
    pub purpose: Vec<u8>,
    pub method: Vec<u8>,
    pub version: u8,
    pub network: Vec<u8>,
    #[serde(deserialize_with = "strict_address")]
    pub package_id: Address,
    #[serde(deserialize_with = "strict_address")]
    pub deployment: Address,
    #[serde(deserialize_with = "strict_address")]
    pub buyer: Address,
    #[serde(deserialize_with = "strict_address")]
    pub provider: Address,
    #[serde(deserialize_with = "strict_address")]
    pub channel: Address,
    pub offer_hash: Vec<u8>,
    #[serde(with = "decimal")]
    pub sequence: u64,
    #[serde(with = "decimal")]
    pub cumulative_amount: u64,
    pub credit_hash: Vec<u8>,
}

impl Ack {
    pub fn validate(&self) -> Result<()> {
        valid_prefix(
            &self.purpose,
            ACK_PURPOSE,
            &self.method,
            self.version,
            &self.network,
            &self.package_id,
            &self.deployment,
            &self.buyer,
            &self.provider,
        )?;
        valid_address(&self.channel, "channel")?;
        valid_hash(&self.offer_hash, "offer_hash")?;
        ensure!(self.sequence > 0, "ack sequence must be positive");
        ensure!(self.cumulative_amount > 0, "ack amount must be positive");
        valid_hash(&self.credit_hash, "credit_hash")?;
        Ok(())
    }
}

/// A provider-signed statement binding fixture output to a request and credit.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ResultStatement {
    pub purpose: Vec<u8>,
    pub method: Vec<u8>,
    pub version: u8,
    pub network: Vec<u8>,
    #[serde(deserialize_with = "strict_address")]
    pub package_id: Address,
    #[serde(deserialize_with = "strict_address")]
    pub deployment: Address,
    #[serde(deserialize_with = "strict_address")]
    pub buyer: Address,
    #[serde(deserialize_with = "strict_address")]
    pub provider: Address,
    #[serde(deserialize_with = "strict_address")]
    pub channel: Address,
    pub offer_hash: Vec<u8>,
    pub request_hash: Vec<u8>,
    pub credit_hash: Vec<u8>,
    pub result_hash: Vec<u8>,
}

impl ResultStatement {
    pub fn validate(&self) -> Result<()> {
        valid_prefix(
            &self.purpose,
            RESULT_PURPOSE,
            &self.method,
            self.version,
            &self.network,
            &self.package_id,
            &self.deployment,
            &self.buyer,
            &self.provider,
        )?;
        valid_address(&self.channel, "channel")?;
        valid_hash(&self.offer_hash, "offer_hash")?;
        valid_hash(&self.request_hash, "request_hash")?;
        valid_hash(&self.credit_hash, "credit_hash")?;
        valid_hash(&self.result_hash, "result_hash")?;
        Ok(())
    }
}

/// A mutually signed final cumulative state.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Close {
    pub purpose: Vec<u8>,
    pub method: Vec<u8>,
    pub version: u8,
    pub network: Vec<u8>,
    #[serde(deserialize_with = "strict_address")]
    pub package_id: Address,
    #[serde(deserialize_with = "strict_address")]
    pub deployment: Address,
    #[serde(deserialize_with = "strict_address")]
    pub buyer: Address,
    #[serde(deserialize_with = "strict_address")]
    pub provider: Address,
    #[serde(deserialize_with = "strict_address")]
    pub channel: Address,
    pub offer_hash: Vec<u8>,
    #[serde(with = "decimal")]
    pub final_sequence: u64,
    #[serde(with = "decimal")]
    pub final_amount: u64,
    pub transcript_hash: Vec<u8>,
}

impl Close {
    pub fn validate(&self) -> Result<()> {
        valid_prefix(
            &self.purpose,
            CLOSE_PURPOSE,
            &self.method,
            self.version,
            &self.network,
            &self.package_id,
            &self.deployment,
            &self.buyer,
            &self.provider,
        )?;
        valid_address(&self.channel, "channel")?;
        valid_hash(&self.offer_hash, "offer_hash")?;
        valid_hash(&self.transcript_hash, "transcript_hash")?;
        ensure!(
            (self.final_sequence == 0) == (self.final_amount == 0),
            "close sequence and amount must be both zero or both positive"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct FixtureTerms {
    pub purpose: Vec<u8>,
    pub result_hash: Vec<u8>,
    #[serde(with = "decimal")]
    pub unit_price: u64,
    #[serde(with = "decimal")]
    pub max_jobs: u64,
    pub max_unfulfilled_jobs: u8,
}

impl FixtureTerms {
    pub fn validate(&self) -> Result<()> {
        ensure!(self.purpose == TERMS_PURPOSE, "wrong fixture terms purpose");
        valid_hash(&self.result_hash, "result_hash")?;
        ensure!(self.unit_price > 0, "unit price must be positive");
        ensure!(
            self.max_jobs > 0 && self.max_jobs <= 1000,
            "invalid max_jobs"
        );
        ensure!(
            self.max_unfulfilled_jobs == 1,
            "unsupported prepaid exposure"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RequestDescriptor {
    pub purpose: Vec<u8>,
    #[serde(deserialize_with = "strict_address")]
    pub channel: Address,
    pub terms_hash: Vec<u8>,
    pub request_id: Vec<u8>,
    #[serde(with = "decimal")]
    pub request_sequence: u64,
}

impl RequestDescriptor {
    pub fn validate(&self) -> Result<()> {
        ensure!(self.purpose == REQUEST_PURPOSE, "wrong request purpose");
        valid_address(&self.channel, "channel")?;
        valid_hash(&self.terms_hash, "terms_hash")?;
        valid_request_id(&self.request_id)?;
        ensure!(
            self.request_sequence > 0,
            "request sequence must be positive"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TranscriptStart {
    pub purpose: Vec<u8>,
    #[serde(deserialize_with = "strict_address")]
    pub channel: Address,
    pub offer_hash: Vec<u8>,
}

impl TranscriptStart {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.purpose == TRANSCRIPT_START_PURPOSE,
            "wrong transcript start purpose"
        );
        valid_address(&self.channel, "channel")?;
        valid_hash(&self.offer_hash, "offer_hash")?;
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TranscriptStep {
    pub purpose: Vec<u8>,
    pub previous_transcript_hash: Vec<u8>,
    pub request_hash: Vec<u8>,
    pub credit_hash: Vec<u8>,
    pub ack_hash: Vec<u8>,
    pub result_statement_hash: Vec<u8>,
}

impl TranscriptStep {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.purpose == TRANSCRIPT_STEP_PURPOSE,
            "wrong transcript step purpose"
        );
        valid_hash(&self.previous_transcript_hash, "previous_transcript_hash")?;
        valid_hash(&self.request_hash, "request_hash")?;
        valid_hash(&self.credit_hash, "credit_hash")?;
        valid_hash(&self.ack_hash, "ack_hash")?;
        valid_hash(&self.result_statement_hash, "result_statement_hash")?;
        Ok(())
    }
}

/// A generic signed statement.  The signature is always a raw 64-byte Ed25519
/// signature over the payload's canonical BCS bytes.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Signed<T> {
    pub payload: T,
    pub signature: Vec<u8>,
}

impl<T> Deref for Signed<T> {
    type Target = T;

    fn deref(&self) -> &Self::Target {
        &self.payload
    }
}

pub trait Validatable {
    fn validate(&self) -> Result<()>;
}

macro_rules! impl_validatable {
    ($($ty:ty),+ $(,)?) => {$ (
        impl Validatable for $ty {
            fn validate(&self) -> Result<()> { <$ty>::validate(self) }
        }
    )+ };
}

impl_validatable!(
    Offer,
    Credit,
    Ack,
    ResultStatement,
    Close,
    FixtureTerms,
    RequestDescriptor,
    TranscriptStart,
    TranscriptStep
);

impl<T: Validatable> Signed<T> {
    pub fn validate(&self) -> Result<()> {
        self.payload.validate()?;
        ensure!(
            self.signature.len() == 64,
            "signature must be exactly 64 bytes"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CloseCertificate {
    pub close: Close,
    pub buyer_signature: Vec<u8>,
    pub provider_signature: Vec<u8>,
}

impl CloseCertificate {
    pub fn validate(&self) -> Result<()> {
        self.close.validate()?;
        ensure!(
            self.buyer_signature.len() == 64 && self.provider_signature.len() == 64,
            "close signatures must be exactly 64 bytes"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Ticket {
    pub version: u8,
    pub method: String,
    #[serde(deserialize_with = "strict_address")]
    pub agent: Address,
    #[serde(deserialize_with = "strict_endpoint_addr")]
    pub endpoint: EndpointAddr,
}

impl Ticket {
    pub fn validate(&self) -> Result<()> {
        ensure!(self.version == VERSION, "unsupported ticket version");
        ensure!(self.method == METHOD, "unsupported ticket method");
        valid_address(&self.agent, "ticket agent")?;
        ensure!(
            !self.endpoint.id.as_bytes().iter().all(|byte| *byte == 0),
            "ticket endpoint id must not be zero"
        );
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum Message {
    #[serde(rename = "payment.offer_request")]
    OfferRequest {
        opening_nonce: Vec<u8>,
        result_hash: Vec<u8>,
        #[serde(with = "decimal")]
        jobs: u64,
        #[serde(with = "decimal")]
        max_unit_price: u64,
        #[serde(with = "decimal")]
        deposit: u64,
    },
    #[serde(rename = "payment.offer")]
    Offer {
        offer: Box<Signed<Offer>>,
        terms: FixtureTerms,
    },
    #[serde(rename = "session.resume")]
    Resume {},
    #[serde(rename = "session.ready")]
    Ready {
        phase: String,
        highest_credit: Option<Signed<Credit>>,
        #[serde(with = "decimal")]
        completed_jobs: u64,
        transcript_hash: Vec<u8>,
        certificate: Option<Box<CloseCertificate>>,
        #[serde(with = "decimal")]
        redeemed_amount: u64,
    },
    #[serde(rename = "payment.authorize")]
    Authorize {
        request: RequestDescriptor,
        credit: Signed<Credit>,
    },
    #[serde(rename = "payment.acknowledge")]
    Acknowledge { ack: Signed<Ack> },
    #[serde(rename = "work.get")]
    Get { request_hash: Vec<u8> },
    #[serde(rename = "work.result")]
    Result {
        result: Signed<ResultStatement>,
        bytes: Vec<u8>,
    },
    #[serde(rename = "payment.close")]
    Close { close: Signed<Close> },
    #[serde(rename = "payment.close_acknowledge")]
    CloseAcknowledge { certificate: Box<CloseCertificate> },
    #[serde(rename = "payment.settlement")]
    Settlement { digest: String },
    #[serde(rename = "error")]
    Error { code: String, message: String },
}

impl Message {
    pub fn validate(&self) -> Result<()> {
        match self {
            Self::OfferRequest {
                opening_nonce,
                result_hash,
                jobs,
                max_unit_price,
                deposit,
            } => {
                ensure!(opening_nonce.len() == 32, "invalid opening nonce");
                valid_hash(result_hash, "result_hash")?;
                ensure!(*jobs > 0 && *jobs <= 1000, "invalid requested jobs");
                ensure!(*max_unit_price > 0, "invalid maximum unit price");
                ensure!(*deposit > 0, "invalid requested deposit");
            }
            Self::Offer { offer, terms } => {
                offer.validate()?;
                terms.validate()?;
                ensure!(
                    offer.payload.terms_hash == terms_hash(terms)?,
                    "offer terms hash does not match terms"
                );
            }
            Self::Resume {} => {}
            Self::Ready {
                phase,
                highest_credit,
                completed_jobs,
                transcript_hash,
                certificate,
                ..
            } => {
                valid_phase(phase)?;
                if let Some(credit) = highest_credit {
                    credit.validate()?;
                }
                ensure!(*completed_jobs <= 1000, "invalid completed job count");
                valid_hash(transcript_hash, "transcript_hash")?;
                if let Some(certificate) = certificate {
                    certificate.validate()?;
                }
            }
            Self::Authorize { request, credit } => {
                request.validate()?;
                credit.validate()?;
                ensure!(
                    credit.payload.request_hash == request_hash(request)?,
                    "credit does not bind its request descriptor"
                );
            }
            Self::Acknowledge { ack } => ack.validate()?,
            Self::Get { request_hash } => valid_hash(request_hash, "request_hash")?,
            Self::Result { result, bytes } => {
                result.validate()?;
                ensure!(bytes.len() <= MAX_FILE, "result exceeds maximum file size");
            }
            Self::Close { close } => close.validate()?,
            Self::CloseAcknowledge { certificate } => certificate.validate()?,
            Self::Settlement { digest } => {
                ensure!(
                    !digest.is_empty() && digest.len() <= 1024,
                    "invalid settlement digest"
                );
            }
            Self::Error { code, message } => {
                valid_error_code(code)?;
                ensure!(
                    !message.is_empty() && message.len() <= 1024,
                    "invalid error message"
                );
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Envelope {
    pub version: u8,
    pub method: String,
    #[serde(deserialize_with = "strict_address")]
    pub buyer: Address,
    #[serde(deserialize_with = "strict_address")]
    pub provider: Address,
    #[serde(deserialize_with = "strict_address")]
    pub agreement_id: Address,
    pub request_id: String,
    pub message: Message,
}

impl Envelope {
    pub fn validate(&self) -> Result<()> {
        ensure!(self.version == VERSION, "unsupported envelope version");
        ensure!(self.method == METHOD, "unsupported envelope method");
        valid_address(&self.buyer, "envelope buyer")?;
        valid_address(&self.provider, "envelope provider")?;
        self.message.validate()?;

        let is_error = matches!(self.message, Message::Error { .. });
        let is_offer = matches!(
            self.message,
            Message::OfferRequest { .. } | Message::Offer { .. }
        );
        if !is_error {
            if is_offer {
                ensure!(
                    self.agreement_id == ZERO,
                    "offer messages have no channel id"
                );
                ensure!(
                    self.request_id.is_empty(),
                    "offer messages have no request id"
                );
            } else {
                ensure!(
                    self.agreement_id != ZERO,
                    "channel message needs an agreement id"
                );
            }
        }

        match &self.message {
            Message::Authorize { .. }
            | Message::Acknowledge { .. }
            | Message::Get { .. }
            | Message::Result { .. } => {
                valid_request_id(self.request_id.as_bytes())?;
            }
            Message::OfferRequest { .. }
            | Message::Offer { .. }
            | Message::Resume {}
            | Message::Ready { .. }
            | Message::Close { .. }
            | Message::CloseAcknowledge { .. }
            | Message::Settlement { .. } => {
                ensure!(
                    self.request_id.is_empty(),
                    "message must not have a request id"
                );
            }
            Message::Error { .. } => {
                if !self.request_id.is_empty() {
                    valid_request_id(self.request_id.as_bytes())?;
                }
            }
        }
        Ok(())
    }
}

fn bcs_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    Ok(bcs::to_bytes(value)?)
}

fn object_hash<T: Serialize + Validatable>(value: &T) -> Result<Vec<u8>> {
    value.validate()?;
    Ok(protocol::hash(&bcs_bytes(value)?))
}

pub fn terms_hash(value: &FixtureTerms) -> Result<Vec<u8>> {
    object_hash(value)
}

pub fn offer_hash(value: &Offer) -> Result<Vec<u8>> {
    object_hash(value)
}

pub fn request_hash(value: &RequestDescriptor) -> Result<Vec<u8>> {
    object_hash(value)
}

pub fn credit_hash(value: &Credit) -> Result<Vec<u8>> {
    object_hash(value)
}

pub fn ack_hash(value: &Ack) -> Result<Vec<u8>> {
    object_hash(value)
}

pub fn result_statement_hash(value: &ResultStatement) -> Result<Vec<u8>> {
    object_hash(value)
}

pub fn transcript_start(channel: Address, offer: &Offer) -> Result<Vec<u8>> {
    offer.validate()?;
    valid_address(&channel, "channel")?;
    let start = TranscriptStart {
        purpose: TRANSCRIPT_START_PURPOSE.to_vec(),
        channel,
        offer_hash: offer_hash(offer)?,
    };
    object_hash(&start)
}

pub fn transcript_next(
    previous: &[u8],
    request: &RequestDescriptor,
    credit: &Credit,
    ack: &Ack,
    result: &ResultStatement,
) -> Result<Vec<u8>> {
    valid_hash(previous, "previous transcript hash")?;
    request.validate()?;
    credit.validate()?;
    ack.validate()?;
    result.validate()?;
    let step = TranscriptStep {
        purpose: TRANSCRIPT_STEP_PURPOSE.to_vec(),
        previous_transcript_hash: previous.to_vec(),
        request_hash: request_hash(request)?,
        credit_hash: credit_hash(credit)?,
        ack_hash: ack_hash(ack)?,
        result_statement_hash: result_statement_hash(result)?,
    };
    object_hash(&step)
}

fn statement<T: Serialize>(payload: &T, signature: Option<&[u8]>) -> Result<Value> {
    let bytes = bcs_bytes(payload)?;
    let mut map = Map::new();
    map.insert("payload".to_string(), serde_json::to_value(payload)?);
    map.insert("bcs_hex".to_string(), Value::String(hex::encode(&bytes)));
    map.insert(
        "hash_hex".to_string(),
        Value::String(hex::encode(protocol::hash(&bytes))),
    );
    if let Some(signature) = signature {
        map.insert(
            "signature_hex".to_string(),
            Value::String(hex::encode(signature)),
        );
    }
    Ok(Value::Object(map))
}

fn public_address(byte: u8) -> Address {
    Address::new([byte; 32])
}

/// Returns the checked, public golden signing fixture used by the Rust and
/// TypeScript implementations.  The seeds are deliberately fixed test data and
/// must never be used as wallet keys.
pub fn signing_vectors() -> Result<Value> {
    let buyer_key = iroh::SecretKey::from_bytes(&[1; 32]);
    let provider_key = iroh::SecretKey::from_bytes(&[2; 32]);
    let package_id = public_address(3);
    let deployment = public_address(4);
    let buyer = public_address(5);
    let provider = public_address(6);
    let refund = public_address(7);
    let payee = public_address(8);
    let opening_nonce = vec![9; 32];
    let channel = public_address(10);
    let file = include_bytes!("../fixtures/hello.txt");

    let terms = FixtureTerms {
        purpose: TERMS_PURPOSE.to_vec(),
        result_hash: protocol::hash(file),
        unit_price: 1000,
        max_jobs: 10,
        max_unfulfilled_jobs: 1,
    };
    let terms_digest = terms_hash(&terms)?;
    let offer = Offer {
        purpose: OFFER_PURPOSE.to_vec(),
        method: METHOD.as_bytes().to_vec(),
        version: VERSION,
        network: b"test-vector".to_vec(),
        package_id,
        deployment,
        buyer,
        provider,
        buyer_key: buyer_key.public().as_bytes().to_vec(),
        provider_key: provider_key.public().as_bytes().to_vec(),
        refund,
        payee,
        opening_nonce,
        terms_hash: terms_digest,
        deposit: 12_000,
        offer_expires_ms: 1_800_000_060_000,
        work_deadline_ms: 1_800_000_300_000,
        claim_deadline_ms: 1_800_000_360_000,
    };
    let offer_digest = offer_hash(&offer)?;
    let request = RequestDescriptor {
        purpose: REQUEST_PURPOSE.to_vec(),
        channel,
        terms_hash: terms_hash(&terms)?,
        request_id: b"job-0001".to_vec(),
        request_sequence: 1,
    };
    let request_digest = request_hash(&request)?;
    let t0 = transcript_start(channel, &offer)?;
    let credit = Credit {
        purpose: CREDIT_PURPOSE.to_vec(),
        method: METHOD.as_bytes().to_vec(),
        version: VERSION,
        network: b"test-vector".to_vec(),
        package_id,
        deployment,
        buyer,
        provider,
        channel,
        offer_hash: offer_digest.clone(),
        sequence: 1,
        cumulative_amount: 1000,
        request_hash: request_digest.clone(),
        previous_transcript_hash: t0.clone(),
    };
    let credit_digest = credit_hash(&credit)?;
    let ack = Ack {
        purpose: ACK_PURPOSE.to_vec(),
        method: METHOD.as_bytes().to_vec(),
        version: VERSION,
        network: b"test-vector".to_vec(),
        package_id,
        deployment,
        buyer,
        provider,
        channel,
        offer_hash: offer_digest.clone(),
        sequence: 1,
        cumulative_amount: 1000,
        credit_hash: credit_digest.clone(),
    };
    let result = ResultStatement {
        purpose: RESULT_PURPOSE.to_vec(),
        method: METHOD.as_bytes().to_vec(),
        version: VERSION,
        network: b"test-vector".to_vec(),
        package_id,
        deployment,
        buyer,
        provider,
        channel,
        offer_hash: offer_digest,
        request_hash: request_digest,
        credit_hash: credit_digest,
        result_hash: terms.result_hash.clone(),
    };
    let result_digest = result_statement_hash(&result)?;
    let t1 = transcript_next(&t0, &request, &credit, &ack, &result)?;
    let close = Close {
        purpose: CLOSE_PURPOSE.to_vec(),
        method: METHOD.as_bytes().to_vec(),
        version: VERSION,
        network: b"test-vector".to_vec(),
        package_id,
        deployment,
        buyer,
        provider,
        channel,
        offer_hash: offer_hash(&offer)?,
        final_sequence: 1,
        final_amount: 1000,
        transcript_hash: t1.clone(),
    };

    let offer_signature = protocol::sign(&offer, &provider_key)?;
    let credit_signature = protocol::sign(&credit, &buyer_key)?;
    let ack_signature = protocol::sign(&ack, &provider_key)?;
    let result_signature = protocol::sign(&result, &provider_key)?;
    let close_buyer_signature = protocol::sign(&close, &buyer_key)?;
    let close_provider_signature = protocol::sign(&close, &provider_key)?;

    let mut statements = Map::new();
    statements.insert("terms".to_string(), statement(&terms, None)?);
    statements.insert("request".to_string(), statement(&request, None)?);
    statements.insert(
        "offer".to_string(),
        statement(&offer, Some(&offer_signature))?,
    );
    statements.insert(
        "credit".to_string(),
        statement(&credit, Some(&credit_signature))?,
    );
    statements.insert("ack".to_string(), statement(&ack, Some(&ack_signature))?);
    statements.insert(
        "result".to_string(),
        statement(&result, Some(&result_signature))?,
    );
    let mut close_statement = statement(&close, None)?.as_object().cloned().unwrap();
    close_statement.insert(
        "buyer_signature_hex".to_string(),
        Value::String(hex::encode(&close_buyer_signature)),
    );
    close_statement.insert(
        "provider_signature_hex".to_string(),
        Value::String(hex::encode(&close_provider_signature)),
    );
    statements.insert("close".to_string(), Value::Object(close_statement));
    let transcript_start_value = TranscriptStart {
        purpose: TRANSCRIPT_START_PURPOSE.to_vec(),
        channel,
        offer_hash: offer_hash(&offer)?,
    };
    let transcript_step_value = TranscriptStep {
        purpose: TRANSCRIPT_STEP_PURPOSE.to_vec(),
        previous_transcript_hash: t0.clone(),
        request_hash: request_hash(&request)?,
        credit_hash: credit_hash(&credit)?,
        ack_hash: ack_hash(&ack)?,
        result_statement_hash: result_digest,
    };
    statements.insert(
        "transcript_start".to_string(),
        statement(&transcript_start_value, None)?,
    );
    statements.insert(
        "transcript_step".to_string(),
        statement(&transcript_step_value, None)?,
    );

    Ok(json!({
        "version": VERSION,
        "method": METHOD,
        "keys": {
            "buyer_public_key": hex::encode(buyer_key.public().as_bytes()),
            "provider_public_key": hex::encode(provider_key.public().as_bytes()),
        },
        "statements": Value::Object(statements),
        "hashes": {
            "transcript_start": hex::encode(t0),
            "transcript_final": hex::encode(t1),
        },
    }))
}
