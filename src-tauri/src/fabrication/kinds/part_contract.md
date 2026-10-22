build123d is Python on OpenCascade. The script runs in an isolated Linux VM with no network, no files, and no
host access, under a 120 s deadline and 2 GB of memory.

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
- Declare the person's measurements as `requirements` in final print coordinates, after all cuts, fillets, and
  transforms. Give `span`, `opening`, and `hole` an `axis`. Except `span`, give each a point `at` inside the
  relevant feature, in the gap for `opening`, in the hole for `hole`, in the material for `min_wall`.
  `min_wall` has no `axis`.
- `min_wall` checks a conservative local thickness estimate, the diameter of an enclosed ball containing `at`.
  It cannot certify a directional cross-section or the whole part's minimum. Near a free edge, the estimate can
  approach zero even when a directional section is thick.
- Cover the thinnest remaining regions, including rounded tips and groove margins. Never infer a global minimum
  from local passes. Report the minimum as unverified when the available checks do not establish it.
- The app checks declared requirements on the finished mesh and runs printability heuristics. Your asserts and
  prints never count as checks. A failed declared requirement fails the build. Heuristic warnings for overhangs,
  thin walls, and small bed contact need the person's acceptance. These warnings do not fail the build or replace
  the person's dimensional requirements.
- A failed script returns its error with the line number (stage `generate`); fix it and build again.
- To change a dimension, revise with only the params that change. Patch `source` only to change the shape.
- Fillet or chamfer a block before cutting holes and channels into it: a fillet after the cuts often leaves a
  solid that intersects itself, which fails at stage `generate` with an error that names the body.
