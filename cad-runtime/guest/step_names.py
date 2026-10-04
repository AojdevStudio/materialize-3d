"""STEP with named bodies, through OpenCascade's XCAF document: each body is one free shape carrying its name, so a
CAD program that opens the STEP shows the same body names the app does. Used by the generation guest to write the
script's bodies and by the inspection guest to re-export them under the names the host checked.
"""

from OCP.IFSelect import IFSelect_RetDone
from OCP.STEPCAFControl import STEPCAFControl_Reader, STEPCAFControl_Writer
from OCP.STEPControl import STEPControl_AsIs
from OCP.TCollection import TCollection_ExtendedString
from OCP.TDataStd import TDataStd_Name
from OCP.TDocStd import TDocStd_Document
from OCP.XCAFDoc import XCAFDoc_DocumentTool
from OCP.collections import Sequence_TDF_Label


def write_named_step(named, path):
    """Writes [(name, shape)] to `path`, one free shape per entry, in order. Returns whether it succeeded."""
    doc = TDocStd_Document(TCollection_ExtendedString("XmlXCAF"))
    shapes = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    for name, shape in named:
        label = shapes.AddShape(shape, False)
        TDataStd_Name.Set_s(label, TCollection_ExtendedString(name, True))
    writer = STEPCAFControl_Writer()
    writer.SetNameMode(True)
    return bool(writer.Transfer(doc, STEPControl_AsIs)) and writer.Write(path) == IFSelect_RetDone


def read_step_shapes(path):
    """The free shapes of the STEP at `path`, in file order, or None when it cannot be read."""
    reader = STEPCAFControl_Reader()
    reader.SetNameMode(True)
    if reader.ReadFile(path) != IFSelect_RetDone:
        return None
    doc = TDocStd_Document(TCollection_ExtendedString("XmlXCAF"))
    if not reader.Transfer(doc):
        return None
    shapes = XCAFDoc_DocumentTool.ShapeTool_s(doc.Main())
    labels = Sequence_TDF_Label()
    shapes.GetFreeShapes(labels)
    return [shapes.GetShape_s(labels.Value(i)) for i in range(1, labels.Length() + 1)]
