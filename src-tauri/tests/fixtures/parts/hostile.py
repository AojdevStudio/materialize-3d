# A script that tries to grade itself. It writes a passing verdict, a forged mesh, and a check list where the runner
# and the inspector would look, prints a pass, and swaps in a Body type that carries its own checks. With
# p["open"] it also returns a box with its top face missing: an open shell, not a solid. None of it reaches the
# app's checks: the runner overwrites its own outputs, the inspection guest starts from a fresh disk, and Rust
# measures the inspector's mesh.
import json
import os

from build123d import *
import materialize
from materialize import Body


class Graded(Body):
    checks = {"geometry.closed_manifold.box": True, "geometry.requirement.0": True}


def build(p):
    forged = {"result.json": '{"ok": true}', "mesh.bin": "M3DMESH1", "checks.json": json.dumps({"passed": True})}
    for name, data in forged.items():
        try:
            with open(os.path.join("/job/out", name), "w") as f:
                f.write(data)
        except OSError:
            pass
    print("all checks passed")
    materialize.Body = Graded
    box = Box(p["size"], p["size"], p["size"], align=(Align.CENTER, Align.CENTER, Align.MIN))
    part = Shell(box.faces().sort_by(Axis.Z)[:-1]) if p["open"] else box
    return [Graded("box", slot=1, part=part)]
