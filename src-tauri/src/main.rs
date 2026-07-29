// main.rs — TDSF Terminal Agent v4.0 Tauri 入口
// -----------------------------------------------------------------------------
// 桌面壳 (Tauri 2) + React 19 前端 (WebView)
// P0 阶段: 仅实现基础窗口 + 日志, 不含终端 / AI / SSH 模块 (留给 P1-P3)
// 详细 API 契约见 specs/04-api-contract.md
//
// inner attribute 必须紧跟文件顶部, 不能在文档注释之后
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tdsf_terminal_agent_lib::run()
}
