import { useCallback, useEffect, useMemo, useRef } from "react";
import type { Tab } from "./useTabs";

type Result = {
  explorerRoot: string | null;
  inheritedCwdForNewTab: () => string | undefined;
};

/**
 * TDSF 修复 2026-08-01: 按 Space 隔离 cwd 记忆。
 *
 * 此前 lastTerminalCwd 是单个 ref、anyTerm 遍历全量 tabs——跨 Space 泄漏：
 * SSH Space 终端 cd 到 /root 后切回本地 Space，explorerRoot 可能命中
 * SSH 终端的远程 cwd（或另一个 Space 的 terminal cwd），左侧本地资源
 * 管理器加载远程路径失败 → 空白/不刷新。现在：
 *   - lastTerminalCwdBySpace: Map<spaceId, cwd>（每个 Space 独立记忆）
 *   - anyTerm 只查当前 Space 的 terminal tab
 */
export function useWorkspaceCwd(
  activeTab: Tab | undefined,
  tabs: Tab[],
  home: string | null,
  spaceRoot?: string | null,
  spaceId?: string | null,
): Result {
  const lastTerminalCwdBySpace = useRef<Map<string, string | null>>(new Map());
  const currentSpaceId = spaceId ?? "default";

  useEffect(() => {
    if (activeTab?.kind === "terminal" && activeTab.cwd) {
      lastTerminalCwdBySpace.current.set(currentSpaceId, activeTab.cwd);
    }
  }, [activeTab, currentSpaceId]);

  const explorerRoot = useMemo<string | null>(() => {
    const spaceTabs = spaceId
      ? tabs.filter((t) => t.spaceId === spaceId)
      : tabs;
    if (activeTab?.kind === "terminal" && activeTab.cwd) return activeTab.cwd;
    const lastInSpace = lastTerminalCwdBySpace.current.get(currentSpaceId);
    if (lastInSpace) return lastInSpace;
    const anyTerm = spaceTabs.find((t) => t.kind === "terminal" && t.cwd);
    if (anyTerm?.kind === "terminal" && anyTerm.cwd) return anyTerm.cwd;
    // TDSF 修复 2026-07-31: 切 Space 时若没有任何 terminal cwd，
    // 优先回退到当前 Space 的 root 目录，再回退到 home。
    return spaceRoot ?? home;
  }, [activeTab, tabs, home, spaceRoot, spaceId, currentSpaceId]);

  const inheritedCwdForNewTab = useCallback((): string | undefined => {
    if (activeTab?.kind === "terminal" && activeTab.cwd) return activeTab.cwd;
    // Editor tabs inherit the last terminal's cwd (or workspace home), not
    // the file's folder — opening a new terminal from a file shouldn't
    // hijack the user's working directory context.
    return (
      lastTerminalCwdBySpace.current.get(currentSpaceId) ??
      spaceRoot ??
      home ??
      undefined
    );
  }, [activeTab, home, spaceRoot, currentSpaceId]);

  return { explorerRoot, inheritedCwdForNewTab };
}
