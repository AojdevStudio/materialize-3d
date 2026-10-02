from build123d import *
from materialize import Body

def build(p):
    with BuildPart() as hook:
        Box(p["width"], p["thick"], p["plate_h"], align=(Align.CENTER, Align.MIN, Align.MIN))
        Box(p["width"], p["reach"], p["thick"], align=(Align.CENTER, Align.MIN, Align.MIN))
        with Locations((0, p["reach"] - p["thick"], 0)):
            Box(p["width"], p["thick"], p["tip_h"], align=(Align.CENTER, Align.MIN, Align.MIN))
        with Locations(Plane.XZ.offset(0)):
            with Locations((0, p["plate_h"] * 0.35), (0, p["plate_h"] * 0.8)):
                CounterSinkHole(radius=p["screw_d"] / 2, counter_sink_radius=p["screw_d"], depth=p["thick"])
        fillet(hook.edges().filter_by(Axis.X).group_by(Axis.Y)[0], radius=1)
    return [Body("hook", slot=1, part=hook.part)]
