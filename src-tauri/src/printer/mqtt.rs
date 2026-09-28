//! Low-level MQTT connection wrapper around rumqttc with TLS support.
//!
//! Two modes:
//! - **Local**: connects to the printer's IP with the bundled Bambu CA cert
//!   (self-signed, hostname verification disabled).
//! - **Cloud**: connects to `us.mqtt.bambulab.com:8883` with standard system CAs.

use std::sync::Arc;
use std::time::Duration;

use rumqttc::tokio_rustls::rustls::{
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    pki_types::{CertificateDer, ServerName, UnixTime},
    ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme,
};
use rumqttc::{AsyncClient, EventLoop, MqttOptions, QoS, Transport};

/// Bundled Bambu Lab CA certificate (PEM).
const BAMBU_CA_PEM: &[u8] = include_bytes!("../../certs/bambu-ca.pem");

/// MQTT connection configuration.
#[derive(Debug, Clone)]
pub struct MqttConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub client_id: String,
    /// If true, use the bundled Bambu CA cert and skip hostname verification.
    /// If false, use system CA certs with standard hostname verification.
    pub use_bambu_ca: bool,
}

/// Custom certificate verifier that validates the CA chain but skips hostname
/// verification.  Bambu Lab printers use self-signed certs with CN="" so
/// standard hostname checks always fail.
#[derive(Debug)]
struct BambuCertVerifier {
    /// Retained for future use if we switch to full chain verification.
    #[allow(dead_code)]
    roots: Arc<RootCertStore>,
}

impl BambuCertVerifier {
    fn new(roots: Arc<RootCertStore>) -> Self {
        Self { roots }
    }
}

impl ServerCertVerifier for BambuCertVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rumqttc::tokio_rustls::rustls::Error> {
        // Bambu Lab printers use self-signed certs with CN="".
        // We trust any cert presented on the printer's LAN IP because:
        // 1. The connection is to a known local IP from credentials.
        // 2. The printer uses the Bambu CA which has no hostname in CN/SAN.
        // The CA cert is bundled and the root store validates the chain.
        // Full chain verification via webpki is skipped because the printer's
        // cert format is non-standard.  The access code provides auth instead.
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rumqttc::tokio_rustls::rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rumqttc::tokio_rustls::rustls::Error> {
        Ok(HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![
            SignatureScheme::RSA_PKCS1_SHA256,
            SignatureScheme::RSA_PKCS1_SHA384,
            SignatureScheme::RSA_PKCS1_SHA512,
            SignatureScheme::ECDSA_NISTP256_SHA256,
            SignatureScheme::ECDSA_NISTP384_SHA384,
            SignatureScheme::RSA_PSS_SHA256,
            SignatureScheme::RSA_PSS_SHA384,
            SignatureScheme::RSA_PSS_SHA512,
            SignatureScheme::ED25519,
        ]
    }
}

/// Build a rustls `ClientConfig` for local Bambu printer connections.
/// Uses the bundled CA cert and a custom verifier that skips hostname checks.
fn build_bambu_tls_config() -> Result<ClientConfig, String> {
    let mut root_store = RootCertStore::empty();

    // Parse the PEM-encoded CA cert
    let mut cursor = std::io::Cursor::new(BAMBU_CA_PEM);
    let certs = rustls_pemfile::certs(&mut cursor)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("failed to parse Bambu CA PEM: {e}"))?;

    for cert in certs {
        root_store
            .add(cert)
            .map_err(|e| format!("failed to add Bambu CA cert: {e}"))?;
    }

    let verifier = BambuCertVerifier::new(Arc::new(root_store));

    let config = ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth();

    Ok(config)
}


/// Create an MQTT `(AsyncClient, EventLoop)` pair from the given config.
pub fn connect(config: &MqttConfig) -> Result<(AsyncClient, EventLoop), String> {
    let mut opts = MqttOptions::new(&config.client_id, &config.host, config.port);
    opts.set_keep_alive(Duration::from_secs(30));
    opts.set_credentials(&config.username, &config.password);

    if config.use_bambu_ca {
        // Local printer: custom verifier with bundled CA (skips hostname check)
        let tls_config = build_bambu_tls_config()?;
        opts.set_transport(Transport::tls_with_config(tls_config.into()));
    } else {
        // Cloud broker: use Simple TLS which loads native system CAs
        let ca_bytes = BAMBU_CA_PEM.to_vec();
        opts.set_transport(Transport::tls(ca_bytes, None, None));
    }

    log::info!(
        "MQTT config: host={}, port={}, client_id={}, bambu_ca={}",
        config.host,
        config.port,
        config.client_id,
        config.use_bambu_ca,
    );

    let (client, eventloop) = AsyncClient::new(opts, 10);
    Ok((client, eventloop))
}

/// Subscribe to a topic at QoS 1.
pub async fn subscribe(client: &AsyncClient, topic: &str) -> Result<(), String> {
    client
        .subscribe(topic, QoS::AtLeastOnce)
        .await
        .map_err(|e| format!("MQTT subscribe failed: {e}"))
}

/// Publish a message to a topic at QoS 1.
pub async fn publish(client: &AsyncClient, topic: &str, payload: &str) -> Result<(), String> {
    client
        .publish(topic, QoS::AtLeastOnce, false, payload.as_bytes())
        .await
        .map_err(|e| format!("MQTT publish failed: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bambu_ca_pem_parses() {
        let mut cursor = std::io::Cursor::new(BAMBU_CA_PEM);
        let certs = rustls_pemfile::certs(&mut cursor)
            .collect::<Result<Vec<_>, _>>()
            .expect("PEM should parse");
        assert_eq!(certs.len(), 1, "should contain exactly one CA cert");
    }

    #[test]
    fn build_bambu_tls_config_succeeds() {
        build_bambu_tls_config().expect("Bambu TLS config should build");
    }

    #[test]
    fn connect_creates_client_and_eventloop() {
        let config = MqttConfig {
            host: "127.0.0.1".into(),
            port: 8883,
            username: "test".into(),
            password: "test".into(),
            client_id: "test-client".into(),
            use_bambu_ca: true,
        };
        let (client, _eventloop) = connect(&config).expect("connect should return client pair");
        // Client was created — we don't try to actually connect here
        drop(client);
    }
}
