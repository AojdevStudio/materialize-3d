from build123d import *
from materialize import Body

def build(p):
    with BuildPart() as stand:
        Box(p["width"], p["base_depth"], p["thick"], align=(Align.CENTER, Align.MIN, Align.MIN))
        with BuildSketch(Plane.YZ) as side:
            with BuildLine():
                Polyline((0, 0), (p["base_depth"] * 0.3, 0), (p["base_depth"] * 0.3 + p["height"] * 0.5, p["height"]),
                         (p["base_depth"] * 0.3 + p["height"] * 0.5 - p["thick"], p["height"]), (0, p["thick"]), close=True)
            make_face()
        extrude(amount=p["width"] / 2, both=True)
        with Locations((0, p["lip"], p["thick"])):
            Box(p["width"], p["thick"], p["lip"], align=(Align.CENTER, Align.MIN, Align.MIN))
    return [Body("stand", slot=1, part=stand.part)]
