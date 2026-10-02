from build123d import *
from materialize import Body

def build(p):
    with BuildPart() as pot:
        Cone(p["bottom_d"] / 2, p["top_d"] / 2, p["height"], align=(Align.CENTER, Align.CENTER, Align.MIN))
        offset(amount=-p["wall"], openings=pot.faces().sort_by(Axis.Z)[-1])
        with Locations(*PolarLocations(p["bottom_d"] / 4, 4)):
            Cylinder(p["hole_d"] / 2, p["wall"] * 3, mode=Mode.SUBTRACT)
    with BuildPart() as saucer:
        Cylinder(p["top_d"] / 2 + 4, p["wall"] + 6, align=(Align.CENTER, Align.CENTER, Align.MIN))
        with Locations((0, 0, p["wall"])):
            Cylinder(p["top_d"] / 2 + 4 - p["wall"], 10, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
    return [Body("pot", slot=1, part=pot.part), Body("saucer", slot=2, part=saucer.part.moved(Location((p["top_d"] + 20, 0, 0))))]
