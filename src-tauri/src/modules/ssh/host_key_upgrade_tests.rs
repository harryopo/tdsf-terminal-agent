use russh::client::Handler;
use russh::keys::{Algorithm, PrivateKey, PublicKeyOrCertificate};
use russh::keys::ssh_key::certificate;
use tempfile::TempDir;

use crate::modules::ssh::handler::SshClientHandler;
use crate::modules::ssh::known_hosts::KnownHostsManager;

const HOST: &str = "hosttest.example";
const PORT: u16 = 22;

fn handler_with_known_hosts(
    app_handle: tauri::AppHandle<tauri::test::MockRuntime>,
    known_hosts: KnownHostsManager,
) -> SshClientHandler<tauri::test::MockRuntime> {
    SshClientHandler {
        connection_id: uuid::Uuid::new_v4(),
        host: HOST.to_string(),
        port: PORT,
        app_handle,
        known_hosts,
    }
}

fn temp_known_hosts() -> (TempDir, KnownHostsManager) {
    let temp_dir = tempfile::tempdir().expect("create temporary known_hosts directory");
    let known_hosts = KnownHostsManager::with_path(temp_dir.path().join("known_hosts"));
    (temp_dir, known_hosts)
}

#[tokio::test]
async fn accepts_a_known_raw_ed25519_server_key() {
    let (_temp_dir, known_hosts) = temp_known_hosts();
    let private_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
        .expect("generate Ed25519 host key");
    let public_key = private_key.public_key();
    known_hosts
        .learn(HOST, PORT, public_key)
        .expect("learn raw host key");
    let server_key = PublicKeyOrCertificate::from(public_key.clone());
    let app = tauri::test::mock_app();
    let mut handler = handler_with_known_hosts(app.handle().clone(), known_hosts);

    assert!(handler.check_server_key(&server_key).await.unwrap());
}

#[tokio::test]
async fn rejects_a_host_certificate_even_when_its_raw_key_is_known() {
    let (_temp_dir, known_hosts) = temp_known_hosts();
    let host_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
        .expect("generate Ed25519 host key");
    let ca_key = PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519)
        .expect("generate Ed25519 CA key");
    let raw_public_key = host_key.public_key();
    known_hosts
        .learn(HOST, PORT, raw_public_key)
        .expect("learn raw host key");

    let mut builder = certificate::Builder::new_with_random_nonce(
        &mut rand::rng(),
        raw_public_key,
        0,
        u64::MAX,
    )
    .expect("create host certificate builder");
    builder
        .cert_type(certificate::CertType::Host)
        .expect("set host certificate type");
    builder
        .valid_principal(HOST)
        .expect("set host certificate principal");
    let certificate = builder.sign(&ca_key).expect("sign host certificate");
    let server_key = PublicKeyOrCertificate::from(certificate);

    let app = tauri::test::mock_app();
    let mut handler = handler_with_known_hosts(app.handle().clone(), known_hosts);

    let error = handler
        .check_server_key(&server_key)
        .await
        .expect_err("host certificates must not be downgraded to their raw key");
    assert!(error.to_string().contains("不支持主机证书"));
}
