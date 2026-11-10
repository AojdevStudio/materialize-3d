"""Turn dock/meshes.json (the real dock mount solids) into dock.glb.

Run from site/models:  blender -b --python blender/build_dock.py

Writes site/src/assets/story/dock.glb.

Each printed part is its own named object, in assembly position. Units are metres.
"""
import json
import math
from pathlib import Path

import bpy

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT.parent / 'src' / 'assets' / 'story'
data = json.loads((ROOT / 'dock' / 'meshes.json').read_text())

bpy.ops.wm.read_factory_settings(use_empty=True)
coll = bpy.context.scene.collection

petg = bpy.data.materials.new('petg')
petg.use_nodes = True
b = petg.node_tree.nodes['Principled BSDF']
b.inputs['Base Color'].default_value = (0.62, 0.63, 0.62, 1.0)
b.inputs['Roughness'].default_value = 0.55

NAMES = {'Back plate': 'back_plate', 'Left rail': 'rail_left', 'Right rail': 'rail_right',
         'Left shelf': 'shelf_left', 'Right shelf': 'shelf_right', 'Arm adapter': 'adapter'}

for label, m in data['parts'].items():
    v = m['verts']
    t = m['tris']
    verts = [(v[i] * 0.001, v[i + 1] * 0.001, v[i + 2] * 0.001) for i in range(0, len(v), 3)]
    faces = [(t[i], t[i + 1], t[i + 2]) for i in range(0, len(t), 3)]
    me = bpy.data.meshes.new(NAMES[label])
    me.from_pydata(verts, [], faces)
    me.validate()
    for poly in me.polygons:
        poly.use_smooth = True
    me.set_sharp_from_angle(angle=math.radians(30))
    me.materials.append(petg)
    ob = bpy.data.objects.new(NAMES[label], me)
    coll.objects.link(ob)
    ob.select_set(True)

bpy.ops.export_scene.gltf(filepath=str(OUT / 'dock.glb'), export_format='GLB', use_selection=True, export_apply=True,
                          export_yup=True, export_cameras=False, export_lights=False, export_animations=False)
print('dock.glb', (OUT / 'dock.glb').stat().st_size, 'bytes')
