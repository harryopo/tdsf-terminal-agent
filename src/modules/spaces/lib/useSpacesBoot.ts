import { useEffect, useRef } from "react";
import { loadAll, type SpaceMeta } from "./store";
import { useSpaces } from "./useSpaces";

type Params = {
  ready: boolean;
  markBooted: () => void;
};

/**
 * 启动引导：每次启动回到初始的选择/新建工作区界面。
 *
 * TDSF 修复 2026-08-07: 用户明确要求"重启后回到初始的选择/新建工作区界面,
 * 不用记住"——SSH 服务器可能已关闭, 恢复持久化的 SSH Space 会携带上次
 * 生命周期的幽灵 sessionId (应用重启后会话不存在), 导致终端显示本地、
 * 资源管理器不接管。
 *
 * TDSF 修复 2026-09-18 (ROADMAP #61 方案 A, 用户钦定): 上面那版把
 * **注册表本身**也一起清空了（`hydrate([], null)`），而 `useSpaces.create()`
 * 落盘的是整个 `spaces` 键 —— 于是启动后第一次新建就把上一轮的工作区清单抹掉，
 * 所有 `scope={kind:"workspace", spaceId}` 的历史会话再也解析不到 Space 元数据，
 * 在列表里直接消失。现在拆开两件事：
 *  - **注册表跨重启留存**（读回来，新建变成追加而不是覆盖）；
 *  - **但不自动进入**任何 Space（`activeId` 恒为 null），所以首屏仍是欢迎页，
 *    也不会拿上一次的幽灵 SSH sessionId 去渲染终端。
 */
export function useSpacesBoot({ ready, markBooted }: Params) {
  const done = useRef(false);

  useEffect(() => {
    if (!ready || done.current) return;
    done.current = true;

    void (async () => {
      let spaces: SpaceMeta[] = [];
      // 每个 Space 上次的活跃标签下标：不传下去，首次落盘会把没打开过的
      // Space 的 activeTabIndex 归零（持久化侧的既有约定）。
      const initialActiveIndex: Record<string, number> = {};
      try {
        const persisted = await loadAll();
        spaces = persisted.spaces;
        for (const [id, state] of persisted.states) {
          initialActiveIndex[id] = state.activeTabIndex;
        }
      } catch (error) {
        // 读不到就按"没有历史工作区"处理，绝不因此卡住启动。
        console.warn("[spaces] 读取持久化工作区清单失败，按空清单启动:", error);
      }
      useSpaces.getState().hydrate(spaces, null, initialActiveIndex);
      markBooted();
    })();
  }, [ready, markBooted]);
}
