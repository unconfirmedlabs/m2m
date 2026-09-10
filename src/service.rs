//! Application boundary for the single immutable-artifact operation in this PoC.
use crate::protocol::{MAX_FILE, hash};
use anyhow::{Result, ensure};

pub trait ServiceHandler: Send + Sync {
    fn result_hash(&self) -> Vec<u8>;
    fn execute(&self) -> Result<Vec<u8>>;
}

pub struct FixedFile {
    bytes: Vec<u8>,
    hash: Vec<u8>,
}

impl FixedFile {
    pub fn new(bytes: Vec<u8>) -> Result<Self> {
        ensure!(bytes.len() <= MAX_FILE, "fixture exceeds 64 KiB");
        Ok(Self {
            hash: hash(&bytes),
            bytes,
        })
    }
}

impl ServiceHandler for FixedFile {
    fn result_hash(&self) -> Vec<u8> {
        self.hash.clone()
    }

    fn execute(&self) -> Result<Vec<u8>> {
        Ok(self.bytes.clone())
    }
}
