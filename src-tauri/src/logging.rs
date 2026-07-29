/**
 * logging.rs — TDSF Terminal Agent 统一日志初始化
 * -----------------------------------------------------------------------------
 * 阶段: P0 用 env_logger (简单), P1 升级 tracing-subscriber (结构化日志)
 * 原则: 所有日志走 log crate, 主进程不直接 println
 */
use log::LevelFilter;
use std::env;

pub fn init() {
    // 默认 RUST_LOG=info, 调试时可设 tauri=debug, tdsf_terminal_agent_lib=trace
    if env::var("RUST_LOG").is_err() {
        env::set_var("RUST_LOG", "info");
    }

    env_logger::Builder::from_default_env()
        .filter_level(LevelFilter::Info)
        .format_module_path(true)
        .format_target(false)
        .format_timestamp_secs()
        .init();

    log::info!(
        "TDSF Terminal Agent v4.0 starting (rustc {}, build: {})",
        rustc_version_runtime(),
        build_profile()
    );
}

fn rustc_version_runtime() -> &'static str {
    // 编译期注入 rustc 版本, 失败回退 "unknown"
    // 必须在 build.rs 中设置 rustc-env RUSTC_VERSION 才能读到值
    option_env!("RUSTC_VERSION").unwrap_or("unknown")
}

fn build_profile() -> &'static str {
    if cfg!(debug_assertions) {
        "debug"
    } else {
        "release"
    }
}
