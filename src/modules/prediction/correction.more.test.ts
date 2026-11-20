/**
 * CORR-03 P2（ROOT v1.2 §P2.5）：显式“更多词形候选”的算法边界。
 * 自动层单编辑不受影响；这里只测次级入口的门槛、参数保留与过滤。
 */
import { describe, expect, it } from "vitest";

import type {
  PredictionRequest,
  RiskLevel,
  ScopeToken,
} from "./contracts";
import {
  boundedEditDistance,
  suggestBufferCorrection,
  suggestBufferCorrectionMore,
} from "./correction";

const scope: ScopeToken = {
  namespaceId: "leaf:1:1",
  leafId: 1,
  rustSessionId: null,
  shellEpoch: "leaf:1:1:epoch-1",
  contextRevision: 0,
};

const COMMANDS = [
  "ls",
  "ll",
  "less",
  "lsns",
  "lssu",
  "grep",
  "systemctl",
  "cat",
  "date",
  "pwd",
];

function makeRequest(text: string, inputVersion = 1): PredictionRequest {
  return {
    requestId: "corr:1:1",
    task: "correct_buffer",
    scope,
    environment: {
      connectionKind: "local",
      osFamily: "linux",
      dialect: "bash",
      targetKey: null,
      userKey: null,
      identityState: "unknown",
    },
    inputVersion,
    snapshotVersion: 0,
    cwdKey: null,
    limit: 5,
    terminalState: "idle-with-input",
    buffer: { text, cursor: text.length },
    block: null,
  };
}

function makeInput(
  text: string,
  opts?: {
    commands?: string[];
    unavailable?: string[];
    risk?: Record<string, RiskLevel>;
    inputVersion?: number;
    currentInputVersion?: number;
  },
) {
  const commands = opts?.commands ?? COMMANDS;
  const availability = new Map<string, "available" | "unknown">();
  const risk = new Map<string, RiskLevel>();
  for (const command of commands) {
    availability.set(
      command,
      opts?.unavailable?.includes(command) ? "unknown" : "available",
    );
    risk.set(command, opts?.risk?.[command] ?? "L0");
  }
  const version = opts?.inputVersion ?? 1;
  const request = makeRequest(text, version);
  return {
    request,
    current: scope,
    currentInputVersion: opts?.currentInputVersion ?? version,
    now: 1,
    vocabulary: { commands },
    availability,
    risk,
  };
}

describe("boundedEditDistance（含相邻换位，超界提前返回）", () => {
  it("常见单编辑/二次编辑与换位", () => {
    expect(boundedEditDistance("grpe", "grep", 2)).toBe(1);
    expect(boundedEditDistance("llsss", "less", 2)).toBe(2);
    expect(boundedEditDistance("ls", "sl", 2)).toBe(1);
    expect(boundedEditDistance("llll", "ls", 2)).toBe(3);
    expect(boundedEditDistance("same", "same", 2)).toBe(0);
  });
});

describe("suggestBufferCorrectionMore 次级入口", () => {
  it("5 字符多打错误可用二次编辑召回，且参数原样保留", () => {
    const view = suggestBufferCorrectionMore(makeInput("llsss"));
    expect(view.status).toBe("ok");
    expect(view.candidates.map((c) => c.insertText)).toContain("less");

    const withArgs = suggestBufferCorrectionMore(makeInput("llsss -n x"));
    expect(withArgs.candidates.map((c) => c.insertText)).toContain("less -n x");
  });

  it("短名（2–4 字符）不走二次编辑：交给自动层单编辑", () => {
    const view = suggestBufferCorrectionMore(makeInput("grpe"));
    expect(view.status).toBe("empty");
    expect(view.candidates).toEqual([]);
    // 自动层仍能给出 grep（旧行为不变）。
    const single = suggestBufferCorrection(makeInput("grpe -n error app.log"));
    expect(single.candidates[0]?.insertText).toBe("grep -n error app.log");
  });

  it("距离/比例超界不召回（lssss↛ls，距离 3）", () => {
    const view = suggestBufferCorrectionMore(makeInput("lssss"));
    const inserted = view.candidates.map((c) => c.insertText);
    expect(inserted).not.toContain("ls");
  });

  it("长命令二次编辑召回（systemctll → systemctl）", () => {
    const view = suggestBufferCorrectionMore(makeInput("systemctll"));
    expect(view.candidates.map((c) => c.insertText)).toContain("systemctl");
  });

  it("最多 3 条候选", () => {
    const view = suggestBufferCorrectionMore(
      makeInput("lssss", { commands: [...COMMANDS, "lsssa", "lsssb", "lsssc"] }),
    );
    expect(view.candidates.length).toBeLessThanOrEqual(3);
  });

  it("候选必须可用且风险 L0–L2；不可用/高风险全部隐藏", () => {
    const hidden = suggestBufferCorrectionMore(
      makeInput("llsss", { unavailable: ["less"] }),
    );
    expect(hidden.candidates.map((c) => c.insertText)).not.toContain("less");

    const risky = suggestBufferCorrectionMore(
      makeInput("llsss", { risk: { less: "L3" } }),
    );
    expect(risky.candidates.map((c) => c.insertText)).not.toContain("less");
  });

  it("复杂语法（管道/引号）不参与到二次编辑", () => {
    expect(suggestBufferCorrectionMore(makeInput("llsss | cat")).status).toBe(
      "unavailable",
    );
    expect(suggestBufferCorrectionMore(makeInput("'llsss'")).status).toBe(
      "unavailable",
    );
  });

  it("输入版本变化 → stale，不返回候选", () => {
    const view = suggestBufferCorrectionMore(
      makeInput("llsss", { inputVersion: 1, currentInputVersion: 2 }),
    );
    expect(view.status).toBe("stale");
    expect(view.candidates).toEqual([]);
  });

  it("合法命令不作为候选（llsss 无自身替换）", () => {
    const view = suggestBufferCorrectionMore(
      makeInput("less", { commands: ["less", "ls"] }),
    );
    expect(view.candidates.map((c) => c.insertText)).not.toContain("less");
  });
});
