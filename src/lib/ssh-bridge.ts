/**
 * ssh-bridge.ts — TDSF SSH 桥接层 (P2-B T-P2-04)
 * -----------------------------------------------------------------------------
 * 封装与 Rust SSH 模块的 Tauri invoke 通信，提供与 pty-bridge 一致的接口。
 *
 * 核心特性:
 *   - 原始字节 Channel (Channel<ArrayBuffer>)，无 JSON 序列化开销
 *   - 状态事件 Channel (SshStatusEvent)，实时推送 9 态有限状态机变化
 *   - TOFU 主机确认：通过 ssh:approve-host 事件 + ssh_approve_host 命令
 *
 * Rust 侧命令 (src-tauri/src/modules/ssh/mod.rs):
 *   - ssh_connect(params, on_data, on_status, on_exit) -> u32
 *   - ssh_write(session_id, data: Vec<u8>) -> ()
 *   - ssh_resize(session_id, cols, rows) -> ()
 *   - ssh_disconnect(session_id) -> ()
 *   - ssh_status() -> Vec<(u32, SshSessionState)>
 *   - ssh_approve_host(approval_id, approved) -> ()
 *
 * 命名约定:
 *   - Tauri 2 invoke 参数：camelCase（默认）
 *   - Rust SshConnectCommand：camelCase（#[serde(rename_all = "camelCase")]）
 *   - Rust SshAuthMethod 变体：lowercase（#[serde(tag = "type", rename_all = "lowercase")]）
 *   - Rust SshAuthMethod 字段：snake_case（无 rename_all，需手动转换 private_key_path）
 *   - Rust SshSessionState 枚举：snake_case（#[serde(rename_all = "snake_case")]）
 *   - Rust SshStatusEvent 字段：camelCase（#[serde(rename_all = "camelCase")]）
 */
import { invoke, Channel } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { SshSessionStateValue } from '../store/runtime';

// 供 ssh-explorer 模块统一从 ssh-bridge 引入会话状态枚举
export type { SshSessionStateValue };

const textEncoder = new TextEncoder();

// === 类型定义 ================================================================

/** SSH 认证方法（前端友好类型，camelCase） */
export type SshAuthMethod =
  | { type: 'password'; password: string }
  | {
      type: 'publickey';
      privateKeyPath: string;
      passphrase?: string;
    };

/** SSH 连接参数（前端友好类型，camelCase） */
export interface SshConnectParams {
  host: string;
  port?: number; // 默认 22
  user: string;
  auth: SshAuthMethod;
  cols?: number; // 默认 80
  rows?: number; // 默认 24
  term?: string; // 默认 'xterm-256color'
}

/** SSH 状态事件（与 Rust SshStatusEvent 对齐，camelCase） */
export interface SshStatusEvent {
  /** 当前状态（snake_case，与 Rust 枚举对齐） */
  state: SshSessionStateValue;
  /** 主机名 */
  host: string;
  /** 端口 */
  port: number;
  /** 用户名（认证阶段后填充） */
  user?: string;
  /** 错误信息（Failed 状态时填充） */
  error?: string;
  /** 时间戳（Unix 毫秒） */
  timestamp: number;
}

/** SSH 会话事件回调 */
export interface SshHandlers {
  /** 远端输出数据（PTY stdout + stderr 合流） */
  onData: (bytes: Uint8Array) => void;
  /** 状态变化事件（9 态有限状态机） */
  onStatus?: (event: SshStatusEvent) => void;
  /** 远端进程退出（exit code） */
  onExit?: (code: number) => void;
}

/** SSH 会话句柄（与 PtySession 接口对齐，便于复用 Terminal 组件） */
export interface SshSession {
  /** Rust 端分配的 session_id */
  id: number;
  /** 写入数据（前端按键） */
  write: (data: string) => Promise<void>;
  /** 调整窗口大小 */
  resize: (cols: number, rows: number) => Promise<void>;
  /** 主动断开连接 */
  close: () => Promise<void>;
}

// === 内部辅助：camelCase → Rust snake_case 转换 ===============================

/**
 * 将前端 SshAuthMethod 转换为 Rust 端期望的 JSON 结构
 *
 * Rust 端 SshAuthMethod:
 *   - 变体名 lowercase（password / publickey）
 *   - 字段名 snake_case（private_key_path）
 *
 * 前端 SshAuthMethod:
 *   - type: 'password' | 'publickey'
 *   - privateKeyPath（camelCase）
 */
function toRustAuth(auth: SshAuthMethod): Record<string, unknown> {
  switch (auth.type) {
    case 'password':
      return { type: 'password', password: auth.password };
    case 'publickey':
      return {
        type: 'publickey',
        // Rust 端字段名为 snake_case（SshAuthMethod 无 #[serde(rename_all = "camelCase")]）
        private_key_path: auth.privateKeyPath,
        passphrase: auth.passphrase ?? null,
      };
  }
}

// === 核心 API ================================================================

/**
 * 建立 SSH 连接并打开 PTY 会话
 *
 * 流程（与 Rust ssh_connect 命令对齐）:
 *   1. 创建 3 个 Tauri Channel（onData / onStatus / onExit）
 *   2. 调用 invoke('ssh_connect', { params, onData, onStatus, onExit })
 *   3. Rust 端：分配 session_id → SshClient::connect → SshSession::open_pty
 *   4. 返回 SshSession（含 write/resize/close 方法）
 *
 * @param params 连接参数（host/port/user/auth/cols/rows/term）
 * @param handlers 事件回调（onData 必填，onStatus/onExit 可选）
 * @returns SshSession 句柄
 *
 * @example
 * ```ts
 * const session = await sshConnect(
 *   { host: '192.168.1.100', user: 'root', auth: { type: 'password', password: '***' } },
 *   {
 *     onData: (bytes) => term.write(bytes),
 *     onStatus: (e) => console.log('state:', e.state),
 *     onExit: (code) => console.log('exit:', code),
 *   },
 * );
 * await session.write('ls -la\n');
 * ```
 */
export async function sshConnect(
  params: SshConnectParams,
  handlers: SshHandlers,
): Promise<SshSession> {
  // 原始字节 Channel — 与 pty-bridge 一致，无 base64/JSON 往返
  const onData = new Channel<ArrayBuffer>();
  const onStatus = new Channel<SshStatusEvent>();
  const onExit = new Channel<number>();

  let released = false;
  const noop = () => {};
  const releaseHandlers = () => {
    if (released) return;
    released = true;
    onData.onmessage = noop;
    onStatus.onmessage = noop;
    onExit.onmessage = noop;
  };

  // 绑定回调
  onData.onmessage = (buf) => handlers.onData(new Uint8Array(buf));
  onStatus.onmessage = (event) => handlers.onStatus?.(event);
  onExit.onmessage = (code) => {
    handlers.onExit?.(code);
    releaseHandlers();
  };

  // 调用 Rust ssh_connect 命令
  // Rust 端 SshConnectCommand 使用 camelCase（#[serde(rename_all = "camelCase")]）
  // SshAuthMethod 的字段 private_key_path 为 snake_case，需手动转换
  const sessionId = await invoke<number>('ssh_connect', {
    params: {
      host: params.host,
      port: params.port ?? 22,
      user: params.user,
      auth: toRustAuth(params.auth),
      cols: params.cols ?? 80,
      rows: params.rows ?? 24,
      term: params.term ?? 'xterm-256color',
    },
    onData,
    onStatus,
    onExit,
  });

  let closed = false;

  return {
    id: sessionId,
    // 写入数据：与 pty_write 一致，使用原始字节 + session_id header
    // 注：Rust 端 ssh_write 第二参数为 Vec<u8>，Tauri 自动反序列化
    write: (data) =>
      invoke('ssh_write', {
        sessionId,
        data: Array.from(textEncoder.encode(data)),
      }),
    resize: (c, r) =>
      invoke('ssh_resize', { sessionId, cols: c, rows: r }),
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await invoke('ssh_disconnect', { sessionId });
      } finally {
        releaseHandlers();
      }
    },
  };
}

/**
 * 向 SSH 会话写入数据（独立调用，不通过 SshSession 句柄）
 *
 * 适用场景：Agent 自动化操作（不依赖前端手动 write）。
 */
export async function sshWrite(sessionId: number, data: string): Promise<void> {
  await invoke('ssh_write', {
    sessionId,
    data: Array.from(textEncoder.encode(data)),
  });
}

/**
 * 调整 SSH PTY 窗口大小
 */
export async function sshResize(
  sessionId: number,
  cols: number,
  rows: number,
): Promise<void> {
  await invoke('ssh_resize', { sessionId, cols, rows });
}

/**
 * 主动断开 SSH 连接
 */
export async function sshDisconnect(sessionId: number): Promise<void> {
  await invoke('ssh_disconnect', { sessionId });
}

/**
 * 查询所有 SSH 会话状态
 *
 * @returns [session_id, state] 数组（与 Rust Vec<(u32, SshSessionState)> 对齐）
 */
export async function sshStatus(): Promise<Array<[number, SshSessionStateValue]>> {
  return invoke<Array<[number, SshSessionStateValue]>>('ssh_status');
}

/**
 * 用户确认信任未知主机（TOFU）
 *
 * 当 SshStatusEvent.state === 'host_verifying' 时，前端弹窗询问用户，
 * 用户点击"信任"后调用此命令，Rust 通过 oneshot channel 通知挂起的
 * check_server_key future 继续。
 *
 * @param approvalId 审批 ID（从 SshStatusEvent 或 ssh:approve-host 事件获取）
 * @param approved true=信任并写入 known_hosts，false=拒绝连接
 */
export async function sshApproveHost(
  approvalId: string,
  approved: boolean,
): Promise<void> {
  await invoke('ssh_approve_host', { approvalId, approved });
}

// === 事件订阅 API ============================================================

/**
 * 订阅全局 SSH 状态变化事件（ssh:status）
 *
 * Rust 端在状态变化时通过 app_handle.emit("ssh:status", event) 推送全局事件，
 * 与 on_status channel 的区别：
 *   - on_status channel：仅对当前 session 推送（invoke 时绑定）
 *   - ssh:status 全局事件：所有 session 都会推送（用于状态栏全局监听）
 *
 * @param callback 状态变化回调
 * @returns 取消订阅函数
 */
export function subscribeSshStatus(
  callback: (event: SshStatusEvent) => void,
): () => void {
  let unlisten: UnlistenFn | null = null;
  let cancelled = false;

  listen<SshStatusEvent>('ssh:status', (e) => {
    callback(e.payload);
  }).then((un) => {
    if (cancelled) {
      un();
    } else {
      unlisten = un;
    }
  });

  return () => {
    cancelled = true;
    unlisten?.();
  };
}

/**
 * 订阅主机确认请求事件（ssh:approve-host）
 *
 * 当 Rust 端 check_server_key 检测到未知主机或主机密钥变化时，
 * 通过 app_handle.emit("ssh:approve-host", payload) 推送事件，
 * 前端弹窗显示指纹并询问用户。
 *
 * payload 包含:
 *   - approvalId: 审批 ID（传给 ssh_approve_host）
 *   - sessionId: 关联的会话 ID
 *   - host: 主机名
 *   - port: 端口
 *   - fingerprint: SHA256 指纹
 *   - reason: 'unknown' | 'mismatch'（首次连接 / 密钥变化）
 */
export interface HostApprovalRequest {
  /** 审批 ID（传给 ssh_approve_host） */
  approvalId: string;
  /** 主机名 */
  host: string;
  /** 端口 */
  port: number;
  /** SHA256 指纹 */
  fingerprint: string;
  /** true=已知主机密钥变化（中间人警告），false=首次连接未知主机（TOFU） */
  isMismatch: boolean;
  /** 服务器公钥算法（如 ssh-ed25519），用于 randomart 展示 */
  keyType?: string;
}

export function subscribeHostApproval(
  callback: (req: HostApprovalRequest) => void,
): () => void {
  let unlisten: UnlistenFn | null = null;
  let cancelled = false;

  listen<HostApprovalRequest>('ssh:approve-host', (e) => {
    callback(e.payload);
  }).then((un) => {
    if (cancelled) {
      un();
    } else {
      unlisten = un;
    }
  });

  return () => {
    cancelled = true;
    unlisten?.();
  };
}

// === TDSF 魔改: 主机验证事件订阅（TOFU / 密钥变更） =============================
//
// Rust handler.rs 在 check_server_key 时按场景推送两个事件（payload 为 snake_case）:
//   - "ssh:host_verify":       首次连接未知主机 (is_mismatch=false)
//   - "ssh:host_key_mismatch": 已知主机密钥变化 (is_mismatch=true, 中间人警告)
// payload: { approval_id, host, port, fingerprint, is_mismatch, key_type, message }

/** Rust 端事件 payload（snake_case，内部使用） */
interface RawHostApprovalPayload {
  approval_id: string;
  host: string;
  port: number;
  fingerprint: string;
  is_mismatch: boolean;
  key_type?: string;
  message?: string;
}

function toHostApprovalRequest(raw: RawHostApprovalPayload): HostApprovalRequest {
  return {
    approvalId: raw.approval_id,
    host: raw.host,
    port: raw.port,
    fingerprint: raw.fingerprint,
    isMismatch: raw.is_mismatch,
    keyType: raw.key_type,
  };
}

function subscribeHostEvent(
  eventName: string,
  callback: (req: HostApprovalRequest) => void,
): () => void {
  let unlisten: UnlistenFn | null = null;
  let cancelled = false;

  listen<RawHostApprovalPayload>(eventName, (e) => {
    callback(toHostApprovalRequest(e.payload));
  }).then((un) => {
    if (cancelled) {
      un();
    } else {
      unlisten = un;
    }
  });

  return () => {
    cancelled = true;
    unlisten?.();
  };
}

/** 订阅"首次连接未知主机"验证请求（ssh:host_verify） */
export function subscribeHostVerify(
  callback: (req: HostApprovalRequest) => void,
): () => void {
  return subscribeHostEvent('ssh:host_verify', callback);
}

/** 订阅"已知主机密钥变化"警告请求（ssh:host_key_mismatch） */
export function subscribeHostKeyMismatch(
  callback: (req: HostApprovalRequest) => void,
): () => void {
  return subscribeHostEvent('ssh:host_key_mismatch', callback);
}

// === TDSF 魔改: SSH 测试连接（不保留会话） =====================================

/** ssh_test 命令返回值（与 Rust SshTestResult 对齐，camelCase） */
export interface SshTestResult {
  ok: boolean;
  message: string;
}

/**
 * 测试 SSH 连接（验证凭据可用后立即断开，不打开 PTY / 不注册会话）
 *
 * TOFU 主机确认仍会触发 ssh:host_verify / ssh:host_key_mismatch 事件。
 */
export async function sshTest(params: SshConnectParams): Promise<SshTestResult> {
  return invoke<SshTestResult>('ssh_test', {
    params: {
      host: params.host,
      port: params.port ?? 22,
      user: params.user,
      auth: toRustAuth(params.auth),
      cols: params.cols ?? 80,
      rows: params.rows ?? 24,
      term: params.term ?? 'xterm-256color',
    },
  });
}

// === TDSF 魔改 P0-D: SSH exec 命令执行（运维 Agent 用） ========================
//
// 设计（与 src-tauri/src/modules/ssh/mod.rs:SshCommandResult 对齐, camelCase）:
//   - 复用现有 SSH 会话的 Handle 开新 channel
//   - 用 channel.exec() (RFC 4254 6.4) 执行单条命令, 非 PTY
//   - 返回 { ok, output, stderr, exitCode, duration }
//   - Python sidecar 经 rust_bridge.ipc_invoke("ssh_command", {...}) 调用 (P1 桥接后)
//   - 前端直接 invoke('ssh_command', {...}) 用于 CDP 测试 / 调试 / 未来 UI 集成

/** ssh_command 命令返回值（与 Rust SshCommandResult 对齐, camelCase） */
export interface SshCommandResult {
  /** 命令执行链路是否正常 (true=完成, false=异常) */
  ok: boolean;
  /** stdout 文本（UTF-8 解码, lossy） */
  output: string;
  /** stderr 文本（UTF-8 解码, lossy; 超时含说明） */
  stderr: string;
  /** 退出码（0=成功, 1-255=Unix 标准, -1=超时/未收到 ExitStatus） */
  exitCode: number;
  /** 执行耗时（秒, f64） */
  duration: number;
}

/**
 * 执行单条 SSH 命令并返回结构化结果（exec 模式, 非 PTY）
 *
 * 适用场景:
 * - 运维 Agent 执行一次性命令（uptime / systemctl status nginx / df -h 等）
 * - 远端 /bin/sh -c <command>, 支持管道 / 重定向 / 链式
 * - 与 PTY 交互解耦, 各自独立 channel, 并发不冲突
 *
 * @param sessionId SSH 会话 ID（ssh_connect 返回值）
 * @param command 要执行的命令
 * @param timeoutSecs 超时秒数（默认 30s）
 * @returns 结构化结果（ok=false 时 stderr 含错误信息）
 */
export async function sshCommand(
  sessionId: number,
  command: string,
  timeoutSecs?: number,
): Promise<SshCommandResult> {
  return invoke<SshCommandResult>('ssh_command', {
    sessionId,
    command,
    timeout: timeoutSecs ?? null,
  });
}

// === TDSF 魔改: SSH 凭据持久化（永久保存密钥 + 自动登录） =======================
//
// 设计（与 src-tauri/src/modules/ssh/credentials.rs 对齐）:
//   - 非敏感元数据 → ssh_credentials_* 命令，存 <app_local_data_dir>/ssh-credentials.json
//   - 敏感字段 (password / passphrase) → secrets_* 命令，存 OS keyring
//   - keyring service = "tdsf-ssh-credential"，account = profile.id

/** keyring service 名（与 Rust KEYRING_SERVICE 一致） */
const SSH_KEYRING_SERVICE = 'tdsf-ssh-credential';

/** 凭据认证方式元数据（不含敏感字段，与 Rust CredentialAuthKind 对齐） */
export type CredentialAuthKind =
  | { type: 'password' }
  | {
      type: 'publickey';
      privateKeyPath: string;
      /** passphrase 是否设置（实际值在 keyring） */
      hasPassphrase: boolean;
    };

/** 单条已保存的 SSH 连接配置（与 Rust SshCredentialProfile 对齐，camelCase） */
export interface SshCredentialProfile {
  /** 唯一 id（host:port:user 拼接或 UUID） */
  id: string;
  /** 别名（默认 user@host:port） */
  alias: string;
  host: string;
  port: number;
  user: string;
  /** 认证方式元数据（不含敏感字段） */
  auth: CredentialAuthKind;
  /** 上次使用时间戳（Unix 毫秒） */
  lastUsed: number;
  /** 创建时间戳 */
  createdAt: number;
}

/**
 * 保存（或更新）一条 SSH 连接配置
 *
 * @param profile 非敏感元数据（写入 JSON 文件）
 * @param secret  敏感字段（password 或 passphrase），写入 keyring；null 表示无敏感字段
 */
export async function sshCredentialsSave(
  profile: SshCredentialProfile,
  secret: string | null,
): Promise<void> {
  if (secret !== null) {
    await invoke('secrets_set', {
      service: SSH_KEYRING_SERVICE,
      account: profile.id,
      password: secret,
    });
  }
  await invoke('ssh_credentials_save', { profile });
}

/** 列出所有已保存的 SSH 连接配置（按 lastUsed 倒序） */
export async function sshCredentialsList(): Promise<SshCredentialProfile[]> {
  return invoke<SshCredentialProfile[]>('ssh_credentials_list');
}

/** 删除一条 SSH 连接配置（同时清理 JSON 元数据 + keyring 敏感字段） */
export async function sshCredentialsDelete(id: string): Promise<void> {
  // keyring 清理失败不致命（可能已被用户在系统设置中删除）
  try {
    await invoke('secrets_delete', {
      service: SSH_KEYRING_SERVICE,
      account: id,
    });
  } catch {
    // 忽略：keyring 中不存在该条目
  }
  await invoke('ssh_credentials_delete', { id });
}

/** 更新 lastUsed 时间戳（用于"最近使用"排序） */
export async function sshCredentialsTouch(id: string): Promise<void> {
  await invoke('ssh_credentials_touch', { id });
}

/** 从 keyring 取回敏感字段（password / passphrase），不存在时返回 null */
export async function sshCredentialsGetSecret(
  id: string,
): Promise<string | null> {
  const secret = await invoke<string | null>('secrets_get', {
    service: SSH_KEYRING_SERVICE,
    account: id,
  });
  return secret ?? null;
}

// === 测试专用导出 =============================================================
// 仅供 ssh-bridge.test.ts 验证 camelCase → snake_case 转换逻辑，业务代码勿用。
export { toRustAuth as __testToRustAuth };
