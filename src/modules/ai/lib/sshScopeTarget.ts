import { isSessionConnected, type SshSessionInfo } from "@/modules/ssh-explorer/sshStore";

/** 一段对话绑定的服务器身份（scope 或 Space env 归一后的形状）。 */
export interface SshServerBinding {
  host: string;
  user: string;
  /** 老数据里可能缺字段，与 sshStore 各处同口径按 22 归一。 */
  port?: number;
}

/**
 * #91⑨：把"这段对话属于哪台服务器"解析成**具体哪一条连接**。
 *
 * #89 之前一台服务器只有一条连接，`sessions.find(按 host/user/port)` 就够用；
 * #89 之后同一台主机上可以并着多条（每个标签页各连各的），第一条往往不是用户
 * 正在看的那条 —— 于是"标签写 A 机、命令打 B 机"。优先级：
 * 1. 可见终端正连着的那条（`visibleRustSessionId` 与注入路径同源，见 #107）；
 * 2. 该服务器上任意一条活着的；
 * 3. 该服务器上第一条（哪怕是断的）—— 让调用方照常报"这台服务器未连接"，
 *    而不是把对话的归属服务器弄丢。
 */
export function resolveScopedSshSession(
  sessions: readonly SshSessionInfo[],
  binding: SshServerBinding,
  visibleRustSessionId: number | null,
): SshSessionInfo | null {
  const port = binding.port ?? 22;
  const onServer = sessions.filter(
    (s) =>
      s.params.host === binding.host &&
      s.params.user === binding.user &&
      (s.params.port ?? 22) === port,
  );
  const live = onServer.filter(isSessionConnected);
  return (
    live.find((s) => s.rustSessionId === visibleRustSessionId) ??
    live[0] ??
    onServer[0] ??
    null
  );
}
