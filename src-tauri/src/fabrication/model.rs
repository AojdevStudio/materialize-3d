//! The printable model every kind of object hands to the shared stages.
//!
//! Bodies are in print orientation (z = 0 is the bed) on the 1 µm integer grid.
//! The package writer, check plans, and slice verification read only this, so a
//! kind's own geometry never leaks past the point where it builds a
//! [`PrintableModel`].

use std::collections::BTreeSet;

use super::printer::{PrinterProfile, Um};

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ModelError {
    #[error("palette has {found} filaments; the printer has {slots} slots")]
    PaletteSize { found: usize, slots: u8 },
    #[error("filament colour {0:?} is not uppercase #RRGGBB")]
    Colour(String),
    #[error("triangle {triangle} names vertex {vertex}, but the mesh has {vertices} vertices")]
    VertexIndex { triangle: usize, vertex: u32, vertices: usize },
    #[error("a model needs at least one body")]
    NoBodies,
    #[error("body {0:?} appears more than once")]
    DuplicateBody(String),
    #[error("body {body:?} uses filament slot {slot}, but the palette has {filaments}")]
    SlotOutsidePalette { body: String, slot: u8, filaments: usize },
}

/// Bodies on the bed, the filaments they print in, and the model's title.
#[derive(Debug, Clone, PartialEq)]
pub struct PrintableModel {
    title: String,
    palette: Palette,
    bodies: Vec<Body>,
}

impl PrintableModel {
    /// Refuses a model with no bodies, two bodies of one name (check ids and
    /// 3MF parts are named after bodies), or a body whose slot is not in `palette`.
    pub fn new(title: String, palette: Palette, bodies: Vec<Body>) -> Result<Self, ModelError> {
        if bodies.is_empty() {
            return Err(ModelError::NoBodies);
        }
        let mut names = BTreeSet::new();
        for body in &bodies {
            if !names.insert(body.name.as_str()) {
                return Err(ModelError::DuplicateBody(body.name.clone()));
            }
            if usize::from(body.slot.0) >= palette.colours.len() {
                return Err(ModelError::SlotOutsidePalette {
                    body: body.name.clone(),
                    slot: body.slot.number(),
                    filaments: palette.colours.len(),
                });
            }
        }
        Ok(Self { title, palette, bodies })
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn palette(&self) -> &Palette {
        &self.palette
    }

    pub fn bodies(&self) -> &[Body] {
        &self.bodies
    }

    /// Smallest box holding every vertex, `[min, max]`.
    pub fn bounds(&self) -> [[Um; 3]; 2] {
        let mut lo = [Um::MAX; 3];
        let mut hi = [Um::MIN; 3];
        for v in self.bodies.iter().flat_map(|b| b.mesh.vertices()) {
            for k in 0..3 {
                lo[k] = lo[k].min(v[k]);
                hi[k] = hi[k].max(v[k]);
            }
        }
        [lo, hi]
    }
}

/// One printed part in one filament.
#[derive(Debug, Clone, PartialEq)]
pub struct Body {
    /// Also the 3MF part name and the subject of its checks.
    pub name: String,
    pub slot: Slot,
    pub mesh: Mesh,
}

/// A filament slot that exists in the palette it came from. Only
/// [`Palette::slot`] makes one, so a body cannot name a missing filament.
///
/// ```
/// use materialize_3d_lib::fabrication::model::Palette;
/// use materialize_3d_lib::fabrication::printer::P2S_04;
/// let palette = Palette::new(vec!["#FFFFFF".into()], &P2S_04).unwrap();
/// assert_eq!(palette.slot(0).map(|slot| slot.number()), Some(1));
/// ```
///
/// ```compile_fail,E0423
/// use materialize_3d_lib::fabrication::model::Slot;
/// let _forged = Slot(7);
/// ```
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Slot(u8);

impl Slot {
    /// 1-based filament slot, as the 3MF `extruder` and Bambu Studio count them.
    pub fn number(self) -> u8 {
        self.0 + 1
    }
}

/// Filament colours, one per slot in slot order, as uppercase `#RRGGBB`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Palette {
    colours: Vec<String>,
}

/// Colour written for a printer slot the model does not use.
const UNUSED_SLOT_COLOUR: &str = "#808080";

impl Palette {
    pub fn new(colours: Vec<String>, printer: &PrinterProfile) -> Result<Self, ModelError> {
        if colours.is_empty() || colours.len() > usize::from(printer.slots) {
            return Err(ModelError::PaletteSize { found: colours.len(), slots: printer.slots });
        }
        if let Some(bad) = colours.iter().find(|c| !is_upper_hex_colour(c)) {
            return Err(ModelError::Colour(bad.clone()));
        }
        Ok(Self { colours })
    }

    /// The slot at palette `index` (0-based), if the palette has one.
    pub fn slot(&self, index: usize) -> Option<Slot> {
        (index < self.colours.len()).then(|| Slot(u8::try_from(index).expect("palette fits a printer's slots")))
    }

    pub fn colours(&self) -> &[String] {
        &self.colours
    }

    /// One colour per printer slot; slots past the palette get a neutral gray.
    pub fn slot_colours(&self, printer: &PrinterProfile) -> Vec<String> {
        (0..usize::from(printer.slots))
            .map(|i| self.colours.get(i).map_or(UNUSED_SLOT_COLOUR, String::as_str).to_owned())
            .collect()
    }
}

fn is_upper_hex_colour(colour: &str) -> bool {
    colour.len() == 7
        && colour.starts_with('#')
        && colour[1..].bytes().all(|b| b.is_ascii_digit() || (b'A'..=b'F').contains(&b))
}

/// A triangle mesh on the 1 µm grid whose triangles index its own vertices.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mesh {
    vertices: Vec<[Um; 3]>,
    triangles: Vec<[u32; 3]>,
}

impl Mesh {
    pub fn new(vertices: Vec<[Um; 3]>, triangles: Vec<[u32; 3]>) -> Result<Self, ModelError> {
        for (triangle, t) in triangles.iter().enumerate() {
            if let Some(&vertex) = t.iter().find(|&&i| i as usize >= vertices.len()) {
                return Err(ModelError::VertexIndex { triangle, vertex, vertices: vertices.len() });
            }
        }
        Ok(Self { vertices, triangles })
    }

    pub fn vertices(&self) -> &[[Um; 3]] {
        &self.vertices
    }

    pub fn triangles(&self) -> &[[u32; 3]] {
        &self.triangles
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fabrication::printer::P2S_04;

    fn tetrahedron() -> Mesh {
        Mesh::new(
            vec![[0, 0, 0], [1000, 0, 0], [0, 1000, 0], [0, 0, 1000]],
            vec![[0, 2, 1], [0, 1, 3], [1, 2, 3], [0, 3, 2]],
        )
        .expect("mesh")
    }

    #[test]
    fn a_palette_fits_the_printer_and_uses_uppercase_colours() {
        let colours = |n: usize| vec!["#FFFFFF".to_owned(); n];
        assert_eq!(Palette::new(colours(0), &P2S_04), Err(ModelError::PaletteSize { found: 0, slots: 3 }));
        assert_eq!(Palette::new(colours(4), &P2S_04), Err(ModelError::PaletteSize { found: 4, slots: 3 }));
        for bad in ["#ffffff", "FFFFFF", "#FFFFF", "#FFFFFG"] {
            assert_eq!(Palette::new(vec![bad.into()], &P2S_04), Err(ModelError::Colour(bad.into())));
        }
        let palette = Palette::new(vec!["#FFFFFF".into(), "#1F3A5F".into()], &P2S_04).expect("palette");
        assert_eq!(palette.slot(1).map(Slot::number), Some(2));
        assert_eq!(palette.slot(2), None);
        assert_eq!(palette.slot_colours(&P2S_04), ["#FFFFFF", "#1F3A5F", "#808080"]);
    }

    #[test]
    fn a_mesh_refuses_a_triangle_past_its_vertices() {
        let err = Mesh::new(vec![[0, 0, 0]; 3], vec![[0, 1, 3]]).unwrap_err();
        assert_eq!(err, ModelError::VertexIndex { triangle: 0, vertex: 3, vertices: 3 });
    }

    #[test]
    fn a_model_refuses_no_bodies_duplicate_names_and_slots_from_a_larger_palette() {
        let small = Palette::new(vec!["#FFFFFF".into()], &P2S_04).expect("palette");
        let large = Palette::new(vec!["#FFFFFF".into(), "#000000".into()], &P2S_04).expect("palette");
        let body = |name: &str, slot: Slot| Body { name: name.into(), slot, mesh: tetrahedron() };
        let first = small.slot(0).expect("slot");

        assert_eq!(PrintableModel::new("t".into(), small.clone(), vec![]), Err(ModelError::NoBodies));
        assert_eq!(
            PrintableModel::new("t".into(), small.clone(), vec![body("a", first), body("a", first)]),
            Err(ModelError::DuplicateBody("a".into()))
        );
        let foreign = large.slot(1).expect("slot");
        assert_eq!(
            PrintableModel::new("t".into(), small.clone(), vec![body("a", foreign)]),
            Err(ModelError::SlotOutsidePalette { body: "a".into(), slot: 2, filaments: 1 })
        );
        let model = PrintableModel::new("t".into(), small, vec![body("a", first)]).expect("model");
        assert_eq!(model.bounds(), [[0, 0, 0], [1000, 1000, 1000]]);
    }
}
