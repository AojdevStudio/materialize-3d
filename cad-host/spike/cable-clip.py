from build123d import *
from materialize import Body        # provided by the guest runtime: name, filament slot, solid

def build(p):
    slot = p["cable_d"] + 2 * p["clearance"]
    jaw = p["desk_t"] + p["clearance"]
    top = slot / 2 + p["wall"]                        # channel depth plus a full wall under it
    height = p["wall"] + jaw + top
    with BuildPart() as clip:
        Box(p["span"], p["depth"], height, align=(Align.CENTER, Align.MIN, Align.MIN))
        with Locations((0, p["wall"], p["wall"])):    # the jaw that slides over the desk
            Box(p["span"] + 2, p["depth"], jaw, align=(Align.CENTER, Align.MIN, Align.MIN), mode=Mode.SUBTRACT)
        with GridLocations(p["span"] / p["cables"], 0, p["cables"], 1):
            with Locations((0, p["depth"] / 2, height)):  # cable channels on top
                Cylinder(slot / 2, p["depth"] + 2, rotation=(90, 0, 0), mode=Mode.SUBTRACT)
        fillet(clip.edges().filter_by(Axis.X), radius=p["fillet"])
    return [Body("clip", slot=1, part=clip.part)]
