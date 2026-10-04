//! The runtime image the helper boots and the digests it must match.
//!
//! The pins are compiled in from `cad-runtime/pins-arm64.json`, the file `cad-runtime/reproduce.sh` checks every
//! clean image build against. So a helper boots only the image its own commit's pinned inputs build, and nothing
//! next to the image (a `pins.json` included) can vouch for a different one.

use std::collections::BTreeMap;
use std::fmt;
use std::io;
use std::path::Path;
use std::sync::OnceLock;

use serde::{Deserialize, Deserializer};
use sha2::{Digest, Sha256};

/// The arm64 pins, exactly as committed; `materialize-cad-host pins` prints them.
pub const PINS_JSON: &str = include_str!("../../cad-runtime/pins-arm64.json");

/// What a release bundles under `Contents/Resources/cad-runtime/`: the kernel, the read-only root, and the job disk
/// template. Every build and inspection boots exactly these.
pub const SHIPPED: [&str; 3] = ["Image", "rootfs.img", "job.img"];

/// The restriction tests' stand-in for a compromised inspection guest. Pinned like the rest, never bundled.
pub const HOSTILE_INITRAMFS: &str = "hostile-initramfs.cpio";

/// A SHA-256 digest, parsed from the 64 lowercase hex digits the pins file uses.
#[derive(Clone, Copy, PartialEq, Eq)]
pub struct Sha256Digest([u8; 32]);

impl Sha256Digest {
    fn parse_hex(hex: &str) -> Option<Self> {
        let (pairs, []) = hex.as_bytes().as_chunks::<2>() else {
            return None;
        };
        if pairs.len() != 32 {
            return None;
        }
        let nibble = |c: u8| match c {
            b'0'..=b'9' => Some(c - b'0'),
            b'a'..=b'f' => Some(c - b'a' + 10),
            _ => None,
        };
        let mut out = [0; 32];
        for (byte, &[high, low]) in out.iter_mut().zip(pairs) {
            *byte = nibble(high)? << 4 | nibble(low)?;
        }
        Some(Self(out))
    }
}

impl fmt::Display for Sha256Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.iter().try_for_each(|b| write!(f, "{b:02x}"))
    }
}

impl fmt::Debug for Sha256Digest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

impl<'de> Deserialize<'de> for Sha256Digest {
    fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let hex = String::deserialize(d)?;
        Self::parse_hex(&hex).ok_or_else(|| {
            serde::de::Error::custom(format!("{hex:?} is not 64 lowercase hex digits"))
        })
    }
}

#[derive(Debug, Deserialize)]
pub struct FilePin {
    pub sha256: Sha256Digest,
    pub bytes: u64,
}

/// One architecture's pinned runtime files. Other fields of the pins file (sizes installed, inputs) are records
/// for people and are not checked here.
#[derive(Debug, Deserialize)]
pub struct Pins {
    pub arch: String,
    pub files: BTreeMap<String, FilePin>,
}

#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    #[error("{name} is not pinned in this helper")]
    NotPinned { name: String },
    #[error("{name}: {source}")]
    Unreadable { name: String, source: io::Error },
    #[error("{name}: {got} bytes, the pin says {want}")]
    Size { name: String, got: u64, want: u64 },
    #[error("{name}: sha256 {got} does not match the pin {want}")]
    Digest {
        name: String,
        got: Sha256Digest,
        want: Sha256Digest,
    },
}

impl Pins {
    pub fn parse(json: &str) -> Result<Self, serde_json::Error> {
        serde_json::from_str(json)
    }

    /// The pins compiled into this binary. `the_compiled_pins_cover_the_shipped_runtime` proves they parse.
    pub fn compiled() -> &'static Self {
        static PINS: OnceLock<Pins> = OnceLock::new();
        PINS.get_or_init(|| Self::parse(PINS_JSON).expect("the compiled-in pins parse"))
    }

    /// Checks each named file in `dir` against its pin, size first and then the full SHA-256. The first file that
    /// is unpinned, unreadable, resized, or changed refuses the whole runtime.
    pub fn verify(&self, dir: &Path, names: &[&str]) -> Result<(), RuntimeError> {
        for &name in names {
            let pin = self
                .files
                .get(name)
                .ok_or_else(|| RuntimeError::NotPinned { name: name.into() })?;
            let unreadable = |source| RuntimeError::Unreadable {
                name: name.into(),
                source,
            };
            let mut file = std::fs::File::open(dir.join(name)).map_err(unreadable)?;
            let got = file.metadata().map_err(unreadable)?.len();
            if got != pin.bytes {
                return Err(RuntimeError::Size {
                    name: name.into(),
                    got,
                    want: pin.bytes,
                });
            }
            let mut hasher = Sha256::new();
            io::copy(&mut file, &mut hasher).map_err(unreadable)?;
            let got = Sha256Digest(hasher.finalize().into());
            if got != pin.sha256 {
                return Err(RuntimeError::Digest {
                    name: name.into(),
                    got,
                    want: pin.sha256,
                });
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A fresh directory holding `files`, and pins that match them exactly.
    fn runtime(test: &str, files: &[(&str, &[u8])]) -> (PathBuf, Pins) {
        let dir =
            std::env::temp_dir().join(format!("cad-host-runtime-{}-{test}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut pins = serde_json::Map::new();
        for (name, data) in files {
            std::fs::write(dir.join(name), data).unwrap();
            let sha256 = Sha256Digest(Sha256::digest(data).into()).to_string();
            pins.insert(
                (*name).into(),
                serde_json::json!({ "sha256": sha256, "bytes": data.len() }),
            );
        }
        let json = serde_json::json!({ "arch": "arm64", "files": pins }).to_string();
        (dir, Pins::parse(&json).unwrap())
    }

    #[test]
    fn a_runtime_that_matches_its_pins_verifies() {
        let (dir, pins) = runtime("match", &[("Image", b"kernel"), ("rootfs.img", b"root")]);
        pins.verify(&dir, &["Image", "rootfs.img"]).unwrap();
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_image_whose_digest_differs_from_its_pin_is_refused() {
        let (dir, pins) = runtime("tampered", &[("Image", b"kernel"), ("rootfs.img", b"root")]);
        // Same size, one byte changed: only the digest can catch it.
        std::fs::write(dir.join("rootfs.img"), b"ROOT").unwrap();
        let err = pins.verify(&dir, &["Image", "rootfs.img"]).unwrap_err();
        let RuntimeError::Digest { name, got, want } = &err else {
            panic!("expected a digest mismatch, got {err}");
        };
        assert_eq!(name, "rootfs.img");
        assert_eq!(*want, pins.files["rootfs.img"].sha256);
        assert_ne!(got, want);
        assert!(err.to_string().contains("does not match the pin"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_missing_resized_or_unpinned_file_is_refused() {
        let (dir, pins) = runtime("absent", &[("Image", b"kernel"), ("job.img", b"job")]);
        std::fs::write(dir.join("job.img"), b"job disk").unwrap();
        assert!(matches!(
            pins.verify(&dir, &["job.img"]),
            Err(RuntimeError::Size {
                got: 8,
                want: 3,
                ..
            })
        ));
        std::fs::remove_file(dir.join("Image")).unwrap();
        assert!(matches!(
            pins.verify(&dir, &["Image"]),
            Err(RuntimeError::Unreadable { .. })
        ));
        assert!(matches!(
            pins.verify(&dir, &["rootfs.img"]),
            Err(RuntimeError::NotPinned { .. })
        ));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn the_compiled_pins_cover_the_shipped_runtime() {
        let pins = Pins::compiled();
        assert_eq!(pins.arch, "arm64");
        for name in SHIPPED.iter().chain([&HOSTILE_INITRAMFS]) {
            assert!(pins.files.contains_key(*name), "{name} is not pinned");
        }
    }
}
