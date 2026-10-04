part: any solid, written as build123d (Python on OpenCascade). The script runs in an isolated Linux VM with no
network, no files, and no host access, under a 120 s deadline and 2 GB of memory.

Write `build(p)` that returns a list of `Body` values:

```python
from build123d import *
from materialize import Body        # name, filament slot, solid

def build(p):
    with BuildPart() as part:
        Box(p["w"], p["d"], p["h"], align=(Align.CENTER, Align.MIN, Align.MIN))
    return [Body("block", slot=1, part=part.part)]
```

- Millimeters. z = 0 is the bed: the part's lowest point must sit at z = 0, in the orientation it prints in.
- `p` is the spec's `params`. Put every dimension the person might change there; scalars only.
- Each `Body` has a unique name (1 to 64 visible characters) and a filament slot listed in `filaments`.
- Declare the person's measurements as `requirements`. Give each one an axis and, except `span`, a point `at`
  inside the feature: inside the gap for `opening`, inside the hole for `hole`, inside the material for `min_wall`.
  The app measures them on the finished mesh; a missed requirement fails the build.
- The app decides whether the part is good. Your asserts and prints never count as checks. Overhangs, thin walls,
  and small bed contact come back as warnings for the person to accept; they do not fail the build.
- A failed script returns its error with the line number (stage `generate`); fix it and build again.
- Fillet or chamfer a block before cutting holes and channels into it: a fillet after the cuts often leaves a
  solid that intersects itself, which fails the mesh checks.
