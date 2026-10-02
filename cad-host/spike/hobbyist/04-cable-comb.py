from build123d import *
from materialize import Body

def build(p):
    pitch = p["cable_d"] + p["tooth"]
    length = pitch * p["count"] + p["tooth"]
    with BuildPart() as comb:
        Box(length, p["depth"], p["height"], align=(Align.MIN, Align.MIN, Align.MIN))
        with Locations(*[(p["tooth"] + i * pitch + p["cable_d"] / 2, p["depth"] / 2, p["height"]) for i in range(p["count"])]):
            Box(p["cable_d"], p["depth"] + 2, p["slot_depth"], align=(Align.CENTER, Align.CENTER, Align.MAX), mode=Mode.SUBTRACT)
        chamfer(comb.edges().filter_by(Axis.Y).group_by(Axis.Z)[-1], length=0.6)
    return [Body("comb", slot=1, part=comb.part)]
