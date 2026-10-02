from build123d import *
from materialize import Body

def build(p):
    size = 42 * p["units"] - 0.5
    with BuildPart() as bin_:
        Box(size, size, p["height"], align=(Align.CENTER, Align.CENTER, Align.MIN))
        fillet(bin_.edges().filter_by(Axis.Z), radius=3.75)
        with Locations((0, 0, p["floor"])):
            Box(size - 2 * p["wall"], size - 2 * p["wall"], p["height"], align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
        with Locations((0, 0, 0)):
            Box(size - 7.2, size - 7.2, 4.4, align=(Align.CENTER, Align.CENTER, Align.MAX))
    return [Body("bin", slot=1, part=bin_.part)]
