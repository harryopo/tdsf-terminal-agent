import { beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  formatTokenCount,
  notifyUsageChanged,
  queryUsage,
  queryUsageSafely,
  summarizeUsageModels,
  trendPoints,
  type UsageEvent,
} from "./usage";

const event: UsageEvent = {
  event_id: "e1",
  call_id: "c1",
  attempt_id: "a1",
  revision: 1,
  update_mode: "cumulative",
  granularity: "invocation_aggregate",
  session_id: "s1",
  turn_id: "t1",
  provider: "openai",
  requested_model: "gpt-a",
  resolved_model: "gpt-a",
  status: "completed",
  started_at: null,
  completed_at: "2026-11-20T00:00:00+00:00",
  config_snapshot_id: "snapshot-1",
  error_category: null,
  covers_call_ids: [],
  input_tokens: 10,
  output_tokens: 4,
  total_tokens: 14,
  cached_input_tokens: null,
  cache_creation_input_tokens: null,
  reasoning_tokens: 2,
};

beforeEach(() => vi.clearAllMocks());

describe("usage query and presentation", () => {
  it("uses the read-only RPC with exact filters", async () => {
    invokeMock.mockResolvedValue({ summary: { event_count: 0 }, events: [], trend: [] });
    await queryUsage({ sessionId: "s1", provider: "openai", model: "gpt-a", days: 30 });
    expect(invokeMock).toHaveBeenCalledWith("ipc_invoke", {
      method: "usage.summary",
      params: { session_id: "s1", provider: "openai", model: "gpt-a", days: 30 },
    });
  });

  it("propagates asynchronous IPC rejection to the panel error boundary", async () => {
    invokeMock.mockRejectedValue(new Error("async IPC unavailable"));
    await expect(queryUsage({ sessionId: "s1" })).rejects.toThrow("async IPC unavailable");
  });

  it("normalizes asynchronous rejection into an explicit UI error result", async () => {
    invokeMock.mockRejectedValue(new Error("safe IPC unavailable"));
    await expect(queryUsageSafely({ sessionId: "s1" })).resolves.toEqual({
      data: null,
      error: "safe IPC unavailable",
    });
  });

  it("returns safe query facts on success", async () => {
    const data = { summary: { event_count: 0 }, events: [], trend: [] };
    invokeMock.mockResolvedValue(data);
    await expect(queryUsageSafely({ sessionId: "s1" })).resolves.toEqual({
      data,
      error: "",
    });
  });

  it("keeps unknown separate from real zero", () => {
    expect(formatTokenCount(null)).toBe("—");
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(1200)).toBe("1,200");
  });

  it("groups model facts without adding unknown fields as zero", () => {
    const rows = summarizeUsageModels([
      event,
      { ...event, event_id: "e2", input_tokens: null, output_tokens: 3 },
      { ...event, event_id: "e3", resolved_model: "gpt-b", input_tokens: 2 },
    ]);
    expect(rows).toEqual([
      { model: "gpt-a", event_count: 2, input_tokens: 10, output_tokens: 7 },
      { model: "gpt-b", event_count: 1, input_tokens: 2, output_tokens: 4 },
    ]);
  });

  it("creates bounded SVG points for empty, single and partial trends", () => {
    expect(trendPoints([])).toBe("");
    expect(trendPoints([{ input_tokens: 0 }])).toBe("50,90");
    expect(trendPoints([{ input_tokens: null }, { input_tokens: 10 }])).toBe("100,10");
    expect(trendPoints([{ input_tokens: null }])).toBe("");
  });

  it("notifies panels only after a usage fact was recorded", () => {
    const target = typeof window === "undefined" ? new EventTarget() : window;
    vi.stubGlobal("window", target);
    const listener = vi.fn();
    target.addEventListener("tdsf://usage-changed", listener, { once: true });
    notifyUsageChanged("s1");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0].detail).toEqual({ sessionId: "s1" });
    vi.unstubAllGlobals();
  });
});