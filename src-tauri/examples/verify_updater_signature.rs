use std::{env, fs, path::PathBuf};

use anyhow::{bail, Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use minisign_verify::{PublicKey, Signature};

fn verify(data: &[u8], signature: &str, public_key: &str) -> Result<()> {
    let key_text = String::from_utf8(STANDARD.decode(public_key.trim())?)?;
    let signature_text = String::from_utf8(STANDARD.decode(signature.trim())?)?;
    PublicKey::decode(&key_text)?
        .verify(data, &Signature::decode(&signature_text)?, true)
        .context("Installer signature does not match the configured updater public key")?;
    Ok(())
}

fn main() -> Result<()> {
    let mut args = env::args_os().skip(1);
    let artifact = PathBuf::from(args.next().context("Expected installer path")?);
    if args.next().is_some() {
        bail!("Usage: verify_updater_signature <installer>");
    }
    let mut signature_path = artifact.as_os_str().to_os_string();
    signature_path.push(".sig");
    let signature = fs::read_to_string(signature_path).context("Read installer signature")?;
    let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json"))?;
    let public_key = config["plugins"]["updater"]["pubkey"]
        .as_str()
        .context("Updater public key is missing")?;
    verify(&fs::read(&artifact)?, &signature, public_key)?;
    println!("Verified installer against the configured updater public key");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    // Public test vector from https://docs.rs/minisign-verify/0.2.5/minisign_verify/
    fn fixture() -> (String, String) {
        let key = "untrusted comment: test public key\nRWQf6LRCGA9i53mlYecO4IzT51TGPpvWucNSCh1CBM0QTaLn73Y7GFO3\n";
        let signature = concat!(
            "untrusted comment: signature from minisign secret key\n",
            "RUQf6LRCGA9i559r3g7V1qNyJDApGip8MfqcadIgT9CuhV3EMhHoN1mGTkUidF/",
            "z7SrlQgXdy8ofjb7bNJJylDOocrCo8KLzZwo=\n",
            "trusted comment: timestamp:1633700835\tfile:test\tprehashed\n",
            "wLMDjy9FLAuxZ3q4NlEvkgtyhrr0gtTu6KC4KBJdITbbOeAi1zBIYo0v4iTgt8jJpIidRJnp94ABQkJAgAooBQ==\n",
        );
        (STANDARD.encode(key), STANDARD.encode(signature))
    }

    #[test]
    fn accepts_a_matching_signature() {
        let (key, signature) = fixture();
        verify(b"test", &format!("{signature}\n"), &key).unwrap();
    }

    #[test]
    fn rejects_modified_installer_bytes() {
        let (key, signature) = fixture();
        assert!(verify(b"tEst", &signature, &key).is_err());
    }

    #[test]
    fn rejects_a_different_public_key() {
        let (key, signature) = fixture();
        let text = String::from_utf8(STANDARD.decode(&key).unwrap()).unwrap();
        let mut raw = STANDARD.decode(text.lines().nth(1).unwrap()).unwrap();
        raw[10] ^= 1;
        let changed = STANDARD.encode(format!(
            "untrusted comment: other public key\n{}\n",
            STANDARD.encode(raw)
        ));
        assert!(verify(b"test", &signature, &changed).is_err());
    }

    #[test]
    fn rejects_missing_or_invalid_signature_data() {
        let (key, _) = fixture();
        assert!(verify(b"test", "", &key).is_err());
        assert!(verify(b"test", "invalid-base64!", &key).is_err());
    }
}
