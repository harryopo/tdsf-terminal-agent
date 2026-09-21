/**
 * autoTypeProvenance.test.tsx — 消息出身闸门
 * -----------------------------------------------------------------------------
 * 钉住 2026-09-21 用户实测的缺陷：打开历史对话会把旧命令重新打进终端
 * （auto 档等于重新执行）。闸门是 fail-closed：**登记过的（从盘读回来）才禁止**，
 * 未登记算本次运行生成；没有 context 的渲染面默认不许自动打字。
 */
import { describe, expect, it } from "vitest";
import { renderHook } from "@testing-library/react";

import {
  LiveMessageProvider,
  __resetAutoTypeProvenance,
  isLiveMessage,
  markMessagesRestored,
  useAutoTypeAllowed,
} from "./autoTypeProvenance";

describe("autoTypeProvenance — 出身登记", () => {
  it("未登记过的消息算本次运行生成（live）", () => {
    __resetAutoTypeProvenance();
    expect(isLiveMessage("msg-fresh")).toBe(true);
  });

  it("登记为读回来的消息永久不再是 live", () => {
    __resetAutoTypeProvenance();
    markMessagesRestored([{ id: "m1" }, { id: "m2" }]);
    expect(isLiveMessage("m1")).toBe(false);
    expect(isLiveMessage("m2")).toBe(false);
    // 重复打开同一会话会再登记一次，不改变结论
    markMessagesRestored([{ id: "m1" }]);
    expect(isLiveMessage("m1")).toBe(false);
  });

  it("live 判定只认精确 id", () => {
    __resetAutoTypeProvenance();
    markMessagesRestored([{ id: "abc" }]);
    expect(isLiveMessage("abc")).toBe(false);
    expect(isLiveMessage("abcd")).toBe(true);
  });

  it("null / undefined 消息列表不抛错（首次打开的空会话）", () => {
    __resetAutoTypeProvenance();
    markMessagesRestored(null);
    markMessagesRestored(undefined);
    expect(isLiveMessage("anything")).toBe(true);
  });
});

describe("autoTypeProvenance — context 传播", () => {
  it("没有 Provider（知识库等非消息面）→ 默认不许自动打字", () => {
    const { result } = renderHook(() => useAutoTypeAllowed());
    expect(result.current).toBe(false);
  });

  it("Provider value=false 不许、value=true 许", () => {
    const off = renderHook(() => useAutoTypeAllowed(), {
      wrapper: ({ children }) => (
        <LiveMessageProvider value={false}>{children}</LiveMessageProvider>
      ),
    });
    expect(off.result.current).toBe(false);
    const on = renderHook(() => useAutoTypeAllowed(), {
      wrapper: ({ children }) => (
        <LiveMessageProvider value>{children}</LiveMessageProvider>
      ),
    });
    expect(on.result.current).toBe(true);
  });
});
