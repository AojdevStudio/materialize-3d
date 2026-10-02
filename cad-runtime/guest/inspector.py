"""Inspection guest program, pinned in the image: normalize an untrusted STEP into what the host checks.

Parses /job/in/model.step, rejects anything that is not one or more valid solids, re-exports the parsed shapes to
/job/out/normalized.step, and tessellates those same in-memory shapes into /job/out/mesh.bin. The host welds and
checks the mesh in Rust; this program never decides whether a part is good.

mesh.bin, little endian: b"M3DMESH1", u32 body count, then per body u32 vertex count, u32 triangle count,
vertex count * 3 f64 (mm), triangle count * 3 u32 vertex indices (counterclockwise seen from outside).
Vertices are listed per face. Each face evaluates its boundary nodes on its own surface, and two faces that share an
edge can disagree by up to the edge's tolerance (more than 1 um on fillets and boolean edges). So every node on an
edge is re-placed on the edge's own 3D curve at that node's parameter, and every edge end on the shared vertex: the
faces on both sides then emit bit-identical points, and the host's 1 um weld joins them exactly.
"""

import json
import struct
import sys
from array import array

# Part of the build key: changing either changes every mesh. At 0.01 mm, BRepMesh reported success yet left six
# cylindrical faces of the reference cable clip untriangulated; 0.02 mm (20 um chord error) meshes every face.
LINEAR_DEFLECTION_MM = 0.02
ANGULAR_DEFLECTION_RAD = 0.2
MAX_BODIES = 16


def fail(message):
    with open("/job/out/result.json", "w") as f:
        json.dump({"ok": False, "error": message[:2000]}, f)
    sys.exit(1)


def main():
    from OCP.BRep import BRep_Tool
    from OCP.BRepAdaptor import BRepAdaptor_Curve
    from OCP.BRepCheck import BRepCheck_Analyzer
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.STEPControl import STEPControl_AsIs, STEPControl_Reader, STEPControl_Writer
    from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE, TopAbs_REVERSED, TopAbs_SOLID
    from OCP.TopExp import TopExp, TopExp_Explorer
    from OCP.TopLoc import TopLoc_Location
    from OCP.TopoDS import TopoDS

    reader = STEPControl_Reader()
    if reader.ReadFile("/job/in/model.step") != IFSelect_RetDone:
        fail("STEP could not be read")
    reader.TransferRoots()
    count = reader.NbShapes()
    if not 1 <= count <= MAX_BODIES:
        fail(f"STEP holds {count} shapes; expected 1 to {MAX_BODIES}")
    shapes = [reader.Shape(i) for i in range(1, count + 1)]

    for i, shape in enumerate(shapes):
        if shape.IsNull() or not TopExp_Explorer(shape, TopAbs_SOLID).More():
            fail(f"shape {i} has no solid")
        if not BRepCheck_Analyzer(shape).IsValid():
            fail(f"shape {i} is not a valid solid")

    writer = STEPControl_Writer()
    for shape in shapes:
        if writer.Transfer(shape, STEPControl_AsIs) != IFSelect_RetDone:
            fail("STEP re-export failed")
    if writer.Write("/job/out/normalized.step") != IFSelect_RetDone:
        fail("STEP write failed")

    out = bytearray(b"M3DMESH1")
    out += struct.pack("<I", len(shapes))
    for i, shape in enumerate(shapes):
        BRepMesh_IncrementalMesh(shape, LINEAR_DEFLECTION_MM, False, ANGULAR_DEFLECTION_RAD, True)
        coords, indices = array("d"), array("I")
        max_shift = 0.0
        faces = TopExp_Explorer(shape, TopAbs_FACE)
        while faces.More():
            face = TopoDS.Face(faces.Current())
            loc = TopLoc_Location()
            tri = BRep_Tool.Triangulation_s(face, loc)
            if tri is None:
                fail(f"shape {i} has a face that did not tessellate")
            trsf = loc.Transformation()
            base = len(coords) // 3
            points = [tri.Node(n).Transformed(trsf) for n in range(1, tri.NbNodes() + 1)]
            edges = TopExp_Explorer(face, TopAbs_EDGE)
            while edges.More():
                edge = TopoDS.Edge(edges.Current())
                poly = BRep_Tool.PolygonOnTriangulation_s(edge, tri, loc)
                if poly is None or not poly.HasParameters():
                    fail(f"shape {i} has an edge without a shared discretization")
                if not BRep_Tool.Degenerated_s(edge):
                    curve = BRepAdaptor_Curve(edge)
                    first, last = curve.FirstParameter(), curve.LastParameter()
                    ends = (BRep_Tool.Pnt_s(TopExp.FirstVertex_s(edge)), BRep_Tool.Pnt_s(TopExp.LastVertex_s(edge)))
                    nodes, params, count = poly.Nodes(), poly.Parameters(), poly.NbNodes()
                    for k in range(1, count + 1):
                        t = params.Value(k)
                        if k in (1, count):
                            p = ends[0] if abs(t - first) <= abs(t - last) else ends[1]
                        else:
                            p = curve.Value(t)
                        n = nodes.Value(k) - 1
                        max_shift = max(max_shift, points[n].Distance(p))
                        points[n] = p
                edges.Next()
            for p in points:
                coords.extend((p.X(), p.Y(), p.Z()))
            reversed_face = face.Orientation() == TopAbs_REVERSED
            for t in range(1, tri.NbTriangles() + 1):
                a, b, c = tri.Triangle(t).Get()
                if reversed_face:
                    b, c = c, b
                indices.extend((base + a - 1, base + b - 1, base + c - 1))
            faces.Next()
        print(f"body {i}: largest edge node correction {max_shift:.6f} mm", file=sys.stderr)
        out += struct.pack("<II", len(coords) // 3, len(indices) // 3)
        out += coords.tobytes()
        out += indices.tobytes()
    with open("/job/out/mesh.bin", "wb") as f:
        f.write(out)
    with open("/job/out/result.json", "w") as f:
        json.dump({"ok": True}, f)


if __name__ == "__main__":
    main()
