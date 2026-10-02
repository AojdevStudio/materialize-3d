# Regression job: an error whose text is long or escape-heavy. The guest must return a bounded prefix of it within
# the host's caps, never a generic "job exited" in its place. The case comes from params.
import os


def build(p):
    if p["case"] == "planted":
        # A hostile job can skip the runner: write an oversized verdict (60 KB of UTF-8) directly and exit.
        with open("/job/out/result.json", "w", encoding="utf-8") as f:
            f.write('{"ok": false, "error": "' + "界" * 20000 + '"}')
        os._exit(1)
    raise RuntimeError({"cjk": "界" * 3000, "control": "\x01" * 3000}[p["case"]])
