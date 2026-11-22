use super::{FsBackend, LocalFs};

#[tokio::test]
async fn create_file_exclusively_creates_missing_path_with_exact_bytes() {
    let dir = tempfile::tempdir().expect("temporary directory");
    let path = dir.path().join("created.bin");
    let path = path.to_string_lossy().into_owned();
    let bytes = [0x00, 0x7f, 0x80, 0xff];

    LocalFs.create_file(&path, &bytes).await.unwrap();

    assert_eq!(tokio::fs::read(path).await.unwrap(), bytes);
}

#[tokio::test]
async fn create_file_rejects_existing_path_without_changing_bytes() {
    let dir = tempfile::tempdir().expect("temporary directory");
    let path = dir.path().join("existing.bin");
    tokio::fs::write(&path, b"original bytes")
        .await
        .expect("seed existing file");
    let path = path.to_string_lossy().into_owned();

    assert!(LocalFs.create_file(&path, b"replacement bytes").await.is_err());
    assert_eq!(tokio::fs::read(path).await.unwrap(), b"original bytes");
}
