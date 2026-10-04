//! Reads an imported mesh into one body on the µm grid, in Rust on the host.
//!
//! A 3MF (what Fusion exports), a binary STL, or an ASCII STL. The bytes are
//! untrusted data and every read of them is bounded: the input store caps the
//! file ([`MAX_INPUT_BYTES`]); a 3MF's zip is refused for zip64, for more than
//! [`MAX_ZIP_ENTRIES`] entries, for an entry name that could leave its folder,
//! or for more than [`MAX_EXPANDED_BYTES`] declared or read once expanded; and
//! the mesh is refused past [`MAX_VERTICES`], [`MAX_TRIANGLES`] (the layer
//! checks' slicing cap), or a coordinate past [`MAX_ABS_MM`]. Nothing in the
//! file is run, and no error repeats the file's own text.

use std::collections::HashMap;
use std::io::{BufReader, Cursor, Read};

use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::fabrication::cad_worker::MeshLimits;
use crate::fabrication::inputs::MAX_INPUT_BYTES;
use crate::fabrication::layers::slice;
use crate::fabrication::model::Mesh;
use crate::fabrication::printer::{Um, UM_PER_MM};

/// Most entries a 3MF's zip may have. Fusion writes about five, and a Bambu
/// Studio project about fifteen.
pub const MAX_ZIP_ENTRIES: usize = 64;
/// Most bytes a 3MF's entries may declare together, and most bytes its model
/// entry may expand to when read.
pub const MAX_EXPANDED_BYTES: u64 = 256 << 20;
/// Most vertices a file may hold before welding, every object counted: the
/// CAD worker's decoder cap.
pub const MAX_VERTICES: usize = MeshLimits::PART.max_vertices as usize;
/// Most triangles a file may hold, every object counted: the layer checks'
/// slicing cap, so an imported part is never verified without its print checks.
pub const MAX_TRIANGLES: usize = slice::MAX_TRIANGLES;
/// Largest coordinate accepted, in mm after the unit is applied: the CAD
/// worker's decoder cap.
pub const MAX_ABS_MM: f64 = MeshLimits::PART.max_abs_mm;
/// Most `<object>`, `<component>`, and `<item>` elements a 3MF may hold.
const MAX_ELEMENTS: usize = 256;
/// The model part every 3MF this reads keeps its mesh in.
const MODEL_ENTRY: &str = "3D/3dmodel.model";

/// The unit a file's coordinates are in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum Units {
    /// Millimeters.
    Mm,
    /// Inches.
    In,
}

impl Units {
    fn mm_per_unit(self) -> f64 {
        match self {
            Units::Mm => 1.0,
            Units::In => 25.4,
        }
    }

    /// The name a 3MF's `unit` attribute gives this unit.
    fn three_mf_name(self) -> &'static str {
        match self {
            Units::Mm => "millimeter",
            Units::In => "inch",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Units::Mm => "mm",
            Units::In => "in",
        }
    }
}

/// Why a file is not imported. The text names the limit or the kind of
/// problem, never the file's own content.
#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum MeshImportError {
    #[error("the file is not a 3MF or an STL mesh")]
    NotAMesh,
    #[error("the file is larger than {MAX_INPUT_BYTES} bytes")]
    TooLarge,
    #[error("the 3MF is not a readable zip")]
    BadZip,
    #[error("the 3MF is a zip64 archive; a 3MF of at most {MAX_INPUT_BYTES} bytes never needs one")]
    Zip64,
    #[error("the 3MF has more than {MAX_ZIP_ENTRIES} zip entries")]
    TooManyEntries,
    #[error("the 3MF has a zip entry name that leaves its folder")]
    UnsafeEntryName,
    #[error("the 3MF expands to more than {MAX_EXPANDED_BYTES} bytes")]
    Expanded,
    #[error("the 3MF has no {MODEL_ENTRY}")]
    NoModel,
    #[error("the 3MF's model is not valid XML at byte {0}")]
    BadXml(u64),
    #[error("the 3MF's model is malformed: {0}")]
    Malformed(&'static str),
    #[error("the 3MF says its unit is {found}, but units is {given}; give the unit the file uses")]
    UnitMismatch { found: String, given: &'static str },
    #[error("the file holds {0} objects; import one body at a time")]
    MultipleObjects(usize),
    #[error("the 3MF refers to a mesh in another file")]
    ExternalMesh,
    #[error("the mesh has more than {MAX_VERTICES} vertices")]
    TooManyVertices,
    #[error("the mesh has more than {MAX_TRIANGLES} triangles")]
    TooManyTriangles,
    #[error("the mesh has a coordinate that is not finite or is beyond {MAX_ABS_MM} mm")]
    BadCoordinate,
    #[error("the mesh has a triangle that names a vertex it does not have")]
    BadIndex,
    #[error("the mesh has no triangles")]
    NoTriangles,
}

type Result<T> = std::result::Result<T, MeshImportError>;

/// The one body in `bytes`, welded onto the 1 µm grid and set on the bed: its
/// lowest point moved to z = 0, its orientation and its x and y kept. A 3MF
/// must state `units` as its own unit (millimeter when it states none); an
/// STL has no unit, so `units` is its unit.
pub fn read(bytes: &[u8], units: Units) -> Result<Mesh> {
    if bytes.len() as u64 > MAX_INPUT_BYTES {
        return Err(MeshImportError::TooLarge);
    }
    let mut welder = Welder::new(units);
    if bytes.starts_with(b"PK\x03\x04") {
        read_3mf(bytes, units, &mut welder, MAX_EXPANDED_BYTES)?;
    } else if let Some(count) = binary_stl_triangles(bytes) {
        read_binary_stl(bytes, count, &mut welder)?;
    } else if bytes.trim_ascii_start().starts_with(b"solid") {
        read_ascii_stl(bytes, &mut welder)?;
    } else {
        return Err(MeshImportError::NotAMesh);
    }
    welder.finish()
}

// ─── Welding ──────────────────────────────────────────────────────────────────

/// Vertices snapped to the µm grid, merged where they land on one point.
struct Welder {
    um_per_unit: f64,
    index: HashMap<[Um; 3], u32>,
    vertices: Vec<[Um; 3]>,
    triangles: Vec<[u32; 3]>,
}

impl Welder {
    fn new(units: Units) -> Self {
        Self { um_per_unit: units.mm_per_unit() * UM_PER_MM as f64, index: HashMap::new(), vertices: Vec::new(), triangles: Vec::new() }
    }

    /// The welded index of a point given in the file's unit.
    fn vertex(&mut self, p: [f64; 3]) -> Result<u32> {
        let um = p.map(|c| c * self.um_per_unit);
        if !um.iter().all(|c| c.is_finite() && c.abs() <= MAX_ABS_MM * UM_PER_MM as f64) {
            return Err(MeshImportError::BadCoordinate);
        }
        // Bounded above, so the rounded value fits.
        let q = um.map(|c| c.round() as Um);
        if let Some(&i) = self.index.get(&q) {
            return Ok(i);
        }
        if self.vertices.len() >= MAX_VERTICES {
            return Err(MeshImportError::TooManyVertices);
        }
        let i = u32::try_from(self.vertices.len()).expect("bounded by MAX_VERTICES");
        self.vertices.push(q);
        self.index.insert(q, i);
        Ok(i)
    }

    fn triangle(&mut self, corners: [[f64; 3]; 3]) -> Result<()> {
        if self.triangles.len() >= MAX_TRIANGLES {
            return Err(MeshImportError::TooManyTriangles);
        }
        let t = [self.vertex(corners[0])?, self.vertex(corners[1])?, self.vertex(corners[2])?];
        self.triangles.push(t);
        Ok(())
    }

    fn finish(self) -> Result<Mesh> {
        let Some(lowest) = self.vertices.iter().map(|v| v[2]).min() else {
            return Err(MeshImportError::NoTriangles);
        };
        let vertices = self.vertices.into_iter().map(|[x, y, z]| [x, y, z - lowest]).collect();
        Ok(Mesh::new(vertices, self.triangles).expect("welding keeps every index in range"))
    }
}

// ─── STL ──────────────────────────────────────────────────────────────────────

/// The triangle count of a binary STL: 80 header bytes, a count, and 50 bytes
/// per triangle, with nothing after them.
fn binary_stl_triangles(bytes: &[u8]) -> Option<usize> {
    let count = u32::from_le_bytes(bytes.get(80..84)?.try_into().ok()?) as usize;
    (bytes.len() as u64 == 84 + 50 * count as u64).then_some(count)
}

fn read_binary_stl(bytes: &[u8], count: usize, welder: &mut Welder) -> Result<()> {
    if count > MAX_TRIANGLES {
        return Err(MeshImportError::TooManyTriangles);
    }
    for record in bytes[84..].as_chunks::<50>().0 {
        // 12 bytes of normal, then three corners of three f32.
        let corner = |k: usize| -> [f64; 3] {
            std::array::from_fn(|axis| {
                let at = 12 + k * 12 + axis * 4;
                f64::from(f32::from_le_bytes([record[at], record[at + 1], record[at + 2], record[at + 3]]))
            })
        };
        welder.triangle([corner(0), corner(1), corner(2)])?;
    }
    Ok(())
}

/// `solid`, then facets of `facet normal`, `outer loop`, three `vertex`
/// lines, `endloop`, and `endfacet`, then `endsolid`.
fn read_ascii_stl(bytes: &[u8], welder: &mut Welder) -> Result<()> {
    let text = std::str::from_utf8(bytes).map_err(|_| MeshImportError::NotAMesh)?;
    let mut corners: Vec<[f64; 3]> = Vec::with_capacity(3);
    for line in text.lines() {
        let mut words = line.split_whitespace();
        match words.next() {
            None | Some("solid" | "facet" | "outer" | "endfacet" | "endsolid") => {}
            Some("vertex") => {
                let mut coordinate = || words.next().and_then(|w| w.parse::<f64>().ok()).ok_or(MeshImportError::NotAMesh);
                let p = [coordinate()?, coordinate()?, coordinate()?];
                if corners.len() == 3 || words.next().is_some() {
                    return Err(MeshImportError::NotAMesh);
                }
                corners.push(p);
            }
            Some("endloop") => {
                let [a, b, c] = corners[..] else { return Err(MeshImportError::NotAMesh) };
                welder.triangle([a, b, c])?;
                corners.clear();
            }
            Some(_) => return Err(MeshImportError::NotAMesh),
        }
    }
    if !corners.is_empty() {
        return Err(MeshImportError::NotAMesh);
    }
    Ok(())
}

// ─── 3MF ──────────────────────────────────────────────────────────────────────

/// Reads a 3MF whose entries may expand to `expanded` bytes: what they
/// declare together, and what its model entry gives when read.
fn read_3mf(bytes: &[u8], units: Units, welder: &mut Welder, expanded: u64) -> Result<()> {
    refuse_zip64(bytes)?;
    let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| MeshImportError::BadZip)?;
    if zip.len() > MAX_ZIP_ENTRIES {
        return Err(MeshImportError::TooManyEntries);
    }
    let mut declared: u64 = 0;
    let mut model = None;
    for i in 0..zip.len() {
        let entry = zip.by_index_raw(i).map_err(|_| MeshImportError::BadZip)?;
        if !safe_entry_name(entry.name_raw()) || entry.enclosed_name().is_none() {
            return Err(MeshImportError::UnsafeEntryName);
        }
        declared = declared.saturating_add(entry.size());
        if declared > expanded {
            return Err(MeshImportError::Expanded);
        }
        if entry.name().eq_ignore_ascii_case(MODEL_ENTRY) {
            model = Some(i);
        }
    }
    let entry = zip.by_index(model.ok_or(MeshImportError::NoModel)?).map_err(|_| MeshImportError::BadZip)?;
    let file = parse_model(Capped { inner: entry, left: expanded, exceeded: false })?;
    file.weld(units, welder)
}

/// Refuses a zip whose end record could lead to a zip64 directory, which is
/// the only way its entry count could exceed what a 16-bit count allows.
fn refuse_zip64(bytes: &[u8]) -> Result<()> {
    const END: &[u8; 4] = b"PK\x05\x06";
    const LOCATOR: &[u8; 4] = b"PK\x06\x07";
    // The end record is 22 bytes plus a comment of up to 65,535, and a zip64
    // locator sits in the 20 bytes before it.
    let tail_start = bytes.len().saturating_sub(22 + 65_535);
    for at in (tail_start..bytes.len().saturating_sub(3)).filter(|&at| &bytes[at..at + 4] == END) {
        if at >= 20 && &bytes[at - 20..at - 16] == LOCATOR {
            return Err(MeshImportError::Zip64);
        }
    }
    Ok(())
}

/// A relative name of plain components: no `..`, no leading separator, no
/// backslash, no drive or stream colon, and no NUL.
fn safe_entry_name(name: &[u8]) -> bool {
    !name.is_empty()
        && !name.starts_with(b"/")
        && !name.iter().any(|&b| matches!(b, b'\\' | b':' | 0))
        && name.split(|&b| b == b'/').all(|part| part != b"..")
}

/// A reader that fails once more than `left` bytes come through it.
struct Capped<R> {
    inner: R,
    left: u64,
    exceeded: bool,
}

impl<R: Read> Read for Capped<R> {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        let want = buf.len().min(usize::try_from(self.left.saturating_add(1)).unwrap_or(usize::MAX));
        let n = self.inner.read(&mut buf[..want])?;
        if n as u64 > self.left {
            self.exceeded = true;
            return Err(std::io::Error::other("expanded past the cap"));
        }
        self.left -= n as u64;
        Ok(n)
    }
}

/// A 3MF transform: `p' = p * M + t`, as twelve numbers row by row.
#[derive(Debug, Clone, Copy)]
struct Transform([f64; 12]);

impl Transform {
    const IDENTITY: Self = Self([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]);

    fn parse(text: &str) -> Result<Self> {
        let values: Vec<f64> = text.split_whitespace().take(13).map(str::parse).collect::<std::result::Result<_, _>>().map_err(|_| MeshImportError::Malformed("a transform is not twelve numbers"))?;
        let values: [f64; 12] = values.try_into().map_err(|_| MeshImportError::Malformed("a transform is not twelve numbers"))?;
        if !values.iter().all(|v| v.is_finite()) {
            return Err(MeshImportError::Malformed("a transform is not twelve numbers"));
        }
        Ok(Self(values))
    }

    fn apply(&self, [x, y, z]: [f64; 3]) -> [f64; 3] {
        let m = &self.0;
        [x * m[0] + y * m[3] + z * m[6] + m[9], x * m[1] + y * m[4] + z * m[7] + m[10], x * m[2] + y * m[5] + z * m[8] + m[11]]
    }

    /// `self`, then `then`.
    fn then(&self, then: &Transform) -> Transform {
        let origin = then.apply(self.apply([0.0; 3]));
        let axis = |k: usize| {
            let mut unit = [0.0; 3];
            unit[k] = 1.0;
            let p = then.apply(self.apply(unit));
            [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]]
        };
        let (x, y, z) = (axis(0), axis(1), axis(2));
        Transform([x[0], x[1], x[2], y[0], y[1], y[2], z[0], z[1], z[2], origin[0], origin[1], origin[2]])
    }
}

enum Object {
    Mesh { vertices: Vec<[f64; 3]>, triangles: Vec<[u32; 3]> },
    Components(Vec<(String, Transform)>),
}

/// What a 3MF model holds, as read: its unit, its objects, its build items.
#[derive(Default)]
struct ModelFile {
    unit: Option<String>,
    objects: HashMap<String, Object>,
    items: Vec<(String, Transform)>,
}

impl ModelFile {
    /// Welds the one body the build places. One build item, of a mesh object
    /// or of an object with one component that is a mesh object, in this file.
    fn weld(self, units: Units, welder: &mut Welder) -> Result<()> {
        let unit = self.unit.as_deref().unwrap_or("millimeter");
        if unit != units.three_mf_name() {
            let found = if unit.len() <= 16 && unit.bytes().all(|b| b.is_ascii_alphabetic()) { unit.to_owned() } else { "not a 3MF unit".to_owned() };
            return Err(MeshImportError::UnitMismatch { found, given: units.as_str() });
        }
        let [(object, placed)] = &self.items[..] else { return Err(MeshImportError::MultipleObjects(self.items.len())) };
        let (mesh, transform) = match self.objects.get(object).ok_or(MeshImportError::Malformed("a build item names a missing object"))? {
            Object::Mesh { .. } => (object, *placed),
            Object::Components(components) => match &components[..] {
                [(inner, local)] => (inner, local.then(placed)),
                many => return Err(MeshImportError::MultipleObjects(many.len())),
            },
        };
        let Some(Object::Mesh { vertices, triangles }) = self.objects.get(mesh) else {
            return Err(MeshImportError::Malformed("a component is not a mesh object"));
        };
        for t in triangles {
            welder.triangle(t.map(|i| transform.apply(vertices[i as usize])))?;
        }
        Ok(())
    }
}

/// Reads the model's XML once, as a stream, counting what it holds.
fn parse_model<R: Read>(source: Capped<R>) -> Result<ModelFile> {
    let mut reader = Reader::from_reader(BufReader::new(source));
    let mut buf = Vec::new();
    let mut file = ModelFile::default();
    let (mut vertex_count, mut triangle_count, mut elements) = (0usize, 0usize, 0usize);
    // The object being read, and its body so far.
    let mut current: Option<(String, Object)> = None;
    loop {
        let event = match reader.read_event_into(&mut buf) {
            Ok(event) => event,
            Err(_) if reader.get_ref().get_ref().exceeded => return Err(MeshImportError::Expanded),
            Err(_) => return Err(MeshImportError::BadXml(reader.buffer_position())),
        };
        let (element, empty) = match &event {
            Event::Start(e) => (e, false),
            Event::Empty(e) => (e, true),
            Event::End(e) if e.local_name().as_ref() == b"object" => {
                let (id, object) = current.take().ok_or(MeshImportError::Malformed("an object ends twice"))?;
                file.objects.insert(id, object);
                buf.clear();
                continue;
            }
            Event::Eof => break,
            _ => {
                buf.clear();
                continue;
            }
        };
        match element.local_name().as_ref() {
            b"model" => file.unit = attr(element, b"unit")?,
            b"object" => {
                elements += 1;
                if elements > MAX_ELEMENTS || current.is_some() {
                    return Err(MeshImportError::Malformed("too many or nested objects"));
                }
                let id = attr(element, b"id")?.ok_or(MeshImportError::Malformed("an object has no id"))?;
                if file.objects.contains_key(&id) {
                    return Err(MeshImportError::Malformed("two objects share an id"));
                }
                let object = Object::Mesh { vertices: Vec::new(), triangles: Vec::new() };
                if empty {
                    file.objects.insert(id, object);
                } else {
                    current = Some((id, object));
                }
            }
            b"vertex" => {
                vertex_count += 1;
                if vertex_count > MAX_VERTICES {
                    return Err(MeshImportError::TooManyVertices);
                }
                let Some((_, Object::Mesh { vertices, .. })) = &mut current else {
                    return Err(MeshImportError::Malformed("a vertex is outside a mesh"));
                };
                vertices.push([number(element, b"x")?, number(element, b"y")?, number(element, b"z")?]);
            }
            b"triangle" => {
                triangle_count += 1;
                if triangle_count > MAX_TRIANGLES {
                    return Err(MeshImportError::TooManyTriangles);
                }
                let Some((_, Object::Mesh { vertices, triangles })) = &mut current else {
                    return Err(MeshImportError::Malformed("a triangle is outside a mesh"));
                };
                let t = [index(element, b"v1")?, index(element, b"v2")?, index(element, b"v3")?];
                if t.iter().any(|&i| i as usize >= vertices.len()) {
                    return Err(MeshImportError::BadIndex);
                }
                triangles.push(t);
            }
            b"component" => {
                elements += 1;
                if elements > MAX_ELEMENTS {
                    return Err(MeshImportError::Malformed("too many components"));
                }
                let reference = reference(element)?;
                let Some((_, object)) = &mut current else {
                    return Err(MeshImportError::Malformed("a component is outside an object"));
                };
                match object {
                    Object::Components(components) => components.push(reference),
                    Object::Mesh { vertices, triangles } if vertices.is_empty() && triangles.is_empty() => {
                        *object = Object::Components(vec![reference]);
                    }
                    Object::Mesh { .. } => return Err(MeshImportError::Malformed("an object has a mesh and components")),
                }
            }
            b"item" => {
                elements += 1;
                if elements > MAX_ELEMENTS {
                    return Err(MeshImportError::Malformed("too many build items"));
                }
                file.items.push(reference(element)?);
            }
            _ => {}
        }
        buf.clear();
    }
    if current.is_some() {
        return Err(MeshImportError::Malformed("an object never ends"));
    }
    Ok(file)
}

/// The text of `element`'s attribute `name`, by local name, if it has one.
/// Only short values are kept: ids, units, numbers, and transforms.
fn attr(element: &BytesStart<'_>, name: &[u8]) -> Result<Option<String>> {
    for attribute in element.attributes() {
        let attribute = attribute.map_err(|_| MeshImportError::Malformed("an attribute is malformed"))?;
        if attribute.key.local_name().as_ref() == name {
            let text = std::str::from_utf8(&attribute.value).map_err(|_| MeshImportError::Malformed("an attribute is not UTF-8"))?;
            if text.len() > 1024 {
                return Err(MeshImportError::Malformed("an attribute is too long"));
            }
            return Ok(Some(text.trim().to_owned()));
        }
    }
    Ok(None)
}

fn number(element: &BytesStart<'_>, name: &[u8]) -> Result<f64> {
    attr(element, name)?
        .and_then(|text| text.parse::<f64>().ok())
        .filter(|n| n.is_finite())
        .ok_or(MeshImportError::BadCoordinate)
}

fn index(element: &BytesStart<'_>, name: &[u8]) -> Result<u32> {
    attr(element, name)?.and_then(|text| text.parse().ok()).ok_or(MeshImportError::BadIndex)
}

/// A component's or a build item's object and transform. A reference to a
/// mesh in another model part (the production extension's `path`) is refused.
fn reference(element: &BytesStart<'_>) -> Result<(String, Transform)> {
    if attr(element, b"path")?.is_some() {
        return Err(MeshImportError::ExternalMesh);
    }
    let object = attr(element, b"objectid")?.ok_or(MeshImportError::Malformed("a reference has no objectid"))?;
    let transform = attr(element, b"transform")?.map_or(Ok(Transform::IDENTITY), |text| Transform::parse(&text))?;
    Ok((object, transform))
}

#[cfg(test)]
pub(super) fn read_3mf_expanding_to(bytes: &[u8], units: Units, expanded: u64) -> Result<Mesh> {
    let mut welder = Welder::new(units);
    read_3mf(bytes, units, &mut welder, expanded)?;
    welder.finish()
}
