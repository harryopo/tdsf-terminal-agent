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
import { render, screen } from "@testing-library/react";

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
