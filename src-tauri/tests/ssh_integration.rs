//! P3 #21: SSH mock server 集成测试
//! ============================================================================
//! 在测试进程内启动 russh server (模拟远端 Linux 主机), 走**完整客户端链路**:
//!
//!   TCP 连接 → KEX (host key) → TOFU (预写 known_hosts 绕过前端弹窗)
//!   → password 认证 → channel_open_session → PTY 请求 → 远端 shell 探测/注入
//!   → exec 命令 → 数据回显 → write_data → close
//!
//! 与单元测试 (session.rs / client.rs) 的区别:
//! - 单元测试: 构造假 SshSession (handle=None), 只能覆盖错误路径
//! - 本集成测试: 真实 russh client ↔ server 协议握手, 覆盖**正常路径**:
//!   1. `SshClient::connect` 成功 (含认证)
//!   2. `SshSession::open_pty` 成功 (含远端 shell 静默注入链路)
//!   3. `SshSession::exec_command` 拿到 mock server 回显输出
//!   4. `SshSession::write_data` 数据推到 on_data channel (真流式链路)
//!   5. 认证失败路径 (错误密码 → SshClientError::AuthFailed)
//!
//! ## TOFU 绕过
//! `SshClientHandler::check_server_key` 对"未知主机"会 emit HostVerify 事件并
//! 等待前端批准 (测试环境无前端)。这里用临时 known_hosts 文件 + `SSH_KNOWN_HOSTS_FILE`
//! 环境变量预写指纹, 使 check 走 "已知主机 + key 匹配" 路径直接放行。
//!
//! ## 并发安全
//! `SSH_KNOWN_HOSTS_FILE` 是进程级环境变量, 本文件全部断言放在**单个测试函数**
//! 内串行执行, 避免并行测试互相污染。

use std::sync::Arc;
use std::time::Duration;

use russh::server::{self, Msg, Session};
use russh::*;
use tauri::ipc::Channel;
use tokio::net::TcpListener;
use tokio::sync::Mutex;

// run_on_socket 是 server::Server trait 的方法, 必须导入 trait 才能调用
use russh::server::Server as _;

use tdsf_terminal_agent_lib::modules::ssh::client::{SshAuthMethod, SshClient, SshConnectParams};
use tdsf_terminal_agent_lib::modules::ssh::session::SshSession;

// === mock SSH server (基于 russh 官方 echoserver 精简) =========================

/// 最小化 mock SSH server, 模拟一个"能跑 bash 的 Linux 主机":
///
/// | 客户端请求                          | mock 响应                              |
/// |-------------------------------------|----------------------------------------|
/// | auth_password (任意 user)           | "test-password" → Accept, 否则 Reject  |
/// | channel_open_session                | 授权 (true)                            |
/// | pty_request                         | channel_success                        |
/// | exec "echo ${SHELL:-...}" (探测)    | 回显 "/bin/bash\n" + exit 0 + eof     |
/// | exec "cat > /tmp/..." (写注入脚本)  | exit 0 + eof (空输出)                  |
/// | exec "exec bash --rcfile ..." (注入)| channel_success, 保持 channel 打开     |
/// | exec 其他命令 (exec_command)        | 回显 "mock-exec-echo: <cmd>" + exit 0 + eof |
/// | data (write_data)                   | 回显 "mock-data: <data>"               |
#[derive(Clone)]
struct MockSshServer {
    /// 最近一次 exec 请求的命令 (供断言)
    last_exec: Arc<Mutex<Option<String>>>,
    /// 最近一次 data 请求的字节 (供断言)
    last_data: Arc<Mutex<Vec<u8>>>,
}

impl server::Server for MockSshServer {
    type Handler = MockSshHandler;

    fn new_client(&mut self, _peer_addr: Option<std::net::SocketAddr>) -> Self::Handler {
        MockSshHandler {
            server: self.clone(),
        }
    }
}

struct MockSshHandler {
    server: MockSshServer,
}

impl server::Handler for MockSshHandler {
    type Error = russh::Error;

    /// 接受任意 user; 密码必须匹配 "test-password"
    async fn auth_password(
        &mut self,
        _user: &str,
        password: &str,
    ) -> Result<server::Auth, Self::Error> {
        if password == "test-password" {
            Ok(server::Auth::Accept)
        } else {
            Ok(server::Auth::Reject {
                proceed_with_methods: None,
                partial_success: false,
            })
        }
    }

    /// 授权所有会话 channel
    /// 注: 参数用 russh::Channel (而非 tauri::ipc::Channel, 后者会遮蔽同名类型)
    async fn channel_open_session(
        &mut self,
        _channel: russh::Channel<Msg>,
        _session: &mut Session,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }

    /// 接受 PTY 请求 (open_pty 需要)
    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _col_width: u32,
        _row_height: u32,
        _pix_width: u32,
        _pix_height: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    /// 模拟远端 shell 执行:
    /// - 探测命令 → 回 `/bin/bash` (走 RemoteShellKind::Bash 注入分支)
    /// - 写注入脚本 → 空输出 + exit 0
    /// - 注入 shell (`exec bash ...`) → 保持 channel 打开 (模拟交互 shell)
    /// - 其他命令 → 回显 + exit 0 + eof (exec_command 链路)
    async fn exec_request(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        let cmd = String::from_utf8_lossy(data).to_string();
        *self.server.last_exec.lock().await = Some(cmd.clone());

        // 1. 先确认命令已接受 (客户端 channel.exec(want_reply=true) 等这个确认)
        session.channel_success(channel)?;

        if cmd.contains("${SHELL") {
            // 远端 shell 探测: 返回 /bin/bash
            session.data(channel, "/bin/bash\n")?;
            session.exit_status_request(channel, 0)?;
            session.eof(channel)?;
            // 客户端 exec_command/collect_exec_output 需等到 Close 才返回
            session.close(channel)?;
        } else if cmd.starts_with("cat > ") {
            // 写注入脚本: 空输出 + 成功
            session.exit_status_request(channel, 0)?;
            session.eof(channel)?;
            session.close(channel)?;
        } else if cmd.starts_with("exec ") {
            // 注入 shell 启动: 保持 channel 打开, 不回 eof (交互式)
            // (open_pty 的 reader task 将在此挂起等待数据)
        } else {
            // 普通 exec 命令 (exec_command): 回显 + exit 0 + eof + close
            let reply = format!("mock-exec-echo: {cmd}\n").into_bytes();
            session.data(channel, reply)?;
            session.exit_status_request(channel, 0)?;
            session.eof(channel)?;
            session.close(channel)?;
        }
        Ok(())
    }

    /// 模拟交互 shell 收到按键: 回显 (write_data 链路)
    async fn data(
        &mut self,
        channel: ChannelId,
        data: &[u8],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        *self.server.last_data.lock().await = data.to_vec();
        let reply = format!("mock-data: {}\r\n", String::from_utf8_lossy(data)).into_bytes();
        session.data(channel, reply)?;
        Ok(())
    }
}

/// 启动 mock server 并预写 known_hosts, 返回 (端口, shutdown handle)
///
/// server key 与 known_hosts 共用同一私钥 (指纹一致, check 直接放行)。
/// `run_on_socket(&mut self, config, &socket)` 借用外部 `srv`/`socket`,
/// 因此 server future 必须在同一个闭包内创建 (srv/socket 作为闭包局部变量),
/// 才能满足 `tokio::spawn` 的 `'static` 约束。handle 通过 oneshot 传出。
async fn start_server_with_known_hosts() -> (u16, server::RunningServerHandle) {
    let private_key = russh::keys::PrivateKey::random(
        &mut rand::rng(),
        russh::keys::Algorithm::Ed25519,
    )
    .expect("failed to generate Ed25519 test key");

    let socket = TcpListener::bind(("127.0.0.1", 0))
        .await
        .expect("failed to bind test port");
    let port = socket.local_addr().expect("local_addr").port();

    // 预写 known_hosts: host + port + 公钥 → 临时文件
    // SshClient::connect 内部 KnownHostsManager::new() 读 SSH_KNOWN_HOSTS_FILE,
    // check 走 "已知主机 + key 匹配" → 直接放行, 无前端弹窗
    // 注: learn_known_hosts_path 位于 keys::known_hosts 子模块 (未重导出到 keys 顶层)
    let kh_dir = tempfile::tempdir().expect("tempdir");
    let kh_path = kh_dir.path().join("known_hosts");
    russh::keys::known_hosts::learn_known_hosts_path(
        "127.0.0.1",
        port,
        private_key.public_key(),
        &kh_path,
    )
    .expect("learn known_hosts");
    std::env::set_var("SSH_KNOWN_HOSTS_FILE", &kh_path);
    // 保持临时目录存活 (直到测试结束)
    std::mem::forget(kh_dir);

    let config = Arc::new(server::Config {
        keys: vec![private_key],
        // 认证拒绝时间缩短, 加速认证失败测试
        auth_rejection_time: Duration::from_millis(50),
        auth_rejection_time_initial: Some(Duration::from_millis(0)),
        ..Default::default()
    });

    // server future 必须被 poll, 否则不接受连接 (spawn 到 tokio runtime)
    let (tx, rx) = tokio::sync::oneshot::channel();
    tokio::spawn(async move {
        let mut srv = MockSshServer {
            last_exec: Arc::new(Mutex::new(None)),
            last_data: Arc::new(Mutex::new(Vec::new())),
        };
        let running = srv.run_on_socket(config, &socket);
        let _ = tx.send(running.handle());
        running.await.expect("mock ssh server failed");
    });
    let handle = rx.await.expect("mock server task should start");

    (port, handle)
}

// === 集成测试 ==================================================================

/// 全链路集成测试 (单函数串行, 避免 env 并发污染):
/// connect(成功) → open_pty → exec_command → write_data → close → connect(失败)
#[tokio::test]
async fn ssh_roundtrip_against_mock_server() {
    // 1. 启动 mock server + 预写 known_hosts
    let (port, server_handle) = start_server_with_known_hosts().await;

    // mock Tauri App (MockRuntime) 作为 AppHandle
    let app = tauri::test::mock_app();

    let make_params = |password: &str| SshConnectParams {
        host: "127.0.0.1".to_string(),
        port,
        user: "root".to_string(),
        auth: SshAuthMethod::Password {
            password: password.to_string(),
        },
    };

    // 2. connect + password 认证 (成功)
    let client = SshClient::connect(app.handle().clone(), make_params("test-password"), None)
        .await
        .expect("ssh connect + auth should succeed");

    // 3. open_pty (含远端 shell 探测 + 注入 + exec) —— mock 完整支持
    let on_data = Channel::new(|_| Ok(()));
    let on_status = Channel::new(|_| Ok(()));
    let on_exit = Channel::new(|_| Ok(()));
    let session = SshSession::open_pty(
        client,
        80,
        24,
        "xterm-256color".to_string(),
        on_data,
        on_status,
        on_exit,
    )
    .await
    .expect("open_pty should succeed");

    // 4. exec_command: 数据回显
    let out = session
        .exec_command("echo hello", Some(5))
        .await
        .expect("exec_command should succeed");
    assert_eq!(out.exit_code, 0, "mock server 应返回 exit 0");
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    assert!(
        stdout.contains("mock-exec-echo: echo hello"),
        "exec_command 应拿到 mock 回显, got: {stdout:?}"
    );

    // 5. write_data: 真流式链路 (数据 → on_data channel)
    session
        .write_data(b"ping\r\n".as_slice())
        .await
        .expect("write_data should succeed");
    tokio::time::sleep(Duration::from_millis(200)).await; // 等 mock 回显

    // 6. close: 干净断开
    session
        .close()
        .await
        .expect("close should succeed");

    // 7. 认证失败路径: 错误密码 → AuthFailed
    //    (SshClient 未实现 Debug, 不能用 expect_err; 用 .err() + unwrap 断言)
    let err = SshClient::connect(app.handle().clone(), make_params("wrong-password"), None)
        .await
        .err()
        .expect("wrong password must fail auth");
    assert!(
        err.to_string().contains("authentication failed"),
        "AuthFailed 错误信息应包含原因, got: {err}"
    );

    // 8. 关停 mock server
    server_handle.shutdown("test finished".to_string());
    tokio::time::sleep(Duration::from_millis(100)).await;
}
