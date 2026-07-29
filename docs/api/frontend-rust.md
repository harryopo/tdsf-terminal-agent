# 前端 ↔ Rust Tauri 命令接口切面文档（DEC-V32-05）

> **版本**：v1.0.0  
> **最后更新**：2026-07-26  
> **对应 spec**：T-P2-12.1 / DEC-V32-05  
> **代码基线**：`src-tauri/src/lib.rs` 的 `tauri::generate_handler!` 注册表  
> **前端桥接**：`src/lib/pty-bridge.ts` / `ssh-bridge.ts` / `sidecar-bridge.ts` / `tauri.ts`

---

## 0. 文档目的

本文档作为 **前端（React/TypeScript）↔ Rust（Tauri 2 后端）** 之间的接口切面契约，逐条罗列所有通过 `tauri::generate_handler!` 注册的命令，包括：

- 命令签名（Rust 端 + 前端 invoke 调用）
- 参数命名规则（camelCase / snake_case 转换）
- 返回值类型
- 错误类型与错误码
- Tauri Channel 事件流（onData / onStatus / onExit）
- 前端 TypeScript 调用示例

**未实现的命令**（属于后续 task 范围，本文档如实标注）：
- `side_git_*`（T-P2-07 影子仓库，待实施）
- `sandbox_*`（T-P2-08 Docker 沙箱，待实施）
- `fs_*` 文件系统命令（资源管理器 P2-B 后续 task）

---

## 1. 接口总览

### 1.1 命令分类总表

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    前端 invoke('cmd', params)                            │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │
                                   ▼
┌──────────────────────────────────────────────────────────────────────────┐
│                          Tauri 2 IPC 边界                                │
│  src-tauri/src/lib.rs → tauri::generate_handler![...]                    │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │
   ┌───────────────┬───────────────┼───────────────┬────────────────┬──────┘
   ▼               ▼               ▼               ▼                ▼
┌─────────┐  ┌──────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐
│  P0     │  │   PTY    │  │   Shell    │  │ Workspace  │  │  Secrets   │
│ 健康检查 │  │ 终端会话  │  │ 后台命令   │  │  目录授权  │  │  密钥管理  │
└─────────┘  └──────────┘  └────────────┘  └────────────┘  └────────────┘
   ┌───────────────┬───────────────┬───────────────┐
   ▼               ▼               ▼               ▼
┌─────────┐  ┌──────────┐  ┌────────────┐  ┌────────────┐
│  Net    │  │ Sidecar  │  │    IPC     │  │    SSH     │
│ 网络请求 │  │ 进程管理  │  │  JSON-RPC  │  │  远程连接  │
└─────────┘  └──────────┘  └────────────┘  └────────────┘
   ┌───────────────┐
   ▼               ▼
┌─────────┐  ┌──────────┐
│  Agent  │  │ 待实现   │
│ 钩子    │  │ side_git │
└─────────┘  └──────────┘
```

### 1.2 命令清单（39 个，按模块分组）

| 模块 | 命令数 | 命令列表 |
|------|--------|----------|
| P0 健康检查 | 3 | `ping` / `get_version` / `get_build_info` |
| PTY 终端 | 9 | `pty_open` / `pty_write` / `pty_resize` / `pty_close` / `pty_close_all` / `pty_has_foreground_process` / `pty_has_foreground_job` / `pty_shell_name` / `pty_list_shells` |
| Shell 后台 | 8 | `shell_run_command` / `shell_session_open` / `shell_session_run` / `shell_session_close` / `shell_bg_spawn` / `shell_bg_logs` / `shell_bg_kill` / `shell_bg_list` |
| Workspace | 5 | `wsl_list_distros` / `wsl_default_distro` / `wsl_home` / `workspace_authorize` / `workspace_current_dir` |
| Agent 钩子 | 2 | `agent_enable_hooks` / `agent_hooks_status` |
| Secrets | 4 | `secrets_get` / `secrets_set` / `secrets_delete` / `secrets_get_all` |
| Net | 3 | `lm_ping` / `ai_http_request` / `ai_http_stream` |
| Sidecar | 4 | `sidecar_status` / `sidecar_start` / `sidecar_stop` / `sidecar_restart` |
| IPC | 3 | `ipc_invoke` / `ipc_notify` / `ipc_status` |
| SSH | 6 | `ssh_connect` / `ssh_write` / `ssh_resize` / `ssh_disconnect` / `ssh_status` / `ssh_approve_host` |
| **合计** | **47** | — |

### 1.3 命名规则

| 侧 | 命名风格 | 示例 |
|----|----------|------|
| Rust 函数 | snake_case | `pub async fn pty_open(...)` |
| 前端 invoke | snake_case（与 Rust 函数名一致） | `invoke('pty_open', ...)` |
| Rust 结构体字段（默认） | snake_case | `struct SshConnectCommand { private_key_path: String }` |
| Rust 结构体字段（带 `#[serde(rename_all = "camelCase")]`） | camelCase | `SshConnectCommand { host, port, user, auth, cols, rows, term }` |
| 前端 TypeScript | camelCase | `{ host, port, user, auth, cols, rows, term }` |
| Rust 枚举变体（带 `#[serde(rename_all = "snake_case")]`） | snake_case | `SshSessionState::Connecting` → `"connecting"` |

**前端调用约定**：默认所有 invoke 参数使用 **camelCase**（除非该结构体未添加 `rename_all`，需手动转换）。

---

## 2. P0 健康检查命令

### 2.1 `ping`

**用途**：前端启动后第一次调用，验证 IPC 通路。

| 项 | 内容 |
|----|------|
| Rust 函数 | `pub fn ping() -> &'static str` |
| 参数 | 无 |
| 返回值 | `"pong"`（固定字符串） |
| 错误 | 无 |

**TypeScript 示例**：

```typescript
import { invoke } from '@tauri-apps/api/core';

const result = await invoke<string>('ping');
console.log(result); // "pong"
```

### 2.2 `get_version`

**用途**：获取应用版本信息。

| 项 | 内容 |
|----|------|
| Rust 函数 | `pub fn get_version() -> VersionInfo` |
| 参数 | 无 |
| 返回值 | `VersionInfo { name: string, version: string, rust_version: string }` |
| 错误 | 无 |

**TypeScript 示例**：

```typescript
interface VersionInfo {
  name: string;
  version: string;
  rust_version: string;
}

const info = await invoke<VersionInfo>('get_version');
console.log(`${info.name} v${info.version} (rustc ${info.rust_version})`);
```

### 2.3 `get_build_info`

**用途**：获取构建信息（含启动时间 + 运行时长）。

| 项 | 内容 |
|----|------|
| Rust 函数 | `pub fn get_build_info(state: State<AppState>) -> ApiResult<BuildInfo>` |
| 参数 | 无（state 由 Tauri 自动注入） |
| 返回值 | `BuildInfo { version: VersionInfo, started_at: string, uptime_secs: number }` |
| 错误 | `ApiResult` 包装，正常无错 |

**TypeScript 示例**：

```typescript
interface BuildInfo {
  version: VersionInfo;
  started_at: string;  // RFC 3339
  uptime_secs: number;
}

const build = await invoke<BuildInfo>('get_build_info');
console.log(`running for ${build.uptime_secs}s since ${build.started_at}`);
```

---

## 3. PTY 终端命令（9 个）

### 3.1 `pty_open` —— 打开 PTY 会话

**用途**：在 Rust 端 spawn 子进程（bash/zsh/powershell），返回会话 ID，并通过 Channel 推送 PTY 输出。

| 项 | 内容 |
|----|------|
| Rust 函数 | `pub async fn pty_open(app, state, registry, cols, rows, cwd, workspace, blocks, shell, on_data, on_exit) -> Result<u32, String>` |
| 参数 | `cols: u16`, `rows: u16`, `cwd: Option<String>`, `workspace: Option<WorkspaceEnv>`, `blocks: Option<bool>`, `shell: Option<String>`, `on_data: Channel<Response>`, `on_exit: Channel<i32>` |
| 返回值 | `u32`（PTY 会话 ID） |
| 错误 | `Err(String)`：spawn 失败、shell 不存在等 |

**Channel 事件**：

- `on_data: Channel<Response>`：PTY stdout 字节流，每条消息是 `ArrayBuffer`（前端用 `Uint8Array` 接收）
- `on_exit: Channel<i32>`：子进程退出码

**TypeScript 示例**（来自 `src/lib/pty-bridge.ts`）：

```typescript
import { invoke, Channel } from '@tauri-apps/api/core';

const onData = new Channel<ArrayBuffer>();
const onExit = new Channel<number>();

onData.onmessage = (buf) => {
  const bytes = new Uint8Array(buf);
  term.write(bytes);  // xterm.js 写入
};
onExit.onmessage = (code) => {
  console.log('shell exited with code', code);
};

const id = await invoke<number>('pty_open', {
  cols: 80,
  rows: 24,
  cwd: null,
  workspace: 'default',
  blocks: false,
  shell: null,
  onData,
  onExit,
});
```

### 3.2 `pty_write` —— 写入 PTY

**用途**：向前端按键写入 PTY stdin。**特殊**：通过 HTTP Header `x-pty-id` 传递会话 ID，请求体为原始字节（无 JSON 序列化开销）。

| 项 | 内容 |
|----|------|
| Rust 函数 | `pub fn pty_write(state, request: tauri::ipc::Request) -> Result<(), String>` |
| 参数 | 通过 `x-pty-id` header 传递 `id: u32`，请求体为 `Vec<u8>` |
| 返回值 | `Ok(())` |
| 错误 | `Err(String)`：缺少 header / 会话不存在 |

**TypeScript 示例**：

```typescript
import { invoke } from '@tauri-apps/api/core';

const textEncoder = new TextEncoder();
const headers = { 'x-pty-id': String(sessionId) };

await invoke('pty_write', textEncoder.encode('ls -la\n'), { headers });
```

### 3.3 `pty_resize` —— 调整 PTY 窗口大小

| 项 | 内容 |
|----|------|
| Rust 函数 | `pub fn pty_resize(state, id: u32, cols: u16, rows: u16) -> Result<(), String>` |
| 参数 | `id`, `cols`, `rows` |
| 返回值 | `Ok(())` |
| 错误 | `Err(String)`：会话不存在 |

### 3.4 `pty_close` —— 关闭 PTY 会话

| 项 | 内容 |
|----|------|
| Rust 函数 | `pub fn pty_close(state, id: u32) -> Result<(), String>` |
| 参数 | `id` |
| 返回值 | `Ok(())` |
| 错误 | `Err(String)`：会话不存在 |

### 3.5 `pty_close_all` —— 关闭所有 PTY 会话

| 项 | 内容 |
|----|------|
| Rust 函数 | `pub fn pty_close_all(state) -> Result<usize, String>` |
| 返回值 | `usize`（关闭的会话数） |

### 3.6 `pty_has_foreground_process` / `pty_has_foreground_job`

**用途**：检测 PTY 中是否有前台进程 / 前台作业组（用于 Ctrl+C 拦截决策）。

| 项 | 内容 |
|----|------|
| 参数 | `id: u32` |
| 返回值 | `bool` |

### 3.7 `pty_shell_name` —— 获取当前 shell 名

| 项 | 内容 |
|----|------|
| 参数 | `id: u32` |
| 返回值 | `String`（如 `"bash"` / `"zsh"` / `"powershell"`） |

### 3.8 `pty_list_shells` —— 列出可用 shell

| 项 | 内容 |
|----|------|
| 参数 | 无 |
| 返回值 | `Vec<ShellInfo>`，每项含 `name: String, path: String, version: String` |

---

## 4. Shell 后台命令（8 个）

### 4.1 `shell_run_command` —— 一次性执行命令

**用途**：执行命令并返回完整 stdout/stderr（阻塞到完成）。

| 项 | 内容 |
|----|------|
| 参数 | `command: String`, `cwd: Option<String>`, `workspace: Option<WorkspaceEnv>` |
| 返回值 | `{ stdout: String, stderr: String, exit_code: i32 }` |
| 错误 | `Err(String)`：spawn 失败 |

### 4.2 `shell_session_open` / `shell_session_run` / `shell_session_close`

**用途**：长生命周期的 shell 会话（多次执行命令）。

```typescript
// 1. open
const sessionId = await invoke<number>('shell_session_open', { cwd: null });
// 2. run（可多次）
const result = await invoke<{stdout, stderr, exit_code}>('shell_session_run', {
  sessionId, command: 'ls -la',
});
// 3. close
await invoke('shell_session_close', { sessionId });
```

### 4.3 `shell_bg_spawn` / `shell_bg_logs` / `shell_bg_kill` / `shell_bg_list`

**用途**：后台 spawn 长时间运行的进程（如 `npm run dev`），不阻塞前端。

| 命令 | 参数 | 返回值 |
|------|------|-------|
| `shell_bg_spawn` | `command, cwd?, workspace?` | `bg_id: u32` |
| `shell_bg_logs` | `bg_id, max_lines?` | `{ stdout: String, stderr: String }` |
| `shell_bg_kill` | `bg_id` | `Ok(())` |
| `shell_bg_list` | 无 | `Vec<{ id, command, exited, exit_code }>` |

---

## 5. Workspace 管理命令（5 个）

### 5.1 `workspace_authorize` —— 授权工作区目录

**用途**：Tauri 2 安全策略要求显式授权文件系统访问范围。

| 项 | 内容 |
|----|------|
| 参数 | `path: String`, `recursive: bool` |
| 返回值 | `Ok(())` |
| 错误 | `Err(String)`：路径不存在 / 权限拒绝 |

### 5.2 `workspace_current_dir` —— 获取当前工作目录

| 项 | 内容 |
|----|------|
| 参数 | 无 |
| 返回值 | `String`（绝对路径） |

### 5.3 WSL 相关命令（仅 Windows）

| 命令 | 返回值 |
|------|-------|
| `wsl_list_distros` | `Vec<String>`（已安装的 WSL 发行版名） |
| `wsl_default_distro` | `String`（默认发行版名） |
| `wsl_home` | `String`（`\\wsl$\<distro>\home\<user>`） |

---

## 6. Agent 钩子命令（2 个）

### 6.1 `agent_enable_hooks`

**用途**：启用 / 禁用 Agent 钩子扩展（如 Pi 扩展）。

| 项 | 内容 |
|----|------|
| 参数 | `agent: String`（如 `"pi"`） |
| 返回值 | `Ok(())` |
| 错误 | `Err(String)`：未知 agent / 安装失败 |

### 6.2 `agent_hooks_status`

| 项 | 内容 |
|----|------|
| 参数 | `agent: String` |
| 返回值 | `bool`（是否已启用） |

---

## 7. Secrets 密钥管理命令（4 个）

**用途**：跨平台密钥存储（Windows: Credential Manager / macOS: Keychain / Linux: 文件加密存储）。

### 7.1 `secrets_get`

| 项 | 内容 |
|----|------|
| 参数 | `service: String`, `account: String` |
| 返回值 | `Option<String>`（`null` 表示无） |
| 错误 | `Err(String)`：keyring 访问失败 |

### 7.2 `secrets_set`

| 项 | 内容 |
|----|------|
| 参数 | `service: String`, `account: String`, `password: String` |
| 返回值 | `Ok(())` |

### 7.3 `secrets_delete`

| 项 | 内容 |
|----|------|
| 参数 | `service: String`, `account: String` |
| 返回值 | `Ok(())` |

### 7.4 `secrets_get_all`

**用途**：批量读取（用于冷启动时一次性加载多个密钥，减少 IPC 往返）。

| 项 | 内容 |
|----|------|
| 参数 | `keys: Vec<{ service: String, account: String }>` |
| 返回值 | `HashMap<String, String>`（key 为 `service:account`） |

**TypeScript 示例**：

```typescript
const secrets = await invoke<Record<string, string>>('secrets_get_all', {
  keys: [
    { service: 'ssh', account: 'root@192.168.1.100' },
    { service: 'api', account: 'openai' },
  ],
});
const password = secrets['ssh:root@192.168.1.100'];
```

---

## 8. Net 网络请求命令（3 个）

### 8.1 `lm_ping` —— 探测 LLM 服务可达性

| 项 | 内容 |
|----|------|
| 参数 | `base_url: String` |
| 返回值 | `u16`（HTTP 状态码，如 200） |
| 错误 | `Err(String)`：URL 无效 / 网络不可达 |

### 8.2 `ai_http_request` —— 同步 AI HTTP 请求

| 项 | 内容 |
|----|------|
| 参数 | `url, method, headers, body, timeout_ms` |
| 返回值 | `{ status: u16, headers: HashMap<String, String>, body: String }` |
| 错误 | `Err(String)`：超时 / 网络错误 |

### 8.3 `ai_http_stream` —— 流式 AI HTTP 请求（SSE）

| 项 | 内容 |
|----|------|
| 参数 | `url, method, headers, body, on_chunk: Channel<String>` |
| 返回值 | `Ok(())`（流式数据通过 Channel 推送） |
| Channel 事件 | `on_chunk.onmessage = (chunk: string) => {...}` |

---

## 9. Sidecar 进程管理命令（4 个）

**用途**：管理 Python Sidecar 子进程的生命周期。

### 9.1 `sidecar_status`

| 项 | 内容 |
|----|------|
| 参数 | 无 |
| 返回值 | `SidecarStateSnapshot` |

```typescript
interface SidecarStateSnapshot {
  status: 'stopped' | 'starting' | 'running' | 'restarting' | 'crashed' | 'stopping';
  pid: number | null;
  uptime: number | null;  // 秒
  retry_count: number;
  max_retry: number;      // 固定 3
  last_heartbeat_ago: number | null;
  methods: string[];      // 已注册的 JSON-RPC 方法名
  python_version: string | null;
}
```

### 9.2 `sidecar_start` / `sidecar_stop` / `sidecar_restart`

| 命令 | 行为 |
|------|------|
| `sidecar_start` | spawn Python 子进程，等待 ready 通知（10s 超时） |
| `sidecar_stop` | 发送 shutdown → 3s grace → SIGKILL |
| `sidecar_restart` | stop + start，重置 retry_count |

**重启策略**（DEC-V321-11 Fix-loop max_retry=3）：

```
进程崩溃
   │
   ▼
retry_count < 3 ──── 是 ───► retry_count++ → restart
   │
   否
   ▼
状态 = crashed → emit("sidecar:crashed") → 不再自动重启
```

---

## 10. IPC JSON-RPC 桥接命令（3 个）

**用途**：前端通过 Rust 中转调用 Python Sidecar 的 JSON-RPC 方法。

### 10.1 调用链路

```
前端 invokeRpc('agent.invoke', {input: '...'})
   │
   ▼
invoke('ipc_invoke', { method, params })
   │
   ▼
Rust ipc_invoke 命令
   │
   ▼
SidecarManager::send_request(method, params)
   │  写入 Python stdin: {"jsonrpc":"2.0","method":"agent.invoke","params":{...},"id":1}
   ▼
Python 处理 → 响应: {"jsonrpc":"2.0","result":{...},"id":1}
   │
   ▼
Rust reader_task 收到响应 → oneshot 回调
   │
   ▼
前端 await 拿到 result
```

### 10.2 `ipc_invoke`

| 项 | 内容 |
|----|------|
| 参数 | `method: String`, `params: Value` |
| 返回值 | `Value`（result 字段内容） |
| 错误 | `IPCError`（结构见下） |

**IPCError 结构**：

```typescript
interface IPCError {
  code: number;    // JSON-RPC 错误码
  message: string;
  data: {
    type: 'not_running' | 'timeout' | 'stdin_closed'
        | 'process_error' | 'json_error' | 'io_error'
        | 'remote_error';
    [key: string]: unknown;
  } | null;
}
```

**错误码对照**：

| code | 含义 | data.type |
|------|------|-----------|
| -32700 | Parse error（Python 解析失败） | `remote_error` |
| -32600 | Invalid Request | `remote_error` |
| -32601 | Method not found | `remote_error` |
| -32602 | Invalid params | `remote_error` |
| -32603 | Internal error | `remote_error` |
| -32000 | Server generic（Sidecar 未运行等） | `not_running` / `stdin_closed` / `process_error` / `io_error` |
| -32001 | Timeout（30s） | `timeout` |
| -32002 | Write lease 冲突 | `remote_error` |

### 10.3 `ipc_notify`

**用途**：发送通知（无 id，无响应）。

| 项 | 内容 |
|----|------|
| 参数 | `method: String`, `params: Value` |
| 返回值 | `Ok(())` |

### 10.4 `ipc_status`

| 项 | 内容 |
|----|------|
| 参数 | 无 |
| 返回值 | `SidecarStateSnapshot`（同 `sidecar_status`） |

---

## 11. SSH 远程连接命令（6 个）

**Rust 模块**：`src-tauri/src/modules/ssh/mod.rs`（基于 russh + TOFU + keepalive）

### 11.1 `ssh_connect` —— 建立 SSH 连接

| 项 | 内容 |
|----|------|
| Rust 函数 | `pub async fn ssh_connect(params, on_data, on_status, on_exit) -> Result<u32, String>` |
| 参数 | `params: SshConnectParams`, `on_data: Channel<ArrayBuffer>`, `on_status: Channel<SshStatusEvent>`, `on_exit: Channel<i32>` |
| 返回值 | `u32`（session_id） |

**SshConnectParams**（camelCase）：

```typescript
interface SshConnectParams {
  host: string;
  port?: number;       // 默认 22
  user: string;
  auth:
    | { type: 'password'; password: string }
    | { type: 'publickey'; privateKeyPath: string; passphrase?: string };
  cols?: number;       // 默认 80
  rows?: number;       // 默认 24
  term?: string;       // 默认 'xterm-256color'
}
```

**SshStatusEvent**（9 态有限状态机）：

```typescript
interface SshStatusEvent {
  state: 'idle' | 'connecting' | 'host_verifying' | 'authenticating'
       | 'opening_channel' | 'ready' | 'failed' | 'disconnected' | 'closed';
  host: string;
  port: number;
  user?: string;
  error?: string;
  timestamp: number;  // Unix 毫秒
}
```

### 11.2 `ssh_write` —— 写入 SSH PTY

| 项 | 内容 |
|----|------|
| 参数 | `sessionId: u32`, `data: Vec<u8>`（注意：通过 `Array.from(textEncoder.encode(data))` 传递） |
| 返回值 | `Ok(())` |

### 11.3 `ssh_resize` / `ssh_disconnect` / `ssh_status` / `ssh_approve_host`

| 命令 | 参数 | 返回值 |
|------|------|-------|
| `ssh_resize` | `sessionId, cols, rows` | `Ok(())` |
| `ssh_disconnect` | `sessionId` | `Ok(())` |
| `ssh_status` | 无 | `Vec<[u32, SshSessionState]>` |
| `ssh_approve_host` | `approvalId: String, approved: bool` | `Ok(())`（用于 TOFU 主机确认） |

**TOFU 流程**：

```
ssh_connect → state="host_verifying"
   │
   ▼
Rust 检测未知主机 → emit("ssh:approve-host", { approvalId, fingerprint, reason })
   │
   ▼
前端弹窗显示指纹 → 用户点击"信任" → invoke('ssh_approve_host', { approvalId, approved: true })
   │
   ▼
Rust oneshot 通知挂起的 check_server_key future → 继续 → state="authenticating"
```

---

## 12. Tauri Channel 事件流总览

### 12.1 PTY 事件

```typescript
// pty-bridge.ts
const onData = new Channel<ArrayBuffer>();
const onExit = new Channel<number>();

onData.onmessage = (buf: ArrayBuffer) => {
  const bytes = new Uint8Array(buf);
  term.write(bytes);  // xterm.js
};
onExit.onmessage = (code: number) => {
  console.log('exit code:', code);
};
```

### 12.2 SSH 事件（3 个 Channel）

```typescript
// ssh-bridge.ts
const onData = new Channel<ArrayBuffer>();
const onStatus = new Channel<SshStatusEvent>();
const onExit = new Channel<number>();

onData.onmessage = (buf) => term.write(new Uint8Array(buf));
onStatus.onmessage = (event) => console.log('state:', event.state);
onExit.onmessage = (code) => console.log('exit:', code);
```

### 12.3 Sidecar 推送事件（Tauri Event，非 Channel）

通过 `app_handle.emit("sidecar:<event>", payload)` 推送，前端用 `listen` 订阅：

```typescript
import { listen } from '@tauri-apps/api/event';

const unlisten = await listen('sidecar:agent_message', (e) => {
  console.log('Agent 消息:', e.payload);
});

// 取消订阅
unlisten();
```

**事件清单**：

| 事件名 | 触发时机 | payload |
|--------|----------|---------|
| `sidecar:ready` | Sidecar 启动完成 | `{ version, python, platform, methods }` |
| `sidecar:crashed` | 重启次数超限 | `{ retry_count, max_retry }` |
| `sidecar:heartbeat_lost` | 30s 无 ping 响应 | `{ last_heartbeat_ago }` |
| `sidecar:agent_message` | Agent 输出消息 | `{ content, type, agent }` |
| `sidecar:mood_change` | Agent mood 变化 | `{ mood, agent }` |
| `sidecar:tool_call` | Agent 调用 MCP tool | `{ tool, params, result }` |
| `sidecar:needs_you` | needs-you 请求 | `{ event, request }` |
| `ssh:status` | SSH 全局状态变化 | `SshStatusEvent` |
| `ssh:approve-host` | 主机确认请求 | `HostApprovalRequest` |

---

## 13. 错误处理模式

### 13.1 Tauri 命令错误（Rust `Result<T, String>`）

Rust 端返回 `Err(String)`，Tauri 自动序列化为字符串抛给前端：

```typescript
try {
  await invoke('pty_open', { ... });
} catch (e) {
  // e 是字符串（Rust Err 的内容）
  console.error('pty_open failed:', e);
}
```

### 13.2 IPC 错误（结构化）

`ipc_invoke` 返回的 `IPCError` 是结构化对象，需用 `parseIPCError` 解析：

```typescript
import { parseIPCError } from '@/lib/sidecar-bridge';

try {
  await invokeRpc('agent.invoke', { input: '...' });
} catch (e) {
  const ipcErr = parseIPCError(e);
  if (ipcErr.code === -32001) {
    console.log('请求超时');
  } else if (ipcErr.data?.type === 'not_running') {
    console.log('Sidecar 未启动，请稍后重试');
  }
}
```

### 13.3 浏览器预览模式降级

非 Tauri 环境（如 `vite dev` 浏览器预览），所有 invoke 抛出友好错误：

```typescript
import { isTauri } from '@/lib/tauri';

if (!isTauri()) {
  throw new Error(
    `IPC call '${method}' is only available in Tauri window. ` +
    `Running in browser preview mode, sidecar not started.`
  );
}
```

`sidecar-bridge.ts` 的 `getStatus()` / `start()` / `stop()` / `restart()` 在浏览器模式下返回 mock 快照，避免 UI 报错。

---

## 14. 完整调用示例：Agent 排查 nginx 故障

```typescript
import { invoke } from '@tauri-apps/api/core';
import { invokeRpc, subscribe, waitForReady } from '@/lib/sidecar-bridge';

// 1. 等待 Sidecar 就绪
await waitForReady(10000);

// 2. 订阅 Agent 输出
const unlistenMsg = await subscribe('agent_message', (payload) => {
  console.log('[Agent]', payload);
});
const unlistenNeeds = await subscribe('needs_you', (payload) => {
  if (payload.event === 'created' && payload.request.type === 'approval') {
    // 弹窗审批
    showApprovalDialog(payload.request);
  }
});

// 3. 调用 Agent
try {
  const result = await invokeRpc('agent.invoke', {
    name: 'main',
    state: {
      input: 'nginx 启动失败',
      session_id: 'sess-1',
      mode: 'agent',
    },
  });
  console.log('Agent 完成:', result);
} catch (e) {
  const ipcErr = parseIPCError(e);
  if (ipcErr.data?.type === 'not_running') {
    console.error('Sidecar 崩溃，请重启应用');
  }
}

// 4. 清理订阅
unlistenMsg();
unlistenNeeds();
```

---

## 15. 版本与变更记录

| 版本 | 日期 | 变更内容 |
|------|------|----------|
| v1.0.0 | 2026-07-26 | 初版：47 个命令 + Channel 事件 + IPC 错误码 |

## 16. 待实现命令（后续 task）

| 命令组 | task | 说明 |
|--------|------|------|
| `side_git_init` / `side_git_commit` / `side_git_diff` / `side_git_restore` | T-P2-07 | side-git 影子仓库（DEC-V321-02） |
| `sandbox_create` / `sandbox_exec` / `sandbox_destroy` / `sandbox_logs` | T-P2-08 | Docker 沙箱（bollard） |
| `fs_read` / `fs_write` / `fs_list` / `fs_watch` | P2-B 资源管理器 | Monaco Editor 文件操作 |

待上述命令实现后，本文档需追加对应章节。

---

**文档结束** | 共 16 章 | 命令数 47 | Channel 事件 5 类 | Tauri Event 9 类
