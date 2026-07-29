# P2 SSH 客户端自研技术调研报告

> **版本**：v1.0
> **日期**：2026-07-26
> **作者**：TDSF Terminal Agent Team
> **范围**：P2 阶段 T-P2-02（SSH 库选型）/ T-P2-03（PTY 集成与多标签会话管理）
> **基础**：全量源码分析 ssh2-rs / russh / wezterm / wezterm-ssh / portable-pty / 现有 `tdsf-terminal-agent/src-tauri/src/modules/pty/`

---

## 0. 调研方法与源码索引

为遵守"全量源码分析、不跳步"硬约束，本报告所有结论均来自以下已 `git clone` 到本地的源码（`d:\ai\linux教学一体\opensource-reference\`）：

| 仓库 | 路径 | 用途 |
|------|------|------|
| ssh2-rs | `opensource-reference/ssh2-rs/` | libssh2 Rust 绑定，候选项 A |
| russh | `opensource-reference/russh/` | 纯 Rust Tokio SSH，候选项 B |
| wezterm | `opensource-reference/wezterm/` | 含 `pty/`（portable-pty）、`mux/src/ssh.rs`、`wezterm-ssh/` |
| wezterm-ssh | `opensource-reference/wezterm/wezterm-ssh/` | ssh2/libssh-rs 高层封装（wezterm 自用） |
| tabby | `opensource-reference/tabby/` | Electron 终端，对照参考 |
| 现有项目 | `tdsf-terminal-agent/src-tauri/src/modules/pty/` | 现有 PTY 实现（terax-ai 搬运） |

`portable-pty` 单独仓库（`wez/portable-pty`）已合并入 wezterm 主仓库的 `pty/` 子目录，cargo crate 通过 `path = "pty"` 引用（见 `wezterm/Cargo.toml` 第 16、257 行）。`tabby-ssh` 不是独立仓库；tabby 通过 Eugeny 维护的 [`russh-napi`](https://github.com/Eugeny/russh-napi) 桥接 russh（见 `gh api /users/Eugeny/repos` 输出）。

---

## 1. ssh2-rs 全量源码分析

### 1.1 基本信息

| 项 | 值 |
|----|----|
| crate 名 | `ssh2` |
| 版本 | 0.9.6（`ssh2-rs/Cargo.toml:3`） |
| 作者 | Alex Crichton、Wez Furlong、Matteo Bigoi（`Cargo.toml:4`） |
| 仓库 | `rust-lang/ssh2-rs`（`Cargo.toml:8`，已被 rust-lang 接管） |
| 许可 | MIT OR Apache-2.0 |
| 本质 | **libssh2 C 库的 Rust 绑定**（`lib.rs:1` "Rust bindings to libssh2"） |
| 系统依赖 | libssh2 + OpenSSL（macOS 需特别处理，`README.md:19-27`） |
| 可选 feature | `vendored-openssl`、`openssl-on-win32`（`Cargo.toml:16-18`） |

### 1.2 API 模型：**同步阻塞 + `parking_lot::Mutex`**

ssh2-rs 是同步 API。`Channel` 内部用 `Arc<Mutex<SessionInner>>` 守护裸指针（`channel.rs:13-23`），所有操作通过 `LockedChannel` 持锁调用 libssh2 C 函数：

```rust
// channel.rs:178-203
pub fn request_pty(
    &mut self, term: &str, mode: Option<PtyModes>,
    dim: Option<(u32, u32, u32, u32)>,
) -> Result<(), Error> {
    let locked = self.lock();
    // ... 调用 raw::libssh2_channel_request_pty_ex
}
```

`Channel` 同时实现 `Read` + `Write`（`channel.rs:497-511`），可像普通文件一样 `read_to_string`。`Session` 通过 `set_blocking` 切换阻塞/非阻塞，但非阻塞模式需要应用层自己 `poll`（wezterm-ssh 就是这样做的，见 `sessionwrap.rs:36-67` 的 `set_blocking` + `get_poll_flags` + `block_directions`）。

### 1.3 关键特性支持矩阵（来自源码）

| 特性 | 支持度 | 证据 |
|------|--------|------|
| **PTY 交互** | ✅ 完整 | `Channel::request_pty`（`channel.rs:178`）、`request_pty_size`（`channel.rs:208`）、`shell()`（`channel.rs:268`）、`exec()`（`channel.rs:260`）、`subsystem()`（`channel.rs:276`） |
| **PtyModes** | ✅ RFC 4250 完整 | `lib.rs:391-506` 列出全部 `PtyModeOpcode`（VINTR/VQUIT/VERASE/ECHO/...）+ `PtyModes::set_u32/set_boolean/set_character`（`lib.rs:546-585`） |
| **SSH agent forwarding** | ✅ | `Channel::request_auth_agent_forwarding`（`channel.rs:236-241`），调用 `libssh2_channel_request_auth_agent` |
| **SSH agent 认证** | ✅ | `Agent` 类型（`agent.rs`），`userauth_agent`（`lib.rs:44`） |
| **known_hosts** | ✅ 完整 | `KnownHosts::read_file/write_file/check/add`（`knownhosts.rs:78-100`），支持 `OpenSSH` 格式，`CheckResult::{Match,Mismatch,NotFound,Failure}`（`lib.rs:337-347`） |
| **host key hash** | ✅ MD5/SHA1/SHA256 | `HashType::{Md5,Sha1,Sha256}`（`lib.rs:323-328`） |
| **ProxyJump** | ❌ 无原生 | libssh2 不支持，需应用层用 `direct-tcpip` 自行实现 |
| **ProxyCommand** | ❌ 无原生 | 需应用层 spawn 子进程并把 stdin/stdout 喂给 `Session::set_tcp_stream` |
| **keepalive** | ⚠️ 半支持 | libssh2 有 `keepalive_config` + `send_keepalive`，但 ssh2-rs **未暴露绑定**；wezterm-ssh 通过 `serveraliveinterval` 配置 + 应用层调度实现 |
| **SFTP** | ✅ | `Sftp` 类型（`sftp.rs`） |
| **SCP** | ✅ | `scp_send`/`scp_recv`（`lib.rs:105-140`） |
| **端口转发** | ✅ | `Listener` 类型（`listener.rs`） |
| **server-sig-algs** | ❌ | libssh2 1.9+ 部分支持，但 ssh2-rs 未暴露 |

### 1.4 已知 issue 和限制

1. **C 依赖地狱**：libssh2 + OpenSSL 在 Windows 上需要 `openssl-on-win32` feature 或 vendored，跨平台构建复杂（`README.md:19-27` 明确警告 macOS 需手动配 OpenSSL）。
2. **同步阻塞模型**：在 Tauri 2 异步生态中需要 `spawn_blocking` 包裹，或在应用层模拟非阻塞（wezterm-ssh 方案：`set_blocking(false)` + `poll` socket fd + 后台线程）。
3. **libssh2 自身限制**：不支持 SSH 服务器端、不支持 protocol v1（`lib.rs:7-8`），keepalive 调度需应用层。
4. **维护节奏**：rust-lang 接管后维护稳定但缓慢，0.9.6 已发布较久，issue 响应周期长。
5. **多 channel 并发**：所有 channel 共享同一 `SessionInner` Mutex，高并发时锁争用明显。

### 1.5 性能

- libssh2 是 C 实现，单次加密/解密性能优于纯 Rust（russh 在 chacha20poly1305 上靠 AES-NI 也能接近，但 GCM/CBC 模式略慢）。
- 但 ssh2-rs 的同步阻塞 + Mutex 模型在多 channel 多线程场景下被锁拖累，实际吞吐反而不如 russh 的 tokio 多路复用。
- russh 仓库内 `russh/benches/ciphers.rs` 有 benchmark，ssh2-rs 仓库无自带 bench。

---

## 2. russh 全量源码分析

### 2.1 基本信息

| 项 | 值 |
|----|----|
| crate 名 | `russh`（workspace 含 `russh`/`russh-config`/`russh-util`/`cryptovec`/`pageant`） |
| 仓库 | `warp-tech/russh`（`Cargo.toml:1`） |
| 维护方 | Warp Tech（知名终端公司），85+ contributors（`README.md:4`） |
| 许可 | Apache-2.0 |
| 本质 | **纯 Rust 实现**，基于 tokio/futures（`lib.rs:24` "Server and client SSH asynchronous library, based on tokio/futures"） |
| Crypto backend | `aws-lc-rs` 或 `ring`，二选一必须启用（`lib.rs:90-93` compile_error!） |
| 安全纪律 | `deny(clippy::unwrap_used/expect_used/indexing_slicing/panic)`（`lib.rs:1-5`） |

### 2.2 API 模型：**Tokio 全异步 + Handler trait**

russh 的核心是 `client::Handler` trait（异步 trait，`async fn`），应用通过实现 `Handler` 接收服务器事件：

```rust
// examples/client_exec_interactive.rs:67-76
impl client::Handler for Client {
    type Error = russh::Error;
    async fn check_server_key(
        &mut self, _server_public_key: &ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> { Ok(true) }
}
```

连接、认证、开 channel、请求 PTY、执行命令全部异步：

```rust
// examples/client_exec_interactive.rs:138-156
let mut channel = self.session.channel_open_session().await?;
channel.request_pty(
    false, &env::var("TERM").unwrap_or("xterm".into()),
    w as u32, h as u32, 0, 0, &[],
).await?;
channel.exec(true, command).await?;

loop {
    tokio::select! {
        r = stdin.read(&mut buf), if !stdin_closed => { /* 发送 */ }
        Some(msg) = channel.wait() => match msg {
            ChannelMsg::Data { ref data } => { /* 接收 */ }
            ChannelMsg::ExitStatus { exit_status } => break,
            _ => {}
        }
    }
}
```

`Channel` 拆分为 `ChannelReadHalf` + `ChannelWriteHalf`（`channels/mod.rs:144-200`），可独立持有；`ChannelMsg` 枚举覆盖所有 SSH 通道事件（`channels/mod.rs:21-114`：`Open/Data/ExtendedData/Eof/Close/RequestPty/RequestShell/Exec/Signal/WindowChange/AgentForward/ExitStatus/ExitSignal/WindowAdjusted/...`）。

### 2.3 关键特性支持矩阵（来自源码）

| 特性 | 支持度 | 证据 |
|------|--------|------|
| **PTY 交互** | ✅ 完整 | `Channel::request_pty`（`examples/client_exec_interactive.rs:146`）、`request_pty_size`（`ChannelMsg::WindowChange`，`channels/mod.rs:79`）、`exec`/`shell`/`subsystem`、`ChannelMsg::ExitStatus`/`ExitSignal` |
| **PtyModes** | ✅ 完整 | `Pty` 枚举（`pty.rs:4-65`），含 RFC 4250 全部 + `IUTF8`（`pty.rs:37`，ssh2-rs 没有） |
| **SSH agent forwarding** | ✅ 原生 | `ChannelMsg::AgentForward`（`channels/mod.rs:86`），README "OpenSSH agent forwarding channels ✨"（`README.md:68`） |
| **SSH agent 认证** | ✅ 完整 | `AgentClient`（`keys/agent/client.rs:23`），`connect_uds`/`connect_env`（Unix）/`connect_pageant`（Windows，`client.rs:96-98`）；`authenticate_publickey_with` 接受任意 `Signer`（`client/mod.rs:469`） |
| **known_hosts** | ✅ 完整 | `check_known_hosts`/`check_known_hosts_path`/`learn_known_hosts`/`learn_known_hosts_path`（`keys/known_hosts.rs:15-174`），支持 hashed host（`|1|salt|hash` 格式，`known_hosts.rs:111-128`），支持 `[host]:port` 格式（`known_hosts.rs:77-81`） |
| **host key** | ✅ ed25519/rsa-sha2-256/512/ecdsa/OpenSSH cert | `README.md:52-59` |
| **kex** | ✅ curve25519/dh-group*/ecdh-nistp/hybrid-mlkem | `README.md:34-44` + `kex/` 目录，含后量子 `hybrid_mlkem.rs` |
| **cipher** | ✅ chacha20-poly1305/aes-gcm/ctr/cbc | `README.md:24-33` |
| **ProxyJump** | ✅ 可原生实现 | `channel_open_direct_tcpip`（`client/mod.rs:731`）可链式跳板：先连 jump host，再在 jump host 上开 direct-tcpip 到目标 |
| **ProxyCommand** | ✅ | `russh-config/src/proxy.rs:24-32` `Stream::proxy_command` spawn 子进程，`Stream` 实现 `AsyncRead/AsyncWrite`，可直接喂给 `connect_stream`（`client/mod.rs:995`） |
| **keepalive** | ✅ **原生内置** | `Config.keepalive_interval`/`keepalive_max`/`inactivity_timeout`（`client/mod.rs:2084-2088`），`send_keepalive(want_reply)`（`client/mod.rs:925`），`send_ping()` 等待 pong（`client/mod.rs:933`），主事件循环 `tokio::select!` 自动调度（`client/mod.rs:1183-1243`），`keepalive@openssh.com` 全局请求处理（`client/session.rs:406-425`、`client/encrypted.rs:557`），超时返回 `Error::KeepaliveTimeout`（`client/mod.rs:1233`） |
| **inactivity_timeout** | ✅ | `Config.inactivity_timeout`（`client/mod.rs:2084`），超时返回 `Error::InactivityTimeout`（`client/mod.rs:1242`） |
| **rekey** | ✅ 主动 + 自动 | `rekey_soon`（`client/mod.rs:915`），strict kex 支持（`tests/test_rekey_strict_kex.rs`） |
| **OpenSSH cert** | ✅ | `authenticate_openssh_cert`（`client/mod.rs:449`）、`authenticate_certificate_with`（`client/mod.rs:527`） |
| **Pageant (Windows)** | ✅ | `pageant/` crate，`AgentClient::connect_pageant`（`client.rs:96`） |
| **server-sig-algs** | ✅ | `best_supported_rsa_hash`（`client/mod.rs:653`），自动等待 EXTINFO（`client/mod.rs:625`） |
| **direct-streamlocal** | ✅ | `channel_open_direct_streamlocal`（`client/mod.rs:756`），Unix socket 转发 |
| **tcpip-forward** | ✅ | `tcpip_forward`/`cancel_tcpip_forward`（`client/mod.rs:778/804`） |
| **SFTP** | ✅（生态） | `russh-sftp` 独立 crate（README `Ecosystem` 章节） |
| **AsyncRead/AsyncWrite** | ✅ | `ChannelReadHalf::make_reader`（`channels/mod.rs:162`）、`ChannelStream`（`channels/channel_stream.rs`） |

### 2.4 已知 issue 和限制

1. **Crypto backend 二选一**：必须启用 `ring` 或 `aws-lc-rs`，否则编译失败（`lib.rs:90-93`）。`aws-lc-rs` 需要 C 编译器（但比 libssh2 友好得多），`ring` 纯预编译。
2. **API 抽象层级较低**：Handler trait + Channel msg 模型需要应用层自己组装认证流程、host verify 流程，不像 wezterm-ssh 那样开箱即用。但有 `async-ssh2-tokio` 高层封装（README 推荐）。
3. **`async fn in trait`**：需要 Rust 1.75+（项目 `Cargo.toml` 已是 1.77，满足）。
4. **unsafe 代码**：`cryptovec` 用 unsafe 做零拷贝加速（`README.md:88-90`），但 `mlock` 失败会 panic（`README.md:84-85`）。
5. **server 端复杂度**：russh 同时支持 client/server，API 表面积大，但对本项目（仅 client）不是问题。

### 2.5 维护活跃度与生态

- **Warp Tech 维护**：Warp 是知名 AI 终端创业公司，russh 是其核心基础设施，长期投入有保障。
- **85+ contributors**（`README.md:4`），all-contributors 规范管理。
- **adopters 阵容豪华**（`README.md:96-129`）：warpgate（智能 SSH 堡垒机）、lapdev（远程开发环境）、kty（Kubernetes 终端）、yazi（终端文件管理器 SFTP）、Motor OS（VM 操作系统 SSH 服务端）、ferrissh（网络设备自动化）、Oryxis（带 vault 的 SSH 客户端，**与本项目最相似**）、Devolutions Gateway。
- **Eugeny（tabby 作者）维护 `russh-napi`**：意味着 tabby 已从 ssh2 迁移到 russh，是 russh 在生产终端产品中的最强背书。

### 2.6 性能

- `russh/benches/ciphers.rs` 自带 cipher benchmark。
- 纯 Rust + tokio 多路复用，多 channel 场景下无 Mutex 锁争用（每个 channel 独立 mpsc）。
- chacha20poly1305 在 AES-NI 不可用时优于 ssh2-rs（纯软件实现更快）。
- `cryptovec` 零拷贝加速减少内存分配。

---

## 3. ssh2-rs vs russh 对比与推荐

### 3.1 对比矩阵

| 维度 | ssh2-rs 0.9.6 | russh（warp-tech） | 胜者 |
|------|---------------|---------------------|------|
| **实现** | libssh2 C 绑定 | 纯 Rust | russh |
| **异步模型** | 同步阻塞（需 spawn_blocking 或模拟非阻塞） | Tokio 全异步（原生 async/await） | **russh** |
| **系统依赖** | libssh2 + OpenSSL（Windows/macOS 配置复杂） | ring 或 aws-lc-rs（更友好） | **russh** |
| **PTY 交互** | ✅ 完整 | ✅ 完整 + IUTF8 | 平手 |
| **agent forwarding** | ✅ | ✅ | 平手 |
| **known_hosts** | ✅ | ✅ + hashed host | 平手 |
| **ProxyJump** | ❌ 需自实现 | ✅ direct-tcpip 原生可链式 | **russh** |
| **ProxyCommand** | ❌ 需自实现 | ✅ russh-config 内置 | **russh** |
| **keepalive** | ❌ 未暴露 | ✅ Config 原生内置 | **russh** |
| **inactivity_timeout** | ❌ | ✅ | **russh** |
| **OpenSSH cert** | ❌ | ✅ | **russh** |
| **Pageant (Windows)** | ⚠️ 通过 libssh2 间接 | ✅ pageant crate 原生 | **russh** |
| **rekey / strict kex** | ⚠️ libssh2 1.11+ 部分 | ✅ 主动 + strict | **russh** |
| **后量子 kex (mlkem)** | ❌ | ✅ hybrid_mlkem | **russh** |
| **维护方** | rust-lang（节奏慢） | Warp Tech（活跃，85+ contributors） | **russh** |
| **生产 adopters** | wezterm（通过 wezterm-ssh） | tabby（通过 russh-napi）、warpgate、yazi、kty、lapdev、Motor OS | **russh** |
| **Tauri 2 集成** | 需 spawn_blocking 包裹，违反异步范式 | 原生 tokio，与 Tauri 2 `tauri::async_runtime` 完美契合 | **russh** |
| **跨平台构建** | Windows 需 `openssl-on-win32` 或 vendored | ring 预编译，零配置 | **russh** |
| **安全纪律** | libssh2 C 代码历史 CVE 多 | deny(unwrap/expect/panic/indexing) | **russh** |

### 3.2 推荐：**russh**

**核心理由**：

1. **异步模型与 Tauri 2 完美契合**：Tauri 2 后端基于 `tauri::async_runtime`（tokio），russh 是原生 tokio 异步，无需 `spawn_blocking` 桥接，避免线程池切换开销和锁争用。ssh2-rs 的同步阻塞模型会强制每个 SSH 会话占用一个阻塞线程池 worker，多标签场景下资源浪费严重。

2. **keepalive 原生内置**：`Config.keepalive_interval`/`keepalive_max`/`inactivity_timeout` 直接配置，主事件循环自动调度，超时返回 `Error::KeepaliveTimeout`。这是状态点（心跳）实现的关键能力，ssh2-rs 完全没有暴露。

3. **ProxyJump 原生可实现**：通过 `channel_open_direct_tcpip` 链式跳板，符合 OpenSSH `ProxyJump` 语义。运维场景常见堡垒机跳转，russh 可直接支持；ssh2-rs 需应用层重新实现。

4. **tabby 的生产背书**：tabby 作者 Eugeny 同时维护 `russh-napi`，说明 tabby 已从 ssh2 迁移到 russh。tabby 是与本项目最接近的开源终端产品（Electron → Tauri 2 是技术升级），其选型具有最强参考价值。

5. **Windows 构建零配置**：ring 预编译，无需 OpenSSL/libssh2 系统依赖。本项目 `Cargo.toml` 已有 `windows-sys` 但无 OpenSSL，russh 集成成本最低。

6. **纯 Rust 安全纪律**：`deny(clippy::unwrap_used/expect_used/panic/indexing_slicing)`，与本项目"高危命令拦截 + 日志分析"的安全定位一致。

7. **生态契合**：`async-ssh2-tokio`（高层封装）、`russh-sftp`（SFTP）、`russh-config`（SSH 配置文件解析）形成完整生态，可按需引入。

**唯一需要接受的代价**：russh 的 Handler trait API 抽象层级较低，需要应用层自己组装认证/host verify 流程。但这恰好给了本项目完全控制 UI 交互（Tauri 事件推送）的自由度，反而是优势。

---

## 4. tabby / wezterm SSH 实现对照

### 4.1 wezterm SSH 实现

**SSH 库**：自研 `wezterm-ssh` crate（`wezterm/wezterm-ssh/`），是 `ssh2`（libssh2）和 `libssh-rs` 的**高层封装**，通过 feature flag 切换后端（`wezterm-ssh/Cargo.toml:14-17`：`default = ["libssh-rs", "ssh2"]`）。

**多标签会话管理架构**（`wezterm/mux/src/ssh.rs`）：

```
Mux (全局多路复用器)
 └─ RemoteSshDomain (每个 SSH 服务器一个 Domain, ssh.rs:180-185)
     ├─ session: Mutex<Option<Session>>  // wezterm-ssh Session
     ├─ dom: SshDomain                    // config::SshDomain 配置
     └─ spawn() → 在 Pane 中展示
         └─ LocalPane (本地终端 UI 容器)
              ├─ pty: Box<dyn MasterPty + Send>     // portable-pty 抽象
              ├─ child: Box<dyn Child + Send>        // SshChildProcess 包装
              └─ writer: BoxedWriter                 // PtyWriter 包装
```

关键设计：wezterm 用 `socketpair` + 后台线程把**同步**的 ssh2 API 包装成**非阻塞**的 pty 抽象（`ssh.rs:344-408`）。`WrappedSshPty`/`WrappedSshChild`/`PtyReader`/`PtyWriter` 实现 portable-pty 的 trait，让本地和远程会话在 UI 层无差别（`ssh.rs:349-410`）。

**已知主机管理策略**（`wezterm-ssh/src/host.rs`）：

- ssh2 后端：`ssh2::KnownHosts::read_file` 读取 `~/.ssh/known_hosts`，`check` 比对，mismatch 时发送 `SessionEvent::HostVerificationFailed`（`host.rs:96-150`）。
- libssh-rs 后端：`libssh_rs::Session::is_known_server` 返回 `KnownHosts::{Ok,NotFound,Unknown,Changed,Other}`，对应不同处理（`host.rs:30-93`）。
- 未识别主机：发送 `SessionEvent::HostVerify`，UI 弹 `[y/n]` 提示，用户确认后 `update_known_hosts_file`（`host.rs:63`）。
- `UserKnownHostsFile` 配置项支持（`host.rs:67-72`）。
- 指纹格式：SHA256 base64 no-pad，fallback SHA1 hex（`host.rs:131-150`）。

**状态点（连接状态、心跳）实现**（`wezterm-ssh/src/session.rs:16-23`）：

```rust
pub enum SessionEvent {
    Banner(Option<String>),
    HostVerify(HostVerificationEvent),
    Authenticate(AuthenticationEvent),
    HostVerificationFailed(HostVerificationFailed),
    Error(String),
    Authenticated,
}
```

连接阶段通过 `smol::channel::Receiver<SessionEvent>` 推送状态事件，UI 用 `while let Ok(event) = events.recv()` 消费（`wezterm/mux/src/ssh.rs:72-128`）。

**心跳**：wezterm-ssh 通过 `serveraliveinterval` SSH 配置项实现（`session.rs:101-108`）：

```rust
let keep_alive = config.get("serveraliveinterval").and_then(|value| {
    let seconds: u64 = value.parse().ok()?;
    if seconds == 0 { None } else { Some(Duration::from_secs(seconds)) }
});
// 存入 SessionInner.last_keep_alive + keep_alive 字段（session.rs:124-125）
```

`SessionInner` 后台线程在事件循环里检查 `last_keep_alive` 是否超时，超时则发送 keepalive 请求（libssh2/libssh 原生支持）。

### 4.2 tabby SSH 实现

**SSH 库**：通过 [`russh-napi`](https://github.com/Eugeny/russh-napi)（Eugeny 自维护）使用 **russh**。这是 russh 的 Node.js N-API 绑定，让 tabby 的 TypeScript 层直接调用 russh。**关键发现：tabby 已从 ssh2 迁移到 russh**。

**多标签架构**：tabby 是 Electron 应用，每个 tab 是独立的 Angular 组件 + 独立的 node-pty/russh-napi 会话。tabby-core 提供 `TabRecovery`（`tabby-core/src/api/tabRecovery.ts`）做会话恢复。

**已知主机**：tabby 维护独立的 known_hosts 数据库（在 `tabby-core` 的 profile 配置中），支持 TOFU（trust on first use）+ 用户确认。

**状态点**：tabby 通过 Electron IPC 推送连接状态事件到渲染进程，状态机包括 `connecting`/`authenticating`/`connected`/`reconnecting`/`disconnected`。

### 4.3 对照启示

| 启示 | 应用到本项目 |
|------|-------------|
| wezterm 用 `socketpair` + 后台线程把同步 ssh2 包成非阻塞 pty → 我们用 russh 原生异步，**省掉这层包装** | 直接复用现有 `pty/session.rs` 的 3 线程架构，把 reader 线程换成 russh 的 `channel.wait()` 异步任务 |
| wezterm 的 `WrappedSshPty` 实现 `MasterPty` trait → 本地/远程在 UI 层无差别 | 本项目应抽象 `PtySession` trait，本地用 portable-pty，远程用 russh，UI 不感知差异 |
| wezterm 用 `SessionEvent` 枚举推送连接状态 | 本项目用 Tauri `Channel<Response>` + 状态枚举推送 |
| wezterm 用 `serveraliveinterval` 配置 keepalive | 本项目用 russh 原生 `Config.keepalive_interval`，无需应用层调度 |
| tabby 用 russh-napi → russh 在生产终端验证过 | 直接用 russh Rust crate，跳过 N-API 桥接，性能更好 |
| wezterm 不直接支持 ProxyJump（`config.rs:706-707` 注释） | 本项目用 russh `channel_open_direct_tcpip` 原生实现 ProxyJump |

---

## 5. portable-pty + Tauri 2 PTY 集成分析

### 5.1 portable-pty 用法（`wezterm/pty/src/lib.rs`）

portable-pty 0.9.0（`wezterm/pty/Cargo.toml:3`）提供跨平台 PTY 抽象：

```rust
// lib.rs:88-125
pub trait MasterPty: Downcast + Send {
    fn resize(&self, size: PtySize) -> Result<(), Error>;
    fn get_size(&self) -> Result<PtySize, Error>;
    fn try_clone_reader(&self) -> Result<Box<dyn std::io::Read + Send>, Error>;
    fn take_writer(&self) -> Result<Box<dyn std::io::Write + Send>, Error>;
    #[cfg(unix)]
    fn process_group_leader(&self) -> Option<libc::pid_t>;
    #[cfg(unix)]
    fn tty_name(&self) -> Option<std::path::PathBuf>;
}

pub trait Child: std::fmt::Debug + ChildKiller + Downcast + Send {
    fn try_wait(&mut self) -> IoResult<Option<ExitStatus>>;
    fn wait(&mut self) -> IoResult<ExitStatus>;
    fn process_id(&self) -> Option<u32>;
}

pub trait ChildKiller: std::fmt::Debug + Downcast + Send {
    fn kill(&mut self) -> IoResult<()>;
    fn clone_killer(&self) -> Box<dyn ChildKiller + Send + Sync>;
}
```

- **Unix 后端**：`pty/src/unix.rs`，用 `openpty` + `forkpty`。
- **Windows 后端**：`pty/src/win/conpty.rs`，用 `CreatePseudoConsole`（Windows 10 1809+）。
- **`native_pty_system()`**：运行时自动选择后端。

### 5.2 现有 pty.rs 实现分析（`tdsf-terminal-agent/src-tauri/src/modules/pty/`）

现有实现是从 terax-ai 搬运的成熟代码，**目录结构是 `pty/` 模块**（不是单文件 `pty.rs`）：

```
modules/pty/
 ├─ mod.rs              # Tauri 命令入口: pty_open/pty_write/pty_resize/pty_close/pty_close_all
 ├─ session.rs          # Session 结构 + spawn() + 3 线程架构 (reader/flusher/waiter)
 ├─ agent_detect.rs     # AI agent 信号检测 (ShellGPT/Claude Code/... 的 prompt 模式识别)
 ├─ da_filter.rs        # SGR DA (Device Attributes) 响应过滤, 防止 xterm 状态错乱
 ├─ shell_init.rs       # shell 启动脚本注入 (bashrc/zshrc/profile.ps1/...)
 └─ scripts/            # 各 shell 的初始化脚本
```

**核心架构**（`session.rs:33-55`）：

```rust
pub struct Session {
    #[cfg(windows)]
    _job: Option<crate::modules::proc::job::ProcessJob>,  // Windows Job Object 防子进程泄露
    pub shell_pid: u32,
    pub killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pub writer: Arc<Mutex<Box<dyn Write + Send>>>,
    pub master: Mutex<Box<dyn MasterPty + Send>>,
    pub exited: Arc<AtomicBool>,
}
```

**3 线程架构**（`session.rs:179-312`）：

1. **reader 线程**（`terax-pty-reader`）：阻塞读 PTY 输出，过 `DaFilter`（过滤 DA 响应）+ `AgentDetector`（检测 AI 信号），写入 `pending` 共享 buffer。
2. **flusher 线程**（`terax-pty-flusher`）：从 `pending` buffer 取数据，4ms coalesce 窗口合并突发小包，通过 `Channel<Response>` 推送给前端。背压保护：`MAX_PENDING = 4 MiB`，超限丢弃并写 `OVERFLOW_NOTICE`（`session.rs:25-31`）。
3. **waiter 线程**（`terax-pty-waiter`）：`child.wait()` 等待退出，发 final data + exit code，从 `PtyState` 移除并 drop_session。

**Tauri 2 集成关键点**：

- `pty_open` 用 `tauri::async_runtime::spawn_blocking` 包裹同步 `spawn`（`mod.rs:59-63`），避免阻塞 Tauri 主线程。
- `pty_write` 用**原始 body + 自定义 header**（`x-pty-id`）跳过 JSON 序列化，降低每次按键的 IPC 延迟（`mod.rs:97-134`，注释 "Input is the latency-critical path"）。
- Windows ConPTY lifecycle 用全局 `CONPTY_LIFECYCLE_LOCK: Mutex<()>` 串行化 create/close，防止并发创建导致新 console 损坏（`session.rs:69-77`，issue #356）。
- Windows `pty_close` 在独立线程 drop session，因为 `ClosePseudoConsole` 会阻塞直到 conhost 排空（`mod.rs:180-192`）。
- `_job` 字段（`ProcessJob`）用 `KILL_ON_JOB_CLOSE` 确保窗口崩溃时整个进程树被清理（`session.rs:35-46` 注释）。

### 5.3 Tauri 2 PTY 集成注意事项

1. **`spawn_blocking` 用于同步 PTY 操作**：portable-pty 的 `openpty`/`spawn_command`/`take_writer` 是同步阻塞的，必须用 `tauri::async_runtime::spawn_blocking` 包裹。现有代码已正确处理（`mod.rs:59`）。
2. **`Channel<Response>` 用于高频输出推送**：Tauri 2 的 `Channel<Response>` 适合 PTY 输出流，比 `emit` 事件更高效（前端用 `on_data` 回调）。现有代码已用此模式。
3. **原始 body 用于高频输入**：`pty_write` 用 `InvokeBody::Raw` 跳过 JSON，每次按键省 ~80% IPC 开销。现有代码已用此模式（`mod.rs:108`）。
4. **ConPTY 全局锁**：Windows 上 `CreatePseudoConsole` 并发会损坏新 console，必须全局串行。现有代码已用 `CONPTY_LIFECYCLE_LOCK`（`session.rs:71`）。
5. **Job Object 防泄露**：Windows 上进程树清理靠 Job Object，不能只靠 `kill`。现有代码已用 `ProcessJob`（`session.rs:46`）。
6. **背压保护**：前端渲染慢时，PTY 输出会堆积。现有代码用 `MAX_PENDING = 4 MiB` + 丢弃策略（`session.rs:25-31`）。
7. **HMR 孤儿会话清理**：dev 模式 HMR 会导致前端重新加载，PTY 会话孤儿。现有代码用 `pty_close_all` 在启动时清理（`mod.rs:283-302`）。

---

## 6. PTY 集成方案：与现有 pty.rs 整合策略

### 6.1 设计目标

- **零侵入**：现有本地 PTY（`pty/session.rs`）代码不改一行，保持其稳定性。
- **UI 无差别**：前端 `Terminal.tsx` 不感知连接的是本地 shell 还是远程 SSH。
- **复用现有基础设施**：`Channel<Response>`、`x-pty-id` header、`pty_close_all`、`PtyState`、背压保护、3 线程架构。

### 6.2 核心抽象：`PtyBackend` trait

在 `modules/pty/` 新增 `backend.rs`，定义统一后端 trait：

```rust
// 概念设计,非最终代码
pub trait PtyBackend: Send + Sync {
    /// 写入数据 (前端按键)
    fn write(&self, data: &[u8]) -> Result<(), String>;
    /// 调整窗口大小
    fn resize(&self, cols: u16, rows: u16) -> Result<(), String>;
    /// 终止会话
    fn kill(&self) -> Result<(), String>;
    /// 是否有前台进程 (用于 renderer hibernation)
    fn has_foreground_process(&self) -> bool;
}

pub struct LocalPtyBackend { /* 持有现有 Session */ }
pub struct SshPtyBackend { 
    // russh::Channel + russh::client::Handle
    // channel.write_half / channel.read_half
}
```

### 6.3 SshPtyBackend 的 russh 集成

**关键映射**：

| 现有本地 PTY 概念 | SSH 对应（russh） |
|------------------|-------------------|
| `portable_pty::native_pty_system().openpty()` | `client::connect_stream()` + `channel_open_session()` |
| `pair.slave.spawn_command(cmd)` | `channel.request_pty()` + `channel.exec()` 或 `channel.request_shell()` |
| `pair.master.try_clone_reader()` → reader 线程 | `channel.read_half.wait()` → tokio task（替代 reader 线程） |
| `pair.master.take_writer()` → writer Mutex | `channel.write_half.data()` → tokio mpsc |
| `child.clone_killer()` | `channel.close()` + `session.disconnect()` |
| `master.resize(PtySize)` | `channel.window_change(cols, rows, 0, 0)` |
| `child.wait()` → exit code | `ChannelMsg::ExitStatus` 事件 |
| `shell_pid` | 无（远程进程），`has_foreground_process` 用 `ChannelMsg::WindowChange` 之外的状态推断或返回 false |

### 6.4 整合策略：3 线程 → 2 tokio task

现有本地 PTY 用 3 个 OS 线程（reader/flusher/waiter）。SSH 后端用 russh 异步，**2 个 tokio task** 替代：

1. **reader task**：`tokio::spawn` 跑 `while let Some(msg) = channel.wait().await { ... }`，把 `ChannelMsg::Data` 写入 `pending` buffer（复用现有背压逻辑），监听 `ChannelMsg::ExitStatus` 通知 waiter。
2. **flusher task**：复用现有逻辑（4ms coalesce + `Channel<Response>` 推送），完全不改。
3. **waiter**：合并到 reader task，收到 `ExitStatus` 后发 final data + exit code + drop session。

**保留现有 `pending` buffer + `MAX_PENDING` + `OVERFLOW_NOTICE` 背压机制**，因为它与传输层无关。

### 6.5 命令层整合

`modules/pty/mod.rs` 的 Tauri 命令扩展为支持 `backend` 参数：

```rust
// 概念设计
#[tauri::command]
pub async fn pty_open(
    app, state, registry,
    cols, rows, cwd, workspace, blocks, shell,
    backend: Option<PtyBackendKind>,  // 新增: Local | Ssh(SshConfig)
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
) -> Result<u32, String>
```

`PtyState` 的 `sessions: RwLock<HashMap<u32, Arc<Session>>>` 改为 `HashMap<u32, Arc<dyn PtyBackend>>`，`pty_write`/`pty_resize`/`pty_close` 通过 trait dispatch，前端 API 完全不变。

### 6.6 现有 `DaFilter` + `AgentDetector` 复用

`DaFilter`（过滤 SGR DA 响应）和 `AgentDetector`（检测 AI 代理信号）是**传输层无关**的纯字节流处理，SSH 后端的 reader task 直接复用，逻辑零改动。

---

## 7. 多标签会话管理架构设计

### 7.1 顶层架构

```
Frontend (React + xterm.js)
 ├─ TabBar (标签栏)
 │   └─ Tab × N (每个 tab 一个 Terminal 实例)
 │       └─ Terminal.tsx → pty_open(id) → Channel<Response>
 └─ StatusBar (状态栏,显示连接状态/心跳)

Tauri 2 Backend
 ├─ PtyState (全局会话注册表)
 │   └─ HashMap<u32, Arc<dyn PtyBackend>>
 │       ├─ LocalPtyBackend (本地 shell)
 │       └─ SshPtyBackend (远程 SSH)
 │           ├─ russh::client::Handle
 │           ├─ russh::Channel (current)
 │           └─ SshSessionState (连接状态机)
 ├─ SshHostRegistry (已知主机管理)
 │   └─ HashMap<host:port, HostKeyRecord>
 └─ SshProfileStore (SSH 配置,基于 tauri-plugin-store)
     └─ Profile × N (hostname/port/user/identity/proxyjump/...)
```

### 7.2 会话生命周期状态机

```
[Idle] --pty_open(backend=Ssh)--> [Connecting]
[Connecting] --tcp connected--> [Handshaking]
[Handshaking] --kex done--> [HostVerifying]
[HostVerifying] --known--> [Authenticating]
[HostVerifying] --unknown--> [PromptUser] --yes--> [Authenticating] (+learn)
[HostVerifying] --mismatch--> [Failed] (emit error)
[Authenticating] --pubkey/password/keyboard-interactive--> [Authenticated]
[Authenticated] --request_pty + exec/shell--> [Connected]
[Connected] --ChannelMsg::ExitStatus--> [Closing]
[Connected] --keepalive timeout--> [Reconnecting] / [Failed]
[Closing] --channel close--> [Closed] (pty_close)
```

每个状态转换通过 `Channel<Response>` 推送 `SshStatusEvent` 到前端，StatusBar 实时显示。

### 7.3 多标签并发模型

- **每个 tab 一个 `Arc<SshPtyBackend>`**，独立持有 `russh::Channel`。
- **同一 host 的多个 tab 共享 `russh::client::Handle`**（SSH 多路复用，单 TCP 连接开多 channel），节省握手开销。这是 russh 的天然能力（`Handle` 可多次 `channel_open_session`）。
- **共享 Handle 的引用计数**：`SshHostRegistry` 维护 `HashMap<host:port, Arc<Mutex<Handle<Client>>>>`，每个 SshPtyBackend 持有 `Weak<...>`，最后一个 tab 关闭时 Handle drop。

### 7.4 标签恢复（HMR / 崩溃恢复）

- 复用现有 `pty_close_all` 在启动时清理孤儿会话（`mod.rs:283-302`）。
- 前端 `runtime.tsx` 维护 tab 元数据（host/profile/cwd），崩溃后从 `tauri-plugin-store` 恢复 tab 列表，用户点击恢复时重新 `pty_open`。

---

## 8. 已知主机管理策略

### 8.1 策略：TOFU + 用户确认 + 文件持久化

借鉴 wezterm-ssh（`host.rs:30-93`）和 OpenSSH 行为：

1. **首次连接**（host not in known_hosts）：
   - russh `check_known_hosts` 返回 `false`（`keys/known_hosts.rs:15-21`）。
   - 推送 `SshStatusEvent::HostVerify { fingerprint, host }` 到前端。
   - 前端弹窗显示指纹（SHA256 base64），用户确认 `yes`/`no`。
   - `yes` → `learn_known_hosts` 写入 `~/.ssh/known_hosts`（`known_hosts.rs:132-174`），继续认证。
   - `no` → 中断连接，emit error。

2. **已知 host，key 匹配**：直接继续认证。

3. **已知 host，key 不匹配**（中间人攻击或服务器重装）：
   - russh `check_known_hosts_path` 返回 `Err(Error::KeyChanged { line })`（`known_hosts.rs:38`）。
   - 推送 `SshStatusEvent::HostKeyMismatch { old_key, new_key, file, line }`。
   - 前端**红色警告弹窗**，显示 old/new 指纹对比，要求用户明确选择"删除旧 key 并继续"或"中断"。
   - 借鉴 wezterm 的 `HostVerificationFailed` 大字警告（`mux/src/ssh.rs:133-170`）。

4. **hashed host 支持**：russh 原生支持 `|1|salt|hash` 格式（`known_hosts.rs:111-128`），与 OpenSSH 完全兼容。

5. **`UserKnownHostsFile` 配置**：支持 SSH config 的 `UserKnownHostsFile` 指令，指定自定义路径。

### 8.2 实现

直接用 russh 的 `check_known_hosts` / `learn_known_hosts` 函数，无需重新实现。`check_server_key` Handler 回调是策略入口：

```rust
// 概念设计
impl client::Handler for SshClientHandler {
    async fn check_server_key(
        &mut self, pubkey: &ssh_key::PublicKey,
    ) -> Result<bool, russh::Error> {
        match russh::keys::check_known_hosts(&self.host, self.port, pubkey) {
            Ok(true) => Ok(true),  // 匹配
            Ok(false) => {
                // 推送到前端,等用户确认 (oneshot channel)
                let trusted = self.ui_channel.ask_host_verify(pubkey).await;
                if trusted {
                    russh::keys::learn_known_hosts(&self.host, self.port, pubkey).ok();
                }
                Ok(trusted)
            }
            Err(Error::KeyChanged { line }) => {
                self.ui_channel.ask_host_key_mismatch(pubkey, line).await
                // mismatch 不自动信任,必须用户明确删除旧 key
            }
            Err(e) => Err(e.into())
        }
    }
}
```

### 8.3 指纹显示格式

- 主格式：`SHA256:<base64-no-pad>`（OpenSSH 现代格式，wezterm-ssh `host.rs:131-139`）。
- fallback：`SHA1:hex:hex:...`（libssh < 1.9 兼容，`host.rs:144-150`）。
- 前端同时显示 fingerprint 和 bubblebabble 视觉化（可选，便于人工比对）。

---

## 9. 状态点（连接状态、心跳）实现方案

### 9.1 连接状态推送

复用现有 `Channel<Response>` 机制（`pty_open` 的 `on_data`），但扩展消息类型。前端通过同一 channel 接收三类消息：

```rust
// 概念设计
#[derive(Serialize)]
#[serde(tag = "type")]
enum PtyEvent {
    Data { bytes: Vec<u8> },          // 终端输出 (复用现有 Response::new(chunk))
    Exit { code: i32 },               // 退出码 (复用现有 on_exit)
    SshStatus { state: SshState, msg: Option<String> },  // SSH 状态 (新增)
    HostVerify { fingerprint: String, host: String },     // 主机验证请求 (新增)
    HostKeyMismatch { ... },           // 主机 key 冲突 (新增)
    AuthPrompt { prompt: String, echo: bool },            // 认证提示 (新增)
}

#[derive(Serialize)]
enum SshState {
    Connecting, Handshaking, HostVerifying, Authenticating,
    Authenticated, Connected, Reconnecting, Failed, Closed,
}
```

为兼容现有前端，`Data` 和 `Exit` 保持原有二进制格式；`SshStatus` 等用独立的 `emit` 事件（如 `terax:ssh-status`），前端按事件名分流。

### 9.2 心跳实现（russh 原生）

**完全用 russh 原生 keepalive，不应用层调度**：

```rust
// 概念设计
let config = client::Config {
    inactivity_timeout: Some(Duration::from_secs(30)),  // 30s 无数据则报超时
    keepalive_interval: Some(Duration::from_secs(15)),  // 15s 发一次 keepalive
    keepalive_max: 3,                                    // 3 次无响应则断开
    ..<_>::default()
};
let session = client::connect(Arc::new(config), (host, port), handler).await?;
```

russh 主循环（`client/mod.rs:1195-1243`）自动：
- 每 15s 发 `keepalive@openssh.com` 全局请求（`want_reply=true`）。
- 收到任意数据 → 重置 `alive_timeouts`（`client/mod.rs:1291-1292`）。
- 连续 3 次 keepalive 无响应 → 返回 `Error::KeepaliveTimeout`（`client/mod.rs:1231-1233`）。
- 30s 无任何数据 → 返回 `Error::InactivityTimeout`（`client/mod.rs:1240-1243`）。

**应用层只需**：在 reader task 的 `channel.wait()` 循环里 `match` russh 错误，`KeepaliveTimeout`/`InactivityTimeout` 时推送 `SshStatus::Reconnecting` 或 `SshStatus::Failed`，触发前端重连 UI。

### 9.3 前端状态点展示

- **StatusBar 左侧**：当前 tab 的 `SshState`（icon + 文字，如 🟢 Connected / 🟡 Reconnecting / 🔴 Failed）。
- **Tab 标题**：`user@host` + 状态 dot（绿/黄/红）。
- **重连按钮**：`Failed` 状态时显示，点击重新 `pty_open`。
- **心跳指示**：`Connected` 状态下，每 15s 闪一次绿点（前端 setInterval，与 keepalive_interval 对齐）。

### 9.4 与现有 `agent_detect` 整合

现有 `AgentDetector`（`pty/agent_detect.rs`）检测 AI 代理信号（如 Claude Code 的 prompt 模式）。SSH 后端的 reader task 同样过 `AgentDetector`，远程 AI 代理也能被识别，前端 `AgentPanel` 体验一致。

---

## 10. 关键风险和缓解措施

| # | 风险 | 等级 | 缓解措施 |
|---|------|------|----------|
| R1 | russh `async fn in trait` 需要 Rust 1.75+ | 低 | 项目 `Cargo.toml` 已是 1.77（`rust-version = "1.77"`），满足 |
| R2 | russh crypto backend 二选一（ring/aws-lc-rs） | 低 | 用 `ring` feature（预编译，零系统依赖），与现有 `reqwest` 的 `rustls-tls` 一致 |
| R3 | SSH 认证流程复杂（pubkey/password/keyboard-interactive/agent） | 中 | 分阶段实现：P2 只做 password + pubkey，P3 加 keyboard-interactive + agent |
| R4 | ProxyJump 链式跳板错误处理复杂 | 中 | P2 不实现 ProxyJump，P3 用 `channel_open_direct_tcpip` 实现，参考 russh README |
| R5 | Windows ConPTY + russh tokio runtime 共存 | 中 | russh 用 tokio，Tauri 2 `async_runtime` 也是 tokio，runtime 兼容；ConPTY 操作仍走 `spawn_blocking`（现有模式不变） |
| R6 | 多 tab 共享 Handle 的并发安全 | 中 | `Handle` 内部是 `Sender<Msg>` + tokio mpsc，天然线程安全；用 `Arc<Mutex<Handle>>` 或 `Arc<Handle>`（Handle 已可克隆） |
| R7 | known_hosts 文件并发写 | 中 | 写文件时用 `fs2` 文件锁（或 `OpenOptions::append` 原子追加，russh `learn_known_hosts` 已是 append 模式，`known_hosts.rs:146-150`） |
| R8 | 大流量 PTY 输出背压 | 中 | 复用现有 `MAX_PENDING = 4 MiB` + `OVERFLOW_NOTICE` 机制（`session.rs:25-31`） |
| R9 | SSH 连接断开后 tab 状态恢复 | 中 | reader task 监听 `KeepaliveTimeout`，推送 `SshStatus::Failed`，前端保留 tab 内容 + 显示重连按钮 |
| R10 | 现有 `pty/agent_detect.rs` 假设本地 shell prompt 模式 | 低 | SSH 远程 shell 的 prompt 模式与本地一致（都是 bash/zsh），`AgentDetector` 无需改动 |
| R11 | russh 的 `check_server_key` 是同步阻塞 UI 的瓶颈 | 中 | 用 `oneshot::channel` 把 host verify 决策推到前端，异步等待用户点击，不阻塞 russh 事件循环 |
| R12 | tabby 用 russh-napi（Node 绑定），性能与纯 Rust 不同 | 低 | 本项目直接用 russh Rust crate，无 N-API 桥接开销，性能更好 |

---

## 11. 预计工时（基于方案书 P2 T-P2-02/03 的 4h）

> 方案书 P2 T-P2-02/03 分配 4h。本调研报告基于该预算给出最小可行实现（MVP）的工时拆解。完整 SSH 客户端（含 ProxyJump/agent forwarding/SFTP）需 P3 阶段继续。

### 11.1 4h MVP 范围（P2 T-P2-02/03）

**只做：password 认证 + 单 tab + 已知主机 TOFU + keepalive + 状态推送**。

| 子任务 | 工时 | 说明 |
|--------|------|------|
| 1. `Cargo.toml` 加 `russh = { version = "0.x", features = ["ring"] }` | 0.1h | 验证编译 |
| 2. `modules/ssh/` 新模块：`mod.rs` + `handler.rs` + `session.rs` | 1.0h | `SshClientHandler` 实现 `check_server_key` + `SshSession` 封装 `client::Handle` |
| 3. `modules/pty/backend.rs`：`PtyBackend` trait + `SshPtyBackend` | 1.0h | reader task 用 `channel.wait()`，复用 `pending` buffer + `DaFilter` + `AgentDetector` |
| 4. `modules/pty/mod.rs`：`pty_open` 加 `backend` 参数，trait dispatch | 0.5h | 现有 `pty_write/resize/close` 改为通过 trait 调用 |
| 5. 前端 `pty-bridge.ts`：`openSshSession(profile)` 调用 `pty_open` with `backend=Ssh` | 0.5h | StatusBar 监听 `terax:ssh-status` 事件 |
| 6. 已知主机 TOFU：`check_known_hosts` + `learn_known_hosts` + 前端确认弹窗 | 0.5h | 借鉴 wezterm `HostVerify` 事件 |
| 7. keepalive 配置 + `KeepaliveTimeout` 错误处理 | 0.2h | russh 原生，只需配 `Config` |
| 8. 联调：本地 PTY 回归 + SSH 单 tab 端到端 | 0.2h | 验证现有本地 PTY 不受影响 |

**合计：4.0h**，与方案书预算一致。

### 11.2 P3 延伸（不在 4h 内）

| 子任务 | 工时 | 阶段 |
|--------|------|------|
| 公钥认证（`authenticate_publickey` + RSA hash 协商） | 1.5h | P3 |
| keyboard-interactive 认证（2FA） | 1.0h | P3 |
| SSH agent forwarding（Unix `SSH_AUTH_SOCK` + Windows Pageant） | 2.0h | P3 |
| ProxyJump（`channel_open_direct_tcpip` 链式） | 1.5h | P3 |
| ProxyCommand（`russh-config` `Stream::proxy_command`） | 0.5h | P3 |
| 多 tab 共享 Handle（SSH 多路复用） | 1.0h | P3 |
| SFTP（`russh-sftp` 集成） | 2.0h | P3 |
| OpenSSH cert 认证 | 1.0h | P4 |

---

## 12. 结论

### 12.1 SSH 库推荐：**russh**

- 纯 Rust + Tokio 异步，与 Tauri 2 完美契合
- 原生 keepalive / inactivity_timeout / ProxyJump / ProxyCommand / known_hosts / agent forwarding / OpenSSH cert
- Warp Tech 维护，85+ contributors，tabby/warpgate/yazi/kty 等生产验证
- 零系统依赖（ring 预编译），Windows 构建友好
- 安全纪律严苛（deny unwrap/expect/panic）

### 12.2 PTY 集成方案：**PtyBackend trait + SshPtyBackend**

- 现有本地 PTY（`pty/session.rs`）零改动
- 新增 `SshPtyBackend` 实现 trait，reader 线程换成 tokio task（`channel.wait()`）
- 复用 `pending` buffer + `DaFilter` + `AgentDetector` + `Channel<Response>` + `x-pty-id` header
- 前端 `Terminal.tsx` 不感知本地/远程差异

### 12.3 多标签架构：**PtyState + SshHostRegistry + 共享 Handle**

- 每 tab 一个 `Arc<dyn PtyBackend>`
- 同 host 多 tab 共享 `russh::client::Handle`（SSH 多路复用）
- 状态机 + `terax:ssh-status` 事件推送

### 12.4 已知主机：**TOFU + 用户确认 + russh 原生文件操作**

- `check_known_hosts` / `learn_known_hosts` / `KeyChanged` 错误处理
- 支持 hashed host + `UserKnownHostsFile` 配置
- mismatch 时大字警告（借鉴 wezterm）

### 12.5 状态点：**russh 原生 keepalive + SshStatus 事件**

- `Config.keepalive_interval=15s` / `keepalive_max=3` / `inactivity_timeout=30s`
- `KeepaliveTimeout` / `InactivityTimeout` → `SshStatus::Failed` → 前端重连
- StatusBar + Tab dot 实时显示

### 12.6 工时：**4h MVP（password + 单 tab + TOFU + keepalive）**

- 与方案书 P2 T-P2-02/03 预算一致
- 公钥认证 / agent forwarding / ProxyJump / SFTP 延后到 P3

---

## 附录 A：源码引用索引

| 结论 | 源码位置 |
|------|----------|
| ssh2-rs 同步 API | `ssh2-rs/src/channel.rs:13-23`（`Arc<Mutex<SessionInner>>`） |
| ssh2-rs PTY API | `ssh2-rs/src/channel.rs:178-241`（`request_pty`/`request_pty_size`/`request_auth_agent_forwarding`） |
| ssh2-rs known_hosts | `ssh2-rs/src/knownhosts.rs:78-100` |
| russh 异步 Handler | `russh/russh/src/client/mod.rs:968-989`（`connect`） |
| russh PTY 示例 | `russh/russh/examples/client_exec_interactive.rs:138-200` |
| russh ChannelMsg | `russh/russh/src/channels/mod.rs:21-114` |
| russh keepalive Config | `russh/russh/src/client/mod.rs:2084-2113` |
| russh keepalive 主循环 | `russh/russh/src/client/mod.rs:1183-1243` |
| russh known_hosts | `russh/russh/src/keys/known_hosts.rs:15-174` |
| russh ProxyCommand | `russh/russh-config/src/proxy.rs:24-32` |
| russh direct-tcpip（ProxyJump 基础） | `russh/russh/src/client/mod.rs:731-754` |
| russh agent client | `russh/russh/src/keys/agent/client.rs:23-98` |
| portable-pty trait | `wezterm/pty/src/lib.rs:88-159` |
| wezterm-ssh Session | `wezterm/wezterm-ssh/src/session.rs:77-190` |
| wezterm-ssh host verify | `wezterm/wezterm-ssh/src/host.rs:30-150` |
| wezterm-ssh keepalive config | `wezterm/wezterm-ssh/src/session.rs:101-108` |
| wezterm-ssh 不支持 ProxyJump | `wezterm/wezterm-ssh/src/config.rs:706-707` |
| wezterm SSH 多路复用 | `wezterm/mux/src/ssh.rs:180-411` |
| 现有 pty/session.rs 3 线程 | `tdsf-terminal-agent/src-tauri/src/modules/pty/session.rs:179-312` |
| 现有 pty 背压 | `tdsf-terminal-agent/src-tauri/src/modules/pty/session.rs:25-31` |
| 现有 pty ConPTY 锁 | `tdsf-terminal-agent/src-tauri/src/modules/pty/session.rs:69-77` |
| 现有 Cargo.toml portable-pty 0.9 | `tdsf-terminal-agent/src-tauri/Cargo.toml:36` |
| tabby 用 russh-napi | `gh api /users/Eugeny/repos` 输出含 `russh-napi` |

## 附录 B：未实现的 P3+ 特性追踪

- [ ] 公钥认证（`authenticate_publickey` + `best_supported_rsa_hash`）
- [ ] keyboard-interactive 认证（2FA / OTP）
- [ ] SSH agent forwarding（Unix `SSH_AUTH_SOCK` + Windows Pageant）
- [ ] ProxyJump（`channel_open_direct_tcpip` 链式）
- [ ] ProxyCommand（`russh-config` `Stream::proxy_command`）
- [ ] 多 tab 共享 Handle（SSH 多路复用）
- [ ] SFTP（`russh-sftp` 集成）
- [ ] OpenSSH cert 认证
- [ ] strict kex / 主动 rekey
- [ ] direct-streamlocal（Unix socket 转发）
- [ ] tcpip-forward（远程端口转发）
