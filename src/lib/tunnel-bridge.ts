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

/** 隧道创建参数（与 Rust TunnelSpec 对齐，camelCase） */
export interface TunnelSpec {
  /** 隧道名称（用户可读，列表展示） */
  name: string;
  /** 所属 SSH 会话 id（ssh_connect 返回值 / sshStore 的 rustSessionId） */
  sessionId: number;
  /** 本地监听地址（默认 "127.0.0.1"；填 "0.0.0.0" 可对外暴露，慎用） */
  localHost?: string;
  /** 本地监听端口 */
  localPort: number;
  /** 远程目标地址（相对 SSH 服务器可达，如内网数据库 host） */
  remoteHost: string;
  /** 远程目标端口 */
  remotePort: number;
}

/** 隧道信息（与 Rust TunnelInfo 对齐，camelCase） */
export interface TunnelInfo {
  /** 隧道 id（tunnel_start 返回值） */
  id: number;
  name: string;
  /** 所属 SSH 会话 id */
  sessionId: number;
  localHost: string;
  localPort: number;
  remoteHost: string;
  remotePort: number;
  state: TunnelStateValue;
  /** 已处理连接数（accept 计数） */
  connections: number;
  /** 创建时间戳（Unix 毫秒） */
  createdAt: number;
}

// === 核心 API ================================================================

/**
 * 创建 SSH 隧道（本地端口转发）
 *
 * 流程（与 Rust tunnel_start 命令对齐）:
 *   1. 校验 SSH 会话存在且未断开
 *   2. 检测本地端口未被其他隧道占用（其他进程占用由 listener bind 兜底报错）
 *   3. Rust 端绑定 localHost:localPort → 返回隧道 id
 *
 * @param spec 隧道定义（localHost 省略时默认 "127.0.0.1"）
 * @returns 隧道 id
 */
export async function tunnelStart(spec: TunnelSpec): Promise<number> {
  return invoke<number>('tunnel_start', {
    spec: {
      name: spec.name,
      sessionId: spec.sessionId,
      localHost: spec.localHost ?? '127.0.0.1',
      localPort: spec.localPort,
      remoteHost: spec.remoteHost,
      remotePort: spec.remotePort,
    },
  });
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
