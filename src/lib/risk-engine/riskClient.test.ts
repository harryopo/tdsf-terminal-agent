// TDSF: riskClient 单元测试 (T2.2)
// -----------------------------------------------------------------------------
// 测试 evaluateRisk 的 RPC 调用 + fail-open 回退逻辑。
// mock @tauri-apps/api/core 的 invoke 函数，模拟 Sidecar 响应。
import { beforeEach, describe, expect, it, vi } from "vitest";

// mock @tauri-apps/api/core —— 必须在 import riskClient 之前
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import { evaluateRisk, evaluateRiskSync, maxRiskLevel } from "./riskClient";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockInvoke.mockReset();
});

describe("evaluateRisk — RPC 成功路径", () => {
  it("L0 → safe（放行）", async () => {
    mockInvoke.mockResolvedValue({
      level: "L0",
      risk_level: "low",
      reason: "safe command",
      require_approval: false,
      matched_rule_name: "",
    });
    const r = await evaluateRisk("ls -la");
    expect(r.level).toBe("safe");
    expect(r.source).toBe("rpc");
    expect(r.requiresConfirmation).toBe(false);
  });

  it("L2 → medium（放行）", async () => {
    mockInvoke.mockResolvedValue({
      level: "L2",
      risk_level: "medium",
      reason: "systemctl restart",
      require_approval: false,
      matched_rule_name: "systemctl_modify",
    });
    const r = await evaluateRisk("systemctl restart nginx");
    expect(r.level).toBe("medium");
    expect(r.source).toBe("rpc");
    expect(r.requiresConfirmation).toBe(false);
  });

  it("L3 → high（需确认）", async () => {
    mockInvoke.mockResolvedValue({
      level: "L3",
      risk_level: "high",
      reason: "rm -rf recursive",
      require_approval: true,
      matched_rule_name: "rm_rf_recursive",
    });
    const r = await evaluateRisk("rm -rf /tmp/foo");
    expect(r.level).toBe("high");
    expect(r.source).toBe("rpc");
    expect(r.requiresConfirmation).toBe(true);
  });

  it("L4 → deny（拒绝）", async () => {
    mockInvoke.mockResolvedValue({
      level: "L4",
      risk_level: "deny",
      reason: "rm -rf /",
      require_approval: false,
      matched_rule_name: "rm_root_wildcard",
    });
    const r = await evaluateRisk("rm -rf /");
    expect(r.level).toBe("deny");
    expect(r.source).toBe("rpc");
    expect(r.requiresConfirmation).toBe(false);
  });

  it("risk_level 字段作为回退映射（无 level 字段）", async () => {
    mockInvoke.mockResolvedValue({
      risk_level: "high",
      reason: "high risk",
      require_approval: true,
    });
    const r = await evaluateRisk("mkfs.ext4 /dev/sda1");
    expect(r.level).toBe("high");
    expect(r.source).toBe("rpc");
  });

  it("正确传递 method 和 params 给 invoke", async () => {
    mockInvoke.mockResolvedValue({ level: "L0", risk_level: "low" });
    await evaluateRisk("ls");
    expect(mockInvoke).toHaveBeenCalledWith("ipc_invoke", {
      method: "risk.evaluate",
      params: { command: "ls" },
    });
  });
});

describe("evaluateRisk — fail-open 回退", () => {
  it("invoke 抛错时回退到本地 TS 评估", async () => {
    mockInvoke.mockRejectedValue(new Error("sidecar not running"));
    const r = await evaluateRisk("ls -la");
    expect(r.source).toBe("local");
    expect(r.level).toBe("safe"); // 本地 evaluate("ls -la") = safe
  });

  it("invoke 返回 null 时回退到本地评估", async () => {
    mockInvoke.mockResolvedValue(null);
    const r = await evaluateRisk("rm -rf /tmp/foo");
    expect(r.source).toBe("local");
    expect(r.level).toBe("high"); // 本地 evaluate 命中 rm_rf_recursive
  });

  it("invoke 返回非对象（字符串）时回退到本地评估", async () => {
    mockInvoke.mockResolvedValue("unexpected string");
    const r = await evaluateRisk("systemctl restart nginx");
    expect(r.source).toBe("local");
    expect(r.level).toBe("medium");
  });

  it("fail-open 时仍能识别高危命令（本地规则库）", async () => {
    mockInvoke.mockRejectedValue(new Error("method not found"));
    const r = await evaluateRisk("rm -rf /");
    expect(r.source).toBe("local");
    expect(r.level).toBe("deny");
    expect(r.requiresConfirmation).toBe(false);
  });

  it("fail-open 时仍能识别 fork 炸弹", async () => {
    mockInvoke.mockRejectedValue("network error");
    const r = await evaluateRisk(":(){:|:&};:");
    expect(r.source).toBe("local");
    expect(r.level).toBe("deny");
  });
});

describe("evaluateRisk — payload 边界情况", () => {
  // 深度体检 Q1（2026-09-18）改了这里的契约：认不出的载荷以前当"safe"处理
  // （fail-open），但 Python 引擎异常时返回的正是这种载荷 → 会把本地已判 deny 的
  // 命令降级。现在"认不出 = 没有信息"，按 high 交给审批，不再冒充安全。
  it("空 payload（所有字段缺失）→ 按 high 处理，不再冒充 safe", async () => {
    mockInvoke.mockResolvedValue({});
    const r = await evaluateRisk("ls");
    expect(r.level).toBe("high");
    expect(r.source).toBe("rpc");
  });

  it("未知 level 值 → 按 high 处理", async () => {
    mockInvoke.mockResolvedValue({ level: "L99", risk_level: "unknown" });
    const r = await evaluateRisk("ls");
    expect(r.level).toBe("high");
  });

  it("require_approval=true 强制 requiresConfirmation=true", async () => {
    mockInvoke.mockResolvedValue({
      level: "L2",
      risk_level: "medium",
      require_approval: true,
      reason: "manual approval required",
    });
    const r = await evaluateRisk("systemctl restart nginx");
    expect(r.level).toBe("medium");
    expect(r.requiresConfirmation).toBe(true);
  });
});

describe("evaluateRiskSync — 同步快速评估", () => {
  it("不调 invoke，直接用本地规则", () => {
    const r = evaluateRiskSync("ls -la");
    expect(r.source).toBe("local");
    expect(r.level).toBe("safe");
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it("同步识别高危命令", () => {
    const r = evaluateRiskSync("rm -rf /tmp/foo");
    expect(r.source).toBe("local");
    expect(r.level).toBe("high");
    expect(r.requiresConfirmation).toBe(true);
  });

  it("同步识别 deny 命令", () => {
    const r = evaluateRiskSync("rm -rf /");
    expect(r.source).toBe("local");
    expect(r.level).toBe("deny");
  });
});

// 深度体检 Q1（2026-09-18，P1）：submitToLeaf 里"本地已判 deny/high → 再拿 RPC 结果
// 精修"这条链，以前是**整体替换**。Python 侧 risk.evaluate 在引擎异常时返回
// `{error, level:"L0"}`，映射后是 safe —— 于是审批卡从「已拒绝(disabled)」
// 变成「仍然执行(enabled)」。现在要求：RPC 只能升不能降。
describe("evaluateRisk — 引擎异常载荷不得降级本地判定（Q1）", () => {
  it("payload 带 error → 视为无信息，回退本地判定", async () => {
    mockInvoke.mockResolvedValue({
      error: "risk engine error",
      level: "L0",
      risk_level: "low",
    });
    const r = await evaluateRisk("rm -rf /");
    expect(r.source).toBe("local");
    expect(r.level).toBe("deny");
  });

  it("level/risk_level 都认不出来 → 按 high 处理，绝不返回 safe", async () => {
    mockInvoke.mockResolvedValue({ level: "L-∞", risk_level: "wtf" });
    const r = await evaluateRisk("anything");
    expect(r.level).toBe("high");
  });

  it("maxRiskLevel 取高者（合并策略的纯函数）", () => {
    expect(maxRiskLevel("deny", "safe")).toBe("deny");
    expect(maxRiskLevel("safe", "deny")).toBe("deny");
    expect(maxRiskLevel("medium", "high")).toBe("high");
    expect(maxRiskLevel("high", "medium")).toBe("high");
    expect(maxRiskLevel("low", "low")).toBe("low");
  });
});
