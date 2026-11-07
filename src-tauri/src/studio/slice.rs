//! The agent's slice step: STL parts in a project folder to one print-ready 3MF for the P2S,
//! sliced by the validated Bambu Studio build with its own system presets merged in full.

use std::fs::File;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use crate::fabrication::bambu::{resolve_presets, BambuStudio, PresetSelection};
use crate::slicer::parse_slice_info;

/// The presets the agent's workflow names: the P2S with a 0.4 mm nozzle, standard layers, PETG.
const MACHINE: &str = "Bambu Lab P2S 0.4 nozzle";
const PROCESS: &str = "0.20mm Standard @BBL P2S";
const FILAMENT: &str = "Bambu PETG Basic @BBL P2S 0.4 nozzle";
/// The P2S machine model's `default_bed_type` (`machine/Bambu Lab P2S.json`), which the preset chain does not carry.
const PLATE: &str = "Textured PEI Plate";

/// Paths are relative to the project folder.
#[derive(Debug, Deserialize)]
pub struct Request {
    project: String,
    inputs: Vec<String>,
    output: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sliced {
    output: String,
    parts: usize,
    print_seconds: u64,
    filament_grams: f64,
}

/// What Bambu Studio reports in `result.json`.
#[derive(Deserialize)]
struct Outcome {
    return_code: i64,
    #[serde(default)]
    error_string: String,
}

pub fn slice(request: &Request, cache_root: &Path) -> Result<Sliced, String> {
    let dir = super::project_dir(&request.project)?;
    let studio = BambuStudio::locate(None).map_err(|e| e.to_string())?;
    slice_in(&studio, &dir, &request.inputs, &request.output, cache_root)
}

/// A path the agent named, which must stay inside its project folder.
fn inside(dir: &Path, rel: &str) -> Result<PathBuf, String> {
    let path = Path::new(rel);
    if rel.is_empty() || !path.components().all(|c| matches!(c, Component::Normal(_))) {
        return Err(format!("{rel:?} is not a path inside the project folder"));
    }
    Ok(dir.join(path))
}

/// The real paths of the inputs and the output. A path is read and written where it really is, so one that leads
/// out of the project through a symbolic link is refused like one that names a place outside it.
fn resolve(dir: &Path, inputs: &[String], output: &str) -> Result<(Vec<PathBuf>, PathBuf), String> {
    if inputs.is_empty() {
        return Err("name at least one STL file to slice".to_owned());
    }
    if !output.ends_with(".3mf") {
        return Err(format!("{output:?} must end in .3mf"));
    }
    let root = dir.canonicalize().map_err(|e| format!("{}: {e}", dir.display()))?;
    let real = |path: &Path, rel: &str| -> Result<PathBuf, String> {
        let path = path.canonicalize().map_err(|_| format!("{rel} does not exist"))?;
        if path.starts_with(&root) { Ok(path) } else { Err(format!("{rel} leads outside the project folder")) }
    };
    let inputs = inputs.iter().map(|rel| real(&inside(dir, rel)?, rel)).collect::<Result<Vec<_>, _>>()?;
    let target = inside(dir, output)?;
    let parent = target.parent().expect("a path inside the project has a parent");
    std::fs::create_dir_all(parent).map_err(|e| format!("{}: {e}", parent.display()))?;
    let parent = real(parent, output)?;
    Ok((inputs, parent.join(target.file_name().expect("a path inside the project names a file"))))
}

fn slice_in(studio: &BambuStudio, dir: &Path, inputs: &[String], output: &str, cache_root: &Path) -> Result<Sliced, String> {
    let (inputs, target) = resolve(dir, inputs, output)?;
    let parent = target.parent().expect("the output has a folder");

    let selection = PresetSelection { machine: MACHINE.to_owned(), process: PROCESS.to_owned(), filaments: vec![FILAMENT.to_owned()] };
    std::fs::create_dir_all(cache_root).map_err(|e| format!("{}: {e}", cache_root.display()))?;
    let presets = resolve_presets(studio, &selection, cache_root).map_err(|e| e.to_string())?;

    // Bambu works in a folder of this run's own beside the output, and the 3MF moves into place only once
    // it checks out, so an earlier 3MF at the output path can never pass as this one.
    let staging = tempfile::Builder::new().prefix(".slice-").tempdir_in(parent).map_err(|e| e.to_string())?;
    let staged = staging.path().join("out.3mf");
    let log = staging.path().join("bambu.log");
    // An STL carries no plate, and Bambu's own default is one the P2S cannot use.
    let mut process = presets.process.config.clone();
    process.insert("curr_bed_type".to_owned(), PLATE.into());
    let process_path = staging.path().join("process.json");
    std::fs::write(&process_path, serde_json::to_vec(&process).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let status = Command::new(&studio.exe)
        .args(&inputs)
        .arg("--load-settings")
        .arg(format!("{};{}", process_path.display(), presets.machine.path.display()))
        .arg("--load-filaments")
        .arg(&presets.filaments[0].path)
        .args(["--arrange", "1", "--orient", "0", "--slice", "0", "--export-3mf"])
        .arg(&staged)
        // Bambu writes result.json into its working directory.
        .current_dir(staging.path())
        .stdin(Stdio::null())
        .stdout(File::create(&log).map_err(|e| e.to_string())?)
        .stderr(Stdio::null())
        .status()
        .map_err(|e| format!("starting {}: {e}", studio.exe.display()))?;

    let outcome: Option<Outcome> = std::fs::read_to_string(staging.path().join("result.json")).ok().and_then(|text| serde_json::from_str(&text).ok());
    match outcome {
        Some(Outcome { return_code: 0, .. }) if status.success() && staged.is_file() => {}
        Some(Outcome { return_code, error_string }) => {
            return Err(format!("Bambu Studio failed ({return_code}): {}", if error_string.is_empty() { status.to_string() } else { error_string }))
        }
        None => return Err(format!("Bambu Studio exited with {status} and reported nothing")),
    }
    let info = parse_slice_info(&staged).map_err(|e| e.to_string())?;
    if info.sliced_parts != inputs.len() {
        return Err(format!("Bambu Studio sliced {} of {} parts, so a part is off the plate or too small", info.sliced_parts, inputs.len()));
    }
    std::fs::rename(&staged, &target).map_err(|e| format!("{}: {e}", target.display()))?;
    Ok(Sliced {
        output: output.to_owned(),
        parts: info.sliced_parts,
        print_seconds: info.estimates.time_seconds,
        filament_grams: info.estimates.filament_grams,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn a_symbolic_link_out_of_the_project_is_refused() {
        let outside = tempfile::tempdir().expect("outside");
        let project = tempfile::tempdir().expect("project");
        std::fs::write(outside.path().join("secret.stl"), "solid x\nendsolid x\n").expect("stl");
        std::os::unix::fs::symlink(outside.path(), project.path().join("print")).expect("link");
        std::os::unix::fs::symlink(outside.path().join("secret.stl"), project.path().join("part.stl")).expect("link");
        std::fs::write(project.path().join("cube.stl"), "solid x\nendsolid x\n").expect("stl");

        let output = resolve(project.path(), &["cube.stl".to_owned()], "print/cube.3mf").expect_err("output through a link");
        assert!(output.contains("leads outside the project folder"), "{output}");
        let input = resolve(project.path(), &["part.stl".to_owned()], "out/cube.3mf").expect_err("input through a link");
        assert!(input.contains("leads outside the project folder"), "{input}");
        let (inputs, target) = resolve(project.path(), &["cube.stl".to_owned()], "out/cube.3mf").expect("inside");
        let root = project.path().canonicalize().expect("root");
        assert_eq!((inputs, target), (vec![root.join("cube.stl")], root.join("out/cube.3mf")));
    }

    #[test]
    fn the_agent_can_name_only_paths_inside_its_project() {
        let dir = Path::new("/projects/clip");
        assert_eq!(inside(dir, "print/clip.3mf").expect("inside"), dir.join("print/clip.3mf"));
        for bad in ["", "/etc/passwd", "../other/a.stl", "print/../../x.3mf", "./a.stl"] {
            assert!(inside(dir, bad).is_err(), "{bad:?} must be refused");
        }
    }

    /// A 20 mm cube as an ASCII STL, outward normals, twelve facets.
    fn cube_stl(size: f64) -> String {
        let v = |x: u8, y: u8, z: u8| [f64::from(x) * size, f64::from(y) * size, f64::from(z) * size];
        let quads: [[[u8; 3]; 4]; 6] = [
            [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
            [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
            [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
            [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
            [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
            [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]],
        ];
        let mut stl = String::from("solid cube\n");
        for [a, b, c, d] in quads {
            for [p, q, r] in [[a, b, c], [a, c, d]] {
                stl.push_str("facet normal 0 0 0\nouter loop\n");
                for [x, y, z] in [p, q, r] {
                    let [x, y, z] = v(x, y, z);
                    stl.push_str(&format!("vertex {x} {y} {z}\n"));
                }
                stl.push_str("endloop\nendfacet\n");
            }
        }
        stl.push_str("endsolid cube\n");
        stl
    }

    /// Needs the validated Bambu Studio build (BAMBU_STUDIO_CLI or an install), as CI's Bambu step has.
    #[test]
    #[ignore = "runs the real Bambu Studio"]
    fn a_cube_slices_to_a_print_ready_3mf_and_a_missing_part_is_refused() {
        let studio = BambuStudio::locate(None).expect("a validated Bambu Studio");
        let project = tempfile::tempdir().expect("project");
        let cache = tempfile::tempdir().expect("cache");
        std::fs::write(project.path().join("cube.stl"), cube_stl(20.0)).expect("stl");

        let sliced = slice_in(&studio, project.path(), &["cube.stl".to_owned()], "print/cube.3mf", cache.path()).expect("slice");
        assert_eq!(sliced.parts, 1);
        assert!(sliced.print_seconds > 0 && sliced.filament_grams > 0.0, "{sliced:?}");
        let mut archive = zip::ZipArchive::new(File::open(project.path().join("print/cube.3mf")).expect("3mf")).expect("zip");
        let mut gcode = String::new();
        std::io::Read::read_to_string(&mut archive.by_name("Metadata/plate_1.gcode").expect("plate 1's G-code"), &mut gcode).expect("text");
        assert!(gcode.contains("P2S start gcode"), "the P2S machine preset is in the G-code");
        assert!(gcode.contains("; curr_bed_type = Textured PEI Plate"), "the P2S plate is in the G-code");
        let leftovers: Vec<_> = std::fs::read_dir(project.path().join("print")).expect("print").filter_map(Result::ok).map(|e| e.file_name()).collect();
        assert_eq!(leftovers, ["cube.3mf"], "the staging folder is gone");

        let missing = slice_in(&studio, project.path(), &["gone.stl".to_owned()], "print/gone.3mf", cache.path()).expect_err("missing input");
        assert!(missing.contains("does not exist"), "{missing}");
    }
}
