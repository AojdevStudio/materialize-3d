from build123d import *
from materialize import Body

def build(p):
    r_out = p["inner_d"] / 2 + p["wall"]
    with BuildPart() as cap:
        Cylinder(r_out, p["height"], align=(Align.CENTER, Align.CENTER, Align.MIN))
        with Locations((0, 0, p["top"])):
            Cylinder(p["inner_d"] / 2, p["height"], align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
        thread_path = Helix(pitch=p["pitch"], height=p["height"] - p["top"] - p["pitch"], radius=p["inner_d"] / 2 - 0.4,
                            center=(0, 0, p["top"] + p["pitch"] / 2))
        with BuildSketch(Plane(origin=thread_path @ 0, z_dir=thread_path % 0)) as profile:
            Triangle(a=1.6, b=1.6, C=60)
        sweep(path=thread_path, is_frenet=True)
        with PolarLocations(r_out, p["knurls"]):
            Cylinder(0.8, p["height"], align=(Align.CENTER, Align.CENTER, Align.MIN), mode=Mode.SUBTRACT)
    return [Body("cap", slot=1, part=cap.part)]
