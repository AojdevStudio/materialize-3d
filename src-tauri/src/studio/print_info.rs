//! What a Bambu 3MF says about its print, read from the file's own metadata: the slice's time, grams, and filament
//! slots from `Metadata/slice_info.config`, and the printer, filament presets, and layer height from
//! `Metadata/project_settings.config`.

use std::fs::File;
use std::io::Read;
use std::path::Path;

use serde::{Deserialize, Serialize};

/// The print a 3MF holds, for the print files bar. A field the file does not hold stays empty.
#[derive(Debug, Default, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PrintInfo {
    /// The printer model without the maker's name, as in `P2S`.
    #[serde(skip_serializing_if = "Option::is_none")]
    printer: Option<String>,
    /// The filament presets the slice used, without the maker's name or the printer, as in `PETG Basic`.
    filaments: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    layer_height_mm: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    print_seconds: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    filament_grams: Option<f64>,
}

/// A number the file holds. `NaN` and `inf` parse as floats but are no measure, and JSON would carry them as `null`.
fn measure(text: &str) -> Option<f64> {
    text.parse::<f64>().ok().filter(|value| value.is_finite())
}

/// What `Metadata/slice_info.config` reports across every plate.
pub(super) struct SliceInfo {
    /// The objects Bambu did not skip.
    pub(super) parts: usize,
    pub(super) print_seconds: Option<u64>,
    pub(super) filament_grams: Option<f64>,
    /// The 1-based filament slots that some plate used filament from, in the order first seen.
    filament_slots: Vec<usize>,
}

/// Reads every plate's `<metadata key="prediction">`, every `<object>` Bambu did not skip, and each `<filament>`:
///
/// ```xml
/// <config><plate>
///   <metadata key="prediction" value="631"/>
///   <object identify_id="7" name="part.stl" skipped="false"/>
///   <filament id="1" type="PETG" used_m="1.29" used_g="3.85"/>
/// </plate></config>
/// ```
pub(super) fn parse_slice_info(xml: &str) -> Result<SliceInfo, String> {
    use quick_xml::events::Event;

    let mut info = SliceInfo { parts: 0, print_seconds: None, filament_grams: None, filament_slots: Vec::new() };
    let mut reader = quick_xml::Reader::from_str(xml);
    loop {
        match reader.read_event().map_err(|e| format!("slice_info.config: {e}"))? {
            Event::Empty(tag) | Event::Start(tag) => {
                let attr = |name: &[u8]| {
                    tag.attributes().flatten().find(|a| a.key.as_ref() == name).map(|a| String::from_utf8_lossy(&a.value).into_owned())
                };
                match tag.name().as_ref() {
                    b"metadata" if attr(b"key").as_deref() == Some("prediction") => {
                        if let Some(seconds) = attr(b"value").and_then(|v| v.parse::<u64>().ok()) {
                            *info.print_seconds.get_or_insert(0) += seconds;
                        }
                    }
                    b"object" if attr(b"skipped").as_deref() != Some("true") => info.parts += 1,
                    b"filament" => {
                        let Some(grams) = attr(b"used_g").as_deref().and_then(measure) else { continue };
                        *info.filament_grams.get_or_insert(0.0) += grams;
                        let slot = attr(b"id").and_then(|v| v.parse::<usize>().ok());
                        if let Some(slot) = slot.filter(|slot| grams > 0.0 && !info.filament_slots.contains(slot)) {
                            info.filament_slots.push(slot);
                        }
                    }
                    _ => {}
                }
            }
            Event::Eof => return Ok(info),
            _ => {}
        }
    }
}

/// Bambu writes each value as a string, or a list with one string per filament slot.
#[derive(Deserialize)]
struct ProjectSettings {
    printer_model: Option<String>,
    layer_height: Option<String>,
    #[serde(default)]
    filament_settings_id: Vec<String>,
}

fn entry(archive: &mut zip::ZipArchive<File>, name: &str) -> Option<String> {
    let mut text = String::new();
    archive.by_name(name).ok()?.read_to_string(&mut text).ok()?;
    Some(text)
}

/// What the 3MF at `path` says about its print. A file that is not a readable 3MF holds nothing the bar can show.
pub(super) fn read(path: &Path) -> PrintInfo {
    let Some(mut archive) = File::open(path).ok().and_then(|file| zip::ZipArchive::new(file).ok()) else {
        return PrintInfo::default();
    };
    let slice = entry(&mut archive, "Metadata/slice_info.config");
    let settings = entry(&mut archive, "Metadata/project_settings.config");
    parse(slice.as_deref(), settings.as_deref())
}

fn parse(slice_info: Option<&str>, project_settings: Option<&str>) -> PrintInfo {
    let slice = slice_info.and_then(|xml| parse_slice_info(xml).ok());
    let settings = project_settings.and_then(|json| serde_json::from_str::<ProjectSettings>(json).ok());
    let mut filaments: Vec<String> = Vec::new();
    if let (Some(slice), Some(settings)) = (&slice, &settings) {
        for preset in slice.filament_slots.iter().filter_map(|slot| settings.filament_settings_id.get(slot.checked_sub(1)?)) {
            let name = preset.split_once(" @").map_or(preset.as_str(), |(name, _)| name);
            let name = name.strip_prefix("Bambu ").unwrap_or(name);
            if !filaments.iter().any(|known| known == name) {
                filaments.push(name.to_owned());
            }
        }
    }
    PrintInfo {
        printer: settings.as_ref().and_then(|s| s.printer_model.as_deref()).map(|model| model.strip_prefix("Bambu Lab ").unwrap_or(model).to_owned()),
        filaments,
        layer_height_mm: settings.as_ref().and_then(|s| measure(s.layer_height.as_deref()?)),
        print_seconds: slice.as_ref().and_then(|s| s.print_seconds),
        filament_grams: slice.as_ref().and_then(|s| s.filament_grams),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_sliced_bambu_3mf_names_its_printer_filament_layer_height_time_and_grams() {
        let cube = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/bambu/cube-p2s-petg.3mf");
        assert_eq!(
            read(&cube),
            PrintInfo {
                printer: Some("P2S".to_owned()),
                filaments: vec!["PETG Basic".to_owned()],
                layer_height_mm: Some(0.2),
                print_seconds: Some(1710),
                filament_grams: Some(3.61),
            }
        );
    }

    #[test]
    fn a_3mf_without_the_settings_shows_nothing_for_them() {
        let dir = tempfile::tempdir().expect("tempdir");
        let bare = dir.path().join("bare.3mf");
        let mut zip = zip::ZipWriter::new(File::create(&bare).expect("3mf"));
        zip.start_file("3D/3dmodel.model", zip::write::SimpleFileOptions::default()).expect("entry");
        std::io::Write::write_all(&mut zip, b"<model/>").expect("write");
        zip.finish().expect("zip");
        assert_eq!(read(&bare), PrintInfo::default());

        let broken = dir.path().join("broken.3mf");
        std::fs::write(&broken, b"not a zip").expect("write");
        assert_eq!(read(&broken), PrintInfo::default());

        let unsliced = parse(None, Some(r#"{"printer_model": "Bambu Lab X1 Carbon", "filament_settings_id": ["Bambu PLA Basic @BBL X1C"]}"#));
        assert_eq!(unsliced, PrintInfo { printer: Some("X1 Carbon".to_owned()), ..PrintInfo::default() });

        let not_numbers = parse(Some(r#"<config><plate><filament id="1" used_g="NaN"/></plate></config>"#), Some(r#"{"layer_height": "inf"}"#));
        assert_eq!(not_numbers, PrintInfo::default());
    }

    #[test]
    fn slice_info_counts_the_parts_bambu_kept_and_sums_every_plate() {
        let xml = r#"<?xml version="1.0" encoding="UTF-8"?>
<config>
  <plate>
    <metadata key="prediction" value="631"/>
    <metadata key="weight" value="3.85"/>
    <object identify_id="7" name="a.stl" skipped="false"/>
    <object identify_id="8" name="b.stl" skipped="true"/>
    <filament id="1" type="PETG" used_m="1.29" used_g="3.85"/>
    <filament id="2" type="PETG" used_m="0.87" used_g="0.00"/>
  </plate>
  <plate>
    <metadata key="prediction" value="100"/>
    <object identify_id="9" name="c.stl" skipped="false"/>
    <filament id="3" type="PLA" used_m="0.50" used_g="1.15"/>
    <filament id="1" type="PETG" used_m="0.10" used_g="0.30"/>
  </plate>
</config>"#;
        let info = parse_slice_info(xml).expect("parses");
        assert_eq!((info.parts, info.print_seconds, info.filament_slots), (2, Some(731), vec![1, 3]));
        assert!((info.filament_grams.expect("grams") - 5.3).abs() < 0.001, "{:?}", info.filament_grams);
    }
}
