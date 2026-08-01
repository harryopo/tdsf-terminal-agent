/**
 * MockLLMWarning.test.tsx — Mock LLM 告警组件测试
 * -----------------------------------------------------------------------------
 * 覆盖（P0-5 补测试）:
 *   1. 无事件时不渲染（返回 null）
 *   2. listen 事件到达后显示告警 label（未配置 LLM / 调用失败降级）
 *   3. 点击触发 navigate 事件（设置页）
 *   4. timestamp 去重：旧事件不覆盖新事件
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// 动态 import 的 Tauri API：先 mock 模块再触发事件回调
const listenMock = vi.fn();
const emitMock = vi.fn();
let capturedListener: ((event: { payload: unknown }) => void) | null = null;

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_eventName: string, cb: (event: { payload: unknown }) => void) => {
    capturedListener = cb;
    return Promise.resolve(() => {});
  }),
  emit: vi.fn((...args: unknown[]) => {
    emitMock(...args);
    return Promise.resolve();
  }),
}));

// event.history RPC：mock 返回空（避免补发逻辑干扰）
vi.mock("@/lib/sidecar-bridge", () => ({
  invokeRpc: vi.fn().mockResolvedValue(null),
}));

import { MockLLMWarning } from "./MockLLMWarning";
import { TooltipProvider } from "@/components/ui/tooltip";

/** Tooltip 需要 Provider 包裹（组件内 Tooltip 依赖 Radix context） */
const renderWithProvider = (ui: React.ReactElement) =>
  render(<TooltipProvider>{ui}</TooltipProvider>);

const fire = (payload: unknown) => capturedListener?.({ payload });

/** 等待组件 effect 完成 listen 注册（动态 import 是异步的） */
async function waitForListener() {
  for (let i = 0; i < 50; i++) {
    if (capturedListener) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("listener not registered");
}

beforeEach(() => {
  capturedListener = null;
  listenMock.mockClear();
  emitMock.mockClear();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("MockLLMWarning — 告警组件", () => {
  it("无事件时不渲染", () => {
    renderWithProvider(<MockLLMWarning />);
    expect(screen.queryByTestId("mock-llm-warning")).toBeNull();
  });

  it("no_llm_config 事件到达后显示告警", async () => {
    renderWithProvider(<MockLLMWarning />);
    await waitForListener();
    fire({
      agent: "main",
      reason: "no_llm_config",
      detail: "未注入 LLM",
      timestamp: 1000,
    });
    expect(await screen.findByTestId("mock-llm-warning")).toBeTruthy();
    expect(screen.getByText("未配置 LLM")).toBeTruthy();
    expect(screen.getByText(/main/)).toBeTruthy();
  });

  it("llm_call_failed 事件显示降级标签", async () => {
    renderWithProvider(<MockLLMWarning />);
    await waitForListener();
    fire({
      agent: "teach",
      reason: "llm_call_failed",
      detail: "API Key 无效",
      timestamp: 1000,
    });
    expect(await screen.findByText("LLM 调用失败降级")).toBeTruthy();
  });

  it("旧 timestamp 事件不覆盖新事件", async () => {
    renderWithProvider(<MockLLMWarning />);
    await waitForListener();
    fire({
      agent: "a",
      reason: "no_llm_config",
      detail: "x",
      timestamp: 2000,
    });
    await waitForListener();
    fire({
      agent: "b",
      reason: "no_llm_config",
      detail: "y",
      timestamp: 1000, // 旧事件 → 忽略
    });
    expect(await screen.findByText(/a/)).toBeTruthy();
    expect(screen.queryByText(/b/)).toBeNull();
  });

  it("点击告警触发 navigate 到设置页", async () => {
    renderWithProvider(<MockLLMWarning />);
    await waitForListener();
    fire({
      agent: "main",
      reason: "no_llm_config",
      detail: "d",
      timestamp: 1000,
    });
    const btn = await screen.findByTestId("mock-llm-warning");
    fireEvent.click(btn);
    // onClick 内部是动态 import 后 emit，等待异步落地
    await new Promise((r) => setTimeout(r, 30));
    expect(emitMock).toHaveBeenCalledWith("navigate", {
      route: "settings",
      section: "models",
    });
  });
});
