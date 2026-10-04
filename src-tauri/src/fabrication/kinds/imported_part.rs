//! The `imported_part` kind: a mesh made elsewhere, such as a body exported
//! from Fusion, brought in for checking, slicing, and approval.
//!
//! Only `import_part` starts one. It copies the caller's file into the input
//! store ([`InputStore`](crate::fabrication::inputs::InputStore)) and builds a spec that names the stored file by its
//! hash, so a revision never depends on the caller's path. The build reads the
//! stored file again, hashed, and parses it in Rust ([`mesh::read`]): no guest
//! and no Python, and nothing in the file runs.
//!
//! An imported part is one body, `body`, on filament slot 1. It is checked
//! like a part with no requirements: the four mesh checks block, the three
//! print checks warn, and the slice and handoff checks follow, with Bambu
//! Studio's support warning advisory. The package names its object after the
//! build key ([`ObjectNaming::BuildKey`]), so the title a caller chose never
//! reaches a slicer warning.

mod mesh;

#[cfg(test)]
pub(crate) mod tests;

pub use mesh::{
    MeshImportError, Units, MAX_ABS_MM, MAX_EXPANDED_BYTES, MAX_TRIANGLES, MAX_VERTICES, MAX_ZIP_ENTRIES,
};

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use super::part::{measure, plan, render_views};
use crate::fabrication::checks::{CheckOutcome, CheckPlan, CheckPlanId, InvalidPlan};
use crate::fabrication::kind::{
    BuildControl, Built, KernelContext, KernelError, KindId, ObjectKind, ObjectNaming, SpecError, View, ViewSet,
};
use crate::fabrication::model::{Body, Palette, PrintableModel};
use crate::fabrication::printer::{PrinterProfile, Um};
use crate::fabrication::revisions::Sha256Hex;

/// Schema version this build accepts in [`ImportedPartSpec::schema_version`].
pub const IMPORTED_PART_SCHEMA_VERSION: u32 = 1;
/// Version of the imported part's check plan: one body's mesh and print
/// checks, then the shared slice and handoff checks and the support warning.
pub const IMPORTED_PART_CHECK_PLAN: CheckPlanId = CheckPlanId::new("imported-part-checks-1");
/// The name of an imported part's one body, in its check ids and its package.
pub const BODY: &str = "body";
const MAX_TITLE_CHARS: usize = 80;
/// The colour the body is written in: the neutral gray a part uses for a
/// filament with no colour.
const COLOUR: &str = "#808080";

/// An imported part as the input store and `revise` see it. `import_part`
/// writes it; no tool takes one from a caller whole.
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ImportedPartSpec {
    pub schema_version: u32,
    /// Shown in revision lists and kept in the 3MF's Title metadata.
    pub title: String,
    /// The SHA-256 of the imported file, which names it in the input store.
    pub input_sha256: String,
    /// The unit the file's coordinates are in.
    pub units: Units,
}

impl ImportedPartSpec {
    pub fn new(title: &str, input_sha256: &Sha256Hex, units: Units) -> Self {
        Self { schema_version: IMPORTED_PART_SCHEMA_VERSION, title: title.to_owned(), input_sha256: input_sha256.to_string(), units }
    }
}

/// An imported part spec that passed validation: a title, the hash of a
/// stored input, and its unit. Its JSON is what the build key hashes, so the
/// same file, title, and unit build once.
#[derive(Debug, Clone, Serialize)]
pub struct ValidImportedPart {
    schema_version: u32,
    title: String,
    input_sha256: Sha256Hex,
    units: Units,
    #[serde(skip)]
    palette: Palette,
    /// The printer's build volume, which the body must fit.
    #[serde(skip)]
    bed: [Um; 3],
}

impl ValidImportedPart {
    pub fn parse(spec: ImportedPartSpec, printer: &PrinterProfile) -> Result<Self, SpecError> {
        if spec.schema_version != IMPORTED_PART_SCHEMA_VERSION {
            return Err(SpecError(format!(
                "schema_version {} is not supported (expected {IMPORTED_PART_SCHEMA_VERSION})",
                spec.schema_version
            )));
        }
        let title = spec.title.trim();
        if title.is_empty() || title.chars().count() > MAX_TITLE_CHARS || title.chars().any(char::is_control) {
            return Err(SpecError(format!("title must be 1 to {MAX_TITLE_CHARS} characters with no control characters")));
        }
        let input_sha256 = Sha256Hex::try_from(spec.input_sha256)
            .map_err(|_| SpecError("input_sha256 must be 64 lowercase hex digits".into()))?;
        let palette = Palette::new(vec![COLOUR.to_owned()], printer).map_err(|e| SpecError(e.to_string()))?;
        Ok(Self { schema_version: spec.schema_version, title: title.to_owned(), input_sha256, units: spec.units, palette, bed: printer.bed })
    }

    pub fn title(&self) -> &str {
        &self.title
    }
}

/// The `imported_part` kind.
pub struct ImportedPart;

impl ObjectKind for ImportedPart {
    type Spec = ImportedPartSpec;
    type Valid = ValidImportedPart;

    const ID: KindId = KindId::new("imported_part");
    /// Bump it when the reader changes what a stored file builds into.
    const TAG: &'static str = "imported-part-1";
    const SUMMARY: &'static str = "a mesh made elsewhere, such as in Fusion, imported from a 3MF or STL file";
    const GUIDE: &'static str = "\
An imported part is a mesh made in another program, such as a body exported from Fusion. \
Only import_part makes one: it takes the file's path, a title, and the unit the file uses (mm or in). \
A 3MF must state that same unit; an STL has none, so units is its unit. \
The file holds one body: export one body at a time. The app sets it on the bed without turning it. \
Its mesh checks block; its overhang, wall, and first-layer checks only warn, and a person acknowledges the warnings when approving. \
To fix the unit or the title, revise it with {\"units\": \"in\"} or {\"title\": \"...\"}.";
    const VIEWS: &'static [View] = &[View::Isometric, View::Front, View::Top];
    const NAMING: ObjectNaming = ObjectNaming::BuildKey;

    fn available(ctx: &KernelContext) -> bool {
        ctx.inputs.is_some()
    }

    fn validate(spec: ImportedPartSpec, printer: &PrinterProfile) -> Result<ValidImportedPart, SpecError> {
        ValidImportedPart::parse(spec, printer)
    }

    fn title(valid: &ValidImportedPart) -> String {
        valid.title.clone()
    }

    fn check_plan(_valid: &ValidImportedPart, _printer: &PrinterProfile) -> Result<CheckPlan, InvalidPlan> {
        plan(IMPORTED_PART_CHECK_PLAN, &[], &[BODY])
    }

    /// The stored file, hashed again, read into one body on the bed.
    fn model(valid: &ValidImportedPart, ctx: &KernelContext, control: &BuildControl<'_>) -> Result<Built, KernelError> {
        let store = ctx.inputs.as_ref().ok_or_else(|| KernelError::Failed("the input store is unavailable".into()))?;
        let bytes = store.get(&valid.input_sha256).map_err(|e| KernelError::Failed(e.to_string()))?;
        if control.is_cancelled() {
            return Err(KernelError::Cancelled);
        }
        let mesh = mesh::read(&bytes, valid.units).map_err(|e| KernelError::Failed(format!("import: {e}")))?;
        let slot = valid.palette.slot(0).expect("the palette has one filament");
        let body = Body { name: BODY.to_owned(), slot, mesh };
        let model = PrintableModel::new(valid.title.clone(), valid.palette.clone(), vec![body]).map_err(|e| KernelError::Failed(e.to_string()))?;
        Ok(Built { model, extra: Vec::new() })
    }

    fn measure(valid: &ValidImportedPart, model: &PrintableModel, control: &BuildControl<'_>) -> Result<Vec<CheckOutcome>, KernelError> {
        measure::measure(valid.bed, &[], model, &|| control.is_cancelled())
    }

    fn preview(_valid: &ValidImportedPart, model: &PrintableModel) -> Result<ViewSet, KernelError> {
        render_views(Self::VIEWS, model)
    }
}

/// Reads `bytes` as an imported mesh in `units`, as the build will, so a file
/// that is not one is refused before it is stored or recorded.
pub fn check_file(bytes: &[u8], units: Units) -> Result<(), MeshImportError> {
    mesh::read(bytes, units).map(drop)
}
