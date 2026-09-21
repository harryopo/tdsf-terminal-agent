import { toast } from "sonner";
import {
  isSshEnvConnected,
} from "./sshSpaceSession";
import { useSshStore } from "@/modules/ssh-explorer/sshStore";
import type { WorkspaceEnv } from "@/modules/workspace";

/**
 * #89：在 SSH 工作区里**为这一个标签页**开一条自己的连接。
 *
 * 用户决策 1 的原话是"连接后可以新建多个 shell 终端，而且相互独立不影响"。
 * 此前 `sshSessionIdForSpace()` 永远返回 `space.env.sessionId`，新标签页不再调
 * `ssh_connect`，于是两个 leaf 订阅同一条远端 shell：tab2 里 `cd`，tab1 的目录、
 * 左侧资源管理器、状态栏全跟着变，新 tab 还要按一次回车才看到提示符
 * （提示符早在另一个 pane 订阅时就被消费掉了）。
 *
 * 走 `connectWithSaved()`：Rust `ssh_connect` 每次都分配新 id + 新 PTY，
 * 同主机重复连接本来就互不干涉。凭据从 keyring 取，不落 store。
 *
 * @returns 新会话 id；拿不到保存凭据或连接失败时返回 null（**调用方必须明示，
 *   不许静默降级成本地 shell**）。
 */
export async function openSshShellForEnv(
  env: WorkspaceEnv,
): Promise<string | null> {
  if (env.kind !== "ssh") return null;
  const store = useSshStore.getState();
  let profile = store.savedConnections.find(
    (p) => p.host === env.host && p.user === env.user && p.port === env.port,
  );
  if (!profile) {
    // 凭据列表是懒加载的（连接对话框/资源管理器挂载时才拉）；没命中先补拉一次，
    // 否则"刚连上就新建标签页"这条最常见路径会被误判成"没有保存凭据"。
    await store.loadSavedConnections();
    profile = useSshStore
      .getState()
      .savedConnections.find(
        (p) => p.host === env.host && p.user === env.user && p.port === env.port,
      );
  }
  if (!profile) {
    toast.warning("这台服务器没有保存凭据", {
      description: `${env.user}@${env.host}:${env.port} 的新终端无法自动连接，请在 SSH 面板重新登录一次。`,
      duration: 6000,
    });
    return null;
  }
  // #101：标成"为这个标签页开的连接"。连接成功订阅据此**不**补建 tab、也不把
  // 工作区主会话指针挪过来——否则调用方建的 tab 和订阅补的 tab 会绑同一条会话。
  const sessionId = await useSshStore.getState().connectWithSaved(profile, {
    origin: "tab",
  });
  return sessionId;
}

/**
 * 这个工作区是不是"该为每个标签页各开一条连接"的 SSH 工作区。
 *
 * 必须**先有一条活着的会话**才走这条路：未连接的 SSH 工作区（#93 之后身份会留着）
 * 里新建标签页本来就该是本地 shell，不该拿一份可能过期的身份去连。
 */
export function wantsPerTabSshShell(env: WorkspaceEnv | undefined): boolean {
  return !!env && env.kind === "ssh" && isSshEnvConnected(env);
}
