//! The generation guest's body manifest: names and filament slots from the model's script, bounded here and
//! checked against the palette by the app (PR 7).

use serde::{Deserialize, Serialize};

pub const MAX_BODIES: usize = 16;
pub const MAX_NAME_CHARS: usize = 64;
pub const MAX_SLOT: u8 = 16;

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BodyManifest {
    pub bodies: Vec<BodyEntry>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct BodyEntry {
    pub name: String,
    pub slot: u8,
}

#[derive(Debug, PartialEq, thiserror::Error)]
pub enum ManifestError {
    #[error("manifest is not valid JSON of the expected shape: {0}")]
    Shape(String),
    #[error("manifest lists {0} bodies; 1 to {MAX_BODIES} are allowed")]
    BodyCount(usize),
    #[error("body {0}: name must be 1 to {MAX_NAME_CHARS} printable characters")]
    Name(usize),
    #[error("body {0}: slot must be 1 to {MAX_SLOT}")]
    Slot(usize),
}

/// Parses the manifest bytes (already capped by the frame reader) and bounds every field.
pub fn parse_manifest(bytes: &[u8]) -> Result<BodyManifest, ManifestError> {
    let manifest: BodyManifest =
        serde_json::from_slice(bytes).map_err(|e| ManifestError::Shape(e.to_string()))?;
    if manifest.bodies.is_empty() || manifest.bodies.len() > MAX_BODIES {
        return Err(ManifestError::BodyCount(manifest.bodies.len()));
    }
    for (i, body) in manifest.bodies.iter().enumerate() {
        let chars = body.name.chars().count();
        if chars == 0 || chars > MAX_NAME_CHARS || body.name.chars().any(char::is_control) {
            return Err(ManifestError::Name(i));
        }
        if body.slot == 0 || body.slot > MAX_SLOT {
            return Err(ManifestError::Slot(i));
        }
    }
    Ok(manifest)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_well_formed_manifest_parses() {
        let m = parse_manifest(br#"{"bodies":[{"name":"clip","slot":1}]}"#).unwrap();
        assert_eq!(m.bodies[0].name, "clip");
    }

    #[test]
    fn bounds_and_shape_are_enforced() {
        assert_eq!(
            parse_manifest(br#"{"bodies":[]}"#).unwrap_err(),
            ManifestError::BodyCount(0)
        );
        assert_eq!(
            parse_manifest(br#"{"bodies":[{"name":"a","slot":0}]}"#).unwrap_err(),
            ManifestError::Slot(0)
        );
        assert_eq!(
            parse_manifest(br#"{"bodies":[{"name":"a","slot":17}]}"#).unwrap_err(),
            ManifestError::Slot(0)
        );
        assert_eq!(
            parse_manifest(br#"{"bodies":[{"name":"a\nb","slot":1}]}"#).unwrap_err(),
            ManifestError::Name(0)
        );
        let long = format!(r#"{{"bodies":[{{"name":"{}","slot":1}}]}}"#, "x".repeat(65));
        assert_eq!(
            parse_manifest(long.as_bytes()).unwrap_err(),
            ManifestError::Name(0)
        );
        assert!(matches!(
            parse_manifest(br#"{"bodies":[{"name":"a","slot":1,"path":"/x"}]}"#),
            Err(ManifestError::Shape(_))
        ));
        assert!(matches!(
            parse_manifest(br#"{"bodies":[{"name":"a","slot":300}]}"#),
            Err(ManifestError::Shape(_))
        ));
    }
}
