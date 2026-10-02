from build123d import *
from materialize import Body

def build(p):
    with BuildPart() as tag:
        with BuildSketch() as outline:
            RectangleRounded(p["width"], p["height"], radius=4)
        extrude(amount=p["thick"])
        with Locations((-p["width"] / 2 + 5, 0, 0)):
            Hole(radius=2)
    with BuildPart() as text:
        with BuildSketch(Plane.XY.offset(p["thick"])):
            with Locations((4, 0)):
                Text(p["label"], font_size=p["font_size"])
        extrude(amount=p["relief"])
    return [Body("tag", slot=1, part=tag.part), Body("label", slot=2, part=text.part)]
