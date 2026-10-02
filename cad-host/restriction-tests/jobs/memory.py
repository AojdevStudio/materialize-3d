# Hostile job: allocate and touch memory until the guest stops it.
import sys

def build(p):
    hoard = []
    while True:
        chunk = bytearray(64 << 20)
        for i in range(0, len(chunk), 4096):
            chunk[i] = 1
        hoard.append(chunk)
        print(f"held {len(hoard) * 64} MiB", file=sys.stderr, flush=True)
