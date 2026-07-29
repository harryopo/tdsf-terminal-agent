// TDSF 魔改 (P4-T4.1): SSH 会话状态指示灯
// -----------------------------------------------------------------------------
// 圆点指示器, 颜色映射 SSH 9 态有限状态机:
//   - idle / closed        → gray (中性)
//   - connecting / handshaking / host_verifying / authenticating / reconnecting → amber (进行中, 呼吸动画)
//   - authenticated / connected → primary (TDSF 灰色主题)
//   - failed               → destructive (红)

import type { SshSessionStateValue } from "@/lib/ssh-bridge";
import { cn } from "@/lib/utils";

type Props = {
  state: SshSessionStateValue;
  className?: string;
};

/** 状态 → 颜色映射 */
function stateColor(state: SshSessionStateValue): string {
  switch (state) {
    case "authenticated":
    case "connected":
      // TDSF 灰色主题: primary
      return "bg-primary shadow-[0_0_6px_rgba(64,64,64,0.6)]";
    case "connecting":
    case "handshaking":
    case "host_verifying":
    case "authenticating":
    case "reconnecting":
      // 进行中: amber 呼吸动画
      return "bg-amber-500 animate-pulse shadow-[0_0_6px_rgba(245,158,11,0.6)]";
    case "failed":
      return "bg-destructive shadow-[0_0_6px_rgba(239,68,68,0.6)]";
    case "idle":
    case "closed":
      return "bg-muted-foreground/50";
  }
}

/** 状态 → 中文标签映射 (供 tooltip / aria-label 使用) */
export function stateLabel(state: SshSessionStateValue): string {
  switch (state) {
    case "idle":
      return "空闲";
    case "connecting":
      return "连接中";
    case "handshaking":
      return "握手";
    case "host_verifying":
      return "验证主机";
    case "authenticating":
      return "认证中";
    case "authenticated":
      return "已认证";
    case "connected":
      return "已连接";
    case "reconnecting":
      return "重连中";
    case "failed":
      return "失败";
    case "closed":
      return "已关闭";
    default:
      return "未知";
  }
}

/** SSH 状态指示灯 (8px 圆点 + 颜色 + 呼吸动画) */
export function SshStatusDot({ state, className }: Props) {
  return (
    <span
      role="img"
      aria-label={stateLabel(state)}
      title={stateLabel(state)}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full transition-colors",
        stateColor(state),
        className,
      )}
    />
  );
}
