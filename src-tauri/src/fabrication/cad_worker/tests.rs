use super::*;
use crate::fabrication::printer::P2S_04;

// ─── The guest channel ───────────────────────────────────────────────────────

fn frame(tag: &[u8; 4], payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    write_frame(&mut out, tag, payload).expect("frame");
    out
}

const DONE: &[u8] = br#"{"ok":true,"error":null}"#;

fn read(bytes: &[u8], role: Role) -> Result<Response, ProtocolError> {
    read_response(&mut &bytes[..], role, &FrameLimits::PART)
}

#[test]
fn a_generation_response_round_trips() {
    let bytes = [frame(b"STEP", b"ISO-10303-21;"), frame(b"MANI", b"{}"), frame(b"DONE", DONE)].concat();
    let response = read(&bytes, Role::Generate).expect("response");
    assert_eq!(response.step.as_deref(), Some(&b"ISO-10303-21;"[..]));
    assert!(response.done.ok);
}

#[test]
fn an_oversized_frame_is_refused_from_its_header_alone() {
    // Only the 8-byte header exists: a reader that tried to fill 4 GiB would report Truncated instead.
    let mut header = b"MESH".to_vec();
    header.extend_from_slice(&u32::MAX.to_le_bytes());
    let err = read(&header, Role::Inspect).unwrap_err();
    assert!(matches!(err, ProtocolError::TooLarge { tag: Tag::Mesh, len: u32::MAX, .. }), "{err}");
}

#[test]
fn unknown_and_path_like_tags_are_refused() {
    let err = read(&frame(b"../x", b"/etc/passwd"), Role::Inspect).unwrap_err();
    assert!(matches!(err, ProtocolError::UnknownTag(_)), "{err}");
}

#[test]
fn each_role_sends_only_its_own_frames_and_each_frame_once() {
    let err = read(&frame(b"MANI", b"{}"), Role::Inspect).unwrap_err();
    assert!(matches!(err, ProtocolError::NotAllowed { tag: Tag::Manifest, .. }), "{err}");
    let err = read(&frame(b"MESH", b""), Role::Generate).unwrap_err();
    assert!(matches!(err, ProtocolError::NotAllowed { tag: Tag::Mesh, .. }), "{err}");
    let err = read(&[frame(b"STEP", b"a"), frame(b"STEP", b"b")].concat(), Role::Generate).unwrap_err();
    assert!(matches!(err, ProtocolError::Duplicate(Tag::Step)), "{err}");
}

#[test]
fn the_total_cap_holds_across_frames_and_done_ends_the_channel() {
    let limits = FrameLimits { total: 10, ..FrameLimits::PART };
    let bytes = [frame(b"STEP", &[0; 8]), frame(b"DIAG", &[0; 8])].concat();
    let err = read_response(&mut &bytes[..], Role::Generate, &limits).unwrap_err();
    assert!(matches!(err, ProtocolError::TotalTooLarge(10)), "{err}");

    let partial = frame(b"STEP", b"partial");
    assert!(matches!(read(&partial, Role::Generate), Err(ProtocolError::Truncated)));
    let err = read(&frame(b"DONE", br#"{"ok":true,"path":"/tmp/x"}"#), Role::Generate).unwrap_err();
    assert!(matches!(err, ProtocolError::BadDone(_)), "{err}");
}

// ─── The body manifest ───────────────────────────────────────────────────────

#[test]
fn a_manifest_bounds_names_and_slots() {
    let manifest = parse_manifest(br#"{"bodies":[{"name":"clip","slot":1},{"name":"inlay","slot":2}]}"#).expect("manifest");
    let names: Vec<&str> = manifest.bodies().iter().map(|(name, _)| name.as_str()).collect();
    assert_eq!(names, ["clip", "inlay"]);

    assert_eq!(parse_manifest(br#"{"bodies":[]}"#).unwrap_err(), ManifestError::BodyCount(0));
    assert_eq!(parse_manifest(br#"{"bodies":[{"name":"a","slot":0}]}"#).unwrap_err(), ManifestError::Slot(0));
    assert_eq!(parse_manifest(br#"{"bodies":[{"name":"a","slot":17}]}"#).unwrap_err(), ManifestError::Slot(0));
    let long = format!(r#"{{"bodies":[{{"name":"{}","slot":1}}]}}"#, "x".repeat(65));
    assert_eq!(parse_manifest(long.as_bytes()).unwrap_err(), ManifestError::Name(0));
    assert!(matches!(parse_manifest(br#"{"bodies":[{"name":"a","slot":1,"path":"/x"}]}"#), Err(ManifestError::Shape(_))));
    assert!(matches!(parse_manifest(br#"{"bodies":[{"name":"a","slot":300}]}"#), Err(ManifestError::Shape(_))));
    assert_eq!(
        parse_manifest(br#"{"bodies":[{"name":"a","slot":1},{"name":"a","slot":2}]}"#).unwrap_err(),
        ManifestError::Duplicate(1, "a".into())
    );
}

/// A name that reads as one thing and is another is refused: control
/// characters, zero-width characters, bidirectional overrides and isolates,
/// and spaces at either end.
#[test]
fn a_body_name_with_hidden_or_reordering_characters_is_refused() {
    for name in ["a\nb", "cl\u{200B}ip", "\u{202E}pilc", "clip\u{2066}", "\u{FEFF}clip", "cl\u{200D}ip", "\u{061C}a", " clip", "clip "] {
        assert_eq!(BodyName::parse(name), None, "{name:?}");
        let json = serde_json::json!({ "bodies": [{ "name": name, "slot": 1 }] }).to_string();
        assert_eq!(parse_manifest(json.as_bytes()).unwrap_err(), ManifestError::Name(0), "{name:?}");
    }
    for name in ["clip", "desk jaw", "Ösen-Halter", "支架"] {
        assert_eq!(BodyName::parse(name).map(|n| n.as_str().to_owned()), Some(name.to_owned()));
    }
}

#[test]
fn a_manifest_slot_must_be_a_filament_the_spec_lists() {
    let palette = Palette::new(vec!["#FFFFFF".into(), "#000000".into()], &P2S_04).expect("palette");
    let manifest = parse_manifest(br#"{"bodies":[{"name":"a","slot":2}]}"#).expect("manifest");
    assert_eq!(manifest.slots(&palette).expect("slots").iter().map(|s| s.number()).collect::<Vec<_>>(), [2]);
    let manifest = parse_manifest(br#"{"bodies":[{"name":"a","slot":3}]}"#).expect("manifest");
    assert_eq!(
        manifest.slots(&palette).unwrap_err(),
        ManifestError::NoSuchFilament { body: 0, name: "a".into(), slot: 3, filaments: 2 }
    );
}

// ─── The mesh protocol ───────────────────────────────────────────────────────

type WireBody = (Vec<[f64; 3]>, Vec<[u32; 3]>);

fn encode(bodies: &[WireBody]) -> Vec<u8> {
    let mut out = MESH_MAGIC.to_vec();
    out.extend((bodies.len() as u32).to_le_bytes());
    for (v, t) in bodies {
        out.extend((v.len() as u32).to_le_bytes());
        out.extend((t.len() as u32).to_le_bytes());
        v.iter().flatten().for_each(|c| out.extend(c.to_le_bytes()));
        t.iter().flatten().for_each(|i| out.extend(i.to_le_bytes()));
    }
    out
}

/// A closed, outward tetrahedron with per-face vertices, the way the inspector sends faces.
fn tetra_bytes(edit: impl FnOnce(&mut Vec<[f64; 3]>, &mut Vec<[u32; 3]>)) -> Vec<u8> {
    let p = [[0.0, 0.0, 0.0], [10.0, 0.0, 0.0], [0.0, 10.0, 0.0], [0.0, 0.0, 10.0]];
    let mut verts = Vec::new();
    let mut tris = Vec::new();
    for f in [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]] {
        let base = verts.len() as u32;
        verts.extend(f.map(|i| p[i]));
        tris.push([base, base + 1, base + 2]);
    }
    edit(&mut verts, &mut tris);
    encode(&[(verts, tris)])
}

#[test]
fn per_face_vertices_weld_to_shared_grid_points() {
    let bodies = decode_mesh(&tetra_bytes(|_, _| {}), &MeshLimits::PART).expect("mesh");
    let mesh = bodies[0].weld();
    assert_eq!(mesh.vertices().len(), 4, "12 per-face vertices weld to 4");
    assert_eq!(mesh.triangles().len(), 4);
    assert!(mesh.vertices().contains(&[10_000, 0, 0]), "millimeters become µm");
    // 0.4 µm apart: both round to the same grid point.
    let bodies = decode_mesh(&tetra_bytes(|v, _| v[3][0] += 0.0004), &MeshLimits::PART).expect("mesh");
    assert_eq!(bodies[0].weld().vertices().len(), 4);
}

#[test]
fn hostile_meshes_are_rejected_before_use() {
    let lim = MeshLimits::PART;
    let cases: [(Vec<u8>, MeshError); 6] = [
        (tetra_bytes(|v, _| v[1][1] = f64::NAN), MeshError::BadCoordinate { body: 0, vertex: 1 }),
        (tetra_bytes(|v, _| v[2][2] = f64::INFINITY), MeshError::BadCoordinate { body: 0, vertex: 2 }),
        (tetra_bytes(|v, _| v[0][0] = 1e300), MeshError::BadCoordinate { body: 0, vertex: 0 }),
        (tetra_bytes(|_, t| t[3][2] = 99), MeshError::BadIndex { body: 0, triangle: 3 }),
        (encode(&[]), MeshError::BodyCount(0)),
        (encode(&vec![(vec![[0.0; 3]; 3], vec![[0, 1, 2]]); 17]), MeshError::BodyCount(17)),
    ];
    for (bytes, want) in cases {
        assert_eq!(decode_mesh(&bytes, &lim).unwrap_err(), want);
    }
    let mut trailing = tetra_bytes(|_, _| {});
    trailing.extend(b"EXTRA");
    assert_eq!(decode_mesh(&trailing, &lim).unwrap_err(), MeshError::TrailingBytes(5));
    let mut magic = tetra_bytes(|_, _| {});
    magic[0] = b'X';
    assert_eq!(decode_mesh(&magic, &lim).unwrap_err(), MeshError::BadMagic);
    let empty = [MESH_MAGIC.as_slice(), &1u32.to_le_bytes(), &0u32.to_le_bytes(), &0u32.to_le_bytes()].concat();
    assert_eq!(decode_mesh(&empty, &lim).unwrap_err(), MeshError::EmptyBody { body: 0, vertices: 0, triangles: 0 });
}

#[test]
fn counts_are_checked_against_the_payload_before_allocating() {
    let mut lie = tetra_bytes(|_, _| {});
    lie[12..16].copy_from_slice(&1_999_999u32.to_le_bytes()); // within limits, far beyond the bytes present
    assert_eq!(decode_mesh(&lie, &MeshLimits::PART).unwrap_err(), MeshError::CountsExceedPayload { body: 0 });
    lie[12..16].copy_from_slice(&u32::MAX.to_le_bytes());
    assert!(matches!(decode_mesh(&lie, &MeshLimits::PART).unwrap_err(), MeshError::TooLarge { .. }));
    assert_eq!(decode_mesh(b"M3DMESH1\x01\x00", &MeshLimits::PART).unwrap_err(), MeshError::Truncated);
}

// ─── The runtime image ───────────────────────────────────────────────────────

/// A directory holding `files`, and pins JSON that match them exactly.
fn runtime_dir(files: &[(&str, &[u8])]) -> (tempfile::TempDir, String) {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut pins = serde_json::Map::new();
    for (name, data) in files {
        std::fs::write(dir.path().join(name), data).expect("write");
        pins.insert((*name).into(), serde_json::json!({ "sha256": hex(&Sha256::digest(data)), "bytes": data.len() }));
    }
    let json = serde_json::json!({ "arch": "amd64", "files": pins }).to_string();
    (dir, json)
}

#[test]
fn a_runtime_verifies_only_when_every_file_matches_its_pin() {
    let (dir, pins) = runtime_dir(&[("vmlinux", b"kernel"), ("rootfs.img", b"root")]);
    let image = VerifiedRuntimeImage::verify(dir.path(), &pins, &["vmlinux", "rootfs.img"]).expect("verified");
    assert_eq!(image.digests[0], format!("vmlinux {}", hex(&Sha256::digest(b"kernel"))));

    // Same size, one byte changed: only the digest can catch it.
    std::fs::write(dir.path().join("rootfs.img"), b"ROOT").expect("tamper");
    let err = VerifiedRuntimeImage::verify(dir.path(), &pins, &["vmlinux", "rootfs.img"]).unwrap_err();
    assert!(matches!(&err, RuntimeUnavailable::Unverified(why) if why.contains("does not match the pin")), "{err}");
    std::fs::write(dir.path().join("rootfs.img"), b"root, longer").expect("resize");
    assert!(matches!(VerifiedRuntimeImage::verify(dir.path(), &pins, &["rootfs.img"]), Err(RuntimeUnavailable::Unverified(_))));
    std::fs::remove_file(dir.path().join("vmlinux")).expect("remove");
    assert!(matches!(VerifiedRuntimeImage::verify(dir.path(), &pins, &["vmlinux"]), Err(RuntimeUnavailable::Missing(_))));
    assert!(matches!(VerifiedRuntimeImage::verify(dir.path(), &pins, &["job.img"]), Err(RuntimeUnavailable::Unverified(_))));
}

#[test]
fn the_compiled_pins_cover_the_shipped_runtime_and_the_inspector_settings_match() {
    let pins: Pins = serde_json::from_str(PINS_ARM64).expect("arm64 pins");
    assert_eq!(pins.arch, "arm64");
    for name in ["Image", "rootfs.img", "job.img"] {
        assert!(pins.files.contains_key(name), "{name} is not pinned");
    }
    let inspector = std::str::from_utf8(INSPECTOR).expect("utf-8");
    assert!(inspector.contains("LINEAR_DEFLECTION_MM = 0.02\n"), "TESSELLATION must follow the inspector");
    assert!(inspector.contains("ANGULAR_DEFLECTION_RAD = 0.2\n"), "TESSELLATION must follow the inspector");
}

#[test]
fn an_app_without_a_bundled_runtime_has_none() {
    // Test binaries live in target/, where no app bundle surrounds them.
    assert!(CadRuntime::bundled().is_err());
    assert!(CadRuntimeSlot::bundled().get().is_none());
    assert!(CadRuntimeSlot::fixed(None).get().is_none());
}
