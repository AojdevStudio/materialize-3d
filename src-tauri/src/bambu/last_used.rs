//! What the person last used in Bambu Studio, read from its own config folder: `BambuStudio.conf`, and the presets
//! the person made, which Bambu Studio keeps under `user/<preset folder>/`.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::presets::PresetKind;
use super::{io_err, parse_json_object, BambuError, Plate, Result};

/// The printer, nozzle, quality, filament, and plate Bambu Studio last had selected. Bambu Studio always records a
/// printer once one is chosen. The process, the filament, and the plate can each be missing.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct LastUsed {
    /// The printer and its nozzle size in mm, as the printer preset's name gives them: `Bambu Lab P2S` and `0.4`.
    pub printer: String,
    pub nozzle: String,
    pub machine: Preset,
    pub process: Option<Preset>,
    /// The filament in the first slot.
    pub filament: Option<Preset>,
    pub plate: Option<Plate>,
}

/// A preset by the name Bambu Studio shows. `system` is the Bambu Lab preset a slice can run with: the same name,
/// or for a preset the person made, the one it was made from. A preset the person made from nothing has none.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Preset {
    pub name: String,
    pub system: Option<String>,
}

/// The parts of `BambuStudio.conf` read here. Bambu Studio writes every value of `app` as a string or a boolean.
#[derive(Deserialize)]
struct Conf {
    #[serde(default)]
    app: App,
    #[serde(default)]
    presets: Selected,
}

#[derive(Default, Deserialize)]
struct App {
    /// The plate, as a number of Bambu's `BedType`.
    curr_bed_type: Option<String>,
    /// The folder under `user/` with the presets the person made: their account's id, or `default` signed out.
    preset_folder: Option<String>,
}

#[derive(Default, Deserialize)]
struct Selected {
    machine: Option<String>,
    process: Option<String>,
    #[serde(default)]
    filaments: Vec<String>,
}

/// Bambu Studio's config folder: `~/Library/Application Support/BambuStudio` on macOS, `~/.config/BambuStudio` on Linux.
fn config_dir() -> Option<PathBuf> {
    dirs::config_dir().map(|dir| dir.join("BambuStudio"))
}

/// What Bambu Studio last used on this computer, for the printer step of setup. Nothing when Bambu Studio has never
/// run here, or when its last printer is not named as Bambu Lab's printer presets are.
#[tauri::command]
pub async fn bambu_last_used() -> Result<Option<LastUsed>, String> {
    let dir = config_dir().ok_or("this computer has no config folder")?;
    read(&dir).map_err(|e| e.to_string())
}

fn read(dir: &Path) -> Result<Option<LastUsed>> {
    let path = dir.join("BambuStudio.conf");
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io_err(&path)(e)),
    };
    let Conf { app, presets } = serde_json::from_str(&text).map_err(|source| BambuError::Json { path, source })?;
    // Bambu Studio keeps an unset value as an empty string.
    let chosen = |name: Option<String>| name.filter(|name| !name.is_empty());
    let folder = chosen(app.preset_folder).unwrap_or_else(|| "default".to_owned());
    let preset = |kind, name| preset(dir, &folder, kind, name);

    let Some(machine) = chosen(presets.machine).map(|name| preset(PresetKind::Machine, name)).transpose()? else {
        return Ok(None);
    };
    let Some((printer, nozzle)) = machine.system.as_deref().and_then(printer_and_nozzle) else {
        return Ok(None);
    };
    Ok(Some(LastUsed {
        printer: printer.to_owned(),
        nozzle: nozzle.to_owned(),
        process: chosen(presets.process).map(|name| preset(PresetKind::Process, name)).transpose()?,
        filament: chosen(presets.filaments.into_iter().next()).map(|name| preset(PresetKind::Filament, name)).transpose()?,
        plate: app.curr_bed_type.and_then(|number| number.parse().ok()).and_then(Plate::from_number),
        machine,
    }))
}

/// The two parts of a Bambu Lab printer preset's name, `<printer> <nozzle> nozzle`.
fn printer_and_nozzle(machine: &str) -> Option<(&str, &str)> {
    machine.strip_suffix(" nozzle")?.rsplit_once(' ')
}

/// A preset Bambu Studio names, with the system preset under it. A preset the person made is a file of that name in
/// their preset folder, whose `inherits` names the system preset it was made from.
fn preset(dir: &Path, folder: &str, kind: PresetKind, name: String) -> Result<Preset> {
    let made = dir.join("user").join(folder).join(kind.as_str()).join(format!("{name}.json"));
    // The file is read where it really is, so a name or a link that leads out of the config folder is refused.
    let real = match made.canonicalize() {
        Ok(real) => real,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Preset { system: Some(name.clone()), name }),
        Err(e) => return Err(io_err(&made)(e)),
    };
    if !real.starts_with(dir.canonicalize().map_err(io_err(dir))?) {
        return Err(BambuError::Preset(format!("{} leads outside Bambu Studio's config folder", made.display())));
    }
    let text = fs::read_to_string(&real).map_err(io_err(&real))?;
    let system = match parse_json_object(&text, &made)?.remove("inherits") {
        None => None,
        // Bambu Studio writes an empty name for a preset made from nothing.
        Some(serde_json::Value::String(parent)) => Some(parent).filter(|parent| !parent.is_empty()),
        Some(other) => return Err(BambuError::Preset(format!("{}: inherits: expected a preset name, got {other}", made.display()))),
    };
    Ok(Preset { name, system })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/bambu/config")
    }

    fn system(name: &str) -> Preset {
        Preset { name: name.to_owned(), system: Some(name.to_owned()) }
    }

    /// A config folder inside a temporary folder of the test's own, so a test can put a file outside it.
    struct Config {
        around: tempfile::TempDir,
    }

    impl Config {
        fn path(&self) -> PathBuf {
            self.around.path().join("BambuStudio")
        }
    }

    fn config_with(change: impl FnOnce(&mut serde_json::Value)) -> Config {
        let config = Config { around: tempfile::tempdir().expect("tempdir") };
        let mut conf: serde_json::Value = serde_json::from_str(&fs::read_to_string(fixture().join("BambuStudio.conf")).expect("conf")).expect("json");
        change(&mut conf);
        let made = "user/1234567890/filament";
        fs::create_dir_all(config.path().join(made)).expect("mkdir");
        fs::write(config.path().join("BambuStudio.conf"), conf.to_string()).expect("write conf");
        for entry in fs::read_dir(fixture().join(made)).expect("presets") {
            let entry = entry.expect("entry");
            fs::copy(entry.path(), config.path().join(made).join(entry.file_name())).expect("copy");
        }
        config
    }

    #[test]
    fn reads_the_printer_presets_and_plate_of_a_real_config() {
        assert_eq!(
            read(&fixture()).expect("reads"),
            Some(LastUsed {
                printer: "Bambu Lab P2S".to_owned(),
                nozzle: "0.4".to_owned(),
                machine: system("Bambu Lab P2S 0.4 nozzle"),
                process: Some(system("0.20mm Standard @BBL P2S")),
                filament: Some(system("Bambu PETG Basic @BBL P2S 0.4 nozzle")),
                plate: Some(Plate::TexturedPei),
            })
        );
    }

    #[test]
    fn a_preset_the_person_made_names_the_bambu_preset_it_was_made_from() {
        let made = "Bambu PLA Basic @BBL P2S - SuperTack 45C";
        let dir = config_with(|conf| {
            conf["presets"]["filaments"] = serde_json::json!([made, "Bambu PETG Basic @BBL P2S 0.4 nozzle"]);
            conf["app"]["curr_bed_type"] = "5".into();
        });
        let last = read(&dir.path()).expect("reads").expect("a printer");
        assert_eq!(last.filament, Some(Preset { name: made.to_owned(), system: Some("Bambu PLA Basic @BBL P2S".to_owned()) }));
        assert_eq!(last.plate, Some(Plate::Supertack));
    }

    #[cfg(unix)]
    #[test]
    fn a_preset_file_that_leads_out_of_the_config_folder_is_refused() {
        let outside = tempfile::tempdir().expect("outside");
        fs::write(outside.path().join("secret.json"), r#"{ "inherits": "Bambu PLA Basic @BBL P2S" }"#).expect("write");
        let dir = config_with(|conf| conf["presets"]["filaments"] = serde_json::json!(["Linked"]));
        std::os::unix::fs::symlink(outside.path().join("secret.json"), dir.path().join("user/1234567890/filament/Linked.json")).expect("link");
        let err = read(&dir.path()).expect_err("a link out of the folder");
        assert!(err.to_string().contains("leads outside Bambu Studio's config folder"), "{err}");

        let climbing = config_with(|conf| conf["presets"]["filaments"] = serde_json::json!(["../../../../outside"]));
        fs::write(climbing.around.path().join("outside.json"), "{}").expect("write");
        let err = read(&climbing.path()).expect_err("a name that climbs out of the folder");
        assert!(err.to_string().contains("leads outside Bambu Studio's config folder"), "{err}");
    }

    #[test]
    fn nothing_when_bambu_studio_never_ran_or_has_no_bambu_lab_printer() {
        let empty = tempfile::tempdir().expect("tempdir");
        assert_eq!(read(empty.path()).expect("no config"), None);
        let unset = config_with(|conf| conf["presets"] = serde_json::json!({}));
        assert_eq!(read(&unset.path()).expect("no printer"), None);
        let other = config_with(|conf| conf["presets"]["machine"] = "Default Printer".into());
        assert_eq!(read(&other.path()).expect("another printer"), None);
    }

    #[test]
    fn what_bambu_studio_did_not_record_is_missing_and_a_broken_config_fails() {
        let bare = config_with(|conf| {
            conf["presets"] = serde_json::json!({ "machine": "Bambu Lab A1 mini 0.2 nozzle", "process": "", "filaments": [] });
            conf["app"] = serde_json::json!({ "curr_bed_type": "0" });
        });
        assert_eq!(
            read(&bare.path()).expect("reads"),
            Some(LastUsed {
                printer: "Bambu Lab A1 mini".to_owned(),
                nozzle: "0.2".to_owned(),
                machine: system("Bambu Lab A1 mini 0.2 nozzle"),
                process: None,
                filament: None,
                plate: None,
            })
        );

        let broken = tempfile::tempdir().expect("tempdir");
        fs::write(broken.path().join("BambuStudio.conf"), "{ \"presets\": ").expect("write");
        let err = read(broken.path()).expect_err("half a config");
        assert!(err.to_string().contains("BambuStudio.conf: invalid JSON"), "{err}");

        let odd = config_with(|conf| conf["presets"]["filaments"] = serde_json::json!(["Odd"]));
        for not_a_preset in [r#"{ "inherits": 42 }"#, r#"{ "inherits": null }"#, r#"["Bambu PLA Basic @BBL P2S"]"#] {
            fs::write(odd.path().join("user/1234567890/filament/Odd.json"), not_a_preset).expect("write");
            let err = read(&odd.path()).expect_err("a preset file that is not a preset");
            assert!(err.to_string().contains("Odd.json"), "{not_a_preset}: {err}");
        }
    }
}
