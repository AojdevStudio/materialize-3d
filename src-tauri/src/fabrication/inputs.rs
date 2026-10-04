//! The input store: files a caller imported, kept by content.
//!
//! `import_part` copies the file a caller names into
//! `<app data>/inputs/<sha256>`, the lowercase hex SHA-256 of its bytes. A
//! revision's spec names the input by that hash, never by the caller's path,
//! so a later change to the caller's file cannot change a recorded build.
//! Storing the same bytes again reuses the stored file. Every read of a stored
//! input hashes it again, so a stored file that changed is never built.
//!
//! The store is bounded: each file by [`MAX_INPUT_BYTES`], and the whole
//! store by the disk space its files take ([`MAX_STORE_BYTES`]) and by their
//! number ([`MAX_STORE_FILES`]). A file is stored before its build runs, so
//! a failed build keeps its input; the store caps are what keep any MCP
//! caller from filling the disk through `import_part`. One process-wide lock
//! serializes every write, from the size check through the rename, so
//! concurrent imports cannot pass the caps together.
//!
//! The bytes are data. Nothing here or in the kind that reads them runs them.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use super::revisions::Sha256Hex;

/// Most bytes one imported file may have. The binary STL at the slicer's
/// 1,000,000-triangle cap sets it: 84 + 50 bytes a triangle is 50,000,084
/// bytes (47.7 MiB). A 3MF of that same mesh is often larger, and above this
/// cap it is refused; a 3MF from Fusion of a printable part is far smaller.
pub const MAX_INPUT_BYTES: u64 = 64 << 20;

/// Most disk space the store's files may take: sixteen files at the
/// per-file cap, or hundreds of typical parts of a few MiB. Each file is
/// charged its allocated space ([`charge`]), not its length, so many tiny
/// files cannot hold more disk than this. A file that would pass it is
/// refused. Nothing evicts a stored input, because a revision's spec names
/// it and a revise rebuilds from it.
pub const MAX_STORE_BYTES: u64 = 1 << 30;
/// Most files the store may hold.
pub const MAX_STORE_FILES: usize = 10_000;
/// The block a file's space is rounded up to where the filesystem does not
/// say, and the least one file is charged.
const BLOCK: u64 = 4096;
/// What a file being written is named until its rename. Any such file found
/// while the store's lock is held was left by a crash.
const STAGED_PREFIX: &str = ".staged-";

/// Serializes every write to any input store in this process.
static STORE_LOCK: Mutex<()> = Mutex::new(());

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
    #[error("the input store at {root} takes {held} bytes of disk; this file would take it past its {max}-byte cap")]
    StoreFull { root: PathBuf, held: u64, max: u64 },
    #[error("the input store at {root} holds {max} files, its most")]
    TooManyFiles { root: PathBuf, max: usize },
}

/// Content-addressed files under one directory.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InputStore {
    root: PathBuf,
    max_bytes: u64,
    max_files: usize,
}

/// What the store's files take now.
struct Usage {
    bytes: u64,
    files: usize,
}

/// The disk space `metadata`'s file is charged: its allocated space, and at
/// least its length rounded up to [`BLOCK`]. A sparse file is charged its
/// length, and a file a filesystem stores inline still a whole block.
fn charge(metadata: &fs::Metadata) -> u64 {
    #[cfg(unix)]
    let allocated = std::os::unix::fs::MetadataExt::blocks(metadata).saturating_mul(512);
    #[cfg(not(unix))]
    let allocated = 0;
    allocated.max(metadata.len().div_ceil(BLOCK).saturating_mul(BLOCK))
}

impl InputStore {
    /// The store in `root`, created on first write.
    pub fn new(root: PathBuf) -> Self {
        Self { root, max_bytes: MAX_STORE_BYTES, max_files: MAX_STORE_FILES }
    }

    /// The store in `root` with smaller caps, so a test can reach them.
    #[cfg(test)]
    fn with_caps(root: PathBuf, max_bytes: u64, max_files: usize) -> Self {
        Self { root, max_bytes, max_files }
    }

    fn path_of(&self, sha256: &Sha256Hex) -> PathBuf {
        self.root.join(sha256.as_str())
    }

    /// Keeps `bytes` under their hash and returns it. Bytes already stored
    /// intact are not written again; a stored copy that changed is replaced.
    /// New bytes are refused when they would take the store past
    /// `max_bytes` of disk, charged as the growth (a replaced file's space
    /// is credited), or past `max_files` files. The store's lock is held
    /// from the check through the rename.
    pub fn put(&self, bytes: &[u8]) -> Result<Sha256Hex, InputError> {
        let sha256 = Sha256Hex::of_bytes(bytes);
        let path = self.path_of(&sha256);
        let _writing = STORE_LOCK.lock().unwrap_or_else(PoisonError::into_inner);
        let replaced = match Sha256Hex::of_file(&path) {
            Ok(stored) if stored == sha256 => return Ok(sha256),
            Ok(_) => fs::metadata(&path).map(|m| charge(&m)).map_err(InputError::Store)?,
            Err(err) if err.kind() == io::ErrorKind::NotFound => 0,
            Err(err) => return Err(InputError::Store(err)),
        };
        fs::create_dir_all(&self.root).map_err(InputError::Store)?;
        let usage = self.usage()?;
        let new = (bytes.len() as u64).div_ceil(BLOCK).saturating_mul(BLOCK);
        if usage.bytes.saturating_sub(replaced).saturating_add(new) > self.max_bytes {
            return Err(InputError::StoreFull { root: self.root.clone(), held: usage.bytes, max: self.max_bytes });
        }
        if replaced == 0 && usage.files >= self.max_files {
            return Err(InputError::TooManyFiles { root: self.root.clone(), max: self.max_files });
        }
        let mut staged = tempfile::Builder::new().prefix(STAGED_PREFIX).tempfile_in(&self.root).map_err(InputError::Store)?;
        staged.write_all(bytes).map_err(InputError::Store)?;
        staged.as_file().sync_all().map_err(InputError::Store)?;
        let mut read_only = staged.as_file().metadata().map_err(InputError::Store)?.permissions();
        read_only.set_readonly(true);
        staged.as_file().set_permissions(read_only).map_err(InputError::Store)?;
        staged.persist(&path).map_err(|err| InputError::Store(err.error))?;
        Ok(sha256)
    }

    /// The space and count of the stored files. Called with the store's lock
    /// held, so a staged file it finds was left by a crash and is removed. An
    /// entry that is gone before it is read is skipped.
    fn usage(&self) -> Result<Usage, InputError> {
        let mut usage = Usage { bytes: 0, files: 0 };
        for entry in fs::read_dir(&self.root).map_err(InputError::Store)? {
            let entry = entry.map_err(InputError::Store)?;
            if entry.file_name().to_string_lossy().starts_with(STAGED_PREFIX) {
                match fs::remove_file(entry.path()) {
                    Err(err) if err.kind() != io::ErrorKind::NotFound => return Err(InputError::Store(err)),
                    _ => continue,
                }
            }
            let metadata = match entry.metadata() {
                Ok(metadata) => metadata,
                Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
                Err(err) => return Err(InputError::Store(err)),
            };
            if metadata.is_file() {
                usage.bytes = usage.bytes.saturating_add(charge(&metadata));
                usage.files += 1;
            }
        }
        Ok(usage)
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

    /// Every file is charged at least a whole block of disk, so tiny files
    /// reach the space cap long before their lengths add up to it; the count
    /// cap refuses one file more; and bytes already stored are still reused.
    #[test]
    fn the_store_charges_disk_space_and_caps_the_file_count() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = InputStore::with_caps(dir.path().join("inputs"), 8 * BLOCK, MAX_STORE_FILES);
        let mut kept = Vec::new();
        let refused = loop {
            match store.put(format!("tiny mesh {}", kept.len()).as_bytes()) {
                Ok(sha) => kept.push(sha),
                Err(err) => break err,
            }
            assert!(kept.len() <= 8, "{} tiny files passed a cap of 8 blocks", kept.len());
        };
        assert!(matches!(refused, InputError::StoreFull { .. }), "{refused:?}");
        assert!(!kept.is_empty() && kept.len() <= 8, "{} files, about {} bytes long in all", kept.len(), 12 * kept.len());
        assert_eq!(store.put(b"tiny mesh 0").expect("reused"), kept[0], "stored bytes are reused at the cap");

        let counted = InputStore::with_caps(dir.path().join("counted"), MAX_STORE_BYTES, 3);
        for i in 0..3 {
            counted.put(format!("mesh {i}").as_bytes()).expect("within the count");
        }
        assert!(matches!(counted.put(b"mesh 3"), Err(InputError::TooManyFiles { max: 3, .. })));
        counted.put(b"mesh 0").expect("a stored file is reused at the count cap");
    }

    /// Repairing a stored input that changed is charged its growth only, so
    /// it succeeds at the cap.
    #[test]
    fn replacing_a_changed_input_at_the_cap_is_charged_only_its_growth() {
        let dir = tempfile::tempdir().expect("tempdir");
        let store = InputStore::with_caps(dir.path().join("inputs"), 2 * BLOCK, 2);
        let sha = store.put(b"first mesh").expect("first");
        store.put(b"second mesh").expect("second, now at the cap");
        let path = dir.path().join("inputs").join(sha.as_str());
        let mut writable = fs::metadata(&path).expect("meta").permissions();
        #[allow(clippy::permissions_set_readonly_false)]
        writable.set_readonly(false);
        fs::set_permissions(&path, writable).expect("chmod");
        fs::write(&path, b"changed!!!").expect("tamper");
        assert_eq!(store.put(b"first mesh").expect("repair at the cap"), sha);
        assert_eq!(store.get(&sha).expect("repaired"), b"first mesh");
    }

    /// Writes are serialized from the check through the rename: concurrent
    /// puts never fail on a file renamed under the scan, never pass the cap
    /// together, and a staged file a crash left behind is removed.
    #[test]
    fn concurrent_puts_never_pass_the_cap_or_trip_over_each_other() {
        let dir = tempfile::tempdir().expect("tempdir");
        let root = dir.path().join("inputs");
        fs::create_dir_all(&root).expect("dir");
        fs::write(root.join(format!("{STAGED_PREFIX}crashed")), vec![0u8; 3 * BLOCK as usize]).expect("left by a crash");
        let store = InputStore::with_caps(root.clone(), 10 * BLOCK, MAX_STORE_FILES);
        let start = std::sync::Arc::new(std::sync::Barrier::new(64));
        let results: Vec<Result<Sha256Hex, InputError>> = std::thread::scope(|scope| {
            let threads: Vec<_> = (0..64)
                .map(|i| {
                    let (store, start) = (store.clone(), start.clone());
                    scope.spawn(move || {
                        start.wait();
                        store.put(format!("concurrent mesh {i}").as_bytes())
                    })
                })
                .collect();
            threads.into_iter().map(|t| t.join().expect("thread")).collect()
        });
        let stored = results.iter().filter(|r| r.is_ok()).count();
        let others: Vec<_> = results.iter().filter_map(|r| r.as_ref().err()).filter(|e| !matches!(e, InputError::StoreFull { .. })).collect();
        assert!(others.is_empty(), "{others:?}");
        assert_eq!(stored, 10, "exactly the cap's worth is stored");
        assert!(!root.join(format!("{STAGED_PREFIX}crashed")).exists(), "the crashed staged file is gone");
        assert!(store.usage().expect("usage").bytes <= 10 * BLOCK);
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
