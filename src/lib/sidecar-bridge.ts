/**
 * sidecar-bridge.ts — Python Sidecar 桥接层（T-P1-02.3）
 * -----------------------------------------------------------------------------
 * 职责：
 *   - 封装前端 ↔ Python Sidecar 的所有 IPC 调用（通过 Rust 中转）
 *   - 提供 invoke / notify / status 三个核心函数
 *   - 提供 subscribe 函数监听 Sidecar 推送的通知事件
 *   - 类型化 IPCError（前端可精确处理 timeout / not_running / remote_error 等）
 *
 * 通信链路:
 *   前端 invoke('ipc_invoke', { method, params })
 *     → Rust 侧 ipc_invoke 命令
 *     → SidecarManager::send_request（写 Python stdin）
 *     → Python 侧 JSON-RPC 处理 + 响应
 *     → SidecarManager reader_task（读 Python stdout）
 *     → oneshot 回调 → Rust 命令返回 → 前端 await 拿到结果
 *
 * 事件订阅链路:
 *   Python send_notification("agent_message", {...})
 *     → Rust reader_task handle_notification
 *     → Tauri emit("sidecar:agent_message", params)
 *     → 前端 listen("sidecar:agent_message", cb)
 *
 * 错误码（与 Rust 侧 IPCError 对齐）：
 *   -32700 Parse error         解析错误
 *   -32600 Invalid Request     无效请求
 *   -32601 Method not found    方法未找到
 *   -32602 Invalid params      无效参数
 *   -32603 Internal error      内部错误
 *   -32000 Server generic      TDSF 通用服务器错误（not_running / stdin_closed / process_error / io_error）
 *   -32001 Timeout             TDSF 超时（请求 30s）
 *   -32002 Write lease         TDSF 写租约冲突（Project Service 并发写）
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { isTauri } from './tauri';

// === 类型定义 ================================================================

/** Sidecar 运行状态（与 Rust 侧 SidecarStatus 枚举对齐，serde rename_all = "lowercase"） */
export type SidecarStatus =
  | 'stopped' // 未启动
  | 'starting' // 启动中（spawn 后等待 ready）
  | 'running' // 运行中（已收到 ready）
  | 'restarting' // 重启中
  | 'crashed' // 崩溃（重启次数超限）
  | 'stopping'; // 停止中（已发送 shutdown，等待退出）

/** Sidecar 状态快照（与 Rust 侧 SidecarStateSnapshot 对齐） */
export interface SidecarStateSnapshot {
  status: SidecarStatus;
  pid: number | null;
  uptime: number | null; // 秒（float）
  retry_count: number;
  max_retry: number;
  last_heartbeat_ago: number | null; // 秒（float）
  methods: string[];
  python_version: string | null;
}

/** IPC 错误（与 Rust 侧 IPCError Serialize 实现对齐） */
export interface IPCError {
  /** JSON-RPC 错误码（-32700 / -32000 / -32001 等） */
  code: number;
  /** 错误消息 */
  message: string;
  /** 错误附加数据（包含 type 字段便于前端区分） */
  data: {
    type:
      | 'not_running'
      | 'timeout'
      | 'stdin_closed'
      | 'process_error'
      | 'json_error'
      | 'io_error'
      | 'remote_error';
    [key: string]: unknown;
  } | null;
}

/** 通知事件 payload（任意 JSON 值） */
export type NotificationPayload = unknown;

/** 订阅事件回调函数 */
export type NotificationCallback = (payload: NotificationPayload) => void;

// === 核心函数 ================================================================

/**
 * 调用 Python Sidecar 的 JSON-RPC 方法（等待响应，30s 超时）
 *
 * @param method JSON-RPC 方法名（如 "agent.invoke" / "project.list"）
 * @param params 调用参数（对象或数组）
 * @returns result 字段内容
 * @throws IPCError（前端可解析 .code 和 .data.type 精确处理）
 *
 * @example
 * ```ts
 * try {
 *   const result = await invoke('agent.invoke', { input: 'nginx 启动失败' });
 *   console.log(result);
 * } catch (e) {
 *   const err = e as IPCError;
 *   if (err.code === -32001) {
 *     console.log('请求超时');
 *   }
 * }
 * ```
 */
export async function invokeRpc<T = unknown>(
  method: string,
  params?: Record<string, unknown> | unknown[]
): Promise<T> {
  if (!isTauri()) {
    throw createBrowserOnlyError(method);
  }
  // Rust 侧 ipc_invoke 返回 Value（result 字段内容）
  // 错误时 Rust 返回 Err(IPCError)，Tauri 自动序列化为字符串抛出
  return invoke<T>('ipc_invoke', {
    method,
    params: params ?? {},
  });
}

/**
 * 向 Python Sidecar 发送通知（无 id，无响应）
 *
 * 适用于不需要等待结果的场景，如取消任务、更新配置。
 *
 * @param method JSON-RPC 方法名（如 "task.cancel"）
 * @param params 通知参数
 *
 * @example
 * ```ts
 * await notify('task.cancel', { task_id: 'xxx' });
 * ```
 */
export async function notify(
  method: string,
  params?: Record<string, unknown> | unknown[]
): Promise<void> {
  if (!isTauri()) {
    throw createBrowserOnlyError(method);
  }
  await invoke('ipc_notify', {
    method,
    params: params ?? {},
  });
}

/**
 * 查询 Sidecar 状态快照
 *
 * @returns SidecarStateSnapshot（status / pid / uptime / methods 等）
 *
 * @example
 * ```ts
 * const status = await getStatus();
 * if (status.status === 'running') {
 *   console.log('Sidecar PID:', status.pid, 'uptime:', status.uptime);
 * }
 * ```
 */
export async function getStatus(): Promise<SidecarStateSnapshot> {
  if (!isTauri()) {
    return createMockSnapshot();
  }
  return invoke<SidecarStateSnapshot>('ipc_status');
}

/**
 * 启动 Sidecar（手动启动，通常应用启动时已自动启动）
 */
export async function start(): Promise<SidecarStateSnapshot> {
  if (!isTauri()) {
    return createMockSnapshot();
  }
  return invoke<SidecarStateSnapshot>('sidecar_start');
}

/**
 * 停止 Sidecar（优雅退出：shutdown → 3s → kill）
 */
export async function stop(): Promise<SidecarStateSnapshot> {
  if (!isTauri()) {
    return createMockSnapshot();
  }
  return invoke<SidecarStateSnapshot>('sidecar_stop');
}

/**
 * 重启 Sidecar（手动重启，重置 retry_count）
 */
export async function restart(): Promise<SidecarStateSnapshot> {
  if (!isTauri()) {
    return createMockSnapshot();
  }
  return invoke<SidecarStateSnapshot>('sidecar_restart');
}

// === 事件订阅 ================================================================

/**
 * 订阅 Sidecar 推送的通知事件
 *
 * 事件名格式：`sidecar:<method>`（如 `sidecar:agent_message` / `sidecar:needs_you`）
 *
 * @param eventName 事件名（不含 `sidecar:` 前缀，如 "agent_message"）
 * @param cb 回调函数，接收事件 payload
 * @returns unlisten 函数，调用后取消订阅
 *
 * @example
 * ```ts
 * const unlisten = await subscribe('agent_message', (payload) => {
 *   console.log('Agent 消息:', payload);
 * });
 * // 取消订阅
 * unlisten();
 * ```
 */
export async function subscribe(
  eventName: string,
  cb: NotificationCallback
): Promise<UnlistenFn> {
  if (!isTauri()) {
    // 浏览器模式下返回 no-op unlisten
    return () => {
      /* no-op */
    };
  }
  const fullEventName = eventName.startsWith('sidecar:')
    ? eventName
    : `sidecar:${eventName}`;
  return listen(fullEventName, (e) => cb(e.payload));
}

/**
 * 订阅 Agent 输出消息（sidecar:agent_message）
 *
 * Agent 在执行过程中通过此事件流式输出 thinking / working / output 状态
 */
export async function onAgentMessage(
  cb: NotificationCallback
): Promise<UnlistenFn> {
  return subscribe('agent_message', cb);
}

/**
 * 订阅工具调用事件（sidecar:tool_call）
 *
 * Agent 调用 MCP tool 时触发，前端可显示工具调用卡
 */
export async function onToolCall(
  cb: NotificationCallback
): Promise<UnlistenFn> {
  return subscribe('tool_call', cb);
}

/**
 * 订阅 needs-you 协调请求（sidecar:needs_you）
 *
 * Agent 需要用户审批/回答问题/错误处理时触发
 */
export async function onNeedsYou(
  cb: NotificationCallback
): Promise<UnlistenFn> {
  return subscribe('needs_you', cb);
}

/**
 * 订阅 Agent 心情变化（sidecar:mood_change）
 *
 * Agent 状态变化时触发（thinking / working / done / error）
 */
export async function onMoodChange(
  cb: NotificationCallback
): Promise<UnlistenFn> {
  return subscribe('mood_change', cb);
}

/**
 * 订阅 Sidecar 崩溃事件（sidecar:crashed）
 *
 * Sidecar 进程崩溃且重启次数超限时触发
 */
export async function onCrashed(
  cb: NotificationCallback
): Promise<UnlistenFn> {
  return subscribe('crashed', cb);
}

/**
 * 订阅心跳丢失事件（sidecar:heartbeat_lost）
 *
 * Sidecar 死锁（30s 无 ping 响应）时触发
 */
export async function onHeartbeatLost(
  cb: NotificationCallback
): Promise<UnlistenFn> {
  return subscribe('heartbeat_lost', cb);
}

/**
 * 订阅 Sidecar 启动完成事件（sidecar:ready）
 *
 * 注意：应用启动时 Sidecar 会自动启动并广播 ready，
 * 但前端组件挂载可能早于该事件，建议同时调用 getStatus() 检查当前状态。
 */
export async function onReady(cb: NotificationCallback): Promise<UnlistenFn> {
  return subscribe('ready', cb);
}

// === 辅助函数 ================================================================

/**
 * 判断 Sidecar 是否运行中
 *
 * @example
 * ```ts
 * if (await isRunning()) {
 *   await invokeRpc('agent.invoke', { input: '...' });
 * }
 * ```
 */
export async function isRunning(): Promise<boolean> {
  const status = await getStatus();
  return status.status === 'running';
}

/**
 * 等待 Sidecar 就绪（轮询 status，超时抛错）
 *
 * @param timeoutMs 超时毫秒数（默认 10s）
 * @param intervalMs 轮询间隔（默认 200ms）
 *
 * @example
 * ```ts
 * await waitForReady(10000); // 等待最多 10s
 * console.log('Sidecar 已就绪');
 * ```
 */
export async function waitForReady(
  timeoutMs = 10000,
  intervalMs = 200
): Promise<void> {
  if (!isTauri()) {
    return; // 浏览器模式立即返回
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await getStatus();
    if (status.status === 'running') return;
    if (status.status === 'crashed') {
      throw new Error(`Sidecar crashed, cannot wait for ready`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Sidecar not ready after ${timeoutMs}ms`);
}

// === 错误处理辅助 ============================================================

/**
 * 解析 invoke 抛出的错误为 IPCError 结构
 *
 * Tauri invoke 失败时抛出的是字符串（Rust 侧 IPCError Serialize 后的 JSON），
 * 此函数尝试解析为 IPCError 对象，失败则返回通用错误。
 *
 * @example
 * ```ts
 * try {
 *   await invokeRpc('agent.invoke', { input: '...' });
 * } catch (e) {
 *   const ipcErr = parseIPCError(e);
 *   if (ipcErr.code === -32001) {
 *     console.log('超时，请重试');
 *   } else if (ipcErr.data?.type === 'not_running') {
 *     console.log('Sidecar 未启动');
 *   }
 * }
 * ```
 */
export function parseIPCError(e: unknown): IPCError {
  if (typeof e === 'string') {
    try {
      const parsed = JSON.parse(e);
      if (
        typeof parsed.code === 'number' &&
        typeof parsed.message === 'string'
      ) {
        return parsed as IPCError;
      }
    } catch {
      // 不是 JSON，按通用错误处理
    }
    return {
      code: -32000,
      message: e,
      data: { type: 'process_error' },
    };
  }
  if (e instanceof Error) {
    return {
      code: -32000,
      message: e.message,
      data: { type: 'process_error' },
    };
  }
  return {
    code: -32603,
    message: 'unknown error',
    data: { type: 'process_error' },
  };
}

// === 浏览器预览模式辅助 ======================================================

/** 浏览器模式下抛出友好错误（提示用户在 Tauri 窗口中运行） */
function createBrowserOnlyError(method: string): Error {
  return new Error(
    `IPC call '${method}' is only available in Tauri window. ` +
      `Running in browser preview mode, sidecar not started.`
  );
}

/** 浏览器模式下返回的 mock 状态快照（避免 UI 报错） */
function createMockSnapshot(): SidecarStateSnapshot {
  return {
    status: 'stopped',
    pid: null,
    uptime: null,
    retry_count: 0,
    max_retry: 3,
    last_heartbeat_ago: null,
    methods: [],
    python_version: null,
  };
}
