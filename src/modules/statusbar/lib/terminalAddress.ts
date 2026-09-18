import {
  isSessionConnected,
  type SshSessionInfo,
} from "@/modules/ssh-explorer/sshStore";

/**
 * 状态栏右下角"命令实际跑在哪台机器"的唯一口径（用户 2026-09-18 钦定）。
 *
 * 只认**活动 tab 自己绑定的、当前已连接的** SSH 会话：
 *  - 本地 / WSL tab → null，如实显示本地。旧实现会回退到"Space 绑的 SSH 会话"，
 *    于是在 SSH 工作区里开一个本地终端标签时，右下角仍写 `user@host`，
 *    而命令其实打在本地（#63，与 2026-09-18 那条"服务器里该显示服务器地址"的诉求同源反向）。
 *  - 连接中 / 已断开 → null。宁可不显示，也不报一个已经不在的主机。
 */
export function terminalAddressOf(
  session: SshSessionInfo | null | undefined,
): string | null {
  if (!session || !isSessionConnected(session)) return null;
  return `${session.params.user}@${session.params.host}`;
}
