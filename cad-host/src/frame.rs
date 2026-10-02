//! The guest byte channel: frames of a 4-byte ASCII tag, a little-endian `u32` length, and the payload.
//!
//! The host sends `JOBS` (and `INPT` for an inspection) and then accepts only the named, bounded frames its guest
//! role may send, each at most once, ending with `DONE`. Every length is checked against its cap before a byte of
//! payload is read or allocated. Frames carry no paths, so nothing the guest sends can name a host location.

use std::io::{self, Read, Write};

use serde::Deserialize;

const HEADER_LEN: usize = 8;

/// Which guest is talking: generation runs the model's source, inspection runs only the pinned inspector.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Generate,
    Inspect,
}

/// The frames a guest may send.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Tag {
    Step,
    Manifest,
    Mesh,
    Diagnostics,
    Stats,
    Done,
}

impl Tag {
    fn parse(raw: [u8; 4]) -> Option<Self> {
        Some(match &raw {
            b"STEP" => Self::Step,
            b"MANI" => Self::Manifest,
            b"MESH" => Self::Mesh,
            b"DIAG" => Self::Diagnostics,
            b"STAT" => Self::Stats,
            b"DONE" => Self::Done,
            _ => return None,
        })
    }

    fn allowed_for(self, role: Role) -> bool {
        match self {
            Self::Manifest => role == Role::Generate,
            Self::Mesh => role == Role::Inspect,
            Self::Step | Self::Diagnostics | Self::Stats | Self::Done => true,
        }
    }
}

/// Per-frame caps and a cap on everything one guest may send.
#[derive(Clone, Copy, Debug)]
pub struct FrameLimits {
    pub step: u32,
    pub manifest: u32,
    pub mesh: u32,
    pub diagnostics: u32,
    pub stats: u32,
    pub done: u32,
    pub total: u64,
}

impl FrameLimits {
    pub const SPIKE: Self = Self {
        step: 32 << 20,
        manifest: 64 << 10,
        mesh: 64 << 20,
        diagnostics: 16 << 10,
        stats: 4 << 10,
        done: 4 << 10,
        total: 112 << 20,
    };

    fn cap(&self, tag: Tag) -> u32 {
        match tag {
            Tag::Step => self.step,
            Tag::Manifest => self.manifest,
            Tag::Mesh => self.mesh,
            Tag::Diagnostics => self.diagnostics,
            Tag::Stats => self.stats,
            Tag::Done => self.done,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ProtocolError {
    #[error("guest sent an unknown frame tag {0:02x?}")]
    UnknownTag([u8; 4]),
    #[error("a {role:?} guest may not send {tag:?}")]
    NotAllowed { tag: Tag, role: Role },
    #[error("guest sent {0:?} twice")]
    Duplicate(Tag),
    #[error("guest announced {len} bytes of {tag:?}; the cap is {cap}")]
    TooLarge { tag: Tag, len: u32, cap: u32 },
    #[error("guest output exceeds the {0}-byte total cap")]
    TotalTooLarge(u64),
    #[error("guest closed the channel before DONE")]
    Truncated,
    #[error("guest DONE is malformed: {0}")]
    BadDone(String),
    #[error("channel: {0}")]
    Io(#[from] io::Error),
}

/// Everything one guest sent, each payload already within its cap. Still untrusted content.
#[derive(Debug, Default)]
pub struct Response {
    pub step: Option<Vec<u8>>,
    pub manifest: Option<Vec<u8>>,
    pub mesh: Option<Vec<u8>>,
    pub diagnostics: Option<Vec<u8>>,
    pub stats: Option<Vec<u8>>,
    pub done: Done,
}

/// The guest's own verdict on its job. `ok` is a claim the host still checks.
#[derive(Debug, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Done {
    pub ok: bool,
    pub error: Option<String>,
}

/// Writes one host-to-guest frame (`JOBS` or `INPT`).
pub fn write_frame(w: &mut impl Write, tag: &[u8; 4], payload: &[u8]) -> io::Result<()> {
    let len = u32::try_from(payload.len()).map_err(|_| io::Error::other("frame over 4 GiB"))?;
    w.write_all(tag)?;
    w.write_all(&len.to_le_bytes())?;
    w.write_all(payload)
}

/// Reads one guest's frames up to and including `DONE`, enforcing the role's allowlist and every cap.
pub fn read_response(
    r: &mut impl Read,
    role: Role,
    limits: &FrameLimits,
) -> Result<Response, ProtocolError> {
    let mut response = Response::default();
    let mut total = 0u64;
    loop {
        let mut header = [0u8; HEADER_LEN];
        read_exact_or_truncated(r, &mut header)?;
        let raw: [u8; 4] = header[..4].try_into().expect("4-byte tag");
        let len = u32::from_le_bytes(header[4..].try_into().expect("4-byte length"));
        let tag = Tag::parse(raw).ok_or(ProtocolError::UnknownTag(raw))?;
        if !tag.allowed_for(role) {
            return Err(ProtocolError::NotAllowed { tag, role });
        }
        let cap = limits.cap(tag);
        if len > cap {
            return Err(ProtocolError::TooLarge { tag, len, cap });
        }
        total += u64::from(len);
        if total > limits.total {
            return Err(ProtocolError::TotalTooLarge(limits.total));
        }
        let slot = match tag {
            Tag::Step => &mut response.step,
            Tag::Manifest => &mut response.manifest,
            Tag::Mesh => &mut response.mesh,
            Tag::Diagnostics => &mut response.diagnostics,
            Tag::Stats => &mut response.stats,
            Tag::Done => {
                let mut payload = vec![0u8; len as usize];
                read_exact_or_truncated(r, &mut payload)?;
                response.done = serde_json::from_slice(&payload)
                    .map_err(|e| ProtocolError::BadDone(e.to_string()))?;
                return Ok(response);
            }
        };
        if slot.is_some() {
            return Err(ProtocolError::Duplicate(tag));
        }
        let mut payload = vec![0u8; len as usize];
        read_exact_or_truncated(r, &mut payload)?;
        *slot = Some(payload);
    }
}

fn read_exact_or_truncated(r: &mut impl Read, buf: &mut [u8]) -> Result<(), ProtocolError> {
    r.read_exact(buf).map_err(|e| match e.kind() {
        io::ErrorKind::UnexpectedEof => ProtocolError::Truncated,
        _ => ProtocolError::Io(e),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(tag: &[u8; 4], payload: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        write_frame(&mut out, tag, payload).unwrap();
        out
    }

    const DONE: &[u8] = br#"{"ok":true,"error":null}"#;

    #[test]
    fn a_generation_response_round_trips() {
        let bytes = [
            frame(b"STEP", b"ISO-10303-21;"),
            frame(b"MANI", b"{}"),
            frame(b"DONE", DONE),
        ]
        .concat();
        let response =
            read_response(&mut bytes.as_slice(), Role::Generate, &FrameLimits::SPIKE).unwrap();
        assert_eq!(response.step.as_deref(), Some(&b"ISO-10303-21;"[..]));
        assert!(response.done.ok);
    }

    #[test]
    fn an_oversized_frame_is_refused_from_its_header_alone() {
        // Only the 8-byte header exists: a reader that tried to fill 4 GiB would report Truncated instead.
        let mut header = b"MESH".to_vec();
        header.extend_from_slice(&u32::MAX.to_le_bytes());
        let err =
            read_response(&mut header.as_slice(), Role::Inspect, &FrameLimits::SPIKE).unwrap_err();
        assert!(
            matches!(
                err,
                ProtocolError::TooLarge {
                    tag: Tag::Mesh,
                    len: u32::MAX,
                    ..
                }
            ),
            "{err}"
        );
    }

    #[test]
    fn unknown_and_path_like_tags_are_refused() {
        let bytes = frame(b"../x", b"/etc/passwd");
        let err =
            read_response(&mut bytes.as_slice(), Role::Inspect, &FrameLimits::SPIKE).unwrap_err();
        assert!(matches!(err, ProtocolError::UnknownTag(_)), "{err}");
    }

    #[test]
    fn each_role_sends_only_its_own_frames() {
        let mani = frame(b"MANI", b"{}");
        let err =
            read_response(&mut mani.as_slice(), Role::Inspect, &FrameLimits::SPIKE).unwrap_err();
        assert!(
            matches!(
                err,
                ProtocolError::NotAllowed {
                    tag: Tag::Manifest,
                    ..
                }
            ),
            "{err}"
        );
        let mesh = frame(b"MESH", b"");
        let err =
            read_response(&mut mesh.as_slice(), Role::Generate, &FrameLimits::SPIKE).unwrap_err();
        assert!(
            matches!(err, ProtocolError::NotAllowed { tag: Tag::Mesh, .. }),
            "{err}"
        );
    }

    #[test]
    fn a_repeated_frame_is_refused() {
        let bytes = [frame(b"STEP", b"a"), frame(b"STEP", b"b")].concat();
        let err =
            read_response(&mut bytes.as_slice(), Role::Generate, &FrameLimits::SPIKE).unwrap_err();
        assert!(matches!(err, ProtocolError::Duplicate(Tag::Step)), "{err}");
    }

    #[test]
    fn the_total_cap_holds_across_frames() {
        let limits = FrameLimits {
            total: 10,
            ..FrameLimits::SPIKE
        };
        let bytes = [frame(b"STEP", &[0; 8]), frame(b"DIAG", &[0; 8])].concat();
        let err = read_response(&mut bytes.as_slice(), Role::Generate, &limits).unwrap_err();
        assert!(matches!(err, ProtocolError::TotalTooLarge(10)), "{err}");
    }

    #[test]
    fn a_channel_that_ends_without_done_is_truncated() {
        let bytes = frame(b"STEP", b"partial");
        let err =
            read_response(&mut bytes.as_slice(), Role::Generate, &FrameLimits::SPIKE).unwrap_err();
        assert!(matches!(err, ProtocolError::Truncated), "{err}");
        let err = read_response(&mut &bytes[..6], Role::Generate, &FrameLimits::SPIKE).unwrap_err();
        assert!(matches!(err, ProtocolError::Truncated), "{err}");
    }

    #[test]
    fn done_must_be_exactly_the_expected_shape() {
        let bytes = frame(b"DONE", br#"{"ok":true,"path":"/tmp/x"}"#);
        let err =
            read_response(&mut bytes.as_slice(), Role::Generate, &FrameLimits::SPIKE).unwrap_err();
        assert!(matches!(err, ProtocolError::BadDone(_)), "{err}");
    }
}
