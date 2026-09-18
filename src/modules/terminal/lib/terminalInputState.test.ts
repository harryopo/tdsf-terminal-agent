/**
 * terminalInputState.test.ts — 用户输入行脏标记与 agent 待命纠正
 * -----------------------------------------------------------------------------
 * 钉住 ROADMAP #55/#57 的两条判定：
 *   1. 用户往提示行上打了可见字符 → 脏，自动打字必须避让
 *   2. 提交（Enter）/ Ctrl-C / Ctrl-U / Ctrl-W → 不再脏
 *   3. 退格等无法判断行是否已空的控制键 → 保守保持脏（宁可少打字，不可覆盖用户）
 *   4. 用户提交了自己敲的那一行 → 撤销 agentPending，避免作者误标
 *   5. agent 注入后用户只按回车 → 行不脏，agentPending 保留（正确记为 agent）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useTerminalBlocksStore } from "./terminalBlocksStore";
import {
  __resetTerminalInputState,
  clearUserLine,
  isUserLineDirty,
  noteUserInput,
} from "./terminalInputState";

const LEAF = 42;

beforeEach(() => {
  __resetTerminalInputState();
  useTerminalBlocksStore.setState({ agentPending: {} });
});

describe("terminalInputState — 脏行判定", () => {
  it("初始不脏", () => {
    expect(isUserLineDirty(LEAF)).toBe(false);
  });

  it("输入可见字符 → 脏", () => {
    noteUserInput(LEAF, "l");
    expect(isUserLineDirty(LEAF)).toBe(true);
  });

  it("粘贴整段命令（未回车）→ 脏", () => {
    noteUserInput(LEAF, "systemctl status nginx");
    expect(isUserLineDirty(LEAF)).toBe(true);
  });

  it("回车提交 → 取消脏标记", () => {
    noteUserInput(LEAF, "uptime");
    noteUserInput(LEAF, "\r");
    expect(isUserLineDirty(LEAF)).toBe(false);
  });

  it("Ctrl-C 整行作废 → 取消脏标记", () => {
    noteUserInput(LEAF, "rm -rf");
    noteUserInput(LEAF, "\x03");
    expect(isUserLineDirty(LEAF)).toBe(false);
  });

  // 深度体检 Q3（2026-09-18）：这三条以前被钉成"清行 → 取消脏标记"，但那是错的语义 ——
  // Ctrl-U 只删到行首、Ctrl-W 只删一个词、Ctrl-K 只删到行尾，行里都可能还有内容。
  // 若此时清账，闸门会放行，AI 就把命令打在用户残行上（正是 M1 修的那类事故）。
  it.each([
    ["Ctrl-U（删到行首）", "\x15"],
    ["Ctrl-W（删一个词）", "\x17"],
    ["Ctrl-K（删到行尾）", "\x0b"],
  ])("%s 之后仍保持脏，不擅自认为行已空", (_label, seq) => {
    noteUserInput(LEAF, "docker-compose -f ");
    noteUserInput(LEAF, seq);
    expect(isUserLineDirty(LEAF)).toBe(true);
  });

  it("纯退格不改变已有脏状态（无法判断行是否已空，保守保持脏）", () => {
    noteUserInput(LEAF, "ls");
    noteUserInput(LEAF, "\x7f");
    expect(isUserLineDirty(LEAF)).toBe(true);
  });

  it("clearUserLine 用于终端销毁时清账", () => {
    noteUserInput(LEAF, "ls");
    clearUserLine(LEAF);
    expect(isUserLineDirty(LEAF)).toBe(false);
  });

  it("leafId 之间互不影响", () => {
    noteUserInput(LEAF, "l");
    expect(isUserLineDirty(LEAF + 1)).toBe(false);
  });
});

describe("terminalInputState — agentPending 作者误标纠正（#57）", () => {
  it("用户自己敲完整条并提交 → 撤销 agent 待命标记", () => {
    useTerminalBlocksStore.getState().markAgentPending(LEAF);
    noteUserInput(LEAF, "df");
    noteUserInput(LEAF, " -h");
    noteUserInput(LEAF, "\r");
    expect(useTerminalBlocksStore.getState().agentPending[LEAF]).toBeUndefined();
  });

  it("agent 注入后用户只按回车 → 标记保留，仍记为 agent", () => {
    const clearSpy = vi.spyOn(useTerminalBlocksStore.getState(), "clearAgentPending");
    useTerminalBlocksStore.getState().markAgentPending(LEAF);
    noteUserInput(LEAF, "\r");
    expect(clearSpy).not.toHaveBeenCalled();
    expect(useTerminalBlocksStore.getState().agentPending[LEAF]).toBeTypeOf("number");
  });

  it("resolveAuthor 仍按原逻辑消费标记 → 返回 agent", () => {
    useTerminalBlocksStore.getState().markAgentPending(LEAF);
    expect(useTerminalBlocksStore.getState().resolveAuthor(LEAF, "uptime")).toBe(
      "agent",
    );
  });
});
