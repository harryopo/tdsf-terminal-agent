/**
 * commands.rs — TDSF Terminal Agent Tauri Commands (P0 健康检查)
 * -----------------------------------------------------------------------------
 * PTY/Shell/Agent 等命令已迁移到 modules/ 目录 (从 terax-ai 搬运)
 * 此文件仅保留 TDSF 自有命令
 */
use crate::error::ApiResult;
use crate::state::AppState;
use serde::Serialize;
use tauri::State;

#[derive(Debug, Serialize)]
pub struct VersionInfo {
    pub name: &'static str,
    pub version: &'static str,
    pub rust_version: &'static str,
}

#[derive(Debug, Serialize)]
pub struct BuildInfo {
    pub version: VersionInfo,
    pub started_at: String, // RFC 3339
    pub uptime_secs: u64,
}

/// 健康检查 (前端启动后第一调用, 验证 IPC 通路)
#[tauri::command]
pub fn ping() -> &'static str {
    "pong"
}

/// 版本信息
#[tauri::command]
pub fn get_version() -> VersionInfo {
    VersionInfo {
        name: env!("CARGO_PKG_NAME"),
        version: env!("CARGO_PKG_VERSION"),
        rust_version: rustc_version_runtime(),
    }
}

/// 构建信息 (含启动时间 + 运行时长)
#[tauri::command]
pub fn get_build_info(state: State<'_, AppState>) -> ApiResult<BuildInfo> {
    let now = chrono::Utc::now();
    let uptime = now
        .signed_duration_since(state.started_at)
        .num_seconds()
        .max(0) as u64;

    Ok(BuildInfo {
        version: get_version(),
        started_at: state.started_at.to_rfc3339(),
        uptime_secs: uptime,
    })
}

fn rustc_version_runtime() -> &'static str {
    option_env!("RUSTC_VERSION").unwrap_or("unknown")
}
