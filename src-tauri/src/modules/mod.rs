// modules/mod.rs — 从 terax-ai 搬运的核心 Rust 模块
// ============================================================================
// PTY 真终端引擎 (3线程 reader/flusher/waiter 架构)
pub mod pty;

// 后台 Shell 命令执行
pub mod shell;

// 进程管理 (Windows Job Object)
pub mod proc;

// 工作区注册表 (目录授权 + CWD 管理)
pub mod workspace;

// Agent 钩子 (Hook 引擎)
pub mod agent;

// 密钥管理 (平台 Keyring)
pub mod secrets;

// 网络请求 (AI HTTP 代理)
pub mod net;

// 文件系统工具 (路径规范化 + 子模块)
pub mod fs;

// Git 操作 (libgit2 / 命令行混合)
pub mod git;

// 命令历史记录 (shell history 持久化 + 智能建议)
pub mod history;

// LSP 客户端 (Language Server Protocol)
pub mod lsp;

// ============================================================================
// TDSF 自有模块（P1-B Agent 引擎）
// ============================================================================

// Python Sidecar 进程管理 (T-P1-01)
// spawn + stdio pipe + ready 等待 + 健康检查 + 自动重启 + 优雅退出
pub mod sidecar;

// stdio JSON-RPC 协议层 (T-P1-02)
// IPCClient + 类型化 IPCError + Tauri 命令（ipc_invoke / ipc_notify / ipc_status）
// 在 sidecar.rs 之上提供高层抽象，供前端 invoke 调用 Python Sidecar
pub mod ipc;

// ============================================================================
// TDSF 自有模块（P2-B SSH 客户端）
// ============================================================================

// SSH 客户端 (T-P2-03)
// russh 0.61 纯 Rust 异步 SSH + TOFU + keepalive + password/publickey 认证
// 模块结构: handler (Handler trait) + client (connect/auth) + known_hosts (TOFU) + session (PTY)
pub mod ssh;

// ============================================================================
// TDSF 自有模块（P2-C side-git 影子仓库）
// ============================================================================

// side-git 影子仓库 (T-P2-07, DEC-V321-02)
// Agent 修改文件前自动 stash + 失败回滚 + 变更日志
// 模块结构: SideGitManager (init/stash/commit/rollback/track_change) + 5 个 Tauri 命令
// 影子仓库路径: ~/.tdsf/side-git/<sha256(project-path)>/{git,worktree,log}/
pub mod side_git;

// ============================================================================
// TDSF 自有模块（P2-D Docker 沙箱）
// ============================================================================

// Docker 沙箱 (T-P2-08, DEC-V321-10)
// Agent 在容器内执行 L3+ 风险命令,提供隔离执行环境
// 模块结构: SandboxManager (Docker 检测 + 容器生命周期 + exec) + 7 个 Tauri 命令
// 基于 bollard 0.17 异步 Docker 客户端
pub mod sandbox;

// ============================================================================
// TDSF 自有模块（P2-D 终端补全）
// ============================================================================

// shell history 读取 (T-P2-10.5)
// 自动检测 shell 类型 (bash/zsh/fish/powershell) + 读取 history 文件
// 返回 ShellHistoryInfo (shellType + historyPath + commands) 供前端 CompletionEngine 加载
pub mod shell_history;
