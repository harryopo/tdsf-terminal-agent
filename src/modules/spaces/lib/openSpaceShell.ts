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
  const profile = await savedProfileForEnv(env);
  if (!profile) {
    toast.warning("这台服务器没有保存凭据", {
      description: `${env.user}@${env.host}:${env.port} 的新终端无法自动连接，请在「新建工作区 → SSH 服务器」里连一次并勾选保存凭据。`,
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

/** 按 host/user/port 找保存的凭据；列表还没加载过时补拉一次。 */
async function savedProfileForEnv(env: WorkspaceEnv) {
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
  return profile ?? null;
}

/** 正在重连中的工作区，防止切进切出或重复渲染连发多条连接。 */
const reconnecting = new Set<string>();

/**
 * #102：进入"身份还在、会话已经不在"的 SSH 工作区时**主动重连一次**。
 *
 * 不重连的现场（用户 2026-09-21 实测"点击打开已有工作区的时候，显示 sftp time out"）：
 * 工作区注册表跨重启留着 `env.sessionId`，那是一条上个生命周期的会话；启动自动连接
 * 只覆盖"最近使用的那一台"，其余的没人管 → 界面按 SSH 渲染，左侧文件树拿着失效的
 * 会话号去开 SFTP，握手 10 秒后整块面板报 `[fsb] sftp session error: SFTP error: Timeout`。
 *
 * 口径：**重连成功**由连接成功订阅接管（改回工作区主会话、绑终端）；**重连不起来**
 * 绝不静默把服务器工作区显示成本地文件树 —— 原因由 `connect()` 弹一次人话 toast，
 * 落点由左侧离线面板就地说明（两边都说不清就是两条重复通知，见 #110）。
 */
export async function reconnectSshSpace(
  spaceId: string,
  env: WorkspaceEnv,
): Promise<string | null> {
  if (env.kind !== "ssh") return null;
  if (reconnecting.has(spaceId)) return null;
  reconnecting.add(spaceId);
  try {
    const profile = await savedProfileForEnv(env);
    if (!profile) {
      toast.warning("服务器连接已失效", {
        description: `${env.user}@${env.host}:${env.port} 没有保存凭据，无法自动重连，请在「新建工作区 → SSH 服务器」里重连一次并保存凭据。`,
        duration: 6000,
      });
      return null;
    }
    // autoConnect:true —— 这是"恢复既有工作区"，不是用户手动新建：
    // 连接订阅据此不再凭空新建/切换工作区。
    const sessionId = await useSshStore.getState().connectWithSaved(profile, {
      autoConnect: true,
    });
    // #110：连不上时**不再**在这里补一条 toast —— connect() 已经按翻译后的原因弹过一条，
    // 两条叠在一起就是用户截图那样（一条英文 Debug + 一条"可在 SSH 面板重试"，
    // 而那个面板早就没入口了）。左侧的离线面板会就地显示"重连失败"和能做的下一步。
    return sessionId;
  } finally {
    reconnecting.delete(spaceId);
  }
}

/** 仅供测试重置并发闸门。 */
export function __resetReconnectGuard(): void {
  reconnecting.clear();
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
