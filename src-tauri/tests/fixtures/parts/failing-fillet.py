# A fillet larger than the block it rounds: OpenCascade refuses it, and the build fails at stage generate with the
# line number, as a model would read it before repairing the script.
from build123d import *
from materialize import Body


def build(p):
    with BuildPart() as block:
        Box(p["size"], p["size"], p["size"], align=(Align.CENTER, Align.CENTER, Align.MIN))
        fillet(block.edges(), radius=p["fillet"])
    return [Body("block", slot=1, part=block.part)]
