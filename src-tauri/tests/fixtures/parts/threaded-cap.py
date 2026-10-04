# A screw-on bottle cap, printed top down: a closed top on the bed, a round wall with grip flutes, and one internal
# thread whose trapezoid profile has 45 degree flanks and a flat crest.
from build123d import *
from materialize import Body

# How far the thread's root reaches into the wall, so the two fuse into one solid. The widest part of the tooth
# must stay narrower than the pitch, or one turn would cut into the next.
OVERLAP = 0.15


def build(p):
    bore_r = p["bore_d"] / 2                   # the bore the bottle's thread turns in
    outer_r = bore_r + p["wall"]
    top, height, pitch = p["top"], p["height"], p["pitch"]
    depth, crest = p["thread_depth"], p["thread_crest"]
    half = crest / 2 + depth + OVERLAP         # half the tooth's width where it meets the wall (45 degree flanks)
    if 2 * half >= pitch:
        raise ValueError(f"the thread tooth ({2 * half:.2f} mm) must be narrower than the pitch ({pitch} mm)")
    start = top + p["relief"] + half           # an unthreaded band above the top keeps the bore measurable
    with BuildPart() as cap:
        Cylinder(outer_r, height, align=(Align.CENTER, Align.CENTER, Align.MIN))
        with Locations((0, 0, top)):
            Cylinder(bore_r, height, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
        with BuildLine() as path:
            Helix(pitch=pitch, height=height - start - half, radius=bore_r, center=(0, 0, start))
        # The profile lies in the plane through the axis at the helix start: u points in toward the axis, v up.
        with BuildSketch(Plane(origin=(bore_r, 0, start), x_dir=(-1, 0, 0), z_dir=(0, 1, 0))):
            with BuildLine():
                Polyline((-OVERLAP, -half), (depth, -crest / 2), (depth, crest / 2), (-OVERLAP, half), close=True)
            make_face()
        sweep(path=path.line, is_frenet=True)
        with PolarLocations(outer_r, p["grips"]):
            Cylinder(p["grip_r"], height, align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
    return [Body("cap", slot=1, part=cap.part)]
