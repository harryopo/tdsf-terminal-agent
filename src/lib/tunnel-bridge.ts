/**
 * tunnel-bridge.ts — SSH 隧道桥接层 (P2 #23)
 * -----------------------------------------------------------------------------
 * 封装与 Rust SSH 隧道模块的 Tauri invoke 通信（与 ssh-bridge.ts 同模式）。
 *
 * Rust 侧命令 (src-tauri/src/modules/ssh/mod.rs):
 *   - tunnel_start(spec: TunnelSpec) -> u32（返回隧道 id）
 *   - tunnel_stop(tunnel_id: u32) -> ()
 *   - tunnel_list() -> Vec<TunnelInfo>
 *
 * 命名约定（与 Rust serde 对齐）:
 *   - TunnelSpec 反序列化: camelCase（name/sessionId/localHost/localPort/remoteHost/remotePort）
 *   - TunnelInfo 序列化:   camelCase（id/name/sessionId/localHost/localPort/remoteHost/remotePort/state/connections/createdAt）
 *   - TunnelState 枚举:    snake_case（starting/running/stopping/stopped/failed）
 */
import { invoke } from '@tauri-apps/api/core';

// === 类型定义 ================================================================

/** 隧道状态（与 Rust TunnelState 对齐，snake_case） */
export type TunnelStateValue =
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed';

/** 隧道类型（与 Rust TunnelKind 对齐，snake_case；P3 #24） */
export type TunnelKind = 'local' | 'remote' | 'socks5';

/** 隧道创建参数（与 Rust TunnelSpec 对齐，camelCase） */
export interface TunnelSpec {
  /** 隧道名称（用户可读，列表展示） */
  name: string;
  /** 所属 SSH 会话 id（ssh_connect 返回值 / sshStore 的 rustSessionId） */
  sessionId: number;
  /** 隧道类型（默认 local，向后兼容 P2） */
  kind?: TunnelKind;
  /** 本地监听地址（Local/Socks5 用；默认 "127.0.0.1"；填 "0.0.0.0" 可对外暴露，慎用） */
  localHost?: string;
  /** 本地监听端口（Local/Socks5 用；Remote 无需） */
  localPort?: number;
  /** 远程目标地址（仅 Local 用；相对 SSH 服务器可达，如内网数据库 host） */
  remoteHost?: string;
  /** 远程目标端口（仅 Local 用） */
  remotePort?: number;
  /** 服务器监听地址（仅 Remote 用；默认 "127.0.0.1"，受 sshd GatewayPorts 约束） */
  bindAddress?: string;
  /** 服务器监听端口（仅 Remote 用；缺省=服务器自动分配） */
  bindPort?: number;
  /** 本地目标地址（仅 Remote 用；相对客户端可达） */
  localTargetHost?: string;
  /** 本地目标端口（仅 Remote 用） */
  localTargetPort?: number;
}

/** 隧道信息（与 Rust TunnelInfo 对齐，camelCase） */
export interface TunnelInfo {
  /** 隧道 id（tunnel_start 返回值） */
  id: number;
  name: string;
  /** 所属 SSH 会话 id */
  sessionId: number;
  /** 隧道类型 */
  kind: TunnelKind;
  localHost: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  /** 服务器监听地址（仅 Remote） */
  bindAddress: string;
  /** 服务器实际监听端口（仅 Remote；tcpip_forward 返回值） */
  bindPort?: number;
  /** 本地目标（仅 Remote） */
  localTargetHost?: string;
  localTargetPort?: number;
  state: TunnelStateValue;
  /** 已处理连接数（accept 计数） */
  connections: number;
  /** 创建时间戳（Unix 毫秒） */
  createdAt: number;
}

// === 核心 API ================================================================

/**
 * 创建 SSH 隧道（本地转发 / 远程转发 / SOCKS5，P3 #24）
 *
 * 流程（与 Rust tunnel_start 命令对齐）:
 *   1. 校验 SSH 会话存在且未断开
 *   2. 按 kind 校验必填字段：
 *      - local:  本地端口 + 远程目标（其他进程占用由 listener bind 兜底报错）
 *      - remote: 本地目标（服务器监听端口缺省=自动分配）
 *      - socks5: 本地端口
 *   3. Rust 端启动对应监听/转发 → 返回隧道 id
 *
 * @param spec 隧道定义（各模式只传所需字段）
 * @returns 隧道 id
 */
export async function tunnelStart(spec: TunnelSpec): Promise<number> {
  const kind = spec.kind ?? 'local';
  const payload: Record<string, unknown> = {
    name: spec.name,
    sessionId: spec.sessionId,
    kind,
  };
  if (kind === 'remote') {
    payload.bindAddress = spec.bindAddress ?? '127.0.0.1';
    if (spec.bindPort !== undefined) payload.bindPort = spec.bindPort;
    if (spec.localTargetHost !== undefined) payload.localTargetHost = spec.localTargetHost;
    if (spec.localTargetPort !== undefined) payload.localTargetPort = spec.localTargetPort;
  } else {
    // Local/Socks5 必须提供本地端口（表单层已校验，这里防御）
    if (spec.localPort === undefined) {
      throw new Error("本地端口缺失（local/socks5 隧道必填）");
    }
    payload.localHost = spec.localHost ?? '127.0.0.1';
    payload.localPort = spec.localPort;
    // Local 需远程目标；Socks5 由 CONNECT 请求动态决定目标，无需 remote 字段
    if (kind === 'local') {
      payload.remoteHost = spec.remoteHost;
      payload.remotePort = spec.remotePort;
    }
  }
  return invoke<number>('tunnel_start', { spec: payload });
}

/**
 * 停止隧道（释放本地端口，已建立的桥接连接自然结束）
 */
export async function tunnelStop(tunnelId: number): Promise<void> {
  await invoke('tunnel_stop', { tunnelId });
}

/**
 * 查询所有隧道（按 id 升序）
 */
export async function tunnelList(): Promise<TunnelInfo[]> {
  return invoke<TunnelInfo[]>('tunnel_list');
}
