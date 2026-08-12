/**
 * tunnels/types.ts — SSH 隧道数据模型（P2 #23 / P3 #24）
 *
 * 三种模式（对应 OpenSSH -L / -R / -D）：
 *   - local  本地转发（direct-tcpip）：本地监听 → SSH 隧道 → 远程目标
 *   - remote 远程转发（forward-tcpip）：服务器监听 → SSH channel → 本地目标
 *   - socks5 动态转发（SOCKS5 协商 + 动态 direct-tcpip）：本地代理按需访问内网
 */
import type { TunnelInfo, TunnelKind, TunnelStateValue } from "@/lib/tunnel-bridge";

/** 隧道状态值（重新导出，供 UI 使用） */
export type { TunnelStateValue };

/** 隧道类型（重新导出，供 UI 使用） */
export type { TunnelKind };

/** 隧道（别名 TunnelInfo，语义更通用） */
export type Tunnel = TunnelInfo;

/** 隧道类型展示元信息（选择器 + badge） */
export const TUNNEL_TYPE_META: Record<
  TunnelKind,
  { label: string; hint: string; badgeClass: string }
> = {
  local: {
    label: "本地转发",
    hint: "本地端口 → SSH → 远程目标（-L）",
    badgeClass: "border-sky-500/40 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  },
  remote: {
    label: "远程转发",
    hint: "服务器端口 → SSH → 本地目标（-R）",
    badgeClass: "border-violet-500/40 bg-violet-500/10 text-violet-600 dark:text-violet-400",
  },
  socks5: {
    label: "SOCKS5",
    hint: "本地 SOCKS5 代理，按需访问内网（-D）",
    badgeClass: "border-teal-500/40 bg-teal-500/10 text-teal-600 dark:text-teal-400",
  },
};

/** 隧道状态展示元信息（badge 文案 + 配色） */
export const TUNNEL_STATE_META: Record<
  TunnelStateValue,
  { label: string; dotClass: string; badgeClass: string }
> = {
  starting: {
    label: "启动中",
    dotClass: "bg-amber-500",
    badgeClass: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  running: {
    label: "运行中",
    dotClass: "bg-emerald-500",
    badgeClass: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  stopping: {
    label: "停止中",
    dotClass: "bg-muted-foreground/60",
    badgeClass: "border-border bg-muted/60 text-muted-foreground",
  },
  stopped: {
    label: "已停止",
    dotClass: "bg-muted-foreground/40",
    badgeClass: "border-border bg-muted/40 text-muted-foreground",
  },
  failed: {
    label: "失败",
    dotClass: "bg-destructive",
    badgeClass: "border-destructive/40 bg-destructive/10 text-destructive",
  },
};

/** 创建隧道表单数据（CreateTunnelDialog 用，端口/地址为字符串便于输入校验） */
export interface TunnelFormData {
  /** 隧道名称 */
  name: string;
  /** 所属 SSH 会话 Rust id（select 值） */
  sessionId: number;
  /** 会话显示标签（host:port，选择器展示用） */
  sessionLabel: string;
  /** 隧道类型 */
  kind: TunnelKind;
  /** 本地监听地址（Local/Socks5 用，默认 "127.0.0.1"） */
  localHost: string;
  /** 本地监听端口（Local/Socks5 用，字符串，提交时校验 1-65535） */
  localPort: string;
  /** 远程目标地址（仅 Local 用） */
  remoteHost: string;
  /** 远程目标端口（仅 Local 用，字符串，提交时校验 1-65535） */
  remotePort: string;
  /** 服务器监听地址（仅 Remote 用，默认 "127.0.0.1"） */
  bindAddress: string;
  /** 服务器监听端口（仅 Remote 用，字符串；留空=服务器自动分配） */
  bindPort: string;
  /** 本地目标地址（仅 Remote 用） */
  localTargetHost: string;
  /** 本地目标端口（仅 Remote 用，字符串，提交时校验 1-65535） */
  localTargetPort: string;
}

/** 空表单初始值 */
export const EMPTY_TUNNEL_FORM: TunnelFormData = {
  name: "",
  sessionId: 0,
  sessionLabel: "",
  kind: "local",
  localHost: "127.0.0.1",
  localPort: "",
  remoteHost: "",
  remotePort: "",
  bindAddress: "127.0.0.1",
  bindPort: "",
  localTargetHost: "127.0.0.1",
  localTargetPort: "",
};

/** 校验端口字符串是否合法（1-65535） */
export function isValidPort(raw: string): boolean {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 65535;
}

/** 校验名称非空（去除首尾空格） */
export function isValidTunnelName(raw: string): boolean {
  return raw.trim().length > 0;
}
