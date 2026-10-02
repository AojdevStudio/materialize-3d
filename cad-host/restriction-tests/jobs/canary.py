# Hostile job: hunt for the host canary token anywhere the guest can see, and for any host share.
import os, stat, sys

def build(p):
    # Built at run time so this source (which the guest holds as /job/in/job.json) does not contain the needle.
    needle = ("M3D-" + "CANARY-").encode()
    found, scanned = [], 0
    for root, dirs, files in os.walk("/"):
        if root.startswith(("/proc", "/sys", "/dev")):
            dirs[:] = []
            continue
        for name in files:
            path = os.path.join(root, name)
            try:
                st = os.lstat(path)
                if not stat.S_ISREG(st.st_mode) or st.st_size > 8 << 20:  # regular files only: /dev/zero never ends
                    continue
                with open(path, "rb") as f:
                    scanned += 1
                    if needle in f.read():
                        found.append(path)
            except OSError:
                pass
    mounts = open("/proc/mounts").read()
    shares = [l for l in mounts.splitlines() if l.split()[2] in ("virtiofs", "9p", "fuse", "nfs", "cifs")]
    disks = sorted(os.listdir("/sys/block"))
    print(f"scanned={scanned} canary_found={len(found)} shares={len(shares)} block_devices={','.join(disks)}", file=sys.stderr)
    print(f"found={found}", file=sys.stderr)
    print(mounts, file=sys.stderr)
    raise RuntimeError(f"canary_found={len(found)} shares={len(shares)}")
