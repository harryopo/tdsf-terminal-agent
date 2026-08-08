// modules/fs_backend/mod.rs — 文件系统后端抽象（WorkspaceFs P2-1）
//
// 设计来源: 方案书 docs/reports/WORKSPACE-FS-REFACTOR-PLAN.md + yazi Engine trait
// 借鉴 (https://github.com/sxyazi/yazi):
//   - trait 定义完整文件操作语义, 实现层提供后端 (Local / Sftp)
//   - capabilities() 声明能力集, UI 按能力禁用不支持的操作
//   - 路径语义由实现层保证: LocalFs 只接受盘符/UNC, SftpFs 只接受 / 开头
//
// 前端经 workspaceFsStore 消费: Space 切换时 backend 整体替换 (原子),
// 消除 FileExplorer source prop 切换两套树的时序竞态 (SSH 闪跳/空白根因)。

mod local;
pub mod commands;
pub mod sftp;

use serde::Serialize;
use std::fmt;

pub use local::LocalFs;
pub use sftp::SftpFs;

/// 后端类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum FsKind {
    Local,
    Sftp,
}

impl fmt::Display for FsKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            FsKind::Local => write!(f, "local"),
            FsKind::Sftp => write!(f, "sftp"),
        }
    }
}

/// 能力集: UI 按此禁用当前后端不支持的操作
#[derive(Debug, Clone, Copy, Default, Serialize)]
pub struct FsCapabilities {
    pub rename: bool,
    pub delete: bool,
    pub mkdir: bool,
    pub write: bool,
    pub trash: bool,
    pub symlink: bool,
}

/// 目录条目 (backend 中立, 不含本地特有字段如 gitignored)
#[derive(Debug, Clone, Serialize)]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    /// Milliseconds since UNIX epoch; 0 if unavailable
    pub mtime: u64,
}

/// 文件系统后端统一抽象
///
/// 实现要求:
/// - 方法均为 async (SFTP 天然异步; Local 用 tokio::fs 对称)
/// - 路径语义自洽: 实现层校验入参路径属于本后端命名空间
///   (Local: 盘符/UNC; Sftp: / 开头), 拒绝跨源路径
#[async_trait::async_trait]
pub trait FsBackend: Send + Sync {
    fn kind(&self) -> FsKind;
    fn capabilities(&self) -> FsCapabilities;

    /// 解析 Space 环境的根路径 (本地: 盘符路径; Sftp: /home/user 等)
    fn resolve_root(&self, env: &crate::modules::workspace::WorkspaceEnv) -> String;

    /// 列出目录直接子项 (目录在前, 大小写不敏感排序)
    async fn list(&self, path: &str) -> Result<Vec<FsEntry>, FsBackendError>;

    /// 读取文件内容
    async fn read(&self, path: &str) -> Result<Vec<u8>, FsBackendError>;

    /// 写入文件 (创建/覆盖)
    async fn write(&self, path: &str, data: &[u8]) -> Result<(), FsBackendError>;

    /// 重命名/移动
    async fn rename(&self, from: &str, to: &str) -> Result<(), FsBackendError>;

    /// 删除 (文件或空目录; 目录非空由实现层返回明确错误)
    async fn delete(&self, path: &str) -> Result<(), FsBackendError>;

    /// 创建目录 (含父目录)
    async fn mkdir(&self, path: &str) -> Result<(), FsBackendError>;

    /// 路径状态
    async fn stat(&self, path: &str) -> Result<FsEntry, FsBackendError>;
}

/// 后端错误: 统一错误语义, 前端按 code 区分降级/重连
#[derive(Debug, Clone, Serialize)]
pub struct FsBackendError {
    pub code: FsErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum FsErrorCode {
    NotFound,
    PermissionDenied,
    NotEmpty,
    NotConnected,
    InvalidPath,
    Io,
    Other,
}

impl FsBackendError {
    pub fn not_found(path: &str) -> Self {
        Self {
            code: FsErrorCode::NotFound,
            message: format!("路径不存在: {path}"),
        }
    }
    pub fn invalid_path(path: &str) -> Self {
        Self {
            code: FsErrorCode::InvalidPath,
            message: format!("路径不属于当前文件系统: {path}"),
        }
    }
    pub fn not_connected() -> Self {
        Self {
            code: FsErrorCode::NotConnected,
            message: "SSH 连接已断开".into(),
        }
    }
    pub fn io(e: impl fmt::Display) -> Self {
        Self {
            code: FsErrorCode::Io,
            message: e.to_string(),
        }
    }
}

impl fmt::Display for FsErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let s = match self {
            FsErrorCode::NotFound => "NotFound",
            FsErrorCode::PermissionDenied => "PermissionDenied",
            FsErrorCode::NotEmpty => "NotEmpty",
            FsErrorCode::NotConnected => "NotConnected",
            FsErrorCode::InvalidPath => "InvalidPath",
            FsErrorCode::Io => "Io",
            FsErrorCode::Other => "Other",
        };
        write!(f, "{s}")
    }
}

impl fmt::Display for FsBackendError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}", self.code, self.message)
    }
}

impl std::error::Error for FsBackendError {}

impl From<std::io::Error> for FsBackendError {
    fn from(e: std::io::Error) -> Self {
        let code = match e.kind() {
            std::io::ErrorKind::NotFound => FsErrorCode::NotFound,
            std::io::ErrorKind::PermissionDenied => FsErrorCode::PermissionDenied,
            std::io::ErrorKind::DirectoryNotEmpty => FsErrorCode::NotEmpty,
            _ => FsErrorCode::Io,
        };
        Self {
            code,
            message: e.to_string(),
        }
    }
}
