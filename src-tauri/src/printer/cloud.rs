//! Bambu Cloud API client — device discovery and Cloud MQTT connection builder.
//!
//! Cloud MQTT connects to `us.mqtt.bambulab.com:8883` using standard TLS
//! with username `u_{user_id}` and the Cloud access token as password.

use serde::Deserialize;

use crate::printer::credentials::BambuCredentials;
use crate::printer::mqtt::MqttConfig;

/// Cloud MQTT broker host.
pub const CLOUD_MQTT_HOST: &str = "us.mqtt.bambulab.com";
/// Cloud MQTT broker port.
pub const CLOUD_MQTT_PORT: u16 = 8883;
/// Bambu Cloud API base URL.
#[allow(dead_code)]
const CLOUD_API_BASE: &str = "https://api.bambulab.com";

/// Typed Cloud API errors.
#[derive(Debug, thiserror::Error)]
#[allow(dead_code)]
pub enum CloudError {
    #[error("cloud API request failed: {0}")]
    Request(#[from] reqwest::Error),
    #[error("cloud access token expired or invalid (HTTP 401)")]
    Unauthorized,
    #[error("unexpected cloud API response (HTTP {0}): {1}")]
    Api(u16, String),
}

/// A device returned by the Cloud bind API.
#[derive(Debug, Clone, Deserialize)]
#[allow(dead_code)]
pub struct CloudDevice {
    pub dev_id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub dev_model_name: String,
    #[serde(default)]
    pub online: bool,
    #[serde(default)]
    pub dev_access_code: Option<String>,
}

/// Inner wrapper for the devices response.
#[derive(Debug, Deserialize)]
#[allow(dead_code)]
pub struct DevicesResponse {
    pub devices: Vec<CloudDevice>,
}

#[allow(dead_code)]
/// Discover bound devices from the Bambu Cloud API.
///
/// `GET /v1/iot-service/api/user/bind` with Bearer token.
pub async fn discover_devices(access_token: &str) -> Result<Vec<CloudDevice>, CloudError> {
    let url = format!("{CLOUD_API_BASE}/v1/iot-service/api/user/bind");

    let client = reqwest::Client::new();
    let resp = client
        .get(&url)
        .header("Authorization", format!("Bearer {access_token}"))
        .send()
        .await?;

    let status = resp.status().as_u16();
    if status == 401 {
        return Err(CloudError::Unauthorized);
    }
    if !resp.status().is_success() {
        let body = resp.text().await.unwrap_or_default();
        return Err(CloudError::Api(status, body));
    }

    let body = resp.json::<DevicesResponse>().await?;
    log::info!(
        "cloud discovery found {} device(s)",
        body.devices.len()
    );
    Ok(body.devices)
}

/// Build an `MqttConfig` for connecting to the Cloud MQTT broker.
pub fn cloud_mqtt_config(creds: &BambuCredentials) -> MqttConfig {
    MqttConfig {
        host: CLOUD_MQTT_HOST.to_string(),
        port: CLOUD_MQTT_PORT,
        username: creds.cloud_mqtt_username(),
        password: creds.access_token.clone(),
        client_id: format!("materialize-{}", creds.printer.device_id),
        use_bambu_ca: false, // Cloud uses standard CAs
    }
}

/// Build an `MqttConfig` for connecting directly to the local printer.
pub fn local_mqtt_config(creds: &BambuCredentials) -> MqttConfig {
    MqttConfig {
        host: creds.printer.host.clone(),
        port: 8883,
        username: creds.local_mqtt_username().to_string(),
        password: creds.local_mqtt_password().to_string(),
        client_id: format!("materialize-local-{}", creds.printer.device_id),
        use_bambu_ca: true, // Local printer uses self-signed Bambu CA
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mock_creds() -> BambuCredentials {
        serde_json::from_str(
            r#"{
                "accessToken": "test-token",
                "userId": "12345",
                "printer": {
                    "name": "TestPrinter",
                    "deviceId": "ABCD1234",
                    "model": "P2S",
                    "accessCode": "deadbeef",
                    "host": "192.0.2.136"
                }
            }"#,
        )
        .unwrap()
    }

    #[test]
    fn cloud_mqtt_config_uses_cloud_broker() {
        let creds = mock_creds();
        let cfg = cloud_mqtt_config(&creds);
        assert_eq!(cfg.host, "us.mqtt.bambulab.com");
        assert_eq!(cfg.port, 8883);
        assert_eq!(cfg.username, "u_12345");
        assert_eq!(cfg.password, "test-token");
        assert!(!cfg.use_bambu_ca);
    }

    #[test]
    fn local_mqtt_config_uses_printer_host() {
        let creds = mock_creds();
        let cfg = local_mqtt_config(&creds);
        assert_eq!(cfg.host, "192.0.2.136");
        assert_eq!(cfg.port, 8883);
        assert_eq!(cfg.username, "bblp");
        assert_eq!(cfg.password, "deadbeef");
        assert!(cfg.use_bambu_ca);
    }
}
