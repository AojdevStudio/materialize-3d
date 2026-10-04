# part

Any solid OpenCascade can model, written as build123d: boxes and cylinders, fillets and chamfers on any edge,
lofts, sweeps, threads, and shells. The app runs the script in an isolated VM, normalizes the solid in a second
VM, measures the mesh, slices it with Bambu Studio, and keeps the STEP inside the print package.

## A worked example: a desk-edge cable clip

Six 4 mm cables on an 18 mm desk, 60 mm wide:

```json
{"schema_version": 1, "title": "Six USB-C desk clip",
 "source": "<the script below>",
 "params": {"cables": 6, "cable_d": 4, "clearance": 0.4, "desk_t": 18, "span": 60,
            "depth": 25, "wall": 3, "fillet": 1.2},
 "requirements": [
   {"measure": "span", "name": "width", "axis": "x", "mm": 60, "tol": 0.2},
   {"measure": "opening", "name": "desk jaw", "axis": "z", "at": [0, 14, 12], "mm": 18.4, "tol": 0.2}],
 "filaments": [{"slot": 1, "name": "Black"}]}
```

```python
from build123d import *
from materialize import Body

def build(p):
    slot = p["cable_d"] + 2 * p["clearance"]
    jaw = p["desk_t"] + p["clearance"]
    top = slot / 2 + p["wall"]
    height = p["wall"] + jaw + top
    with BuildPart() as clip:
        Box(p["span"], p["depth"], height, align=(Align.CENTER, Align.MIN, Align.MIN))
        with Locations((0, p["wall"], p["wall"])):
            Box(p["span"] + 2, p["depth"], jaw, align=(Align.CENTER, Align.MIN, Align.MIN), mode=Mode.SUBTRACT)
        fillet(clip.edges().filter_by(Axis.X), radius=p["fillet"])
        with GridLocations(p["span"] / p["cables"], 0, p["cables"], 1):
            with Locations((0, p["depth"] / 2, height)):
                Cylinder(slot / 2, p["depth"] + 2, rotation=(90, 0, 0), mode=Mode.SUBTRACT)
    return [Body("clip", slot=1, part=clip.part)]
```

The jaw's ceiling hangs over the desk opening, so the build verifies with a `print.overhang.clip` warning: print it
with supports, or on its side.

## Requirements

| measure | means | needs |
|---|---|---|
| `span` | overall extent along `axis` | `axis`, `mm`, `tol` |
| `opening` | width of the empty gap along `axis` through `at` | `axis`, `at` in the gap, `mm`, `tol` |
| `hole` | diameter of the hole whose centerline runs along `axis` through `at` | `axis`, `at` in the hole, `mm`, `tol` |
| `min_wall` | the material at `at` is at least `mm` thick | `at` in the material, `mm` |

## Idioms

- `align=(Align.CENTER, Align.MIN, Align.MIN)` puts a box on the bed, centered in x.
- `mode=Mode.SUBTRACT` cuts; `Locations`, `GridLocations`, and `PolarLocations` place repeated features.
- Fillet first, then cut: `fillet(part.edges().filter_by(Axis.Z), radius=r)` on the plain block.
- Threads: sweep a closed trapezoid profile (flat crest) along a `Helix` made inside `BuildLine`, with `is_frenet=True`.
  Keep the tooth narrower than the pitch, or one turn cuts into the next, and let its root reach about 0.15 mm into
  the wall so the two fuse into one solid.
- Print orientation is the script's job: put the largest flat face on z = 0.
