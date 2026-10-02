# Hostile job: fill every writable place until the guest refuses more bytes.
import errno, os, sys

def fill(directory):
    written, n = 0, 0
    block = b"\xa5" * (1 << 20)
    while True:
        path = os.path.join(directory, f"fill-{n}")
        try:
            with open(path, "wb") as f:
                for _ in range(32):
                    f.write(block)
                    f.flush()
                    written += len(block)
        except OSError as e:
            if e.errno == errno.ENOSPC:
                return written, "ENOSPC"
            if e.errno != errno.EFBIG:
                return written, e.strerror
        n += 1

def build(p):
    for d in ["/job/out", "/tmp"]:
        written, why = fill(d)
        print(f"{d}: wrote {written >> 20} MiB then {why}", file=sys.stderr)
    raise RuntimeError("disk probe finished")
