"""Build the enclosed CoreXY printer (P2S proportions) and export printer.glb.

Run from site/models:  blender -b --python blender/build_printer.py -- [--render]

Writes, into site/src/assets/story:
  printer.glb            one named object per explodable part
  printer-parts.json     part order, labels and explode offsets (three.js axes)
With --render it also writes renders/blender-assembled.png and renders/blender-exploded.png
(Cycles, CPU, low samples). renders/ is not committed.

Units are metres. Blender axes: X right, Y back (front is -Y), Z up.
No logo or wordmark is modelled anywhere.
"""
import json
import math
import sys
from pathlib import Path

import bmesh
import bpy
from mathutils import Euler, Matrix, Vector

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT.parent / 'src' / 'assets' / 'story'
ARGS = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []

# Published outer size and build volume.
W, D, H = 0.392, 0.406, 0.478
BED = 0.256

FOOT = 0.008
ZB = 0.046     # top of the base tray
ZT = 0.420     # bottom of the top frame
ZL = 0.470     # top of the top frame, the lid sits here
R = 0.012      # outer corner radius
POST = 0.030   # corner post and ring wall
ZG = 0.392     # gantry rod height
YT = -0.040    # toolhead and X beam position along Y
XT = 0.004     # toolhead position along X
ZP = 0.165     # top of the build plate
BED_Y = -0.008
LEAD = [(-0.110, 0.150), (0.110, 0.150), (0.0, -0.160)]

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
coll = scene.collection


# ---------------------------------------------------------------- materials
def mat(name, color, metallic=0.0, rough=0.5, alpha=1.0, transmission=0.0, emission=None, strength=0.0, coat=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = (*color, 1.0)
    b.inputs['Metallic'].default_value = metallic
    b.inputs['Roughness'].default_value = rough
    b.inputs['Alpha'].default_value = alpha
    b.inputs['Transmission Weight'].default_value = transmission
    b.inputs['Coat Weight'].default_value = coat
    if emission:
        b.inputs['Emission Color'].default_value = (*emission, 1.0)
        b.inputs['Emission Strength'].default_value = strength
    return m


def srgb(hexstr):
    h = hexstr.lstrip('#')
    c = [int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)]
    return tuple(x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c)


M = {
    'shell': mat('shell_gray', srgb('#85878A'), metallic=0.35, rough=0.48),
    'cover': mat('toolhead_cover', srgb('#9B9DA0'), metallic=0.45, rough=0.38),
    'black': mat('black_plastic', srgb('#17181A'), rough=0.62),
    'liner': mat('liner_black', srgb('#0E0F10'), rough=0.8),
    'dsteel': mat('dark_steel', srgb('#3A3C3F'), metallic=1.0, rough=0.38),
    'steel': mat('steel', srgb('#C9CBCE'), metallic=1.0, rough=0.2),
    'carbon': mat('carbon', srgb('#101113'), metallic=0.3, rough=0.28, coat=0.6),
    'belt': mat('belt', srgb('#0B0B0C'), rough=0.9),
    'rubber': mat('rubber', srgb('#0C0C0D'), rough=0.95),
    'white': mat('white_plastic', srgb('#E6E6E3'), rough=0.42),
    'ptfe': mat('ptfe', srgb('#DCDDDA'), rough=0.3),
    'glass': mat('glass', (0.13, 0.135, 0.14), rough=0.02, transmission=1.0),
    'frit': mat('glass_frit', srgb('#08090A'), rough=0.15),
    'bezel': mat('screen_bezel', srgb('#060607'), rough=0.12, coat=0.5),
    'display': mat('screen_display', srgb('#0D1014'), rough=0.1, emission=(0.02, 0.025, 0.03), strength=1.0),
    'ui': mat('screen_ui', srgb('#D8DADC'), rough=0.4, emission=(0.8, 0.82, 0.84), strength=1.2),
    'uidim': mat('screen_ui_dim', srgb('#3A3F45'), rough=0.4, emission=(0.09, 0.1, 0.11), strength=1.0),
    'bedal': mat('bed_aluminium', srgb('#2B2C2F'), metallic=0.7, rough=0.5),
    'pei': mat('pei_plate', srgb('#2C2A27'), metallic=0.25, rough=0.78),
}

# Cycles only: a fine bump on the PEI plate. The web page adds its own grain texture.
_n = M['pei'].node_tree
_noise = _n.nodes.new('ShaderNodeTexNoise')
_noise.inputs['Scale'].default_value = 2600
_noise.inputs['Detail'].default_value = 2
_bump = _n.nodes.new('ShaderNodeBump')
_bump.inputs['Strength'].default_value = 0.35
_bump.inputs['Distance'].default_value = 0.0004
_n.links.new(_noise.outputs['Fac'], _bump.inputs['Height'])
_n.links.new(_bump.outputs['Normal'], _n.nodes['Principled BSDF'].inputs['Normal'])


# ---------------------------------------------------------------- mesh helpers
PARTS = {}
_current = None


def part(name):
    global _current
    _current = name
    PARTS.setdefault(name, [])


def piece(bm, material, smooth=38):
    me = bpy.data.meshes.new('piece')
    bm.normal_update()
    bm.to_mesh(me)
    bm.free()
    for p in me.polygons:
        p.use_smooth = True
    me.set_sharp_from_angle(angle=math.radians(smooth))
    ob = bpy.data.objects.new('piece', me)
    me.materials.append(material)
    coll.objects.link(ob)
    PARTS[_current].append(ob)
    return ob


def box(size, loc, material, bevel=0.0012, seg=2, rot=None):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    if bevel > 0:
        bevel = min(bevel, min(size) * 0.49)
        bmesh.ops.bevel(bm, geom=bm.edges[:], offset=bevel, segments=seg, profile=0.5, affect='EDGES')
    if rot:
        bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=Euler(rot).to_matrix(), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(loc), verts=bm.verts)
    return piece(bm, material)


def bbox(x0, x1, y0, y1, z0, z1, material, bevel=0.0012, seg=2):
    return box((x1 - x0, y1 - y0, z1 - z0), ((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), material, bevel, seg)


def cyl(r, h, loc, material, axis='z', seg=32, bevel=0.0, r2=None):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r, radius2=r if r2 is None else r2, depth=h)
    if bevel > 0:
        ring = [e for e in bm.edges if abs(e.verts[0].co.z - e.verts[1].co.z) < 1e-7]
        bmesh.ops.bevel(bm, geom=ring, offset=bevel, segments=2, profile=0.5, affect='EDGES')
    if axis == 'x':
        bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, 'Y'), verts=bm.verts)
    elif axis == 'y':
        bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=Matrix.Rotation(-math.pi / 2, 3, 'X'), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(loc), verts=bm.verts)
    return piece(bm, material, smooth=50)


def rrect(w, d, r, cx=0.0, cy=0.0, seg=6):
    """Counter-clockwise rounded rectangle outline."""
    pts = []
    for (sx, sy, a0) in ((1, 1, 0), (-1, 1, 90), (-1, -1, 180), (1, -1, 270)):
        ox, oy = cx + sx * (w / 2 - r), cy + sy * (d / 2 - r)
        for i in range(seg + 1):
            a = math.radians(a0 + 90 * i / seg)
            pts.append((ox + r * math.cos(a), oy + r * math.sin(a)))
    return pts


def _bevel_rings(bm, bevel, seg=2):
    if bevel <= 0:
        return
    ring = [e for e in bm.edges if abs(e.verts[0].co.z - e.verts[1].co.z) < 1e-7 and len(e.link_faces) == 2
            and abs(e.link_faces[0].normal.dot(e.link_faces[1].normal)) < 0.5]
    bmesh.ops.bevel(bm, geom=ring, offset=bevel, segments=seg, profile=0.5, affect='EDGES')


def prism(pts, z0, z1, material, bevel=0.0012, xform=None):
    bm = bmesh.new()
    lo = [bm.verts.new((x, y, z0)) for x, y in pts]
    hi = [bm.verts.new((x, y, z1)) for x, y in pts]
    n = len(pts)
    bm.faces.new(list(reversed(lo)))
    bm.faces.new(hi)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((lo[i], lo[j], hi[j], hi[i]))
    bm.normal_update()
    _bevel_rings(bm, bevel)
    if xform is not None:
        bmesh.ops.transform(bm, matrix=xform, verts=bm.verts)
    return piece(bm, material)


def ring(outer, inner, z0, z1, material, bevel=0.0012, xform=None):
    assert len(outer) == len(inner)
    bm = bmesh.new()
    n = len(outer)
    ol = [bm.verts.new((x, y, z0)) for x, y in outer]
    oh = [bm.verts.new((x, y, z1)) for x, y in outer]
    il = [bm.verts.new((x, y, z0)) for x, y in inner]
    ih = [bm.verts.new((x, y, z1)) for x, y in inner]
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((ol[i], ol[j], oh[j], oh[i]))
        bm.faces.new((il[j], il[i], ih[i], ih[j]))
        bm.faces.new((oh[i], oh[j], ih[j], ih[i]))
        bm.faces.new((ol[j], ol[i], il[i], il[j]))
    bm.normal_update()
    _bevel_rings(bm, bevel)
    if xform is not None:
        bmesh.ops.transform(bm, matrix=xform, verts=bm.verts)
    return piece(bm, material)


def tube(points, r, material, seg=10):
    """Sweep a circle along a polyline."""
    bm = bmesh.new()
    rings = []
    up = Vector((0, 0, 1))
    for i, p in enumerate(points):
        p = Vector(p)
        a = Vector(points[max(i - 1, 0)])
        b = Vector(points[min(i + 1, len(points) - 1)])
        t = (b - a).normalized()
        side = t.cross(up)
        if side.length < 1e-5:
            side = t.cross(Vector((0, 1, 0)))
        side.normalize()
        nrm = side.cross(t).normalized()
        rings.append([bm.verts.new(p + r * (math.cos(2 * math.pi * k / seg) * side + math.sin(2 * math.pi * k / seg) * nrm)) for k in range(seg)])
    for a, b in zip(rings, rings[1:]):
        for k in range(seg):
            bm.faces.new((a[k], a[(k + 1) % seg], b[(k + 1) % seg], b[k]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    return piece(bm, material, smooth=60)


def bezier(p0, p1, p2, p3, n=28):
    p0, p1, p2, p3 = map(Vector, (p0, p1, p2, p3))
    out = []
    for i in range(n + 1):
        t = i / n
        out.append(((1 - t) ** 3) * p0 + 3 * ((1 - t) ** 2) * t * p1 + 3 * (1 - t) * t * t * p2 + (t ** 3) * p3)
    return out


# ---------------------------------------------------------------- the printer
hw, hd = W / 2, D / 2

# Base tray with feet and the flat floor.
part('base')
prism(rrect(W, D, R), FOOT, ZB, M['shell'], bevel=0.002)
prism(rrect(W - 2 * POST, D - 2 * POST, 0.004), ZB - 0.001, ZB + 0.0012, M['liner'], bevel=0.0005)
for sx in (-1, 1):
    for sy in (-1, 1):
        cyl(0.015, FOOT + 0.002, (sx * (hw - 0.036), sy * (hd - 0.036), FOOT / 2 + 0.001), M['rubber'], bevel=0.0015)
    # lift handle recess low on each side
    box((0.003, 0.110, 0.016), (sx * (hw - 0.0008), 0.0, FOOT + 0.019), M['liner'], bevel=0.001)
# rear power and vent block
box((0.060, 0.003, 0.018), (-0.110, hd - 0.0008, FOOT + 0.019), M['liner'], bevel=0.001)

# Frame: four corner posts, Z rods and three lead screws.
part('frame')
for sx in (-1, 1):
    for sy in (-1, 1):
        prism(rrect(POST, POST, R, sx * (hw - POST / 2), sy * (hd - POST / 2)), ZB, ZT, M['shell'], bevel=0.0008)
for (lx, ly) in LEAD:
    cyl(0.0042, 0.305, (lx, ly, ZB + 0.020 + 0.1525), M['dsteel'], seg=16)
    cyl(0.015, 0.022, (lx, ly, ZB + 0.011), M['black'], bevel=0.002)
    cyl(0.009, 0.010, (lx, ly, ZB + 0.027), M['dsteel'], bevel=0.001)
    box((0.026, 0.026, 0.012), (lx, ly, ZB + 0.020 + 0.305 + 0.004), M['black'], bevel=0.002)
for sx in (-1, 1):
    # rear smooth rods and their brackets
    cyl(0.005, 0.330, (sx * 0.150, 0.150, ZB + 0.165), M['steel'], seg=20)
    box((0.024, 0.024, 0.010), (sx * 0.150, 0.150, ZB + 0.005), M['black'], bevel=0.002)
    box((0.024, 0.024, 0.010), (sx * 0.150, 0.150, ZB + 0.333), M['black'], bevel=0.002)
    # thin inner uprights that carry the gantry
    bbox(sx * (hw - 0.012) - 0.004, sx * (hw - 0.012) + 0.004, -hd + POST, hd - POST, ZT - 0.060, ZT - 0.048, M['black'], bevel=0.001)
# rear cross brace
bbox(-hw + POST, hw - POST, hd - 0.022, hd - 0.012, ZB + 0.325, ZB + 0.345, M['black'], bevel=0.001)
bbox(-hw + POST, hw - POST, hd - 0.022, hd - 0.012, ZB, ZB + 0.012, M['black'], bevel=0.001)

# Side panels and the back panel: gray skin outside, black liner inside.
for name, sx in (('panel_left', -1), ('panel_right', 1)):
    part(name)
    x_out = sx * hw
    bbox(min(x_out, x_out - sx * 0.004), max(x_out, x_out - sx * 0.004), -hd + POST, hd - POST, ZB, ZT, M['shell'], bevel=0.0006)
    bbox(min(x_out - sx * 0.004, x_out - sx * 0.006), max(x_out - sx * 0.004, x_out - sx * 0.006), -hd + POST + 0.002, hd - POST - 0.002, ZB + 0.002, ZT - 0.002, M['liner'], bevel=0.0)

part('panel_back')
bbox(-hw + POST, hw - POST, hd - 0.004, hd, ZB, ZT, M['shell'], bevel=0.0006)
bbox(-hw + POST + 0.002, hw - POST - 0.002, hd - 0.006, hd - 0.004, ZB + 0.002, ZT - 0.002, M['liner'], bevel=0.0)
for i in range(15):  # vent fins seen through the door
    box((0.0024, 0.006, 0.210), (0.050 + i * 0.0062, hd - 0.009, 0.215), M['dsteel'], bevel=0.0005, seg=1)
box((0.100, 0.006, 0.222), (0.0934, hd - 0.0075, 0.215), M['black'], bevel=0.001)
box((0.092, 0.002, 0.092), (-0.075, hd + 0.0006, 0.250), M['liner'], bevel=0.001)   # rear fan grille
for i in range(7):
    box((0.084, 0.002, 0.003), (-0.075, hd + 0.0016, 0.214 + i * 0.012), M['shell'], bevel=0.0005, seg=1)

# Front door: tinted glass, black border, white handle, four hinge caps.
part('door')
dx0, dx1 = -hw + POST - 0.002, hw - POST + 0.002
dz0, dz1 = ZB + 0.003, ZT - 0.003
yf = -hd
bbox(dx0, dx1, yf, yf + 0.004, dz0, dz1, M['glass'], bevel=0.0008)
bw = 0.007
for (x0, x1, z0, z1) in ((dx0, dx1, dz1 - bw, dz1), (dx0, dx1, dz0, dz0 + bw), (dx0, dx0 + bw, dz0, dz1), (dx1 - bw, dx1, dz0, dz1)):
    bbox(x0, x1, yf + 0.0042, yf + 0.0052, z0, z1, M['frit'], bevel=0.0)
box((0.042, 0.011, 0.015), (dx1 - 0.010, yf - 0.0052, (dz0 + dz1) / 2 + 0.012), M['white'], bevel=0.005, seg=5)
for hz in (dz1 - 0.014, dz0 + 0.014):
    for hx in (dx0 + 0.022, dx0 + 0.046):
        cyl(0.0042, 0.003, (hx, yf - 0.0012, hz), M['black'], axis='y', seg=20, bevel=0.0008)

# Top frame: the ring that carries the lid.
part('top_frame')
ring(rrect(W, D, R), rrect(W - 2 * POST, D - 2 * POST, 0.006), ZT, ZL, M['shell'], bevel=0.0018)
ring(rrect(W - 2 * POST + 0.002, D - 2 * POST + 0.002, 0.006), rrect(W - 2 * POST - 0.010, D - 2 * POST - 0.010, 0.004), ZT + 0.004, ZL - 0.006, M['liner'], bevel=0.0)
# chamber light bar behind the front rail
box((0.200, 0.006, 0.006), (0.0, -hd + POST + 0.004, ZT + 0.008), M['white'], bevel=0.001)

# Touchscreen, tilted back, standing proud of the top edge on the left.
part('screen')
SW, SH, ST = 0.126, 0.080, 0.010
tilt = Matrix.Translation((-0.086, -hd - 0.013, 0.452)) @ Matrix.Rotation(math.radians(-17), 4, 'X') @ Matrix.Rotation(math.radians(90), 4, 'X')
# local frame before tilt: x right, y up the screen, z towards the viewer
prism(rrect(SW, SH, 0.008), -ST / 2, ST / 2, M['bezel'], bevel=0.0015, xform=tilt)
prism(rrect(SW - 0.010, SH - 0.010, 0.004), ST / 2, ST / 2 + 0.0004, M['display'], bevel=0.0, xform=tilt)


def ui(x0, x1, y0, y1, material):
    prism([(x0, y0), (x1, y0), (x1, y1), (x0, y1)], ST / 2 + 0.0004, ST / 2 + 0.0007, material, bevel=0.0, xform=tilt)


for i in range(4):  # plain status rows, no text, no logo
    y = 0.022 - i * 0.0135
    ui(-0.052, -0.047, y - 0.003, y + 0.003, M['ui'])
    ui(-0.043, -0.008, y - 0.0042, y + 0.0042, M['uidim'])
    ui(-0.040, -0.040 + 0.012 + 0.004 * ((i * 3) % 4), y - 0.0012, y + 0.0012, M['ui'])
ui(-0.002, 0.054, -0.026, 0.028, M['uidim'])
prism([(0.010, -0.010), (0.036, -0.014), (0.046, -0.004), (0.020, 0.000)], ST / 2 + 0.0007, ST / 2 + 0.0010, M['ui'], bevel=0.0, xform=tilt)
ui(0.036, 0.050, -0.023, -0.019, M['ui'])
# neck that holds the screen to the front rail
box((0.036, 0.014, 0.022), (-0.086, -hd - 0.004, 0.440), M['black'], bevel=0.003)

# Glass lid.
part('lid')
ring(rrect(W - 0.004, D - 0.004, R - 0.002), rrect(W - 0.030, D - 0.030, 0.006), ZL, ZL + 0.008, M['black'], bevel=0.0016)
prism(rrect(W - 0.028, D - 0.028, 0.006), ZL + 0.0025, ZL + 0.0065, M['glass'], bevel=0.0006)
box((0.060, 0.010, 0.003), (0.0, -hd + 0.010, ZL + 0.0065), M['black'], bevel=0.0012)   # finger lip

# CoreXY gantry: Y rods, the X beam with two carbon rods, belts, motors.
part('gantry')
GX = 0.158
for sx in (-1, 1):
    cyl(0.004, 0.340, (sx * GX, 0.0, ZG), M['steel'], axis='y', seg=18)
    for sy in (-1, 1):
        box((0.020, 0.012, 0.022), (sx * GX, sy * 0.172, ZG), M['black'], bevel=0.002)
    box((0.016, 0.356, 0.008), (sx * (GX + 0.016), 0.0, ZG - 0.016), M['black'], bevel=0.001)   # side rail
    box((0.036, 0.054, 0.030), (sx * GX, YT, ZG), M['black'], bevel=0.004, seg=3)                # Y carriage
    box((0.042, 0.042, 0.040), (sx * 0.150, 0.163, ZG - 0.030), M['black'], bevel=0.003)          # motor
    cyl(0.0065, 0.014, (sx * 0.150, 0.163, ZG - 0.003), M['steel'], seg=20)
    cyl(0.0065, 0.012, (sx * (GX + 0.012), -0.172, ZG + 0.014), M['steel'], seg=20)               # front idler
    cyl(0.0065, 0.012, (sx * (GX + 0.012), 0.180, ZG + 0.014), M['steel'], seg=20)
    box((0.0012, 0.352, 0.006), (sx * (GX + 0.0185), 0.004, ZG + 0.014), M['belt'], bevel=0.0)
    box((0.0012, 0.352, 0.006), (sx * (GX + 0.0055), 0.004, ZG + 0.014), M['belt'], bevel=0.0)
box((0.356, 0.016, 0.008), (0.0, 0.184, ZG - 0.016), M['black'], bevel=0.001)                    # rear rail
box((0.330, 0.0012, 0.006), (0.0, 0.1865, ZG + 0.014), M['belt'], bevel=0.0)
for sy in (-1, 1):
    cyl(0.005, 2 * GX - 0.030, (0.0, YT + sy * 0.016, ZG), M['carbon'], axis='x', seg=20)
    box((2 * GX - 0.036, 0.0012, 0.006), (0.0, YT + sy * 0.0065, ZG + 0.014), M['belt'], bevel=0.0)

# Toolhead: gray front cover with a round fan, black body, nozzle, cable and tube.
part('toolhead')
ty = YT - 0.006
box((0.054, 0.066, 0.064), (XT, ty, ZG - 0.004), M['black'], bevel=0.005, seg=3)
box((0.058, 0.012, 0.074), (XT, ty - 0.038, ZG - 0.008), M['cover'], bevel=0.005, seg=4)
cyl(0.0215, 0.004, (XT, ty - 0.0445, ZG + 0.003), M['dsteel'], axis='y', seg=40, bevel=0.0012)
cyl(0.0185, 0.004, (XT, ty - 0.0452, ZG + 0.003), M['liner'], axis='y', seg=40)
cyl(0.0065, 0.004, (XT, ty - 0.0462, ZG + 0.003), M['black'], axis='y', seg=24, bevel=0.001)
for k in range(7):  # fan blades as thin spokes
    a = 2 * math.pi * k / 7
    box((0.0125, 0.0012, 0.0045), (XT + 0.0125 * math.cos(a), ty - 0.0458, ZG + 0.003 + 0.0125 * math.sin(a)), M['black'], bevel=0.0, rot=(0, -a + 0.5, 0))
box((0.050, 0.044, 0.020), (XT, ty - 0.010, ZG - 0.046), M['black'], bevel=0.004, seg=3)          # chin
for sx in (-1, 1):
    box((0.012, 0.030, 0.014), (XT + sx * 0.019, ty - 0.022, ZG - 0.060), M['black'], bevel=0.003)  # cooling ducts
box((0.016, 0.014, 0.010), (XT, ty - 0.012, ZG - 0.060), M['dsteel'], bevel=0.0015)               # heater block
cyl(0.0042, 0.007, (XT, ty - 0.012, ZG - 0.0685), M['steel'], seg=20, r2=0.0012)                   # nozzle tip, points down
cab_a = (XT + 0.010, ty + 0.012, ZG + 0.028)
tube(bezier(cab_a, (XT + 0.010, ty + 0.030, ZG + 0.105), (0.030, 0.090, ZG + 0.085), (0.040, 0.176, ZG + 0.020)), 0.0042, M['black'])
ptfe_a = (XT - 0.010, ty + 0.004, ZG + 0.028)
tube(bezier(ptfe_a, (XT - 0.014, ty + 0.010, ZG + 0.100), (0.050, 0.110, ZG + 0.075), (0.060, hd - 0.030, ZG + 0.058)), 0.0022, M['ptfe'], seg=8)
box((0.022, 0.018, 0.010), (XT, ty + 0.008, ZG + 0.030), M['black'], bevel=0.003)

# Heatbed and its carrier.
part('bed')
bz = ZP - 0.002
box((0.262, 0.262, 0.008), (0.0, BED_Y, bz - 0.004), M['bedal'], bevel=0.002)
box((0.250, 0.006, 0.014), (0.0, BED_Y - 0.134, bz - 0.011), M['black'], bevel=0.002)             # front edge bar
box((0.210, 0.210, 0.004), (0.0, BED_Y, bz - 0.012), M['liner'], bevel=0.001)
box((0.300, 0.030, 0.016), (0.0, 0.150, bz - 0.026), M['black'], bevel=0.003)                     # rear beam
box((0.030, 0.330, 0.016), (0.0, -0.005, bz - 0.026), M['black'], bevel=0.003)                    # spine to the front screw
for sx in (-1, 1):
    box((0.022, 0.150, 0.012), (sx * 0.095, 0.085, bz - 0.024), M['black'], bevel=0.003, rot=(0, 0, sx * 0.5))
for (lx, ly) in LEAD:
    cyl(0.0105, 0.016, (lx, ly, bz - 0.026), M['dsteel'], bevel=0.0015, seg=24)
for sx in (-1, 1):
    cyl(0.009, 0.020, (sx * 0.150, 0.150, bz - 0.026), M['dsteel'], bevel=0.0015, seg=24)
    cyl(0.008, 0.006, (sx * 0.105, BED_Y - 0.105, bz - 0.017), M['dsteel'], bevel=0.001, seg=20)  # levelling knobs
cyl(0.008, 0.006, (0.0, BED_Y + 0.105, bz - 0.017), M['dsteel'], bevel=0.001, seg=20)

# Build plate: thin textured PEI sheet with a front grip.
part('build_plate')
# no bevel here: a bevel tilts the normals of the big top face and shows as a crease in the web view
prism(rrect(0.2575, 0.2575, 0.004, 0.0, BED_Y), ZP - 0.002, ZP, M['pei'], bevel=0.0)
bbox(-0.090, 0.090, BED_Y - 0.1365, BED_Y - 0.1280, ZP - 0.002, ZP - 0.0001, M['pei'], bevel=0.0)


# ---------------------------------------------------------------- join the pieces
def join(name, objs):
    for o in bpy.context.view_layer.objects:
        o.select_set(False)
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    if len(objs) > 1:
        bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = name
    ob.data.name = name
    bpy.ops.object.origin_set(type='ORIGIN_GEOMETRY', center='BOUNDS')
    return ob


OBJ = {name: join(name, objs) for name, objs in PARTS.items()}

# Explode order, top down. Offsets in Blender axes (metres).
EXPLODE = [
    ('lid',         'Top glass lid',                 (0.0, 0.0, 0.86)),
    ('screen',      'Touchscreen',                   (0.0, -0.10, 0.80)),
    ('top_frame',   'Top frame',                     (0.0, 0.0, 0.72)),
    ('toolhead',    'Toolhead',                      (0.0, 0.0, 0.66)),
    ('gantry',      'CoreXY gantry, rods and belts', (0.0, 0.0, 0.48)),
    ('door',        'Front door',                    (0.0, -0.34, 0.0)),
    ('panel_left',  'Side panel',                    (-0.30, 0.0, 0.0)),
    ('panel_right', 'Side panel',                    (0.30, 0.0, 0.0)),
    ('panel_back',  'Back panel',                    (0.0, 0.34, 0.0)),
    ('frame',       'Frame, Z rods, lead screws',    (0.0, 0.0, 0.30)),
    ('bed',         'Heatbed',                       (0.0, 0.0, -0.07)),
    ('base',        'Base',                          (0.0, 0.0, -0.16)),
    ('build_plate', 'Build plate, textured PEI',     (0.0, 0.0, 0.0)),
]
assert {e[0] for e in EXPLODE} == set(OBJ), set(OBJ) ^ {e[0] for e in EXPLODE}


def three(v):
    return [round(v[0], 5), round(v[2], 5), round(-v[1], 5)]


tris = 0
for ob in OBJ.values():
    ob.data.calc_loop_triangles()
    tris += len(ob.data.loop_triangles)

meta = {
    'units': 'metres, three.js axes (x right, y up, z towards the viewer)',
    'outer_mm': [392, 406, 478],
    'build_volume_mm': [256, 256, 256],
    'plate_top_center': three((0.0, BED_Y, ZP)),
    'plate_size': 0.2575,
    'nozzle_tip': three((XT, YT - 0.018, ZG - 0.072)),
    'parts': [{'name': n, 'label': label, 'offset': three(off), 'top_mm': round(max((OBJ[n].matrix_world @ Vector(c)).z for c in OBJ[n].bound_box) * 1000)}
              for n, label, off in EXPLODE],
    'triangles': tris,
}
(OUT / 'printer-parts.json').write_text(json.dumps(meta, indent=1))

for o in bpy.context.view_layer.objects:
    o.select_set(o.name in OBJ)
bpy.ops.export_scene.gltf(filepath=str(OUT / 'printer.glb'), export_format='GLB', use_selection=True, export_apply=True,
                          export_yup=True, export_cameras=False, export_lights=False, export_animations=False)
print('GLB written', (OUT / 'printer.glb').stat().st_size, 'bytes,', tris, 'triangles')

# ---------------------------------------------------------------- stills
if '--render' in ARGS:
    scene.render.engine = 'CYCLES'
    scene.cycles.device = 'CPU'
    DRAFT = '--draft' in ARGS
    scene.cycles.samples = 24 if DRAFT else 96
    scene.render.resolution_percentage = 50 if DRAFT else 100
    scene.cycles.use_denoising = True
    scene.cycles.max_bounces = 8
    scene.cycles.transmission_bounces = 8
    scene.cycles.transparent_max_bounces = 8
    scene.render.threads_mode = 'AUTO'
    scene.view_settings.view_transform = 'Standard'
    scene.view_settings.look = 'None'
    scene.render.image_settings.file_format = 'PNG'
    scene.render.film_transparent = True   # the floor only catches shadow, paper white is added after

    world = bpy.data.worlds.new('studio')
    world.use_nodes = True
    world.node_tree.nodes['Background'].inputs['Color'].default_value = (1, 1, 1, 1)
    world.node_tree.nodes['Background'].inputs['Strength'].default_value = 0.42
    # reflections see a dimmer room, so the tinted glass shows the inside and not a white sky
    wn = world.node_tree
    lp = wn.nodes.new('ShaderNodeLightPath')
    mix = wn.nodes.new('ShaderNodeMix')
    mix.data_type = 'FLOAT'
    mix.inputs['A'].default_value = 0.42
    mix.inputs['B'].default_value = 0.06
    wn.links.new(lp.outputs['Is Glossy Ray'], mix.inputs['Factor'])
    wn.links.new(mix.outputs['Result'], wn.nodes['Background'].inputs['Strength'])
    scene.world = world

    floor_mat = mat('paper', (0.93, 0.93, 0.92), rough=0.9)
    bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, 0))
    floor = bpy.context.active_object
    floor.data.materials.append(floor_mat)
    floor.is_shadow_catcher = True

    def area(name, loc, target, size, power, color=(1, 1, 1)):
        light = bpy.data.lights.new(name, 'AREA')
        light.shape = 'RECTANGLE'
        light.size, light.size_y = size
        light.energy = power
        light.color = color
        ob = bpy.data.objects.new(name, light)
        ob.location = loc
        ob.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()
        coll.objects.link(ob)
        return ob

    cam_data = bpy.data.cameras.new('cam')
    cam_data.lens = 70
    cam = bpy.data.objects.new('cam', cam_data)
    coll.objects.link(cam)
    scene.camera = cam

    def look(loc, target):
        cam.location = loc
        cam.rotation_euler = (Vector(target) - Vector(loc)).to_track_quat('-Z', 'Y').to_euler()

    (ROOT / 'renders').mkdir(exist_ok=True)

    # Assembled.
    key = area('key', (1.3, -1.6, 1.7), (0, 0, 0.25), (1.6, 1.6), 46)
    fill = area('fill', (-1.6, -1.0, 0.9), (0, 0, 0.25), (1.4, 1.4), 12)
    top = area('top', (0.0, 0.2, 2.2), (0, 0, 0.3), (2.0, 2.0), 20)
    rim = area('rim', (-0.6, 1.6, 1.2), (0, 0, 0.3), (1.0, 1.0), 14)
    glow = area('chamber', (0.0, -0.10, ZT - 0.014), (0, 0.02, 0.15), (0.24, 0.03), 4.0)
    for light in (key, fill, top, rim, glow):
        light.visible_camera = False
    # the fill, top and rim lights would mirror in the door and lid as white slabs
    for light in (fill, top, rim):
        light.visible_glossy = False
    scene.render.resolution_x, scene.render.resolution_y = 1600, 1200
    look((1.05, -1.75, 0.80), (0.0, 0.0, 0.245))
    def still(name):
        import subprocess
        out = ROOT / 'renders' / name
        scene.render.filepath = str(out)
        bpy.ops.render.render(write_still=True)
        subprocess.run(['magick', str(out), '-background', '#F7F7F5', '-flatten', str(out)], check=True)

    still('blender-assembled.png')

    # Exploded. The floor drops out of the way so the base can sink.
    for n, _, off in EXPLODE:
        OBJ[n].location = OBJ[n].location + Vector(off)
    floor.location.z = -0.30
    glow.hide_render = True
    key.location = (2.2, -2.6, 2.6)
    key.data.energy = 150
    key.data.size = key.data.size_y = 2.4
    key.rotation_euler = (Vector((0, 0, 0.6)) - Vector(key.location)).to_track_quat('-Z', 'Y').to_euler()
    fill.location = (-2.6, -1.6, 1.2)
    fill.data.energy = 44
    fill.rotation_euler = (Vector((0, 0, 0.6)) - Vector(fill.location)).to_track_quat('-Z', 'Y').to_euler()
    top.location = (0.0, 0.2, 3.4)
    top.data.energy = 60
    rim.data.energy = 36
    scene.render.resolution_x, scene.render.resolution_y = 1200, 1600
    cam_data.lens = 62
    look((2.35, -3.9, 1.75), (0.0, 0.0, 0.52))
    still('blender-exploded.png')
    print('stills written')
