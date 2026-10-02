from build123d import *
from materialize import Body

def build(p):
    with BuildPart() as knob:
        with BuildSketch(Plane.XZ) as profile:
            with BuildLine():
                l1 = Line((0, 0), (p["stem_d"] / 2, 0))
                l2 = Line(l1 @ 1, (p["stem_d"] / 2, p["stem_h"]))
                a1 = ThreePointArc(l2 @ 1, (p["head_d"] / 2, p["stem_h"] + p["head_h"] / 2), (p["head_d"] * 0.3, p["stem_h"] + p["head_h"]))
                l3 = Line(a1 @ 1, (0, p["stem_h"] + p["head_h"]))
                Line(l3 @ 1, l1 @ 0)
            make_face()
        revolve(axis=Axis.Z)
        with Locations((0, 0, 0)):
            Hole(radius=p["screw_d"] / 2, depth=p["stem_h"])
    return [Body("knob", slot=1, part=knob.part)]
