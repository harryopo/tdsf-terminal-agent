/**
 * sshConnectedPlan — 「一条 SSH 连接成功了，该落在哪个终端标签页」的决策真源
 * -----------------------------------------------------------------------------
 * 原先这段判断写在 `App.tsx` 的连接成功订阅回调里（2400 行组件里的一块逻辑，
 * 没有任何测试能覆盖），于是撞出 #101：
 *
 * #89 之后「新建标签页」会为那一个 tab 单独 `connectWithSaved()` 一条连接。
 * 连接成功事件**先于** tab 创建到达，回调按 2026-08-31 的老规则发现"这个工作区里
 * 没有任何 tab 绑着这条会话" → 自己补建了一个 shell tab；紧接着调用方又建了它
 * 自己那个 → **两条 tab 绑同一条会话**，用户看到的就是"新建 shell 像复制了一份
 * shell 似的，资源管理器也跟着同步"。
 *
 * 所以按出身分流：**为某个标签页开的连接（origin==="tab"）没有落点**，它的 tab
 * 由调用方自己建、自己绑。（工作区层面的同一个闸门在 `App.tsx` 的订阅回调里：
 * 那种连接也不改 `space.env.sessionId`、不新建工作区。）
 */
import type { SshSessionOrigin } from "@/modules/ssh-explorer/sshStore";

/** 决策只用到这几个字段，不必把整个 Tab 类型拖进来。 */
export type BindableTab = {
  id: number;
  spaceId: string;
  kind: string;
  sshSessionId?: string | null;
};

export type SshTabTarget =
  | { action: "bind"; tabId: number }
  | { action: "create" }
  | { action: "none" };

export type SshTabTargetInput = {
  /** 缺省按 "space" 处理：老数据与手动连接都是工作区级 */
  origin?: SshSessionOrigin;
  /** 这条连接的前端会话 id */
  sessionId: string;
  /** 已经按 host/user/port 匹配到的目标工作区 */
  targetSpaceId: string;
  activeTabId: number | null;
  tabs: readonly BindableTab[];
  /** 该前端会话 id 当前是否还活着（store 里存在）——幽灵绑定允许重绑 */
  sessionExists: (id: string | null | undefined) => boolean;
};

export function planSshTabTarget(input: SshTabTargetInput): SshTabTarget {
  const { origin, sessionId, targetSpaceId, activeTabId, tabs, sessionExists } =
    input;

  // 为单个标签页开的连接：调用方自己会建 tab 并绑定，这里插手就是第二条 tab。
  if (origin === "tab") return { action: "none" };

  const canRebind = (id: string | null | undefined) =>
    !id || !sessionExists(id) || id === sessionId;

  const inSpace = (t: BindableTab) =>
    t.spaceId === targetSpaceId && t.kind === "terminal";

  // ① 已经有 tab 绑着这条会话（SpaceCreateDialog 预绑定 / 断线重连）
  const exact = tabs.find((t) => inSpace(t) && t.sshSessionId === sessionId);
  if (exact) return { action: "bind", tabId: exact.id };

  // ② 当前活动 tab 是终端且可重绑（本地壳 / 幽灵绑定）
  const active = tabs.find(
    (t) => inSpace(t) && t.id === activeTabId && canRebind(t.sshSessionId),
  );
  if (active) return { action: "bind", tabId: active.id };

  // ③ 目标工作区里任意一个可重绑的终端 tab
  const any = tabs.find((t) => inSpace(t) && canRebind(t.sshSessionId));
  if (any) return { action: "bind", tabId: any.id };

  // ④ 一个终端都没有：补一个，否则"连上了却没有终端"（2026-08-31 的规则）
  return { action: "create" };
}
