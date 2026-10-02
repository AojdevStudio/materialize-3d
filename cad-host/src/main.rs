//! `materialize-cad-host`: the PR 5 spike's signed helper.
//!
//! ```text
//! materialize-cad-host generate --runtime DIR --source FILE --params FILE --out DIR [options]
//! materialize-cad-host inspect  --runtime DIR --step FILE --out DIR [options]
//! materialize-cad-host build    --runtime DIR --source FILE --params FILE --out DIR [options]
//! materialize-cad-host hostile  --runtime DIR --case NAME --out DIR [options]
//! options: --pins FILE (default DIR/pins.json) --deadline-s N --cancel-after-s N --cpus N --memory-mib N
//! ```
//!
//! Every command verifies the runtime files against the pinned sha256 digests before it boots anything, gives each
//! guest a fresh job disk cloned from the template, and writes only host-named files into `--out`: `result.json`
//! always, plus the accepted payloads. `--out` must be absent or empty when the run starts, so every file in it
//! belongs to this run, and a file that cannot be saved fails the run as internal. Exit codes: 0 accepted, 1 the job
//! failed (a bounded, structured error), 2 the guest's output was rejected, 3 deadline or cancel, 4 runtime
//! verification failed, 64 usage, 70 internal.
//! In the shipped app the pins are compiled in; the spike reads them from a file so tests can point at copies.

#[cfg(target_os = "macos")]
mod vm;

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::ExitCode;

use serde::Serialize;
use serde_json::{Value, json};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
enum Outcome {
    Accepted,
    JobFailed,
    Rejected,
    Deadline,
    Unverified,
    Usage,
    Internal,
}

impl Outcome {
    fn code(self) -> u8 {
        match self {
            Self::Accepted => 0,
            Self::JobFailed => 1,
            Self::Rejected => 2,
            Self::Deadline => 3,
            Self::Unverified => 4,
            Self::Usage => 64,
            Self::Internal => 70,
        }
    }
}

/// A command's verdict: the outcome, a bounded error, and the facts collected on the way.
#[derive(Debug)]
struct Report {
    outcome: Outcome,
    error: Option<String>,
    fields: serde_json::Map<String, Value>,
}

impl Report {
    fn fail(outcome: Outcome, error: impl Into<String>) -> Self {
        Self {
            outcome,
            error: Some(error.into()),
            fields: serde_json::Map::new(),
        }
    }

    /// Fails the run as internal, keeping any earlier error after the new one.
    fn fail_internal(&mut self, error: String) {
        self.error = Some(match self.error.take() {
            Some(earlier) => format!("{error} (after: {earlier})"),
            None => error,
        });
        self.outcome = Outcome::Internal;
    }
}

/// The helper's output directory. A run starts only with it absent or empty, so no earlier run's files can pass for
/// this run's. Files are saved by host-chosen names through `save`, which records any failure; `finish` then fails
/// the run as internal, whatever outcome it had reached.
#[derive(Debug)]
struct OutDir {
    path: PathBuf,
    unsaved: RefCell<Vec<String>>,
}

impl OutDir {
    fn prepare(path: PathBuf) -> Result<Self, Report> {
        let io = |e: std::io::Error| {
            Report::fail(Outcome::Internal, format!("--out {}: {e}", path.display()))
        };
        std::fs::create_dir_all(&path).map_err(io)?;
        if std::fs::read_dir(&path).map_err(io)?.next().is_some() {
            let error = format!(
                "--out {} must be absent or empty, so no earlier run's files can pass for this run's",
                path.display()
            );
            return Err(Report::fail(Outcome::Usage, error));
        }
        Ok(Self {
            path,
            unsaved: RefCell::default(),
        })
    }

    /// Saves one output file; a failure fails the run when it finishes.
    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn save(&self, name: &str, data: &[u8]) {
        if let Err(e) = std::fs::write(self.path.join(name), data) {
            self.unsaved.borrow_mut().push(format!("{name}: {e}"));
        }
    }
}

struct Args {
    command: String,
    opts: HashMap<String, String>,
}

impl Args {
    fn parse() -> Result<Self, String> {
        let mut it = std::env::args().skip(1);
        let command = it.next().ok_or("missing command")?;
        let mut opts = HashMap::new();
        while let Some(key) = it.next() {
            let name = key
                .strip_prefix("--")
                .ok_or_else(|| format!("unexpected argument {key}"))?;
            let value = it.next().ok_or_else(|| format!("--{name} needs a value"))?;
            opts.insert(name.to_owned(), value);
        }
        Ok(Self { command, opts })
    }

    fn path(&self, name: &str) -> Result<PathBuf, String> {
        self.opts
            .get(name)
            .map(PathBuf::from)
            .ok_or_else(|| format!("--{name} is required"))
    }

    #[cfg_attr(not(target_os = "macos"), allow(dead_code))]
    fn number(&self, name: &str, default: u64) -> Result<u64, String> {
        self.opts.get(name).map_or(Ok(default), |v| {
            v.parse().map_err(|_| format!("--{name} must be a number"))
        })
    }
}

fn main() -> ExitCode {
    let args = match Args::parse() {
        Ok(args) => args,
        Err(e) => return finish(None, "usage", Report::fail(Outcome::Usage, e)),
    };
    let out = match args.path("out").map(OutDir::prepare) {
        Ok(Ok(out)) => Some(out),
        Ok(Err(report)) => return finish(None, &args.command, report),
        Err(_) => None,
    };
    let report = run(&args, out.as_ref()).unwrap_or_else(|e| Report::fail(Outcome::Usage, e));
    finish(out.as_ref(), &args.command, report)
}

/// Prints the run's result and exits with its outcome's code.
fn finish(out: Option<&OutDir>, command: &str, report: Report) -> ExitCode {
    let (outcome, text) = conclude(out, command, report);
    println!("{text}");
    ExitCode::from(outcome.code())
}

/// Settles the final outcome and saves `result.json`. Any output file that could not be saved, `result.json`
/// included, turns the outcome into internal. Returns the outcome and the JSON text to print.
fn conclude(out: Option<&OutDir>, command: &str, mut report: Report) -> (Outcome, String) {
    let render = |report: &Report| {
        let mut doc =
            json!({ "command": command, "outcome": report.outcome, "error": report.error });
        doc.as_object_mut()
            .expect("object")
            .extend(report.fields.clone());
        serde_json::to_string_pretty(&doc).expect("serializable")
    };
    let Some(out) = out else {
        return (report.outcome, render(&report));
    };
    let unsaved = out.unsaved.take();
    if !unsaved.is_empty() {
        report.fail_internal(format!("could not save {}", unsaved.join("; ")));
    }
    let text = render(&report);
    match std::fs::write(out.path.join("result.json"), &text) {
        Ok(()) => (report.outcome, text),
        Err(e) => {
            report.fail_internal(format!("could not save result.json: {e}"));
            (report.outcome, render(&report))
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn run(_args: &Args, _out: Option<&OutDir>) -> Result<Report, String> {
    Ok(Report::fail(
        Outcome::Internal,
        "the VM helper runs only on macOS; the protocol library is portable",
    ))
}

#[cfg(target_os = "macos")]
fn run(args: &Args, out: Option<&OutDir>) -> Result<Report, String> {
    use cad_host::frame::{FrameLimits, Role};

    let out = out.ok_or("--out is required")?;
    let runtime = Runtime::open(args)?;
    let limits = VmLimits::from_args(args)?;
    let job = match args.command.as_str() {
        "generate" | "build" => Some(generate_request(args)?),
        "inspect" | "hostile" => None,
        other => return Err(format!("unknown command {other}")),
    };
    let step = match args.command.as_str() {
        "inspect" => Some(std::fs::read(args.path("step")?).map_err(|e| format!("--step: {e}"))?),
        _ => None,
    };
    let case = args.opts.get("case");
    if args.command == "hostile" && case.is_none() {
        return Err("--case is required".into());
    }
    if let Err(report) = runtime.verify() {
        return Ok(report);
    }
    Ok(match (args.command.as_str(), job, step) {
        ("generate", Some(job), _) => runtime.generate(job, &limits, out).0,
        ("inspect", _, Some(step)) => runtime.inspect(step, &limits, out, None),
        ("build", Some(job), _) => {
            let (generated, accepted) = runtime.generate(job, &limits, out);
            let Some((step, manifest)) = accepted else {
                return Ok(generated);
            };
            let mut inspected = runtime.inspect(step, &limits, out, Some(&manifest));
            let guests = [generated.fields.get("guest"), inspected.fields.get("guest")]
                .map(|g| g.cloned().unwrap_or(Value::Null));
            inspected.fields.remove("guest");
            inspected
                .fields
                .insert("guests".into(), Value::Array(guests.into()));
            inspected
        }
        _ => {
            // A stand-in for a fully compromised inspection guest; see cad-runtime/test/hostile-guest.c.
            let cfg = vm::GuestConfig {
                kernel: runtime.file("Image"),
                initrd: Some(runtime.file("hostile-initramfs.cpio")),
                cmdline: format!(
                    "console=hvc0 rdinit=/init panic=1 m3d.case={}",
                    case.expect("checked")
                ),
                ..limits.guest()
            };
            let request = vec![
                (*b"JOBS", br#"{"role":"inspect","timeout_s":10}"#.to_vec()),
                (*b"INPT", b"ISO-10303-21;".to_vec()),
            ];
            let outcome = vm::run_guest(&cfg, request, Role::Inspect, FrameLimits::SPIKE);
            finish_inspect(outcome, out, None, None)
        }
    })
}

/// The job spec the generation guest receives.
#[cfg(target_os = "macos")]
fn generate_request(args: &Args) -> Result<Value, String> {
    let source =
        std::fs::read_to_string(args.path("source")?).map_err(|e| format!("--source: {e}"))?;
    let params = std::fs::read(args.path("params")?).map_err(|e| format!("--params: {e}"))?;
    let params: Value = serde_json::from_slice(&params).map_err(|e| format!("--params: {e}"))?;
    Ok(json!({ "role": "generate", "source": source, "params": params }))
}

/// Fixed CPUs, memory, and deadline per guest (`WorkerLimits` in the design).
#[cfg(target_os = "macos")]
struct VmLimits {
    cpus: usize,
    memory_mib: u64,
    deadline_s: u64,
    cancel_after_s: Option<u64>,
}

#[cfg(target_os = "macos")]
impl VmLimits {
    fn from_args(args: &Args) -> Result<Self, String> {
        Ok(Self {
            cpus: usize::try_from(args.number("cpus", 2)?).map_err(|_| "--cpus is too large")?,
            memory_mib: args.number("memory-mib", 2048)?,
            deadline_s: args.number("deadline-s", 120)?,
            cancel_after_s: args
                .opts
                .contains_key("cancel-after-s")
                .then(|| args.number("cancel-after-s", 0))
                .transpose()?,
        })
    }

    /// The guest-side soft timeout: a little under the host deadline, so an honest guest reports first.
    fn guest_timeout_s(&self) -> u64 {
        self.deadline_s.saturating_sub(5).max(1)
    }

    fn guest(&self) -> vm::GuestConfig {
        vm::GuestConfig {
            kernel: PathBuf::new(),
            initrd: None,
            disks: Vec::new(),
            cmdline: String::new(),
            cpus: self.cpus,
            memory_bytes: self.memory_mib << 20,
            deadline: std::time::Duration::from_secs(self.deadline_s),
            cancel_after: self.cancel_after_s.map(std::time::Duration::from_secs),
            console_cap: 64 << 10,
        }
    }
}

/// The runtime directory and the digests it must match.
#[cfg(target_os = "macos")]
struct Runtime {
    dir: PathBuf,
    pins: Vec<(String, String)>,
}

#[cfg(target_os = "macos")]
impl Runtime {
    fn open(args: &Args) -> Result<Self, String> {
        let dir = args.path("runtime")?;
        let pins_path = args
            .opts
            .get("pins")
            .map_or_else(|| dir.join("pins.json"), PathBuf::from);
        let pins = std::fs::read(&pins_path).map_err(|e| format!("pins: {e}"))?;
        let pins: Value = serde_json::from_slice(&pins).map_err(|e| format!("pins: {e}"))?;
        let pins = pins["files"]
            .as_object()
            .ok_or("pins: no files")?
            .iter()
            .map(|(name, v)| {
                Ok((
                    name.clone(),
                    v["sha256"]
                        .as_str()
                        .ok_or("pins: missing sha256")?
                        .to_owned(),
                ))
            })
            .collect::<Result<_, String>>()?;
        Ok(Self { dir, pins })
    }

    fn file(&self, name: &str) -> PathBuf {
        self.dir.join(name)
    }

    /// Hashes every pinned file; any mismatch or missing file refuses the whole runtime.
    fn verify(&self) -> Result<(), Report> {
        use sha2::{Digest, Sha256};
        let started = std::time::Instant::now();
        for (name, want) in &self.pins {
            let unverified =
                |e: std::io::Error| Report::fail(Outcome::Unverified, format!("{name}: {e}"));
            let mut file = std::fs::File::open(self.file(name)).map_err(unverified)?;
            let mut hasher = Sha256::new();
            std::io::copy(&mut file, &mut hasher).map_err(unverified)?;
            let got = format!("{:x}", hasher.finalize());
            if &got != want {
                return Err(Report::fail(
                    Outcome::Unverified,
                    format!("{name}: sha256 {got} does not match the pin {want}"),
                ));
            }
        }
        eprintln!("runtime verified in {} ms", started.elapsed().as_millis());
        Ok(())
    }

    /// A fresh job disk cloned from the template; dropping the guard deletes it.
    fn job_disk(&self) -> Result<JobDisk, Report> {
        static SEQ: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("m3d-job-{}-{seq}", std::process::id()));
        let internal =
            |e: std::io::Error| Report::fail(Outcome::Internal, format!("job disk: {e}"));
        std::fs::create_dir(&dir).map_err(internal)?;
        let disk = JobDisk {
            path: dir.join("job.img"),
            dir,
        };
        std::fs::copy(self.file("job.img"), &disk.path).map_err(internal)?;
        Ok(disk)
    }

    fn guest_config(&self, limits: &VmLimits, disk: &JobDisk) -> vm::GuestConfig {
        vm::GuestConfig {
            kernel: self.file("Image"),
            disks: vec![(self.file("rootfs.img"), true), (disk.path.clone(), false)],
            cmdline:
                "console=hvc0 root=/dev/vda rootfstype=erofs ro init=/opt/m3d/init panic=1 quiet"
                    .into(),
            ..limits.guest()
        }
    }

    /// Runs the model's source in a fresh guest; on success also returns the STEP and the parsed manifest.
    fn generate(
        &self,
        mut job: Value,
        limits: &VmLimits,
        out: &OutDir,
    ) -> (Report, Option<(Vec<u8>, cad_host::manifest::BodyManifest)>) {
        use cad_host::frame::{FrameLimits, Role};
        let disk = match self.job_disk() {
            Ok(disk) => disk,
            Err(report) => return (report, None),
        };
        job["timeout_s"] = json!(limits.guest_timeout_s());
        let request = vec![(*b"JOBS", serde_json::to_vec(&job).expect("json"))];
        let outcome = vm::run_guest(
            &self.guest_config(limits, &disk),
            request,
            Role::Generate,
            FrameLimits::SPIKE,
        );
        let mut report = guest_report("generate", &outcome, Some(&disk), out);
        let Ok(response) = outcome.result else {
            return (report, None);
        };
        if !response.done.ok {
            report.outcome = Outcome::JobFailed;
            report.error = response.done.error.map(|e| e.chars().take(2000).collect());
            return (report, None);
        }
        let (Some(step), Some(manifest)) = (response.step, response.manifest) else {
            report.outcome = Outcome::Rejected;
            report.error = Some("guest claimed success without STEP and manifest".into());
            return (report, None);
        };
        let manifest = match cad_host::manifest::parse_manifest(&manifest) {
            Ok(m) => m,
            Err(e) => {
                report.outcome = Outcome::Rejected;
                report.error = Some(e.to_string());
                return (report, None);
            }
        };
        out.save("generated.step", &step);
        report.fields.insert(
            "manifest".into(),
            serde_json::to_value(&manifest).expect("json"),
        );
        report.fields.insert("step_bytes".into(), json!(step.len()));
        (report, Some((step, manifest)))
    }

    /// Runs only the pinned inspector on untrusted STEP in a fresh guest, then decodes and checks the mesh.
    fn inspect(
        &self,
        step: Vec<u8>,
        limits: &VmLimits,
        out: &OutDir,
        manifest: Option<&cad_host::manifest::BodyManifest>,
    ) -> Report {
        use cad_host::frame::{FrameLimits, Role};
        let disk = match self.job_disk() {
            Ok(disk) => disk,
            Err(report) => return report,
        };
        let job = json!({ "role": "inspect", "timeout_s": limits.guest_timeout_s() });
        let request = vec![
            (*b"JOBS", serde_json::to_vec(&job).expect("json")),
            (*b"INPT", step),
        ];
        let outcome = vm::run_guest(
            &self.guest_config(limits, &disk),
            request,
            Role::Inspect,
            FrameLimits::SPIKE,
        );
        finish_inspect(outcome, out, manifest, Some(&disk))
    }
}

/// Decodes and checks an inspection guest's answer. The mesh is accepted only if it decodes within the limits and
/// its body count matches the manifest; the geometry report says whether it would pass the app's checks.
#[cfg(target_os = "macos")]
fn finish_inspect(
    outcome: vm::GuestOutcome,
    out: &OutDir,
    manifest: Option<&cad_host::manifest::BodyManifest>,
    disk: Option<&JobDisk>,
) -> Report {
    use cad_host::mesh::{MeshLimits, analyze, decode_mesh, weld};
    let mut report = guest_report("inspect", &outcome, disk, out);
    let Ok(response) = outcome.result else {
        return report;
    };
    let reject = |mut report: Report, error: String| {
        report.outcome = Outcome::Rejected;
        report.error = Some(error);
        report
    };
    if !response.done.ok {
        report.outcome = Outcome::JobFailed;
        report.error = response.done.error.map(|e| e.chars().take(2000).collect());
        return report;
    }
    let Some(mesh) = response.mesh else {
        return reject(report, "guest claimed success without a mesh".into());
    };
    let bodies = match decode_mesh(&mesh, &MeshLimits::SPIKE) {
        Ok(bodies) => bodies,
        Err(e) => return reject(report, format!("mesh rejected: {e}")),
    };
    if let Some(manifest) = manifest
        && manifest.bodies.len() != bodies.len()
    {
        let error = format!(
            "inspector found {} bodies; the manifest names {}",
            bodies.len(),
            manifest.bodies.len()
        );
        return reject(report, error);
    }
    let reports: Vec<Value> = bodies
        .iter()
        .enumerate()
        .map(|(i, raw)| {
            let entry = manifest.and_then(|m| m.bodies.get(i));
            json!({ "name": entry.map(|b| b.name.as_str()), "slot": entry.map(|b| b.slot),
                    "raw_vertices": raw.vertices.len(), "mesh": analyze(&weld(raw)) })
        })
        .collect();
    if let Some(step) = &response.step {
        out.save("normalized.step", step);
    }
    out.save("mesh.bin", &mesh);
    report.fields.insert("mesh_bytes".into(), json!(mesh.len()));
    report.fields.insert("bodies".into(), Value::Array(reports));
    report
}

/// A per-guest job disk, deleted when dropped. The host never mounts or reads it.
#[cfg(target_os = "macos")]
struct JobDisk {
    dir: PathBuf,
    path: PathBuf,
}

#[cfg(target_os = "macos")]
impl Drop for JobDisk {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

/// The common part of every guest's result: timings, stats, console, job disk size, and the failure if any.
#[cfg(target_os = "macos")]
fn guest_report(
    role: &str,
    outcome: &vm::GuestOutcome,
    disk: Option<&JobDisk>,
    out: &OutDir,
) -> Report {
    use std::os::unix::fs::MetadataExt;
    out.save(&format!("console-{role}.log"), &outcome.console);
    let mut guest = json!({ "role": role, "timings": outcome.timings, "console_bytes": outcome.console_total_bytes });
    if let Some(meta) = disk.and_then(|d| std::fs::metadata(&d.path).ok()) {
        let path = disk.map(|d| d.path.display().to_string());
        guest["job_disk"] =
            json!({ "path": path, "bytes": meta.len(), "allocated_bytes": meta.blocks() * 512 });
    }
    if let Ok(response) = &outcome.result {
        if let Some(stats) = response
            .stats
            .as_deref()
            .and_then(|s| serde_json::from_slice::<Value>(s).ok())
        {
            guest["stats"] = stats;
        }
        if let Some(diag) = &response.diagnostics {
            out.save(&format!("diagnostics-{role}.txt"), diag);
            guest["diagnostics_bytes"] = json!(diag.len());
        }
    }
    let mut report = match &outcome.result {
        Ok(_) => Report {
            outcome: Outcome::Accepted,
            error: None,
            fields: serde_json::Map::new(),
        },
        Err(e @ (vm::GuestError::Deadline(_) | vm::GuestError::Cancelled)) => {
            Report::fail(Outcome::Deadline, e.to_string())
        }
        Err(e @ vm::GuestError::Protocol(_)) => Report::fail(Outcome::Rejected, e.to_string()),
        Err(e @ vm::GuestError::StoppedEarly) => Report::fail(Outcome::JobFailed, e.to_string()),
        Err(e) => Report::fail(Outcome::Internal, e.to_string()),
    };
    report.fields.insert("guest".into(), guest);
    report
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A path under the temp dir that does not exist yet, unique to this test process and `name`.
    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!("cad-host-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        path
    }

    fn accepted() -> Report {
        Report {
            outcome: Outcome::Accepted,
            error: None,
            fields: serde_json::Map::new(),
        }
    }

    fn saved_result(dir: &std::path::Path) -> Value {
        serde_json::from_slice(&std::fs::read(dir.join("result.json")).unwrap()).unwrap()
    }

    #[test]
    fn a_reused_output_directory_is_refused_before_anything_runs() {
        let dir = scratch("reused");
        std::fs::create_dir_all(dir.join("mesh.bin")).unwrap();
        let report = OutDir::prepare(dir.clone()).unwrap_err();
        assert_eq!(report.outcome, Outcome::Usage);
        assert!(report.error.unwrap().contains("must be absent or empty"));
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_artifact_that_cannot_be_saved_fails_an_accepted_run() {
        let dir = scratch("artifact");
        let out = OutDir::prepare(dir.clone()).unwrap();
        // The required artifact's path is taken by a directory, so the save fails without relying on permissions.
        std::fs::create_dir(dir.join("mesh.bin")).unwrap();
        out.save("mesh.bin", b"M3DMESH1");
        let (outcome, text) = conclude(Some(&out), "build", accepted());
        assert_eq!((outcome, outcome.code()), (Outcome::Internal, 70));
        let saved = saved_result(&dir);
        assert_eq!(saved["outcome"], "internal");
        assert!(
            saved["error"]
                .as_str()
                .unwrap()
                .starts_with("could not save mesh.bin: ")
        );
        assert_eq!(serde_json::from_str::<Value>(&text).unwrap(), saved);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn a_result_that_cannot_be_saved_fails_the_run() {
        let dir = scratch("result");
        let out = OutDir::prepare(dir.clone()).unwrap();
        std::fs::create_dir(dir.join("result.json")).unwrap();
        let (outcome, text) = conclude(Some(&out), "build", accepted());
        assert_eq!(outcome, Outcome::Internal);
        let printed: Value = serde_json::from_str(&text).unwrap();
        assert_eq!(printed["outcome"], "internal");
        assert!(
            printed["error"]
                .as_str()
                .unwrap()
                .starts_with("could not save result.json: ")
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_accepted_run_with_every_file_saved_stays_accepted() {
        let dir = scratch("clean");
        let out = OutDir::prepare(dir.clone()).unwrap();
        out.save("mesh.bin", b"M3DMESH1");
        let (outcome, _) = conclude(Some(&out), "build", accepted());
        assert_eq!(outcome, Outcome::Accepted);
        assert_eq!(saved_result(&dir)["outcome"], "accepted");
        assert_eq!(std::fs::read(dir.join("mesh.bin")).unwrap(), b"M3DMESH1");
        std::fs::remove_dir_all(dir).unwrap();
    }
}
