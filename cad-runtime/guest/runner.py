"""Generation guest program: runs the model's build123d source and exports what it built.

Reads /job/in/job.json ({"source", "params"}), calls build(params), and writes /job/out/model.step (one STEP root
per body, in manifest order), /job/out/manifest.json (body names and filament slots), and /job/out/result.json.
Everything here runs as the unprivileged job user and is untrusted by the host: the inspection guest re-reads the
STEP and the host checks every byte it receives.
"""

import json
import sys
import traceback

MAX_BODIES = 16
MAX_NAME = 64
MAX_SLOT = 16


def fail(message):
    with open("/job/out/result.json", "w") as f:
        json.dump({"ok": False, "error": message[:2000]}, f)
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
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Writer
    from OCP.TopoDS import TopoDS_Shape

    if not isinstance(bodies, list) or not 1 <= len(bodies) <= MAX_BODIES:
        fail(f"build() must return a list of 1 to {MAX_BODIES} Body values")
    manifest = []
    writer = STEPControl_Writer()
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
        if writer.Transfer(shape, STEPControl_AsIs) != IFSelect_RetDone:
            fail(f"body {body.name}: STEP transfer failed")
        manifest.append({"name": body.name, "slot": body.slot})
    if writer.Write("/job/out/model.step") != IFSelect_RetDone:
        fail("STEP write failed")
    with open("/job/out/manifest.json", "w") as f:
        json.dump({"bodies": manifest}, f)
    with open("/job/out/result.json", "w") as f:
        json.dump({"ok": True}, f)


if __name__ == "__main__":
    main()
