/**
 * SnippetsPanel.test.tsx — 代码片段面板组件测试
 * -----------------------------------------------------------------------------
 * 覆盖（P2 代码片段管理）:
 *   1. 空状态显示引导文案
 *   2. 有片段时渲染列表（置顶排序由 store 纯函数单测覆盖）
 *   3. 无变量片段点击行 → 直接插入终端
 *   4. 有变量片段点击行 → 弹出变量解析 Dialog（不直接插入）
 *   5. 搜索过滤
 *   6. 置顶 / 取消置顶
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { useSnippetsStore } from "./lib/snippetStore";
import { snippetConfirmation } from "./lib/snippetConfirmation";
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
  it("无变量片段点击行 → 直接插入终端", () => {
    useSnippetsStore.setState({
      snippets: [makeSnippet({ id: "df-id", name: "磁盘占用", command: "df -h" })],
      hydrated: true,
    });
    render(<SnippetsPanel onInsertCommand={onInsertCommand} />);
    fireEvent.click(screen.getByTestId("snippet-row-磁盘占用"));
    expect(onInsertCommand).toHaveBeenCalledTimes(1);
    expect(onInsertCommand).toHaveBeenCalledWith("df -h");
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

  it("无活动终端时插入失败 → 仅提示不崩溃", () => {
    onInsertCommand.mockReturnValue(false);
    useSnippetsStore.setState({
      snippets: [makeSnippet({ id: "df-id", name: "磁盘占用", command: "df -h" })],
      hydrated: true,
    });
    render(<SnippetsPanel onInsertCommand={onInsertCommand} />);
    fireEvent.click(screen.getByTestId("snippet-row-磁盘占用"));
    expect(onInsertCommand).toHaveBeenCalledTimes(1);
  });
});

describe("SnippetsPanel — 置顶", () => {
  it("hover 置顶按钮 → togglePin 写入 pinnedAt", () => {
    useSnippetsStore.setState({
      snippets: [makeSnippet({ id: "df-id", name: "磁盘占用", command: "df -h" })],
      hydrated: true,
    });
    render(<SnippetsPanel onInsertCommand={onInsertCommand} />);
    fireEvent.click(screen.getByTitle("置顶（按置顶顺序排列）"));
    expect(useSnippetsStore.getState().snippets[0].pinnedAt).toBeDefined();
  });

  it("已置顶片段再点 → 取消置顶", () => {
    useSnippetsStore.setState({
      snippets: [
        makeSnippet({ id: "df-id", name: "磁盘占用", command: "df -h", pinnedAt: 100 }),
      ],
      hydrated: true,
    });
    render(<SnippetsPanel onInsertCommand={onInsertCommand} />);
    fireEvent.click(screen.getByTitle("取消置顶"));
    expect(useSnippetsStore.getState().snippets[0].pinnedAt).toBeUndefined();
  });

  it("置顶不触发插入终端", () => {
    useSnippetsStore.setState({
      snippets: [makeSnippet({ id: "df-id", name: "磁盘占用", command: "df -h" })],
      hydrated: true,
    });
    render(<SnippetsPanel onInsertCommand={onInsertCommand} />);
    fireEvent.click(screen.getByTitle("置顶（按置顶顺序排列）"));
    expect(onInsertCommand).not.toHaveBeenCalled();
  });
});

// #166 ③：删除确认收进全应用同一只弹窗（先证"点一下不删"，再证"确认才删"）
describe("SnippetsPanel — 删除走正式确认窗", () => {
  function renderOne() {
    useSnippetsStore.setState({
      snippets: [
        makeSnippet({ id: "df-id", name: "磁盘占用", command: "df -h" }),
      ],
      hydrated: true,
    });
    render(<SnippetsPanel onInsertCommand={onInsertCommand} />);
  }

  it("点行内删除只开窗，片段还在；确认之后才真删", () => {
    renderOne();
    fireEvent.click(screen.getByTitle("删除片段"));
    expect(useSnippetsStore.getState().snippets).toHaveLength(1);

    const dialog = screen.getByTestId("confirm-delete-dialog");
    expect(dialog.textContent).toContain("磁盘占用");
    expect(dialog.textContent).toContain("df -h");

    fireEvent.click(screen.getByTestId("confirm-delete-action"));
    expect(useSnippetsStore.getState().snippets).toHaveLength(0);
  });

  it("取消什么都不删（上一条是正向配对：确认键真删得掉，这条「不删」才算数）", () => {
    renderOne();
    fireEvent.click(screen.getByTitle("删除片段"));
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    expect(useSnippetsStore.getState().snippets).toHaveLength(1);
    expect(screen.queryByTestId("confirm-delete-dialog")).toBeNull();
  });
});

// #166 ③：删除确认换成全应用同一只弹窗，文案由这个纯函数给 —— 直接测它，
// 不必为了两句真话去渲染整棵面板
describe("snippetConfirmation — 删除片段要说的真话", () => {
  it("把命令本体摆进事实行（列表里同名片段靠命令分辨）", () => {
    const c = snippetConfirmation(
      makeSnippet({ name: "磁盘", command: "df -h | tail -3", tags: ["运维"] }),
    );
    expect(c.subject).toBe("这个片段");
    expect(c.name).toBe("磁盘");
    expect(c.facts).toContainEqual({ label: "命令", value: "df -h | tail -3" });
    expect(c.facts).toContainEqual({ label: "标签", value: "运维" });
  });

  it("说清不可恢复，同时不夸大成'会影响主机'", () => {
    const c = snippetConfirmation(makeSnippet({ tags: [] }));
    expect(c.impact).toContain("无法恢复");
    // 没有标签时不许留一行空的"标签："
    expect(c.facts?.some((f) => f.label === "标签")).toBe(false);
  });
});
