/**
 * 会话证据状态客户端测试。
 *
 * 用户可见状态只能来自 sidecar 记录的真实工具调用；服务不可用时必须
 * 明确降为“待核验”，不得退回到按模型文本猜测的启发式评分。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assessSessionEvidence } from "./client";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("assessSessionEvidence", () => {
  it("只向后端请求当前会话的真实证据", async () => {
    vi.mocked(invoke).mockResolvedValue({
      tier: "grounded",
      reason: "已记录 1 项真实工具结果。",
      evidence_count: 1,
      sources: [{ tool_name: "knowledge_search" }],
      scope: "session",
    });

    const result = await assessSessionEvidence("chat-1");

    expect(invoke).toHaveBeenCalledWith("ipc_invoke", {
      method: "evidence.assess",
      params: { session_id: "chat-1" },
    });
    expect(result).toMatchObject({
      tier: "grounded",
      source: "rpc",
      evidenceCount: 1,
      sources: [{ toolName: "knowledge_search" }],
    });
  });

  it("服务不可用时保守地显示待核验，不从回答文本推断来源", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("sidecar down"));

    const result = await assessSessionEvidence("chat-1");

    expect(result).toEqual({
      tier: "unverified",
      source: "unavailable",
      reason: "证据服务不可用，未对回答文本作任何推断。",
      evidenceCount: 0,
      sources: [],
      scope: "session",
    });
  });

  it("缺少会话或返回格式异常时同样不伪造评分", async () => {
    expect(await assessSessionEvidence(null)).toMatchObject({
      tier: "unverified",
      source: "unavailable",
      evidenceCount: 0,
    });
    expect(invoke).not.toHaveBeenCalled();

    vi.mocked(invoke).mockResolvedValue({ tier: "high", score: 0.99 });
    expect(await assessSessionEvidence("chat-1")).toMatchObject({
      tier: "unverified",
      source: "unavailable",
      evidenceCount: 0,
    });
  });
});
