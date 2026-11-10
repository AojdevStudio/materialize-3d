"""Revision C arm adapter. Builds the adapter solid and checks the stack: monitor, adapter, arm bracket, cradle.

Monitor frame: origin at the monitor VESA centre on the monitor face. X right, Y away from the monitor, Z up.
The cradle from model.py keeps its own frame and moves by (0, adapter thickness, cradle offset Z).
The arm bracket and joint are an assumed envelope, not a measured part.

Run: uv run --with manifold3d --with numpy python build/adapter.py
Writes print/adapter.3mf, monitor face down. Slice it with: python3 -I build/slice.py adapter
"""
import json
import sys
from pathlib import Path

import numpy as np
import manifold3d

sys.path.insert(0, str(Path(__file__).resolve().parent))
import model  # noqa: E402  cradle solids and fit checks, writes nothing on import

p = model.p
box, rod, union = model.box, model.rod, model.union

t = p['adapter_thickness_mm']
D = p['adapter_cradle_offset_z_mm']
dy = p['adapter_cradle_offset_y_mm']
cr = p['adapter_cradle_pattern_mm'] / 2

arm_holes = [(sx * p[k], sz * p[k]) for k in ('vesa_small_center_offset_mm', 'vesa_large_center_offset_mm') for sx in (-1, 1) for sz in (-1, 1)]
cradle_inserts = [(sx * cr, D + sz * cr) for sx in (-1, 1) for sz in (-1, 1)]
assert len(arm_holes) == p['adapter_arm_hole_count'] and len(cradle_inserts) == p['adapter_cradle_insert_count']
pilot_bottom = t - p['adapter_insert_pilot_depth_mm']

adapter = box(p['adapter_x_min_mm'], p['adapter_x_max_mm'], p['adapter_y_min_mm'], p['adapter_y_max_mm'], p['adapter_z_min_mm'], p['adapter_z_max_mm'])
cuts = [rod('y', -1, t + 1, x, z, p['vesa_clearance_diameter_mm']) for x, z in arm_holes]
cuts += [rod('y', pilot_bottom, t + 1, x, z, p['insert_pilot_diameter_mm']) for x, z in cradle_inserts]
adapter = adapter - union(cuts)

# The cradle's 75 mm VESA holes must sit on the adapter inserts.
assert cr == p['vesa_small_center_offset_mm']

cradle = {name: m.translate([0, dy, D]) for name, m in model.assembly.items()}
dock = model.dock.translate([0, dy, D])
half = p['arm_bracket_assumed_max_size_mm'] / 2
bt = p['arm_bracket_assumed_thickness_mm']
arm = union([
    box(-half, half, t, t + bt, -half, half),
    rod('y', t + bt, t + bt + p['arm_joint_assumed_depth_mm'], 0, 0, p['arm_joint_assumed_diameter_mm']),
])
monitor = box(-300, 300, -60, 0, -200, 200)


def overlap(a, b):
    return (a ^ b).volume()


checks = {}
for name, m in {**cradle, 'Dock': dock}.items():
    checks[f'{name} x adapter'] = overlap(m, adapter)
    checks[f'{name} x arm envelope'] = overlap(m, arm)
checks['Adapter x monitor'] = overlap(adapter, monitor)
checks['Adapter x arm envelope'] = overlap(adapter, arm)
bad = {k: v for k, v in checks.items() if v > 1e-6}
assert not bad, bad

cradle_low = min(np.array(m.bounding_box())[2] for m in cradle.values())
clearances = {
    'Cradle lowest point to assumed bracket top': round(cradle_low - half, 3),
    'Cradle screw tip to adapter pilot bottom': round(t + p['plate_thickness_mm'] + p['washer_thickness_mm'] - p['cradle_adapter_screw_length_mm'] - pilot_bottom, 3),
    'Adapter pilot bottom to monitor face': round(pilot_bottom, 3),
    'Adapter insert pilot to top edge': round(p['adapter_z_max_mm'] - max(z for _, z in cradle_inserts) - p['insert_pilot_diameter_mm'] / 2, 3),
    'Adapter insert pilot to side edge': round(p['adapter_x_max_mm'] - cr - p['insert_pilot_diameter_mm'] / 2, 3),
    'Large arm hole to adapter edge': round(p['adapter_x_max_mm'] - p['vesa_large_center_offset_mm'] - p['vesa_clearance_diameter_mm'] / 2, 3),
}
assert all(c > 0 for c in clearances.values()), clearances
engagement = t - (t + p['plate_thickness_mm'] + p['washer_thickness_mm'] - p['cradle_adapter_screw_length_mm'])
assert engagement >= p['insert_length_mm'], engagement

lo, hi = np.array(adapter.bounding_box()).reshape(2, 3)
size = (hi - lo).round(3)
printed = adapter.rotate([90, 0, 0])  # monitor face down
plo, phi = np.array(printed.bounding_box()).reshape(2, 3)
print_size = (phi - plo).round(3).tolist()
bed = [p[f'printer_bed_{a}_mm'] for a in 'xyz']
assert all(a <= b for a, b in zip(print_size, bed)), print_size
assert print_size == [p['adapter_print_footprint_x_mm'], p['adapter_print_footprint_y_mm'], p['adapter_print_height_mm']], print_size
assert adapter.status() == manifold3d.Error.NoError and adapter.genus() == len(arm_holes) + 0

if __name__ == '__main__':
    out = model.ROOT / 'print' / 'adapter.3mf'
    model.write_3mf(out, {'Arm adapter': printed.translate((-plo).tolist())})
    print(json.dumps({
        'file': str(out),
        'adapter_size_mm': size.tolist(),
        'print_size_mm': print_size,
        'volume_cm3': round(adapter.volume() / 1000, 1),
        'cradle_offset_mm': [0, dy, D],
        'dock_top_above_vesa_centre_mm': p['dock_top_above_vesa_centre_mm'],
        'overlap_checks': len(checks),
        'clearances_mm': clearances,
        'cradle_screw_engagement_mm': round(engagement, 3),
    }, indent=2))
