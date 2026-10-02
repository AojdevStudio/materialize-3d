# Hostile job: fork until the guest says no; every child sleeps forever so nothing frees a slot.
import os, sys, time

def build(p):
    count = 0
    while True:
        try:
            pid = os.fork()
        except OSError as e:
            print(f"fork refused after {count} children: {e.strerror}", file=sys.stderr)
            raise RuntimeError(f"forked={count}")
        if pid == 0:
            while True:
                time.sleep(60)
        count += 1
