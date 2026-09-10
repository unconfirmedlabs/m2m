use anyhow::{Result, ensure};
use blake2::{Blake2b, Digest, digest::consts::U32};
use ed25519_dalek::{Signature, VerifyingKey};
use iroh::SecretKey;
use serde::{Deserialize, Serialize};
pub use sui_sdk_types::Address;

pub const ALPN: &[u8] = b"m2m/fixture/1";
pub const MAX_FILE: usize = 65_536;
pub const MAX_FRAME: usize = 1_048_576;
pub const VERSION: u8 = 1;

/// BCS u64; exact decimal strings in human-readable JSON (no JS float rounding).
pub mod decimal {
    use serde::{Deserialize, Deserializer, Serializer, de::Error};
    pub fn serialize<S: Serializer>(n: &u64, s: S) -> Result<S::Ok, S::Error> {
        if s.is_human_readable() {
            s.serialize_str(&n.to_string())
        } else {
            s.serialize_u64(*n)
        }
    }
    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<u64, D::Error> {
        if d.is_human_readable() {
            let s = String::deserialize(d)?;
            let n: u64 = s.parse().map_err(D::Error::custom)?;
            if n.to_string() != s {
                return Err(D::Error::custom("noncanonical decimal u64"));
            }
            Ok(n)
        } else {
            u64::deserialize(d)
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Quote {
    pub purpose: Vec<u8>,
    pub network: Vec<u8>,
    pub package_id: Address,
    pub deployment: Address,
    pub buyer: Address,
    pub provider: Address,
    pub buyer_key: Vec<u8>,
    pub provider_key: Vec<u8>,
    pub refund: Address,
    pub payee: Address,
    #[serde(with = "decimal")]
    pub nonce: u64,
    pub request_hash: Vec<u8>,
    pub result_hash: Vec<u8>,
    #[serde(with = "decimal")]
    pub amount: u64,
    #[serde(with = "decimal")]
    pub quote_expires_ms: u64,
    #[serde(with = "decimal")]
    pub deadline_ms: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Acceptance {
    pub purpose: Vec<u8>,
    pub network: Vec<u8>,
    pub package_id: Address,
    pub deployment: Address,
    pub escrow: Address,
    pub quote_hash: Vec<u8>,
    pub result_hash: Vec<u8>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignedQuote {
    pub quote: Quote,
    pub signature: Vec<u8>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SignedAcceptance {
    pub acceptance: Acceptance,
    pub signature: Vec<u8>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "method", rename_all = "snake_case", deny_unknown_fields)]
pub enum Request {
    Quote {
        version: u8,
        buyer: Address,
        #[serde(with = "decimal")]
        nonce: u64,
        result_hash: Vec<u8>,
    },
    Deliver {
        version: u8,
        escrow: Address,
    },
    Accept {
        version: u8,
        receipt: SignedAcceptance,
    },
}
impl Request {
    pub fn validate(&self) -> Result<()> {
        let version = match self {
            Self::Quote { version, .. }
            | Self::Deliver { version, .. }
            | Self::Accept { version, .. } => version,
        };
        ensure!(*version == VERSION, "unsupported protocol version");
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Response {
    Quote { signed: Box<SignedQuote> },
    Result { escrow: Address, bytes: Vec<u8> },
    Settled { escrow: Address, digest: String },
    Error { code: String, message: String },
}

pub fn hash(data: &[u8]) -> Vec<u8> {
    Blake2b::<U32>::digest(data).to_vec()
}
pub fn request_hash(result_hash: &[u8]) -> Vec<u8> {
    let mut bytes = b"m2m/fixture.get/v1\0".to_vec();
    bytes.extend_from_slice(result_hash);
    hash(&bytes)
}
pub fn sign<T: Serialize>(value: &T, key: &SecretKey) -> Result<Vec<u8>> {
    Ok(key.sign(&bcs::to_bytes(value)?).to_bytes().to_vec())
}
pub fn verify<T: Serialize>(value: &T, signature: &[u8], public_key: &[u8]) -> Result<()> {
    let pk: &[u8; 32] = public_key.try_into()?;
    VerifyingKey::from_bytes(pk)?
        .verify_strict(&bcs::to_bytes(value)?, &Signature::from_slice(signature)?)?;
    Ok(())
}
impl Quote {
    pub fn validate(&self) -> Result<()> {
        ensure!(self.purpose == b"m2m/quote/v1", "wrong quote purpose");
        ensure!(
            !self.network.is_empty() && self.network.len() <= 64,
            "invalid network"
        );
        ensure!(
            self.buyer_key.len() == 32 && self.provider_key.len() == 32,
            "invalid endpoint key"
        );
        ensure!(
            self.result_hash.len() == 32 && self.request_hash == request_hash(&self.result_hash),
            "invalid fixture commitment"
        );
        ensure!(self.amount > 0, "zero price");
        ensure!(self.quote_expires_ms < self.deadline_ms, "invalid deadline");
        Ok(())
    }
    pub fn acceptance(&self, escrow: Address) -> Result<Acceptance> {
        Ok(Acceptance {
            purpose: b"m2m/accept/v1".to_vec(),
            network: self.network.clone(),
            package_id: self.package_id,
            deployment: self.deployment,
            escrow,
            quote_hash: hash(&bcs::to_bytes(self)?),
            result_hash: self.result_hash.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn output_length_is_part_of_blake2() {
        assert_eq!(
            hex::encode(hash(b"")),
            "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8"
        );
    }
    #[test]
    fn unknown_fields_and_versions_fail() {
        assert!(
            serde_json::from_str::<Request>(
                r#"{"method":"deliver","version":1,"escrow":"0x1","spend_more":true}"#
            )
            .is_err()
        );
        assert!(
            Request::Deliver {
                version: 2,
                escrow: Address::ZERO
            }
            .validate()
            .is_err()
        );
    }
    #[test]
    fn purpose_prevents_signature_reuse() {
        let key = SecretKey::from_bytes(&[7; 32]);
        let mut a = Acceptance {
            purpose: b"m2m/accept/v1".to_vec(),
            network: b"test".to_vec(),
            package_id: Address::ZERO,
            deployment: Address::ZERO,
            escrow: Address::ZERO,
            quote_hash: vec![0; 32],
            result_hash: vec![1; 32],
        };
        let sig = sign(&a, &key).unwrap();
        verify(&a, &sig, key.public().as_bytes()).unwrap();
        a.purpose = b"m2m/quote/v1".to_vec();
        assert!(verify(&a, &sig, key.public().as_bytes()).is_err());
    }
}
