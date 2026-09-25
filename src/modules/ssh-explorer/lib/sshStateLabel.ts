/**
 * SSH 会话状态 → 中文文案（唯一主人）。
 *
 * 原来住在 `SshStatusDot.tsx` 里，和那盏圆点一起服务于侧栏 SSH 连接面板。
 * 面板在 #109（2026-09-25）整片下线后，这里只剩**一个**真实消费方：
 * 连接进度遮罩 `SshConnectingOverlay` 用它报"现在走到哪一步"。
 * 颜色映射（那盏灯）没有跟着搬 —— 没有别的界面再按 9 态着色。
 */
import type { SshSessionStateValue } from "@/lib/ssh-bridge";

const LABELS: Record<SshSessionStateValue, string> = {
  idle: "空闲",
  connecting: "连接中",
  handshaking: "握手",
  host_verifying: "验证主机",
  authenticating: "认证中",
  authenticated: "已认证",
  connected: "已连接",
  reconnecting: "重连中",
  failed: "失败",
  closed: "已关闭",
};

export function stateLabel(state: SshSessionStateValue): string {
  // 认不出的状态（Rust 加了新枚举而前端没跟）如实说"未知"，不猜一个已知的贴上去
  return LABELS[state] ?? "未知";
}
