# A Gridfinity bin on the standard 42 mm grid: one stepped foot per grid cell, rounded walls, and an open top.
from build123d import *
from materialize import Body


def rounded(size_x, size_y, radius, z):
    """A rounded rectangle, centered on the z axis, at height z."""
    with BuildSketch(Plane.XY.offset(z)) as sketch:
        RectangleRounded(size_x, size_y, radius)
    return sketch.sketch


def foot(p):
    """One grid cell's foot: a 45 degree chamfer, a straight band, and a 45 degree chamfer out to the cell."""
    cell, radius = p["grid"] - p["clearance"], p["corner_r"]
    low, band, high = p["foot_low_chamfer"], p["foot_band"], p["foot_high_chamfer"]
    bottom, middle = cell - 2 * (low + high), cell - 2 * high
    with BuildPart() as part:
        loft([rounded(bottom, bottom, radius - low - high, 0), rounded(middle, middle, radius - high, low)])
        extrude(rounded(middle, middle, radius - high, low), amount=band)
        loft([rounded(middle, middle, radius - high, low + band), rounded(cell, cell, radius, low + band + high)])
    return part.part


def build(p):
    pitch = p["grid"]
    nx, ny = p["units_x"], p["units_y"]
    size_x, size_y = nx * pitch - p["clearance"], ny * pitch - p["clearance"]
    foot_h = p["foot_low_chamfer"] + p["foot_band"] + p["foot_high_chamfer"]
    height = p["units_z"] * p["unit_h"]
    one = foot(p)
    with BuildPart() as bin_:
        for i in range(nx):
            for j in range(ny):
                add(one.moved(Location(((i - (nx - 1) / 2) * pitch, (j - (ny - 1) / 2) * pitch, 0))))
        extrude(rounded(size_x, size_y, p["corner_r"], foot_h), amount=height - foot_h)
        wall = p["wall"]
        extrude(rounded(size_x - 2 * wall, size_y - 2 * wall, p["corner_r"] - wall, foot_h + p["floor"]),
                amount=height, mode=Mode.SUBTRACT)
    return [Body("bin", slot=1, part=bin_.part)]
