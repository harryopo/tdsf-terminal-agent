// modules/fs_backend/sftp.rs — SSH SFTP 文件系统后端 (WorkspaceFs P2-2)

use std::sync::Arc;

use super::{FsBackend, FsBackendError, FsCapabilities, FsEntry, FsErrorCode, FsKind};
use crate::modules::ssh::sftp::SftpSession;
use crate::modules::workspace::WorkspaceEnv;

/// SFTP 后端: 封装现有 russh SFTP 会话, 路径语义强制 / 开头绝对路径
#[derive(Clone)]
pub struct SftpFs {
    session: Arc<SftpSession>,
    root: String,
}

impl SftpFs {
    pub fn new(session: Arc<SftpSession>, root: String) -> Self {
        Self { session, root }
    }
}

/// SFTP 路径校验: 必须是 / 开头绝对路径 (拒绝本地盘符/相对路径跨源泄漏)
fn validate_sftp_path(path: &str) -> Result<&str, FsBackendError> {
    if !path.starts_with('/') {
        return Err(FsBackendError::invalid_path(path));
    }
    Ok(path)
}

/// 错误字符串 → 统一错误码 (russh-sftp 错误为字符串)
fn map_err(path: &str, e: String) -> FsBackendError {
    let lower = e.to_lowercase();
    let code = if lower.contains("no such file") || lower.contains("not found") {
        FsErrorCode::NotFound
    } else if lower.contains("permission denied") {
        FsErrorCode::PermissionDenied
    } else if lower.contains("not empty") || lower.contains("directory not empty") {
        FsErrorCode::NotEmpty
    } else if lower.contains("closed") || lower.contains("not connected") {
        FsErrorCode::NotConnected
    } else {
        FsErrorCode::Io
    };
    FsBackendError {
        code,
        message: format!("{path}: {e}"),
    }
}

fn entry_from_sftp(e: &crate::modules::ssh::sftp::SftpEntry) -> FsEntry {
    FsEntry {
        name: e.name.clone(),
        path: e.path.clone(),
        is_dir: e.is_dir,
        size: e.size,
        mtime: if e.modified > 0 {
            (e.modified as u64).saturating_mul(1000)
        } else {
            0
        },
    }
}

#[async_trait::async_trait]
impl FsBackend for SftpFs {
    fn kind(&self) -> FsKind {
        FsKind::Sftp
    }

    fn capabilities(&self) -> FsCapabilities {
        FsCapabilities {
            rename: true,
            delete: true,
            mkdir: true,
            write: true,
            trash: false,
            symlink: false,
        }
    }

    fn resolve_root(&self, _env: &WorkspaceEnv) -> String {
        self.root.clone()
    }

    async fn list(&self, path: &str) -> Result<Vec<FsEntry>, FsBackendError> {
        let p = validate_sftp_path(path)?;
        let entries = self
            .session
            .list_dir(p)
            .await
            .map_err(|e| map_err(path, e))?;
        let mut out: Vec<FsEntry> = entries.iter().map(entry_from_sftp).collect();
        // 目录在前, 大小写不敏感排序 (与 LocalFs 对齐)
        out.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(out)
    }

    async fn read(&self, path: &str) -> Result<Vec<u8>, FsBackendError> {
        let p = validate_sftp_path(path)?;
        self.session
            .read_file(p)
            .await
            .map_err(|e| map_err(path, e))
    }

    async fn write(&self, path: &str, data: &[u8]) -> Result<(), FsBackendError> {
        let p = validate_sftp_path(path)?;
        self.session
            .write_file(p, data)
            .await
            .map_err(|e| map_err(path, e))
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), FsBackendError> {
        let src = validate_sftp_path(from)?;
        let dst = validate_sftp_path(to)?;
        self.session
            .rename(src, dst)
            .await
            .map_err(|e| map_err(from, e))
    }

    async fn delete(&self, path: &str) -> Result<(), FsBackendError> {
        let p = validate_sftp_path(path)?;
        // 先 stat 判定目录/文件, 再选 remove_dir/remove_file
        let attrs = self
            .session
            .stat(p)
            .await
            .map_err(|e| map_err(path, e))?;
        let is_dir = (attrs.permissions & 0o170000) == 0o040000;
        if is_dir {
            self.session
                .remove_dir(p)
                .await
                .map_err(|e| map_err(path, e))
        } else {
            self.session
                .remove_file(p)
                .await
                .map_err(|e| map_err(path, e))
        }
    }

    async fn mkdir(&self, path: &str) -> Result<(), FsBackendError> {
        let p = validate_sftp_path(path)?;
        self.session
            .mkdir(p)
            .await
            .map_err(|e| map_err(path, e))
    }

    async fn stat(&self, path: &str) -> Result<FsEntry, FsBackendError> {
        let p = validate_sftp_path(path)?;
        let attrs = self
            .session
            .stat(p)
            .await
            .map_err(|e| map_err(path, e))?;
        let name = p
            .rsplit('/')
            .find(|s| !s.is_empty())
            .unwrap_or(p)
            .to_string();
        Ok(FsEntry {
            name,
            path: p.to_string(),
            is_dir: (attrs.permissions & 0o170000) == 0o040000,
            size: attrs.size,
            mtime: if attrs.modified > 0 {
                (attrs.modified as u64).saturating_mul(1000)
            } else {
                0
            },
        })
    }
}
