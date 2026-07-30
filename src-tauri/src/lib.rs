pub mod modules;

use modules::{agent, fs, git, history, ipc, lsp, net, pty, secrets, shell, sidecar, ssh, workspace};
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};
#[cfg(target_os = "macos")]
use tauri::{PhysicalPosition, WindowEvent};
use tauri_plugin_window_state::StateFlags;

/// Drained on first read so HMR / re-mounts can't replay the launch dir.
#[derive(Default)]
struct LaunchDir(Mutex<Option<String>>);

/// Drained on first read so HMR / re-mounts can't replay the launch files.
#[derive(Default)]
struct LaunchFiles(Mutex<Vec<String>>);

#[tauri::command]
fn get_launch_dir(state: State<'_, LaunchDir>) -> Option<String> {
    state.0.lock().expect("LaunchDir mutex poisoned").take()
}

#[tauri::command]
fn get_launch_files(state: State<'_, LaunchFiles>) -> Vec<String> {
    std::mem::take(&mut *state.0.lock().expect("LaunchFiles mutex poisoned"))
}

enum LaunchEntry {
    Dir(PathBuf),
    File(PathBuf),
}

#[derive(Default, Debug, PartialEq)]
struct LaunchTarget {
    dir: Option<String>,
    files: Vec<String>,
}

/// First dir arg (else the first file's parent) becomes the workspace; every
/// file arg is opened. Kept free of fs/env access so it stays unit-testable.
fn resolve_launch_target(entries: Vec<LaunchEntry>) -> LaunchTarget {
    let mut dir = None;
    let mut files = Vec::new();
    for entry in entries {
        match entry {
            LaunchEntry::Dir(path) => {
                if dir.is_none() {
                    dir = Some(fs::to_canon(&path));
                }
            }
            LaunchEntry::File(path) => {
                if dir.is_none() {
                    dir = path.parent().map(fs::to_canon);
                }
                files.push(fs::to_canon(&path));
            }
        }
    }
    LaunchTarget { dir, files }
}

fn parse_launch_target() -> LaunchTarget {
    let entries = std::env::args()
        .skip(1)
        .filter(|arg| !arg.starts_with('-'))
        .filter_map(|arg| std::fs::canonicalize(arg).ok())
        .filter_map(|path| {
            let meta = std::fs::metadata(&path).ok()?;
            Some(if meta.is_dir() {
                LaunchEntry::Dir(path)
            } else {
                LaunchEntry::File(path)
            })
        })
        .collect();
    resolve_launch_target(entries)
}

/// True for the settings window family: "settings", "settings-1", "settings-2", …
fn is_settings_label(label: &str) -> bool {
    label == "settings"
        || label
            .strip_prefix("settings-")
            .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
}

/// Pick the first free settings label. A dead settings window keeps its label
/// registered forever (tauri only frees a label on the `Destroyed` event, which
/// a zombie already missed), so recovery must rebuild under a fresh label.
fn next_settings_label(existing: &[String]) -> String {
    if !existing.iter().any(|l| l == "settings") {
        return "settings".to_string();
    }
    let mut n: u32 = 1;
    loop {
        let candidate = format!("settings-{n}");
        if !existing.iter().any(|l| l == &candidate) {
            return candidate;
        }
        n += 1;
    }
}

#[tauri::command]
async fn open_settings_window(app: tauri::AppHandle, tab: Option<String>) -> Result<(), String> {
    let url_path = match tab.as_deref() {
        Some(t) if !t.is_empty() => format!("settings.html?tab={}", t),
        _ => "settings.html".to_string(),
    };

    // TDSF fix (2026-07-30): a settings window whose native window/webview died
    // (e.g. failed WebView2 creation) stays registered as a zombie label — every
    // dispatcher call fails with FailedToReceiveMessage and the old code
    // swallowed those errors, so the button silently did nothing forever.
    // Probe liveness first; only reuse a window that still answers.
    let mut dead_labels: Vec<String> = Vec::new();
    for (label, window) in app.webview_windows() {
        if !is_settings_label(&label) {
            continue;
        }
        if window.is_visible().is_err() {
            dead_labels.push(label);
            continue;
        }
        if let Err(e) = window.set_always_on_top(true) {
            log::warn!("settings window '{label}': set_always_on_top failed: {e}");
        }
        if let Err(e) = window.show() {
            log::warn!("settings window '{label}': show failed: {e}");
        }
        if let Err(e) = window.set_focus() {
            log::warn!("settings window '{label}': set_focus failed: {e}");
        }
        if let Some(t) = tab.as_deref().filter(|s| !s.is_empty()) {
            // emit() serializes via JSON — no string-escape footgun, unlike
            // eval() with format!(). Frontend listens via Tauri event API.
            let _ = window.emit("terax:settings-tab", t);
        }
        return Ok(());
    }
    if !dead_labels.is_empty() {
        log::warn!(
            "open_settings_window: dead settings window(s) {dead_labels:?} still registered; building a replacement"
        );
    }

    let existing: Vec<String> = app.webview_windows().keys().cloned().collect();
    let label = next_settings_label(&existing);
    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App(url_path.into()))
        .title("Settings")
        .inner_size(900.0, 700.0)
        .min_inner_size(820.0, 620.0)
        .resizable(true)
        .visible(false)
        // Keep settings above the main app window so it doesn't get hidden
        // when the user clicks back into the editor or terminal (#33).
        .always_on_top(true);

    // TDSF fix (2026-07-30): the main window ships custom additionalBrowserArgs
    // (CDP --remote-debugging-port). WebView2 refuses to create a second webview
    // in the same user-data dir with different browser args (0x8007139F
    // ERROR_INVALID_STATE), so the settings webview must inherit them.
    let main_browser_args = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .and_then(|w| w.additional_browser_args.clone());
    let builder = match &main_browser_args {
        Some(args) => builder.additional_browser_args(args),
        None => builder,
    };

    // Tie lifecycle to the main window so settings minimizes/closes with it.
    // macOS: skip parent() — child + always_on_top leaves the settings webview
    // behind the main window except while the parent is being dragged (#33).
    #[cfg(not(target_os = "macos"))]
    let builder = if let Some(main) = app.get_webview_window("main") {
        builder.parent(&main).map_err(|e| e.to_string())?
    } else {
        builder
    };

    #[cfg(target_os = "macos")]
    let builder = builder
        .title_bar_style(tauri::TitleBarStyle::Overlay)
        .hidden_title(true);

    // On Linux/Windows we render our own titlebar, so drop native chrome
    // and make the window transparent.
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    let builder = builder.decorations(false).transparent(true);

    let window = builder.build().map_err(|e| e.to_string())?;

    // Some Linux compositors (GNOME/Mutter with CSD-by-default) ignore the
    // builder-time decorations flag — re-assert it after realize.
    #[cfg(target_os = "linux")]
    {
        let _ = window.set_decorations(false);
    }

    #[cfg(target_os = "macos")]
    if let Some(main) = app.get_webview_window("main") {
        if let (Ok(main_pos), Ok(main_size), Ok(settings_size)) = (
            main.outer_position(),
            main.outer_size(),
            window.outer_size(),
        ) {
            let x = main_pos.x
                + ((main_size.width as i32).saturating_sub(settings_size.width as i32)) / 2;
            let y = main_pos.y
                + ((main_size.height as i32).saturating_sub(settings_size.height as i32)) / 2;
            let _ = window.set_position(PhysicalPosition::new(x, y));
        } else {
            let _ = window.center();
        }
    }

    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(windows)]
    {
        let args: Vec<String> = std::env::args().collect();
        if args.get(1).map(String::as_str) == Some("__terax_notify") {
            if let (Some(agent), Some(event)) = (args.get(2), args.get(3)) {
                agent::emit_conout_marker(agent, event);
            }
            use std::io::Write;
            let mut out = std::io::stdout();
            let _ = out.write_all(b"{}");
            let _ = out.flush();
            std::process::exit(0);
        }
    }

    let launch = parse_launch_target();
    let cli_dir = launch.dir.clone();
    workspace::init_launch_cwd(cli_dir.as_deref());

    let builder = tauri::Builder::default();
    #[cfg(target_os = "linux")]
    let builder = builder.plugin(tauri_plugin_clipboard_manager::init());
    builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // Skip restoring VISIBLE — frontend calls window.show() after first
        // paint so the user never sees a transparent window-shadow flash on
        // Windows/Linux.
        .plugin(
            tauri_plugin_window_state::Builder::new()
                .with_state_flags(StateFlags::all() & !StateFlags::VISIBLE)
                .build(),
        )
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(
            tauri_plugin_log::Builder::new()
                .level(tauri_plugin_log::log::LevelFilter::Info)
                // TDSF (#20): SSH 终端深度集成已实测通过 (CDP 验证 rendererPool 复用
                // JetBrainsMono 等宽字体 + 暗模式 token 正确), 诊断期结束, 还原 russh 为 Info.
                // 排查 SSH 问题临时开 Debug: 把下行注释解除即可, 不需改 RUST_LOG (无效).
                // .level_for("russh", tauri_plugin_log::log::LevelFilter::Debug)
                .build(),
        )
        .plugin(tauri_plugin_opener::init())
        .setup(|_app| {
            // macOS skips parent() for the settings window, so tie its lifecycle
            // to the main window here instead. Other platforms keep parent().
            #[cfg(target_os = "macos")]
            if let Some(main) = _app.get_webview_window("main") {
                let handle = _app.handle().clone();
                main.on_window_event(move |event| {
                    if matches!(
                        event,
                        WindowEvent::CloseRequested { .. } | WindowEvent::Destroyed
                    ) {
                        for (label, settings) in handle.webview_windows() {
                            if is_settings_label(&label) {
                                let _ = settings.close();
                            }
                        }
                    }
                });
            }

            // ====================================================================
            // T2.1: 启动 Python Sidecar（TDSF Agent 引擎桥接）
            // ====================================================================
            // Sidecar 脚本路径: <app_root>/sidecar/main.py
            // 在 dev 模式下: <workspace>/tdsf-terminal-agent-clone/src-tauri/sidecar/main.py
            // 在 prod 模式下: 通过 tauri resource 打包（后续 task 处理）
            let sidecar_script = locate_sidecar_script();
            log::info!("[setup] sidecar script path: {:?}", sidecar_script);

            let sidecar_manager = sidecar::SidecarManager::new(sidecar_script);
            let app_handle = _app.handle().clone();
            let sidecar_manager_for_setup = sidecar_manager.clone();
            tauri::async_runtime::spawn(async move {
                sidecar_manager_for_setup
                    .set_app_handle(app_handle)
                    .await;

                // 启动 restart loop（监听 exit_watcher_task 的重启信号）
                // 必须在 start() 之前启动，否则首次崩溃时 restart_tx 还未设置
                sidecar_manager_for_setup.start_restart_loop().await;

                // 启动 Sidecar（不阻塞 setup，后台 spawn）
                // 失败时通过 Tauri event 通知前端
                if let Err(e) = sidecar_manager_for_setup.start().await {
                    log::error!("[setup] sidecar start failed: {}", e);
                } else {
                    log::info!("[setup] sidecar started successfully");
                }
            });

            // 注册到 Tauri State（前端可通过 invoke('sidecar_status') 调用）
            // SidecarManager 已实现 Clone（内部所有字段都是 Arc），Tauri State 内部会 Arc 包装
            _app.manage(sidecar_manager);

            Ok(())
        })
        .manage(pty::PtyState::default())
        .manage(shell::ShellState::default())
        .manage(secrets::SecretsState::default())
        .manage(fs::watch::FsWatchState::default())
        .manage(history::HistoryState::default())
        .manage(lsp::LspState::default())
        .manage(fs::grep::ContentSearchState::default())
        // TDSF 魔改 (P4-T4.1): SSH 远程资源管理器全局状态 (sessions + sftp_sessions 缓存)
        .manage(ssh::SshState::default())
        .manage({
            let registry = workspace::WorkspaceRegistry::default();
            workspace::bootstrap_registry(&registry);
            if let Some(ref launch_dir) = cli_dir {
                let _ = registry.authorize(launch_dir);
            }
            registry
        })
        .manage(LaunchDir(Mutex::new(cli_dir)))
        .manage(LaunchFiles(Mutex::new(launch.files)))
        .invoke_handler(tauri::generate_handler![
            pty::pty_open,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_close,
            pty::pty_close_all,
            pty::pty_has_foreground_process,
            pty::pty_has_foreground_job,
            pty::pty_shell_name,
            pty::pty_list_shells,
            fs::tree::list_subdirs,
            fs::tree::fs_read_dir,
            fs::file::fs_read_file,
            fs::file::fs_write_file,
            fs::file::fs_stat,
            fs::file::fs_canonicalize,
            fs::mutate::fs_create_file,
            fs::mutate::fs_create_dir,
            fs::mutate::fs_rename,
            fs::mutate::fs_delete,
            fs::mutate::fs_copy,
            fs::watch::fs_watch_add,
            fs::watch::fs_watch_remove,
            lsp::lsp_detect,
            lsp::lsp_host_pid,
            lsp::lsp_resolve_root,
            lsp::lsp_spawn,
            lsp::lsp_send,
            lsp::lsp_kill,
            fs::search::fs_search,
            fs::search::fs_list_files,
            fs::grep::fs_grep,
            fs::grep::fs_grep_interactive,
            fs::grep::fs_glob,
            git::commands::git_resolve_repo,
            git::commands::git_panel_snapshot,
            git::commands::git_status,
            git::commands::git_diff,
            git::commands::git_diff_content,
            git::commands::git_stage,
            git::commands::git_unstage,
            git::commands::git_discard,
            git::commands::git_commit,
            git::commands::git_fetch,
            git::commands::git_pull_ff_only,
            git::commands::git_push,
            git::commands::git_log,
            git::commands::git_show_commit,
            git::commands::git_commit_files,
            git::commands::git_commit_file_diff,
            git::commands::git_remote_url,
            git::commands::git_list_branches,
            git::commands::git_checkout_branch,
            shell::shell_run_command,
            shell::shell_session_open,
            shell::shell_session_run,
            shell::shell_session_close,
            shell::shell_bg_spawn,
            shell::shell_bg_logs,
            shell::shell_bg_kill,
            shell::shell_bg_list,
            workspace::wsl_list_distros,
            workspace::wsl_default_distro,
            workspace::wsl_home,
            workspace::workspace_authorize,
            workspace::workspace_current_dir,
            get_launch_dir,
            get_launch_files,
            open_settings_window,
            agent::agent_enable_hooks,
            agent::agent_hooks_status,
            secrets::secrets_get,
            secrets::secrets_set,
            secrets::secrets_delete,
            secrets::secrets_get_all,
            net::lm_ping,
            net::ai_http_request,
            net::ai_http_stream,
            history::history_suggest,
            history::history_commands,
            history::history_record,
            history::history_list,
            // T2.1: Python Sidecar 管理 + IPC 协议层
            sidecar::sidecar_start,
            sidecar::sidecar_stop,
            sidecar::sidecar_restart,
            sidecar::sidecar_status,
            // TDSF 魔改 P2-3: Sidecar 日志查看 (前端 TDSFPanelSection 调用)
            sidecar::sidecar_logs,
            sidecar::sidecar_logs_clear,
            ipc::ipc_invoke,
            ipc::ipc_notify,
            // TDSF 魔改 (P4-T4.1): SSH 远程资源管理器 (russh 0.61 + SFTP)
            // ssh_*: SSH 连接/PTY 读写/窗口调整/断开/状态查询/TOFU 主机审批
            // sftp_*: 远程文件 list/stat/read/write/mkdir/remove/rename
            ssh::ssh_connect,
            ssh::ssh_write,
            ssh::ssh_resize,
            ssh::ssh_disconnect,
            ssh::ssh_status,
            ssh::ssh_approve_host,
            ssh::sftp_list,
            ssh::sftp_stat,
            ssh::sftp_read,
            ssh::sftp_write,
            ssh::sftp_mkdir,
            ssh::sftp_remove,
            ssh::sftp_rename,
            // TDSF 魔改: SSH 测试连接 + 凭据持久化 (永久保存密钥 + 自动登录)
            ssh::ssh_test,
            // TDSF 魔改 P0-D (2026-07-30): SSH exec 命令执行 (运维 Agent 用)
            // 复用 Handle 开 channel.exec(),返回 {ok, output, stderr, exit_code, duration}
            ssh::ssh_command,
            ssh::credentials::ssh_credentials_save,
            ssh::credentials::ssh_credentials_list,
            ssh::credentials::ssh_credentials_delete,
            ssh::credentials::ssh_credentials_touch,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            match event {
                // Servers exit on stdin EOF, but destructors are not guaranteed
                // on process exit; kill explicitly.
                tauri::RunEvent::Exit => {
                    if let Some(state) = app.try_state::<lsp::LspState>() {
                        state.kill_all();
                    }
                    // T2.1: 优雅退出 Python Sidecar
                    if let Some(sidecar) = app.try_state::<sidecar::SidecarManager>() {
                        let sidecar = sidecar.inner().clone();
                        tauri::async_runtime::block_on(async move {
                            let _ = sidecar.stop().await;
                        });
                    }
                }
                // macOS delivers "Open With" files here, not as argv (cold and
                // warm start, several at once). Seed the drain-once state and
                // emit; canonicalize so the /tmp -> /private/tmp symlink can't
                // defeat openFileTab's path dedupe against a CLI launch.
                #[cfg(target_os = "macos")]
                tauri::RunEvent::Opened { urls } => {
                    let entries = urls
                        .iter()
                        .filter_map(|u| u.to_file_path().ok())
                        .filter_map(|p| std::fs::canonicalize(p).ok())
                        .filter(|p| p.is_file())
                        .map(LaunchEntry::File)
                        .collect();
                    let target = resolve_launch_target(entries);
                    if target.files.is_empty() {
                        return;
                    }
                    if let Some(dir) = &target.dir {
                        if let Some(registry) = app.try_state::<workspace::WorkspaceRegistry>() {
                            let _ = registry.authorize(dir);
                        }
                        if let Some(state) = app.try_state::<LaunchDir>() {
                            *state.0.lock().expect("LaunchDir mutex poisoned") = Some(dir.clone());
                        }
                    }
                    if let Some(state) = app.try_state::<LaunchFiles>() {
                        *state.0.lock().expect("LaunchFiles mutex poisoned") = target.files.clone();
                    }
                    // TDSF 魔改: terax:open-file → tdsf:open-file（与全局 Terax→TDSF 清洗对齐）
                    let _ = app.emit("tdsf:open-file", target.files);
                }
                _ => {}
            }
        });
}

#[cfg(test)]
mod settings_label_tests {
    use super::{is_settings_label, next_settings_label};

    #[test]
    fn fresh_app_uses_base_label() {
        assert_eq!(next_settings_label(&["main".into()]), "settings");
    }

    #[test]
    fn zombie_base_label_falls_back_to_dash_one() {
        let existing = vec!["main".into(), "settings".into()];
        assert_eq!(next_settings_label(&existing), "settings-1");
    }

    #[test]
    fn multiple_zombies_pick_next_free_suffix() {
        let existing = vec![
            "main".into(),
            "settings".into(),
            "settings-1".into(),
            "settings-2".into(),
        ];
        assert_eq!(next_settings_label(&existing), "settings-3");
    }

    #[test]
    fn label_matcher_accepts_base_and_suffixed_only() {
        assert!(is_settings_label("settings"));
        assert!(is_settings_label("settings-1"));
        assert!(is_settings_label("settings-42"));
        assert!(!is_settings_label("main"));
        assert!(!is_settings_label("settingsx"));
    }
}

#[cfg(test)]
mod launch_target_tests {
    use super::{resolve_launch_target, LaunchEntry, LaunchTarget};
    use std::path::PathBuf;

    #[test]
    fn no_entries_resolves_to_empty() {
        assert_eq!(resolve_launch_target(vec![]), LaunchTarget::default());
    }

    #[test]
    fn dir_arg_sets_workspace_and_opens_nothing() {
        let out = resolve_launch_target(vec![LaunchEntry::Dir(PathBuf::from("/home/u/proj"))]);
        assert_eq!(out.dir.as_deref(), Some("/home/u/proj"));
        assert!(out.files.is_empty());
    }

    #[test]
    fn file_arg_opens_file_and_uses_parent_as_workspace() {
        let out =
            resolve_launch_target(vec![LaunchEntry::File(PathBuf::from("/home/u/proj/main.rs"))]);
        assert_eq!(out.dir.as_deref(), Some("/home/u/proj"));
        assert_eq!(out.files, vec!["/home/u/proj/main.rs".to_string()]);
    }

    #[test]
    fn multiple_files_all_open_and_first_parent_wins() {
        let out = resolve_launch_target(vec![
            LaunchEntry::File(PathBuf::from("/a/one.txt")),
            LaunchEntry::File(PathBuf::from("/b/two.txt")),
        ]);
        assert_eq!(out.dir.as_deref(), Some("/a"));
        assert_eq!(
            out.files,
            vec!["/a/one.txt".to_string(), "/b/two.txt".to_string()]
        );
    }

    #[test]
    fn explicit_dir_takes_precedence_over_file_parent() {
        let out = resolve_launch_target(vec![
            LaunchEntry::Dir(PathBuf::from("/workspace")),
            LaunchEntry::File(PathBuf::from("/other/x.rs")),
        ]);
        assert_eq!(out.dir.as_deref(), Some("/workspace"));
        assert_eq!(out.files, vec!["/other/x.rs".to_string()]);
    }
}

/// 定位 Python Sidecar 脚本路径
///
/// 查找顺序:
/// 1. 开发模式: <workspace_root>/sidecar/main.py
///    - workspace_root 通过 CARGO_MANIFEST_DIR 推导 (即 src-tauri/ 父目录)
/// 2. 兜底: 同样返回 dev 路径（启动时若文件不存在会报错并写日志）
fn locate_sidecar_script() -> PathBuf {
    // 开发模式: sidecar 目录直接位于 src-tauri/sidecar/（与 Cargo.toml 同级）
    // prod 模式: 通过 tauri resource 打包（后续 task 处理）
    let manifest_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    manifest_dir.join("sidecar").join("main.py")
}
