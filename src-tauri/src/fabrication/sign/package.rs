//! Bambu project 3MF for a built sign.
//!
//! Layout mirrors a Bambu Studio GUI project: one mesh object per body, one
//! assembly object whose components are those bodies, one build item placing
//! the sign at the bed center, per-part extruders in
//! `Metadata/model_settings.config`, and the verified slicer configuration in
//! `Metadata/project_settings.config`. Output is byte-for-byte deterministic.

use std::fmt::Write as _;
use std::io::{Cursor, Write as _};
use std::path::Path;

use serde::Serialize;
use serde_json::Value;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, DateTime, ZipWriter};

use super::check::check_geometry;
use super::geometry::SignGeometry;
use super::spec::{hex_digest, ValidSignSpec, FILAMENT_SLOTS};
use super::{Result, SignError};

/// Effective settings of Bambu Studio 02.08.02.61 for P2S 0.4 nozzle,
/// 0.20mm Standard, 3x Bambu PLA Basic. See resources/bambu/README.md.
pub static P2S_PROJECT_SETTINGS_TEMPLATE: &str =
    include_str!("../../../resources/bambu/p2s-0.4-pla-basic-x3.project_settings.json");

const APPLICATION: &str = "BambuStudio-02.08.02.61";
/// Center of the 256 x 256 mm P2S bed.
const BED_CENTER_UM: i64 = 128_000;
/// Color for a filament slot the sign does not use.
/// Arbitrary but fixed instance identity, as a GUI project would carry.
const IDENTIFY_ID: u32 = 1001;

const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="application/octet-stream"/></Types>
"#;
const RELS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>
"#;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PackageInfo {
    /// Lowercase hex SHA-256 of the written file.
    pub sha256: String,
    pub bytes: u64,
    /// Part names in filament-slot order.
    pub part_names: Vec<String>,
}

/// Writes the sign's 3MF to `out`, which must not exist yet.
///
/// Refuses geometry that fails any [`check_geometry`] check. `template` is the
/// project settings JSON (normally [`P2S_PROJECT_SETTINGS_TEMPLATE`], parsed);
/// its `filament_colour` and `filament_multi_colour` are replaced with the
/// sign's colors. The file is written to a temporary sibling and moved into
/// place without overwriting.
pub fn write_package(
    geometry: &SignGeometry,
    spec: &ValidSignSpec,
    template: &Value,
    out: &Path,
) -> Result<PackageInfo> {
    if geometry.palette != spec.palette {
        return Err(SignError::Package(
            "geometry was not built from this spec".into(),
        ));
    }
    let failed: Vec<String> = check_geometry(geometry)
        .into_iter()
        .filter(|c| !c.passed)
        .map(|c| format!("{} [{}]: {}", c.name, c.subject, c.detail))
        .collect();
    if !failed.is_empty() {
        return Err(SignError::ChecksFailed(failed.join("; ")));
    }
    if out.exists() {
        return Err(SignError::Io(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            format!("{} already exists", out.display()),
        )));
    }

    let bytes = package_bytes(geometry, spec, template)?;
    let dir = match out.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    let mut temp = tempfile::Builder::new()
        .prefix(".sign-")
        .suffix(".3mf.partial")
        .tempfile_in(dir)?;
    temp.write_all(&bytes)?;
    temp.as_file().sync_all()?;
    temp.persist_noclobber(out)
        .map_err(|e| SignError::Io(e.error))?;

    Ok(PackageInfo {
        sha256: hex_digest(&bytes),
        bytes: bytes.len() as u64,
        part_names: geometry.bodies.iter().map(|b| b.name.clone()).collect(),
    })
}

fn package_bytes(
    geometry: &SignGeometry,
    spec: &ValidSignSpec,
    template: &Value,
) -> Result<Vec<u8>> {
    let title = spec.title().to_owned();
    let entries = [
        ("[Content_Types].xml", CONTENT_TYPES.as_bytes().to_vec()),
        ("_rels/.rels", RELS.as_bytes().to_vec()),
        ("3D/3dmodel.model", model_xml(geometry, &title).into_bytes()),
        (
            "Metadata/model_settings.config",
            model_settings_xml(geometry, &title).into_bytes(),
        ),
        (
            "Metadata/project_settings.config",
            project_settings(spec, template)?,
        ),
    ];

    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .compression_level(Some(6))
        .last_modified_time(DateTime::default())
        .unix_permissions(0o644);
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let zip_err = |e: zip::result::ZipError| SignError::Package(e.to_string());
    for (name, data) in entries {
        zip.start_file(name, options).map_err(zip_err)?;
        zip.write_all(&data)?;
    }
    Ok(zip.finish().map_err(zip_err)?.into_inner())
}

/// µm as a fixed three-decimal millimeter string; exact and platform independent.
fn fmt_um(v: i32) -> String {
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

fn assembly_id(geometry: &SignGeometry) -> usize {
    geometry.bodies.len() + 1
}

fn model_xml(geometry: &SignGeometry, title: &str) -> String {
    let mut x = String::with_capacity(
        geometry
            .bodies
            .iter()
            .map(|b| b.vertices.len() * 64 + b.triangles.len() * 48)
            .sum::<usize>()
            + 1024,
    );
    x.push_str("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n");
    x.push_str("<model xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\" unit=\"millimeter\" xml:lang=\"en-US\">\n");
    let _ = writeln!(
        x,
        " <metadata name=\"Application\">{APPLICATION}</metadata>"
    );
    let _ = writeln!(x, " <metadata name=\"Title\">{}</metadata>", escape(title));
    x.push_str(" <resources>\n");
    for (i, body) in geometry.bodies.iter().enumerate() {
        let _ = writeln!(
            x,
            "  <object id=\"{}\" type=\"model\" name=\"{}\">\n   <mesh>\n    <vertices>",
            i + 1,
            escape(&body.name)
        );
        for v in &body.vertices {
            let _ = writeln!(
                x,
                "     <vertex x=\"{}\" y=\"{}\" z=\"{}\"/>",
                fmt_um(v[0]),
                fmt_um(v[1]),
                fmt_um(v[2])
            );
        }
        x.push_str("    </vertices>\n    <triangles>\n");
        for t in &body.triangles {
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
        assembly_id(geometry),
        escape(title)
    );
    for i in 0..geometry.bodies.len() {
        let _ = writeln!(x, "    <component objectid=\"{}\"/>", i + 1);
    }
    x.push_str("   </components>\n  </object>\n </resources>\n <build>\n");
    // Mesh coordinates span [0, W] x [0, H]; center the footprint on the bed.
    let tx = (2 * BED_CENTER_UM - i64::from(geometry.dims.w)) as f64 / 2000.0;
    let ty = (2 * BED_CENTER_UM - i64::from(geometry.dims.h)) as f64 / 2000.0;
    let _ = writeln!(
        x,
        "  <item objectid=\"{}\" transform=\"1 0 0 0 1 0 0 0 1 {tx:.4} {ty:.4} 0\" printable=\"1\"/>",
        assembly_id(geometry)
    );
    x.push_str(" </build>\n</model>\n");
    x
}

/// Each part is written on one line, `<part ...><metadata key="name" .../>
/// <metadata key="extruder" .../>...`, the shape the layer-1 verification
/// script (tmp/m1/layer1.py) matches.
fn model_settings_xml(geometry: &SignGeometry, title: &str) -> String {
    let id = assembly_id(geometry);
    let mut x = String::from("<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<config>\n");
    let _ = writeln!(x, " <object id=\"{id}\">");
    let _ = writeln!(x, "  <metadata key=\"name\" value=\"{}\" />", escape(title));
    x.push_str("  <metadata key=\"extruder\" value=\"1\" />\n");
    // Carried over from the proven Python recipe's object override.
    x.push_str("  <metadata key=\"wall_generator\" value=\"arachne\" />\n");
    for (i, body) in geometry.bodies.iter().enumerate() {
        let _ = writeln!(
            x,
            "  <part id=\"{}\" subtype=\"normal_part\"><metadata key=\"name\" value=\"{}\" /><metadata key=\"extruder\" value=\"{}\" /><mesh_stat face_count=\"{}\" edges_fixed=\"0\" degenerate_facets=\"0\" facets_removed=\"0\" facets_reversed=\"0\" backwards_edges=\"0\" /></part>",
            i + 1,
            escape(&body.name),
            body.extruder,
            body.triangles.len()
        );
    }
    x.push_str(" </object>\n <plate>\n");
    for (key, value) in [
        ("plater_id", "1"),
        ("plater_name", ""),
        ("locked", "false"),
        ("filament_map_mode", "Auto For Flush"),
        ("filament_maps", "1 1 1"),
        ("filament_volume_maps", "0 0 0"),
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

/// The template with the sign's colors in filament slots 1..=3.
fn project_settings(spec: &ValidSignSpec, template: &Value) -> Result<Vec<u8>> {
    let mut settings = template.clone();
    let object = settings.as_object_mut().ok_or_else(|| {
        SignError::Package("project settings template is not a JSON object".into())
    })?;
    for key in [
        "filament_colour",
        "filament_multi_colour",
        "filament_settings_id",
    ] {
        let slots = object.get(key).and_then(Value::as_array).map(Vec::len);
        if slots != Some(FILAMENT_SLOTS) {
            return Err(SignError::Package(format!(
                "project settings template {key} must list {FILAMENT_SLOTS} filaments, found {slots:?}"
            )));
        }
    }
    let matrix = object
        .get("flush_volumes_matrix")
        .and_then(Value::as_array)
        .map(Vec::len);
    if matrix != Some(FILAMENT_SLOTS * FILAMENT_SLOTS) {
        return Err(SignError::Package(format!(
            "project settings template flush_volumes_matrix must be {FILAMENT_SLOTS}x{FILAMENT_SLOTS}, found {matrix:?} entries"
        )));
    }
    let colours: Vec<Value> = spec.slot_colours().into_iter().map(Value::from).collect();
    object.insert("filament_colour".into(), Value::Array(colours.clone()));
    object.insert("filament_multi_colour".into(), Value::Array(colours));
    let mut bytes = serde_json::to_vec_pretty(&settings)
        .map_err(|e| SignError::Package(format!("project settings: {e}")))?;
    bytes.push(b'\n');
    Ok(bytes)
}
