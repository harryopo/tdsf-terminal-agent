/**
 * TodoStrip.test.tsx — T3 规划-执行回环：completedAt 完成时间戳测试
 * -----------------------------------------------------------------------------
 * 覆盖（spec add-agent-loop-closure Task 3.3）:
 *   1. completed 项显示 completedAt 小字时间（data-testid="todo-completed-at"）
 *   2. pending / in_progress 项不显示时间戳
 *   3. 旧数据 completed 无 completedAt 字段 → 不渲染（向后兼容）
 *   4. 跨天完成时间带日期前缀（MM-DD HH:MM）
 *   5. 进度统计（completed/total）
 *
 * todoStore 直接 setState（hydrate 已含 session，避免触发 Tauri 持久层）
 */
import { afterEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { TodoStrip } from "./TodoStrip";
import { useTodosStore } from "../store/todoStore";
import type { Todo } from "../lib/todos";

const SESSION = "t3-test-session";

function setTodos(todos: Todo[]) {
  useTodosStore.setState({
    bySession: { [SESSION]: todos },
    hydrated: new Set([SESSION]),
  });
}

/**
 * 「全部完成 ⇒ 自动收起」以后，只有一条完成项的清单默认是收起的，时间戳在列表里。
 * 这一组的用例考的是时间戳不是折叠，所以先把列表展开；展开这件事本身由下面
 * 专门的一组用例负责。
 */
function expandList() {
  if (!screen.queryByTestId("todo-strip-list")) {
    fireEvent.click(screen.getByTestId("todo-strip-toggle"));
  }
  return screen.getByTestId("todo-strip-list");
}

afterEach(() => {
  useTodosStore.setState({ bySession: {}, hydrated: new Set() });
});

describe("TodoStrip — completedAt 完成时间戳（T3）", () => {
  it("completed 项显示完成时间小字", () => {
    const now = new Date();
    const iso = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      14,
      30,
    ).toISOString();
    setTodos([
      {
        id: "a",
        title: "检查 nginx 状态",
        status: "completed",
        completedAt: iso,
      },
    ]);
    render(<TodoStrip sessionId={SESSION} />);
    expandList();
    const ts = screen.getByTestId("todo-completed-at");
    expect(ts.textContent).toContain("14:30");
  });

  it("pending / in_progress 项不显示时间戳", () => {
    setTodos([
      { id: "a", title: "待办步骤", status: "pending" },
      {
        id: "b",
        title: "进行中步骤",
        status: "in_progress",
        completedAt: "2026-08-31T10:00:00",
      },
    ]);
    render(<TodoStrip sessionId={SESSION} />);
    expect(screen.queryByTestId("todo-completed-at")).toBeNull();
  });

  it("旧数据 completed 无 completedAt → 不渲染时间（向后兼容）", () => {
    setTodos([{ id: "a", title: "历史完成项", status: "completed" }]);
    render(<TodoStrip sessionId={SESSION} />);
    // 负向断言配正向：先证明列表与那一行真的渲染出来了，
    // 否则"时间戳没出现"会因为"列表压根没展开"而假绿。
    expandList();
    expect(screen.getByText("历史完成项")).toBeTruthy();
    expect(screen.queryByTestId("todo-completed-at")).toBeNull();
  });

  it("跨天完成时间带日期前缀（MM-DD）", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const iso = new Date(
      yesterday.getFullYear(),
      yesterday.getMonth(),
      yesterday.getDate(),
      9,
      5,
    ).toISOString();
    setTodos([
      { id: "a", title: "昨天完成的", status: "completed", completedAt: iso },
    ]);
    render(<TodoStrip sessionId={SESSION} />);
    expandList();
    const ts = screen.getByTestId("todo-completed-at");
    // 跨天格式 "MM-DD HH:MM"（含日期分隔符）
    expect(ts.textContent).toMatch(/\d{2}-\d{2} \d{2}:\d{2}/);
  });

  it("进度统计显示 completed/total", () => {
    setTodos([
      { id: "a", title: "步骤一", status: "completed" },
      { id: "b", title: "步骤二", status: "pending" },
    ]);
    render(<TodoStrip sessionId={SESSION} />);
    expect(screen.getByText("任务清单")).toBeTruthy();
    expect(screen.getByText("1/2")).toBeTruthy();
  });

  it("无 todo 或无 session 不渲染", () => {
    setTodos([]);
    const { container } = render(<TodoStrip sessionId={SESSION} />);
    expect(container.firstChild).toBeNull();
    const { container: c2 } = render(<TodoStrip sessionId={null} />);
    expect(c2.firstChild).toBeNull();
  });
});

// ============================================================================
// 用户 2026-09-24 两条：
//   ①「希望有一个折叠展开的 UI，能够折叠起来，不影响输出的观看视野」
//   ②「完成的 UI 显示是一个圈角正方形中间又有一个钩，但是我感觉很丑」
// ②的根因是**三层嵌套**：外层 span 已经是 `rounded-full`（圆），里面又塞了
// `CheckmarkSquare02Icon`（方框带钩）⇒ 圆里套方、方里再套钩。修法=圆里只放一个光钩，
// 待处理则放一个空心圆（不再塞 SquareIcon）。
// 判据要能证伪：断言"标记内 svg 的路径数 ≤ 1"与"待处理标记里没有 svg"，
// 装回旧图标会当场红。
// ============================================================================
describe("TodoStrip — 折叠展开 + 状态标记不套娃", () => {
  it("点标题行收起清单，再点展开", () => {
    setTodos([
      { id: "a", title: "步骤一", status: "completed" },
      { id: "b", title: "步骤二", status: "pending" },
    ]);
    render(<TodoStrip sessionId={SESSION} />);
    expect(screen.getByTestId("todo-strip-list")).toBeTruthy();
    const toggle = screen.getByTestId("todo-strip-toggle");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(screen.queryByTestId("todo-strip-list")).toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(screen.getByTestId("todo-strip-list")).toBeTruthy();
  });

  it("全部完成 ⇒ 自动收起（把视野还给输出），手动展开后不再被强制收起", () => {
    setTodos([
      { id: "a", title: "一", status: "completed" },
      { id: "b", title: "二", status: "completed" },
    ]);
    const { rerender } = render(<TodoStrip sessionId={SESSION} />);
    expect(screen.queryByTestId("todo-strip-list")).toBeNull();
    const toggle = screen.getByTestId("todo-strip-toggle");
    fireEvent.click(toggle);
    expect(screen.getByTestId("todo-strip-list")).toBeTruthy();
    // 父组件再渲染一次（同一条会话、仍然全完成）也不许把它偷偷收回去
    rerender(<TodoStrip sessionId={SESSION} />);
    expect(screen.getByTestId("todo-strip-list")).toBeTruthy();
  });

  it("收起时若有进行中项，仍要说清在跑哪一步", () => {
    setTodos([
      { id: "a", title: "先做完的", status: "completed" },
      { id: "b", title: "正在跑的步骤", status: "in_progress" },
    ]);
    render(<TodoStrip sessionId={SESSION} />);
    // 正向配对：没全完成时默认是展开的 —— 先证明列表真的在，
    // 否则"收起后列表不在"这条会因为"元素压根不存在"而假绿。
    expect(screen.getByTestId("todo-strip-list")).toBeTruthy();
    fireEvent.click(screen.getByTestId("todo-strip-toggle"));
    expect(screen.queryByTestId("todo-strip-list")).toBeNull();
    expect(screen.getByTestId("todo-current").textContent).toContain(
      "正在跑的步骤",
    );
  });

  it("状态标记不许套娃：完成=圆里一个光钩（≤1 条路径），待处理=空心圆（不放图形）", () => {
    setTodos([
      { id: "a", title: "完成的", status: "completed" },
      { id: "b", title: "待处理的", status: "pending" },
    ]);
    const { container } = render(<TodoStrip sessionId={SESSION} />);
    const done = container.querySelector('[aria-label="已完成"]');
    const pending = container.querySelector('[aria-label="待处理"]');
    expect(done).not.toBeNull();
    expect(pending).not.toBeNull();
    // 完成：有钩，但只允许一条路径（CheckmarkSquare02Icon 是 2 条 = 方框 + 钩）
    const donePaths = done?.querySelectorAll("svg path") ?? [];
    expect(donePaths.length).toBeGreaterThan(0);
    expect(donePaths.length).toBeLessThanOrEqual(1);
    // 待处理：空心圆，里面什么都不塞（旧实现塞了 SquareIcon）
    expect(pending?.querySelector("svg")).toBeNull();
  });
});

// ============================================================================
// 用户 2026-09-24 看图提的两处排版缺陷（图5）：
//   ①「todo 代办进行时的待完成圆圈不在卡片中间」—— 标记原来钉在 `top-1.5`，
//      所以两行的卡片（进行中带 description）里它贴在顶上；
//   ②「下滑栏和已完成文字重叠，应当有一些间距」—— ScrollArea 的滚动条是
//      绝对定位盖在内容上的（w-2.5），列表没有右内边距就会被它压住。
// happy-dom 不做布局，所以这里钉的是**结构事实**（类名），不是像素；
// 像素级由 pnpm probe:ui 负责。装回旧写法这两条都会红。
// ============================================================================
describe("TodoStrip — 标记垂直居中 + 列表给滚动条留位", () => {
  it("状态标记垂直居中于整行（两行的卡片里也居中），不再钉在行首", () => {
    setTodos([
      { id: "a", title: "正在跑的步骤", status: "in_progress", description: "两行卡片" },
    ]);
    const { container } = render(<TodoStrip sessionId={SESSION} />);
    const marker = container.querySelector('[aria-label="进行中"]');
    expect(marker).not.toBeNull();
    const cls = String(marker?.className);
    expect(cls).toContain("top-1/2");
    expect(cls).toContain("-translate-y-1/2");
    expect(cls).not.toContain("top-1.5");
  });

  it("列表右侧留出滚动条的位子，状态文字不被压住", () => {
    setTodos([
      { id: "a", title: "完成的", status: "completed", completedAt: "2026-09-24T10:00:00" },
    ]);
    const { container } = render(<TodoStrip sessionId={SESSION} />);
    expandList();
    const ul = container.querySelector("ul");
    expect(ul).not.toBeNull();
    expect(String(ul?.className)).toMatch(/\bpr-\d/);
  });
});
