import {
  isSessionConnected,
  isSessionConnecting,
  type SshSessionInfo,
  useSshStore,
} from "@/modules/ssh-explorer/sshStore";
import type { WorkspaceEnv } from "@/modules/workspace";

/**
 * #93：SSH 工作区的**身份**（host/user/port/label）跨断线留着，只摘掉指向
 * 那条会话的引用。
 *
 * 旧做法是断线/重启时把整个 env 改写成 `{ kind: "local" }`（`App.tsx` 三处），
 * 后果是工作区既在界面上变成"本地"，又丢了重连所需的线索（只能重新连一遍、
 * 再生成一个专属 Space）。现在改成只清 `sessionId`：标签还能说清"这是哪台服务器、
 * 现在没连上"，而所有"要不要按远端处理"的判断必须改用下面的显式判据。
 */
export function detachSshSession(env: WorkspaceEnv): WorkspaceEnv {
  if (env.kind !== "ssh" || env.sessionId === undefined) return env;
  const { sessionId: _gone, ...rest } = env;
  return rest;
}

/**
 * 这条 env 是否指向一条**活着**的 SSH 会话。
 *
 * 判据只有主人是 sshStore：`isSessionConnected` = `state === 'connected'`
 * 且已经拿到 Rust 句柄。**不能**再用"env.kind === 'ssh'"当"已连接"——
 * 自 #93 起身份会留着，那个等式不再成立。
 *
 * @param sessions 渲染期调用者请把自己已经订阅的那份会话表传进来（这样会话状态
 *   一变就会重算）；命令式调用点（新建 tab、切工作区、绑定 tab）省略即可，
 *   函数直接读 store 当前值。
 */
export function isSshEnvConnected(
  env: WorkspaceEnv,
  sessions?: readonly SshSessionInfo[],
): boolean {
  if (env.kind !== "ssh" || !env.sessionId) return false;
  const list =
    sessions ?? (useSshStore.getState().sessions as readonly SshSessionInfo[]);
  const session = list.find((s) => s.id === env.sessionId);
  return !!session && isSessionConnected(session);
}

/**
 * 这台服务器当前是否**正有一条连接在建立**（含自动重连中）。
 *
 * #102 收尾：离线面板要区分"没人管，点一下才动"和"重连已经在跑了"。后者不能再显示
 * 成可点的「重新连接」—— 用户会以为没生效而反复点，而 `reconnectSshSpace` 的并发闸门
 * 会把重复请求直接吞掉（返回 null），面板就会谎报"重连失败"。
 *
 * 按 host/user/port 匹配，**不是**"会话表里有任何连接"：同时开两个 SSH 工作区时，
 * B 在连不能让 A 的面板显示"正在重连"。
 */
export function sshEnvIsConnecting(
  env: WorkspaceEnv,
  sessions?: readonly SshSessionInfo[],
): boolean {
  if (env.kind !== "ssh") return false;
  const list =
    sessions ?? (useSshStore.getState().sessions as readonly SshSessionInfo[]);
  return list.some(
    (s) =>
      isSessionConnecting(s) &&
      s.params?.host === env.host &&
      s.params?.port === env.port &&
      s.params?.user === env.user,
  );
}

/** 带 ssh 身份、但会话已经不在了（幽灵 id / 断线后残留）的工作区 id。 */
export function staleSshSpaceIds(
  spaces: readonly { id: string; env: WorkspaceEnv }[],
  sessions: readonly Pick<SshSessionInfo, "id" | "state" | "rustSessionId">[],
): string[] {
  const live = new Set(
    sessions
      .filter((s) => s.state === "connected" && s.rustSessionId !== null)
      .map((s) => s.id),
  );
  return spaces
    .filter(
      (sp) => sp.env.kind === "ssh" && sp.env.sessionId && !live.has(sp.env.sessionId),
    )
    .map((sp) => sp.id);
}
