"""Generation guest program: runs the model's build123d source and exports what it built.

Reads /job/in/job.json ({"source", "params"}), calls build(params), and writes /job/out/model.step (one free
shape per body, in manifest order, each named after its body), /job/out/manifest.json (body names and filament
slots), and /job/out/result.json. A body whose solid intersects itself fails here with an error the script's author
can act on, instead of as an open mesh later. Everything here runs as the unprivileged job user and is untrusted by
the host: the inspection guest re-reads the STEP and the host checks every byte it receives.
"""

import json
import sys
import traceback

from m3d_text import failure_json

MAX_BODIES = 16
MAX_NAME = 64
MAX_SLOT = 16


def fail(message):
    with open("/job/out/result.json", "wb") as f:
        f.write(failure_json(message))  # bounded by encoded bytes, so the agent always reads it
    sys.exit(1)


def script_error(exc):
    """`line 16: fillet: StdFail_NotDone (...)`: the innermost frame of the model's own source, then the error."""
    frames = [f for f in traceback.extract_tb(exc.__traceback__) if f.filename == "<part>"]
    where = f"line {frames[-1].lineno}: " if frames else ""
    text = str(exc).strip().splitlines()
    return f"{where}{type(exc).__name__}: {text[0] if text else ''}".strip()


def main():
    with open("/job/in/job.json") as f:
        job = json.load(f)
    namespace = {"__name__": "part"}
    try:
        code = compile(job["source"], "<part>", "exec")
        exec(code, namespace)
        build = namespace.get("build")
        if not callable(build):
            fail("the source defines no build(params) function")
        bodies = build(job["params"])
    except SyntaxError as e:
        fail(f"line {e.lineno}: SyntaxError: {e.msg}")
    except Exception as e:  # the model's error, bounded and structured for its repair turn
        fail(script_error(e))

    from materialize import Body
    from OCP.BRepAlgoAPI import BRepAlgoAPI_Check
    from OCP.TopoDS import TopoDS_Shape
    from step_names import write_named_step

    if not isinstance(bodies, list) or not 1 <= len(bodies) <= MAX_BODIES:
        fail(f"build() must return a list of 1 to {MAX_BODIES} Body values")
    manifest = []
    named = []
    for i, body in enumerate(bodies):
        if not isinstance(body, Body):
            fail(f"build() item {i} is not a Body")
        if not isinstance(body.name, str) or not 1 <= len(body.name) <= MAX_NAME or not body.name.isprintable():
            fail(f"body {i}: name must be 1 to {MAX_NAME} printable characters")
        if not isinstance(body.slot, int) or isinstance(body.slot, bool) or not 1 <= body.slot <= MAX_SLOT:
            fail(f"body {body.name}: slot must be an integer from 1 to {MAX_SLOT}")
        shape = getattr(body.part, "wrapped", body.part)
        if not isinstance(shape, TopoDS_Shape) or shape.IsNull():
            fail(f"body {body.name}: part is not a build123d shape")
        # Self-interference only: small edges are legal, and the host's mesh checks judge the rest.
        if not BRepAlgoAPI_Check(shape, False, True).IsValid():
            fail(
                f"body {body.name}: the solid intersects itself. Fillet or chamfer a block before cutting into it, "
                "and keep repeated features, such as the turns of a thread, from overlapping"
            )
        manifest.append({"name": body.name, "slot": body.slot})
        named.append((body.name, shape))
    if not write_named_step(named, "/job/out/model.step"):
        fail("STEP write failed")
    with open("/job/out/manifest.json", "w") as f:
        json.dump({"bodies": manifest}, f)
    with open("/job/out/result.json", "w") as f:
        json.dump({"ok": True}, f)


if __name__ == "__main__":
    main()
