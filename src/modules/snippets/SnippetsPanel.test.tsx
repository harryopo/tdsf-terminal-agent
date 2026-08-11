/**
 * SnippetsPanel.test.tsx — 代码片段面板组件测试
 * -----------------------------------------------------------------------------
 * 覆盖（P2 代码片段管理）:
 *   1. 空状态显示引导文案
 *   2. 有片段时渲染列表（Frecency 排序由 store 纯函数单测覆盖）
 *   3. 无变量片段点击行 → 直接插入终端 + recordUsage 计数
 *   4. 有变量片段点击行 → 弹出变量解析 Dialog（不直接插入）
 *   5. 搜索过滤
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useSnippetsStore } from "./lib/snippetStore";
import { SnippetsPanel } from "./SnippetsPanel";
import type { Snippet } from "./types";

const onInsertCommand = vi.fn(() => true);

function makeSnippet(over: Partial<Snippet> = {}): Snippet {
  return {
    id: over.id ?? "test-id",
    name: "df",
    command: "df -h",
    description: undefined,
    tags: [],
    variables: [],
    createdAt: 1,
    updatedAt: 1,
    usageCount: 0,
    ...over,
  };
}

beforeEach(() => {
  onInsertCommand.mockClear();
  useSnippetsStore.setState({
    snippets: [],
    hydrated: true,
  });
});

describe("SnippetsPanel — 面板渲染", () => {
  it("空状态显示引导文案与新建按钮", () => {
    render(<SnippetsPanel onInsertCommand={onInsertCommand} />);
    expect(screen.getByText("还没有代码片段")).toBeTruthy();
    expect(screen.getByRole("button", { name: /新建片段/ })).toBeTruthy();
  });

  it("渲染片段列表（名称 + 命令预览）", () => {
    useSnippetsStore.setState({
      snippets: [makeSnippet({ name: "磁盘占用", command: "df -h" })],
      hydrated: true,
    });
    render(<SnippetsPanel onInsertCommand={onInsertCommand} />);
    expect(screen.getByText("磁盘占用")).toBeTruthy();
    expect(screen.getByText("df -h")).toBeTruthy();
  });

  it("搜索过滤片段", () => {
    useSnippetsStore.setState({
      snippets: [
        makeSnippet({ id: "a", name: "磁盘占用", command: "df -h" }),
        makeSnippet({ id: "b", name: "系统更新", command: "dnf update" }),
      ],
      hydrated: true,
    });
    render(<SnippetsPanel onInsertCommand={onInsertCommand} />);
    fireEvent.change(screen.getByTestId("snippets-search-input"), {
      target: { value: "更新" },
    });
    expect(screen.getByText("系统更新")).toBeTruthy();
    expect(screen.queryByText("磁盘占用")).toBeNull();
  });
});

describe("SnippetsPanel — 插入行为", () => {
  it("无变量片段点击行 → 直接插入终端并记录使用次数", () => {
    useSnippetsStore.setState({
      snippets: [makeSnippet({ id: "df-id", name: "磁盘占用", command: "df -h" })],
      hydrated: true,
    });
    render(<SnippetsPanel onInsertCommand={onInsertCommand} />);
    fireEvent.click(screen.getByTestId("snippet-row-磁盘占用"));
    expect(onInsertCommand).toHaveBeenCalledTimes(1);
    expect(onInsertCommand).toHaveBeenCalledWith("df -h");
    expect(useSnippetsStore.getState().snippets[0].usageCount).toBe(1);
  });

  it("有变量片段点击行 → 弹出确认 Dialog，不直接插入", async () => {
    useSnippetsStore.setState({
      snippets: [
        makeSnippet({
          id: "grep-id",
          name: "按模式搜索",
          command: "grep -r {{pattern}} .",
          variables: [{ name: "pattern", defaultValue: "error" }],
        }),
      ],
      hydrated: true,
    });
    render(<SnippetsPanel onInsertCommand={onInsertCommand} />);
    fireEvent.click(screen.getByTestId("snippet-row-按模式搜索"));
    // 懒加载 Dialog 异步挂载
    expect(await screen.findByText("即将插入的命令")).toBeTruthy();
    expect(onInsertCommand).not.toHaveBeenCalled();
  });

  it("无活动终端时插入失败 → 提示且不计数", () => {
    onInsertCommand.mockReturnValue(false);
    useSnippetsStore.setState({
      snippets: [makeSnippet({ id: "df-id", name: "磁盘占用", command: "df -h" })],
      hydrated: true,
    });
    render(<SnippetsPanel onInsertCommand={onInsertCommand} />);
    fireEvent.click(screen.getByTestId("snippet-row-磁盘占用"));
    expect(useSnippetsStore.getState().snippets[0].usageCount).toBe(0);
  });
});
