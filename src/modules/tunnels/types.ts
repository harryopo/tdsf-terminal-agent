/**
 * tunnels/types.ts — SSH 隧道数据模型（P2 #23）
 *
 * P2 SSH 隧道（方案书 v1.1 §四）：本地端口转发（direct-tcpip），
 * DBA 通过跳板机连远程数据库 / 访问内网服务，免 VPN。
 */
import type { TunnelInfo, TunnelStateValue } from "@/lib/tunnel-bridge";

/** 隧道状态值（重新导出，供 UI 使用） */
export type { TunnelStateValue };

/** 隧道（别名 TunnelInfo，语义更通用） */
export type Tunnel = TunnelInfo;

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
  /** 本地监听地址（默认 "127.0.0.1"） */
  localHost: string;
  /** 本地监听端口（字符串，提交时校验 1-65535） */
  localPort: string;
  /** 远程目标地址 */
  remoteHost: string;
  /** 远程目标端口（字符串，提交时校验 1-65535） */
  remotePort: string;
}

/** 空表单初始值 */
export const EMPTY_TUNNEL_FORM: TunnelFormData = {
  name: "",
  sessionId: 0,
  sessionLabel: "",
  localHost: "127.0.0.1",
  localPort: "",
  remoteHost: "",
  remotePort: "",
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
