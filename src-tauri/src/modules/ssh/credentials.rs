// TDSF 魔改: SSH 凭据持久化模块
// ============================================================================
// 实现"永久保存密钥 + 自动登录"功能。
//
// 设计:
//   - 非敏感元数据 (host/port/user/auth_kind/privateKeyPath/lastUsed/alias)
//     保存到 JSON 文件: <app_local_data_dir>/ssh-credentials.json
//   - 敏感字段 (password 或 passphrase) 通过 `secrets_*` 命令保存到
//     OS keyring (Windows Credential Manager / macOS Keychain / Linux 文件 0600)
//   - keyring service = "tdsf-ssh-credential", account = profile id
//
// 前端调用流程:
//   1. 用户在 SshConnectDialog 勾选"永久保存密钥" + 测试成功 → ssh_credentials_save
//   2. 启动时 SshExplorer 调用 ssh_credentials_list → 渲染已保存连接列表
//   3. 用户点击列表项 → ssh_credentials_get 取回完整凭据 → sshConnect 自动登录
//   4. 用户删除 → ssh_credentials_delete 同时清理 JSON + keyring

use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// 凭据认证方式 (与 SshAuthMethod 对齐, 但用 enum 字符串便于 JSON 序列化)
///
/// 注意: 不含敏感字段, 敏感字段通过 keyring 单独存储
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum CredentialAuthKind {
    Password,
    PublicKey {
        private_key_path: String,
        /// passphrase 是否设置 (实际值在 keyring)
        has_passphrase: bool,
    },
}

/// 单条已保存的 SSH 连接配置 (非敏感元数据)
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshCredentialProfile {
    /// 唯一 id (UUID 风格, 前端生成或 host:port:user 拼接)
    pub id: String,
    /// 别名 (用户可读, 默认 user@host:port)
    pub alias: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    /// 认证方式元数据 (不含敏感字段)
    pub auth: CredentialAuthKind,
    /// 上次使用时间戳 (Unix 毫秒)
    pub last_used: u64,
    /// 创建时间戳
    pub created_at: u64,
}

/// keyring service 名 (与前端 secrets_set 调用一致)
pub const KEYRING_SERVICE: &str = "tdsf-ssh-credential";

// ============================================================================
// 文件路径解析
// ============================================================================

/// 获取 ssh-credentials.json 文件路径
///
/// 路径: <app_local_data_dir>/ssh-credentials.json
/// Windows: C:\Users\<user>\AppData\Local\<bundle_identifier>\ssh-credentials.json
/// macOS:   ~/Library/Application Support/<bundle_identifier>/ssh-credentials.json
/// Linux:   ~/.local/share/<bundle_identifier>/ssh-credentials.json
fn credentials_file_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("ssh-credentials.json"))
}

/// 读取所有已保存的连接配置
fn read_all_profiles(app: &AppHandle) -> Result<Vec<SshCredentialProfile>, String> {
    let path = credentials_file_path(app)?;
    if !path.exists() {
        return Ok(Vec::new());
    }
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    serde_json::from_slice::<Vec<SshCredentialProfile>>(&bytes).map_err(|e| e.to_string())
}

/// 写入所有连接配置 (原子写: 先写 .tmp 再 rename)
fn write_all_profiles(
    app: &AppHandle,
    profiles: &[SshCredentialProfile],
) -> Result<(), String> {
    let path = credentials_file_path(app)?;
    let tmp = path.with_extension("json.tmp");
    let bytes = serde_json::to_vec_pretty(profiles).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, &bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(())
}

// ============================================================================
// Tauri 命令
// ============================================================================

/// 保存 (或更新) 一条 SSH 连接配置
///
/// 敏感字段 (password 或 passphrase) 通过 `secrets_set` 单独写入 keyring,
/// account = profile.id。前端调用此命令前应先调用 secrets_set 写入敏感字段。
#[tauri::command]
pub async fn ssh_credentials_save(
    app: AppHandle,
    profile: SshCredentialProfile,
) -> Result<(), String> {
    log::info!(
        "[ssh-credentials] save: id={} alias={} host={}:{} user={}",
        profile.id,
        profile.alias,
        profile.host,
        profile.port,
        profile.user
    );

    let mut profiles = read_all_profiles(&app)?;
    // upsert: 同 id 覆盖
    if let Some(idx) = profiles.iter().position(|p| p.id == profile.id) {
        profiles[idx] = profile;
    } else {
        profiles.push(profile);
    }
    write_all_profiles(&app, &profiles)
}

/// 列出所有已保存的 SSH 连接配置 (按 lastUsed 倒序, 最近使用的在前)
#[tauri::command]
pub async fn ssh_credentials_list(
    app: AppHandle,
) -> Result<Vec<SshCredentialProfile>, String> {
    let mut profiles = read_all_profiles(&app)?;
    // 按 last_used 倒序
    profiles.sort_by(|a, b| b.last_used.cmp(&a.last_used));
    Ok(profiles)
}

/// 删除一条 SSH 连接配置
///
/// 同时清理 JSON 文件中的元数据和 keyring 中的敏感字段。
/// keyring 删除失败不致命 (可能已经被用户在系统设置中删除), 仅记录警告。
#[tauri::command]
pub async fn ssh_credentials_delete(app: AppHandle, id: String) -> Result<(), String> {
    log::info!("[ssh-credentials] delete: id={}", id);

    let mut profiles = read_all_profiles(&app)?;
    let before = profiles.len();
    profiles.retain(|p| p.id != id);
    if profiles.len() == before {
        // 没找到, 不报错 (幂等删除)
        return Ok(());
    }
    write_all_profiles(&app, &profiles)?;

    // 清理 keyring (失败不致命)
    #[cfg(not(target_os = "linux"))]
    {
        if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, &id) {
            if let Err(e) = entry.delete_credential() {
                log::warn!("[ssh-credentials] keyring delete failed (non-fatal): {}", e);
            }
        }
    }
    // Linux: 由前端调用 secrets_delete 清理 (因为 Linux 走文件存储, 需要 SecretsState)

    Ok(())
}

/// 更新 lastUsed 时间戳 (用于"最近使用"排序)
#[tauri::command]
pub async fn ssh_credentials_touch(app: AppHandle, id: String) -> Result<(), String> {
    let mut profiles = read_all_profiles(&app)?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    if let Some(p) = profiles.iter_mut().find(|p| p.id == id) {
        p.last_used = now;
        write_all_profiles(&app, &profiles)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn credential_auth_kind_password_serialize() {
        let kind = CredentialAuthKind::Password;
        let json = serde_json::to_string(&kind).unwrap();
        assert!(json.contains(r#""type":"password""#));
    }

    #[test]
    fn credential_auth_kind_publickey_serialize() {
        let kind = CredentialAuthKind::PublicKey {
            private_key_path: "/home/user/.ssh/id_ed25519".to_string(),
            has_passphrase: false,
        };
        let json = serde_json::to_string(&kind).unwrap();
        assert!(json.contains(r#""type":"publickey""#));
        assert!(json.contains("privateKeyPath"));
    }

    #[test]
    fn profile_camel_case_serialization() {
        let now = 1700000000_000u64;
        let profile = SshCredentialProfile {
            id: "test-1".to_string(),
            alias: "测试".to_string(),
            host: "192.168.1.10".to_string(),
            port: 22,
            user: "root".to_string(),
            auth: CredentialAuthKind::Password,
            last_used: now,
            created_at: now,
        };
        let json = serde_json::to_string(&profile).unwrap();
        // camelCase 字段名
        assert!(json.contains("lastUsed"));
        assert!(json.contains("createdAt"));
        assert!(!json.contains("last_used"));
    }
}
