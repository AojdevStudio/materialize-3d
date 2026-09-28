use std::path::PathBuf;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

// ─── Error types ──────────────────────────────────────────────────────────────

#[derive(Debug, thiserror::Error)]
pub enum CredentialError {
    #[error("credentials file not found: {0}")]
    NotFound(PathBuf),
    #[error("failed to read credentials: {0}")]
    Io(#[from] std::io::Error),
    #[error("invalid JSON in credentials: {0}")]
    Parse(#[from] serde_json::Error),
    #[error("access token has expired (expired at {0})")]
    Expired(String),
}

// ─── Credential types ─────────────────────────────────────────────────────────

/// Bambu Lab printer info from credentials file.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PrinterInfo {
    pub name: String,
    pub device_id: String,
    pub model: String,
    pub access_code: String,
    pub host: String,
}

/// Bambu Cloud credentials loaded from `~/.bambu-mcp/credentials.json`.
#[derive(Debug, Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BambuCredentials {
    pub access_token: String,
    pub user_id: String,
    #[serde(default)]
    pub user_name: Option<String>,
    pub printer: PrinterInfo,
    #[serde(default)]
    pub expires_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub created_at: Option<DateTime<Utc>>,
}

impl BambuCredentials {
    /// Load credentials from a specific file path.
    pub fn load_from_file(path: impl Into<PathBuf>) -> Result<Self, CredentialError> {
        let path = path.into();
        if !path.exists() {
            return Err(CredentialError::NotFound(path));
        }
        let contents = std::fs::read_to_string(&path)?;
        let creds: Self = serde_json::from_str(&contents)?;

        // Check expiry if present
        if let Some(expires_at) = creds.expires_at {
            if expires_at < Utc::now() {
                return Err(CredentialError::Expired(expires_at.to_rfc3339()));
            }
        }

        // Redaction-safe logging: never log the token itself
        log::info!(
            "loaded Bambu credentials for printer {} ({})",
            creds.printer.name,
            creds.printer.device_id
        );

        Ok(creds)
    }

    /// Load from the default location: `~/.bambu-mcp/credentials.json`.
    pub fn load_default() -> Result<Self, CredentialError> {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("."));
        let path = home.join(".bambu-mcp").join("credentials.json");
        Self::load_from_file(path)
    }

    /// MQTT username for local printer connection.
    pub fn local_mqtt_username(&self) -> &str {
        "bblp"
    }

    /// MQTT password for local printer connection (the LAN access code).
    pub fn local_mqtt_password(&self) -> &str {
        &self.printer.access_code
    }

    /// FTPS password for printer file upload (same as LAN access code).
    pub fn ftps_password(&self) -> &str {
        &self.printer.access_code
    }

    /// MQTT username for Cloud connection: `u_{user_id}`.
    pub fn cloud_mqtt_username(&self) -> String {
        format!("u_{}", self.user_id)
    }

    /// MQTT topic for subscribing to printer reports.
    pub fn report_topic(&self) -> String {
        format!("device/{}/report", self.printer.device_id)
    }

    /// MQTT topic for publishing commands to the printer.
    pub fn request_topic(&self) -> String {
        format!("device/{}/request", self.printer.device_id)
    }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    fn sample_creds_json() -> String {
        serde_json::json!({
            "accessToken": "test-token-abc123",
            "userId": "12345",
            "userName": "testuser",
            "expiresAt": "2030-01-01T00:00:00.000Z",
            "createdAt": "2025-01-01T00:00:00.000Z",
            "printer": {
                "name": "TestPrinter",
                "deviceId": "ABCD1234",
                "model": "P2S",
                "accessCode": "deadbeef",
                "host": "192.168.1.100"
            }
        })
        .to_string()
    }

    #[test]
    fn load_valid_credentials() {
        let mut file = NamedTempFile::new().unwrap();
        write!(file, "{}", sample_creds_json()).unwrap();

        let creds =
            BambuCredentials::load_from_file(file.path()).expect("should load valid creds");
        assert_eq!(creds.user_id, "12345");
        assert_eq!(creds.printer.device_id, "ABCD1234");
        assert_eq!(creds.printer.access_code, "deadbeef");
        assert_eq!(creds.printer.host, "192.168.1.100");
    }

    #[test]
    fn load_missing_file() {
        let result = BambuCredentials::load_from_file("/tmp/nonexistent-bambu-creds.json");
        assert!(matches!(result, Err(CredentialError::NotFound(_))));
    }

    #[test]
    fn load_invalid_json() {
        let mut file = NamedTempFile::new().unwrap();
        write!(file, "not json").unwrap();

        let result = BambuCredentials::load_from_file(file.path());
        assert!(matches!(result, Err(CredentialError::Parse(_))));
    }

    #[test]
    fn load_expired_token() {
        let json = serde_json::json!({
            "accessToken": "expired-token",
            "userId": "12345",
            "expiresAt": "2020-01-01T00:00:00.000Z",
            "printer": {
                "name": "TestPrinter",
                "deviceId": "ABCD1234",
                "model": "P2S",
                "accessCode": "deadbeef",
                "host": "192.168.1.100"
            }
        })
        .to_string();

        let mut file = NamedTempFile::new().unwrap();
        write!(file, "{}", json).unwrap();

        let result = BambuCredentials::load_from_file(file.path());
        assert!(matches!(result, Err(CredentialError::Expired(_))));
    }

    #[test]
    fn mqtt_topic_generation() {
        let mut file = NamedTempFile::new().unwrap();
        write!(file, "{}", sample_creds_json()).unwrap();
        let creds = BambuCredentials::load_from_file(file.path()).unwrap();

        assert_eq!(creds.report_topic(), "device/ABCD1234/report");
        assert_eq!(creds.request_topic(), "device/ABCD1234/request");
        assert_eq!(creds.local_mqtt_username(), "bblp");
        assert_eq!(creds.local_mqtt_password(), "deadbeef");
        assert_eq!(creds.ftps_password(), "deadbeef");
        assert_eq!(creds.ftps_password(), creds.local_mqtt_password());
        assert_eq!(creds.cloud_mqtt_username(), "u_12345");
    }
}
