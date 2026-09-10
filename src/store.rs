use anyhow::{Context, Result};
use fs2::FileExt;
use serde::{Serialize, de::DeserializeOwned};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

pub fn private_dir(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

/// Hold for the complete command/server lifetime. Never share mutable state dirs.
pub struct Store {
    pub root: PathBuf,
    _lock: File,
}
impl Store {
    pub fn open(root: PathBuf) -> Result<Self> {
        private_dir(&root)?;
        let mut opts = OpenOptions::new();
        opts.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)]
        opts.mode(0o600);
        let lock = opts.open(root.join(".lock"))?;
        lock.try_lock_exclusive()
            .context("state directory is already in use")?;
        Ok(Self { root, _lock: lock })
    }
    pub fn path(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
    pub fn read<T: DeserializeOwned>(&self, name: &str) -> Result<T> {
        read(&self.path(name))
    }
    pub fn write<T: Serialize>(&self, name: &str, value: &T) -> Result<()> {
        write(&self.path(name), value)
    }
}
pub fn read<T: DeserializeOwned>(path: &Path) -> Result<T> {
    Ok(serde_json::from_slice(
        &fs::read(path).with_context(|| format!("read {}", path.display()))?,
    )?)
}
pub fn write<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let parent = path.parent().context("missing parent directory")?;
    private_dir(parent)?;
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    opts.mode(0o600);
    let mut file = opts.open(&tmp)?;
    file.write_all(&serde_json::to_vec_pretty(value)?)?;
    file.sync_all()?;
    fs::rename(&tmp, path)?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn lock_and_durable_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path().to_owned()).unwrap();
        assert!(Store::open(dir.path().to_owned()).is_err());
        store.write("job.json", &vec![1, 2, 3]).unwrap();
        assert_eq!(store.read::<Vec<u8>>("job.json").unwrap(), vec![1, 2, 3]);
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(store.path("job.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
