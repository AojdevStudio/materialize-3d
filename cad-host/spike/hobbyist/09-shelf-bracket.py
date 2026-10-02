from build123d import *
from materialize import Body

def build(p):
    with BuildPart() as bracket:
        Box(p["width"], p["thick"], p["leg"], align=(Align.CENTER, Align.MIN, Align.MIN))
        Box(p["width"], p["leg"], p["thick"], align=(Align.CENTER, Align.MIN, Align.MIN))
        with BuildSketch(Plane.YZ) as gusset:
            Triangle(a=p["leg"] * 0.7, b=p["leg"] * 0.7, C=90, align=(Align.MIN, Align.MIN))
        extrude(amount=p["thick"] / 2, both=True)
        fillet(bracket.edges().filter_by(Axis.X).group_by(Axis.Y)[0].group_by(Axis.Z)[0], radius=0.5)
        with Locations(Plane.XZ):
            with Locations((0, p["leg"] * 0.75)):
                Hole(radius=p["screw_d"] / 2)
        with Locations((0, p["leg"] * 0.75, 0)):
            Hole(radius=p["screw_d"] / 2)
    return [Body("bracket", slot=1, part=bracket.part)]
