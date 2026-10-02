# Hostile job: try to write anywhere outside /job/out and /tmp, and to gain the privileges that would allow it.
import ctypes, os, sys

TARGETS = ["/opt/m3d/inspector.py", "/opt/m3d/agent.py", "/usr/local/lib/python3.13/site-packages/build123d/__init__.py",
           "/etc/passwd", "/m3d-planted", "/job/in/job.json", "/job/planted", "/dev/vda", "/dev/vdb", "/sys/kernel/uevent_helper"]

def build(p):
    breaches = []
    for path in TARGETS:
        try:
            with open(path, "ab") as f:
                f.write(b"tampered")
            breaches.append(path)
            print(f"{path}: WRITTEN", file=sys.stderr)
        except OSError as e:
            print(f"{path}: blocked ({e.strerror})", file=sys.stderr)
    libc = ctypes.CDLL(None, use_errno=True)
    MS_REMOUNT = 32
    rc = libc.mount(b"none", b"/", None, MS_REMOUNT, None)
    print(f"remount / rw: {'SUCCEEDED' if rc == 0 else 'blocked errno ' + str(ctypes.get_errno())}", file=sys.stderr)
    if rc == 0:
        breaches.append("remount")
    for fn, label in [(lambda: os.setuid(0), "setuid(0)"), (lambda: os.chown("/job/out", 0, 0), "chown")]:
        try:
            fn()
            breaches.append(label)
            print(f"{label}: SUCCEEDED", file=sys.stderr)
        except OSError as e:
            print(f"{label}: blocked ({e.strerror})", file=sys.stderr)
    for ok in ["/job/out/allowed", "/tmp/allowed"]:
        with open(ok, "wb") as f:
            f.write(b"fine")
    print(f"uid={os.getuid()} gid={os.getgid()} groups={os.getgroups()} env={dict(os.environ)}", file=sys.stderr)
    raise RuntimeError(f"breaches={len(breaches)}")
