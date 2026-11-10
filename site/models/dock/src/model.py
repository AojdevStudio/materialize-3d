"""Build the five printed parts from params.json and write print/parts.3mf.

Run: uv run --with manifold3d --with numpy python build/model.py
"""
import json
import math
import zipfile
from pathlib import Path

import numpy as np
import manifold3d
from manifold3d import Manifold, CrossSection

ROOT = Path(__file__).resolve().parent.parent
p = json.loads((ROOT / 'params.json').read_text())
SEG = 64


def box(x0, x1, y0, y1, z0, z1):
    return Manifold.cube([x1 - x0, y1 - y0, z1 - z0]).translate([x0, y0, z0])


def rod(axis, a0, a1, c1, c2, d):
    """Cylinder of diameter d along axis from a0 to a1. c1, c2 are the other two coordinates in xyz order."""
    c = Manifold.cylinder(a1 - a0, d / 2, d / 2, SEG)
    if axis == 'x':
        return c.rotate([0, 90, 0]).translate([a0, c1, c2])
    if axis == 'y':
        return c.rotate([-90, 0, 0]).translate([c1, a0, c2])
    return c.translate([c1, c2, a0])


def union(parts):
    return Manifold.batch_boolean(parts, manifold3d.OpType.Add)


# Back plate. Assembly coordinates: origin at VESA centre on the monitor face, X right, Y away, Z up.
plate = box(p['plate_x_min_mm'], p['plate_x_max_mm'], p['plate_y_min_mm'], p['plate_y_max_mm'], p['plate_z_min_mm'], p['plate_z_max_mm'])
cuts = []
for k in ('vesa_small_center_offset_mm', 'vesa_large_center_offset_mm'):
    for sx in (-1, 1):
        for sz in (-1, 1):
            cuts.append(rod('y', -1, p['plate_y_max_mm'] + 1, sx * p[k], sz * p[k], p['vesa_clearance_diameter_mm']))
inserts = [(s * p['rail_screw_right_x_mm'], z) for s in (-1, 1) for z in (p['rail_screw_lower_z_mm'], p['rail_screw_upper_z_mm'])]
inserts += [(s * x, z) for s in (-1, 1) for x in p['wing_screw_abs_x_mm'] for z in (p['wing_screw_lower_z_mm'], p['wing_screw_upper_z_mm'])]
assert len(inserts) == p['plate_insert_count']
for x, z in inserts:
    cuts.append(rod('y', p['insert_pilot_bottom_y_mm'], p['plate_y_max_mm'] + 1, x, z, p['insert_pilot_diameter_mm']))
plate = plate - union(cuts)

# Right rail.
xi, xo, cx = p['rail_right_x_min_mm'], p['rail_right_x_max_mm'], p['cavity_x_max_mm']
ry0, ry1, rib = p['rail_y_min_mm'], p['rail_y_max_mm'], p['rib_y_max_mm']
lip = p['rail_front_lip_y_min_mm']
rail = union([
    box(xi, xo, ry0, rib, p['rail_z_min_mm'], p['rail_z_max_mm']),
    box(cx, xo, rib, ry1, p['rail_lower_cheek_z_min_mm'], p['rail_lower_cheek_z_max_mm']),
    box(cx, xo, rib, ry1, p['rail_upper_cheek_z_min_mm'], p['rail_upper_cheek_z_max_mm']),
    box(xi, cx, rib, ry1, p['rail_z_min_mm'], p['cavity_z_seat_mm']),
    box(xi, cx, lip, ry1, p['cavity_z_seat_mm'], p['rail_lower_cheek_z_max_mm']),
    box(xi, cx, lip, ry1, p['rail_upper_lip_z_min_mm'], p['rail_upper_lip_z_max_mm']),
])
cuts = [rod('y', ry0 - 1, rib + 1, p['rail_screw_right_x_mm'], z, p['rail_screw_clearance_diameter_mm'])
        for z in (p['rail_screw_lower_z_mm'], p['rail_screw_upper_z_mm'])]
cb0 = p['shelf_rail_counterbore_mouth_abs_x_mm']
for y in p['spine_insert_y_mm']:
    cuts.append(rod('x', cb0 - 1, xo + 1, y, p['spine_insert_z_mm'], p['shelf_rail_hole_diameter_mm']))
    cuts.append(rod('x', cb0 - 1, cb0 + p['shelf_rail_counterbore_depth_mm'], y, p['spine_insert_z_mm'], p['shelf_rail_counterbore_diameter_mm']))
rail_right = rail - union(cuts)

# Right shelf with its spine.
wx0, wx1 = p['wing_right_x_min_mm'], p['wing_right_x_max_mm']
wy0, wy1 = p['wing_y_min_mm'], p['wing_y_max_mm']
flange_y1 = wy0 + p['wing_rear_flange_thickness_mm']
shelf = union([
    box(wx0, wx1, wy0, wy1, p['wing_tray_z_min_mm'], p['wing_z_max_mm']),
    box(wx0, wx1, wy0, flange_y1, p['wing_z_min_mm'], p['wing_z_max_mm']),
    box(p['spine_abs_x_min_mm'], p['spine_abs_x_max_mm'], p['spine_y_min_mm'], p['spine_y_max_mm'], p['spine_z_min_mm'], p['spine_z_max_mm']),
])
r = p['wing_slot_radius_mm']
v1, v2 = wy0 + p['wing_slot_arc_center_v1_mm'], wy0 + p['wing_slot_arc_center_v2_mm']
cuts = []
for i in range(p['wing_slot_count_each']):
    x = wx0 + p['wing_slot_first_center_u_mm'] + i * p['wing_slot_pitch_mm']
    stadium = CrossSection.circle(r, SEG).translate([x, v1]) + CrossSection.circle(r, SEG).translate([x, v2]) + CrossSection.square([2 * r, v2 - v1]).translate([x - r, v1])
    cuts.append(Manifold.extrude(stadium, p['wing_tray_thickness_mm'] + 2).translate([0, 0, p['wing_tray_z_min_mm'] - 1]))
for x in p['wing_screw_abs_x_mm']:
    for z in (p['wing_screw_lower_z_mm'], p['wing_screw_upper_z_mm']):
        cuts.append(rod('y', wy0 - 1, flange_y1 + 1, x, z, p['wing_screw_clearance_diameter_mm']))
for y in p['spine_insert_y_mm']:
    cuts.append(rod('x', p['spine_abs_x_min_mm'] - 1, p['spine_insert_pilot_bottom_abs_x_mm'], y, p['spine_insert_z_mm'], p['insert_pilot_diameter_mm']))
shelf_right = shelf - union(cuts)


def mirror_x(m):
    return m.mirror([1, 0, 0])


assembly = {
    'Back plate': plate,
    'Left rail': mirror_x(rail_right),
    'Right rail': rail_right,
    'Left shelf': mirror_x(shelf_right),
    'Right shelf': shelf_right,
}

# Fit check in assembly position. Parts may touch but never overlap each other or the dock.
dock = box(p['dock_shown_x_min_mm'], p['dock_shown_x_max_mm'], p['dock_shown_y_min_mm'], p['dock_shown_y_max_mm'], p['dock_shown_z_min_mm'], p['dock_shown_z_max_mm'])
names = list(assembly)
overlaps = {}
for i, a in enumerate(names):
    overlaps[f'{a} x dock'] = (assembly[a] ^ dock).volume()
    for b in names[i + 1:]:
        overlaps[f'{a} x {b}'] = (assembly[a] ^ assembly[b]).volume()
bad = {k: v for k, v in overlaps.items() if v > 1e-6}
assert not bad, bad
lo, hi = np.array(union(list(assembly.values())).bounding_box()).reshape(2, 3)
overall = (hi - lo).round(3).tolist()
assert overall == [p['assembly_width_mm'], p['assembly_depth_mm'], p['assembly_height_mm']], overall

# Print orientation per the drawing: plate monitor face down, rails outer face down, shelves tray top down.
orient = {
    'Back plate': lambda m: m.rotate([90, 0, 0]),
    'Left rail': lambda m: m.rotate([0, -90, 0]),
    'Right rail': lambda m: m.rotate([0, 90, 0]),
    'Left shelf': lambda m: m.rotate([180, 0, 0]),
    'Right shelf': lambda m: m.rotate([180, 0, 0]),
}
bed = [p[f'printer_bed_{a}_mm'] for a in 'xyz']
printed = {}
report = []
for name, m in assembly.items():
    m = orient[name](m)
    lo, hi = np.array(m.bounding_box()).reshape(2, 3)
    m = m.translate((-lo).tolist())
    size = (hi - lo).round(3)
    assert all(size <= bed), (name, size)
    assert m.genus() >= 0 and m.status() == manifold3d.Error.NoError, name
    printed[name] = m
    report.append({'part': name, 'size_mm': size.tolist(), 'volume_cm3': round(m.volume() / 1000, 2), 'genus': m.genus()})


def model_xml(parts):
    objs, items = [], []
    x_cursor = 0.0
    for i, (name, m) in enumerate(parts.items(), start=1):
        mesh = m.to_mesh()
        verts = mesh.vert_properties[:, :3]
        tris = mesh.tri_verts
        v = ''.join(f'<vertex x="{a:.4f}" y="{b:.4f}" z="{c:.4f}"/>' for a, b, c in verts)
        t = ''.join(f'<triangle v1="{a}" v2="{b}" v3="{c}"/>' for a, b, c in tris)
        objs.append(f'<object id="{i}" name="{name}" type="model"><mesh><vertices>{v}</vertices><triangles>{t}</triangles></mesh></object>')
        items.append(f'<item objectid="{i}" transform="1 0 0 0 1 0 0 0 1 {x_cursor:.3f} 0 0"/>')
        x_cursor += m.bounding_box()[3] + 10
    return ('<?xml version="1.0" encoding="UTF-8"?>'
            '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">'
            f'<metadata name="Title">UGREEN Maxidok U716 VESA cradle mount. Revision {p["revision"]}.</metadata>'
            f'<resources>{"".join(objs)}</resources><build>{"".join(items)}</build></model>')


def write_3mf(out, parts):
    out.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>')
        z.writestr('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>')
        z.writestr('3D/3dmodel.model', model_xml(parts))


# build/guide.py and build/adapter.py import this module for the solids, so the file write runs only as a script.
if __name__ == '__main__':
    out = ROOT / 'print' / 'parts.3mf'
    write_3mf(out, printed)

    print(json.dumps({'overall_mm': overall, 'overlap_checks': len(overlaps), 'parts': report, 'file': str(out)}, indent=2))
