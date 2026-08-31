/**
 * client.test.ts — 置信度 RPC 客户端测试（2026-08-31 问题3修复）
 * -----------------------------------------------------------------------------
 * 覆盖:
 *   1. localConfidenceReason: 5 维 breakdown → 人话原因（低分维度映射）
 *   2. rpcConfidenceReason: grounded_count/evidence_count/conflict → 原因
 *   3. scoreConfidenceRpc: RPC 成功带 reason / RPC 失败 fail-open 回退本地
 *      评分且附 reason（a+b 组合：低置信度必须附原因，无原因则不显示）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  localConfidenceReason,
  rpcConfidenceReason,
  scoreConfidenceRpc,
} from "./client";
import { scoreConfidence } from "./index";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";

beforeEach(() => {
  vi.mocked(invoke).mockReset();
});

describe("localConfidenceReason — 本地 5 维 breakdown → 原因", () => {
  it("全维度低分时给出至多 2 条最关键原因", () => {
    const reason = localConfidenceReason({
      source: 0,
      terminology: 0,
      verifiability: 0,
      consistency: 0.9,
      specificity: 0,
    });
    expect(reason).toContain("未引用权威来源");
    expect(reason).toContain("缺少可验证细节");
    // 最多 2 条（slice(0, 2)）
    expect(reason!.split("、").length).toBeLessThanOrEqual(2);
  });

  it("全维度达标返回 null（UI 约定：无原因不显示标签）", () => {
    const reason = localConfidenceReason({
      source: 1,
      terminology: 1,
      verifiability: 1,
      consistency: 0.9,
      specificity: 1,
    });
    expect(reason).toBeNull();
  });

  it("一致性矛盾（consistency < 0.9）映射为自相矛盾原因", () => {
    const reason = localConfidenceReason({
      source: 1,
      terminology: 1,
      verifiability: 1,
      consistency: 0.3,
      specificity: 1,
    });
    expect(reason).toBe("表述存在自相矛盾");
  });

  it("真实低分消息（score < 0.5）必有原因（问题3核心约定）", () => {
    // 短口语回答："你好呀！我很乐意帮忙" —— 信号词全无
    const { breakdown, score } = scoreConfidence("你好呀！我很乐意帮忙");
    if (score < 0.5) {
      expect(localConfidenceReason(breakdown)).not.toBeNull();
    } else {
      // 数学保证：score < 0.5 ⇒ 至少一个维度低于阈值；这里兜底验证
      expect(localConfidenceReason(breakdown)).toBeNull();
    }
  });
});

describe("rpcConfidenceReason — Python sidecar payload → 原因", () => {
  it("grounded_count=0（有证据但无落地）→ 未检索到可靠来源佐证", () => {
    expect(
      rpcConfidenceReason({
        score: 0.32,
        evidence_count: 3,
        grounded_count: 0,
      }),
    ).toBe("未检索到可靠来源佐证");
  });

  it("部分落地 → 仅 N/M 条证据落地", () => {
    expect(
      rpcConfidenceReason({
        score: 0.42,
        evidence_count: 3,
        grounded_count: 1,
      }),
    ).toBe("仅 1/3 条证据落地");
  });

  it("高冲突（conflict >= 0.3）→ 证据间存在冲突", () => {
    expect(
      rpcConfidenceReason({
        score: 0.4,
        evidence_count: 2,
        grounded_count: 2,
        conflict: 0.45,
      }),
    ).toBe("证据间存在冲突");
  });

  it("字段齐全且健康 → null（无原因不显示标签）", () => {
    expect(
      rpcConfidenceReason({
        score: 0.85,
        evidence_count: 2,
        grounded_count: 2,
        conflict: 0.1,
      }),
    ).toBeNull();
  });

  it("payload 缺少计数字段 → null", () => {
    expect(rpcConfidenceReason({ score: 0.2 })).toBeNull();
  });
});

describe("scoreConfidenceRpc — RPC 成功路径", () => {
  it("RPC 返回 score + 计数字段 → source=rpc 且附 reason", async () => {
    vi.mocked(invoke).mockResolvedValue({
      score: 0.35,
      method: "D-S+PCR5",
      evidence_count: 3,
      grounded_count: 0,
      conflict: 0.1,
    });
    const r = await scoreConfidenceRpc("回答文本");
    expect(r.source).toBe("rpc");
    expect(r.score).toBe(0.35);
    expect(r.reason).toBe("未检索到可靠来源佐证");
  });

  it("RPC 返回健康 payload → reason=null（UI 不显示标签）", async () => {
    vi.mocked(invoke).mockResolvedValue({
      score: 0.9,
      evidence_count: 2,
      grounded_count: 2,
      conflict: 0.05,
    });
    const r = await scoreConfidenceRpc("回答文本");
    expect(r.source).toBe("rpc");
    expect(r.reason).toBeNull();
  });

  it("RPC 分数钳位到 [0, 1]", async () => {
    vi.mocked(invoke).mockResolvedValue({ score: 7 });
    const r = await scoreConfidenceRpc("x");
    expect(r.score).toBe(1);
  });
});

describe("scoreConfidenceRpc — fail-open 回退路径", () => {
  it("RPC 失败回退本地评分且 breakdown/reason 齐全", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("sidecar down"));
    const r = await scoreConfidenceRpc("你好呀！我很乐意帮忙");
    expect(r.source).toBe("local");
    expect(r.breakdown).toBeDefined();
    // 低分本地评分必须附原因（低置信度必须解释为什么低）
    if (r.score < 0.5) {
      expect(r.reason).not.toBeNull();
    }
  });

  it("RPC 返回非对象 / score 缺失也回退本地", async () => {
    vi.mocked(invoke).mockResolvedValue("garbage");
    const r = await scoreConfidenceRpc("你好呀！我很乐意帮忙");
    expect(r.source).toBe("local");
    expect(r.breakdown).toBeDefined();

    vi.mocked(invoke).mockResolvedValue({ method: "D-S+PCR5" });
    const r2 = await scoreConfidenceRpc("你好呀！我很乐意帮忙");
    expect(r2.source).toBe("local");
  });
});
