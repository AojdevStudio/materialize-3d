//! macOS VM driver: boots one sealed Linux guest with Apple's Virtualization framework, runs one job over vsock,
//! and always ends with the VM stopped.
//!
//! The guest gets only what `GuestConfig` lists: a kernel, optional initramfs, block disks (the root read-only),
//! a console that the host reads with a cap, an entropy device, and one vsock device. No network device, no
//! directory share, no USB, no graphics. The host listens on one vsock port before boot and accepts exactly one
//! connection, which the guest agent makes before any job code runs; every later connection is refused and
//! counted. Everything Objective-C runs on the main thread, which spins its run loop so the framework's callbacks
//! fire; the channel bytes move on a worker thread through the bounded frame reader. The host's deadline (and
//! cancel) force-stops the VM whatever the guest is doing.

use std::cell::{Cell, RefCell};
use std::io::Read;
use std::os::fd::FromRawFd;
use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant};

use block2::RcBlock;
use cad_host::frame::{self, FrameLimits, ProtocolError, Response, Role};
use objc2::rc::Retained;
use objc2::runtime::{Bool, ProtocolObject};
use objc2::{
    AllocAnyThread, DefinedClass, MainThreadMarker, MainThreadOnly, Message, define_class, msg_send,
};
use objc2_foundation::{
    NSArray, NSDate, NSDefaultRunLoopMode, NSError, NSFileHandle, NSObject, NSObjectProtocol,
    NSRunLoop, NSString, NSURL,
};
use objc2_virtualization::{
    VZDiskImageStorageDeviceAttachment, VZEntropyDeviceConfiguration,
    VZFileHandleSerialPortAttachment, VZLinuxBootLoader, VZSerialPortConfiguration,
    VZSocketDeviceConfiguration, VZStorageDeviceConfiguration, VZVirtioBlockDeviceConfiguration,
    VZVirtioConsoleDeviceSerialPortConfiguration, VZVirtioEntropyDeviceConfiguration,
    VZVirtioSocketConnection, VZVirtioSocketDevice, VZVirtioSocketDeviceConfiguration,
    VZVirtioSocketListener, VZVirtioSocketListenerDelegate, VZVirtualMachine,
    VZVirtualMachineConfiguration, VZVirtualMachineState,
};

/// The one vsock port the host listens on; the guest agent connects to it from inside.
pub const HOST_PORT: u32 = 7000;

pub struct GuestConfig {
    pub kernel: PathBuf,
    pub initrd: Option<PathBuf>,
    /// Block devices in order (`/dev/vda`, `/dev/vdb`, ...) and whether each is read-only.
    pub disks: Vec<(PathBuf, bool)>,
    pub cmdline: String,
    pub cpus: usize,
    pub memory_bytes: u64,
    /// Host-owned: when it passes, the VM is force-stopped.
    pub deadline: Duration,
    /// A build cancelled by the person; the same force-stop, reported separately.
    pub cancel_after: Option<Duration>,
    pub console_cap: usize,
}

#[derive(Debug, thiserror::Error)]
pub enum GuestError {
    #[error("VM configuration rejected: {0}")]
    Config(String),
    #[error("VM did not start: {0}")]
    Start(String),
    #[error("guest stopped before answering")]
    StoppedEarly,
    #[error("host deadline of {0:?} reached")]
    Deadline(Duration),
    #[error("cancelled")]
    Cancelled,
    #[error("guest protocol violation: {0}")]
    Protocol(#[from] ProtocolError),
    /// The host could not confirm the VM stopped, so it may still be running. Replaces any other result.
    #[error("could not confirm the VM stopped: {0}")]
    StopUnconfirmed(String),
}

#[derive(Debug, Default, serde::Serialize)]
pub struct Timings {
    /// `start` call to the framework reporting the VM running.
    pub start_ms: u64,
    /// VM running to the guest agent's connection: the guest's cold boot.
    pub boot_ms: u64,
    /// Connection to DONE: the job itself, as the host sees it.
    pub job_ms: u64,
    /// DONE (or the failure) to the VM stopped.
    pub stop_ms: u64,
    pub total_ms: u64,
    /// Whether the host force-stopped the VM and the framework confirmed it halted.
    pub forced_stop: bool,
    /// The VM's state when the host was done with it. Anything but "stopped" or "error" means it may still run.
    pub final_state: &'static str,
    /// Connections after the agent's, all refused (job code trying to reach the host).
    pub refused_connections: u32,
}

pub struct GuestOutcome {
    pub result: Result<Response, GuestError>,
    pub console: Vec<u8>,
    pub console_total_bytes: u64,
    pub timings: Timings,
}

struct ListenerIvars {
    connection: RefCell<Option<Retained<VZVirtioSocketConnection>>>,
    refused: Cell<u32>,
}

define_class!(
    // SAFETY: NSObject has no subclassing requirements and this class does not implement Drop. The VM runs on
    // the main queue, so the framework calls the delegate on the main thread.
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[name = "M3DCadHostListenerDelegate"]
    #[ivars = ListenerIvars]
    struct ListenerDelegate;

    unsafe impl NSObjectProtocol for ListenerDelegate {}

    unsafe impl VZVirtioSocketListenerDelegate for ListenerDelegate {
        #[unsafe(method(listener:shouldAcceptNewConnection:fromSocketDevice:))]
        fn should_accept(
            &self,
            _listener: &VZVirtioSocketListener,
            connection: &VZVirtioSocketConnection,
            _device: &VZVirtioSocketDevice,
        ) -> Bool {
            let ivars = self.ivars();
            let mut slot = ivars.connection.borrow_mut();
            if slot.is_some() {
                ivars.refused.set(ivars.refused.get() + 1);
                return Bool::NO;
            }
            *slot = Some(connection.retain());
            Bool::YES
        }
    }
);

impl ListenerDelegate {
    fn new(mtm: MainThreadMarker) -> Retained<Self> {
        let this = Self::alloc(mtm).set_ivars(ListenerIvars {
            connection: RefCell::default(),
            refused: Cell::default(),
        });
        // SAFETY: NSObject's designated initializer.
        unsafe { msg_send![super(this), init] }
    }
}

fn ms(d: Duration) -> u64 {
    d.as_millis().try_into().unwrap_or(u64::MAX)
}

fn file_url(path: &Path) -> Retained<NSURL> {
    NSURL::fileURLWithPath(&NSString::from_str(&path.to_string_lossy()))
}

/// Spins the main run loop (so framework callbacks run) until `done` or `until`.
fn spin_until(until: Instant, mut done: impl FnMut() -> bool) -> bool {
    let run_loop = NSRunLoop::currentRunLoop();
    // SAFETY: NSDefaultRunLoopMode is an immutable framework constant.
    let mode = unsafe { NSDefaultRunLoopMode };
    while !done() {
        if Instant::now() >= until {
            return false;
        }
        run_loop.runMode_beforeDate(mode, &NSDate::dateWithTimeIntervalSinceNow(0.005));
    }
    true
}

/// Reads the console pipe into a capped buffer, draining (and counting) the rest so the guest never blocks.
fn console_reader(fd: i32, cap: usize) -> Arc<Mutex<(Vec<u8>, u64)>> {
    // SAFETY: `fd` is the read end of a pipe this module created and hands to this thread alone.
    let mut pipe = unsafe { std::fs::File::from_raw_fd(fd) };
    let shared = Arc::new(Mutex::new((Vec::new(), 0u64)));
    let sink = shared.clone();
    thread::spawn(move || {
        let mut buf = [0u8; 8192];
        while let Ok(n @ 1..) = pipe.read(&mut buf) {
            let mut guard = sink.lock().expect("console lock");
            let (kept, total) = &mut *guard;
            *total += n as u64;
            let room = cap.saturating_sub(kept.len());
            kept.extend_from_slice(&buf[..n.min(room)]);
        }
    });
    shared
}

fn configure(
    cfg: &GuestConfig,
    console_write_fd: i32,
) -> Result<Retained<VZVirtualMachineConfiguration>, GuestError> {
    // SAFETY: framework object construction and setters on fresh objects owned by this function.
    unsafe {
        let boot = VZLinuxBootLoader::initWithKernelURL(
            VZLinuxBootLoader::alloc(),
            &file_url(&cfg.kernel),
        );
        boot.setCommandLine(&NSString::from_str(&cfg.cmdline));
        if let Some(initrd) = &cfg.initrd {
            boot.setInitialRamdiskURL(Some(&file_url(initrd)));
        }
        let config = VZVirtualMachineConfiguration::new();
        config.setBootLoader(Some(&boot));
        config.setCPUCount(cfg.cpus);
        config.setMemorySize(cfg.memory_bytes);

        let mut storage: Vec<Retained<VZStorageDeviceConfiguration>> = Vec::new();
        for (path, read_only) in &cfg.disks {
            let attachment = VZDiskImageStorageDeviceAttachment::initWithURL_readOnly_error(
                VZDiskImageStorageDeviceAttachment::alloc(),
                &file_url(path),
                *read_only,
            )
            .map_err(|e| {
                GuestError::Config(format!("{}: {}", path.display(), e.localizedDescription()))
            })?;
            let device = VZVirtioBlockDeviceConfiguration::initWithAttachment(
                VZVirtioBlockDeviceConfiguration::alloc(),
                &attachment,
            );
            storage.push(device.into_super());
        }
        config.setStorageDevices(&NSArray::from_retained_slice(&storage));

        let handle = NSFileHandle::initWithFileDescriptor_closeOnDealloc(
            NSFileHandle::alloc(),
            console_write_fd,
            true,
        );
        let attachment =
            VZFileHandleSerialPortAttachment::initWithFileHandleForReading_fileHandleForWriting(
                VZFileHandleSerialPortAttachment::alloc(),
                None,
                Some(&handle),
            );
        let serial = VZVirtioConsoleDeviceSerialPortConfiguration::new();
        serial.setAttachment(Some(&attachment));
        let serials: [Retained<VZSerialPortConfiguration>; 1] = [serial.into_super()];
        config.setSerialPorts(&NSArray::from_retained_slice(&serials));

        let entropy: [Retained<VZEntropyDeviceConfiguration>; 1] =
            [VZVirtioEntropyDeviceConfiguration::new().into_super()];
        config.setEntropyDevices(&NSArray::from_retained_slice(&entropy));
        let sockets: [Retained<VZSocketDeviceConfiguration>; 1] =
            [VZVirtioSocketDeviceConfiguration::new().into_super()];
        config.setSocketDevices(&NSArray::from_retained_slice(&sockets));

        config
            .validateWithError()
            .map_err(|e| GuestError::Config(e.localizedDescription().to_string()))?;
        Ok(config)
    }
}

/// Boots the guest, sends `request`, and reads the role's bounded response. Must run on the main thread.
pub fn run_guest(
    cfg: &GuestConfig,
    request: Vec<([u8; 4], Vec<u8>)>,
    role: Role,
    limits: FrameLimits,
) -> GuestOutcome {
    let mtm = MainThreadMarker::new().expect("the VM driver runs on the main thread");
    let started = Instant::now();
    let cancel_at = cfg.cancel_after.map(|d| started + d);
    let stop_at = cancel_at.map_or(started + cfg.deadline, |c| c.min(started + cfg.deadline));
    let stop_reason = || match cancel_at {
        Some(c) if Instant::now() >= c => GuestError::Cancelled,
        _ => GuestError::Deadline(cfg.deadline),
    };
    let mut timings = Timings::default();

    let mut fds = [0i32; 2];
    // SAFETY: `fds` is a valid two-element array for pipe(2).
    if unsafe { libc::pipe(fds.as_mut_ptr()) } != 0 {
        let error =
            GuestError::Config(format!("console pipe: {}", std::io::Error::last_os_error()));
        return GuestOutcome {
            result: Err(error),
            console: Vec::new(),
            console_total_bytes: 0,
            timings,
        };
    }
    let console = console_reader(fds[0], cfg.console_cap);
    let config = match configure(cfg, fds[1]) {
        Ok(config) => config,
        Err(e) => {
            return GuestOutcome {
                result: Err(e),
                console: Vec::new(),
                console_total_bytes: 0,
                timings,
            };
        }
    };
    // SAFETY: created on the main thread, so the VM uses the main queue that `spin_until` services.
    let vm = unsafe { VZVirtualMachine::initWithConfiguration(VZVirtualMachine::alloc(), &config) };
    let delegate = ListenerDelegate::new(mtm);
    // SAFETY: framework calls on the VM's queue; the listener's delegate is weak, so `delegate` outlives the VM's use.
    let device = unsafe {
        let listener = VZVirtioSocketListener::new();
        listener.setDelegate(Some(ProtocolObject::from_ref(&*delegate)));
        let device = vm
            .socketDevices()
            .firstObject()
            .and_then(|d| d.downcast::<VZVirtioSocketDevice>().ok());
        if let Some(device) = &device {
            device.setSocketListener_forPort(&listener, HOST_PORT);
        }
        device
    };

    let result = (|| -> Result<Response, GuestError> {
        device
            .as_ref()
            .ok_or_else(|| GuestError::Config("no vsock device".into()))?;
        let start_result: Rc<RefCell<Option<Result<(), String>>>> = Rc::default();
        let slot = start_result.clone();
        let on_start = RcBlock::new(move |err: *mut NSError| {
            // SAFETY: the framework passes null or an NSError valid for the callback.
            *slot.borrow_mut() = Some(match unsafe { err.as_ref() } {
                None => Ok(()),
                Some(e) => Err(e.localizedDescription().to_string()),
            });
        });
        // SAFETY: called on the VM's queue (main) with a live completion block.
        unsafe { vm.startWithCompletionHandler(&on_start) };
        if !spin_until(stop_at, || start_result.borrow().is_some()) {
            return Err(stop_reason());
        }
        if let Some(Err(e)) = start_result.borrow_mut().take() {
            return Err(GuestError::Start(e));
        }
        let running = Instant::now();
        timings.start_ms = ms(running - started);

        let connected = spin_until(stop_at, || {
            // SAFETY: state is readable on the VM's queue.
            delegate.ivars().connection.borrow().is_some()
                || unsafe { vm.state() } != VZVirtualMachineState::Running
        });
        let Some(connection) = delegate.ivars().connection.borrow().clone() else {
            return Err(if connected {
                GuestError::StoppedEarly
            } else {
                stop_reason()
            });
        };
        let connected = Instant::now();
        timings.boot_ms = ms(connected - running);

        // SAFETY: the connection owns this descriptor until closed; the dup is ours alone.
        let fd = unsafe { libc::dup(connection.fileDescriptor()) };
        if fd < 0 {
            return Err(GuestError::Protocol(std::io::Error::last_os_error().into()));
        }
        // SAFETY: `fd` is a fresh, owned socket descriptor.
        let stream = unsafe { UnixStream::from_raw_fd(fd) };
        let unblock = stream
            .try_clone()
            .map_err(|e| GuestError::Protocol(e.into()))?;
        let (tx, rx) = mpsc::channel();
        thread::spawn(move || {
            let mut stream = stream;
            let outcome = request
                .iter()
                .try_for_each(|(tag, payload)| {
                    frame::write_frame(&mut stream, tag, payload).map_err(ProtocolError::from)
                })
                .and_then(|()| frame::read_response(&mut stream, role, &limits));
            let _ = tx.send(outcome);
        });
        let mut received = None;
        let answered = spin_until(stop_at, || {
            received = rx.try_recv().ok();
            received.is_some()
        });
        // SAFETY: closes the framework's descriptor for this connection; our dup is shut down separately.
        unsafe { connection.close() };
        if !answered {
            let _ = unblock.shutdown(std::net::Shutdown::Both);
            return Err(stop_reason());
        }
        timings.job_ms = ms(connected.elapsed());
        received.expect("answered").map_err(GuestError::Protocol)
    })();

    let done_at = Instant::now();
    // An honest guest powers itself off after DONE; give it a moment, then force-stop. Failures stop at once.
    let grace = if result.is_ok() {
        Duration::from_secs(5)
    } else {
        Duration::ZERO
    };
    let result = match halt(&vm, done_at + grace) {
        Ok(Halt::ByGuest) => result,
        Ok(Halt::Forced) => {
            timings.forced_stop = true;
            result
        }
        Err(e) => Err(GuestError::StopUnconfirmed(match &result {
            Ok(_) => e,
            Err(earlier) => format!("{e} (after: {earlier})"),
        })),
    };
    timings.final_state = state_name(&vm);
    timings.stop_ms = ms(done_at.elapsed());
    timings.refused_connections = delegate.ivars().refused.get();
    drop((vm, config, device));
    // Give the console a moment to drain what the guest wrote before it stopped.
    spin_until(Instant::now() + Duration::from_millis(100), || false);
    let (console, console_total_bytes) = console.lock().map(|g| g.clone()).unwrap_or_default();
    timings.total_ms = ms(started.elapsed());
    GuestOutcome {
        result,
        console,
        console_total_bytes,
        timings,
    }
}

/// How long the host waits for each step of a forced stop.
const STOP_TIMEOUT: Duration = Duration::from_secs(10);

/// How the VM came to a halt.
enum Halt {
    /// The guest powered off (or the VM failed) on its own.
    ByGuest,
    /// The host force-stopped it and the framework confirmed.
    Forced,
}

fn state_name(vm: &VZVirtualMachine) -> &'static str {
    // SAFETY: state is readable on the VM's queue.
    match unsafe { vm.state() } {
        VZVirtualMachineState::Stopped => "stopped",
        VZVirtualMachineState::Running => "running",
        VZVirtualMachineState::Paused => "paused",
        VZVirtualMachineState::Error => "error",
        VZVirtualMachineState::Starting => "starting",
        VZVirtualMachineState::Pausing => "pausing",
        VZVirtualMachineState::Resuming => "resuming",
        VZVirtualMachineState::Stopping => "stopping",
        VZVirtualMachineState::Saving => "saving",
        VZVirtualMachineState::Restoring => "restoring",
        _ => "unknown",
    }
}

/// Whether the VM no longer runs: stopped, or failed (the framework's error state ends execution).
fn halted(vm: &VZVirtualMachine) -> bool {
    matches!(state_name(vm), "stopped" | "error")
}

/// Waits until `grace_until` for the guest to halt, then force-stops the VM without guest cooperation and confirms
/// it halted. A VM that is still starting cannot be stopped yet, so the forced stop first waits (bounded) until the
/// framework allows it. Every wait is bounded; an error means the VM may still be running.
fn halt(vm: &VZVirtualMachine, grace_until: Instant) -> Result<Halt, String> {
    if spin_until(grace_until, || halted(vm)) {
        return Ok(Halt::ByGuest);
    }
    let until = Instant::now() + STOP_TIMEOUT;
    // SAFETY: canStop is readable on the VM's queue.
    if !spin_until(until, || halted(vm) || unsafe { vm.canStop() }) {
        return Err(format!(
            "the VM never became stoppable within {STOP_TIMEOUT:?} (state {})",
            state_name(vm)
        ));
    }
    if halted(vm) {
        return Ok(Halt::ByGuest);
    }
    let completion: Rc<RefCell<Option<Result<(), String>>>> = Rc::default();
    let slot = completion.clone();
    let on_stop = RcBlock::new(move |err: *mut NSError| {
        // SAFETY: the framework passes null or an NSError valid for the callback.
        *slot.borrow_mut() = Some(match unsafe { err.as_ref() } {
            None => Ok(()),
            Some(e) => Err(e.localizedDescription().to_string()),
        });
    });
    // SAFETY: called on the VM's queue with a live completion block; `stop` is the framework's forced stop.
    unsafe { vm.stopWithCompletionHandler(&on_stop) };
    if !spin_until(until, || completion.borrow().is_some()) {
        return Err(format!(
            "the framework did not complete the stop within {STOP_TIMEOUT:?}"
        ));
    }
    if let Some(Err(e)) = completion.borrow_mut().take() {
        return Err(format!("the framework refused the stop: {e}"));
    }
    if !spin_until(until, || halted(vm)) {
        return Err(format!(
            "the stop completed but the VM is {}",
            state_name(vm)
        ));
    }
    Ok(Halt::Forced)
}
