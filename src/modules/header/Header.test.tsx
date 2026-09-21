// -----------------------------------------------------------------------------
// #103 返工的接线检查（2026-09-21 用户实测纠正）
//
// 用户原话：「⌘ 和通知我说的是挪到左侧的最右侧，就是侧边栏的最右侧，大概也是原来
// 的地方，只不过靠右顶格」。第一版把"右对齐"理解成窗口右端，被当场退回。
//
// 这里只钉**结构**（控件挂在哪个容器里、左簇宽度跟不跟侧栏变量）；像素级的"顶格"
// 与"分隔线对齐"jsdom 量不出来，由 `pnpm probe:ui` 的 dividerMisaligned +
// controlOutsideLeftCluster 两条规则在真机把关。
// -----------------------------------------------------------------------------
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

// 子组件一律换成带同样 data-testid 的桩：本测的是 Header 的摆位，不是它们内部。
vi.mock("@/components/WindowControls", () => ({
  WindowControls: () => <div data-testid="window-controls" />,
}));
vi.mock("@/modules/agents", () => ({
  NotificationBell: () => <span data-testid="header-notification-bell" />,
}));
vi.mock("@/modules/ai/components/AgentStatusPill", () => ({
  AgentStatusPill: () => <span data-testid="header-agent-status-pill" />,
}));
vi.mock("@/modules/tabs", () => ({
  TabBar: () => <div data-testid="tab-bar" />,
}));
vi.mock("./SearchInline", () => ({
  SearchInline: () => <div data-testid="search-inline" />,
}));
vi.mock("@/modules/theme", () => ({
  useTheme: () => ({ resolvedMode: "dark", setMode: vi.fn() }),
}));
vi.mock("@/modules/translate", () => ({
  useTranslateStore: (sel: (s: unknown) => unknown) =>
    sel({ enabled: false, toggleEnabled: vi.fn() }),
}));

const { Header } = await import("./Header");

function renderHeader() {
  const noop = () => {};
  return render(
    <Header
      tabs={[]}
      activeId={0}
      onSelect={noop}
      onNew={noop}
      onNewEditor={noop}
      onClose={noop}
      onPin={noop}
      onRename={noop}
      onReorder={noop}
      onToggleSidebar={noop}
      onOpenCommandPalette={noop}
      onActivateAgent={noop}
      onActivateLocalAgent={noop}
      onOpenSettings={noop}
      spaceSwitcher={<div data-testid="space-switcher" />}
      searchTarget={null}
      searchRef={{ current: null }}
    />,
  );
}

afterEach(cleanup);

/** 取某控件最近的「左簇」祖先（找不到返回 null） */
function insideLeftCluster(testId: string): boolean {
  const el = screen.getByTestId(testId);
  return Boolean(el.closest('[data-testid="header-left-cluster"]'));
}

describe("Header — ⌘ 与通知在顶栏左簇的最右侧（用户实测口径）", () => {
  it("命令面板与通知都挂在左簇容器里，不在窗口右端那一簇", () => {
    renderHeader();
    expect(insideLeftCluster("header-command-palette")).toBe(true);
    expect(insideLeftCluster("header-notification-bell")).toBe(true);
    // 反面对照：搜索框属于右簇，必须在左簇之外 —— 少了这条，
    // "整个顶栏都被塞进左簇"也能让上面两条一起绿。
    expect(insideLeftCluster("search-inline")).toBe(false);
    expect(insideLeftCluster("space-switcher")).toBe(false);
  });

  it("左簇与分隔线是顶栏根的兄弟节点（分隔线跟随左簇的前提）", () => {
    const { container } = renderHeader();
    const cluster = container.querySelector<HTMLElement>(
      '[data-testid="header-left-cluster"]',
    );
    const divider = container.querySelector<HTMLElement>(
      '[data-testid="header-divider"]',
    );
    expect(cluster).not.toBeNull();
    expect(divider).not.toBeNull();
    expect(divider?.parentElement).toBe(cluster?.parentElement);
    // 「左簇宽度 = 侧栏宽」这条耦合（style 里的 calc(var(--tdsf-sidebar-w) - 9px)）
    // 在 happy-dom 里读不到：它不认 calc()，直接把这个声明丢掉。所以由真机门禁
    // probe:ui 的 dividerMisaligned + controlOutsideLeftCluster 两条规则量像素。
  });
});
