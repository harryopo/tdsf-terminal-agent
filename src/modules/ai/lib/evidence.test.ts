/**
 * evidence.test.ts — 会话证据工具函数测试（P1-2）
 * -----------------------------------------------------------------------------
 * 覆盖:
 *   1. evidenceLabel: 工具名 → 中文标签（含 agent: 前缀）
 *   2. evidenceTime: 时间戳 → HH:MM:SS
 *   3. fetchEvidence: 无会话返回空 / RPC 失败返回空
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  evidenceLabel,
  evidenceTime,
  fetchEvidence,
} from "./evidence";

vi.mock("@/lib/sidecar-bridge", () => ({
  invokeRpc: vi.fn(),
}));

import { invokeRpc } from "@/lib/sidecar-bridge";

beforeEach(() => {
  vi.mocked(invokeRpc).mockReset();
});

describe("evidenceLabel — 工具名 → 展示标签", () => {
  it("agent: 前缀映射为 Agent 名", () => {
    expect(evidenceLabel("agent:teach")).toBe("teach Agent");
    expect(evidenceLabel("agent:coding")).toBe("coding Agent");
    expect(evidenceLabel("agent:explore")).toBe("explore Agent");
    expect(evidenceLabel("agent:history")).toBe("history Agent");
  });

  it("运维工具映射为中文标签", () => {
    expect(evidenceLabel("ssh_command")).toBe("SSH 命令");
    expect(evidenceLabel("read_remote_file")).toBe("读远程文件");
    expect(evidenceLabel("analyze_logs")).toBe("日志分析");
    expect(evidenceLabel("suggest_command")).toBe("命令建议");
  });

  it("未知工具名原样返回", () => {
    expect(evidenceLabel("custom_tool")).toBe("custom_tool");
  });
});

describe("evidenceTime — 时间戳格式化", () => {
  it("格式化为 HH:MM:SS", () => {
    // 2026-08-01 12:34:56 UTC
    const ts = Date.UTC(2026, 7, 1, 12, 34, 56) / 1000;
    const t = evidenceTime(ts);
    // 本地时区可能偏移，但结构应为 HH:MM:SS
    expect(t).toMatch(/^\d{2}:\d{2}:\d{2}$/);
  });

  it("0/无效时间戳返回空", () => {
    expect(evidenceTime(0)).toBe("");
    expect(evidenceTime(NaN)).toBe("");
  });
});

describe("fetchEvidence — 会话证据拉取", () => {
  it("无会话 ID 返回空数组（不调用 RPC）", async () => {
    expect(await fetchEvidence(null)).toEqual([]);
    expect(invokeRpc).not.toHaveBeenCalled();
  });

  it("RPC 返回列表透传", async () => {
    const items = [
      {
        tool_name: "ssh_command",
        status: "completed",
        detail: "uptime",
        result: "load average: 0.08",
        agent: "main",
        timestamp: 1000,
      },
    ];
    vi.mocked(invokeRpc).mockResolvedValue(items);
    expect(await fetchEvidence("s1")).toEqual(items);
    expect(invokeRpc).toHaveBeenCalledWith("evidence.list", {
      session_id: "s1",
    });
  });

  it("RPC 失败返回空数组（不抛错）", async () => {
    vi.mocked(invokeRpc).mockRejectedValue(new Error("sidecar down"));
    expect(await fetchEvidence("s1")).toEqual([]);
  });

  it("RPC 返回 null 返回空数组", async () => {
    vi.mocked(invokeRpc).mockResolvedValue(null);
    expect(await fetchEvidence("s1")).toEqual([]);
  });
});
