//! The input store: files a caller imported, kept by content.
//!
//! `import_part` copies the file a caller names into
//! `<app data>/inputs/<sha256>`, the lowercase hex SHA-256 of its bytes. A
//! revision's spec names the input by that hash, never by the caller's path,
//! so a later change to the caller's file cannot change a recorded build.
//! Storing the same bytes again reuses the stored file. Every read of a stored
//! input hashes it again, so a stored file that changed is never built.
//!
//! The bytes are data. Nothing here or in the kind that reads them runs them.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use super::revisions::Sha256Hex;

/// Most bytes one imported file may have: room for a binary STL at the
/// slicer's 1,000,000-triangle cap (about 48 MiB), and a 3MF of that mesh.
pub const MAX_INPUT_BYTES: u64 = 64 << 20;

#[derive(Debug, thiserror::Error)]
pub enum InputError {
    #[error("path must be absolute, got {0}")]
    RelativePath(PathBuf),
    #[error("{path} is not a regular file")]
    NotAFile { path: PathBuf },
    #[error("{path} is larger than {max} bytes")]
    TooLarge { path: PathBuf, max: u64 },
    #[error("{path} is empty")]
    Empty { path: PathBuf },
    #[error("cannot read {path}: {source}")]
    Read { path: PathBuf, source: io::Error },
    #[error("no stored input {0}")]
    Missing(Sha256Hex),
    #[error("stored input {expected} changed on disk (now {actual})")]
    Changed { expected: Sha256Hex, actual: Sha256Hex },
    #[error("cannot store the input: {0}")]
    Store(io::Error),
}

/// Content-addressed files under one directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputStore {
    root: PathBuf,
}

impl InputStore {
    /// The store in `root`, created on first write.
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    fn path_of(&self, sha256: &Sha256Hex) -> PathBuf {
        self.root.join(sha256.as_str())
    }

    /// Keeps `bytes` under their hash and returns it. Bytes already stored
    /// intact are not written again; a stored copy that changed is replaced.
    pub fn put(&self, bytes: &[u8]) -> Result<Sha256Hex, InputError> {
        let sha256 = Sha256Hex::of_bytes(bytes);
        let path = self.path_of(&sha256);
        match Sha256Hex::of_file(&path) {
            Ok(stored) if stored == sha256 => return Ok(sha256),
            Ok(_) => {}
            Err(err) if err.kind() == io::ErrorKind::NotFound => {}
            Err(err) => return Err(InputError::Store(err)),
        }
        fs::create_dir_all(&self.root).map_err(InputError::Store)?;
        let mut staged = tempfile::NamedTempFile::new_in(&self.root).map_err(InputError::Store)?;
        staged.write_all(bytes).map_err(InputError::Store)?;
        staged.as_file().sync_all().map_err(InputError::Store)?;
        let mut read_only = staged.as_file().metadata().map_err(InputError::Store)?.permissions();
        read_only.set_readonly(true);
        staged.as_file().set_permissions(read_only).map_err(InputError::Store)?;
        staged.persist(&path).map_err(|err| InputError::Store(err.error))?;
        Ok(sha256)
    }

    /// The stored bytes of `sha256`, hashed again on the way out.
    pub fn get(&self, sha256: &Sha256Hex) -> Result<Vec<u8>, InputError> {
        let path = self.path_of(sha256);
        let bytes = match read_capped(&path) {
            Err(InputError::Read { source, .. }) if source.kind() == io::ErrorKind::NotFound => {
                return Err(InputError::Missing(sha256.clone()))
            }
            other => other?,
        };
        let actual = Sha256Hex::of_bytes(&bytes);
        if &actual != sha256 {
            return Err(InputError::Changed { expected: sha256.clone(), actual });
        }
        Ok(bytes)
    }
}

/// The bytes of the file a caller named: an absolute path that opens as a
/// regular file of 1 to [`MAX_INPUT_BYTES`] bytes. On Unix it opens without
/// blocking, so a FIFO in the path's place is refused instead of waited on.
pub fn read_source(path: &Path) -> Result<Vec<u8>, InputError> {
    if !path.is_absolute() {
        return Err(InputError::RelativePath(path.to_path_buf()));
    }
    read_capped(path)
}

fn read_capped(path: &Path) -> Result<Vec<u8>, InputError> {
    let read_err = |source| InputError::Read { path: path.to_path_buf(), source };
    let file = open_nonblocking(path).map_err(read_err)?;
    let metadata = file.metadata().map_err(read_err)?;
    if !metadata.is_file() {
        return Err(InputError::NotAFile { path: path.to_path_buf() });
    }
    if metadata.len() > MAX_INPUT_BYTES {
        return Err(InputError::TooLarge { path: path.to_path_buf(), max: MAX_INPUT_BYTES });
    }
    // The file can grow after fstat, so the read is capped as well.
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_INPUT_BYTES + 1).read_to_end(&mut bytes).map_err(read_err)?;
    if bytes.len() as u64 > MAX_INPUT_BYTES {
        return Err(InputError::TooLarge { path: path.to_path_buf(), max: MAX_INPUT_BYTES });
    }
    if bytes.is_empty() {
        return Err(InputError::Empty { path: path.to_path_buf() });
    }
    Ok(bytes)
}

#[cfg(unix)]
fn open_nonblocking(path: &Path) -> io::Result<File> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::OpenOptions::new().read(true).custom_flags(libc::O_NONBLOCK).open(path)
}

#[cfg(not(unix))]
fn open_nonblocking(path: &Path) -> io::Result<File> {
    File::open(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_bytes_are_stored_once_under_their_hash_and_read_back_checked() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = InputStore::new(dir.path().join("inputs"));
        let sha = store.put(b"solid mesh").expect("put");
        assert_eq!(sha, Sha256Hex::of_bytes(b"solid mesh"));
        assert_eq!(store.put(b"solid mesh").expect("again"), sha);
        let names: Vec<_> = fs::read_dir(dir.path().join("inputs")).expect("dir").map(|e| e.expect("entry").file_name()).collect();
        assert_eq!(names, [std::ffi::OsString::from(sha.as_str())], "one file, named by its hash");
        assert_eq!(store.get(&sha).expect("get"), b"solid mesh");

        let path = dir.path().join("inputs").join(sha.as_str());
        let mut writable = fs::metadata(&path).expect("meta").permissions();
        assert!(writable.readonly(), "a stored input is read-only");
        #[allow(clippy::permissions_set_readonly_false)]
        writable.set_readonly(false);
        fs::set_permissions(&path, writable).expect("chmod");
        fs::write(&path, b"changed").expect("tamper");
        assert!(matches!(store.get(&sha), Err(InputError::Changed { .. })), "a changed input is not read");
        assert_eq!(store.put(b"solid mesh").expect("restore"), sha);
        assert_eq!(store.get(&sha).expect("restored"), b"solid mesh");
        assert!(matches!(store.get(&Sha256Hex::of_bytes(b"other")), Err(InputError::Missing(_))));
    }

    #[test]
    fn a_source_is_an_absolute_regular_file_within_the_cap() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert!(matches!(read_source(Path::new("relative.3mf")), Err(InputError::RelativePath(_))));
        assert!(matches!(read_source(dir.path()), Err(InputError::NotAFile { .. })));
        let empty = dir.path().join("empty.stl");
        fs::write(&empty, b"").expect("write");
        assert!(matches!(read_source(&empty), Err(InputError::Empty { .. })));
        let big = dir.path().join("big.stl");
        File::create(&big).expect("create").set_len(MAX_INPUT_BYTES + 1).expect("grow");
        assert!(matches!(read_source(&big), Err(InputError::TooLarge { max: MAX_INPUT_BYTES, .. })));
        let ok = dir.path().join("ok.stl");
        fs::write(&ok, b"solid x").expect("write");
        assert_eq!(read_source(&ok).expect("read"), b"solid x");
    }

    #[cfg(unix)]
    #[test]
    fn a_fifo_in_place_of_the_source_is_refused_without_blocking() {
        let dir = tempfile::tempdir().expect("tempdir");
        let fifo = dir.path().join("pipe.3mf");
        let c_path = std::ffi::CString::new(fifo.as_os_str().as_encoded_bytes()).expect("path");
        assert_eq!(unsafe { libc::mkfifo(c_path.as_ptr(), 0o600) }, 0, "mkfifo");
        let (sent, received) = std::sync::mpsc::channel();
        std::thread::spawn(move || sent.send(read_source(&fifo).map(|_| ())));
        let refused = received.recv_timeout(std::time::Duration::from_secs(5)).expect("did not block");
        assert!(matches!(refused, Err(InputError::NotAFile { .. })), "{refused:?}");
    }
}
