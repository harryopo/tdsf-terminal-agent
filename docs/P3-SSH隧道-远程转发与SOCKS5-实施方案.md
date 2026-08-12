# P3 SSH 隧道：远程转发（-R）+ SOCKS5 动态转发（-D）实施方案

> **状态**：✅ 已调研完成（2026-08-12）· 待实现
> **依据**：`docs/方案书-v1.1-更新草案.md` §4（343-378 行）——P2 已落地本地转发，远程转发 + SOCKS5 留 P3
> **上游参考**：russh 0.61.2（`client/mod.rs`）+ [chisel-rs](https://github.com/nezha-rs/chisel)（SOCKS5 实现参考）

---

## 一、目标

在 P2 本地转发（`-L`，direct-tcpip）基础上补齐三种隧道模式：

| 模式 | 对应 ssh 命令 | RFC 4254 机制 | 方向 |
|------|--------------|---------------|------|
| 本地转发 Local | `ssh -L` | direct-tcpip | 本地监听 → SSH → 远程目标（**已有**） |
| 远程转发 Remote | `ssh -R` | forward-tcpip | **服务器监听** → SSH channel → 客户端连本地目标（**本次新增**） |
| 动态转发 SOCKS5 | `ssh -D` | SOCKS5 协商 + 动态 direct-tcpip | 本地 SOCKS 代理 → 按目标动态开 channel（**本次新增**） |

典型场景：
- **远程转发**：把内网服务暴露给公网跳板机（如把本机 3000 端口的开发服务映射到公网服务器，供同事/演示访问）；跳板机访问本机数据库/Web 服务。
- **SOCKS5**：一个本地端口当通用代理，浏览器/工具配 `127.0.0.1:socksPort` 即可通过跳板机访问任意内网目标，无需为每个目标建一条隧道。

---

## 二、现状分析（P2 基础）

### 后端（`src-tauri/src/modules/ssh/`）

| 文件 | 现状 | P3 缺口 |
|------|------|---------|
| `tunnel.rs` | `SshTunnel` 结构体：`spec/state/listener/stop_flag/stop_notify/connections/session/task`；`start()` bind+accept_loop；`bridge_connection()` tokio::select 双向桥接（64KiB buffer）；`stop()` 幂等；5 个测试 | TunnelSpec/TunnelInfo 只有 local 语义字段；无 kind；无 SOCKS5 握手；无远程隧道生命周期 |
| `session.rs` | `open_tcpip_channel()`（946-977 行）——借用 handle 锁开 channel，锁只覆盖一个 RTT | 缺 `tcpip_forward` / `cancel_tcpip_forward` 封装 |
| `handler.rs` | `SshClientHandler` 实现 `check_server_key` / `disconnected`；有全局 `HOST_APPROVAL_REGISTRY` 先例（LazyLock<Mutex<HashMap>> + oneshot） | **未实现 `server_channel_open_forwarded_tcpip` 回调 → 远程转发 channel 被默认空实现直接丢弃（数据流断裂）** |
| `mod.rs` | `SshState.tunnels: RwLock<HashMap<u32, Arc<SshTunnel>>>` + registry 操作 + `tunnel_start/stop/list` 命令（861-944 行） | 命令按 kind 分支校验；远程隧道 registry 类型不兼容（无 listener） |

### 前端（`src/modules/tunnels/`）

| 文件 | 现状 | P3 缺口 |
|------|------|---------|
| `lib/tunnel-bridge.ts` | `TunnelSpec`（name/sessionId/localHost/localPort/remoteHost/remotePort）+ `TunnelInfo` + 3 个 invoke 封装 | 无 kind 字段；无 bind/localTarget 字段 |
| `types.ts` | `TunnelFormData` + `EMPTY_TUNNEL_FORM` + 校验函数 + `TUNNEL_STATE_META` | 无 kind/表单分支 |
| `CreateTunnelDialog.tsx` | 单一本地转发表单（会话/名称/本地端口/远程地址/远程端口/本地监听地址） | 无类型选择器；无按类型条件渲染 |
| `TunnelPanel.tsx` | `formatEndpoint()` 固定 `local → remote` 展示 | 按 kind 分格式展示 |
| `lib/tunnelStore.ts` | refresh/startTunnel/stopTunnel | 基本无需改（spec 透传） |

### russh 0.61.2 API 确认（源码级）

```rust
// client/mod.rs 765-788：请求服务器监听端口（port=0 → 服务器自动分配，返回实际端口）
pub async fn tcpip_forward<A: Into<String>>(&self, address: A, port: u32) -> Result<u32, crate::Error>

// client/mod.rs 791-814：取消监听
pub async fn cancel_tcpip_forward<A: Into<String>>(&self, address: A, port: u32) -> Result<(), crate::Error>

// client/mod.rs 2207-2217：Handler trait 回调 —— 服务器收到连接时调用，默认空实现 = channel 被丢弃！
fn server_channel_open_forwarded_tcpip(
    &mut self,
    channel: Channel<Msg>,
    connected_address: &str,   // 服务器上收到的目标地址（= tcpip_forward 的 address）
    connected_port: u32,        // 服务器上收到的目标端口（= tcpip_forward 返回的实际端口）
    originator_address: &str,   // 实际发起方
    originator_port: u32,
    session: &mut Session,
) -> impl Future<Output = Result<(), Self::Error>> + Send
```

**关键结论**：
- `Channel<Msg>` 是 `Send + Sync`，可跨 task 传递（grep channels/mod.rs 确认）
- 回调按 `(connected_address, connected_port)` 定位目标 → 服务器监听多个远程隧道时用 (地址, 端口) 组合唯一匹配
- `bridge_connection(stream, channel)` 语义与方向无关（stream=本地连接，channel=SSH channel），**远程转发复用无需改动**：只是本地连接由「accept 入站」变为「主动 connect 本地目标」

---

## 三、后端设计

### 3.1 数据模型（`tunnel.rs`）

```rust
/// 隧道类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TunnelKind { Local, Remote, Socks5 }

pub struct TunnelSpec {
    pub name: String,
    pub session_id: u32,
    /// 隧道类型（默认 Local，向后兼容）
    #[serde(default)]
    pub kind: TunnelKind,
    // === Local / Socks5：本地监听 ===
    #[serde(default = "default_local_host")]
    pub local_host: Option<String>,     // 语义：Local/Socks5 必填
    pub local_port: Option<u16>,        // Local/Socks5 必填
    // === Local：远程目标 ===
    pub remote_host: Option<String>,    // Local 必填
    pub remote_port: Option<u16>,       // Local 必填
    // === Remote：服务器监听 + 本地目标 ===
    #[serde(default = "default_local_host")]
    pub bind_address: Option<String>,   // 服务器监听地址（默认 127.0.0.1，受 sshd GatewayPorts 约束）
    pub bind_port: Option<u16>,         // 服务器监听端口（0/None = 服务器自动分配）
    pub local_target_host: Option<String>, // Remote 必填（本地目标，相对客户端可达）
    pub local_target_port: Option<u16>,    // Remote 必填
}
```

> **兼容策略**：`kind` 默认 `Local`；现有 local 字段保持 `localHost/localPort/remoteHost/remotePort`（P2 前端/测试不受破坏）。用 `Option` 区分模式必填字段，`tunnel_start` 命令里按 kind 校验缺失字段并报中文错误。

### 3.2 SshTunnel 扩展（`tunnel.rs`）——单结构体承载三模式

**决策：不新建独立结构体、不改 registry 类型**（`HashMap<u32, Arc<SshTunnel>>` 保持）。原因：
- Local/Socks5 共享 listener + accept_loop + stop 生命周期；Remote 共享 state/stop/connections/session
- 改 registry 类型为 trait object 需 async-trait 或 BoxFuture，引入额外复杂度，收益低
- 内部按 `spec.kind` 分支，代码集中在一个文件，可维护

结构体字段调整：
```rust
pub struct SshTunnel<R> {
    pub id: u32,
    pub spec: TunnelSpec,
    state: RwLock<TunnelState>,
    listener: Arc<Mutex<Option<TcpListener>>>,   // Local/Socks5 用；Remote 恒 None
    stop_flag: Arc<AtomicBool>,
    stop_notify: Arc<Notify>,
    connections: AtomicU64,
    created_at: i64,
    session: Arc<SshSession<R>>,
    task: Arc<Mutex<Option<JoinHandle<()>>>>,    // Local/Socks5: accept_loop；Remote: 无
    /// Remote 专属：服务器实际监听端口（tcpip_forward 返回值；bind_port=0 时由服务器分配）
    remote_port: RwLock<Option<u32>>,
}
```

**start() 按 kind 分支**：
- `Local`：现有逻辑不变（bind → accept_loop）
- `Socks5`：bind → accept_loop（accept 后走 SOCKS5 握手而非直接开 channel）
- `Remote`：调 `session.tcpip_forward(bind_address, bind_port)` → 拿实际端口 → 注册 `REMOTE_TUNNEL_REGISTRY[(address, port)] = { session_id, local_target_host, local_target_port }` → Running（无 accept_loop）

**stop() 按 kind 分支**：
- `Local/Socks5`：现有逻辑（drop listener + 等 accept_loop 退出）
- `Remote`：`session.cancel_tcpip_forward(address, port)` → 从 registry 移除 → Stopped（幂等：重复 stop 直接返回）

**accept_loop() 按 kind 分支处理连接**：
- `Local`：现有逻辑（直接 open_tcpip_channel(fixed target) → spawn bridge）
- `Socks5`：spawn `socks5_handle(stream, session, self)`：握手（NO AUTH）→ 读 CONNECT 请求（ATYP IPv4/域名/IPv6）→ 解析目标 → `open_tcpip_channel(target)` → 回 success 响应 → 复用 `bridge_connection`

### 3.3 SshSession 新增 API（`session.rs`）

```rust
/// 请求服务器开启远程端口转发（RFC 4254 §7.1 forward-tcpip）
/// port=0 → 服务器自动分配，返回实际端口
pub async fn tcpip_forward(&self, address: &str, port: u32) -> Result<u32, SshSessionError>;

/// 取消服务器远程端口转发
pub async fn cancel_tcpip_forward(&self, address: &str, port: u32) -> Result<(), SshSessionError>;
```
与 `open_tcpip_channel` 同模式：先查 `connection_closed`，借用 `handle` 锁（不 take），锁只覆盖一个 RTT。

### 3.4 SshClientHandler 回调（`handler.rs`）

新增全局注册表（借鉴 `HOST_APPROVAL_REGISTRY` 模式）：

```rust
/// 远程转发注册表：服务器收到连接时，按 (address, port) 找本地目标
/// value = { local_target_host: String, local_target_port: u16 }
static REMOTE_TUNNEL_REGISTRY: LazyLock<Mutex<HashMap<(String, u32), RemoteTarget>>>;

pub fn register_remote_target(key: (String, u32), target: RemoteTarget) -> Result<(), String>;
pub fn unregister_remote_target(key: &(String, u32)) -> Option<RemoteTarget>;
```

实现回调：
```rust
async fn server_channel_open_forwarded_tcpip(
    &mut self,
    channel: Channel<Msg>,
    connected_address: &str,
    connected_port: u32,
    originator_address: &str,
    originator_port: u32,
    _session: &mut Session,
) -> Result<(), Self::Error> {
    // 1. 查 registry：找不到 → 关 channel + 日志 + Ok（不报错，避免杀掉 SSH 连接）
    // 2. 找到 → spawn 独立 task：TcpStream::connect(local_target) → bridge_connection(stream, channel)
    // 3. 回调立即返回（不阻塞 handler 主循环）
    Ok(())
}
```

**要点**：
- 回调里不能 await 长桥接（阻塞 handler 主循环）→ spawn task
- 连接失败：`channel.close()` + 日志（russh Channel 有 `close()` 方法）
- 回调用 `connected_address/connected_port` 查表；注册 key 用 `tcpip_forward` 的 address + 实际端口
- `SshClientHandler` 每个 SSH 会话一个实例，多个远程隧道共享同一 handler → registry 全局查表天然支持

### 3.5 SOCKS5 协议实现（`tunnel.rs` 内子模块或独立 `socks5.rs`）

RFC 1928，仅实现 CONNECT（CMD=0x01）+ NO AUTH 方法：

```
客户端 → 服务器: [0x05, 0x01, 0x00]                          (版本, 方法数, NO AUTH)
服务器 → 客户端: [0x05, 0x00]                                  (选择 NO AUTH)
客户端 → 服务器: [0x05, 0x01, 0x00, ATYP, ADDR, PORT]         (CONNECT 请求)
   ATYP: 0x01 IPv4 (4B) | 0x03 域名 (1B len + name) | 0x04 IPv6 (16B)
   PORT: 2B big endian
服务器 → 客户端: [0x05, 0x00, 0x00, ATYP, BND.ADDR, BND.PORT] (成功; BND 可回 0.0.0.0:0)
之后双向透传
```

实现：
- `socks5_handshake(stream) -> Result<(), String>`：读固定 3 字节 → 校验版本/方法 → 写 2 字节回复
- `socks5_read_request(stream) -> Result<(String /*host*/, u16 /*port*/), String>`：读 4 字节头 → 按 ATYP 读地址 → 读 2 字节端口（big endian）
- 不支持的方法/CMD → 返回错误回复（0xFF 拒绝 / 0x07 CMD not supported）并关闭
- 域名类型（ATYP=0x03）是主流场景（浏览器填 hostname），必须支持

**参考**：[chisel-rs](https://github.com/nezha-rs/chisel) `crates/chisel-server/src/proxy/socks5.rs`（Rust 实现，Tokio 风格）+ 各语言 SOCKS5 库共通模式。

### 3.6 命令层（`mod.rs`）

`tunnel_start` 按 `kind` 分支校验：
- Local：现有校验（session 存活 + local_port 未被本应用隧道占用 + local_host/local_port/remote_host/remote_port 非空）
- Socks5：校验 local_host/local_port；端口占用检测
- Remote：校验 bind_address/bind_port（可空=自动）+ local_target_host/local_target_port；无本地端口占用问题（占用的是服务器端口）

`tunnel_info()` 按 kind 输出展示字段（TunnelInfo 加 `kind` + `bindAddress/bindPort/localTargetHost/localTargetPort` 可空字段）。

`stop_tunnels_for_session` 保持——SSH 断开时对 Remote 隧道也要 cancel + 清 registry（russh 断连后 cancel 会失败，容错处理：忽略错误，只清 registry）。

---

## 四、前端设计

### 4.1 `lib/tunnel-bridge.ts`

```ts
export type TunnelKind = 'local' | 'remote' | 'socks5';

export interface TunnelSpec {
  name: string;
  sessionId: number;
  kind?: TunnelKind;                    // 默认 'local'
  // Local / Socks5
  localHost?: string;
  localPort?: number;
  // Local
  remoteHost?: string;
  remotePort?: number;
  // Remote
  bindAddress?: string;                 // 默认 127.0.0.1
  bindPort?: number;                    // 0 = 自动分配
  localTargetHost?: string;
  localTargetPort?: number;
}

export interface TunnelInfo {
  id: number; name: string; sessionId: number;
  kind: TunnelKind;
  localHost?: string; localPort?: number;
  remoteHost?: string; remotePort?: number;
  bindAddress?: string; bindPort?: number;
  localTargetHost?: string; localTargetPort?: number;
  state: TunnelStateValue; connections: number; createdAt: number;
}
```

`tunnelStart` 按 kind 只发送对应字段（Option 序列化：Rust serde 对 `Option` 缺省字段自动 None）。

### 4.2 `types.ts`

- `TunnelFormData` 加 `kind: TunnelKind` + `bindAddress/bindPort/localTargetHost/localTargetPort`
- `EMPTY_TUNNEL_FORM` 扩展（kind 默认 'local'）
- 新增 `TUNNEL_TYPE_META`（本地/远程/SOCKS5 的中文名 + 说明）
- 校验函数复用 `isValidPort`

### 4.3 `CreateTunnelDialog.tsx`

- 顶部加「隧道类型」选择（Select 或 Segmented：本地转发 / 远程转发 / SOCKS5 代理）
- 按 kind 条件渲染：
  - `local`：本地端口 + 远程目标地址 + 远程端口 + 本地监听地址（现有字段）
  - `remote`：服务器监听地址（默认 127.0.0.1）+ 服务器监听端口（空=自动分配）+ 本地目标地址 + 本地目标端口
  - `socks5`：本地监听地址 + 本地监听端口（+ 说明：配合浏览器/工具 SOCKS5 代理使用）
- 提交时按 kind 构造 spec（`tunnelStart` 只发对应字段）

### 4.4 `TunnelPanel.tsx`

`formatEndpoint` 按 kind 分支：
- local：`127.0.0.1:5432 → db.internal:5432`
- remote：`服务器:8080 → 本机:3000`
- socks5：`127.0.0.1:1080 (SOCKS5 代理)`
行内加类型 badge（与状态 badge 并列）。

---

## 五、测试方案

### 后端（Rust）
1. `tunnel.rs`：kind 序列化 snake_case 测试；TunnelSpec 三模式反序列化测试（含缺省 kind=local）；TunnelInfo 序列化 camelCase 测试（含 remote 字段）
2. `handler.rs`：registry 注册/查表/移除/不存在查询测试
3. SOCKS5 纯函数测试：`socks5_read_request` 对 IPv4/域名/IPv6 报文解析 + 非法报文拒绝（握手/请求解析拆成可测纯函数，TCP 读写用 `tokio::io::duplex` 模拟）
4. `session.rs`：`tcpip_forward/cancel_tcpip_forward` 在连接关闭时返回 Closed（复用现有 mock 模式）

### 前端
1. `tunnelStore.test.ts`：保持（spec 透传不变）
2. `TunnelPanel.test.tsx` / `CreateTunnelDialog` 相关测试：补 kind 分支渲染断言（若无现成测试文件则补关键断言）
3. 五绿门禁：`pnpm typecheck && pnpm lint && pnpm test && pnpm build:web` + `cargo test`（不在本任务范围时说明）

---

## 六、风险与注意事项

1. **GatewayPorts**：远程转发服务器端监听地址受 `sshd_config GatewayPorts` 控制（no=仅 127.0.0.1，yes=0.0.0.0，clientspecified=请求地址）。UI 文档说明：默认 127.0.0.1；想对外暴露需服务器配置 GatewayPorts yes。
2. **回调丢弃 channel**：若不实现 `server_channel_open_forwarded_tcpip`，远程转发静默失效（数据被丢）——这是 P3 后端第一优先级缺口。
3. **registry 泄漏**：SSH 断连时 `stop_tunnels_for_session` 必须同时清 REMOTE_TUNNEL_REGISTRY（cancel 失败也清）。
4. **端口冲突**：Local/Socks5 走现有两级校验；Remote 的服务器端口由服务器端决定，本应用不检测（bind 失败由 tcpip_forward 返回错误 → 状态 Failed）。
5. **SOCKS5 只支持 CONNECT**：UDP ASSOCIATE/BIND 返回 0x07 不支持（浏览器主流场景是 CONNECT，够用）。
6. **锁定模式不变**：所有开 channel/forward 操作继续「借用 handle + 锁只覆盖一个 RTT」，不跨 await 持锁（质量红线 §3.5-3）。

---

## 七、实施顺序

1. `session.rs`：`tcpip_forward` / `cancel_tcpip_forward`（独立可测）
2. `handler.rs`：`REMOTE_TUNNEL_REGISTRY` + `server_channel_open_forwarded_tcpip` 回调
3. `tunnel.rs`：TunnelKind + TunnelSpec/TunnelInfo 扩展 + SshTunnel 三模式 start/stop/accept + SOCKS5 实现
4. `mod.rs`：`tunnel_start` 按 kind 校验 + info 输出 + stop_tunnels_for_session 清 registry
5. 前端：`tunnel-bridge.ts` → `types.ts` → `CreateTunnelDialog.tsx` → `TunnelPanel.tsx`
6. 测试 + 文档（本文件回勾 + 方案书 §4 注记 + DEV-JOURNAL + dev-state §37.x）+ commit

**预估**：后端 2 天 + 前端 0.5 天 + 测试文档 0.5 天（与方案书 §4.3 对齐）。
