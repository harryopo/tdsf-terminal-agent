//! SFTP 文件传输 (T-P2-05)
//! ============================================================================
//! 基于 russh-sftp 2.x 实现 SFTP 协议,复用现有 SSH session 的 Handle 开 channel。
//!
//! ## 工作流程
//! 1. 前端调用 `sftp_list`/`sftp_read`/`sftp_write` 等命令,传入 session_id
//! 2. mod.rs 从 SshState 取出 SshSession,调用 `SshSession::open_sftp_channel()`
//! 3. SshSession::open_sftp_channel() 复用 Handle 开 channel + 请求 sftp 子系统
//! 4. SftpSession::new(channel.into_stream()) 初始化 SFTP 协议握手
//! 5. SFTP 操作完成,结果通过 Tauri invoke 返回前端
//!
//! ## SFTP 会话缓存
//! 首次 SFTP 操作时创建 SftpSession,缓存到 SshState 中(session_id → SftpSession)。
//! 后续操作复用缓存的 SftpSession,避免每次都开新 channel。
//! SSH 断开时通过 SshState::take 清理对应 SFTP 会话。
//!
//! ## 编码
//! SFTP 协议默认 UTF-8,中文文件名天然支持。
//! russh-sftp 的 path 参数接受 `Into<String>`,即 Rust String(UTF-8),无需额外编码处理。
//!
//! ## 错误处理
//! 所有错误转为 String 返回前端,前端用 i18n 显示。

use std::sync::Arc;

use russh_sftp::client::SftpSession as RawSftpSession;
use tokio::sync::Mutex;

/// SFTP 目录项 (前端序列化用)
///
/// 对应 SFTP read_dir 返回的 DirEntry,字段精简后序列化为 JSON。
/// 前端 TypeScript 接口:
/// ```ts
/// interface SftpEntry {
///   name: string;
///   path: string;
///   isDir: boolean;
///   isFile: boolean;
///   isSymlink: boolean;
///   size: number;
///   modified: number;  // Unix timestamp (秒)
///   permissions: string | null;
/// }
/// ```
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpEntry {
    /// 文件名 (不含路径,UTF-8)
    pub name: String,
    /// 完整路径 (父路径 + name)
    pub path: String,
    /// 是否目录
    pub is_dir: bool,
    /// 是否普通文件
    pub is_file: bool,
    /// 是否符号链接
    pub is_symlink: bool,
    /// 文件大小 (字节,目录为 0)
    pub size: u64,
    /// 修改时间 (Unix timestamp,秒)
    pub modified: i64,
    /// 权限字符串 (如 "rwxr-xr-x",无法获取时为 null)
    pub permissions: Option<String>,
}

/// SFTP 文件属性 (stat 命令返回)
///
/// 对应 SFTP metadata,与 SftpEntry 字段有重叠但保留独立结构供 stat 命令使用。
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SftpAttrs {
    /// 文件大小 (字节)
    pub size: u64,
    /// 用户 ID
    pub uid: u32,
    /// 组 ID
    pub gid: u32,
    /// 权限位 (Unix mode,如 0o755)
    pub permissions: u32,
    /// 修改时间 (Unix timestamp,秒)
    pub modified: i64,
    /// 访问时间 (Unix timestamp,秒)
    pub accessed: i64,
}

/// SFTP 会话封装
///
/// 持有 russh-sftp 的 SftpSession,所有操作通过 tokio Mutex 串行化
/// (SFTP 协议本身是请求-响应模式,Mutex 保护避免请求 ID 冲突)。
///
/// 生命周期:
/// - 创建: 首次 SFTP 操作时由 SftpState::get_or_create 创建
/// - 复用: 后续同 session_id 的操作复用
/// - 销毁: SSH 断开 / sftp_close 命令调用时移除
pub struct SftpSession {
    /// russh-sftp 高层 SFTP 客户端
    ///
    /// 用 Arc<Mutex<>> 包装,因为:
    /// 1. SftpSession 内部状态可变 (&self 方法,内部 Mutex)
    /// 2. 多个 Tauri 命令可能并发访问同一 session
    /// 3. close 时需要 take 出来 drop
    inner: Arc<Mutex<Option<RawSftpSession>>>,
}

/// SFTP 错误 (统一转为 String 给 Tauri 命令层)
fn sftp_err(e: impl std::fmt::Display) -> String {
    format!("SFTP error: {e}")
}

impl SftpSession {
    /// 创建 SFTP 会话
    ///
    /// 流程:
    /// 1. 接收 russh ChannelStream (调用方已 channel_open_session + request_subsystem("sftp"))
    /// 2. RawSftpSession::new(stream) 完成 SFTP 协议握手 (version exchange + extensions)
    ///
    /// # 参数
    /// - `stream`: russh ChannelStream<russh::client::Msg> (Channel::into_stream() 结果)
    pub async fn new(
        stream: russh::ChannelStream<russh::client::Msg>,
    ) -> Result<Self, String> {
        log::info!("[sftp] initializing SFTP session");
        let session = RawSftpSession::new(stream)
            .await
            .map_err(sftp_err)?;
        Ok(Self {
            inner: Arc::new(Mutex::new(Some(session))),
        })
    }

    /// 列目录
    ///
    /// 返回目录下所有条目 (含 . 和 .. 由 SFTP 服务器决定是否返回,此处过滤)。
    /// 排序: 目录优先,然后按名称字母序 (UTF-8 排序,中文按 Unicode 码点)。
    ///
    /// # 参数
    /// - `path`: 远程目录绝对路径 (如 "/home/user")
    pub async fn list_dir(&self, path: &str) -> Result<Vec<SftpEntry>, String> {
        log::info!("[sftp] list_dir: {}", path);
        let guard = self.inner.lock().await;
        let session = guard.as_ref().ok_or("SFTP session closed")?;

        let read_dir = session.read_dir(path.to_string()).await.map_err(sftp_err)?;
        let mut entries: Vec<SftpEntry> = Vec::new();

        // read_dir 实现标准 Iterator trait (同步 next)
        // 注: read_dir 内部已经缓存了 SFTP readdir 响应,迭代是同步的
        for entry in read_dir {
            let name = entry.file_name();
            // 跳过 "." 和 ".."
            if name == "." || name == ".." {
                continue;
            }
            let file_type = entry.file_type();
            let metadata = entry.metadata();

            // 构造完整路径
            let full_path = if path.ends_with('/') {
                format!("{}{}", path, name)
            } else {
                format!("{}/{}", path, name)
            };

            let entry = SftpEntry {
                name,
                path: full_path,
                is_dir: file_type.is_dir(),
                is_file: file_type.is_file(),
                is_symlink: file_type.is_symlink(),
                size: metadata.size.unwrap_or(0),
                modified: metadata.mtime.map(|t| t as i64).unwrap_or(0),
                permissions: metadata
                    .permissions
                    .map(mode_to_permission_string),
            };
            entries.push(entry);
        }

        // 排序: 目录优先,然后按名称
        entries.sort_by(|a, b| {
            // 目录在前
            match (a.is_dir, b.is_dir) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.name.cmp(&b.name),
            }
        });

        log::info!("[sftp] list_dir success: {} entries", entries.len());
        Ok(entries)
    }

    /// 查询文件属性 (stat)
    pub async fn stat(&self, path: &str) -> Result<SftpAttrs, String> {
        log::info!("[sftp] stat: {}", path);
        let guard = self.inner.lock().await;
        let session = guard.as_ref().ok_or("SFTP session closed")?;

        let metadata = session.metadata(path.to_string()).await.map_err(sftp_err)?;

        Ok(SftpAttrs {
            size: metadata.size.unwrap_or(0),
            uid: metadata.uid.unwrap_or(0),
            gid: metadata.gid.unwrap_or(0),
            permissions: metadata.permissions.unwrap_or(0),
            modified: metadata.mtime.map(|t| t as i64).unwrap_or(0),
            accessed: metadata.atime.map(|t| t as i64).unwrap_or(0),
        })
    }

    /// 读取文件内容
    ///
    /// 全量读取 (整文件读入内存)。大文件场景可优化为分块读取,
    /// 但 Monaco Editor 编辑需要全量,故暂不分块。
    pub async fn read_file(&self, path: &str) -> Result<Vec<u8>, String> {
        log::info!("[sftp] read_file: {} ({} bytes)", path, 0);
        let guard = self.inner.lock().await;
        let session = guard.as_ref().ok_or("SFTP session closed")?;

        let data = session.read(path.to_string()).await.map_err(sftp_err)?;
        log::info!("[sftp] read_file success: {} bytes", data.len());
        Ok(data)
    }

    /// 写入文件内容 (覆盖)
    ///
    /// SFTP write 会创建文件(若不存在)或截断(若存在),然后写入数据。
    pub async fn write_file(&self, path: &str, content: &[u8]) -> Result<(), String> {
        log::info!("[sftp] write_file: {} ({} bytes)", path, content.len());
        let guard = self.inner.lock().await;
        let session = guard.as_ref().ok_or("SFTP session closed")?;

        session
            .write(path.to_string(), content)
            .await
            .map_err(sftp_err)?;
        log::info!("[sftp] write_file success");
        Ok(())
    }

    /// 创建目录
    pub async fn mkdir(&self, path: &str) -> Result<(), String> {
        log::info!("[sftp] mkdir: {}", path);
        let guard = self.inner.lock().await;
        let session = guard.as_ref().ok_or("SFTP session closed")?;

        session
            .create_dir(path.to_string())
            .await
            .map_err(sftp_err)?;
        Ok(())
    }

    /// 删除文件
    ///
    /// 注意: 仅删除文件,不递归删除目录 (与 rm 一致,非 rm -r)。
    /// 删除目录用 remove_dir (russh-sftp 的 remove_dir 方法)。
    pub async fn remove_file(&self, path: &str) -> Result<(), String> {
        log::info!("[sftp] remove_file: {}", path);
        let guard = self.inner.lock().await;
        let session = guard.as_ref().ok_or("SFTP session closed")?;

        session
            .remove_file(path.to_string())
            .await
            .map_err(sftp_err)?;
        Ok(())
    }

    /// 删除目录 (空目录)
    pub async fn remove_dir(&self, path: &str) -> Result<(), String> {
        log::info!("[sftp] remove_dir: {}", path);
        let guard = self.inner.lock().await;
        let session = guard.as_ref().ok_or("SFTP session closed")?;

        session
            .remove_dir(path.to_string())
            .await
            .map_err(sftp_err)?;
        Ok(())
    }

    /// 重命名文件/目录
    pub async fn rename(&self, from: &str, to: &str) -> Result<(), String> {
        log::info!("[sftp] rename: {} -> {}", from, to);
        let guard = self.inner.lock().await;
        let session = guard.as_ref().ok_or("SFTP session closed")?;

        session
            .rename(from.to_string(), to.to_string())
            .await
            .map_err(sftp_err)?;
        Ok(())
    }

    /// 关闭 SFTP 会话
    ///
    /// 调用 RawSftpSession::close 发送 close packet,然后 take 出来 drop 释放资源。
    pub async fn close(&self) -> Result<(), String> {
        log::info!("[sftp] closing session");
        let mut guard = self.inner.lock().await;
        if let Some(session) = guard.take() {
            // close 失败不阻断清理 (drop 也会释放资源)
            if let Err(e) = session.close().await {
                log::warn!("[sftp] close error (ignored): {}", e);
            }
        }
        log::info!("[sftp] session closed");
        Ok(())
    }

    /// 规范化路径 (canonicalize,解析符号链接 + . .. 等)
    ///
    /// 用于前端"获取当前工作目录"(realpath("."))
    pub async fn canonicalize(&self, path: &str) -> Result<String, String> {
        log::info!("[sftp] canonicalize: {}", path);
        let guard = self.inner.lock().await;
        let session = guard.as_ref().ok_or("SFTP session closed")?;

        let resolved = session
            .canonicalize(path.to_string())
            .await
            .map_err(sftp_err)?;
        Ok(resolved)
    }
}

/// Unix mode 位 → 9 字符权限字符串 (如 "rwxr-xr-x")
///
/// SSH 协议 permissions 字段为 POSIX mode (包含 type + permission bits),
/// 取低 9 位 (permission bits) 转换。
fn mode_to_permission_string(mode: u32) -> String {
    let mut s = String::with_capacity(9);
    let perms = [
        // owner: rwx
        (mode & 0o400 != 0, mode & 0o200 != 0, mode & 0o100 != 0),
        // group: rwx
        (mode & 0o040 != 0, mode & 0o020 != 0, mode & 0o010 != 0),
        // other: rwx
        (mode & 0o004 != 0, mode & 0o002 != 0, mode & 0o001 != 0),
    ];
    for (r, w, x) in perms {
        s.push(if r { 'r' } else { '-' });
        s.push(if w { 'w' } else { '-' });
        s.push(if x { 'x' } else { '-' });
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use russh_sftp::protocol::FileType;

    #[test]
    fn test_mode_to_permission_string_rwx() {
        // 0o755 = rwxr-xr-x
        assert_eq!(mode_to_permission_string(0o755), "rwxr-xr-x");
    }

    #[test]
    fn test_mode_to_permission_string_644() {
        // 0o644 = rw-r--r--
        assert_eq!(mode_to_permission_string(0o644), "rw-r--r--");
    }

    #[test]
    fn test_mode_to_permission_string_000() {
        // 0o000 = ---------
        assert_eq!(mode_to_permission_string(0o000), "---------");
    }

    #[test]
    fn test_mode_to_permission_string_777() {
        // 0o777 = rwxrwxrwx
        assert_eq!(mode_to_permission_string(0o777), "rwxrwxrwx");
    }

    #[test]
    fn test_sftp_entry_serialization() {
        let entry = SftpEntry {
            name: "测试文件.md".to_string(),
            path: "/home/user/测试文件.md".to_string(),
            is_dir: false,
            is_file: true,
            is_symlink: false,
            size: 1024,
            modified: 1690000000,
            permissions: Some("rw-r--r--".to_string()),
        };
        let json = serde_json::to_string(&entry).unwrap();
        // 验证 camelCase 序列化
        assert!(json.contains("\"isDir\":false"));
        assert!(json.contains("\"isFile\":true"));
        assert!(json.contains("\"name\":\"测试文件.md\""));
        // 中文 UTF-8 序列化验证
        assert!(json.contains("\"path\":\"/home/user/测试文件.md\""));
    }

    #[test]
    fn test_sftp_attrs_serialization() {
        let attrs = SftpAttrs {
            size: 4096,
            uid: 1000,
            gid: 1000,
            permissions: 0o753,
            modified: 1690000000,
            accessed: 1690001000,
        };
        let json = serde_json::to_string(&attrs).unwrap();
        assert!(json.contains("\"size\":4096"));
        assert!(json.contains("\"uid\":1000"));
        assert!(json.contains("\"gid\":1000"));
        assert!(json.contains("\"permissions\":491")); // 0o753 = 491
    }

    #[test]
    fn test_file_type_variants() {
        // 验证 FileType 各变体 (russh-sftp 公开 API)
        assert!(FileType::Dir.is_dir());
        assert!(!FileType::Dir.is_file());
        assert!(FileType::File.is_file());
        assert!(FileType::Symlink.is_symlink());
        assert!(FileType::Other.is_other());
    }
}
