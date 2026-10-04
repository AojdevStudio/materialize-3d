//! Bambu project 3MF for a checked model.
//!
//! Layout mirrors a Bambu Studio GUI project: one mesh object per body, one
//! assembly object whose components are those bodies, one build item placing
//! the model at the bed center, per-part extruders in
//! `Metadata/model_settings.config`, and the printer profile's verified slicer
//! configuration in `Metadata/project_settings.config`. Output is byte-for-byte
//! deterministic.

use std::fmt::Write as _;
use std::io::{Cursor, Write as _};
use std::path::Path;

use serde::Serialize;
use serde_json::Value;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, DateTime, ZipWriter};

use super::checks::CheckedModel;
use super::model::PrintableModel;
use super::printer::{PrinterProfile, Um};
use super::revisions::Sha256Hex;

/// The Bambu Studio release the printer templates were exported from.
const APPLICATION: &str = "BambuStudio-02.08.02.61";
/// Arbitrary but fixed instance identity, as a GUI project would carry.
const IDENTIFY_ID: u32 = 1001;

const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="application/octet-stream"/></Types>
"#;
/// `[Content_Types].xml` for a package that carries a STEP: the same types plus `.step`.
const CONTENT_TYPES_WITH_STEP: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="application/octet-stream"/><Default Extension="step" ContentType="model/step"/></Types>
"#;
const RELS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>
"#;

#[derive(Debug, thiserror::Error)]
pub enum PackageError {
    #[error("package: {0}")]
    Package(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

type Result<T, E = PackageError> = std::result::Result<T, E>;

/// Where a package stores a part's STEP. Bambu Studio slices a package with a
/// member here exactly as it slices one without it
/// (`cad-runtime/evidence/step-in-3mf.log`).
pub const STEP_MEMBER: &str = "Metadata/part.step";

/// A file a build makes beside its model. The package stores it as a member,
/// so the package hash, and the approval bound to it, cover it too.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExtraArtifact {
    /// A part's STEP, as the inspection guest re-exported it.
    Step(Vec<u8>),
}

impl ExtraArtifact {
    /// The package member that holds it.
    pub fn member(&self) -> &'static str {
        match self {
            ExtraArtifact::Step(_) => STEP_MEMBER,
        }
    }

    pub fn bytes(&self) -> &[u8] {
        match self {
            ExtraArtifact::Step(bytes) => bytes,
        }
    }
}

/// The STEP inside `package`, the bytes of a whole 3MF, if it holds one.
/// Exporting reads it from bytes already checked against the approved hash,
/// so it is exactly the STEP the person approved.
pub fn included_step(package: &[u8]) -> Result<Option<Vec<u8>>> {
    let zip_err = |e: zip::result::ZipError| PackageError::Package(e.to_string());
    let mut zip = zip::ZipArchive::new(Cursor::new(package)).map_err(zip_err)?;
    let mut member = match zip.by_name(STEP_MEMBER) {
        Ok(member) => member,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(e) => return Err(zip_err(e)),
    };
    let mut step = Vec::new();
    std::io::Read::read_to_end(&mut member, &mut step)?;
    Ok(Some(step))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PackageInfo {
    /// Lowercase hex SHA-256 of the written file.
    pub sha256: String,
    pub bytes: u64,
    /// Part names in filament-slot order.
    pub part_names: Vec<String>,
}

/// Writes the 3MF for `checked` to `out`, which must not exist yet.
///
/// Only a model that passed its check plan can be packaged, and the files it was
/// certified with ([`CheckedModel::extra`]) go in with it. `object_name` names
/// the assembly object in `3D/3dmodel.model` and `model_settings.config`, which
/// is the name Bambu Studio prints in slicing warnings; the model's title goes
/// into the 3MF `Title` metadata. The printer's project template is embedded with
/// its `filament_colour` and `filament_multi_colour` replaced by the palette.
/// The file is written to a temporary sibling and moved into place without
/// overwriting.
///
/// ```
/// use materialize_3d_lib::fabrication::{checks::CheckedModel, package::write_package, printer::P2S_04};
/// fn package(checked: &CheckedModel) {
///     let _ = write_package(checked, checked.model().title(), &P2S_04, std::path::Path::new("out.3mf"));
/// }
/// ```
///
/// An unchecked model does not compile:
///
/// ```compile_fail,E0308
/// use materialize_3d_lib::fabrication::{model::PrintableModel, package::write_package, printer::P2S_04};
/// fn package(model: &PrintableModel) {
///     let _ = write_package(model, model.title(), &P2S_04, std::path::Path::new("out.3mf"));
/// }
/// ```
pub fn write_package(
    checked: &CheckedModel,
    object_name: &str,
    printer: &PrinterProfile,
    out: &Path,
) -> Result<PackageInfo> {
    let model = checked.model();
    if out.exists() {
        return Err(PackageError::Io(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("{} already exists", out.display()),
        )));
    }

    let bytes = package_bytes(model, checked.extra(), object_name, printer)?;
    let dir = match out.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    let mut temp = tempfile::Builder::new()
        .prefix(".package-")
        .suffix(".3mf.partial")
        .tempfile_in(dir)?;
    temp.write_all(&bytes)?;
    temp.as_file().sync_all()?;
    temp.persist_noclobber(out)
        .map_err(|e| PackageError::Io(e.error))?;

    Ok(PackageInfo {
        sha256: Sha256Hex::of_bytes(&bytes).into(),
        bytes: bytes.len() as u64,
        part_names: model.bodies().iter().map(|b| b.name.clone()).collect(),
    })
}

/// A model without extras is written exactly as before extras existed, so a
/// sign's package stays byte-identical.
fn package_bytes(
    model: &PrintableModel,
    extra: &[ExtraArtifact],
    object_name: &str,
    printer: &PrinterProfile,
) -> Result<Vec<u8>> {
    let content_types = if extra.is_empty() { CONTENT_TYPES } else { CONTENT_TYPES_WITH_STEP };
    let mut entries = vec![
        ("[Content_Types].xml", content_types.as_bytes().to_vec()),
        ("_rels/.rels", RELS.as_bytes().to_vec()),
        ("3D/3dmodel.model", model_xml(model, object_name, printer).into_bytes()),
        (
            "Metadata/model_settings.config",
            model_settings_xml(model, object_name, printer).into_bytes(),
        ),
        (
            "Metadata/project_settings.config",
            project_settings(model, printer)?,
        ),
    ];
    entries.extend(extra.iter().map(|artifact| (artifact.member(), artifact.bytes().to_vec())));

    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(6))
        .last_modified_time(DateTime::default())
        .unix_permissions(0o644);
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let zip_err = |e: zip::result::ZipError| PackageError::Package(e.to_string());
    for (name, data) in entries {
        zip.start_file(name, options).map_err(zip_err)?;
        zip.write_all(&data)?;
    }
    Ok(zip.finish().map_err(zip_err)?.into_inner())
}

/// µm as a fixed three-decimal millimeter string; exact and platform independent.
fn fmt_um(v: Um) -> String {
    let sign = if v < 0 { "-" } else { "" };
    let a = v.unsigned_abs();
    format!("{sign}{}.{:03}", a / 1000, a % 1000)
}

fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            c => out.push(c),
        }
    }
    out
}

fn assembly_id(model: &PrintableModel) -> usize {
    model.bodies().len() + 1
}

fn model_xml(model: &PrintableModel, object_name: &str, printer: &PrinterProfile) -> String {
    let mut x = String::with_capacity(
        model
            .bodies()
            .iter()
            .map(|b| b.mesh.vertices().len() * 64 + b.mesh.triangles().len() * 48)
            .sum::<usize>()
            + 1024,
    );
    x.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    x.push_str("<model xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\" unit=\"millimeter\" xml:lang=\"en-US\">\n");
    let _ = writeln!(
        x,
        " <metadata name=\"Application\">{APPLICATION}</metadata>"
    );
    let _ = writeln!(x, " <metadata name=\"Title\">{}</metadata>", escape(model.title()));
    x.push_str(" <resources>\n");
    for (i, body) in model.bodies().iter().enumerate() {
        let _ = writeln!(
            x,
            "  <object id=\"{}\" type=\"model\" name=\"{}\">\n   <mesh>\n    <vertices>",
            i + 1,
            escape(&body.name)
        );
        for v in body.mesh.vertices() {
            let _ = writeln!(
                x,
                "     <vertex x=\"{}\" y=\"{}\" z=\"{}\"/>",
                fmt_um(v[0]),
                fmt_um(v[1]),
                fmt_um(v[2])
            );
        }
        x.push_str("    </vertices>\n    <triangles>\n");
        for t in body.mesh.triangles() {
            let _ = writeln!(
                x,
                "     <triangle v1=\"{}\" v2=\"{}\" v3=\"{}\"/>",
                t[0], t[1], t[2]
            );
        }
        x.push_str("    </triangles>\n   </mesh>\n  </object>\n");
    }
    let _ = writeln!(
        x,
        "  <object id=\"{}\" type=\"model\" name=\"{}\">\n   <components>",
        assembly_id(model),
        escape(object_name)
    );
    for i in 0..model.bodies().len() {
        let _ = writeln!(x, "    <component objectid=\"{}\"/>", i + 1);
    }
    x.push_str("   </components>\n  </object>\n </resources>\n <build>\n");
    // Center the footprint (the x-y bounds of every vertex) on the bed.
    let [lo, hi] = model.bounds();
    let center = printer.bed_center();
    let tx = (2 * center[0] - (lo[0] + hi[0])) as f64 / 2000.0;
    let ty = (2 * center[1] - (lo[1] + hi[1])) as f64 / 2000.0;
    let _ = writeln!(
        x,
        "  <item objectid=\"{}\" transform=\"1 0 0 0 1 0 0 0 1 {tx:.4} {ty:.4} 0\" printable=\"1\"/>",
        assembly_id(model)
    );
    x.push_str(" </build>\n</model>\n");
    x
}

/// Each part is written on one line, `<part ...><metadata key="name" .../>
/// <metadata key="extruder" .../>...`, the shape the layer-1 verification
/// script (tmp/m1/layer1.py) matches.
fn model_settings_xml(model: &PrintableModel, object_name: &str, printer: &PrinterProfile) -> String {
    let id = assembly_id(model);
    let mut x = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<config>\n");
    let _ = writeln!(x, " <object id=\"{id}\">");
    let _ = writeln!(x, "  <metadata key=\"name\" value=\"{}\" />", escape(object_name));
    x.push_str("  <metadata key=\"extruder\" value=\"1\" />\n");
    // Carried over from the proven Python recipe's object override.
    x.push_str("  <metadata key=\"wall_generator\" value=\"arachne\" />\n");
    for (i, body) in model.bodies().iter().enumerate() {
        let _ = writeln!(
            x,
            "  <part id=\"{}\" subtype=\"normal_part\"><metadata key=\"name\" value=\"{}\" /><metadata key=\"extruder\" value=\"{}\" /><mesh_stat face_count=\"{}\" edges_fixed=\"0\" degenerate_facets=\"0\" facets_removed=\"0\" facets_reversed=\"0\" backwards_edges=\"0\" /></part>",
            i + 1,
            escape(&body.name),
            body.slot.number(),
            body.mesh.triangles().len()
        );
    }
    x.push_str(" </object>\n <plate>\n");
    // One entry per printer slot.
    let per_slot = |value: &str| vec![value; usize::from(printer.slots)].join(" ");
    let (filament_maps, filament_volume_maps) = (per_slot("1"), per_slot("0"));
    for (key, value) in [
        ("plater_id", "1"),
        ("plater_name", ""),
        ("locked", "false"),
        ("filament_map_mode", "Auto For Flush"),
        ("filament_maps", filament_maps.as_str()),
        ("filament_volume_maps", filament_volume_maps.as_str()),
    ] {
        let _ = writeln!(x, "  <metadata key=\"{key}\" value=\"{value}\" />");
    }
    x.push_str("  <model_instance>\n");
    let _ = writeln!(x, "   <metadata key=\"object_id\" value=\"{id}\" />");
    x.push_str("   <metadata key=\"instance_id\" value=\"0\" />\n");
    let _ = writeln!(
        x,
        "   <metadata key=\"identify_id\" value=\"{IDENTIFY_ID}\" />"
    );
    x.push_str("  </model_instance>\n </plate>\n</config>\n");
    x
}

/// The printer's template with the palette's colours in its filament slots.
fn project_settings(model: &PrintableModel, printer: &PrinterProfile) -> Result<Vec<u8>> {
    let slots = usize::from(printer.slots);
    if model.palette().colours().len() > slots {
        return Err(PackageError::Package(format!(
            "palette has {} filaments; the printer has {slots} slots",
            model.palette().colours().len()
        )));
    }
    let mut settings: Value = serde_json::from_str(printer.template)
        .map_err(|e| PackageError::Package(format!("project settings template: {e}")))?;
    let object = settings.as_object_mut().ok_or_else(|| {
        PackageError::Package("project settings template is not a JSON object".into())
    })?;
    for key in [
        "filament_colour",
        "filament_multi_colour",
        "filament_settings_id",
    ] {
        let found = object.get(key).and_then(Value::as_array).map(Vec::len);
        if found != Some(slots) {
            return Err(PackageError::Package(format!(
                "project settings template {key} must list {slots} filaments, found {found:?}"
            )));
        }
    }
    let matrix = object
        .get("flush_volumes_matrix")
        .and_then(Value::as_array)
        .map(Vec::len);
    if matrix != Some(slots * slots) {
        return Err(PackageError::Package(format!(
            "project settings template flush_volumes_matrix must be {slots}x{slots}, found {matrix:?} entries"
        )));
    }
    let colours: Vec<Value> = model.palette().slot_colours(printer).into_iter().map(Value::from).collect();
    object.insert("filament_colour".into(), Value::Array(colours.clone()));
    object.insert("filament_multi_colour".into(), Value::Array(colours));
    let mut bytes = serde_json::to_vec_pretty(&settings)
        .map_err(|e| PackageError::Package(format!("project settings: {e}")))?;
    bytes.push(b'\n');
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use std::io::Read;

    use super::*;
    use crate::fabrication::printer::P2S_04;
    use crate::fabrication::kinds::sign::{build_model, check_geometry, check_plan, GeometryCheck, SignDesign, ValidSignSpec};

    fn checked() -> CheckedModel {
        let spec = ValidSignSpec::from_json(include_str!("../../tests/fixtures/signs/synthetic-one-ink.json"), &P2S_04).expect("spec");
        let design = SignDesign::new(spec).expect("layout");
        let model = build_model(design.layout(), design.spec().title(), &P2S_04).expect("model");
        let evidence = check_geometry(design.layout(), &model).iter().map(GeometryCheck::outcome).collect();
        check_plan(design.spec()).expect("plan").certify(model, Vec::new(), evidence).expect("certified")
    }

    fn entry(path: &Path, name: &str) -> String {
        let mut zip = zip::ZipArchive::new(std::fs::File::open(path).expect("package")).expect("zip");
        let mut text = String::new();
        zip.by_name(name).expect(name).read_to_string(&mut text).expect("utf-8");
        text
    }

    #[test]
    fn the_object_name_names_the_assembly_and_the_title_stays_in_metadata() {
        let dir = tempfile::tempdir().expect("tempdir");
        let checked = checked();
        assert_eq!(checked.model().title(), "One ink");
        let out = dir.path().join("part.3mf");
        write_package(&checked, "part-0123456789ab", &P2S_04, &out).expect("package");

        let model = entry(&out, "3D/3dmodel.model");
        assert!(model.contains(r#"<metadata name="Title">One ink</metadata>"#), "{model:.400}");
        assert!(model.contains(r#"<object id="3" type="model" name="part-0123456789ab">"#));
        assert!(!model.contains(r#"name="One ink""#));
        let settings = entry(&out, "Metadata/model_settings.config");
        assert!(settings.contains(r#"<object id="3">
  <metadata key="name" value="part-0123456789ab" />"#), "{settings}");
        assert!(!settings.contains("One ink"));
    }

    /// A part's STEP is a member of its package, so the package hash covers
    /// it; a model without one is written as it always was.
    #[test]
    fn a_checked_step_is_packaged_and_reads_back_exactly() {
        use crate::fabrication::checks::{CheckId, CheckOutcome, CheckPhase, CheckPlan, CheckPlanId};
        let dir = tempfile::tempdir().expect("tempdir");
        let step = b"ISO-10303-21;\nEND-ISO-10303-21;\n".to_vec();
        let id = CheckId::new(CheckPhase::Geometry, "closed.a");
        let plan = CheckPlan::new(CheckPlanId::new("p"), vec![id.clone()]).expect("plan");
        let with_step = plan
            .certify(crate::fabrication::checks::test_support::model(), vec![ExtraArtifact::Step(step.clone())], vec![CheckOutcome { id, passed: true, detail: String::new() }])
            .expect("certified");
        let out = dir.path().join("part.3mf");
        let info = write_package(&with_step, "part-0123456789ab", &P2S_04, &out).expect("package");
        let bytes = std::fs::read(&out).expect("read");
        assert_eq!(included_step(&bytes).expect("zip"), Some(step));
        assert!(entry(&out, "[Content_Types].xml").contains(r#"<Default Extension="step" ContentType="model/step"/>"#));
        assert_eq!(Sha256Hex::of_bytes(&bytes).as_str(), info.sha256);

        let sign = dir.path().join("sign.3mf");
        write_package(&checked(), "One ink", &P2S_04, &sign).expect("package");
        assert_eq!(included_step(&std::fs::read(&sign).expect("read")).expect("zip"), None);
        assert_eq!(entry(&sign, "[Content_Types].xml"), CONTENT_TYPES, "no STEP, no change");
    }
}
