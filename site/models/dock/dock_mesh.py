"""Export the real dock mount solids for the page.

Run from site/models:  uv run --with manifold3d --with numpy python dock/dock_mesh.py

Reads the copied reference scripts in dock/src (model.py, adapter.py) and dock/params.json.
Writes dock/meshes.json (for blender/build_dock.py, not committed) and, into site/src/assets/story,
dock-data.json (the print pose of the printed part and the sizes the page quotes) and
dock-slices.json (the printed part's real slice outlines, only the 3D view loads them).
"""
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / 'src'))
import model      # noqa: E402  five cradle parts, fit checks
import adapter    # noqa: E402  revision C arm adapter, stack checks

p = model.p
PRINT_PART = 'Right shelf'
LAYER = 0.2

# Cradle parts stay in the cradle frame. The adapter moves into that frame.
parts = dict(model.assembly)
parts['Arm adapter'] = adapter.adapter.translate([0, -p['adapter_cradle_offset_y_mm'], -p['adapter_cradle_offset_z_mm']])


def mesh(m):
    g = m.to_mesh()
    return {'verts': np.asarray(g.vert_properties)[:, :3].round(4).ravel().tolist(), 'tris': np.asarray(g.tri_verts).ravel().tolist()}


out = {'unit': 'mm', 'axes': 'X right, Y away from the monitor, Z up', 'parts': {name: mesh(m) for name, m in parts.items()}}
(HERE / 'meshes.json').write_text(json.dumps(out))

# Print pose of the printed part: the same rotation model.py uses, then the minimum corner to the origin.
rot = np.diag([1.0, -1.0, -1.0])            # rotate 180 degrees about X: tray top down
src = parts[PRINT_PART]
lo, hi = np.array(src.rotate([180, 0, 0]).bounding_box()).reshape(2, 3)
printed = model.printed[PRINT_PART]
plo, phi = np.array(printed.bounding_box()).reshape(2, 3)
assert np.allclose(plo, 0) and np.allclose(phi, hi - lo)
size = (hi - lo).round(3)

# The same pose as a 4x4 in three.js axes and metres. three = (x, z, -y) * 0.001.
C = np.array([[1, 0, 0], [0, 0, 1], [0, -1, 0]], dtype=float)
R3 = C @ rot @ C.T
t3 = C @ (-lo) * 0.001
M = np.eye(4)
M[:3, :3] = R3
M[:3, 3] = t3

layers = int(round(size[2] / LAYER))
slices = []
for i in range(60):                           # one outline every half millimetre
    z = (i + 0.5) * size[2] / 60
    polys = printed.slice(float(z)).to_polygons()
    slices.append({'z': round(float(z), 3), 'polys': [np.asarray(poly).round(2).ravel().tolist() for poly in polys]})

data = {
    'print_part': PRINT_PART,
    'print_size_mm': size.tolist(),
    'layer_mm': LAYER,
    'layers': layers,
    'print_matrix': M.T.ravel().round(6).tolist(),     # column-major, three.js axes, metres
    'assembly_mm': [p['assembly_width_mm'], p['assembly_depth_mm'], p['assembly_height_mm']],
    'explode_mm': {'rail_y': p['exploded_rail_offset_y_mm'], 'shelf_x': p['exploded_wing_offset_x_mm'], 'dock_z': p['exploded_dock_offset_z_mm']},
    'dock_box_mm': [p[f'dock_shown_{a}_{b}_mm'] for a in 'xyz' for b in ('min', 'max')],
    'params': {k: p[k] for k in ('dock_width_mm', 'dock_height_mm', 'dock_depth_mm', 'fit_clearance_each_side_mm', 'clear_width_mm',
                                 'plate_width_mm', 'plate_height_mm', 'plate_thickness_mm', 'rail_width_mm', 'rail_depth_mm', 'rail_height_mm',
                                 'wing_width_mm', 'wing_depth_mm', 'wing_total_height_mm', 'wing_slot_count_each', 'insert_count',
                                 'printed_part_count', 'adapter_thickness_mm', 'adapter_width_mm', 'adapter_height_mm', 'revision')},
    'tbd': {k: v['status'] for k, v in p['tbd'].items()},
}
OUT = HERE.parent.parent / 'src' / 'assets' / 'story'
(OUT / 'dock-data.json').write_text(json.dumps(data))
(OUT / 'dock-slices.json').write_text(json.dumps({'slices': slices}))
print(json.dumps({'parts': {n: len(m['tris']) // 3 for n, m in out['parts'].items()}, 'print_size_mm': size.tolist(), 'layers': layers,
                  'slice_points': sum(len(q) // 2 for s in slices for q in s['polys'])}, indent=1))
