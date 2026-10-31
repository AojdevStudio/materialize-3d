//! Low-level MQTT connection wrapper around rumqttc with TLS support.
//!
//! Two modes:
//! - **Printer**: connects to the printer's LAN address. Its certificate must chain to a Bambu
//!   printer root and name the printer's serial.
//! - **Cloud**: connects to `us.mqtt.bambulab.com:8883` with standard system CAs.

use std::sync::Arc;
use std::time::Duration;

use rumqttc::tokio_rustls::rustls::{
    self,
    client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier},
    client::verify_server_cert_signed_by_trust_anchor,
    crypto::{ring, verify_tls13_signature_with_raw_key, CryptoProvider, WebPkiSupportedAlgorithms},
    pki_types::{CertificateDer, ServerName, SubjectPublicKeyInfoDer, UnixTime},
    server::ParsedCertificate,
    CertificateError, ClientConfig, DigitallySignedStruct, PeerMisbehaved, RootCertStore,
    SignatureScheme,
};
use rumqttc::{AsyncClient, EventLoop, MqttOptions, QoS, Transport};
use x509_parser::{
    certificate::X509Certificate, oid_registry, prelude::FromDer, time::ASN1Time,
    x509::X509Version,
};

/// Bundled Bambu Lab CA certificate (PEM).
const BAMBU_CA_PEM: &[u8] = include_bytes!("../../certs/bambu-ca.pem");

/// Bambu's printer roots, copied verbatim from Bambu Studio's `resources/cert/printer.cer`: the
/// original `BBL CA` and the `BBL CA2` RSA and ECC roots that newer printers such as the P2S use.
const BAMBU_PRINTER_ROOTS_PEM: &[u8] = include_bytes!("../../certs/bambu-printer-roots.pem");

/// The broker an MQTT connection talks to, which decides how its certificate is verified.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Broker {
    Cloud,
    /// A printer on the LAN. Its certificate must name this serial as its common name.
    Printer { serial: String },
}

/// MQTT connection configuration.
#[derive(Debug, Clone)]
pub struct MqttConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: String,
    pub client_id: String,
    pub broker: Broker,
}

/// Verifies a printer's certificate chain against Bambu's printer roots, then checks that the leaf
/// names the expected serial. Printer certificates carry no hostname or IP address, and Bambu sets
/// the leaf's common name to the serial, so the serial replaces the usual hostname check.
///
/// Older printers present X.509 v1 leaves signed directly by `BBL CA`. webpki rejects every v1
/// certificate, so those leaves take a narrow path: signed directly by a bundled root with SHA-256
/// and inside their validity period.
#[derive(Debug)]
struct PrinterCertVerifier {
    roots: Vec<CertificateDer<'static>>,
    root_store: Arc<RootCertStore>,
    serial: String,
    algorithms: WebPkiSupportedAlgorithms,
}

impl PrinterCertVerifier {
    fn new(
        roots: Vec<CertificateDer<'static>>,
        serial: String,
        algorithms: WebPkiSupportedAlgorithms,
    ) -> Result<Self, String> {
        let mut root_store = RootCertStore::empty();
        for root in &roots {
            X509Certificate::from_der(root).map_err(|e| format!("failed to parse printer root: {e}"))?;
            root_store
                .add(root.clone())
                .map_err(|e| format!("failed to add printer root: {e}"))?;
        }
        Ok(Self { roots, root_store: Arc::new(root_store), serial, algorithms })
    }

    fn verify_v1_leaf(&self, leaf: &X509Certificate<'_>, now: UnixTime) -> Result<(), rustls::Error> {
        let algorithm = &leaf.signature_algorithm.algorithm;
        let sha256 = *algorithm == oid_registry::OID_PKCS1_SHA256WITHRSA
            || *algorithm == oid_registry::OID_SIG_ECDSA_WITH_SHA256;
        let signed_by_root = sha256
            && self
                .roots
                .iter()
                .filter_map(|root| X509Certificate::from_der(root).ok())
                .any(|(_, root)| {
                    root.subject() == leaf.issuer() && leaf.verify_signature(Some(root.public_key())).is_ok()
                });
        if !signed_by_root {
            return Err(CertificateError::UnknownIssuer.into());
        }

        let now = ASN1Time::from_timestamp(now.as_secs() as i64)
            .map_err(|e| rustls::Error::General(format!("clock out of range: {e}")))?;
        let validity = leaf.validity();
        if now < validity.not_before {
            return Err(CertificateError::NotValidYet.into());
        }
        if now > validity.not_after {
            return Err(CertificateError::Expired.into());
        }
        Ok(())
    }
}

fn parse_certificate<'a>(der: &'a CertificateDer<'_>) -> Result<X509Certificate<'a>, rustls::Error> {
    X509Certificate::from_der(der)
        .map(|(_, cert)| cert)
        .map_err(|_| CertificateError::BadEncoding.into())
}

/// The leaf's public key, which signs the handshake. Read from the SPKI rather than through
/// webpki's certificate parser so v1 leaves verify too.
fn leaf_public_key(cert: &CertificateDer<'_>) -> Result<SubjectPublicKeyInfoDer<'static>, rustls::Error> {
    Ok(SubjectPublicKeyInfoDer::from(parse_certificate(cert)?.public_key().raw.to_vec()))
}

impl ServerCertVerifier for PrinterCertVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        let leaf = parse_certificate(end_entity)?;
        if leaf.version() == X509Version::V1 {
            self.verify_v1_leaf(&leaf, now)?;
        } else {
            verify_server_cert_signed_by_trust_anchor(
                &ParsedCertificate::try_from(end_entity)?,
                &self.root_store,
                intermediates,
                now,
                self.algorithms.all,
            )?;
        }

        let mut common_names = leaf.subject().iter_common_name().map(|cn| cn.as_str());
        match (common_names.next(), common_names.next()) {
            (Some(Ok(cn)), None) if cn == self.serial => Ok(ServerCertVerified::assertion()),
            _ => Err(CertificateError::NotValidForName.into()),
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        let spki = leaf_public_key(cert)?;
        let key = webpki::RawPublicKeyEntity::try_from(&spki)
            .map_err(|_| rustls::Error::from(CertificateError::BadEncoding))?;
        let candidates = self
            .algorithms
            .mapping
            .iter()
            .find(|(scheme, _)| *scheme == dss.scheme)
            .map(|(_, algorithms)| *algorithms)
            .ok_or(PeerMisbehaved::SignedHandshakeWithUnadvertisedSigScheme)?;
        candidates
            .iter()
            .any(|algorithm| key.verify_signature(*algorithm, message, dss.signature()).is_ok())
            .then(HandshakeSignatureValid::assertion)
            .ok_or_else(|| CertificateError::BadSignature.into())
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        verify_tls13_signature_with_raw_key(message, &leaf_public_key(cert)?, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

/// Makes ring the process-wide rustls provider unless one is set. reqwest 0.13 enables aws-lc-rs
/// beside ring, so rustls cannot choose by itself, and rumqttc builds the cloud config with
/// `ClientConfig::builder()`, which needs that default.
fn ensure_crypto_provider() {
    if CryptoProvider::get_default().is_none() {
        // Fails only when another thread installed a provider first, which is also a usable default.
        let _ = ring::default_provider().install_default();
    }
}

fn bambu_printer_roots() -> Result<Vec<CertificateDer<'static>>, String> {
    rustls_pemfile::certs(&mut std::io::Cursor::new(BAMBU_PRINTER_ROOTS_PEM))
        .collect::<Result<_, _>>()
        .map_err(|e| format!("failed to parse Bambu printer roots: {e}"))
}

/// Build a rustls `ClientConfig` that only accepts the printer with this serial.
fn printer_tls_config(roots: Vec<CertificateDer<'static>>, serial: &str) -> Result<ClientConfig, String> {
    let provider = Arc::new(ring::default_provider());
    let verifier = PrinterCertVerifier::new(roots, serial.to_owned(), provider.signature_verification_algorithms)?;
    Ok(ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("failed to set printer TLS versions: {e}"))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(verifier))
        .with_no_client_auth())
}

/// Create an MQTT `(AsyncClient, EventLoop)` pair from the given config.
pub fn connect(config: &MqttConfig) -> Result<(AsyncClient, EventLoop), String> {
    let mut opts = MqttOptions::new(&config.client_id, &config.host, config.port);
    opts.set_keep_alive(Duration::from_secs(30));
    opts.set_credentials(&config.username, &config.password);

    match &config.broker {
        Broker::Printer { serial } => {
            let tls_config = printer_tls_config(bambu_printer_roots()?, serial)?;
            opts.set_transport(Transport::tls_with_config(tls_config.into()));
        }
        Broker::Cloud => {
            // Cloud broker: use Simple TLS which loads native system CAs
            ensure_crypto_provider();
            let ca_bytes = BAMBU_CA_PEM.to_vec();
            opts.set_transport(Transport::tls(ca_bytes, None, None));
        }
    }

    log::info!(
        "MQTT config: host={}, port={}, client_id={}, printer={}",
        config.host,
        config.port,
        config.client_id,
        matches!(config.broker, Broker::Printer { .. }),
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

    const SERIAL: &str = "01P00A000000000";

    #[test]
    fn connect_creates_client_and_eventloop() {
        let config = MqttConfig {
            host: "127.0.0.1".into(),
            port: 8883,
            username: "test".into(),
            password: "test".into(),
            client_id: "test-client".into(),
            broker: Broker::Printer { serial: SERIAL.into() },
        };
        let (client, _eventloop) = connect(&config).expect("connect should return client pair");
        // Client was created — we don't try to actually connect here
        drop(client);
    }

    #[tokio::test]
    async fn cloud_tls_setup_fails_the_handshake_instead_of_panicking() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let port = listener.local_addr().expect("local addr").port();
        tokio::spawn(async move { drop(listener.accept().await) });
        let config = MqttConfig {
            host: "127.0.0.1".into(),
            port,
            username: "test".into(),
            password: "test".into(),
            client_id: "test-cloud".into(),
            broker: Broker::Cloud,
        };
        let (_client, mut eventloop) = connect(&config).expect("client pair");
        let result = eventloop.poll().await;
        assert!(matches!(result, Err(rumqttc::ConnectionError::Tls(_))), "a closed connection fails the TLS handshake: {result:?}");
    }

    const TLS_VERSIONS: [&rustls::SupportedProtocolVersion; 2] = [&rustls::version::TLS12, &rustls::version::TLS13];

    /// Runs one TLS handshake between `client` and a local server that presents `chain` and signs
    /// with `key` over `version`.
    async fn handshake(
        client: ClientConfig,
        chain: Vec<CertificateDer<'static>>,
        key: &rcgen::KeyPair,
        version: &'static rustls::SupportedProtocolVersion,
    ) -> Result<(), rustls::Error> {
        use rumqttc::tokio_rustls::rustls::{
            pki_types::PrivateKeyDer,
            sign::{CertifiedKey, SingleCertAndKey},
            ServerConfig,
        };
        use rumqttc::tokio_rustls::{TlsAcceptor, TlsConnector};

        let provider = Arc::new(ring::default_provider());
        let key = PrivateKeyDer::try_from(key.serialize_der()).expect("server key");
        let key = provider.key_provider.load_private_key(key).expect("server signing key");
        // Serves the chain as given. `with_single_cert` would parse it with webpki, which refuses v1.
        let resolver = SingleCertAndKey::from(CertifiedKey::new(chain, key));
        let server = ServerConfig::builder_with_provider(provider)
            .with_protocol_versions(&[version])
            .expect("protocol version")
            .with_no_client_auth()
            .with_cert_resolver(Arc::new(resolver));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.expect("bind");
        let addr = listener.local_addr().expect("local addr");
        tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.expect("accept");
            drop(TlsAcceptor::from(Arc::new(server)).accept(tcp).await);
        });

        let tcp = tokio::net::TcpStream::connect(addr).await.expect("connect");
        let name = ServerName::IpAddress(addr.ip().into());
        TlsConnector::from(Arc::new(client)).connect(name, tcp).await.map(drop).map_err(|e| {
            *e.into_inner()
                .and_then(|inner| inner.downcast::<rustls::Error>().ok())
                .expect("the client handshake fails with a rustls error")
        })
    }

    /// A test certificate authority standing in for a Bambu root or device CA.
    struct TestCa {
        cert: CertificateDer<'static>,
        params: rcgen::CertificateParams,
        key: rcgen::KeyPair,
    }

    impl TestCa {
        fn new(name: &str, parent: Option<&TestCa>) -> Self {
            let key = rcgen::KeyPair::generate().expect("CA key");
            let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).expect("CA params");
            params.distinguished_name.push(rcgen::DnType::CommonName, name);
            params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
            params.key_usages = vec![rcgen::KeyUsagePurpose::KeyCertSign];
            let cert = match parent {
                Some(parent) => params.signed_by(&key, &parent.issuer()),
                None => params.self_signed(&key),
            }
            .expect("CA cert");
            Self { cert: cert.der().clone(), params, key }
        }

        fn issuer(&self) -> rcgen::Issuer<'_, &rcgen::KeyPair> {
            rcgen::Issuer::from_params(&self.params, &self.key)
        }

        fn printer_leaf(&self, params: rcgen::CertificateParams) -> (CertificateDer<'static>, rcgen::KeyPair) {
            let key = rcgen::KeyPair::generate().expect("leaf key");
            let cert = params.signed_by(&key, &self.issuer()).expect("leaf cert");
            (cert.der().clone(), key)
        }

        /// A leaf shaped like an older printer's: X.509 v1, no extensions, signed by this CA.
        fn printer_leaf_v1(&self, params: rcgen::CertificateParams) -> (CertificateDer<'static>, rcgen::KeyPair) {
            use rcgen::SigningKey;

            let (v3, key) = self.printer_leaf(params);
            let outer = der_children(&v3);
            let fields: Vec<u8> = der_children(outer[0])
                .into_iter()
                .filter(|field| field[0] != 0xA0 && field[0] != 0xA3)
                .flatten()
                .copied()
                .collect();
            let tbs = der(0x30, &fields);
            let mut signature = vec![0];
            signature.extend(self.key.sign(&tbs).expect("sign v1 TBS"));
            let cert = der(0x30, &[tbs, outer[1].to_vec(), der(0x03, &signature)].concat());
            (cert.into(), key)
        }
    }

    fn leaf_params(serial: &str) -> rcgen::CertificateParams {
        let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).expect("leaf params");
        params.distinguished_name.push(rcgen::DnType::CommonName, serial);
        params
    }

    fn der(tag: u8, body: &[u8]) -> Vec<u8> {
        let mut out = vec![tag];
        match body.len() {
            len @ 0..=0x7f => out.push(len as u8),
            len @ 0x80..=0xff => out.extend([0x81, len as u8]),
            len => out.extend([0x82, (len >> 8) as u8, len as u8]),
        }
        out.extend(body);
        out
    }

    /// The DER elements inside the SEQUENCE `der`.
    fn der_children(der: &[u8]) -> Vec<&[u8]> {
        fn header(der: &[u8]) -> (usize, usize) {
            match der[1] {
                len @ 0..=0x7f => (2, len as usize),
                long => {
                    let n = (long & 0x7f) as usize;
                    (2 + n, der[2..2 + n].iter().fold(0, |len, byte| len << 8 | *byte as usize))
                }
            }
        }
        let mut rest = &der[header(der).0..];
        let mut children = Vec::new();
        while !rest.is_empty() {
            let (head, len) = header(rest);
            children.push(&rest[..head + len]);
            rest = &rest[head + len..];
        }
        children
    }

    #[tokio::test]
    async fn printer_tls_rejects_a_self_signed_impostor() {
        let key = rcgen::KeyPair::generate().expect("key");
        let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).expect("params");
        params.distinguished_name.push(rcgen::DnType::CommonName, SERIAL);
        let cert = params.self_signed(&key).expect("self-signed cert");

        let config = printer_tls_config(bambu_printer_roots().expect("roots"), SERIAL).expect("printer TLS config");
        assert_eq!(
            handshake(config, vec![cert.der().clone()], &key, &rustls::version::TLS13).await,
            Err(CertificateError::UnknownIssuer.into()),
            "an impostor's self-signed certificate must fail the handshake",
        );
    }

    #[tokio::test]
    async fn printer_tls_rejects_another_printer_and_bad_v1_leaves() {
        let root = TestCa::new("Test Root", None);
        let config = || printer_tls_config(vec![root.cert.clone()], SERIAL).expect("printer TLS config");

        let (other_printer, key) = root.printer_leaf(leaf_params("01P00A000000001"));
        assert_eq!(
            handshake(config(), vec![other_printer], &key, &rustls::version::TLS13).await,
            Err(CertificateError::NotValidForName.into()),
            "a trusted certificate for a different serial is not this printer",
        );

        let (untrusted_v1, key) = TestCa::new("Rogue Root", None).printer_leaf_v1(leaf_params(SERIAL));
        assert_eq!(
            handshake(config(), vec![untrusted_v1], &key, &rustls::version::TLS13).await,
            Err(CertificateError::UnknownIssuer.into()),
            "a v1 leaf must be signed by a trusted root",
        );

        let mut expired = leaf_params(SERIAL);
        expired.not_before = rcgen::date_time_ymd(2020, 1, 1);
        expired.not_after = rcgen::date_time_ymd(2021, 1, 1);
        let (expired_v1, key) = root.printer_leaf_v1(expired);
        assert_eq!(
            handshake(config(), vec![expired_v1], &key, &rustls::version::TLS13).await,
            Err(CertificateError::Expired.into()),
            "a v1 leaf must be inside its validity period",
        );
    }

    #[tokio::test]
    async fn printer_tls_rejects_a_copied_certificate_without_the_printer_key() {
        let root = TestCa::new("Test Root", None);
        let config = || printer_tls_config(vec![root.cert.clone()], SERIAL).expect("printer TLS config");
        let (leaf, _) = root.printer_leaf(leaf_params(SERIAL));
        let (leaf_v1, _) = root.printer_leaf_v1(leaf_params(SERIAL));
        let impostor_key = rcgen::KeyPair::generate().expect("impostor key");

        for version in TLS_VERSIONS {
            for chain in [&leaf, &leaf_v1] {
                assert_eq!(
                    handshake(config(), vec![chain.clone()], &impostor_key, version).await,
                    Err(CertificateError::BadSignature.into()),
                    "{version:?}: the handshake must be signed by the key the certificate names",
                );
            }
        }
    }

    #[tokio::test]
    async fn printer_tls_accepts_the_printer_it_was_built_for() {
        let root = TestCa::new("Test Root", None);
        let device_ca = TestCa::new("Test Device CA", Some(&root));
        let config = || printer_tls_config(vec![root.cert.clone()], SERIAL).expect("printer TLS config");
        let (leaf, key) = device_ca.printer_leaf(leaf_params(SERIAL));
        let (leaf_v1, key_v1) = root.printer_leaf_v1(leaf_params(SERIAL));

        for version in TLS_VERSIONS {
            assert_eq!(
                handshake(config(), vec![leaf.clone(), device_ca.cert.clone()], &key, version).await,
                Ok(()),
                "{version:?}: a v3 leaf sent with its device CA, as the P2S does",
            );
            assert_eq!(
                handshake(config(), vec![leaf_v1.clone()], &key_v1, version).await,
                Ok(()),
                "{version:?}: a v1 leaf signed directly by a root, as older printers present",
            );
        }
    }
}
