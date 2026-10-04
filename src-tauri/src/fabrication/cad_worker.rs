//! The CAD worker boundary: model-written build123d runs in a Linux virtual
//! machine, never on the host, and the app trusts nothing it sends back until
//! Rust has checked it.
//!
//! Every uncached build boots two fresh guests from the pinned runtime image.
//! The generation guest runs the script and returns an untrusted STEP and a
//! manifest of body names and filament slots. The inspection guest runs only
//! the pinned inspector, which parses that STEP, re-exports it, and tessellates
//! the same solids into the mesh protocol [`decode_mesh`] reads. Both guests
//! talk over one bounded byte channel ([`read_response`]): named frames, each
//! capped before a byte of it is read, and no paths.
//!
//! A [`CadRuntime`] exists only after its image matched the digests compiled
//! into this app, and on macOS only after its helper's signature checked out.
//! It runs on one of two backends:
//! - [`CadBackend::MacVm`], the shipped one: the signed helper bundled at
//!   `Contents/MacOS/materialize-cad-host` boots each guest with Apple's
//!   Virtualization framework.
//! - `CadBackend::LinuxMicroVm`, compiled only with the `linux-cad-test`
//!   feature, which no release enables: QEMU's microvm machine boots the amd64
//!   build of the same image on a KVM host, for the functional and real-slicer
//!   tests on the self-hosted Linux runner.
//!
//! There is no third backend. Without one, [`CadRuntime`] cannot be built, so
//! the `part` kind is unavailable; nothing ever runs a script on the host.

// Without a backend no runtime can be built, so its half of this module goes unused there.
#![cfg_attr(not(any(target_os = "macos", all(target_os = "linux", feature = "linux-cad-test"))), allow(dead_code))]

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::kind::BuildControl;
use super::model::{Mesh, Palette, Slot};
use super::printer::Um;

// ─── Limits ───────────────────────────────────────────────────────────────────

/// Fixed resources and caps for one guest. Every job runs under all of them;
/// none is optional.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkerLimits {
    pub vcpus: u8,
    pub memory_mib: u32,
    /// The host stops the VM at this deadline, whatever the guest is doing.
    pub deadline: Duration,
    /// Everything one guest may send, all frames together.
    pub output: u64,
    /// Console bytes kept for diagnostics; the rest is read and dropped.
    pub log: usize,
}

impl WorkerLimits {
    /// What a `part` build gives each guest.
    pub const PART: Self = Self {
        vcpus: 2,
        memory_mib: 2048,
        deadline: Duration::from_secs(120),
        output: FrameLimits::PART.total,
        log: 64 << 10,
    };

    /// The guest's own timeout for the job, a little under the host deadline,
    /// so an honest guest reports a slow script before the host stops it.
    #[cfg_attr(not(all(target_os = "linux", feature = "linux-cad-test")), allow(dead_code))]
    fn guest_timeout_s(&self) -> u64 {
        self.deadline.as_secs().saturating_sub(5).max(1)
    }
}

/// Joins the build key: bump it whenever the isolation or the limits a script
/// runs under change.
pub const SANDBOX_POLICY: &str = "m3d-cad-sandbox-1 vcpus=2 memory_mib=2048 deadline_s=120";

/// The inspector's tessellation settings (`cad-runtime/guest/inspector.py`),
/// which decide every mesh. They join the build key.
pub const TESSELLATION: &str = "linear_deflection_mm=0.02 angular_deflection_rad=0.2";

/// The pinned inspector's source, as the runtime image holds it.
const INSPECTOR: &[u8] = include_bytes!("../../../cad-runtime/guest/inspector.py");

// ─── Errors ───────────────────────────────────────────────────────────────────

/// Why a guest's job did not produce output the host accepts.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum WorkerError {
    /// The script or the inspector failed and said why, in a bounded message
    /// the script's author can act on.
    #[error("{0}")]
    Job(String),
    /// The guest's output broke the protocol or failed a bound.
    #[error("the worker's output was refused: {0}")]
    Rejected(String),
    #[error("the worker ran past its {0} s deadline and was stopped")]
    Deadline(u64),
    #[error("build cancelled")]
    Cancelled,
    #[error("the CAD worker failed: {0}")]
    Internal(String),
}

/// Why this app has no CAD runtime. The `part` kind is unavailable then.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum RuntimeUnavailable {
    #[error("the CAD runtime is not bundled with this app ({0})")]
    Missing(String),
    #[error("the CAD runtime failed verification: {0}")]
    Unverified(String),
}

// ─── The runtime image and its pins ──────────────────────────────────────────

/// The arm64 pins the shipped helper also compiles in; `cad-runtime/reproduce.sh`
/// checks every clean image build against this file.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const PINS_ARM64: &str = include_str!("../../../cad-runtime/pins-arm64.json");
/// The amd64 pins, for the Linux test backend only.
#[cfg(all(target_os = "linux", feature = "linux-cad-test"))]
const PINS_AMD64: &str = include_str!("../../../cad-runtime/pins-amd64.json");

#[derive(Debug, Deserialize)]
struct Pins {
    arch: String,
    files: BTreeMap<String, FilePin>,
}

#[derive(Debug, Deserialize)]
struct FilePin {
    sha256: String,
    bytes: u64,
}

/// A runtime directory whose files matched the compiled-in pins, size and
/// SHA-256, when it was opened. The helper checks them again before each boot.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedRuntimeImage {
    dir: PathBuf,
    arch: String,
    /// `name sha256`, in pin order, for the build key.
    digests: Vec<String>,
}

impl VerifiedRuntimeImage {
    /// Checks each of `names` in `dir` against `pins_json`, the pins compiled
    /// into this app. The first file that is unpinned, missing, resized, or
    /// changed refuses the whole runtime.
    fn verify(dir: &Path, pins_json: &str, names: &[&str]) -> Result<Self, RuntimeUnavailable> {
        let pins: Pins = serde_json::from_str(pins_json)
            .map_err(|e| RuntimeUnavailable::Unverified(format!("the compiled-in pins do not parse: {e}")))?;
        let mut digests = Vec::with_capacity(names.len());
        for &name in names {
            let pin = pins
                .files
                .get(name)
                .ok_or_else(|| RuntimeUnavailable::Unverified(format!("{name} is not pinned")))?;
            let path = dir.join(name);
            let mut file = std::fs::File::open(&path).map_err(|e| match e.kind() {
                io::ErrorKind::NotFound => RuntimeUnavailable::Missing(format!("{} is missing", path.display())),
                _ => RuntimeUnavailable::Unverified(format!("{}: {e}", path.display())),
            })?;
            let unreadable = |e: io::Error| RuntimeUnavailable::Unverified(format!("{}: {e}", path.display()));
            let size = file.metadata().map_err(unreadable)?.len();
            if size != pin.bytes {
                return Err(RuntimeUnavailable::Unverified(format!("{name}: {size} bytes, the pin says {}", pin.bytes)));
            }
            let mut hasher = Sha256::new();
            io::copy(&mut file, &mut hasher).map_err(unreadable)?;
            let got = hex(&hasher.finalize());
            if got != pin.sha256 {
                return Err(RuntimeUnavailable::Unverified(format!("{name}: sha256 {got} does not match the pin {}", pin.sha256)));
            }
            digests.push(format!("{name} {got}"));
        }
        Ok(Self { dir: dir.to_path_buf(), arch: pins.arch, digests })
    }

    #[cfg_attr(not(all(target_os = "linux", feature = "linux-cad-test")), allow(dead_code))]
    fn file(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// ─── The runtime ──────────────────────────────────────────────────────────────

/// A verified CAD runtime: holding one proves the backend (on macOS, the
/// helper's signature) and the image matched what this app version compiled
/// in. Cheap to clone.
#[derive(Debug, Clone)]
pub struct CadRuntime {
    inner: Arc<RuntimeInner>,
}

#[derive(Debug)]
struct RuntimeInner {
    backend: CadBackend,
    image: VerifiedRuntimeImage,
}

/// How a guest boots.
#[derive(Debug)]
pub enum CadBackend {
    /// The shipped backend: the signed helper and Apple's Virtualization framework.
    #[cfg(target_os = "macos")]
    MacVm(VerifiedHostHelper),
    /// Linux test backend: the amd64 build of the same pinned lock file,
    /// booted under QEMU's microvm machine. Compiled only with the
    /// `linux-cad-test` feature, which the macOS release never enables, so it
    /// cannot ship and there is no host-Python path.
    #[cfg(all(target_os = "linux", feature = "linux-cad-test"))]
    LinuxMicroVm(MicroVmConfig),
}

/// The job the generation guest runs: the script and its params.
#[derive(Debug, Clone)]
pub struct CadJob {
    pub source: String,
    pub params: Value,
}

/// A STEP a guest sent. Nothing on the host parses it; only a fresh
/// inspection guest does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UntrustedStep(Vec<u8>);

/// What the generation guest returned.
#[derive(Debug)]
pub struct GeneratedCad {
    pub step: UntrustedStep,
    pub bodies: BodyManifest,
    pub diagnostics: String,
}

/// What the inspection guest returned: its re-exported STEP and the bodies it
/// tessellated from that same solid, in manifest order.
#[derive(Debug)]
pub struct NormalizedCad {
    pub step: Vec<u8>,
    pub bodies: Vec<RawBody>,
    pub diagnostics: String,
}

impl CadRuntime {
    /// The bundled runtime of this app, if it has one that verifies. On macOS
    /// it is the helper beside the app binary and the image in the bundle's
    /// resources. Anywhere else there is none.
    pub fn bundled() -> Result<Self, RuntimeUnavailable> {
        #[cfg(target_os = "macos")]
        {
            let exe = std::env::current_exe().map_err(|e| RuntimeUnavailable::Missing(e.to_string()))?;
            let macos_dir = exe.parent().ok_or_else(|| RuntimeUnavailable::Missing("the app binary has no directory".into()))?;
            let helper = VerifiedHostHelper::verify(&macos_dir.join(HELPER_NAME))?;
            Self::mac_vm(helper, &macos_dir.join("../Resources/cad-runtime"))
        }
        #[cfg(not(target_os = "macos"))]
        {
            Err(RuntimeUnavailable::Missing("only the macOS app bundles one".into()))
        }
    }

    /// A runtime on the shipped macOS backend: `helper` booting the image in
    /// `runtime_dir`, which must match the arm64 pins compiled into this app.
    #[cfg(target_os = "macos")]
    pub fn mac_vm(helper: VerifiedHostHelper, runtime_dir: &Path) -> Result<Self, RuntimeUnavailable> {
        let image = VerifiedRuntimeImage::verify(runtime_dir, PINS_ARM64, &["Image", "rootfs.img", "job.img"])?;
        Ok(Self { inner: Arc::new(RuntimeInner { backend: CadBackend::MacVm(helper), image }) })
    }

    /// A runtime on the Linux test backend: `config`'s QEMU booting the image
    /// in `runtime_dir`, which must match the amd64 pins compiled into this app.
    #[cfg(all(target_os = "linux", feature = "linux-cad-test"))]
    pub fn linux_microvm(config: MicroVmConfig, runtime_dir: &Path) -> Result<Self, RuntimeUnavailable> {
        let image = VerifiedRuntimeImage::verify(runtime_dir, PINS_AMD64, &["vmlinux", "rootfs.img", "job.img"])?;
        Ok(Self { inner: Arc::new(RuntimeInner { backend: CadBackend::LinuxMicroVm(config), image }) })
    }

    /// Everything about this runtime that decides a build's output, for the
    /// build key: the image digests, the inspector, the tessellation settings,
    /// and the sandbox policy.
    pub fn key_inputs(&self) -> Vec<String> {
        let image = &self.inner.image;
        let mut inputs = vec![format!("cad-runtime {}", image.arch)];
        inputs.extend(image.digests.iter().cloned());
        inputs.push(format!("inspector {}", hex(&Sha256::digest(INSPECTOR))));
        inputs.push(format!("tessellation {TESSELLATION}"));
        inputs.push(format!("sandbox {SANDBOX_POLICY}"));
        inputs
    }

    /// Boots a fresh generation guest, runs the script, and returns its
    /// untrusted STEP, its body manifest (bounded and parsed), and its
    /// diagnostics. A script error comes back as [`WorkerError::Job`].
    pub fn generate(&self, job: &CadJob, limits: &WorkerLimits, control: &BuildControl<'_>) -> Result<GeneratedCad, WorkerError> {
        let response = self.exchange(Request::Generate(job), limits, control)?;
        let diagnostics = diagnostics_text(response.diagnostics.as_deref());
        if !response.done.ok {
            return Err(WorkerError::Job(bounded_error(response.done.error.as_deref(), "the script failed")));
        }
        let (Some(step), Some(manifest)) = (response.step, response.manifest) else {
            return Err(WorkerError::Rejected("the guest claimed success without a STEP and a manifest".into()));
        };
        let bodies = parse_manifest(&manifest).map_err(|e| WorkerError::Rejected(e.to_string()))?;
        Ok(GeneratedCad { step: UntrustedStep(step), bodies, diagnostics })
    }

    /// Boots a fresh inspection guest that runs only the pinned inspector on
    /// `input`, then decodes its mesh within `MeshLimits::PART`. The inspector
    /// names the bodies of the STEP it re-exports with `bodies`' names, which
    /// the host checked, never with names the untrusted STEP carries.
    pub fn normalize(
        &self,
        input: UntrustedStep,
        bodies: &BodyManifest,
        limits: &WorkerLimits,
        control: &BuildControl<'_>,
    ) -> Result<NormalizedCad, WorkerError> {
        let names: Vec<&str> = bodies.bodies().iter().map(|(name, _)| name.as_str()).collect();
        let response = self.exchange(Request::Inspect(input, &names), limits, control)?;
        let diagnostics = diagnostics_text(response.diagnostics.as_deref());
        if !response.done.ok {
            return Err(WorkerError::Job(bounded_error(response.done.error.as_deref(), "the inspector refused the STEP")));
        }
        let (Some(step), Some(mesh)) = (response.step, response.mesh) else {
            return Err(WorkerError::Rejected("the inspector claimed success without a STEP and a mesh".into()));
        };
        let bodies = decode_mesh(&mesh, &MeshLimits::PART).map_err(|e| WorkerError::Rejected(format!("mesh: {e}")))?;
        Ok(NormalizedCad { step, bodies, diagnostics })
    }

    /// Runs one guest on this runtime's backend and returns what it sent,
    /// each frame within its cap.
    #[cfg_attr(not(any(target_os = "macos", all(target_os = "linux", feature = "linux-cad-test"))), allow(unused_variables))]
    fn exchange(&self, request: Request<'_>, limits: &WorkerLimits, control: &BuildControl<'_>) -> Result<Response, WorkerError> {
        match self.inner.backend {
            #[cfg(target_os = "macos")]
            CadBackend::MacVm(ref helper) => match request {
                Request::Generate(job) => helper.generate(&self.inner.image, job, limits, control),
                Request::Inspect(step, names) => helper.inspect(&self.inner.image, &step.0, names, limits, control),
            },
            #[cfg(all(target_os = "linux", feature = "linux-cad-test"))]
            CadBackend::LinuxMicroVm(ref config) => {
                let encode = |job: Value| serde_json::to_vec(&job).map_err(|e| WorkerError::Internal(e.to_string()));
                let timeout_s = limits.guest_timeout_s();
                let (frames, role) = match request {
                    Request::Generate(job) => {
                        let spec = serde_json::json!({ "role": "generate", "source": job.source, "params": job.params, "timeout_s": timeout_s });
                        (vec![(*b"JOBS", encode(spec)?)], Role::Generate)
                    }
                    Request::Inspect(step, names) => {
                        let spec = serde_json::json!({ "role": "inspect", "timeout_s": timeout_s, "names": names });
                        (vec![(*b"JOBS", encode(spec)?), (*b"INPT", step.0)], Role::Inspect)
                    }
                };
                linux::run_guest(config, &self.inner.image, &frames, role, limits, control)
            }
        }
    }
}

/// What one guest is asked to do.
enum Request<'a> {
    Generate(&'a CadJob),
    /// The STEP and the body names to give its bodies.
    Inspect(UntrustedStep, &'a [&'a str]),
}

/// Characters of a guest error kept for the person or model reading it.
const ERROR_CHARS: usize = 2000;

fn bounded_error(error: Option<&str>, fallback: &str) -> String {
    let text = error.filter(|e| !e.trim().is_empty()).unwrap_or(fallback);
    text.chars().filter(|c| !c.is_control() || *c == '\n').take(ERROR_CHARS).collect()
}

fn diagnostics_text(bytes: Option<&[u8]>) -> String {
    bytes.map(|b| String::from_utf8_lossy(b).chars().take(FrameLimits::PART.diagnostics as usize).collect()).unwrap_or_default()
}

/// Where a workspace finds its CAD runtime: located and verified once, on
/// first use, and shared by every clone.
#[derive(Clone)]
pub struct CadRuntimeSlot {
    runtime: Arc<OnceLock<Option<CadRuntime>>>,
    locate: fn() -> Option<CadRuntime>,
}

impl CadRuntimeSlot {
    /// The runtime bundled with this app ([`CadRuntime::bundled`]).
    pub fn bundled() -> Self {
        Self { runtime: Arc::new(OnceLock::new()), locate: locate_bundled }
    }

    /// Exactly `runtime`, already verified, or none.
    pub fn fixed(runtime: Option<CadRuntime>) -> Self {
        Self { runtime: Arc::new(OnceLock::from(runtime)), locate: || None }
    }

    pub fn get(&self) -> Option<&CadRuntime> {
        self.runtime.get_or_init(self.locate).as_ref()
    }
}

impl fmt::Debug for CadRuntimeSlot {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CadRuntimeSlot").field("runtime", &self.runtime.get()).finish()
    }
}

fn locate_bundled() -> Option<CadRuntime> {
    match CadRuntime::bundled() {
        Ok(runtime) => Some(runtime),
        Err(why) => {
            log::warn!("cad: the part kind is unavailable: {why}");
            None
        }
    }
}

// ─── The guest channel ────────────────────────────────────────────────────────

/// Which guest is talking: generation runs the model's source, inspection runs
/// only the pinned inspector.
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
    /// The caps the PR 5 spike's restriction tests proved, unchanged.
    pub const PART: Self = Self {
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

/// Everything one guest sent, each payload already within its cap. Still
/// untrusted content.
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
#[cfg_attr(not(all(target_os = "linux", feature = "linux-cad-test")), allow(dead_code))]
fn write_frame(w: &mut impl io::Write, tag: &[u8; 4], payload: &[u8]) -> io::Result<()> {
    let len = u32::try_from(payload.len()).map_err(|_| io::Error::other("frame over 4 GiB"))?;
    w.write_all(tag)?;
    w.write_all(&len.to_le_bytes())?;
    w.write_all(payload)
}

/// Reads one guest's frames up to and including `DONE`, enforcing the role's
/// allowlist and every cap. Each length is checked against its cap before a
/// byte of payload is read or allocated.
pub fn read_response(r: &mut impl Read, role: Role, limits: &FrameLimits) -> Result<Response, ProtocolError> {
    let mut response = Response::default();
    let mut total = 0u64;
    loop {
        let mut header = [0u8; 8];
        read_exact_or_truncated(r, &mut header)?;
        let raw: [u8; 4] = [header[0], header[1], header[2], header[3]];
        let len = u32::from_le_bytes([header[4], header[5], header[6], header[7]]);
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
        let mut payload = vec![0u8; len as usize];
        read_exact_or_truncated(r, &mut payload)?;
        let slot = match tag {
            Tag::Step => &mut response.step,
            Tag::Manifest => &mut response.manifest,
            Tag::Mesh => &mut response.mesh,
            Tag::Diagnostics => &mut response.diagnostics,
            Tag::Stats => &mut response.stats,
            Tag::Done => {
                response.done = serde_json::from_slice(&payload).map_err(|e| ProtocolError::BadDone(e.to_string()))?;
                return Ok(response);
            }
        };
        if slot.is_some() {
            return Err(ProtocolError::Duplicate(tag));
        }
        *slot = Some(payload);
    }
}

fn read_exact_or_truncated(r: &mut impl Read, buf: &mut [u8]) -> Result<(), ProtocolError> {
    r.read_exact(buf).map_err(|e| match e.kind() {
        io::ErrorKind::UnexpectedEof => ProtocolError::Truncated,
        _ => ProtocolError::Io(e),
    })
}

// ─── The body manifest ────────────────────────────────────────────────────────

pub const MAX_BODIES: usize = 16;
pub const MAX_NAME_CHARS: usize = 64;
/// Slots the generation guest may name; the palette decides which exist.
pub const MAX_SLOT: u8 = 16;

/// A body name from a script: 1 to 64 characters, none of them a control
/// character or one that hides or reorders text (zero-width and bidirectional
/// controls), so what a person reads is what the name is.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct BodyName(String);

impl BodyName {
    pub fn parse(name: &str) -> Option<Self> {
        let chars = name.chars().count();
        let printable = name.chars().all(|c| !c.is_control() && !is_invisible_format(c));
        ((1..=MAX_NAME_CHARS).contains(&chars) && printable && name.trim() == name).then(|| Self(name.to_owned()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Zero-width characters, bidirectional controls, and other invisible
/// formatting characters (Unicode general category Cf that renders nothing).
fn is_invisible_format(c: char) -> bool {
    matches!(
        c,
        '\u{00AD}'
            | '\u{061C}'
            | '\u{180E}'
            | '\u{200B}'..='\u{200F}'
            | '\u{202A}'..='\u{202E}'
            | '\u{2060}'..='\u{2064}'
            | '\u{2066}'..='\u{206F}'
            | '\u{FEFF}'
            | '\u{FFF9}'..='\u{FFFB}'
    )
}

/// Body names and filament slots from the script, in STEP root order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BodyManifest {
    bodies: Vec<(BodyName, u8)>,
}

impl BodyManifest {
    /// Each body's name and 1-based filament slot.
    pub fn bodies(&self) -> &[(BodyName, u8)] {
        &self.bodies
    }

    /// The slots as palette slots, refusing one the palette does not have.
    pub fn slots(&self, palette: &Palette) -> Result<Vec<Slot>, ManifestError> {
        self.bodies
            .iter()
            .enumerate()
            .map(|(i, (name, slot))| {
                palette.slot(usize::from(*slot) - 1).ok_or_else(|| ManifestError::NoSuchFilament {
                    body: i,
                    name: name.as_str().to_owned(),
                    slot: *slot,
                    filaments: palette.colours().len(),
                })
            })
            .collect()
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ManifestError {
    #[error("manifest is not valid JSON of the expected shape: {0}")]
    Shape(String),
    #[error("build() returned {0} bodies; 1 to {MAX_BODIES} are allowed")]
    BodyCount(usize),
    #[error("body {0}: a name must be 1 to {MAX_NAME_CHARS} visible characters, with no control, zero-width, or bidirectional characters and no space at either end")]
    Name(usize),
    #[error("body {0}: slot must be 1 to {MAX_SLOT}")]
    Slot(usize),
    #[error("body {0}: the name {1:?} is used twice")]
    Duplicate(usize, String),
    #[error("body {body} ({name}) uses filament slot {slot}, but the spec lists {filaments} filaments")]
    NoSuchFilament { body: usize, name: String, slot: u8, filaments: usize },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireManifest {
    bodies: Vec<WireBody>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireBody {
    name: String,
    slot: u8,
}

/// Parses manifest bytes (already capped by the frame reader) and bounds
/// every field.
pub fn parse_manifest(bytes: &[u8]) -> Result<BodyManifest, ManifestError> {
    let wire: WireManifest = serde_json::from_slice(bytes).map_err(|e| ManifestError::Shape(e.to_string()))?;
    if wire.bodies.is_empty() || wire.bodies.len() > MAX_BODIES {
        return Err(ManifestError::BodyCount(wire.bodies.len()));
    }
    let mut seen = BTreeSet::new();
    let mut bodies = Vec::with_capacity(wire.bodies.len());
    for (i, body) in wire.bodies.into_iter().enumerate() {
        let name = BodyName::parse(&body.name).ok_or(ManifestError::Name(i))?;
        if body.slot == 0 || body.slot > MAX_SLOT {
            return Err(ManifestError::Slot(i));
        }
        if !seen.insert(name.clone()) {
            return Err(ManifestError::Duplicate(i, body.name));
        }
        bodies.push((name, body.slot));
    }
    Ok(BodyManifest { bodies })
}

// ─── The mesh protocol ────────────────────────────────────────────────────────
//
// Little endian: b"M3DMESH1", u32 body count, then per body u32 vertex count,
// u32 triangle count, vertex count * 3 f64 (mm), triangle count * 3 u32
// indices, counterclockwise seen from outside.

const MESH_MAGIC: &[u8; 8] = b"M3DMESH1";

#[derive(Clone, Copy, Debug)]
pub struct MeshLimits {
    pub max_bodies: u32,
    pub max_vertices: u32,
    pub max_triangles: u32,
    /// Largest absolute coordinate accepted, in mm.
    pub max_abs_mm: f64,
}

impl MeshLimits {
    pub const PART: Self = Self { max_bodies: MAX_BODIES as u32, max_vertices: 2_000_000, max_triangles: 2_000_000, max_abs_mm: 2_000.0 };
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum MeshError {
    #[error("mesh does not start with the M3DMESH1 magic")]
    BadMagic,
    #[error("mesh ends early")]
    Truncated,
    #[error("mesh has {0} bodies; 1 to the limit are allowed")]
    BodyCount(u32),
    #[error("body {body} claims {vertices} vertices and {triangles} triangles, over the limits")]
    TooLarge { body: u32, vertices: u32, triangles: u32 },
    #[error("body {body} declares no geometry ({vertices} vertices, {triangles} triangles)")]
    EmptyBody { body: u32, vertices: u32, triangles: u32 },
    #[error("body {body} claims more data than the mesh holds")]
    CountsExceedPayload { body: u32 },
    #[error("body {body} vertex {vertex} is not finite or is out of range")]
    BadCoordinate { body: u32, vertex: u32 },
    #[error("body {body} triangle {triangle} indexes past its vertices")]
    BadIndex { body: u32, triangle: u32 },
    #[error("{0} bytes follow the last body")]
    TrailingBytes(usize),
}

/// One body as the inspector sent it: per-face vertices, not yet on the grid.
/// Only [`decode_mesh`] makes one, so every coordinate is finite and bounded
/// and every index is in range.
#[derive(Debug, Clone, PartialEq)]
pub struct RawBody {
    vertices: Vec<[f64; 3]>,
    triangles: Vec<[u32; 3]>,
}

impl RawBody {
    pub fn triangle_count(&self) -> usize {
        self.triangles.len()
    }

    /// Snaps every vertex to the 1 µm grid and merges vertices that land on
    /// the same grid point: the mesh the app checks, packages, and slices.
    pub fn weld(&self) -> Mesh {
        let mut index: std::collections::HashMap<[Um; 3], u32> = std::collections::HashMap::with_capacity(self.vertices.len());
        let mut vertices = Vec::new();
        let remap: Vec<u32> = self
            .vertices
            .iter()
            .map(|p| {
                // decode_mesh bounded every coordinate, so the rounded value fits.
                let q = p.map(|c| (c * 1000.0).round() as Um);
                *index.entry(q).or_insert_with(|| {
                    vertices.push(q);
                    u32::try_from(vertices.len() - 1).expect("vertex count is bounded by MeshLimits")
                })
            })
            .collect();
        let triangles = self.triangles.iter().map(|t| t.map(|i| remap[i as usize])).collect();
        Mesh::new(vertices, triangles).expect("welding keeps every index in range")
    }
}

struct Cursor<'a>(&'a [u8]);

impl<'a> Cursor<'a> {
    fn take(&mut self, n: usize) -> Result<&'a [u8], MeshError> {
        if self.0.len() < n {
            return Err(MeshError::Truncated);
        }
        let (head, rest) = self.0.split_at(n);
        self.0 = rest;
        Ok(head)
    }

    fn u32(&mut self) -> Result<u32, MeshError> {
        let b = self.take(4)?;
        Ok(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
}

/// Decodes and bounds-checks the inspector's mesh. Allocation never exceeds
/// what the payload actually holds.
pub fn decode_mesh(bytes: &[u8], limits: &MeshLimits) -> Result<Vec<RawBody>, MeshError> {
    let mut cur = Cursor(bytes);
    if cur.take(MESH_MAGIC.len())? != MESH_MAGIC {
        return Err(MeshError::BadMagic);
    }
    let count = cur.u32()?;
    if count == 0 || count > limits.max_bodies {
        return Err(MeshError::BodyCount(count));
    }
    let mut bodies = Vec::with_capacity(count as usize);
    for body in 0..count {
        let (vertices, triangles) = (cur.u32()?, cur.u32()?);
        if vertices > limits.max_vertices || triangles > limits.max_triangles {
            return Err(MeshError::TooLarge { body, vertices, triangles });
        }
        if vertices == 0 || triangles == 0 {
            return Err(MeshError::EmptyBody { body, vertices, triangles });
        }
        let need = u64::from(vertices) * 24 + u64::from(triangles) * 12;
        if need > cur.0.len() as u64 {
            return Err(MeshError::CountsExceedPayload { body });
        }
        let coords = cur.take(vertices as usize * 24)?;
        let mut verts = Vec::with_capacity(vertices as usize);
        for (vertex, chunk) in (0u32..).zip(coords.as_chunks::<24>().0) {
            let p: [f64; 3] = std::array::from_fn(|k| {
                let mut b = [0u8; 8];
                b.copy_from_slice(&chunk[k * 8..k * 8 + 8]);
                f64::from_le_bytes(b)
            });
            if !p.iter().all(|c| c.is_finite() && c.abs() <= limits.max_abs_mm) {
                return Err(MeshError::BadCoordinate { body, vertex });
            }
            verts.push(p);
        }
        let raw = cur.take(triangles as usize * 12)?;
        let mut tris = Vec::with_capacity(triangles as usize);
        for (triangle, chunk) in (0u32..).zip(raw.as_chunks::<12>().0) {
            let t: [u32; 3] = std::array::from_fn(|k| u32::from_le_bytes([chunk[k * 4], chunk[k * 4 + 1], chunk[k * 4 + 2], chunk[k * 4 + 3]]));
            if t.iter().any(|&i| i >= vertices) {
                return Err(MeshError::BadIndex { body, triangle });
            }
            tris.push(t);
        }
        bodies.push(RawBody { vertices: verts, triangles: tris });
    }
    if !cur.0.is_empty() {
        return Err(MeshError::TrailingBytes(cur.0.len()));
    }
    Ok(bodies)
}

// ─── macOS: the signed helper ─────────────────────────────────────────────────

/// The helper's file name in `Contents/MacOS/`.
#[cfg(target_os = "macos")]
const HELPER_NAME: &str = "materialize-cad-host";

/// The helper's signing identifier, as `scripts/release/build-macos.sh` signs it.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const HELPER_IDENTIFIER: &str = "com.aojdevstudio.materialize3d.cad-host";

/// Marks a leaf certificate as Developer ID Application, which only Apple
/// issues for distribution outside the App Store.
const DEVELOPER_ID_LEAF: &str = "1.2.840.113635.100.6.1.13";
/// Marks the Developer ID certification authority, the leaf's issuer.
const DEVELOPER_ID_CA: &str = "1.2.840.113635.100.6.2.6";

/// The code requirement a helper must meet, for `codesign -R`, or `None` for
/// any valid signature. `team` is the signing team compiled into this build
/// (`M3D_CAD_HELPER_TEAM`, which `scripts/release/build-macos.sh` sets); with
/// one, the helper must carry its identifier and a Developer ID Application
/// signature from that team: Apple's anchor, the Developer ID CA, the
/// Developer ID Application leaf, and the team as the leaf's OU. That team's
/// Apple Development certificates do not meet it. Without one, only a debug build (tests, `tauri dev`, the CI
/// self-test) accepts any valid signature, ad hoc included. A release build
/// without a team fails closed: it trusts no helper, so `part` is unavailable.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn helper_requirement(team: Option<&str>, debug_build: bool) -> Result<Option<String>, RuntimeUnavailable> {
    match team {
        Some(team) => Ok(Some(format!(
            "=identifier \"{HELPER_IDENTIFIER}\" and anchor apple generic and certificate 1[field.{DEVELOPER_ID_CA}] exists \
             and certificate leaf[field.{DEVELOPER_ID_LEAF}] exists and certificate leaf[subject.OU] = \"{team}\""
        ))),
        None if debug_build => Ok(None),
        None => Err(RuntimeUnavailable::Unverified(
            "this release build names no signing team for its CAD helper (M3D_CAD_HELPER_TEAM), so it trusts none".into(),
        )),
    }
}

/// The bundled helper, after its code signature checked out against
/// [`helper_requirement`].
#[cfg(target_os = "macos")]
#[derive(Debug)]
pub struct VerifiedHostHelper {
    path: PathBuf,
}

#[cfg(target_os = "macos")]
impl VerifiedHostHelper {
    pub fn verify(path: &Path) -> Result<Self, RuntimeUnavailable> {
        if !path.is_file() {
            return Err(RuntimeUnavailable::Missing(format!("{} is missing", path.display())));
        }
        let requirement = helper_requirement(option_env!("M3D_CAD_HELPER_TEAM"), cfg!(debug_assertions))?;
        let mut codesign = std::process::Command::new("/usr/bin/codesign");
        codesign.args(["--verify", "--strict"]);
        if let Some(requirement) = requirement {
            codesign.arg("-R").arg(requirement);
        }
        let output = codesign
            .arg(path)
            .env_clear()
            .output()
            .map_err(|e| RuntimeUnavailable::Unverified(format!("codesign: {e}")))?;
        if !output.status.success() {
            let why = String::from_utf8_lossy(&output.stderr);
            return Err(RuntimeUnavailable::Unverified(format!("the CAD helper's signature: {}", why.trim())));
        }
        Ok(Self { path: path.to_path_buf() })
    }

    fn generate(&self, image: &VerifiedRuntimeImage, job: &CadJob, limits: &WorkerLimits, control: &BuildControl<'_>) -> Result<Response, WorkerError> {
        let scratch = mac::Scratch::new()?;
        let source = scratch.write("source.py", job.source.as_bytes())?;
        let params = scratch.write("params.json", &serde_json::to_vec(&job.params).map_err(|e| WorkerError::Internal(e.to_string()))?)?;
        let mut args = vec!["generate".into(), "--source".into(), source.into_os_string(), "--params".into(), params.into_os_string()];
        let out = mac::run(self, image, &scratch, &mut args, limits, control)?;
        let manifest = match out.result.get("manifest") {
            Some(manifest) => Some(serde_json::to_vec(manifest).map_err(|e| WorkerError::Internal(e.to_string()))?),
            None => None,
        };
        Ok(Response {
            step: out.read("generated.step", FrameLimits::PART.step)?,
            manifest,
            mesh: None,
            diagnostics: out.read("diagnostics-generate.txt", FrameLimits::PART.diagnostics)?,
            stats: None,
            done: out.done(),
        })
    }

    fn inspect(
        &self,
        image: &VerifiedRuntimeImage,
        step: &[u8],
        names: &[&str],
        limits: &WorkerLimits,
        control: &BuildControl<'_>,
    ) -> Result<Response, WorkerError> {
        let scratch = mac::Scratch::new()?;
        let input = scratch.write("input.step", step)?;
        let names = scratch.write("names.json", &serde_json::to_vec(names).map_err(|e| WorkerError::Internal(e.to_string()))?)?;
        let mut args = vec!["inspect".into(), "--step".into(), input.into_os_string(), "--names".into(), names.into_os_string()];
        let out = mac::run(self, image, &scratch, &mut args, limits, control)?;
        Ok(Response {
            step: out.read("normalized.step", FrameLimits::PART.step)?,
            manifest: None,
            mesh: out.read("mesh.bin", FrameLimits::PART.mesh)?,
            diagnostics: out.read("diagnostics-inspect.txt", FrameLimits::PART.diagnostics)?,
            stats: None,
            done: out.done(),
        })
    }
}

#[cfg(target_os = "macos")]
mod mac {
    //! Runs the helper as a child process. It boots the guest, reads the
    //! channel within the frame caps, and writes only host-named files into a
    //! fresh output directory; this side reads them back within the same caps.

    use std::ffi::OsString;
    use std::io::Read;
    use std::path::{Path, PathBuf};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};

    use serde_json::Value;

    use super::{BuildControl, Done, VerifiedHostHelper, VerifiedRuntimeImage, WorkerError, WorkerLimits};

    const POLL: Duration = Duration::from_millis(100);
    /// The helper's `result.json`: its outcome, a bounded error, and timings.
    const RESULT_CAP: u64 = 1 << 20;

    /// A private directory for one helper run, removed when dropped.
    pub(super) struct Scratch(tempfile::TempDir);

    impl Scratch {
        pub(super) fn new() -> Result<Self, WorkerError> {
            tempfile::Builder::new()
                .prefix("m3d-cad-")
                .tempdir()
                .map(Self)
                .map_err(|e| WorkerError::Internal(format!("scratch directory: {e}")))
        }

        pub(super) fn write(&self, name: &str, data: &[u8]) -> Result<PathBuf, WorkerError> {
            let path = self.0.path().join(name);
            std::fs::write(&path, data).map_err(|e| WorkerError::Internal(format!("{name}: {e}")))?;
            Ok(path)
        }

        fn path(&self) -> &Path {
            self.0.path()
        }
    }

    pub(super) struct HelperOutput {
        dir: PathBuf,
        pub(super) result: Value,
    }

    impl HelperOutput {
        /// One output file, refused when it is larger than `cap`.
        pub(super) fn read(&self, name: &str, cap: u32) -> Result<Option<Vec<u8>>, WorkerError> {
            read_capped(&self.dir.join(name), u64::from(cap))
        }

        pub(super) fn done(&self) -> Done {
            Done {
                ok: self.result["outcome"] == "accepted",
                error: self.result["error"].as_str().map(str::to_owned),
            }
        }
    }

    fn read_capped(path: &Path, cap: u64) -> Result<Option<Vec<u8>>, WorkerError> {
        let file = match std::fs::File::open(path) {
            Ok(file) => file,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(e) => return Err(WorkerError::Internal(format!("{}: {e}", path.display()))),
        };
        let mut data = Vec::new();
        file.take(cap + 1)
            .read_to_end(&mut data)
            .map_err(|e| WorkerError::Internal(format!("{}: {e}", path.display())))?;
        if data.len() as u64 > cap {
            return Err(WorkerError::Rejected(format!("{} is over its {cap}-byte cap", path.display())));
        }
        Ok(Some(data))
    }

    /// Runs one helper command to completion, or stops it on cancel or at the
    /// deadline (with a margin for the helper to stop its own VM first).
    pub(super) fn run(
        helper: &VerifiedHostHelper,
        image: &VerifiedRuntimeImage,
        scratch: &Scratch,
        args: &mut Vec<OsString>,
        limits: &WorkerLimits,
        control: &BuildControl<'_>,
    ) -> Result<HelperOutput, WorkerError> {
        let out = scratch.path().join("out");
        args.extend([
            "--runtime".into(),
            image.dir.clone().into_os_string(),
            "--out".into(),
            out.clone().into_os_string(),
            "--deadline-s".into(),
            limits.deadline.as_secs().to_string().into(),
            "--cpus".into(),
            limits.vcpus.to_string().into(),
            "--memory-mib".into(),
            limits.memory_mib.to_string().into(),
        ]);
        let mut child = Command::new(&helper.path)
            .args(args.iter())
            .env_clear()
            .env("TMPDIR", scratch.path())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| WorkerError::Internal(format!("could not start the CAD helper: {e}")))?;
        let stop_at = Instant::now() + limits.deadline + Duration::from_secs(30);
        let status = loop {
            if let Some(status) = child.try_wait().map_err(|e| WorkerError::Internal(e.to_string()))? {
                break status;
            }
            if control.is_cancelled() || Instant::now() >= stop_at {
                let _ = child.kill();
                let _ = child.wait();
                return Err(if control.is_cancelled() { WorkerError::Cancelled } else { WorkerError::Deadline(limits.deadline.as_secs()) });
            }
            std::thread::sleep(POLL);
        };
        let result = read_capped(&out.join("result.json"), RESULT_CAP)?
            .ok_or_else(|| WorkerError::Internal(format!("the CAD helper exited {status} without a result")))?;
        let result: Value = serde_json::from_slice(&result).map_err(|e| WorkerError::Internal(format!("helper result: {e}")))?;
        let error = || super::bounded_error(result["error"].as_str(), "no error given");
        match result["outcome"].as_str() {
            Some("accepted" | "job_failed") => Ok(HelperOutput { dir: out, result }),
            Some("rejected") => Err(WorkerError::Rejected(error())),
            Some("deadline") => Err(WorkerError::Deadline(limits.deadline.as_secs())),
            Some("unverified") => Err(WorkerError::Internal(format!("the runtime failed the helper's check: {}", error()))),
            _ => Err(WorkerError::Internal(error())),
        }
    }
}

// ─── Linux test backend: QEMU microvm ────────────────────────────────────────

/// How the Linux test backend boots a guest.
#[cfg(all(target_os = "linux", feature = "linux-cad-test"))]
#[derive(Debug, Clone)]
pub struct MicroVmConfig {
    /// `qemu-system-x86_64` with KVM; the host needs `/dev/kvm` and
    /// `/dev/vhost-vsock`.
    pub qemu: PathBuf,
}

#[cfg(all(target_os = "linux", feature = "linux-cad-test"))]
mod linux {
    //! One guest under QEMU's microvm machine: a read-only root, a fresh job
    //! disk, no network device, a vsock the guest agent dials once, and a
    //! host-owned deadline. QEMU never ends the VM by itself (the amd64 kernel
    //! has no ACPI, so the agent's power-off only halts it), so the host stops
    //! it after `DONE` or at the deadline.

    use std::io::{self, Read, Write};
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
    use std::process::{Child, Command, Stdio};
    use std::sync::Mutex;
    use std::time::Instant;

    use super::{read_response, write_frame, BuildControl, FrameLimits, MicroVmConfig, ProtocolError, Response, Role, VerifiedRuntimeImage, WorkerError, WorkerLimits};

    /// The port the guest agent dials on the host (CID 2).
    const PORT: u32 = 7000;
    const POLL_MS: i32 = 100;
    /// One guest at a time per process: every guest dials the same host port.
    static PORT_LOCK: Mutex<()> = Mutex::new(());

    pub(super) fn run_guest(
        config: &MicroVmConfig,
        image: &VerifiedRuntimeImage,
        request: &[([u8; 4], Vec<u8>)],
        role: Role,
        limits: &WorkerLimits,
        control: &BuildControl<'_>,
    ) -> Result<Response, WorkerError> {
        let _port = PORT_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        let scratch = tempfile::Builder::new()
            .prefix("m3d-cad-")
            .tempdir()
            .map_err(|e| WorkerError::Internal(format!("scratch directory: {e}")))?;
        let job_disk = scratch.path().join("job.img");
        std::fs::copy(image.file("job.img"), &job_disk).map_err(|e| WorkerError::Internal(format!("job disk: {e}")))?;
        let listener = Listener::bind().map_err(|e| WorkerError::Internal(format!("vsock listener on port {PORT}: {e}")))?;
        let cid = guest_cid();
        let deadline = Instant::now() + limits.deadline;
        let mut vm = Vm::start(config, image, &job_disk, cid, limits)?;

        let stream = loop {
            if control.is_cancelled() {
                return Err(WorkerError::Cancelled);
            }
            if Instant::now() >= deadline {
                return Err(WorkerError::Deadline(limits.deadline.as_secs()));
            }
            if let Some(status) = vm.child.try_wait().map_err(|e| WorkerError::Internal(e.to_string()))? {
                return Err(WorkerError::Internal(format!("QEMU exited {status} before the guest connected: {}", vm.console())));
            }
            match listener.accept(POLL_MS).map_err(|e| WorkerError::Internal(format!("vsock accept: {e}")))? {
                // Only this run's guest may talk to the host; any other peer is refused.
                Some((stream, peer)) if peer == cid => break stream,
                Some(_) | None => {}
            }
        };
        let mut channel = Channel::new(stream, deadline, control).map_err(|e| WorkerError::Internal(format!("vsock: {e}")))?;
        let response = exchange(&mut channel, request, role);
        drop(vm);
        match response {
            Ok(response) => Ok(response),
            Err(_) if channel.cancelled => Err(WorkerError::Cancelled),
            Err(_) if channel.timed_out => Err(WorkerError::Deadline(limits.deadline.as_secs())),
            Err(ProtocolError::Io(e)) => Err(WorkerError::Internal(format!("vsock: {e}"))),
            Err(e) => Err(WorkerError::Rejected(e.to_string())),
        }
    }

    /// A guest CID nothing else on the host is likely to hold.
    fn guest_cid() -> u32 {
        let random = u32::from_le_bytes(uuid::Uuid::new_v4().as_bytes()[..4].try_into().expect("4 bytes"));
        3 + random % 0x3fff_0000
    }

    /// A running QEMU, killed when dropped.
    struct Vm {
        child: Child,
        console: std::sync::Arc<Mutex<Vec<u8>>>,
    }

    impl Vm {
        fn start(
            config: &MicroVmConfig,
            image: &VerifiedRuntimeImage,
            job_disk: &std::path::Path,
            cid: u32,
            limits: &WorkerLimits,
        ) -> Result<Self, WorkerError> {
            let drive = |id: &str, path: &std::path::Path, readonly: bool| {
                format!("id={id},file={},format=raw,if=none{}", path.display(), if readonly { ",readonly=on" } else { "" })
            };
            let mut child = Command::new(&config.qemu)
                // Without ACPI, QEMU lists the virtio-mmio devices on the kernel command line, which is how this
                // kernel finds its disks and vsock.
                .args(["-M", "microvm,acpi=off,x-option-roms=off", "-enable-kvm", "-cpu", "host"])
                .args(["-m", &limits.memory_mib.to_string(), "-smp", &limits.vcpus.to_string()])
                .args(["-nodefaults", "-no-user-config", "-display", "none", "-no-reboot", "-serial", "stdio"])
                .arg("-kernel")
                .arg(image.file("vmlinux"))
                .args(["-append", "console=ttyS0 root=/dev/vda rootfstype=erofs ro init=/opt/m3d/init panic=1 quiet"])
                .args(["-drive", &drive("root", &image.file("rootfs.img"), true), "-device", "virtio-blk-device,drive=root"])
                .args(["-drive", &drive("job", job_disk, false), "-device", "virtio-blk-device,drive=job"])
                .args(["-device", &format!("vhost-vsock-device,guest-cid={cid}")])
                .env_clear()
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .map_err(|e| WorkerError::Internal(format!("could not start {}: {e}", config.qemu.display())))?;
            let console = std::sync::Arc::new(Mutex::new(Vec::new()));
            for stream in [child.stdout.take().map(|s| Box::new(s) as Box<dyn Read + Send>), child.stderr.take().map(|s| Box::new(s) as Box<dyn Read + Send>)]
                .into_iter()
                .flatten()
            {
                let console = console.clone();
                let cap = limits.log;
                std::thread::spawn(move || keep_tail(stream, &console, cap));
            }
            Ok(Self { child, console })
        }

        fn console(&self) -> String {
            let console = self.console.lock().unwrap_or_else(|p| p.into_inner());
            String::from_utf8_lossy(&console).into_owned()
        }
    }

    impl Drop for Vm {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    /// Reads `stream` to its end, keeping only the last `cap` bytes.
    fn keep_tail(mut stream: Box<dyn Read + Send>, console: &Mutex<Vec<u8>>, cap: usize) {
        let mut buf = [0u8; 8192];
        while let Ok(n) = stream.read(&mut buf) {
            if n == 0 {
                break;
            }
            let mut console = console.lock().unwrap_or_else(|p| p.into_inner());
            console.extend_from_slice(&buf[..n]);
            let excess = console.len().saturating_sub(cap);
            console.drain(..excess);
        }
    }

    /// The host end of the guest channel: every read and write waits at most
    /// until the deadline and gives up on cancel. The socket is non-blocking,
    /// so a guest that stops reading or writing can stall a call only until
    /// the next poll, never past the deadline.
    struct Channel<'a> {
        fd: OwnedFd,
        deadline: Instant,
        control: &'a BuildControl<'a>,
        timed_out: bool,
        cancelled: bool,
    }

    impl<'a> Channel<'a> {
        fn new(fd: OwnedFd, deadline: Instant, control: &'a BuildControl<'a>) -> io::Result<Self> {
            // SAFETY: fcntl on a descriptor this function owns.
            unsafe {
                let flags = libc::fcntl(fd.as_raw_fd(), libc::F_GETFL);
                if flags < 0 || libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) < 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            Ok(Self { fd, deadline, control, timed_out: false, cancelled: false })
        }

        /// Runs `op` once the socket is ready for `events`, again whenever it
        /// would block, until it succeeds, fails, or the wait gives up.
        fn ready(&mut self, events: i16, mut op: impl FnMut(RawFd) -> isize) -> io::Result<usize> {
            loop {
                self.wait(events)?;
                let n = op(self.fd.as_raw_fd());
                if n >= 0 {
                    return Ok(n as usize);
                }
                let err = io::Error::last_os_error();
                if !matches!(err.kind(), io::ErrorKind::WouldBlock | io::ErrorKind::Interrupted) {
                    return Err(err);
                }
            }
        }

        /// Fails once the build is cancelled or the deadline has passed. Asked
        /// before every poll, after every wakeup, and before a response is
        /// accepted, so a cancel or an expired deadline always wins.
        fn still_wanted(&mut self) -> io::Result<()> {
            if self.control.is_cancelled() {
                self.cancelled = true;
                return Err(io::Error::other("cancelled"));
            }
            if Instant::now() >= self.deadline {
                self.timed_out = true;
                return Err(io::Error::new(io::ErrorKind::TimedOut, "deadline"));
            }
            Ok(())
        }

        fn wait(&mut self, events: i16) -> io::Result<()> {
            loop {
                self.still_wanted()?;
                let left = self.deadline.saturating_duration_since(Instant::now());
                let timeout = i32::try_from(left.as_millis()).unwrap_or(i32::MAX).clamp(1, POLL_MS);
                let ready = poll(self.fd.as_raw_fd(), events, timeout)?;
                self.still_wanted()?;
                if ready {
                    return Ok(());
                }
            }
        }
    }

    /// Sends `request` and reads the guest's response. The response counts
    /// only if the build is still wanted once DONE has arrived.
    fn exchange(channel: &mut Channel<'_>, request: &[([u8; 4], Vec<u8>)], role: Role) -> Result<Response, ProtocolError> {
        request.iter().try_for_each(|(tag, payload)| write_frame(channel, tag, payload))?;
        let response = read_response(channel, role, &FrameLimits::PART)?;
        channel.still_wanted()?;
        Ok(response)
    }

    impl Read for Channel<'_> {
        fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
            // SAFETY: `buf` is valid for `buf.len()` bytes and the fd is open.
            self.ready(libc::POLLIN, |fd| unsafe { libc::read(fd, buf.as_mut_ptr().cast(), buf.len()) })
        }
    }

    impl Write for Channel<'_> {
        fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
            // SAFETY: `buf` is valid for `buf.len()` bytes and the fd is open.
            self.ready(libc::POLLOUT, |fd| unsafe { libc::write(fd, buf.as_ptr().cast(), buf.len()) })
        }

        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }

    /// True when `fd` is ready for `events` within `timeout_ms`.
    fn poll(fd: RawFd, events: i16, timeout_ms: i32) -> io::Result<bool> {
        let mut pfd = libc::pollfd { fd, events, revents: 0 };
        // SAFETY: one valid pollfd.
        let n = unsafe { libc::poll(&mut pfd, 1, timeout_ms) };
        match n {
            n if n < 0 => {
                let err = io::Error::last_os_error();
                if err.kind() == io::ErrorKind::Interrupted { Ok(false) } else { Err(err) }
            }
            0 => Ok(false),
            _ => Ok(true),
        }
    }

    /// A vsock listener on the host's port 7000, for any guest CID.
    struct Listener(OwnedFd);

    impl Listener {
        fn bind() -> io::Result<Self> {
            // SAFETY: plain socket calls on a fd this function owns.
            unsafe {
                let fd = libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0);
                if fd < 0 {
                    return Err(io::Error::last_os_error());
                }
                let fd = OwnedFd::from_raw_fd(fd);
                let mut addr: libc::sockaddr_vm = std::mem::zeroed();
                addr.svm_family = libc::AF_VSOCK as libc::sa_family_t;
                addr.svm_port = PORT;
                addr.svm_cid = libc::VMADDR_CID_ANY;
                let len = std::mem::size_of::<libc::sockaddr_vm>() as libc::socklen_t;
                if libc::bind(fd.as_raw_fd(), (&raw const addr).cast(), len) != 0 || libc::listen(fd.as_raw_fd(), 4) != 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(Self(fd))
            }
        }

        /// The next connection and its peer CID, if one arrives within `timeout_ms`.
        fn accept(&self, timeout_ms: i32) -> io::Result<Option<(OwnedFd, u32)>> {
            if !poll(self.0.as_raw_fd(), libc::POLLIN, timeout_ms)? {
                return Ok(None);
            }
            // SAFETY: `addr` and `len` describe a valid sockaddr_vm buffer.
            unsafe {
                let mut addr: libc::sockaddr_vm = std::mem::zeroed();
                let mut len = std::mem::size_of::<libc::sockaddr_vm>() as libc::socklen_t;
                let fd = libc::accept4(self.0.as_raw_fd(), (&raw mut addr).cast(), &mut len, libc::SOCK_CLOEXEC);
                if fd < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(Some((OwnedFd::from_raw_fd(fd), addr.svm_cid)))
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        use std::time::Duration;

        /// Both ends of a local stream socket; only the first goes into a channel.
        fn socket_pair() -> (OwnedFd, OwnedFd) {
            let mut fds = [0; 2];
            // SAFETY: `fds` is a valid two-element array for socketpair(2).
            let rc = unsafe { libc::socketpair(libc::AF_UNIX, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0, fds.as_mut_ptr()) };
            assert_eq!(rc, 0, "{}", io::Error::last_os_error());
            // SAFETY: socketpair returned two fresh descriptors this test owns.
            unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) }
        }

        /// A guest that never reads fills the socket buffer; the host's write
        /// still gives up at the deadline instead of blocking past it.
        #[test]
        fn a_peer_that_never_reads_cannot_hold_a_write_past_the_deadline() {
            let (host, _guest) = socket_pair();
            let control = BuildControl::new(&|_| {}, &|| false);
            let deadline = Instant::now() + Duration::from_millis(100);
            let mut channel = Channel::new(host, deadline, &control).expect("channel");
            let started = Instant::now();
            let result = write_frame(&mut channel, b"INPT", &vec![0u8; 64 << 20]);
            assert!(result.is_err(), "64 MiB cannot fit an unread socket");
            assert!(channel.timed_out, "the deadline ended the write");
            assert!(started.elapsed() < Duration::from_millis(100 + 2 * POLL_MS as u64 + 100), "{:?}", started.elapsed());
        }

        #[test]
        fn cancelling_ends_a_write_to_a_peer_that_never_reads() {
            let (host, _guest) = socket_pair();
            let cancel = std::sync::atomic::AtomicBool::new(false);
            let cancelled = || cancel.load(std::sync::atomic::Ordering::SeqCst);
            let control = BuildControl::new(&|_| {}, &cancelled);
            let mut channel = Channel::new(host, Instant::now() + Duration::from_secs(60), &control).expect("channel");
            std::thread::scope(|scope| {
                scope.spawn(|| {
                    std::thread::sleep(Duration::from_millis(100));
                    cancel.store(true, std::sync::atomic::Ordering::SeqCst);
                });
                let started = Instant::now();
                assert!(write_frame(&mut channel, b"INPT", &vec![0u8; 64 << 20]).is_err());
                assert!(channel.cancelled && !channel.timed_out);
                assert!(started.elapsed() < Duration::from_secs(2), "{:?}", started.elapsed());
            });
        }

        /// A whole, valid response, DONE included.
        fn done_frames() -> Vec<u8> {
            let mut bytes = Vec::new();
            write_frame(&mut bytes, b"STEP", b"ISO-10303-21;").expect("frame");
            write_frame(&mut bytes, b"MANI", br#"{"bodies":[{"name":"a","slot":1}]}"#).expect("frame");
            write_frame(&mut bytes, b"DONE", br#"{"ok":true,"error":null}"#).expect("frame");
            bytes
        }

        /// The guest sends all of `frames` but the last byte at once, and that
        /// byte after `delay`: the host is waiting for it when time runs out.
        fn send_later(peer: OwnedFd, delay: Duration, frames: Vec<u8>) -> std::thread::JoinHandle<OwnedFd> {
            std::thread::spawn(move || {
                let mut file = std::fs::File::from(peer);
                let (head, last) = frames.split_at(frames.len() - 1);
                file.write_all(head).expect("guest write");
                std::thread::sleep(delay);
                file.write_all(last).expect("guest write");
                OwnedFd::from(file)
            })
        }

        /// A whole DONE that arrives after the deadline is not accepted.
        #[test]
        fn a_response_that_arrives_after_the_deadline_is_refused() {
            let (host, guest) = socket_pair();
            let control = BuildControl::new(&|_| {}, &|| false);
            let mut channel = Channel::new(host, Instant::now() + Duration::from_millis(50), &control).expect("channel");
            let sender = send_later(guest, Duration::from_millis(80), done_frames());
            let result = exchange(&mut channel, &[], Role::Generate);
            assert!(result.is_err() && channel.timed_out, "{result:?}");
            let _guest = sender.join().expect("guest");
            // Already in the buffer, and the deadline long past: still refused.
            let (host, guest) = socket_pair();
            let _guest = send_later(guest, Duration::ZERO, done_frames()).join().expect("guest");
            let mut channel = Channel::new(host, Instant::now() - Duration::from_millis(1), &control).expect("channel");
            assert!(exchange(&mut channel, &[], Role::Generate).is_err() && channel.timed_out);
        }

        /// A cancel that lands while the host waits wins over the DONE that follows it.
        #[test]
        fn a_response_after_a_cancel_is_refused() {
            let (host, guest) = socket_pair();
            let cancel = std::sync::atomic::AtomicBool::new(false);
            let cancelled = || cancel.load(std::sync::atomic::Ordering::SeqCst);
            let control = BuildControl::new(&|_| {}, &cancelled);
            let mut channel = Channel::new(host, Instant::now() + Duration::from_secs(10), &control).expect("channel");
            std::thread::scope(|scope| {
                scope.spawn(|| {
                    std::thread::sleep(Duration::from_millis(30));
                    cancel.store(true, std::sync::atomic::Ordering::SeqCst);
                });
                let sender = send_later(guest, Duration::from_millis(60), done_frames());
                let result = exchange(&mut channel, &[], Role::Generate);
                assert!(result.is_err() && channel.cancelled, "{result:?}");
                let _guest = sender.join().expect("guest");
            });
            // A cancel after the last byte arrived, before acceptance, also wins.
            let (host, guest) = socket_pair();
            let _guest = send_later(guest, Duration::ZERO, done_frames()).join().expect("guest");
            // Cancelled once the host has read every byte: after DONE, before acceptance.
            let raw = host.as_raw_fd();
            let late = || {
                let mut unread: libc::c_int = 0;
                // SAFETY: FIONREAD writes one int; the descriptor stays open for the test.
                unsafe { libc::ioctl(raw, libc::FIONREAD, &mut unread) };
                unread == 0
            };
            let control = BuildControl::new(&|_| {}, &late);
            let mut channel = Channel::new(host, Instant::now() + Duration::from_secs(10), &control).expect("channel");
            assert!(exchange(&mut channel, &[], Role::Generate).is_err() && channel.cancelled);
        }

    }
}

#[cfg(test)]
mod tests;
