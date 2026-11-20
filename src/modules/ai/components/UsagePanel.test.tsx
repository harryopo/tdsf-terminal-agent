import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UsageQueryResult } from "../lib/usage";

const queryMock = vi.fn();

import { notifyUsageChanged } from "../lib/usage";
import { UsagePanel } from "./UsagePanel";

function result(partial: Partial<UsageQueryResult["summary"]> = {}): UsageQueryResult {
  return {
    summary: {
      event_count: 0,
      input_tokens: null,
      output_tokens: null,
      total_tokens: null,
      cached_input_tokens: null,
      cache_creation_input_tokens: null,
      reasoning_tokens: null,
      ...partial,
    },
    events: [],
    trend: [],
  };
}

beforeEach(() => queryMock.mockReset());


describe("UsagePanel", () => {
  it("distinguishes empty facts from zero", async () => {
    queryMock.mockResolvedValue({ data: result(), error: "" });
    render(<UsagePanel loadUsage={queryMock} sessionId="s1" compact />);
    expect(await screen.findByText("尚无实报；未知不会按 0 计入。")).toBeInTheDocument();
    expect(queryMock).toHaveBeenCalledWith({ sessionId: "s1", days: 90 });
  });

  it("renders partial facts, model grouping and snapshot without filling unknown", async () => {
    const data = result({ event_count: 1, input_tokens: 0, output_tokens: 4 });
    data.events = [{
      event_id: "e1", call_id: "c1", attempt_id: "a1", revision: 1,
      update_mode: "cumulative", granularity: "invocation_aggregate",
      session_id: "s1", turn_id: "t1", provider: "openai",
      requested_model: "gpt-a", resolved_model: "gpt-a", status: "completed",
      started_at: null, completed_at: "2026-11-20T00:00:00+00:00",
      config_snapshot_id: "snapshot-1", error_category: null, covers_call_ids: [],
      input_tokens: 0, output_tokens: 4, total_tokens: null,
      cached_input_tokens: null, cache_creation_input_tokens: null, reasoning_tokens: null,
    }];
    data.trend = [{ date: "2026-11-20", ...data.summary }];
    queryMock.mockResolvedValue({ data, error: "" });
    render(<UsagePanel loadUsage={queryMock} sessionId="s1" compact />);

    expect(await screen.findByText("gpt-a")).toBeInTheDocument();
    expect(screen.getByText("1 次 · 入 0 · 出 4")).toBeInTheDocument();
    expect(screen.getByText(/配置快照 snapshot-1/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /仅绘制已知数据/ })).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });

  it("shows query failure instead of stale or fabricated totals", async () => {
    queryMock.mockResolvedValue({ data: null, error: "offline" });
    render(<UsagePanel loadUsage={queryMock} />);
    expect(await screen.findByText("用量读取失败：offline")).toBeTruthy();
    expect(screen.queryByText("实报调用")).not.toBeInTheDocument();
  });

  it("applies provider/model/session/day filters through the same RPC", async () => {
    queryMock.mockResolvedValue({ data: result(), error: "" });
    render(<UsagePanel loadUsage={queryMock} showFilters />);
    await screen.findByText("尚无实报；未知不会按 0 计入。");
    fireEvent.change(screen.getByLabelText("Provider 筛选"), { target: { value: "openai" } });
    fireEvent.change(screen.getByLabelText("模型筛选"), { target: { value: "gpt-a" } });
    fireEvent.change(screen.getByLabelText("会话筛选"), { target: { value: "s1" } });
    fireEvent.click(screen.getByRole("combobox", { name: "查询天数" }));
    fireEvent.click(await screen.findByRole("option", { name: "30 天" }));
    fireEvent.click(screen.getByRole("button", { name: "筛选" }));

    await waitFor(() => expect(queryMock).toHaveBeenLastCalledWith({
      provider: "openai", model: "gpt-a", sessionId: "s1", days: 30,
    }));
  });

  it("refreshes the matching session after an入账 event", async () => {
    queryMock.mockResolvedValue({ data: result({ event_count: 1, input_tokens: 1 }), error: "" });
    render(<UsagePanel loadUsage={queryMock} sessionId="s1" compact />);
    await waitFor(() => expect(queryMock).toHaveBeenCalledTimes(1));
    notifyUsageChanged("other");
    expect(queryMock).toHaveBeenCalledTimes(1);
    notifyUsageChanged("s1");
    await waitFor(() => expect(queryMock).toHaveBeenCalledTimes(2));
  });
});