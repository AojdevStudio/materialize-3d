//! Port of the reference wrapper's `resolvePresets` (fusion-cad `bambu-cli.ts`): flatten a
//! system preset's `inherits` chain and ordered `include` templates into one JSON file that
//! Bambu Studio's CLI accepts via `--load-settings` / `--load-filaments`.

use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::rc::Rc;

use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

use super::{
    hex, io_err, parse_json_object, read_json_object, write_atomic, write_json_atomic, BambuError,
    BambuStudio, JsonMap, PresetSelection, Result,
};

/// Bump when resolution semantics or the compiled-defaults probe changes; it keys the cache.
pub const RESOLVER_SCHEMA_VERSION: u32 = 2;

/// Keys that describe a preset rather than configure the printer; they never count as
/// explicitly set, so an include cannot leak them into the including preset.
const PROFILE_METADATA_KEYS: &[&str] = &[
    "alias",
    "description",
    "filament_id",
    "from",
    "include",
    "inherits",
    "instantiation",
    "name",
    "renamed_from",
    "setting_id",
    "type",
];

/// Filament-level overrides that Bambu seeds from the printer-level key when the compiled
/// defaults omit them.
const FILAMENT_OVERRIDE_KEYS: &[&str] = &[
    "filament_retraction_length",
    "filament_z_hop",
    "filament_z_hop_types",
    "filament_retract_lift_above",
    "filament_retract_lift_below",
    "filament_retraction_speed",
    "filament_deretraction_speed",
    "filament_retract_restart_extra",
    "filament_retraction_minimum_travel",
    "filament_wipe_distance",
    "filament_retract_when_changing_layer",
    "filament_wipe",
    "filament_retract_before_wipe",
    "filament_long_retractions_when_cut",
    "filament_retraction_distances_when_cut",
];

const DEFAULT_PROBE_STL: &str = "solid fusion_cad_default_probe
  facet normal 0 0 -1
    outer loop
      vertex 0 0 0
      vertex 10 0 0
      vertex 0 10 0
    endloop
  endfacet
  facet normal 0 -1 1
    outer loop
      vertex 0 0 0
      vertex 0 0 10
      vertex 10 0 0
    endloop
  endfacet
  facet normal 1 1 1
    outer loop
      vertex 10 0 0
      vertex 0 0 10
      vertex 0 10 0
    endloop
  endfacet
  facet normal -1 0 1
    outer loop
      vertex 0 10 0
      vertex 0 0 10
      vertex 0 0 0
    endloop
  endfacet
endsolid fusion_cad_default_probe
";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum PresetKind {
    Machine,
    Process,
    Filament,
}

impl PresetKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Machine => "machine",
            Self::Process => "process",
            Self::Filament => "filament",
        }
    }

    fn list_key(self) -> &'static str {
        match self {
            Self::Machine => "machine_list",
            Self::Process => "process_list",
            Self::Filament => "filament_list",
        }
    }
}

/// One flattened preset written to the cache. Serializes (without `config`) to the same
/// shape as the wrapper's manifest entries.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPreset {
    pub name: String,
    pub path: PathBuf,
    pub source_path: PathBuf,
    #[serde(skip)]
    pub config: JsonMap,
}

/// Flattened machine, process, and per-slot filament presets. Serializes to the wrapper's
/// `manifest.json` shape.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResolvedPresets {
    pub app_version: String,
    pub cache_dir: PathBuf,
    pub filaments: Vec<ResolvedPreset>,
    pub machine: ResolvedPreset,
    pub process: ResolvedPreset,
    pub profile_manifest: PathBuf,
    pub profile_version: String,
    pub resolver_schema_version: u32,
}

/// Resolves the selection against the studio's profile tree, probing the studio for its
/// compiled defaults (cached per app and profile version).
pub fn resolve_presets(
    studio: &BambuStudio,
    selection: &PresetSelection,
    cache_root: &Path,
) -> Result<ResolvedPresets> {
    let resolver = Resolver::open(&studio.profiles_dir)?;
    let cache_dir = resolver.cache_dir(cache_root, studio.version.as_str())?;
    let defaults = probe_defaults(&studio.exe, &cache_dir)?;
    resolver.resolve_selection(studio.version.as_str(), defaults, selection, cache_dir)
}

/// Same as [`resolve_presets`] with the compiled defaults supplied by the caller (the
/// wrapper's `--defaults-file`), so no Bambu binary is needed.
pub fn resolve_presets_with_defaults(
    profiles_dir: &Path,
    app_version: &str,
    defaults: JsonMap,
    selection: &PresetSelection,
    cache_root: &Path,
) -> Result<ResolvedPresets> {
    let resolver = Resolver::open(profiles_dir)?;
    let cache_dir = resolver.cache_dir(cache_root, app_version)?;
    resolver.resolve_selection(app_version, defaults, selection, cache_dir)
}

type PresetKey = (PresetKind, String);

struct Resolved {
    config: JsonMap,
    explicit_keys: BTreeSet<String>,
    source_path: PathBuf,
}

struct Resolver {
    profiles_dir: PathBuf,
    manifest_path: PathBuf,
    profile_version: String,
    index: HashMap<PresetKey, String>,
    defaults: JsonMap,
    raw: HashMap<PresetKey, Rc<JsonMap>>,
    resolved: HashMap<PresetKey, Rc<Resolved>>,
}

fn preset_err(message: String) -> BambuError {
    BambuError::Preset(message)
}

fn required_str<'a>(value: Option<&'a Value>, context: &str) -> Result<&'a str> {
    match value {
        Some(Value::String(s)) if !s.is_empty() => Ok(s),
        _ => Err(preset_err(format!(
            "{context}: expected a non-empty string"
        ))),
    }
}

fn optional_str<'a>(value: Option<&'a Value>, context: &str) -> Result<Option<&'a str>> {
    value.map(|v| required_str(Some(v), context)).transpose()
}

fn string_list<'a>(value: Option<&'a Value>, context: &str) -> Result<Vec<&'a str>> {
    let err = || preset_err(format!("{context}: expected an array of strings"));
    let Some(Value::Array(items)) = value else {
        return Err(err());
    };
    items
        .iter()
        .map(|item| item.as_str().ok_or_else(err))
        .collect()
}

fn includes_list<'a>(value: Option<&'a Value>, context: &str) -> Result<Vec<&'a str>> {
    match value {
        None => Ok(Vec::new()),
        Some(Value::String(s)) => Ok(vec![s.as_str()]),
        other => string_list(other, context),
    }
}

/// Parses `^[+-]?(\d+(\.\d*)?|\.\d+)%?$` as a number, like the wrapper's `numericText`.
fn numeric_text(value: &str) -> Option<f64> {
    let body = value.strip_suffix('%').unwrap_or(value);
    let unsigned = body.strip_prefix(['+', '-']).unwrap_or(body);
    let (int, frac) = match unsigned.split_once('.') {
        Some((int, frac)) => (int, Some(frac)),
        None => (unsigned, None),
    };
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    let well_formed = digits(int)
        && frac.is_none_or(digits)
        && (!int.is_empty() || frac.is_some_and(|f| !f.is_empty()));
    if !well_formed {
        return None;
    }
    body.parse::<f64>().ok().filter(|n| n.is_finite())
}

/// True when the values differ only in how equal numbers are spelled ("0.5" vs "0.50"),
/// which the include-vs-default comparison cannot decide safely.
fn has_numeric_text_drift(left: &Value, right: &Value) -> bool {
    // (comparable, drift) for one pair of strings.
    let compare = |a: &str, b: &str| -> (bool, bool) {
        if a == b {
            return (true, false);
        }
        let comparable = matches!((numeric_text(a), numeric_text(b)), (Some(x), Some(y)) if x == y);
        (comparable, true)
    };
    match (left, right) {
        (Value::String(a), Value::String(b)) => compare(a, b) == (true, true),
        (Value::Array(a), Value::Array(b)) if a.len() == b.len() => {
            let mut drift = false;
            for (x, y) in a.iter().zip(b) {
                let (Some(x), Some(y)) = (x.as_str(), y.as_str()) else {
                    return false;
                };
                let (comparable, differs) = compare(x, y);
                if !comparable {
                    return false;
                }
                drift |= differs;
            }
            drift
        }
        _ => false,
    }
}

fn sanitize_segment(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for c in value.chars() {
        if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
            out.push(c);
        } else if !out.ends_with('-') {
            // Collapse each run of disallowed characters into a single dash.
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-');
    if trimmed.is_empty() {
        "unknown".to_owned()
    } else {
        trimmed.to_owned()
    }
}

fn preset_filename(name: &str) -> String {
    let hash = hex(&Sha256::digest(name.as_bytes()));
    let stem: String = sanitize_segment(name).chars().take(80).collect();
    format!("{stem}-{}.json", &hash[..10])
}

/// Lexical `path.resolve`: absolute, with `.` and `..` folded, symlinks untouched.
fn lexical_absolute(path: &Path) -> Result<PathBuf> {
    let absolute = std::path::absolute(path).map_err(io_err(path))?;
    let mut out = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            other => out.push(other),
        }
    }
    Ok(out)
}

impl Resolver {
    fn open(profiles_dir: &Path) -> Result<Self> {
        let root = lexical_absolute(profiles_dir)?;
        let mut sibling = root.clone().into_os_string();
        sibling.push(".json");
        let candidates = [root.join("BBL.json"), PathBuf::from(sibling)];
        let mut found = None;
        for candidate in &candidates {
            match fs::read_to_string(candidate) {
                Ok(text) => {
                    found = Some((candidate.clone(), text));
                    break;
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(io_err(candidate)(e)),
            }
        }
        let Some((manifest_path, text)) = found else {
            return Err(preset_err(format!(
                "profile manifest not found; checked {} and {}",
                candidates[0].display(),
                candidates[1].display()
            )));
        };
        let manifest = parse_json_object(&text, &manifest_path)?;
        let profile_version = required_str(manifest.get("version"), "BBL.json version")?.to_owned();
        let mut index = HashMap::new();
        for kind in [
            PresetKind::Machine,
            PresetKind::Process,
            PresetKind::Filament,
        ] {
            let list_key = kind.list_key();
            let Some(Value::Array(items)) = manifest.get(list_key) else {
                return Err(preset_err(format!(
                    "BBL.json {list_key}: expected an array"
                )));
            };
            for (position, item) in items.iter().enumerate() {
                let context = format!("BBL.json {list_key}[{position}]");
                let Value::Object(item) = item else {
                    return Err(preset_err(format!("{context}: expected an object")));
                };
                let name = required_str(item.get("name"), &format!("{context}.name"))?;
                let sub_path = required_str(item.get("sub_path"), &format!("{context}.sub_path"))?;
                if index
                    .insert((kind, name.to_owned()), sub_path.to_owned())
                    .is_some()
                {
                    return Err(preset_err(format!(
                        "BBL.json {list_key}: duplicate preset name {name:?}"
                    )));
                }
            }
        }
        Ok(Self {
            profiles_dir: root,
            manifest_path,
            profile_version,
            index,
            defaults: JsonMap::new(),
            raw: HashMap::new(),
            resolved: HashMap::new(),
        })
    }

    fn cache_dir(&self, cache_root: &Path, app_version: &str) -> Result<PathBuf> {
        Ok(lexical_absolute(cache_root)?.join(format!(
            "v{RESOLVER_SCHEMA_VERSION}-{}-{}",
            sanitize_segment(app_version),
            sanitize_segment(&self.profile_version)
        )))
    }

    fn source_path(&self, kind: PresetKind, name: &str) -> Result<PathBuf> {
        let sub_path = self.index.get(&(kind, name.to_owned())).ok_or_else(|| {
            preset_err(format!(
                "{} preset not found in BBL.json: {name:?}",
                kind.as_str()
            ))
        })?;
        let source = lexical_absolute(&self.profiles_dir.join(sub_path))?;
        if !source.starts_with(&self.profiles_dir) {
            return Err(preset_err(format!(
                "profile path escapes vendor root: {}",
                source.display()
            )));
        }
        Ok(source)
    }

    fn raw(&mut self, kind: PresetKind, name: &str) -> Result<Rc<JsonMap>> {
        let key = (kind, name.to_owned());
        if let Some(raw) = self.raw.get(&key) {
            return Ok(Rc::clone(raw));
        }
        let source = self.source_path(kind, name)?;
        let raw = read_json_object(&source)?;
        let shown = source.display();
        if let Some(declared) = optional_str(raw.get("name"), &format!("{shown} name"))? {
            if declared != name {
                return Err(preset_err(format!(
                    "{shown}: manifest name {name:?} does not match file name {declared:?}"
                )));
            }
        }
        if let Some(declared) = optional_str(raw.get("type"), &format!("{shown} type"))? {
            if declared != kind.as_str() {
                return Err(preset_err(format!(
                    "{shown}: expected type {}, got {declared}",
                    kind.as_str()
                )));
            }
        }
        let raw = Rc::new(raw);
        self.raw.insert(key, Rc::clone(&raw));
        Ok(raw)
    }

    fn resolve(
        &mut self,
        kind: PresetKind,
        name: &str,
        stack: &mut Vec<PresetKey>,
    ) -> Result<Rc<Resolved>> {
        let key = (kind, name.to_owned());
        if let Some(resolved) = self.resolved.get(&key) {
            return Ok(Rc::clone(resolved));
        }
        if stack.contains(&key) {
            let chain: Vec<String> = stack
                .iter()
                .chain([&key])
                .map(|(k, n)| format!("{}:{n}", k.as_str()))
                .collect();
            return Err(preset_err(format!("preset cycle: {}", chain.join(" -> "))));
        }
        let source_path = self.source_path(kind, name)?;
        let raw = self.raw(kind, name)?;

        stack.push(key.clone());
        let resolved = self.flatten(kind, name, &raw, stack);
        stack.pop();
        let (config, explicit_keys) = resolved?;

        let resolved = Rc::new(Resolved {
            config,
            explicit_keys,
            source_path,
        });
        self.resolved.insert(key, Rc::clone(&resolved));
        Ok(resolved)
    }

    /// Parent first, then includes in order (skipping values equal to the compiled default,
    /// which Bambu treats as unset), then the preset's own keys.
    fn flatten(
        &mut self,
        kind: PresetKind,
        name: &str,
        raw: &JsonMap,
        stack: &mut Vec<PresetKey>,
    ) -> Result<(JsonMap, BTreeSet<String>)> {
        let (mut config, mut explicit_keys) =
            match optional_str(raw.get("inherits"), &format!("{name} inherits"))? {
                Some(parent) => {
                    let parent = self.resolve(kind, parent, stack)?;
                    (parent.config.clone(), parent.explicit_keys.clone())
                }
                None => Default::default(),
            };

        for include_name in includes_list(raw.get("include"), &format!("{name} include"))? {
            let included = self.resolve(kind, include_name, stack)?;
            for include_key in &included.explicit_keys {
                let include_value = included.config.get(include_key);
                let default_value = self.defaults.get(include_key);
                if let (Some(value), Some(default)) = (include_value, default_value) {
                    if value != default && has_numeric_text_drift(value, default) {
                        return Err(preset_err(format!(
                            "include {include_name:?} key {include_key}: cannot safely compare numerically equal textual values {value} and {default}"
                        )));
                    }
                }
                if let Some(value) = include_value {
                    if default_value != Some(value) {
                        config.insert(include_key.clone(), value.clone());
                    }
                }
                explicit_keys.insert(include_key.clone());
            }
        }

        for (key, value) in raw {
            if key == "inherits" || key == "include" {
                continue;
            }
            config.insert(key.clone(), value.clone());
            if !PROFILE_METADATA_KEYS.contains(&key.as_str()) {
                explicit_keys.insert(key.clone());
            }
        }
        config.insert("name".into(), Value::from(name));
        config.insert("type".into(), Value::from(kind.as_str()));
        config.insert("from".into(), Value::from("system"));
        Ok((config, explicit_keys))
    }

    fn resolve_selection(
        mut self,
        app_version: &str,
        defaults: JsonMap,
        selection: &PresetSelection,
        cache_dir: PathBuf,
    ) -> Result<ResolvedPresets> {
        self.defaults = defaults;
        let machine_name = selection.machine.as_str();

        // Load and check every raw preset before resolving any, as the wrapper does, so a
        // missing or template-only selection fails before partial work.
        let machine_raw = self.raw(PresetKind::Machine, machine_name)?;
        let process_raw = self.raw(PresetKind::Process, &selection.process)?;
        let filament_raws = selection
            .filaments
            .iter()
            .map(|name| self.raw(PresetKind::Filament, name))
            .collect::<Result<Vec<_>>>()?;
        require_instantiated(&machine_raw, PresetKind::Machine, machine_name)?;
        require_instantiated(&process_raw, PresetKind::Process, &selection.process)?;
        for (raw, name) in filament_raws.iter().zip(&selection.filaments) {
            require_instantiated(raw, PresetKind::Filament, name)?;
        }

        let mut stack = Vec::new();
        let machine = self.resolve(PresetKind::Machine, machine_name, &mut stack)?;
        let process = self.resolve(PresetKind::Process, &selection.process, &mut stack)?;
        let filaments = selection
            .filaments
            .iter()
            .map(|name| self.resolve(PresetKind::Filament, name, &mut stack))
            .collect::<Result<Vec<_>>>()?;
        validate_machine(&machine.config, machine_name)?;
        require_compatible(
            &process.config,
            PresetKind::Process,
            &selection.process,
            machine_name,
        )?;
        for (filament, name) in filaments.iter().zip(&selection.filaments) {
            require_compatible(&filament.config, PresetKind::Filament, name, machine_name)?;
        }

        let machine = write_preset(&cache_dir, PresetKind::Machine, machine_name, &machine)?;
        let process = write_preset(
            &cache_dir,
            PresetKind::Process,
            &selection.process,
            &process,
        )?;
        let filaments = filaments
            .iter()
            .zip(&selection.filaments)
            .map(|(filament, name)| write_preset(&cache_dir, PresetKind::Filament, name, filament))
            .collect::<Result<Vec<_>>>()?;

        let presets = ResolvedPresets {
            app_version: app_version.to_owned(),
            cache_dir,
            filaments,
            machine,
            process,
            profile_manifest: self.manifest_path,
            profile_version: self.profile_version,
            resolver_schema_version: RESOLVER_SCHEMA_VERSION,
        };
        write_json_atomic(&presets.cache_dir.join("manifest.json"), &presets)?;
        Ok(presets)
    }
}

fn require_instantiated(raw: &JsonMap, kind: PresetKind, name: &str) -> Result<()> {
    if raw.get("instantiation").and_then(Value::as_str) == Some("true") {
        return Ok(());
    }
    Err(preset_err(format!(
        "{} preset {name:?} is not an instantiable system preset",
        kind.as_str()
    )))
}

fn require_compatible(config: &JsonMap, kind: PresetKind, name: &str, machine: &str) -> Result<()> {
    let context = format!("{} {name:?} compatible_printers", kind.as_str());
    if string_list(config.get("compatible_printers"), &context)?.contains(&machine) {
        return Ok(());
    }
    Err(preset_err(format!(
        "{} preset {name:?} is not compatible with machine {machine:?}",
        kind.as_str()
    )))
}

fn validate_machine(config: &JsonMap, name: &str) -> Result<()> {
    let variant = required_str(
        config.get("printer_variant"),
        &format!("{name} printer_variant"),
    )?;
    let nozzles = string_list(
        config.get("nozzle_diameter"),
        &format!("{name} nozzle_diameter"),
    )?;
    if !nozzles.contains(&variant) {
        return Err(preset_err(format!(
            "machine {name:?} printer_variant {variant} is absent from nozzle_diameter"
        )));
    }
    if !name.contains(&format!("{variant} nozzle")) {
        return Err(preset_err(format!(
            "machine {name:?} does not identify its {variant} nozzle variant"
        )));
    }
    string_list(
        config.get("printable_area"),
        &format!("{name} printable_area"),
    )?;
    required_str(
        config.get("printable_height"),
        &format!("{name} printable_height"),
    )?;
    required_str(
        config.get("machine_start_gcode"),
        &format!("{name} machine_start_gcode"),
    )?;
    Ok(())
}

fn write_preset(
    cache_dir: &Path,
    kind: PresetKind,
    name: &str,
    resolved: &Resolved,
) -> Result<ResolvedPreset> {
    let path = cache_dir.join(kind.as_str()).join(preset_filename(name));
    write_json_atomic(&path, &resolved.config)?;
    Ok(ResolvedPreset {
        name: name.to_owned(),
        path,
        source_path: resolved.source_path.clone(),
        config: resolved.config.clone(),
    })
}

/// Asks the studio for its compiled defaults by slicing a tiny probe with near-empty
/// presets and exporting the effective settings. Cached in `<cache_dir>/defaults-probe`.
fn probe_defaults(exe: &Path, cache_dir: &Path) -> Result<JsonMap> {
    let probe_dir = cache_dir.join("defaults-probe");
    let defaults_path = probe_dir.join("defaults.json");
    match fs::read_to_string(&defaults_path) {
        Ok(text) => return parse_json_object(&text, &defaults_path),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => return Err(io_err(&defaults_path)(e)),
    }

    let machine_path = probe_dir.join("machine.json");
    let process_path = probe_dir.join("process.json");
    let filament_path = probe_dir.join("filament.json");
    let model_path = probe_dir.join("probe.stl");
    let raw_defaults_path = probe_dir.join(format!(
        "defaults.{}-{}.json",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let compact_line = |value: Value| format!("{value}\n");
    write_atomic(
        &machine_path,
        compact_line(serde_json::json!({
            "type": "machine",
            "name": "fusion-cad default probe machine",
            "from": "system",
            "printer_technology": "FFF",
        }))
        .as_bytes(),
    )?;
    write_atomic(
        &process_path,
        compact_line(serde_json::json!({
            "type": "process",
            "name": "fusion-cad default probe process",
            "from": "system",
            "compatible_printers": ["fusion-cad default probe machine"],
        }))
        .as_bytes(),
    )?;
    write_atomic(
        &filament_path,
        compact_line(serde_json::json!({
            "type": "filament",
            "name": "fusion-cad default probe filament",
            "from": "system",
        }))
        .as_bytes(),
    )?;
    write_atomic(&model_path, DEFAULT_PROBE_STL.as_bytes())?;

    let mut load_settings = machine_path.into_os_string();
    load_settings.push(";");
    load_settings.push(&process_path);
    let probe = Command::new(exe)
        .arg(&model_path)
        .args(["--debug", "1", "--load-settings"])
        .arg(load_settings)
        .arg("--load-filaments")
        .arg(&filament_path)
        .arg("--export-settings")
        .arg(&raw_defaults_path)
        .arg("--outputdir")
        .arg(&probe_dir)
        // Bambu also writes result.json into its working directory.
        .current_dir(&probe_dir)
        .output()
        .map_err(io_err(exe))?;
    write_atomic(&probe_dir.join("bambu-stdout.log"), &probe.stdout)?;
    write_atomic(&probe_dir.join("bambu-stderr.log"), &probe.stderr)?;
    if !probe.status.success() {
        return Err(BambuError::ProbeFailed {
            exit_code: probe.status.code(),
            stderr: String::from_utf8_lossy(&probe.stderr).trim().to_owned(),
        });
    }

    let mut defaults = read_json_object(&raw_defaults_path)?;
    for key in FILAMENT_OVERRIDE_KEYS {
        if defaults.contains_key(*key) {
            continue;
        }
        let printer_key = &key["filament_".len()..];
        if let Some(value) = defaults.get(printer_key).cloned() {
            defaults.insert((*key).to_owned(), value);
        }
    }
    write_json_atomic(&defaults_path, &defaults)?;
    // The raw export is a scratch file; the normalized defaults.json above is the record.
    let _ = fs::remove_file(&raw_defaults_path);
    Ok(defaults)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn fixture_profiles() -> tempfile::TempDir {
        let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/bambu/profiles");
        let dir = tempfile::tempdir().expect("tempdir");
        copy_tree(&src, dir.path());
        dir
    }

    fn copy_tree(src: &Path, dst: &Path) {
        fs::create_dir_all(dst).expect("mkdir");
        for entry in fs::read_dir(src).expect("read fixture dir") {
            let entry = entry.expect("entry");
            let target = dst.join(entry.file_name());
            if entry.path().is_dir() {
                copy_tree(&entry.path(), &target);
            } else {
                fs::copy(entry.path(), target).expect("copy fixture");
            }
        }
    }

    fn write(dir: &Path, rel: &str, value: Value) {
        fs::write(
            dir.join(rel),
            serde_json::to_string_pretty(&value).expect("json"),
        )
        .expect("write");
    }

    fn selection() -> PresetSelection {
        PresetSelection {
            machine: "Test Printer 0.6 nozzle".into(),
            process: "Test Process".into(),
            filaments: vec!["Test Filament".into()],
        }
    }

    fn resolve(profiles: &Path) -> Result<ResolvedPresets> {
        let defaults = read_json_object(&profiles.join("defaults.json")).expect("defaults");
        resolve_presets_with_defaults(
            profiles,
            "9.8.7",
            defaults,
            &selection(),
            &profiles.join("cache"),
        )
    }

    fn read(path: &Path) -> Value {
        Value::Object(read_json_object(path).expect("cached preset"))
    }

    #[test]
    fn flattens_inheritance_and_ordered_includes_into_versioned_system_presets() {
        let profiles = fixture_profiles();
        let presets = resolve(profiles.path()).expect("resolves");

        assert!(presets.cache_dir.ends_with("v2-9.8.7-1.2.3"));
        let machine = read(&presets.machine.path);
        let expected = json!({
            "type": "machine",
            "name": "Test Printer 0.6 nozzle",
            "from": "system",
            "instantiation": "true",
            "printable_area": ["0x0", "256x0", "256x256", "0x256"],
            "printable_height": "256",
            "printer_model": "Test Printer",
            "printer_variant": "0.6",
            "machine_start_gcode": "START B\n\"quoted\"",
            "include_order": "B",
            "different_length_vector": ["1", "1", "1"],
            "equal_vector": ["parent"],
            "nozzle_diameter": ["0.6"],
            "retraction_length": ["1.4", "1.4", "1.4"],
            "suppressed_key": "parent",
        });
        assert_eq!(
            machine, expected,
            "machine preset is exactly the flattened chain"
        );

        let process = read(&presets.process.path);
        assert_eq!(process["layer_height"], "0.24");
        assert_eq!(
            process["compatible_printers"],
            json!(["Test Printer 0.6 nozzle"])
        );

        let filament = read(&presets.filaments[0].path);
        assert_eq!(filament["filament_id"], "GFTEST");
        assert_eq!(filament["filament_type"], json!(["PLA"]));
        assert_eq!(
            filament["filament_extruder_variant"],
            json!(["Direct Drive Standard", "Direct Drive High Flow"])
        );

        let manifest = read(&presets.cache_dir.join("manifest.json"));
        assert_eq!(manifest["machine"]["name"], "Test Printer 0.6 nozzle");
        assert_eq!(manifest["resolverSchemaVersion"], 2);
    }

    #[test]
    fn fails_loudly_when_a_selected_process_is_incompatible() {
        let profiles = fixture_profiles();
        write(
            profiles.path(),
            "process/leaf.json",
            json!({
                "type": "process", "name": "Test Process", "from": "system", "instantiation": "true",
                "inherits": "Base Process", "compatible_printers": ["Other Printer 0.6 nozzle"],
            }),
        );
        let err = resolve(profiles.path()).expect_err("incompatible");
        assert!(err.to_string().contains(
            r#"process preset "Test Process" is not compatible with machine "Test Printer 0.6 nozzle""#
        ), "{err}");
    }

    #[test]
    fn fails_loudly_when_an_include_cannot_be_resolved() {
        let profiles = fixture_profiles();
        write(
            profiles.path(),
            "machine/leaf.json",
            json!({
                "type": "machine", "name": "Test Printer 0.6 nozzle", "from": "system",
                "instantiation": "true", "inherits": "Base Machine", "include": ["Missing Template"],
                "printer_variant": "0.6", "nozzle_diameter": ["0.6"],
            }),
        );
        let err = resolve(profiles.path()).expect_err("missing include");
        assert!(
            err.to_string()
                .contains(r#"machine preset not found in BBL.json: "Missing Template""#),
            "{err}"
        );
    }

    #[test]
    fn fails_closed_on_numerically_equal_default_values_with_textual_drift() {
        let profiles = fixture_profiles();
        write(
            profiles.path(),
            "defaults.json",
            json!({ "numeric_drift": "0.5" }),
        );
        write(
            profiles.path(),
            "machine/start-a.json",
            json!({
                "name": "Start A", "instantiation": "false", "numeric_drift": "0.50",
            }),
        );
        let err = resolve(profiles.path()).expect_err("drift");
        assert!(
            err.to_string()
                .contains("cannot safely compare numerically equal textual values"),
            "{err}"
        );
    }

    #[test]
    fn rejects_a_template_preset_selection() {
        let profiles = fixture_profiles();
        let defaults = read_json_object(&profiles.path().join("defaults.json")).expect("defaults");
        let template = PresetSelection {
            process: "Base Process".into(),
            ..selection()
        };
        let err = resolve_presets_with_defaults(
            profiles.path(),
            "9.8.7",
            defaults,
            &template,
            &profiles.path().join("cache"),
        )
        .expect_err("template");
        assert!(
            err.to_string()
                .contains(r#"process preset "Base Process" is not an instantiable system preset"#),
            "{err}"
        );
    }

    #[test]
    fn numeric_text_matches_the_wrapper_grammar() {
        assert_eq!(numeric_text("0.50"), Some(0.5));
        assert_eq!(numeric_text("+.5%"), Some(0.5));
        assert_eq!(numeric_text("1."), Some(1.0));
        assert_eq!(numeric_text("."), None);
        assert_eq!(numeric_text("1e3"), None);
        assert_eq!(numeric_text("0x10"), None);
    }

    #[test]
    fn preset_filenames_match_the_wrapper() {
        // Values taken from the wrapper's resolved cache for the proven P2S run.
        assert_eq!(
            preset_filename("Bambu PLA Basic @BBL P2S"),
            "Bambu-PLA-Basic-BBL-P2S-97639ee51f.json"
        );
        assert_eq!(
            preset_filename("Bambu Lab P2S 0.4 nozzle"),
            "Bambu-Lab-P2S-0.4-nozzle-a89491af29.json"
        );
        assert_eq!(
            preset_filename("0.20mm Standard @BBL P2S"),
            "0.20mm-Standard-BBL-P2S-1b6fb71e59.json"
        );
    }
}
