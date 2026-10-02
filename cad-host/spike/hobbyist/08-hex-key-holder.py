from build123d import *
from materialize import Body

def build(p):
    sizes = p["sizes"]
    length = sum(s + p["gap"] for s in sizes) + p["gap"]
    with BuildPart() as holder:
        Box(length, p["depth"], p["height"], align=(Align.MIN, Align.CENTER, Align.MIN))
        x = p["gap"]
        for s in sizes:
            across_corners = (s + p["clearance"]) / 0.866
            with Locations((x + s / 2, 0, p["height"])):
                with BuildSketch(Plane.XY.offset(0)):
                    RegularPolygon(across_corners / 2, 6)
                extrude(amount=-p["height"] + p["floor"], mode=Mode.SUBTRACT)
            x += s + p["gap"]
    return [Body("holder", slot=1, part=holder.part)]
