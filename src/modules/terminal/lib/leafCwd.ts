import { effectiveLeafSsh, findLeafCwd, type PaneNode } from "./panes";

/** leaf 落点所需的最小 tab 形状（不依赖 Tab 联合类型，避免反向 import）。 */
export interface LeafCwdSource {
  paneTree: PaneNode;
  /** 建 tab 时的初值快照，仅本地 leaf 作为回退 */
  cwd?: string;
  sshSessionId?: string | null;
}

/**
 * 一块终端 leaf **此刻**在哪个目录 —— 本地与 SSH 共用一个入口（#91①）。
 *
 * 两条链路的数据源不一样，直接读 `paneTree` 的 `leaf.cwd` 对 SSH 恒是建 leaf
 * 那一刻的初值：远端 shell 的 OSC7 cwd 只写进 `sshStore.currentPathBySession`
 * （按会话存），没人回写 paneTree。所以 SSH leaf 必须按它绑的那条会话取路径，
 * 否则会把本地盘路径当成远端目录端出去（代码片段面板就是这么把
 * `cd D:\...` 打进服务器 shell 的）。
 *
 * 拿不到就返回 null —— 宁可少写一行，也不要一个会撒谎的路径。
 */
export function leafCwdOf(
  tab: LeafCwdSource,
  leafId: number,
  remoteCwdBySession: Readonly<Record<string, string>>,
): string | null {
  const ssh = effectiveLeafSsh(tab.paneTree, leafId, tab.sshSessionId);
  if (ssh) return remoteCwdBySession[ssh] ?? null;
  return findLeafCwd(tab.paneTree, leafId) ?? tab.cwd ?? null;
}
