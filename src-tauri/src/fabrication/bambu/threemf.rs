//! Read what a Bambu project 3MF asks for: its selected system presets and where each
//! colour part touches the plate.

use std::collections::HashMap;
use std::fs::File;
use std::io::Read;
use std::path::Path;

use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use zip::ZipArchive;

use super::{io_err, parse_json_object, BambuError, Bbox, Result};

const PROJECT_SETTINGS: &str = "Metadata/project_settings.config";
const MODEL_SETTINGS: &str = "Metadata/model_settings.config";
const ROOT_MODEL: &str = "3D/3dmodel.model";
/// Vertices within this distance of z = 0 (after transforms) touch the plate.
const PLATE_EPSILON_MM: f64 = 1e-4;

/// System preset names a project was saved with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PresetSelection {
    pub machine: String,
    pub process: String,
    /// One per filament slot, in slot order; duplicates are expected.
    pub filaments: Vec<String>,
}

/// Plate-contact footprint of one part.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PartFootprint {
    pub part_name: String,
    /// 1-based filament slot, as stored in the 3MF. Layer-1 tool `T{extruder - 1}` prints it.
    pub extruder: u8,
    /// Bounds of the part's z = 0 vertices.
    pub bbox: Bbox,
    /// Mesh triangles whose three vertices sit at z = 0, as plate XY: the area the part
    /// covers on the bed.
    pub contact_triangles: Vec<[[f64; 2]; 3]>,
}

type Archive = ZipArchive<File>;

fn open(path: &Path) -> Result<Archive> {
    let file = File::open(path).map_err(io_err(path))?;
    ZipArchive::new(file).map_err(|source| BambuError::Zip {
        path: path.to_path_buf(),
        source,
    })
}

fn read_entry(archive: &mut Archive, path: &Path, name: &str) -> Result<Option<String>> {
    let mut entry = match archive.by_name(name) {
        Ok(entry) => entry,
        Err(zip::result::ZipError::FileNotFound) => return Ok(None),
        Err(source) => {
            return Err(BambuError::Zip {
                path: path.to_path_buf(),
                source,
            })
        }
    };
    let mut text = String::new();
    entry.read_to_string(&mut text).map_err(io_err(path))?;
    Ok(Some(text))
}

fn model_err(path: &Path, detail: impl Into<String>) -> BambuError {
    BambuError::Model {
        path: path.to_path_buf(),
        detail: detail.into(),
    }
}

/// Reads `printer_settings_id`, `print_settings_id`, and `filament_settings_id` from the
/// project's `Metadata/project_settings.config`.
pub fn read_preset_selection(threemf: &Path) -> Result<PresetSelection> {
    let mut archive = open(threemf)?;
    let text = read_entry(&mut archive, threemf, PROJECT_SETTINGS)?
        .ok_or_else(|| model_err(threemf, format!("{PROJECT_SETTINGS} is missing")))?;
    let settings = parse_json_object(&text, &threemf.join(PROJECT_SETTINGS))?;
    let missing = |key| BambuError::MissingSelection {
        path: threemf.to_path_buf(),
        key,
    };
    let string = |key: &'static str| match settings.get(key) {
        Some(Value::String(s)) if !s.is_empty() => Ok(s.clone()),
        _ => Err(missing(key)),
    };
    let filaments = match settings.get("filament_settings_id") {
        Some(Value::Array(items)) if !items.is_empty() => items
            .iter()
            .map(|item| match item {
                Value::String(s) if !s.is_empty() => Ok(s.clone()),
                _ => Err(missing("filament_settings_id")),
            })
            .collect::<Result<Vec<_>>>()?,
        _ => return Err(missing("filament_settings_id")),
    };
    Ok(PresetSelection {
        machine: string("printer_settings_id")?,
        process: string("print_settings_id")?,
        filaments,
    })
}

/// 3MF affine transform: row-vector convention, `p' = p * M + t`.
#[derive(Debug, Clone, Copy)]
struct Transform([f64; 12]);

impl Transform {
    const IDENTITY: Self = Self([1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]);

    fn parse(text: &str) -> Option<Self> {
        let values: Vec<f64> = text
            .split_whitespace()
            .map(str::parse)
            .collect::<Result<_, _>>()
            .ok()?;
        values.try_into().ok().map(Self)
    }

    fn apply(&self, [x, y, z]: [f64; 3]) -> [f64; 3] {
        let m = &self.0;
        [
            x * m[0] + y * m[3] + z * m[6] + m[9],
            x * m[1] + y * m[4] + z * m[7] + m[10],
            x * m[2] + y * m[5] + z * m[8] + m[11],
        ]
    }
}

struct ComponentRef {
    object_id: String,
    /// Production-extension `p:path` to another model part, when the mesh lives there.
    path: Option<String>,
    transform: Transform,
}

#[derive(Default)]
struct Mesh {
    vertices: Vec<[f64; 3]>,
    /// Vertex indices, as stored in the 3MF.
    triangles: Vec<[usize; 3]>,
}

enum ObjectBody {
    Mesh(Mesh),
    Components(Vec<ComponentRef>),
}

struct ModelObject {
    name: String,
    body: ObjectBody,
}

struct BuildItem {
    object_id: String,
    transform: Transform,
}

#[derive(Default)]
struct ModelFile {
    objects: HashMap<String, ModelObject>,
    build: Vec<BuildItem>,
}

fn attrs(element: &BytesStart<'_>, path: &Path) -> Result<HashMap<String, String>> {
    element
        .attributes()
        .map(|attr| {
            let attr = attr.map_err(|e| model_err(path, e.to_string()))?;
            // Local name drops the namespace prefix, so `p:path` reads as `path`.
            let key = String::from_utf8_lossy(attr.key.local_name().as_ref()).into_owned();
            let value = attr
                .unescape_value()
                .map_err(|e| model_err(path, e.to_string()))?;
            Ok((key, value.into_owned()))
        })
        .collect()
}

fn transform_attr(attrs: &HashMap<String, String>, path: &Path) -> Result<Transform> {
    attrs
        .get("transform")
        .map_or(Ok(Transform::IDENTITY), |text| {
            Transform::parse(text)
                .ok_or_else(|| model_err(path, format!("invalid transform {text:?}")))
        })
}

fn numeric<T: std::str::FromStr>(
    attrs: &HashMap<String, String>,
    element: &str,
    key: &str,
    path: &Path,
) -> Result<T> {
    attrs
        .get(key)
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| model_err(path, format!("{element} has no numeric {key}")))
}

fn parse_model(xml: &str, path: &Path) -> Result<ModelFile> {
    let mut reader = Reader::from_str(xml);
    let mut model = ModelFile::default();
    let mut current: Option<(String, ModelObject)> = None;
    loop {
        let event = reader
            .read_event()
            .map_err(|e| model_err(path, e.to_string()))?;
        let (element, closes_immediately) = match &event {
            Event::Start(e) => (e, false),
            Event::Empty(e) => (e, true),
            Event::End(e) if e.local_name().as_ref() == b"object" => {
                if let Some((id, object)) = current.take() {
                    model.objects.insert(id, object);
                }
                continue;
            }
            Event::Eof => break,
            _ => continue,
        };
        match element.local_name().as_ref() {
            b"object" => {
                let attrs = attrs(element, path)?;
                let id = attrs
                    .get("id")
                    .cloned()
                    .ok_or_else(|| model_err(path, "object without id"))?;
                let name = attrs.get("name").cloned().unwrap_or_default();
                let object = ModelObject {
                    name,
                    body: ObjectBody::Mesh(Mesh::default()),
                };
                if closes_immediately {
                    model.objects.insert(id, object);
                } else {
                    current = Some((id, object));
                }
            }
            b"vertex" => {
                if let Some((
                    _,
                    ModelObject {
                        body: ObjectBody::Mesh(mesh),
                        ..
                    },
                )) = &mut current
                {
                    let attrs = attrs(element, path)?;
                    mesh.vertices.push([
                        numeric(&attrs, "vertex", "x", path)?,
                        numeric(&attrs, "vertex", "y", path)?,
                        numeric(&attrs, "vertex", "z", path)?,
                    ]);
                }
            }
            b"triangle" => {
                if let Some((
                    _,
                    ModelObject {
                        body: ObjectBody::Mesh(mesh),
                        ..
                    },
                )) = &mut current
                {
                    let attrs = attrs(element, path)?;
                    mesh.triangles.push([
                        numeric(&attrs, "triangle", "v1", path)?,
                        numeric(&attrs, "triangle", "v2", path)?,
                        numeric(&attrs, "triangle", "v3", path)?,
                    ]);
                }
            }
            b"component" => {
                let attrs = attrs(element, path)?;
                let component = ComponentRef {
                    object_id: attrs
                        .get("objectid")
                        .cloned()
                        .ok_or_else(|| model_err(path, "component without objectid"))?,
                    path: attrs.get("path").cloned(),
                    transform: transform_attr(&attrs, path)?,
                };
                if let Some((_, object)) = &mut current {
                    match &mut object.body {
                        ObjectBody::Components(components) => components.push(component),
                        body => *body = ObjectBody::Components(vec![component]),
                    }
                }
            }
            b"item" => {
                let attrs = attrs(element, path)?;
                model.build.push(BuildItem {
                    object_id: attrs
                        .get("objectid")
                        .cloned()
                        .ok_or_else(|| model_err(path, "build item without objectid"))?,
                    transform: transform_attr(&attrs, path)?,
                });
            }
            _ => {}
        }
    }
    Ok(model)
}

#[derive(Default)]
struct PartSettings {
    name: Option<String>,
    extruder: Option<u8>,
}

#[derive(Default)]
struct ObjectSettings {
    own: PartSettings,
    parts: HashMap<String, PartSettings>,
}

/// Parses object and part names/extruders from `Metadata/model_settings.config`.
/// Extruder 0 means "inherit", so it is treated as unset.
fn parse_model_settings(xml: &str, path: &Path) -> Result<HashMap<String, ObjectSettings>> {
    let mut reader = Reader::from_str(xml);
    let mut objects: HashMap<String, ObjectSettings> = HashMap::new();
    let mut object: Option<String> = None;
    let mut part: Option<String> = None;
    loop {
        let event = reader
            .read_event()
            .map_err(|e| model_err(path, e.to_string()))?;
        match &event {
            Event::Start(e) | Event::Empty(e) => {
                let is_start = matches!(event, Event::Start(_));
                match e.local_name().as_ref() {
                    b"object" if is_start => {
                        object = attrs(e, path)?.remove("id");
                    }
                    b"part" if is_start => part = attrs(e, path)?.remove("id"),
                    b"metadata" => {
                        let Some(object_id) = &object else { continue };
                        let attrs = attrs(e, path)?;
                        let entry = objects.entry(object_id.clone()).or_default();
                        let target = match &part {
                            Some(part_id) => entry.parts.entry(part_id.clone()).or_default(),
                            None => &mut entry.own,
                        };
                        match (attrs.get("key").map(String::as_str), attrs.get("value")) {
                            (Some("name"), Some(value)) => target.name = Some(value.clone()),
                            (Some("extruder"), Some(value)) => {
                                let extruder: u8 = value.parse().map_err(|_| {
                                    model_err(path, format!("invalid extruder {value:?}"))
                                })?;
                                target.extruder = (extruder > 0).then_some(extruder);
                            }
                            _ => {}
                        }
                    }
                    _ => {}
                }
            }
            Event::End(e) => match e.local_name().as_ref() {
                b"object" => object = None,
                b"part" => part = None,
                _ => {}
            },
            Event::Eof => break,
            _ => {}
        }
    }
    Ok(objects)
}

/// Plate-contact footprint of every part on the build plate: the bbox of the part's z = 0
/// vertices and its all-z = 0 triangles, after its component and build-item transforms, with
/// its filament slot from `model_settings.config` (part, else object, else slot 1). Parts
/// that do not touch the plate are omitted.
pub fn part_footprints(threemf: &Path) -> Result<Vec<PartFootprint>> {
    let mut archive = open(threemf)?;
    let root_xml = read_entry(&mut archive, threemf, ROOT_MODEL)?
        .ok_or_else(|| model_err(threemf, format!("{ROOT_MODEL} is missing")))?;
    let root = parse_model(&root_xml, threemf)?;
    let settings = match read_entry(&mut archive, threemf, MODEL_SETTINGS)? {
        Some(xml) => parse_model_settings(&xml, threemf)?,
        None => HashMap::new(),
    };
    let mut external: HashMap<String, ModelFile> = HashMap::new();
    let mut footprints = Vec::new();

    for item in &root.build {
        let object = root.objects.get(&item.object_id).ok_or_else(|| {
            model_err(
                threemf,
                format!("build item references missing object {}", item.object_id),
            )
        })?;
        let object_settings = settings.get(&item.object_id);
        let object_extruder = object_settings.and_then(|s| s.own.extruder).unwrap_or(1);

        match &object.body {
            ObjectBody::Mesh(mesh) => {
                let name = object_settings
                    .and_then(|s| s.own.name.clone())
                    .unwrap_or_else(|| object.name.clone());
                push_footprint(
                    &mut footprints,
                    threemf,
                    name,
                    object_extruder,
                    mesh,
                    &[item.transform],
                )?;
            }
            ObjectBody::Components(components) => {
                for component in components {
                    let model = match &component.path {
                        Some(part_path) => {
                            let entry = part_path.trim_start_matches('/');
                            if !external.contains_key(entry) {
                                let xml =
                                    read_entry(&mut archive, threemf, entry)?.ok_or_else(|| {
                                        model_err(
                                            threemf,
                                            format!("component model {entry} is missing"),
                                        )
                                    })?;
                                external.insert(entry.to_owned(), parse_model(&xml, threemf)?);
                            }
                            &external[entry]
                        }
                        None => &root,
                    };
                    let part = model.objects.get(&component.object_id).ok_or_else(|| {
                        model_err(
                            threemf,
                            format!(
                                "component references missing object {}",
                                component.object_id
                            ),
                        )
                    })?;
                    let ObjectBody::Mesh(mesh) = &part.body else {
                        return Err(model_err(
                            threemf,
                            format!("nested components in object {}", component.object_id),
                        ));
                    };
                    let part_settings =
                        object_settings.and_then(|s| s.parts.get(&component.object_id));
                    let name = part_settings
                        .and_then(|p| p.name.clone())
                        .unwrap_or_else(|| part.name.clone());
                    let extruder = part_settings
                        .and_then(|p| p.extruder)
                        .unwrap_or(object_extruder);
                    push_footprint(
                        &mut footprints,
                        threemf,
                        name,
                        extruder,
                        mesh,
                        &[component.transform, item.transform],
                    )?;
                }
            }
        }
    }
    Ok(footprints)
}

fn push_footprint(
    out: &mut Vec<PartFootprint>,
    threemf: &Path,
    part_name: String,
    extruder: u8,
    mesh: &Mesh,
    transforms: &[Transform],
) -> Result<()> {
    let placed: Vec<[f64; 3]> = mesh
        .vertices
        .iter()
        .map(|vertex| transforms.iter().fold(*vertex, |v, t| t.apply(v)))
        .collect();
    let on_plate = |[_, _, z]: [f64; 3]| z.abs() < PLATE_EPSILON_MM;
    let mut bbox: Option<Bbox> = None;
    for &[x, y, z] in &placed {
        if on_plate([x, y, z]) {
            bbox.get_or_insert_with(|| Bbox::point(x, y)).include(x, y);
        }
    }
    let mut contact_triangles = Vec::new();
    for triangle in &mesh.triangles {
        let corners = triangle.map(|index| placed.get(index).copied());
        let [Some(a), Some(b), Some(c)] = corners else {
            return Err(model_err(
                threemf,
                format!("part {part_name:?} has a triangle {triangle:?} past its vertex list"),
            ));
        };
        if [a, b, c].into_iter().all(on_plate) {
            contact_triangles.push([a, b, c].map(|[x, y, _]| [x, y]));
        }
    }
    if let Some(bbox) = bbox {
        out.push(PartFootprint {
            part_name,
            extruder,
            bbox,
            contact_triangles,
        });
    }
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Write;

    /// Writes a zip with the given entries; the test's stand-in for a project 3MF.
    pub(crate) fn write_3mf(path: &Path, entries: &[(&str, &str)]) {
        let mut zip = zip::ZipWriter::new(File::create(path).expect("create 3mf"));
        for (name, body) in entries {
            zip.start_file(*name, zip::write::SimpleFileOptions::default())
                .expect("entry");
            zip.write_all(body.as_bytes()).expect("write entry");
        }
        zip.finish().expect("finish zip");
    }

    fn square(id: u32, name: &str, x0: f64, y0: f64, size: f64, z0: f64) -> String {
        let (x1, y1, z1) = (x0 + size, y0 + size, z0 + 1.0);
        format!(
            r#"<object id="{id}" type="model" name="{name}"><mesh><vertices>
            <vertex x="{x0}" y="{y0}" z="{z0}" /><vertex x="{x1}" y="{y0}" z="{z0}" />
            <vertex x="{x1}" y="{y1}" z="{z0}" /><vertex x="{x0}" y="{y1}" z="{z0}" />
            <vertex x="{x0}" y="{y0}" z="{z1}" /><vertex x="-500" y="-500" z="{z1}" />
            </vertices><triangles>
            <triangle v1="0" v2="2" v3="1" /><triangle v1="0" v2="3" v3="2" />
            <triangle v1="0" v2="1" v3="4" />
            </triangles></mesh></object>"#
        )
    }

    pub(crate) fn sign_model() -> String {
        format!(
            r#"<?xml version="1.0" encoding="UTF-8"?>
<model xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" unit="millimeter"><resources>
{}{}{}
<object id="4" type="model" name="Sign"><components>
<component objectid="1" /><component objectid="2" transform="1 0 0 0 1 0 0 0 1 5 0 0" /><component objectid="3" />
</components></object></resources>
<build><item objectid="4" transform="1 0 0 0 1 0 0 0 1 53 23 0" printable="1" /></build></model>"#,
            square(1, "white", 0.0, 0.0, 150.0, 0.0),
            square(2, "navy", 20.0, 10.0, 30.0, 0.0),
            square(3, "raised", 0.0, 0.0, 10.0, 0.6),
        )
    }

    pub(crate) const SIGN_SETTINGS: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<config><object id="4"><metadata key="name" value="Sign" /><metadata key="extruder" value="1" />
<part id="1" subtype="normal_part"><metadata key="name" value="white" /><metadata key="extruder" value="1" /></part>
<part id="2" subtype="normal_part"><metadata key="name" value="navy part" /><metadata key="extruder" value="2" /></part>
<part id="3" subtype="normal_part"><metadata key="name" value="raised" /><metadata key="extruder" value="3" /></part>
</object><plate><metadata key="plater_id" value="1" /></plate></config>"#;

    pub(crate) const SIGN_PROJECT: &str = r#"{
        "printer_settings_id": "Bambu Lab P2S 0.4 nozzle",
        "print_settings_id": "0.20mm Standard @BBL P2S",
        "filament_settings_id": ["Bambu PLA Basic @BBL P2S", "Bambu PLA Basic @BBL P2S"]
    }"#;

    #[test]
    fn footprints_apply_transforms_and_keep_only_plate_contact_parts() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sign.3mf");
        let model = sign_model();
        write_3mf(
            &path,
            &[(ROOT_MODEL, &model), (MODEL_SETTINGS, SIGN_SETTINGS)],
        );

        let parts = part_footprints(&path).expect("footprints");
        let expected = vec![
            PartFootprint {
                part_name: "white".into(),
                extruder: 1,
                bbox: Bbox {
                    min_x: 53.0,
                    max_x: 203.0,
                    min_y: 23.0,
                    max_y: 173.0,
                },
                contact_triangles: vec![
                    [[53.0, 23.0], [203.0, 173.0], [203.0, 23.0]],
                    [[53.0, 23.0], [53.0, 173.0], [203.0, 173.0]],
                ],
            },
            PartFootprint {
                part_name: "navy part".into(),
                extruder: 2,
                bbox: Bbox {
                    min_x: 78.0,
                    max_x: 108.0,
                    min_y: 33.0,
                    max_y: 63.0,
                },
                contact_triangles: vec![
                    [[78.0, 33.0], [108.0, 63.0], [108.0, 33.0]],
                    [[78.0, 33.0], [78.0, 63.0], [108.0, 63.0]],
                ],
            },
        ];
        assert_eq!(
            parts, expected,
            "the raised part never touches the plate, and side triangles are not contact"
        );
    }

    #[test]
    fn reads_the_project_preset_selection() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sign.3mf");
        write_3mf(&path, &[(PROJECT_SETTINGS, SIGN_PROJECT)]);
        let selection = read_preset_selection(&path).expect("selection");
        assert_eq!(selection.machine, "Bambu Lab P2S 0.4 nozzle");
        assert_eq!(selection.process, "0.20mm Standard @BBL P2S");
        assert_eq!(selection.filaments, vec!["Bambu PLA Basic @BBL P2S"; 2]);
    }

    #[test]
    fn rejects_a_project_without_a_filament_selection() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("sign.3mf");
        write_3mf(
            &path,
            &[(
                PROJECT_SETTINGS,
                r#"{"printer_settings_id": "P", "print_settings_id": "Q", "filament_settings_id": []}"#,
            )],
        );
        let err = read_preset_selection(&path).expect_err("empty filaments");
        assert!(
            matches!(
                err,
                BambuError::MissingSelection {
                    key: "filament_settings_id",
                    ..
                }
            ),
            "{err}"
        );
    }
}
