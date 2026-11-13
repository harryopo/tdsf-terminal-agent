import { describe, expect, it } from "vitest";
import {
  isCorrectionTargetCurrent,
  isSingleEdit,
  suggestBufferCorrection,
  type CorrectionVocabulary,
} from "./correction";
import {
  MAX_CANDIDATES,
  validateCandidateView,
  type PredictionRequest,
  type ScopeToken,
} from "./contracts";

const SCOPE: ScopeToken = {
  namespaceId: "ns-correction",
  leafId: 21,
  rustSessionId: null,
  shellEpoch: "epoch-correction",
  contextRevision: 0,
};

const VOCABULARY: CorrectionVocabulary = {
  commands: ["systemctl", "journalctl", "docker", "grep", "ls", "pwd"],
  subcommands: {
    systemctl: ["status", "start", "stop", "restart"],
  },
  options: {
    systemctl: ["--no-pager", "--quiet"],
  },
};

function request(
  bufferText: string,
  overrides: Partial<PredictionRequest> = {},
): PredictionRequest {
  return {
    requestId: "req-corr-1",
    task: "correct_buffer",
    scope: SCOPE,
    environment: {
      connectionKind: "local",
      osFamily: "linux",
      dialect: "bash",
      targetKey: "target-a",
      userKey: "user-a",
      identityState: "verified",
    },
    inputVersion: 5,
    snapshotVersion: 0,
    cwdKey: null,
    limit: MAX_CANDIDATES,
    terminalState: "idle-with-input",
    buffer: { text: bufferText, cursor: bufferText.length },
    block: null,
    ...overrides,
  };
}

function availabilityOf(...commands: string[]) {
  return new Map(commands.map((command) => [command, "available" as const]));
}

function riskOf(...commands: string[]) {
  return new Map(commands.map((command) => [command, "L0" as const]));
}

function correct(bufferText: string, overrides: Partial<PredictionRequest> = {}) {
  return suggestBufferCorrection({
    request: request(bufferText, overrides),
    current: SCOPE,
    currentInputVersion: 5,
    now: 1000,
    vocabulary: VOCABULARY,
    availability: availabilityOf(...VOCABULARY.commands),
    risk: riskOf(...VOCABULARY.commands),
  });
}

describe("isSingleEdit", () => {
  it("接受一次替换/插入/删除/相邻换位", () => {
    expect(isSingleEdit("sytemctl", "systemctl")).toBe(true);
    expect(isSingleEdit("systemctl", "systemct")).toBe(true);
    expect(isSingleEdit("systemctl", "systemctll")).toBe(true);
    expect(isSingleEdit("statsu", "status")).toBe(true);
  });

  it("拒绝相同文本与两次以上编辑", () => {
    expect(isSingleEdit("pwd", "pwd")).toBe(false);
    expect(isSingleEdit("pwdx", "abxy")).toBe(false);
    expect(isSingleEdit("abc", "xyz")).toBe(false);
  });
});

describe("会话内保守纠错", () => {
  it("只改命令名一个 token，保留参数原样", () => {
    const view = correct("sytemctl status httpd");
    expect(view.status).toBe("ok");
    const insertText = view.candidates[0].insertText ?? "";
    expect(insertText).toBe("systemctl status httpd");
    expect(insertText.endsWith(" httpd")).toBe(true);
    expect(insertText).not.toMatch(/\bsudo\b/);
    expect(insertText).not.toMatch(/[\r\n]/);
    expect(validateCandidateView(view)).toEqual([]);
  });

  it("只改子命令一个 token", () => {
    const view = correct("systemctl statsu httpd");
    expect(view.status).toBe("ok");
    expect(view.candidates[0].insertText).toBe("systemctl status httpd");
    expect(view.candidates[0].source).toBe("spec");
  });

  it("只改静态规格明确的选项名", () => {
    const view = correct("systemctl --no-pagr status");
    expect(view.status).toBe("ok");
    expect(view.candidates[0].insertText).toBe("systemctl --no-pager status");
  });

  it("原本正确的命令不产生候选", () => {
    expect(correct("systemctl status httpd").status).toBe("empty");
  });

  it("复杂语法不自动纠正（管道/重定向/引号/展开）", () => {
    for (const buffer of [
      "sytemctl status httpd | grep run",
      "sytemctl status httpd > /tmp/out",
      'sytemctl status "httpd"',
      "sytemctl status $(hostname)",
    ]) {
      expect(correct(buffer).status, buffer).toBe("unavailable");
    }
  });

  it("可用性/风险未知时不猜可用", () => {
    const noAvailability = suggestBufferCorrection({
      request: request("sytemctl status httpd"),
      current: SCOPE,
      currentInputVersion: 5,
      now: 1000,
      vocabulary: VOCABULARY,
      availability: new Map(),
      risk: riskOf("systemctl"),
    });
    expect(noAvailability.status).toBe("unknown");
    expect(noAvailability.candidates).toEqual([]);

    const risky = suggestBufferCorrection({
      request: request("sytemctl status httpd"),
      current: SCOPE,
      currentInputVersion: 5,
      now: 1000,
      vocabulary: VOCABULARY,
      availability: availabilityOf("systemctl"),
      risk: new Map([["systemctl", "L2" as const]]),
    });
    expect(risky.status).toBe("unknown");
    expect(risky.candidates).toEqual([]);
  });

  it("owner/输入版本变化返回 stale", () => {
    const view = suggestBufferCorrection({
      request: request("sytemctl status httpd"),
      current: { ...SCOPE, contextRevision: 1 },
      currentInputVersion: 5,
      now: 1000,
      vocabulary: VOCABULARY,
      availability: availabilityOf("systemctl"),
      risk: riskOf("systemctl"),
    });
    expect(view.status).toBe("stale");

    const staleInput = suggestBufferCorrection({
      request: request("sytemctl status httpd"),
      current: SCOPE,
      currentInputVersion: 6,
      now: 1000,
      vocabulary: VOCABULARY,
      availability: availabilityOf("systemctl"),
      risk: riskOf("systemctl"),
    });
    expect(staleInput.status).toBe("stale");
  });

  it("接受前复核原文本/光标/owner/输入版本", () => {
    const req = request("sytemctl status httpd");
    expect(
      isCorrectionTargetCurrent(
        req,
        SCOPE,
        5,
        "sytemctl status httpd",
        "sytemctl status httpd".length,
      ),
    ).toBe(true);
    expect(
      isCorrectionTargetCurrent(
        req,
        SCOPE,
        5,
        "sytemctl status httpd ",
        "sytemctl status httpd ".length,
      ),
    ).toBe(false);
    expect(
      isCorrectionTargetCurrent(
        req,
        { ...SCOPE, contextRevision: 2 },
        5,
        "sytemctl status httpd",
        "sytemctl status httpd".length,
      ),
    ).toBe(false);
    expect(
      isCorrectionTargetCurrent(
        req,
        SCOPE,
        6,
        "sytemctl status httpd",
        "sytemctl status httpd".length,
      ),
    ).toBe(false);
  });

  it("纠错候选不超过 UI 上限，且不执行命令", () => {
    const view = correct("sytemctl status httpd");
    expect(view.candidates.length).toBeLessThanOrEqual(MAX_CANDIDATES);
    for (const candidate of view.candidates) {
      expect(candidate.task).toBe("correct_buffer");
      expect(candidate.constraints).toContain("no-execution");
      expect(candidate.constraints).toContain("no-privilege-change");
    }
  });
});
