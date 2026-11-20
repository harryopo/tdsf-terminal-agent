use std::{
    collections::HashMap,
    sync::{Arc, Mutex as StdMutex},
    time::Duration,
};

use russh_sftp::{
    protocol::{FileAttributes, Handle, OpenFlags, Status, StatusCode, Version},
    server::Handler,
};
use tokio::io::duplex;

use super::{RawSftpSession, SftpSession};

#[derive(Default)]
struct ServerState {
    files: HashMap<String, Vec<u8>>,
    opens: Vec<(String, OpenFlags)>,
    closes: usize,
    fail_open: bool,
    fail_write: bool,
    fail_close: bool,
}

struct MemoryServer(Arc<StdMutex<ServerState>>);

impl Handler for MemoryServer {
    type Error = StatusCode;

    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }

    async fn init(
        &mut self,
        _version: u32,
        _extensions: HashMap<String, String>,
    ) -> Result<Version, Self::Error> {
        Ok(Version::new())
    }

    async fn open(
        &mut self,
        id: u32,
        filename: String,
        pflags: OpenFlags,
        _attrs: FileAttributes,
    ) -> Result<Handle, Self::Error> {
        let mut state = self.0.lock().unwrap();
        state.opens.push((filename.clone(), pflags));
        if state.fail_open {
            return Err(StatusCode::PermissionDenied);
        }
        if pflags.contains(OpenFlags::EXCLUDE) && state.files.contains_key(&filename) {
            return Err(StatusCode::Failure);
        }
        if pflags.contains(OpenFlags::CREATE) {
            state.files.entry(filename.clone()).or_default();
            if pflags.contains(OpenFlags::TRUNCATE) {
                state.files.get_mut(&filename).unwrap().clear();
            }
        } else if !state.files.contains_key(&filename) {
            return Err(StatusCode::NoSuchFile);
        }
        Ok(Handle {
            id,
            handle: filename,
        })
    }

    async fn write(
        &mut self,
        id: u32,
        handle: String,
        offset: u64,
        data: Vec<u8>,
    ) -> Result<Status, Self::Error> {
        let mut state = self.0.lock().unwrap();
        if state.fail_write {
            return Err(StatusCode::PermissionDenied);
        }
        let file = state.files.get_mut(&handle).ok_or(StatusCode::NoSuchFile)?;
        let offset = offset as usize;
        if file.len() < offset {
            file.resize(offset, 0);
        }
        let end = offset + data.len();
        if file.len() < end {
            file.resize(end, 0);
        }
        file[offset..end].copy_from_slice(&data);
        Ok(ok_status(id))
    }

    async fn close(&mut self, id: u32, _handle: String) -> Result<Status, Self::Error> {
        let mut state = self.0.lock().unwrap();
        state.closes += 1;
        if state.fail_close {
            return Err(StatusCode::PermissionDenied);
        }
        Ok(ok_status(id))
    }
}

fn ok_status(id: u32) -> Status {
    Status {
        id,
        status_code: StatusCode::Ok,
        error_message: "ok".into(),
        language_tag: "en".into(),
    }
}

async fn session(state: ServerState) -> (SftpSession, Arc<StdMutex<ServerState>>) {
    let state = Arc::new(StdMutex::new(state));
    let (client, server) = duplex(64 * 1024);
    russh_sftp::server::run(server, MemoryServer(state.clone())).await;
    let raw = tokio::time::timeout(Duration::from_secs(4), RawSftpSession::new(client))
        .await
        .expect("SFTP handshake timed out")
        .expect("SFTP handshake failed");
    (
        SftpSession {
            inner: Arc::new(tokio::sync::Mutex::new(Some(raw))),
            poisoned: std::sync::atomic::AtomicBool::new(false),
        },
        state,
    )
}

async fn write(session: &SftpSession, path: &str, content: &[u8]) -> Result<(), String> {
    tokio::time::timeout(Duration::from_secs(4), session.write_file(path, content))
        .await
        .expect("SFTP write timed out")
}

#[tokio::test]
async fn write_creates_missing_file_with_create_truncate_and_write_flags() {
    let (session, state) = session(ServerState::default()).await;

    write(&session, "/new.txt", b"created").await.unwrap();

    let state = state.lock().unwrap();
    assert_eq!(state.files.get("/new.txt").unwrap(), b"created");
    assert!(state.opens[0].1.contains(OpenFlags::CREATE));
    assert!(state.opens[0].1.contains(OpenFlags::TRUNCATE));
    assert!(state.opens[0].1.contains(OpenFlags::WRITE));
    assert_eq!(state.closes, 1, "successful write must await CLOSE");
}

#[tokio::test]
async fn write_truncates_existing_file_before_shorter_content() {
    let mut initial = ServerState::default();
    initial
        .files
        .insert("/existing.txt".into(), b"old trailing data".to_vec());
    let (session, state) = session(initial).await;

    write(&session, "/existing.txt", b"new").await.unwrap();

    assert_eq!(state.lock().unwrap().files["/existing.txt"], b"new");
}

#[tokio::test]
async fn empty_write_truncates_existing_file_to_empty() {
    let mut initial = ServerState::default();
    initial
        .files
        .insert("/empty.txt".into(), b"old contents".to_vec());
    let (session, state) = session(initial).await;

    write(&session, "/empty.txt", b"").await.unwrap();

    assert_eq!(state.lock().unwrap().files["/empty.txt"], b"");
}

#[tokio::test]
async fn rejected_close_is_not_reported_as_success() {
    let mut initial = ServerState {
        fail_close: true,
        ..ServerState::default()
    };
    initial.files.insert("/close-fails.txt".into(), Vec::new());
    let (session, state) = session(initial).await;

    let result = write(&session, "/close-fails.txt", b"data").await;

    assert!(result.is_err(), "CLOSE rejection must reach the caller");
    assert_eq!(state.lock().unwrap().closes, 1);
}

#[tokio::test]
async fn rejected_write_ack_is_not_reported_as_success() {
    let mut initial = ServerState {
        fail_write: true,
        ..ServerState::default()
    };
    initial.files.insert("/write-fails.txt".into(), Vec::new());
    let (session, state) = session(initial).await;

    let result = write(&session, "/write-fails.txt", b"data").await;

    assert!(
        result.is_err(),
        "WRITE rejection must be drained before success"
    );
    assert_eq!(state.lock().unwrap().files["/write-fails.txt"], b"");
}

#[tokio::test]
async fn permission_denied_open_does_not_poison_the_live_channel() {
    let initial = ServerState {
        fail_open: true,
        ..ServerState::default()
    };
    let (session, _) = session(initial).await;

    let result = write(&session, "/denied.txt", b"data").await;

    assert!(result.is_err());
    assert!(
        !session.is_poisoned(),
        "a server PermissionDenied response proves the channel is alive"
    );
}

#[tokio::test]
async fn create_file_creates_missing_file_exclusively_without_truncate_flag() {
    let (session, state) = session(ServerState::default()).await;

    tokio::time::timeout(
        Duration::from_secs(4),
        session.create_file("/exclusive-new.txt", b"new bytes"),
    )
    .await
    .expect("exclusive create timed out")
    .unwrap();

    let state = state.lock().unwrap();
    assert_eq!(state.files["/exclusive-new.txt"], b"new bytes");
    assert_eq!(state.opens.len(), 1);
    assert_eq!(
        state.opens[0].1.bits(),
        (OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE).bits()
    );
    assert!(!state.opens[0].1.contains(OpenFlags::TRUNCATE));
}

#[tokio::test]
async fn create_file_refuses_existing_path_without_changing_bytes() {
    let mut initial = ServerState::default();
    initial
        .files
        .insert("/already-exists.txt".into(), b"keep these bytes".to_vec());
    let (session, state) = session(initial).await;

    let result = tokio::time::timeout(
        Duration::from_secs(4),
        session.create_file("/already-exists.txt", b"replacement"),
    )
    .await
    .expect("exclusive create timed out");

    assert!(
        result.is_err(),
        "exclusive create must reject an existing path"
    );
    let state = state.lock().unwrap();
    assert_eq!(state.files["/already-exists.txt"], b"keep these bytes");
    assert_eq!(state.opens.len(), 1);
    assert_eq!(
        state.opens[0].1.bits(),
        (OpenFlags::CREATE | OpenFlags::EXCLUDE | OpenFlags::WRITE).bits()
    );
    assert!(!state.opens[0].1.contains(OpenFlags::TRUNCATE));
}
