//! Docker 沙箱模块 (P2-C T-P2-08, DEC-V321-10)
//! ============================================================================
//! 让 Agent 在容器内执行 L3+ 风险命令,提供隔离的执行环境。
//!
//! ## 模块结构
//! - `config`: SandboxConfig / ExecResult / ContainerInfo / DockerStatus 数据结构
//! - `manager`: SandboxManager 核心管理器 (Docker 检测 + 容器生命周期 + exec)
//! - `exec`: 容器内命令执行 (create_exec + start_exec + 输出收集)
//!
//! ## 关键特性
//! - **跨平台**: bollard 0.17 自动检测 Windows Named Pipe / Linux Unix socket
//! - **安全加固**: cap_drop ALL + read_only_rootfs + 非 root + seccomp + no-new-privileges
//! - **资源限制**: 512MB 内存 / 1 CPU / 256 进程数 (cgroups v2)
//! - **网络隔离**: 默认 none 模式 (无网络)
//! - **临时文件**: /tmp tmpfs 64MB (与根文件系统隔离)
//!
//! ## Tauri 命令
//! - `sandbox_status`: 检测 Docker 可用性,返回 DockerStatus
//! - `sandbox_create`: 创建沙箱容器,返回容器 ID
//! - `sandbox_start` / `sandbox_stop` / `sandbox_remove`: 容器生命周期
//! - `sandbox_exec`: 在容器内执行命令,返回 ExecResult
//! - `sandbox_list`: 列出所有 tdsf-sandbox-* 容器
//!
//! ## 用法示例 (前端)
//! ```ts
//! // 1. 检测 Docker
//! const status = await invoke('sandbox_status');
//! if (!status.available) {
//!   // 引导用户安装 Docker Desktop
//!   return;
//! }
//!
//! // 2. 创建并启动沙箱
//! const id = await invoke('sandbox_create', { config: { /* SandboxConfig */ } });
//! await invoke('sandbox_start', { id });
//!
//! // 3. 执行命令
//! const result = await invoke('sandbox_exec', { id, cmd: ['ls', '-l', '/'] });
//! console.log(result.stdout, result.exitCode);
//!
//! // 4. 清理
//! await invoke('sandbox_stop', { id });
//! await invoke('sandbox_remove', { id });
//! ```

pub mod config;
pub mod exec;
pub mod manager;
pub mod os_level;

// 重导出核心类型,供 lib.rs 注册 Tauri 命令使用
pub use config::{ContainerInfo, DockerStatus, DockerVersion, ExecResult, SandboxConfig};
pub use manager::SandboxManager;
// T-P5-06: OS 级沙箱（Windows Restricted Token + WFP）
pub use os_level::{Handle as OsSandboxHandle, OsSandbox, SandboxError as OsSandboxError, Sid};

// ============================================================================
// Tauri 命令定义 (lib.rs 中通过 invoke_handler 注册)
// ============================================================================

/// sandbox_status 命令: 检测 Docker daemon 可用性
///
/// 返回 DockerStatus:
/// - available: true 时 version 字段有值
/// - available: false 时 error 字段包含友好提示
///
/// 前端首次进入沙箱面板时调用,根据结果决定 UI 状态。
#[tauri::command]
pub async fn sandbox_status(
    state: tauri::State<'_, SandboxState>,
) -> Result<DockerStatus, String> {
    let manager = state.get_or_init().await?;
    Ok(manager.status().await)
}

/// sandbox_create 命令: 创建沙箱容器
///
/// 参数:
/// - `config`: SandboxConfig (前端传入,可选字段使用默认值)
///
/// 返回: 容器 ID (64 字符 hex)
#[tauri::command]
pub async fn sandbox_create(
    state: tauri::State<'_, SandboxState>,
    config: SandboxConfig,
) -> Result<String, String> {
    let manager = state.get_or_init().await?;
    manager.create_container(config).await
}

/// sandbox_start 命令: 启动容器
#[tauri::command]
pub async fn sandbox_start(
    state: tauri::State<'_, SandboxState>,
    id: String,
) -> Result<(), String> {
    let manager = state.get_or_init().await?;
    manager.start_container(&id).await
}

/// sandbox_stop 命令: 优雅停止容器 (10s 超时后强制 kill)
#[tauri::command]
pub async fn sandbox_stop(
    state: tauri::State<'_, SandboxState>,
    id: String,
) -> Result<(), String> {
    let manager = state.get_or_init().await?;
    manager.stop_container(&id).await
}

/// sandbox_remove 命令: 删除容器 (force=true,即使运行中也强制删除)
#[tauri::command]
pub async fn sandbox_remove(
    state: tauri::State<'_, SandboxState>,
    id: String,
) -> Result<(), String> {
    let manager = state.get_or_init().await?;
    manager.remove_container(&id).await
}

/// sandbox_exec 命令: 在容器内执行命令
///
/// 参数:
/// - `id`: 容器 ID
/// - `cmd`: 命令参数 (如 `["ls", "-l", "/"]`)
///
/// 返回: ExecResult { stdout, stderr, exit_code, duration_ms }
#[tauri::command]
pub async fn sandbox_exec(
    state: tauri::State<'_, SandboxState>,
    id: String,
    cmd: Vec<String>,
) -> Result<ExecResult, String> {
    let manager = state.get_or_init().await?;
    manager.exec_in_container(&id, cmd).await
}

/// sandbox_list 命令: 列出所有 tdsf-sandbox-* 容器
///
/// 返回: Vec<ContainerInfo> (按 created 降序)
#[tauri::command]
pub async fn sandbox_list(
    state: tauri::State<'_, SandboxState>,
) -> Result<Vec<ContainerInfo>, String> {
    let manager = state.get_or_init().await?;
    manager.list_containers().await
}

// ============================================================================
// SandboxState — 全局状态 (通过 Tauri State 注入)
// ============================================================================

/// 沙箱全局状态
///
/// 内部持有 `Option<SandboxManager>`(延迟初始化):
/// - 首次调用时尝试创建 SandboxManager
/// - 若 Docker daemon 不可用,返回错误到前端
/// - 创建成功后缓存,后续调用复用
///
/// 用 Mutex<Option<SandboxManager>> 而非直接持有 SandboxManager:
/// - 避免 Docker daemon 未启动时 panic
/// - 允许 daemon 重启后重试 (后续扩展)
pub struct SandboxState {
    manager: tokio::sync::Mutex<Option<SandboxManager>>,
}

impl Default for SandboxState {
    fn default() -> Self {
        Self {
            manager: tokio::sync::Mutex::new(None),
        }
    }
}

impl SandboxState {
    /// 获取或初始化 SandboxManager
    ///
    /// - 首次调用: 创建 SandboxManager 并缓存
    /// - 后续调用: 复用缓存的 manager
    /// - Docker daemon 不可用: 返回错误 (不缓存,允许下次重试)
    pub async fn get_or_init(&self) -> Result<SandboxManager, String> {
        let mut guard = self.manager.lock().await;
        if let Some(m) = guard.as_ref() {
            return Ok(m.clone());
        }

        let manager = SandboxManager::new()?;
        *guard = Some(manager.clone());
        Ok(manager)
    }
}
