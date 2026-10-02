"""In-guest supervisor (PID 1). Serves exactly one job over vsock, then powers the guest off.

The agent connects to the host on vsock port 7000. Wire format, both directions: frames of a 4-byte ASCII tag, a little-endian u32 length, and that many bytes.
Host to guest: JOBS (JSON job spec), then INPT (the STEP bytes) for an inspect job.
Guest to host: STEP, MANI (generate only), MESH (inspect only), DIAG, STAT, then DONE. The host enforces its own
caps on every frame and trusts none of this; the caps here only keep an honest guest inside them.

The job itself runs as an unprivileged user with an empty environment, no new privileges, and a cgroup that caps
memory and process count. The agent reads the job's outputs by fixed names only, refusing symlinks and anything
that is not a regular file.
"""

import ctypes
import json
import os
import resource
import select
import signal
import socket
import struct
import time

PORT = 7000
HOST_CID = 2
JOB_UID = 1000
JOB_GID = 1000
CGROUP = "/sys/fs/cgroup/job"
PIDS_MAX = 64
MEMORY_RESERVE = 320 << 20  # left for the kernel and this agent
JOBS_MAX = 1 << 20
INPT_MAX = 32 << 20
DIAG_MAX = 16 << 10
OUTPUTS = {  # role -> (output file, frame tag, cap)
    "generate": [("model.step", b"STEP", 32 << 20), ("manifest.json", b"MANI", 64 << 10)],
    "inspect": [("normalized.step", b"STEP", 32 << 20), ("mesh.bin", b"MESH", 64 << 20)],
}
PROGRAMS = {"generate": "/opt/m3d/runner.py", "inspect": "/opt/m3d/inspector.py"}

libc = ctypes.CDLL(None, use_errno=True)
PR_SET_NO_NEW_PRIVS = 38
LINUX_REBOOT_CMD_POWER_OFF = 0x4321FEDC
# The guest has no clock source for wall time and boots at 1970, which OpenCascade's STEP writer rejects. A fixed
# date (2000-01-01) also makes the STEP header identical across builds of the same script.
FIXED_CLOCK = 946684800


def power_off():
    os.sync()
    libc.reboot(LINUX_REBOOT_CMD_POWER_OFF)
    while True:  # PID 1 must never return
        time.sleep(1)


def recv_exact(conn, n):
    buf = bytearray()
    while len(buf) < n:
        chunk = conn.recv(min(n - len(buf), 1 << 20))
        if not chunk:
            raise EOFError("host closed the connection")
        buf += chunk
    return bytes(buf)


def recv_frame(conn, want, cap):
    tag, length = struct.unpack("<4sI", recv_exact(conn, 8))
    if tag != want or length > cap:
        raise ValueError(f"expected {want!r} up to {cap} bytes")
    return recv_exact(conn, length)


def send_frame(conn, tag, payload):
    conn.sendall(struct.pack("<4sI", tag, len(payload)) + payload)


def write_cgroup(name, value):
    with open(os.path.join(CGROUP, name), "w") as f:
        f.write(value)


def read_cgroup(name):
    try:
        with open(os.path.join(CGROUP, name)) as f:
            return f.read()
    except OSError:
        return ""


def mem_total():
    with open("/proc/meminfo") as f:
        for line in f:
            if line.startswith("MemTotal:"):
                return int(line.split()[1]) * 1024
    raise RuntimeError("no MemTotal")


def setup_cgroup():
    with open("/sys/fs/cgroup/cgroup.subtree_control", "w") as f:
        f.write("+memory +pids")
    os.makedirs(CGROUP, exist_ok=True)
    # The guest kernel has no swap, so memory.max is a hard cap on the job's RAM.
    write_cgroup("memory.max", str(max(mem_total() - MEMORY_RESERVE, 256 << 20)))
    write_cgroup("pids.max", str(PIDS_MAX))


def drop_privileges():
    """Runs in the forked child before exec: join the job cgroup, cap resources, become the job user."""
    with open(os.path.join(CGROUP, "cgroup.procs"), "w") as f:
        f.write("0")
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    resource.setrlimit(resource.RLIMIT_NOFILE, (256, 256))
    resource.setrlimit(resource.RLIMIT_FSIZE, (64 << 20, 64 << 20))
    os.setgroups([])
    os.setgid(JOB_GID)
    os.setuid(JOB_UID)
    if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0:
        raise OSError(ctypes.get_errno(), "no_new_privs")
    os.umask(0o077)
    os.chdir("/job/out")


def read_output(path, cap):
    """Reads a job output by fixed name, refusing symlinks, non-regular files, and anything over the cap."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError:
        return None
    try:
        st = os.fstat(fd)
        if not (st.st_mode & 0o170000 == 0o100000) or st.st_size > cap:
            return None
        data = os.read(fd, cap + 1)
        return data if len(data) <= cap else None
    finally:
        os.close(fd)


def run_job(role, timeout_s):
    """Runs the role's program; returns (exit status, stderr tail, wall ms, timed out)."""
    devnull = os.open("/dev/null", os.O_RDWR)
    r, w = os.pipe()
    started = time.monotonic()
    pid = os.fork()
    if pid == 0:
        try:
            os.dup2(devnull, 0)
            os.dup2(devnull, 1)
            os.dup2(w, 2)
            os.closerange(3, 1024)
            drop_privileges()
            os.execve("/usr/local/bin/python3", ["python3", "-I", PROGRAMS[role]], {})
        except BaseException as e:
            os.write(2, f"agent: could not start the job: {type(e).__name__}: {e}".encode())
        finally:
            os._exit(127)
    os.close(w)
    tail = bytearray()
    deadline = started + timeout_s
    timed_out = False
    status = None
    while status is None:
        left = deadline - time.monotonic()
        if left <= 0:
            timed_out = True
            write_cgroup("cgroup.kill", "1")
            _, status = os.waitpid(pid, 0)
            break
        ready, _, _ = select.select([r], [], [], min(left, 0.2))
        if ready:
            chunk = os.read(r, 65536)
            if chunk:
                tail += chunk
                del tail[: max(0, len(tail) - DIAG_MAX)]
        done, st = os.waitpid(pid, os.WNOHANG)
        if done:
            status = st
    # Anything the job forked dies with it; then drain what it wrote before dying.
    write_cgroup("cgroup.kill", "1")
    while select.select([r], [], [], 0.5)[0]:
        chunk = os.read(r, 65536)
        if not chunk:
            break
        tail += chunk
        del tail[: max(0, len(tail) - DIAG_MAX)]
    os.close(r)
    os.close(devnull)
    return status, bytes(tail), int((time.monotonic() - started) * 1000), timed_out


def serve(conn, connect_ms):
    spec = json.loads(recv_frame(conn, b"JOBS", JOBS_MAX))
    role = spec.get("role")
    if role not in PROGRAMS:
        raise ValueError("unknown role")
    timeout_s = float(spec.get("timeout_s", 60))
    os.makedirs("/job/in", mode=0o755, exist_ok=True)
    os.makedirs("/job/out", mode=0o700, exist_ok=True)
    os.chown("/job/out", JOB_UID, JOB_GID)
    if role == "generate":
        job = {"source": spec["source"], "params": spec.get("params", {})}
        data, name = json.dumps(job).encode(), "job.json"
    else:
        data, name = recv_frame(conn, b"INPT", INPT_MAX), "model.step"
    with open(os.path.join("/job/in", name), "wb") as f:
        f.write(data)
    os.chmod(os.path.join("/job/in", name), 0o444)

    setup_cgroup()
    status, diag, wall_ms, timed_out = run_job(role, timeout_s)
    events = read_cgroup("memory.events")
    oom_kills = next((int(l.split()[1]) for l in events.splitlines() if l.startswith("oom_kill ")), 0)
    result = read_output("/job/out/result.json", 4096)
    try:
        result = json.loads(result) if result else {}
    except ValueError:
        result = {}
    if not isinstance(result, dict):
        result = {}

    sent_all = True
    for fname, tag, cap in OUTPUTS[role]:
        payload = read_output(os.path.join("/job/out", fname), cap)
        if payload is None:
            sent_all = False
            continue
        send_frame(conn, tag, payload)
    if diag:
        send_frame(conn, b"DIAG", diag)
    exit_code = os.waitstatus_to_exitcode(status)
    stat = {
        "connect_ms": connect_ms,
        "job_ms": wall_ms,
        "memory_peak": int(read_cgroup("memory.peak").strip() or 0),
        "pids_peak": int(read_cgroup("pids.peak").strip() or 0),
        "oom_kills": oom_kills,
        "exit": exit_code,
    }
    send_frame(conn, b"STAT", json.dumps(stat).encode())
    ok = exit_code == 0 and not timed_out and sent_all and result.get("ok") is True
    if timed_out:
        error = f"job exceeded {timeout_s:g} s"
    elif oom_kills:
        error = "job ran out of memory"
    elif ok:
        error = None
    else:
        error = str(result.get("error") or f"job exited with {exit_code}")[:2000]
    send_frame(conn, b"DONE", json.dumps({"ok": ok, "error": error}).encode())


def main():
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)
    time.clock_settime(time.CLOCK_REALTIME, FIXED_CLOCK)
    # The host listens; the agent connects out once, before any job code runs. The host accepts only this first
    # connection, so a job that later tries to reach the host is refused.
    conn = socket.socket(socket.AF_VSOCK, socket.SOCK_STREAM)
    conn.connect((HOST_CID, PORT))
    with open("/proc/uptime") as f:
        connect_ms = int(float(f.read().split()[0]) * 1000)
    try:
        serve(conn, connect_ms)
    except Exception as e:  # report a bounded, typed failure instead of hanging until the host deadline
        try:
            send_frame(conn, b"DONE", json.dumps({"ok": False, "error": f"agent: {type(e).__name__}: {e}"[:2000]}).encode())
        except OSError:
            pass
    finally:
        conn.close()


if __name__ == "__main__":
    try:
        main()
    finally:
        power_off()
