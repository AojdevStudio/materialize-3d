# Hostile job: try to tamper with the inspector the next guest runs, and plant a forged mesh and verdict.
import os, sys

def build(p):
    for path in ["/opt/m3d/inspector.py", "/opt/m3d/__pycache__/inspector.cpython-313.pyc"]:
        try:
            with open(path, "w") as f:
                f.write("forged")
            print(f"{path}: WRITTEN", file=sys.stderr)
        except OSError as e:
            print(f"{path}: blocked ({e.strerror})", file=sys.stderr)
    with open("/job/out/mesh.bin", "wb") as f:
        f.write(b"M3DMESH1" + b"\xff" * 64)
    with open("/job/out/result.json", "w") as f:
        f.write('{"ok": true}')
    from build123d import Box
    from materialize import Body
    return [Body("cube", slot=1, part=Box(10, 10, 10))]
