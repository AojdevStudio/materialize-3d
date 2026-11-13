//! The agent's slice step: STL parts in a project folder to one print-ready 3MF for the chosen printer,
//! sliced by the validated Bambu Studio build with its own system presets merged in full.

use std::fs::File;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};

use serde::{Deserialize, Serialize};

use super::print_info::{parse_slice_info, SliceInfo};
use crate::bambu::{resolve_presets, BambuStudio, Plate, PresetSelection, ResolvedPresets};

/// The printer a slice runs for: three Bambu Lab system presets by name, and the plate. With no plate, the slice
/// uses the default plate of the printer's model.
#[derive(Debug, Deserialize)]
pub struct Printer {
    machine: String,
    process: String,
    filament: String,
    plate: Option<Plate>,
}

/// Paths are relative to the project folder.
#[derive(Debug, Deserialize)]
pub struct Request {
    project: String,
    inputs: Vec<String>,
    output: String,
    printer: Printer,
}

/// `plate` is the plate the slice ran on, which is the printer's default when the request named none.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sliced {
    output: String,
    parts: usize,
    print_seconds: u64,
    filament_grams: f64,
    plate: Plate,
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
    let studio = BambuStudio::locate().map_err(|e| e.to_string())?;
    slice_in(&studio, &dir, &request.inputs, &request.output, &request.printer, cache_root)
}

/// Whether a slice can run for `printer`: the validated Bambu Studio ships its three presets, they fit each other,
/// and the printer takes the plate. The setting is saved only after this passes.
pub fn check(printer: &Printer, cache_root: &Path) -> Result<(), String> {
    let studio = BambuStudio::locate().map_err(|e| e.to_string())?;
    presets_for(&studio, printer, cache_root).map(|_| ())
}

/// The printer's presets, flattened for Bambu Studio's command line, and the plate to slice on.
fn presets_for(studio: &BambuStudio, printer: &Printer, cache_root: &Path) -> Result<(ResolvedPresets, Plate), String> {
    let selection = PresetSelection { machine: printer.machine.clone(), process: printer.process.clone(), filaments: vec![printer.filament.clone()] };
    std::fs::create_dir_all(cache_root).map_err(|e| format!("{}: {e}", cache_root.display()))?;
    let presets = resolve_presets(studio, &selection, cache_root).map_err(|e| e.to_string())?;
    let plate = presets.plates.choose(printer.plate).map_err(|e| e.to_string())?;
    Ok((presets, plate))
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
    // The output's folder is made one level at a time, and each level that exists is checked where it really is
    // first, so no folder is ever made outside the project.
    let mut folder = root.clone();
    for part in Path::new(output).parent().map_or_else(Vec::new, |parent| parent.components().collect()) {
        let next = folder.join(part);
        match std::fs::symlink_metadata(&next) {
            Ok(_) => folder = real(&next, output)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                std::fs::create_dir(&next).map_err(|e| format!("{}: {e}", next.display()))?;
                folder = next;
            }
            Err(e) => return Err(format!("{}: {e}", next.display())),
        }
    }
    Ok((inputs, folder.join(target.file_name().expect("a path inside the project names a file"))))
}

fn slice_in(studio: &BambuStudio, dir: &Path, inputs: &[String], output: &str, printer: &Printer, cache_root: &Path) -> Result<Sliced, String> {
    let (inputs, target) = resolve(dir, inputs, output)?;
    let parent = target.parent().expect("the output has a folder");
    let (presets, plate) = presets_for(studio, printer, cache_root)?;

    // Bambu works in a folder of this run's own beside the output, and the 3MF moves into place only once
    // it checks out, so an earlier 3MF at the output path can never pass as this one.
    let staging = tempfile::Builder::new().prefix(".slice-").tempdir_in(parent).map_err(|e| e.to_string())?;
    let staged = staging.path().join("out.3mf");
    let log = staging.path().join("bambu.log");
    // An STL carries no plate, and Bambu's own default is one most of its printers cannot use.
    let mut process = presets.process.config.clone();
    process.insert("curr_bed_type".to_owned(), plate.setting().into());
    let process_path = staging.path().join("process.json");
    std::fs::write(&process_path, serde_json::to_vec(&process).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    let status = Command::new(&studio.exe)
        .args(&inputs)
        .arg("--load-settings")
        .arg(format!("{};{}", process_path.display(), presets.machine.path.display()))
        .arg("--load-filaments")
        .arg(&presets.filaments[0].path)
        // The 3MF goes by its bare name: Bambu joins it to the output folder, and on macOS a full path
        // there fails to export (-13).
        .args(["--arrange", "1", "--orient", "0", "--slice", "0", "--export-3mf", "out.3mf", "--outputdir"])
        .arg(staging.path())
        // Bambu writes result.json into its output folder or its working directory. Both are this folder.
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
        None => {
            let log = std::fs::read_to_string(&log).unwrap_or_default();
            let tail = log.lines().rev().take(5).collect::<Vec<_>>().into_iter().rev().collect::<Vec<_>>().join("\n");
            return Err(format!("Bambu Studio exited with {status} and reported nothing. Its log ends:\n{tail}"));
        }
    }
    let info = slice_info(&staged)?;
    if info.parts != inputs.len() {
        return Err(format!("Bambu Studio sliced {} of {} parts, so a part is off the plate or too small", info.parts, inputs.len()));
    }
    std::fs::rename(&staged, &target).map_err(|e| format!("{}: {e}", target.display()))?;
    Ok(Sliced { output: output.to_owned(), parts: info.parts, print_seconds: info.print_seconds.unwrap_or(0), filament_grams: info.filament_grams.unwrap_or(0.0), plate })
}

fn slice_info(path: &Path) -> Result<SliceInfo, String> {
    let mut archive = zip::ZipArchive::new(File::open(path).map_err(|e| format!("{}: {e}", path.display()))?)
        .map_err(|e| format!("{}: not a 3MF: {e}", path.display()))?;
    let mut xml = String::new();
    std::io::Read::read_to_string(
        &mut archive.by_name("Metadata/slice_info.config").map_err(|e| format!("the 3MF has no slice_info.config: {e}"))?,
        &mut xml,
    )
    .map_err(|e| format!("reading slice_info.config: {e}"))?;
    parse_slice_info(&xml)
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
        let deeper = resolve(project.path(), &["cube.stl".to_owned()], "print/new/cube.3mf").expect_err("a new folder through a link");
        assert!(deeper.contains("leads outside the project folder"), "{deeper}");
        assert!(!outside.path().join("new").exists(), "no folder was made outside the project");
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

    fn printer(machine: &str, process: &str, filament: &str, plate: Option<Plate>) -> Printer {
        Printer { machine: machine.to_owned(), process: process.to_owned(), filament: filament.to_owned(), plate }
    }

    /// The printer a new store starts with (`SettingsDoc` in `sidecar/src/store.ts`).
    fn p2s() -> Printer {
        printer("Bambu Lab P2S 0.4 nozzle", "0.20mm Standard @BBL P2S", "Bambu PETG Basic @BBL P2S 0.4 nozzle", None)
    }

    /// One file of a sliced 3MF, as text.
    fn entry(path: &Path, name: &str) -> String {
        let mut archive = zip::ZipArchive::new(File::open(path).expect("3mf")).expect("zip");
        let mut text = String::new();
        std::io::Read::read_to_string(&mut archive.by_name(name).unwrap_or_else(|e| panic!("{name}: {e}")), &mut text).expect("text");
        text
    }

    /// Needs the validated Bambu Studio build (BAMBU_STUDIO_CLI or an install), as CI's Bambu step has.
    #[test]
    #[ignore = "runs the real Bambu Studio"]
    fn a_cube_slices_to_a_print_ready_3mf_and_a_missing_part_is_refused() {
        let studio = BambuStudio::locate().expect("a validated Bambu Studio");
        let project = tempfile::tempdir().expect("project");
        let cache = tempfile::tempdir().expect("cache");
        std::fs::write(project.path().join("cube.stl"), cube_stl(20.0)).expect("stl");

        let sliced = slice_in(&studio, project.path(), &["cube.stl".to_owned()], "print/cube.3mf", &p2s(), cache.path()).expect("slice");
        assert_eq!((sliced.parts, sliced.plate), (1, Plate::TexturedPei));
        assert!(sliced.print_seconds > 0 && sliced.filament_grams > 0.0, "{sliced:?}");
        let gcode = entry(&project.path().join("print/cube.3mf"), "Metadata/plate_1.gcode");
        assert!(gcode.contains("P2S start gcode"), "the P2S machine preset is in the G-code");
        assert!(gcode.contains("; curr_bed_type = Textured PEI Plate"), "the P2S plate is in the G-code");
        let leftovers: Vec<_> = std::fs::read_dir(project.path().join("print")).expect("print").filter_map(Result::ok).map(|e| e.file_name()).collect();
        assert_eq!(leftovers, ["cube.3mf"], "the staging folder is gone");

        let missing = slice_in(&studio, project.path(), &["gone.stl".to_owned()], "print/gone.3mf", &p2s(), cache.path()).expect_err("missing input");
        assert!(missing.contains("does not exist"), "{missing}");
    }

    #[test]
    #[ignore = "runs the real Bambu Studio"]
    fn a_cube_slices_for_the_chosen_printer_and_plate() {
        let studio = BambuStudio::locate().expect("a validated Bambu Studio");
        let project = tempfile::tempdir().expect("project");
        let cache = tempfile::tempdir().expect("cache");
        std::fs::write(project.path().join("cube.stl"), cube_stl(20.0)).expect("stl");
        let a1_mini = |plate| printer("Bambu Lab A1 mini 0.4 nozzle", "0.20mm Standard @BBL A1M", "Bambu PLA Basic @BBL A1M", plate);

        let sliced = slice_in(&studio, project.path(), &["cube.stl".to_owned()], "print/cube.3mf", &a1_mini(Some(Plate::Supertack)), cache.path()).expect("slice");
        assert_eq!((sliced.parts, sliced.plate), (1, Plate::Supertack));
        let settings: serde_json::Value =
            serde_json::from_str(&entry(&project.path().join("print/cube.3mf"), "Metadata/project_settings.config")).expect("project settings");
        assert_eq!(settings["printer_model"], "Bambu Lab A1 mini");
        assert_eq!(settings["printer_settings_id"], "Bambu Lab A1 mini 0.4 nozzle");
        assert_eq!(settings["print_settings_id"], "0.20mm Standard @BBL A1M");
        assert_eq!(settings["filament_settings_id"], serde_json::json!(["Bambu PLA Basic @BBL A1M"]));
        assert_eq!(settings["curr_bed_type"], "Supertack Plate");
        let gcode = entry(&project.path().join("print/cube.3mf"), "Metadata/plate_1.gcode");
        assert!(gcode.contains("; printer_model = Bambu Lab A1 mini"), "the A1 mini machine preset is in the G-code");
        assert!(gcode.contains("; curr_bed_type = Supertack Plate"), "the chosen plate is in the G-code");

        let on_default = slice_in(&studio, project.path(), &["cube.stl".to_owned()], "print/default.3mf", &a1_mini(None), cache.path()).expect("slice");
        assert_eq!(on_default.plate, Plate::TexturedPei, "the A1 mini's own default plate");
    }

    #[test]
    #[ignore = "runs the real Bambu Studio"]
    fn a_printer_bambu_studio_cannot_slice_for_is_refused() {
        let cache = tempfile::tempdir().expect("cache");
        let refused = |printer: Printer| check(&printer, cache.path()).expect_err("refused");

        check(&p2s(), cache.path()).expect("the printer a new store starts with");
        let unknown = refused(printer("Bambu Lab Z9 0.4 nozzle", "0.20mm Standard @BBL P2S", "Bambu PETG Basic @BBL P2S 0.4 nozzle", None));
        assert!(unknown.contains(r#"machine preset not found in BBL.json: "Bambu Lab Z9 0.4 nozzle""#), "{unknown}");
        let another = refused(printer("Bambu Lab A1 mini 0.4 nozzle", "0.20mm Standard @BBL A1M", "Bambu PETG Basic @BBL P2S 0.4 nozzle", None));
        assert!(another.contains(r#"is not compatible with machine "Bambu Lab A1 mini 0.4 nozzle""#), "{another}");
        let plate = refused(printer("Bambu Lab P2S 0.4 nozzle", "0.20mm Standard @BBL P2S", "Bambu PETG Basic @BBL P2S 0.4 nozzle", Some(Plate::Cool)));
        assert!(plate.contains("The Bambu Lab P2S cannot use the Cool Plate"), "{plate}");
    }
}
