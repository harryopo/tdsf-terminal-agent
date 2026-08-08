// modules/fs_backend/local.rs — 本地文件系统后端 (WorkspaceFs P2-1)

use std::path::{Path, PathBuf};

use super::{FsBackend, FsBackendError, FsCapabilities, FsEntry, FsErrorCode, FsKind};
use crate::modules::workspace::WorkspaceEnv;

/// 本地后端: tokio::fs 异步实现, 路径语义 = Windows 盘符 / UNC
#[derive(Debug, Clone, Default)]
pub struct LocalFs;

/// 本地路径合法性: 必须是绝对路径 (盘符或 UNC)
fn validate_local_path(path: &str) -> Result<PathBuf, FsBackendError> {
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err(FsBackendError::invalid_path(path));
    }
    Ok(p)
}

fn entry_from_meta(name: &str, path: &Path, meta: &std::fs::Metadata) -> FsEntry {
    FsEntry {
        name: name.to_string(),
        path: path.to_string_lossy().into_owned(),
        is_dir: meta.is_dir(),
        size: meta.len(),
        mtime: meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0),
    }
}

#[async_trait::async_trait]
impl FsBackend for LocalFs {
    fn kind(&self) -> FsKind {
        FsKind::Local
    }

    fn capabilities(&self) -> FsCapabilities {
        FsCapabilities {
            rename: true,
            delete: true,
            mkdir: true,
            write: true,
            trash: false,
            symlink: true,
        }
    }

    fn resolve_root(&self, env: &WorkspaceEnv) -> String {
        // 本地后端只服务 Local/Wsl 环境 (SSH 由 SftpFs 处理, P2-2)
        let _ = env;
        std::env::current_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_else(|_| ".".to_string())
    }

    async fn list(&self, path: &str) -> Result<Vec<FsEntry>, FsBackendError> {
        let root = validate_local_path(path)?;
        let mut entries = Vec::new();
        let mut rd = tokio::fs::read_dir(&root).await?;
        while let Some(de) = rd.next_entry().await? {
            let name = de.file_name().to_string_lossy().into_owned();
            let full = de.path();
            let meta = de.metadata().await?;
            entries.push(entry_from_meta(&name, &full, &meta));
        }
        // 目录在前, 大小写不敏感排序 (与现有 fs_read_dir 行为对齐)
        entries.sort_by(|a, b| {
            b.is_dir
                .cmp(&a.is_dir)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });
        Ok(entries)
    }

    async fn read(&self, path: &str) -> Result<Vec<u8>, FsBackendError> {
        let p = validate_local_path(path)?;
        Ok(tokio::fs::read(&p).await?)
    }

    async fn write(&self, path: &str, data: &[u8]) -> Result<(), FsBackendError> {
        let p = validate_local_path(path)?;
        Ok(tokio::fs::write(&p, data).await?)
    }

    async fn rename(&self, from: &str, to: &str) -> Result<(), FsBackendError> {
        let src = validate_local_path(from)?;
        let dst = validate_local_path(to)?;
        Ok(tokio::fs::rename(&src, &dst).await?)
    }

    async fn delete(&self, path: &str) -> Result<(), FsBackendError> {
        let p = validate_local_path(path)?;
        let meta = tokio::fs::metadata(&p).await?;
        if meta.is_dir() {
            Ok(tokio::fs::remove_dir(&p).await?)
        } else {
            Ok(tokio::fs::remove_file(&p).await?)
        }
    }

    async fn mkdir(&self, path: &str) -> Result<(), FsBackendError> {
        let p = validate_local_path(path)?;
        Ok(tokio::fs::create_dir_all(&p).await?)
    }

    async fn stat(&self, path: &str) -> Result<FsEntry, FsBackendError> {
        let p = validate_local_path(path)?;
        let meta = tokio::fs::metadata(&p).await?;
        let name = p
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string());
        Ok(entry_from_meta(&name, &p, &meta))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn list_sorts_dirs_first_case_insensitive() {
        let tmp = std::env::temp_dir().join(format!("tdsf-fsback-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(tmp.join("Bdir")).unwrap();
        std::fs::create_dir_all(tmp.join("adir")).unwrap();
        std::fs::write(tmp.join("Zfile"), b"z").unwrap();
        std::fs::write(tmp.join("afile"), b"a").unwrap();

        let fs = LocalFs;
        let entries = fs.list(&tmp.to_string_lossy()).await.unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        // 目录在前 (adir < Bdir 大小写不敏感), 然后文件 (afile < Zfile)
        assert_eq!(names, vec!["adir", "Bdir", "afile", "Zfile"]);
        assert!(entries[0].is_dir);
        assert!(!entries[2].is_dir);

        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn rejects_relative_path() {
        let fs = LocalFs;
        let err = fs.list("relative/path").await.unwrap_err();
        assert_eq!(err.code, super::FsErrorCode::InvalidPath);
    }

    #[tokio::test]
    async fn roundtrip_write_read_rename_delete() {
        let tmp = std::env::temp_dir().join(format!("tdsf-fsback2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).unwrap();

        let fs = LocalFs;
        let file = tmp.join("a.txt").to_string_lossy().into_owned();
        fs.write(&file, b"hello").await.unwrap();
        assert_eq!(fs.read(&file).await.unwrap(), b"hello");

        let renamed = tmp.join("b.txt").to_string_lossy().into_owned();
        fs.rename(&file, &renamed).await.unwrap();
        assert!(fs.stat(&renamed).await.is_ok());

        fs.delete(&renamed).await.unwrap();
        assert_eq!(
            fs.stat(&renamed).await.unwrap_err().code,
            super::FsErrorCode::NotFound
        );

        let _ = std::fs::remove_dir_all(&tmp);
    }
}
