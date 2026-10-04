# A slab on a post: the slab's underside hangs in the air, so Bambu Studio asks for supports and the app's overhang
# check warns. Both are warnings; the part still verifies.
from build123d import *
from materialize import Body


def build(p):
    with BuildPart() as tee:
        Box(p["post"], p["post"], p["post_h"], align=(Align.CENTER, Align.CENTER, Align.MIN))
        with Locations((0, 0, p["post_h"])):
            Box(p["slab"], p["slab"], p["slab_t"], align=(Align.CENTER, Align.CENTER, Align.MIN))
    return [Body("tee", slot=1, part=tee.part)]
