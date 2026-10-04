use std::io::{Cursor, Write};

use serde_json::json;

use super::mesh::{read, read_3mf_expanding_to, MAX_ATTRIBUTES, MAX_ATTRIBUTE_BYTES};
use super::*;
use crate::fabrication::kind::{find, Kind, KindDriver};
use crate::fabrication::printer::P2S_04;

/// Corners and triangles, mm.
pub(crate) type Piece = (Vec<[f64; 3]>, Vec<[u32; 3]>);

/// A closed, outward box from `lo` to `hi`, mm.
fn cuboid(lo: [f64; 3], hi: [f64; 3]) -> Piece {
    let v = (0..8)
        .map(|i| [if i & 1 == 0 { lo[0] } else { hi[0] }, if i & 2 == 0 { lo[1] } else { hi[1] }, if i & 4 == 0 { lo[2] } else { hi[2] }])
        .collect();
    let t = vec![[0, 2, 1], [1, 2, 3], [4, 5, 6], [5, 7, 6], [0, 1, 4], [1, 5, 4], [2, 6, 3], [3, 6, 7], [0, 4, 2], [2, 4, 6], [1, 3, 5], [3, 7, 5]];
    (v, t)
}

/// The pipeline's slab on a post as one closed shell, which overhangs: a
/// 40 mm slab 3 mm thick on a 10 mm post 10 mm tall, with its foot `lift` mm
/// above z = 0. The slab's underside is a ring around the post's top.
pub(crate) fn slab_on_a_post(lift: f64) -> Piece {
    let square = |lo: f64, hi: f64, z: f64| [[lo, lo, z], [hi, lo, z], [hi, hi, z], [lo, hi, z]];
    let v: Vec<[f64; 3]> = [square(15.0, 25.0, lift), square(15.0, 25.0, lift + 10.0), square(0.0, 40.0, lift + 10.0), square(0.0, 40.0, lift + 13.0)]
        .concat();
    // 0-3 the post's foot, 4-7 its top, 8-11 the slab's underside edge, 12-15 the slab's top.
    let t = vec![
        [0, 2, 1], [0, 3, 2], // foot
        [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7], // post sides
        [8, 4, 5], [8, 5, 9], [9, 5, 6], [9, 6, 10], [10, 6, 7], [10, 7, 11], [11, 7, 4], [11, 4, 8], // underside ring
        [12, 13, 14], [12, 14, 15], // top
        [8, 9, 13], [8, 13, 12], [9, 10, 14], [9, 14, 13], [10, 11, 15], [10, 15, 14], [11, 8, 12], [11, 12, 15], // slab sides
    ];
    (v, t)
}

/// `<object>` `id` holding `piece` as its mesh.
fn mesh_object(id: u32, (v, t): &Piece) -> String {
    let vertices: String = v.iter().map(|[x, y, z]| format!("<vertex x=\"{x}\" y=\"{y}\" z=\"{z}\"/>")).collect();
    let triangles: String = t.iter().map(|[a, b, c]| format!("<triangle v1=\"{a}\" v2=\"{b}\" v3=\"{c}\"/>")).collect();
    format!("<object id=\"{id}\" type=\"model\"><mesh><vertices>{vertices}</vertices><triangles>{triangles}</triangles></mesh></object>")
}

/// A 3MF model part: `unit` (none when empty), `resources`, then `build`.
fn model(unit: &str, resources: &str, build: &str) -> String {
    let unit = if unit.is_empty() { String::new() } else { format!(" unit=\"{unit}\"") };
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<model xmlns=\"http://schemas.microsoft.com/3dmanufacturing/core/2015/02\"{unit}>\
         <resources>{resources}</resources><build>{build}</build></model>"
    )
}

/// A zip of `entries`, deflated, as a 3MF writer makes one.
pub(crate) fn zip_of(entries: &[(&str, &[u8])]) -> Vec<u8> {
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    for (name, body) in entries {
        zip.start_file(*name, zip::write::SimpleFileOptions::default()).expect("entry");
        zip.write_all(body).expect("write");
    }
    zip.finish().expect("finish").into_inner()
}

/// A 3MF holding `model` as its model part, with the parts a 3MF writer adds.
fn three_mf(model: &str) -> Vec<u8> {
    zip_of(&[
        ("[Content_Types].xml", b"<Types/>".as_slice()),
        ("_rels/.rels", b"<Relationships/>".as_slice()),
        ("3D/3dmodel.model", model.as_bytes()),
    ])
}

/// A 3MF of `piece` as one object in millimeters, as Fusion exports one body.
pub(crate) fn one_body_3mf(piece: &Piece) -> Vec<u8> {
    three_mf(&model("millimeter", &mesh_object(1, piece), "<item objectid=\"1\"/>"))
}

pub(crate) fn binary_stl((v, t): &Piece) -> Vec<u8> {
    let mut out = vec![b' '; 80];
    out.extend((t.len() as u32).to_le_bytes());
    for tri in t {
        out.extend([0u8; 12]);
        for &i in tri {
            for c in v[i as usize] {
                out.extend((c as f32).to_le_bytes());
            }
        }
        out.extend([0u8; 2]);
    }
    out
}

fn ascii_stl((v, t): &Piece) -> Vec<u8> {
    let mut out = String::from("solid slab\n");
    for tri in t {
        out.push_str("  facet normal 0 0 0\n    outer loop\n");
        for &i in tri {
            let [x, y, z] = v[i as usize];
            out.push_str(&format!("      vertex {x} {y} {z}\n"));
        }
        out.push_str("    endloop\n  endfacet\n");
    }
    out.push_str("endsolid slab\n");
    out.into_bytes()
}

fn bounds(mesh: &crate::fabrication::model::Mesh) -> [[Um; 3]; 2] {
    let mut lo = [Um::MAX; 3];
    let mut hi = [Um::MIN; 3];
    for v in mesh.vertices() {
        for k in 0..3 {
            lo[k] = lo[k].min(v[k]);
            hi[k] = hi[k].max(v[k]);
        }
    }
    [lo, hi]
}

/// A 3MF, a binary STL, and an ASCII STL of one body read into the same
/// welded mesh, set on the bed with x and y kept.
#[test]
fn every_format_reads_one_body_welded_and_set_on_the_bed() {
    let piece = slab_on_a_post(5.0);
    let from_3mf = read(&one_body_3mf(&piece), Units::Mm).expect("3mf");
    assert_eq!((from_3mf.vertices().len(), from_3mf.triangles().len()), (16, 28));
    assert_eq!(bounds(&from_3mf), [[0, 0, 0], [40_000, 40_000, 13_000]], "lifted 5 mm, then set on the bed");
    assert_eq!(read(&binary_stl(&piece), Units::Mm).expect("binary stl"), from_3mf);
    assert_eq!(read(&ascii_stl(&piece), Units::Mm).expect("ascii stl"), from_3mf);
}

/// A 3MF states its unit and `units` must name it; with none it is in
/// millimeters. An STL takes `units` as its unit.
#[test]
fn units_scale_to_the_um_grid_and_a_3mf_must_state_the_same_unit() {
    let piece = slab_on_a_post(0.0);
    let inch = three_mf(&model("inch", &mesh_object(1, &piece), "<item objectid=\"1\"/>"));
    assert_eq!(bounds(&read(&inch, Units::In).expect("inch")), [[0, 0, 0], [1_016_000, 1_016_000, 330_200]]);
    assert_eq!(
        read(&inch, Units::Mm),
        Err(MeshImportError::UnitMismatch { found: "inch".into(), given: "mm" }),
        "a 3MF in inches read as millimeters is refused"
    );
    let unstated = three_mf(&model("", &mesh_object(1, &piece), "<item objectid=\"1\"/>"));
    assert_eq!(bounds(&read(&unstated, Units::Mm).expect("default mm"))[1], [40_000, 40_000, 13_000]);
    assert!(matches!(read(&unstated, Units::In), Err(MeshImportError::UnitMismatch { .. })));
    assert_eq!(bounds(&read(&binary_stl(&piece), Units::In).expect("stl in inches"))[1], [1_016_000, 1_016_000, 330_200]);
}

/// More than one object is refused, never merged: two build items, or one
/// item of an object with two components. One component is read through
/// both transforms.
#[test]
fn a_file_with_more_than_one_object_is_refused_and_one_component_is_placed() {
    let piece = slab_on_a_post(0.0);
    let two_items = three_mf(&model(
        "millimeter",
        &format!("{}{}", mesh_object(1, &piece), mesh_object(2, &piece)),
        "<item objectid=\"1\"/><item objectid=\"2\" transform=\"1 0 0 0 1 0 0 0 1 60 0 0\"/>",
    ));
    assert_eq!(read(&two_items, Units::Mm), Err(MeshImportError::MultipleObjects(2)));
    let two_components = three_mf(&model(
        "millimeter",
        &format!(
            "{}{}<object id=\"3\" type=\"model\"><components><component objectid=\"1\"/><component objectid=\"2\"/></components></object>",
            mesh_object(1, &piece),
            mesh_object(2, &piece)
        ),
        "<item objectid=\"3\"/>",
    ));
    assert_eq!(read(&two_components, Units::Mm), Err(MeshImportError::MultipleObjects(2)));
    let wrapped = three_mf(&model(
        "millimeter",
        &format!(
            "{}<object id=\"2\" type=\"model\"><components><component objectid=\"1\" transform=\"0 1 0 -1 0 0 0 0 1 0 0 0\"/></components></object>",
            mesh_object(1, &piece)
        ),
        "<item objectid=\"2\" transform=\"1 0 0 0 1 0 0 0 1 100 0 0\"/>",
    ));
    // A quarter turn about z, then 100 mm along x.
    assert_eq!(bounds(&read(&wrapped, Units::Mm).expect("one component")), [[60_000, 0, 0], [100_000, 40_000, 13_000]]);
    let elsewhere = three_mf(&model(
        "millimeter",
        "<object id=\"2\" type=\"model\"><components><component objectid=\"1\" p:path=\"/3D/other.model\" xmlns:p=\"http://schemas.microsoft.com/3dmanufacturing/production/2015/06\"/></components></object>",
        "<item objectid=\"2\"/>",
    ));
    assert_eq!(read(&elsewhere, Units::Mm), Err(MeshImportError::ExternalMesh));
}

/// Files that are not meshes are refused as such, and the error repeats none
/// of their text.
#[test]
fn a_file_that_is_not_a_mesh_is_refused_without_repeating_it() {
    let png = b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR secret-token-1234".to_vec();
    let docx = zip_of(&[("word/document.xml", b"<w:document>secret-token-1234</w:document>".as_slice())]);
    let text = b"secret-token-1234 is not a mesh".to_vec();
    let not_stl = b"solid secret-token-1234\nfacet normal 0 0 1\n outer loop\n vertex 0 0 secret-token-1234\n".to_vec();
    let broken_xml = three_mf("<model unit=\"millimeter\"><resources secret-token-1234=\"1\"></object></model>");
    for (why, bytes, expected) in [
        ("a PNG", png, MeshImportError::NotAMesh),
        ("a zip that is not a 3MF", docx, MeshImportError::NoModel),
        ("text", text, MeshImportError::NotAMesh),
        ("an ASCII STL that is not one", not_stl, MeshImportError::NotAMesh),
        ("a 3MF whose model is not XML", broken_xml, MeshImportError::BadXml(0)),
    ] {
        let refused = read(&bytes, Units::Mm).expect_err(why);
        let same = match (&refused, &expected) {
            (MeshImportError::BadXml(_), MeshImportError::BadXml(_)) => true,
            (refused, expected) => refused == expected,
        };
        assert!(same, "{why}: {refused:?}");
        assert!(!refused.to_string().contains("secret-token"), "{why}: {refused}");
    }
    assert_eq!(read(&three_mf(&model("millimeter", "", "")), Units::Mm), Err(MeshImportError::MultipleObjects(0)));
}

/// A zip with more entries than the cap, or entries that declare more bytes
/// than the cap, is refused before anything is expanded. A model entry whose
/// header understates it stops at the cap when read.
#[test]
fn a_zip_bomb_is_refused_by_entry_count_and_by_expanded_size() {
    let piece = slab_on_a_post(0.0);
    let body = model("millimeter", &mesh_object(1, &piece), "<item objectid=\"1\"/>");
    let names: Vec<String> = (0..MAX_ZIP_ENTRIES).map(|i| format!("Metadata/thumb-{i}.png")).collect();
    let mut entries: Vec<(&str, &[u8])> = names.iter().map(|name| (name.as_str(), b"x".as_slice())).collect();
    entries.push(("3D/3dmodel.model", body.as_bytes()));
    assert_eq!(read(&zip_of(&entries), Units::Mm), Err(MeshImportError::TooManyEntries), "{} entries", entries.len());
    entries.drain(..2);
    assert!(read(&zip_of(&entries), Units::Mm).is_ok(), "{} entries is within the cap", entries.len());

    // One entry declares more than the cap; its header is all that is read.
    let mut declared = zip_of(&[("3D/3dmodel.model", body.as_bytes()), ("Metadata/big.bin", b"tiny".as_slice())]);
    let directory = declared.windows(4).rposition(|w| w == b"PK\x01\x02").expect("last directory entry");
    let over = u32::try_from(MAX_EXPANDED_BYTES + 1).expect("fits");
    declared[directory + 24..directory + 28].copy_from_slice(&over.to_le_bytes());
    assert_eq!(read(&declared, Units::Mm), Err(MeshImportError::Expanded));

    // A model whose header understates it stops at the cap when read.
    let padded = format!("{body}{}", " ".repeat(64 << 10));
    let mut bomb = zip_of(&[("3D/3dmodel.model", padded.as_bytes())]);
    assert!(bomb.len() < 8 << 10, "deflated to {} bytes", bomb.len());
    let directory = bomb.windows(4).rposition(|w| w == b"PK\x01\x02").expect("directory entry");
    bomb[directory + 24..directory + 28].copy_from_slice(&100u32.to_le_bytes());
    bomb[22..26].copy_from_slice(&100u32.to_le_bytes());
    assert_eq!(read_3mf_expanding_to(&bomb, Units::Mm, 32 << 10), Err(MeshImportError::Expanded), "it declares 100 bytes");
}

/// An entry name that could leave its folder refuses the whole file, though
/// nothing is ever written from it.
#[test]
fn a_zip_entry_name_with_traversal_is_refused() {
    let body = model("millimeter", &mesh_object(1, &slab_on_a_post(0.0)), "<item objectid=\"1\"/>");
    for name in ["../escape.txt", "Metadata/../../escape.txt", "/etc/escape", "C:\\escape.txt", "Metadata\\..\\escape", "a:stream"] {
        let bytes = zip_of(&[("3D/3dmodel.model", body.as_bytes()), (name, b"x".as_slice())]);
        assert_eq!(read(&bytes, Units::Mm), Err(MeshImportError::UnsafeEntryName), "{name}");
    }
}

#[test]
fn a_zip64_end_record_is_refused() {
    let mut bytes = one_body_3mf(&slab_on_a_post(0.0));
    let end = bytes.windows(4).rposition(|w| w == b"PK\x05\x06").expect("end record");
    let mut locator = b"PK\x06\x07".to_vec();
    locator.extend([0u8; 16]);
    bytes.splice(end..end, locator);
    assert_eq!(read(&bytes, Units::Mm), Err(MeshImportError::Zip64));
}

#[test]
fn a_mesh_over_a_count_or_coordinate_cap_or_with_a_bad_index_is_refused() {
    let mut huge = vec![0u8; 84 + 50 * (MAX_TRIANGLES + 1)];
    huge[80..84].copy_from_slice(&u32::try_from(MAX_TRIANGLES + 1).expect("fits").to_le_bytes());
    assert_eq!(read(&huge, Units::Mm), Err(MeshImportError::TooManyTriangles));

    let (mut v, t) = slab_on_a_post(0.0);
    v[0] = [MAX_ABS_MM + 1.0, 0.0, 0.0];
    assert_eq!(read(&binary_stl(&(v, t.clone())), Units::Mm), Err(MeshImportError::BadCoordinate));
    let (v, _) = slab_on_a_post(0.0);
    assert_eq!(read(&binary_stl(&(v.clone(), t)), Units::In).map(drop), Ok(()), "40 mm read as inches still fits");
    let bad_index = three_mf(&model("millimeter", &mesh_object(1, &(v, vec![[0, 1, 99]])), "<item objectid=\"1\"/>"));
    assert_eq!(read(&bad_index, Units::Mm), Err(MeshImportError::BadIndex));
}

fn spec(title: &str, sha: &str, units: &str) -> serde_json::Value {
    json!({ "schema_version": 1, "title": title, "input_sha256": sha, "units": units })
}

/// The kind is registered for `find` but offered by no tool, and its spec is
/// validated like any other.
#[test]
fn the_kind_is_found_but_never_offered_to_build_and_its_spec_is_validated() {
    let driver = find("imported_part").expect("registered");
    assert_eq!(driver.naming(), ObjectNaming::BuildKey);
    assert!(crate::fabrication::kind::KINDS.iter().all(|kind| kind.id().as_str() != "imported_part"));
    let sha = Sha256Hex::of_bytes(b"mesh");
    let parsed = Kind::<ImportedPart>::NEW.parse(spec(" Shelf bracket ", sha.as_str(), "mm"), &P2S_04).expect("valid");
    assert_eq!(parsed.title(), "Shelf bracket");
    assert_eq!(parsed.plan().id(), IMPORTED_PART_CHECK_PLAN);
    let ids: Vec<&str> = parsed.plan().required().iter().map(|id| id.as_str()).take(7).collect();
    assert_eq!(
        ids,
        [
            "geometry.closed_manifold.body",
            "geometry.non_degenerate.body",
            "geometry.outward_orientation.body",
            "geometry.bounds.body",
            "print.overhang.body",
            "print.min_wall.body",
            "print.first_layer.body",
        ]
    );
    for (why, bad) in [
        ("an empty title", spec(" ", sha.as_str(), "mm")),
        ("a hash that is not one", spec("t", "../../etc/passwd", "mm")),
        ("a unit it does not read", spec("t", sha.as_str(), "cm")),
        ("an unknown field", json!({ "schema_version": 1, "title": "t", "input_sha256": sha.as_str(), "units": "mm", "path": "/x" })),
    ] {
        assert!(Kind::<ImportedPart>::NEW.parse(bad, &P2S_04).is_err(), "{why}");
    }
}

/// Every attribute is bounded, whether the reader uses it or not: its length,
/// how many one element has, and no name twice. A DTD, which could declare
/// entities, is refused.
#[test]
fn xml_attributes_are_bounded_and_a_dtd_is_refused() {
    let piece = slab_on_a_post(0.0);
    let with_vertex_attrs = |extra: &str| {
        let object = mesh_object(1, &piece).replacen("<vertex ", &format!("<vertex {extra} "), 1);
        three_mf(&model("millimeter", &object, "<item objectid=\"1\"/>"))
    };
    assert!(read(&with_vertex_attrs("color=\"red\""), Units::Mm).is_ok(), "a short unknown attribute is fine");
    let long = format!("note=\"{}\"", "a".repeat(MAX_ATTRIBUTE_BYTES + 1));
    let many: String = (0..=MAX_ATTRIBUTES).map(|i| format!("a{i}=\"1\" ")).collect();
    let twice = "note=\"1\" note=\"2\"".to_owned();
    for (why, attrs) in [("an unknown attribute over the cap", long), ("too many attributes", many), ("one name twice", twice)] {
        let refused = read(&with_vertex_attrs(&attrs), Units::Mm);
        assert!(matches!(refused, Err(MeshImportError::Malformed(_))), "{why}: {refused:?}");
    }
    let dtd = model("millimeter", &mesh_object(1, &piece), "<item objectid=\"1\"/>").replacen(
        "<model",
        "<!DOCTYPE model [<!ENTITY lol \"lollollol\"><!ENTITY lol2 \"&lol;&lol;&lol;\">]>\n<model",
        1,
    );
    let refused = read(&three_mf(&dtd), Units::Mm);
    assert!(matches!(refused, Err(MeshImportError::Malformed(_))), "a DTD with entities: {refused:?}");
}

/// A zip64 extra field on an entry is refused like a zip64 end record.
#[test]
fn a_zip64_entry_is_refused() {
    let body = model("millimeter", &mesh_object(1, &slab_on_a_post(0.0)), "<item objectid=\"1\"/>");
    let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
    zip.start_file("3D/3dmodel.model", zip::write::SimpleFileOptions::default().large_file(true)).expect("entry");
    zip.write_all(body.as_bytes()).expect("write");
    let bytes = zip.finish().expect("finish").into_inner();
    assert_eq!(read(&bytes, Units::Mm).map(drop), Err(MeshImportError::Zip64));
}

/// A unit the 3MF specification does not name is called "an unknown unit";
/// the file's own text is never repeated.
#[test]
fn a_unit_mismatch_never_repeats_the_files_unit_text() {
    let object = mesh_object(1, &slab_on_a_post(0.0));
    let crafted = read(&three_mf(&model("secrettokenunit", &object, "<item objectid=\"1\"/>")), Units::Mm).map(drop).expect_err("refused");
    assert!(!crafted.to_string().contains("secrettoken"), "{crafted}");
    assert!(crafted.to_string().contains("an unknown unit"), "{crafted}");
    let known = read(&three_mf(&model("centimeter", &object, "<item objectid=\"1\"/>")), Units::Mm).map(drop).expect_err("refused");
    assert_eq!(known.to_string(), "the 3MF says its unit is centimeter, but units is mm; give the unit the file uses");
}

/// A closed, outward cube shell of side `size` mm at `at`, or an inward one.
fn shell(at: [f64; 3], size: f64, inward: bool) -> Piece {
    let (v, t) = cuboid(at, [at[0] + size, at[1] + size, at[2] + size]);
    (v, if inward { t.iter().map(|[a, b, c]| [*a, *c, *b]).collect() } else { t })
}

/// `pieces` as one mesh, as one STL body or one 3MF object holds them.
fn joined(pieces: &[Piece]) -> Piece {
    let (mut v, mut t) = (Vec::new(), Vec::new());
    for (pv, pt) in pieces {
        let base = v.len() as u32;
        v.extend_from_slice(pv);
        t.extend(pt.iter().map(|tri| tri.map(|i| i + base)));
    }
    (v, t)
}

/// An imported part is exactly one shell after welding, whatever the
/// orientation or placement of any other: a second solid, a sealed internal
/// cavity (a stated limit), shells that cross, and an inverted shell outside
/// the body are all refused, in every format. One shell is read.
#[test]
fn a_mesh_of_more_than_one_shell_is_refused() {
    let cube = shell([0.0, 0.0, 0.0], 30.0, false);
    let mut ascii = String::from_utf8(ascii_stl(&cube)).expect("text");
    ascii.push_str(&String::from_utf8(ascii_stl(&shell([40.0, 0.0, 0.0], 10.0, false))).expect("text"));
    assert_eq!(read(ascii.as_bytes(), Units::Mm).map(drop), Err(MeshImportError::MultipleObjects(2)));
    for (why, pieces) in [
        ("two disjoint solids", vec![cube.clone(), shell([40.0, 0.0, 0.0], 10.0, false)]),
        ("a sealed internal cavity", vec![cube.clone(), shell([10.0, 10.0, 10.0], 10.0, true)]),
        ("crossing shells", vec![cube.clone(), shell([20.0, 20.0, 20.0], 30.0, false)]),
        ("an inverted shell outside the body", vec![cube.clone(), shell([40.0, 0.0, 0.0], 10.0, true)]),
        ("three shells", vec![cube.clone(), shell([40.0, 0.0, 0.0], 10.0, false), shell([60.0, 0.0, 0.0], 10.0, true)]),
    ] {
        let mesh = joined(&pieces);
        for (format, bytes) in [("binary STL", binary_stl(&mesh)), ("3MF", one_body_3mf(&mesh))] {
            assert_eq!(read(&bytes, Units::Mm).map(drop), Err(MeshImportError::SeparateShells(pieces.len())), "{why}, {format}");
        }
    }
    for (format, bytes) in [("binary STL", binary_stl(&cube)), ("3MF", one_body_3mf(&slab_on_a_post(0.0)))] {
        assert!(read(&bytes, Units::Mm).is_ok(), "one shell, {format}");
    }
}

/// The outer surface of unit cells (`size` mm cubes at integer cell
/// coordinates): every cell face with no cell beyond it, facing out.
fn voxels(cells: &[[i32; 3]], size: f64) -> Piece {
    let (v, t) = cuboid([0.0; 3], [size; 3]);
    let filled = |c: [i32; 3]| cells.contains(&c);
    // cuboid's faces, two triangles each: -z, +z, -y, +y, -x, +x.
    let toward: [[i32; 3]; 6] = [[0, 0, -1], [0, 0, 1], [0, -1, 0], [0, 1, 0], [-1, 0, 0], [1, 0, 0]];
    let mut pieces = Vec::new();
    for &cell in cells {
        let offset = cell.map(|c| f64::from(c) * size);
        let moved: Vec<[f64; 3]> = v.iter().map(|p| [p[0] + offset[0], p[1] + offset[1], p[2] + offset[2]]).collect();
        let open: Vec<[u32; 3]> = t
            .chunks(2)
            .zip(toward)
            .filter(|(_, d)| !filled([cell[0] + d[0], cell[1] + d[1], cell[2] + d[2]]))
            .flat_map(|(face, _)| face.iter().copied())
            .collect();
        pieces.push((moved, open));
    }
    joined(&pieces)
}

/// Two bodies that touch at one point are two shells, joined only through a
/// shared edge: touching at a welded vertex, or across a 0.4 µm gap the weld
/// closes, in every format. One shell pinched at a vertex, where its surface
/// only touches itself, is refused too.
#[test]
fn shells_join_through_edges_and_a_pinched_vertex_is_refused() {
    let a = shell([0.0, 0.0, 0.0], 10.0, false);
    let touching = joined(&[a.clone(), shell([10.0, 10.0, 10.0], 10.0, false)]);
    let welded_gap = joined(&[a.clone(), shell([10.0004, 10.0004, 10.0004], 10.0, false)]);
    let mut one_solid = String::from_utf8(ascii_stl(&touching)).expect("text");
    for (why, bytes) in [
        ("binary STL", binary_stl(&touching)),
        ("ASCII STL", one_solid.into_bytes()),
        ("3MF", one_body_3mf(&touching)),
        ("a 0.4 µm gap the weld closes", binary_stl(&welded_gap)),
    ] {
        assert_eq!(read(&bytes, Units::Mm).map(drop), Err(MeshImportError::SeparateShells(2)), "{why}");
    }

    // A loop of cells whose two ends meet only at the corner (10, 10, 10).
    let ring = [[0, 0, 0], [0, 0, -1], [0, 0, -2], [1, 0, -2], [2, 0, -2], [3, 0, -2], [3, 0, -1], [3, 0, 0], [3, 0, 1], [3, 1, 1], [2, 1, 1], [1, 1, 1]];
    let pinched = voxels(&ring, 10.0);
    assert_eq!(read(&binary_stl(&pinched), Units::Mm).map(drop), Err(MeshImportError::PinchedVertex));
    let open_ring = voxels(&ring[..ring.len() - 1], 10.0);
    assert!(read(&binary_stl(&open_ring), Units::Mm).is_ok(), "the same cells without the touching end are one surface");

    for (why, bytes) in [("a cube", binary_stl(&a)), ("the slab on a post", one_body_3mf(&slab_on_a_post(0.0)))] {
        assert!(read(&bytes, Units::Mm).is_ok(), "{why}");
    }
}

/// An attribute's whole qualified name is capped, prefix included.
#[test]
fn a_qualified_attribute_name_over_the_cap_is_refused() {
    let piece = slab_on_a_post(0.0);
    for prefix in [MAX_ATTRIBUTE_BYTES - 3, MAX_ATTRIBUTE_BYTES] {
        let name = format!("{}:note", "p".repeat(prefix));
        let object = mesh_object(1, &piece).replacen("<vertex ", &format!("<vertex {name}=\"x\" "), 1);
        let refused = read(&three_mf(&model("millimeter", &object, "<item objectid=\"1\"/>")), Units::Mm);
        assert!(matches!(refused, Err(MeshImportError::Malformed(_))), "{} bytes: {refused:?}", name.len());
    }
}

/// A one-entry 3MF whose local and central headers carry these extra fields.
fn with_extra_fields(local: &[u8], central: &[u8]) -> Vec<u8> {
    let body = model("millimeter", &mesh_object(1, &slab_on_a_post(0.0)), "<item objectid=\"1\"/>");
    let base = zip_of(&[("3D/3dmodel.model", body.as_bytes())]);
    let name = b"3D/3dmodel.model";
    let directory = base.windows(4).rposition(|w| w == b"PK\x01\x02").expect("directory");
    let end = base.windows(4).rposition(|w| w == b"PK\x05\x06").expect("end record");
    assert_eq!((&base[28..30], &base[directory + 30..directory + 32]), (&[0, 0][..], &[0, 0][..]), "no extra fields yet");
    let mut out = base[..30].to_vec();
    out[28..30].copy_from_slice(&(local.len() as u16).to_le_bytes());
    out.extend(name);
    out.extend(local);
    out.extend(&base[30 + name.len()..directory]);
    let directory_start = out.len();
    let mut header = base[directory..directory + 46].to_vec();
    header[30..32].copy_from_slice(&(central.len() as u16).to_le_bytes());
    out.extend(header);
    out.extend(name);
    out.extend(central);
    let mut record = base[end..].to_vec();
    record[12..16].copy_from_slice(&((out.len() - directory_start) as u32).to_le_bytes());
    record[16..20].copy_from_slice(&(directory_start as u32).to_le_bytes());
    out.extend(record);
    out
}

/// An extra field must parse into whole records: a fragment shorter than a
/// record's head, or a record that runs past the field, refuses the zip in
/// either header.
#[test]
fn an_incomplete_extra_field_record_is_refused_in_either_header() {
    let record = [0xfe, 0xca, 2, 0, 7, 7];
    assert!(read(&with_extra_fields(&record, &record), Units::Mm).is_ok(), "whole records are fine");
    let mut bad: Vec<Vec<u8>> = [&[1u8][..], &[1, 0], &[1, 0, 8]].iter().map(|tail| [&record[..], tail].concat()).collect();
    bad.push(vec![0xfe, 0xca, 8, 0, 1, 2]);
    for extra in &bad {
        for (header, local, central) in [("local", &extra[..], &[][..]), ("central", &[][..], &extra[..])] {
            assert_eq!(read(&with_extra_fields(local, central), Units::Mm).map(drop), Err(MeshImportError::BadZip), "{header}: {extra:?}");
        }
    }
}
