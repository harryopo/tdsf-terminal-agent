/**
 * useTerminalCardTarget —— 守卫的接线（#91 第⑤条）。
 *
 * 纯函数只证明"算得对"，这条证明**目标是在首次渲染时记下的**：
 * 如果实现改成"点击时才取当前终端"，下面第二条就会绿 —— 而那正是缺陷本身
 * （取到的永远是切换后的新终端，守卫形同不存在）。
 */
import { beforeEach, describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";
import { useChatStore } from "../store/chatStore";
import type { TerminalTarget } from "./commandCardTarget";
import { useTerminalCardTarget } from "./useTerminalCardTarget";

const TAB1: TerminalTarget = {
  tabId: 1,
  leafId: 11,
  sshRustSessionId: null,
  label: "docs",
};
const TAB2: TerminalTarget = {
  tabId: 2,
  leafId: 21,
  sshRustSessionId: 9,
  label: "root@10.0.0.8",
};

/** 让 bridge 报告"当前活动终端 = x"。 */
function setActiveTerminal(x: TerminalTarget | null) {
  useChatStore.setState((s) => ({
    live: { ...s.live, getActiveTerminalTarget: () => x },
  }));
}

beforeEach(() => setActiveTerminal(TAB1));

describe("useTerminalCardTarget", () => {
  it("活动终端没变 → 不拦", () => {
    const { result } = renderHook(() => useTerminalCardTarget());
    expect(result.current.blockReason()).toBeNull();
  });

  it("卡片生成后切到别的终端 → 拦下，并且说的是当初那一条", () => {
    const { result } = renderHook(() => useTerminalCardTarget());
    setActiveTerminal(TAB2);
    const reason = result.current.blockReason();
    expect(reason).not.toBeNull();
    expect(reason).toContain("docs");
    expect(reason).not.toContain("root@10.0.0.8");
  });

  it("生成时没有活动终端 → 后来出现终端也不拦", () => {
    setActiveTerminal(null);
    const { result } = renderHook(() => useTerminalCardTarget());
    setActiveTerminal(TAB2);
    expect(result.current.blockReason()).toBeNull();
  });
});
