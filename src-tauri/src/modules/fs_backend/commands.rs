// modules/fs_backend/commands.rs — Tauri 命令层 (WorkspaceFs P2-3a)
//
// 统一文件系统入口: 前端 workspaceFsStore 只调 fsb_* 命令。
// session_id: Some → SftpFs (SSH 会话); None → LocalFs。
// 消除 FileExplorer 双轨 (useFileTree/useRemoteFileTree) 的根源——路径
// 语义由后端实现层保证, 前端不再有 local/ssh 分支。

use tauri::State;

use super::{FsBackend, FsBackendError, FsCapabilities, FsEntry, LocalFs, SftpFs};
use crate::modules::ssh::SshState;

async fn resolve_backend(
    session_id: Option<u32>,
    root: Option<String>,
    state: &State<'_, SshState>,
) -> Result<Box<dyn FsBackend>, String> {
    match session_id {
        Some(id) => {
            let sftp = state
                .get_or_create_sftp(id)
                .await
                .map_err(|e| format!("[fsb] sftp session error: {e}"))?;
            let root = root.unwrap_or_else(|| "/".to_string());
            Ok(Box::new(SftpFs::new(sftp, root)))
        }
        None => Ok(Box::new(LocalFs)),
    }
}

fn err_str(e: FsBackendError) -> String {
    e.to_string()
}

/// 列出目录
#[tauri::command]
pub async fn fsb_list(
    session_id: Option<u32>,
    root: Option<String>,
    path: String,
    state: State<'_, SshState>,
) -> Result<Vec<FsEntry>, String> {
    let backend = resolve_backend(session_id, root, &state).await?;
    backend.list(&path).await.map_err(err_str)
}

/// 读取文件
#[tauri::command]
pub async fn fsb_read(
    session_id: Option<u32>,
    root: Option<String>,
    path: String,
    state: State<'_, SshState>,
) -> Result<Vec<u8>, String> {
    let backend = resolve_backend(session_id, root, &state).await?;
    backend.read(&path).await.map_err(err_str)
}

/// 写入文件
#[tauri::command]
pub async fn fsb_write(
    session_id: Option<u32>,
    root: Option<String>,
    path: String,
    data: Vec<u8>,
    state: State<'_, SshState>,
) -> Result<(), String> {
    let backend = resolve_backend(session_id, root, &state).await?;
    backend.write(&path, &data).await.map_err(err_str)
}

/// 重命名/移动
#[tauri::command]
pub async fn fsb_rename(
    session_id: Option<u32>,
    root: Option<String>,
    from: String,
    to: String,
    state: State<'_, SshState>,
) -> Result<(), String> {
    let backend = resolve_backend(session_id, root, &state).await?;
    backend.rename(&from, &to).await.map_err(err_str)
}

/// 删除
#[tauri::command]
pub async fn fsb_delete(
    session_id: Option<u32>,
    root: Option<String>,
    path: String,
    state: State<'_, SshState>,
) -> Result<(), String> {
    let backend = resolve_backend(session_id, root, &state).await?;
    backend.delete(&path).await.map_err(err_str)
}

/// 创建目录
#[tauri::command]
pub async fn fsb_mkdir(
    session_id: Option<u32>,
    root: Option<String>,
    path: String,
    state: State<'_, SshState>,
) -> Result<(), String> {
    let backend = resolve_backend(session_id, root, &state).await?;
    backend.mkdir(&path).await.map_err(err_str)
}

/// 路径状态
#[tauri::command]
pub async fn fsb_stat(
    session_id: Option<u32>,
    root: Option<String>,
    path: String,
    state: State<'_, SshState>,
) -> Result<FsEntry, String> {
    let backend = resolve_backend(session_id, root, &state).await?;
    backend.stat(&path).await.map_err(err_str)
}

/// 能力集 (前端按此禁用不支持的操作)
#[tauri::command]
pub async fn fsb_capabilities(
    session_id: Option<u32>,
    state: State<'_, SshState>,
) -> Result<FsCapabilities, String> {
    let backend = resolve_backend(session_id, None, &state).await?;
    Ok(backend.capabilities())
}
