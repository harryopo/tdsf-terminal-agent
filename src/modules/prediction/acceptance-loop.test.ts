/**
 * 工作包 C 的首个可检查闭环（会话内、合成命令）：
 * 已完成事件 → 同环境统计候选 → 中文依据/来源 → 明确选择 → 只填入当前可见空行；
 * 切上下文后旧结果不可接受；buffer 纠错只改一行里的一个 token、不补 sudo、不改参数值、
 * 不执行。这里用真实 ObservationTracker + SessionPredictionStore + 纠错与接受守卫，
 * 不接 UI/RPC/存储。
 */
import { describe, expect, it, vi } from "vitest";
import {
  MAX_CANDIDATES,
  checkCandidateAcceptable,
  validateCandidateView,
  type PredictionRequest,
  type ScopeToken,
} from "./contracts";
import { ObservationTracker } from "./context";
import {
  isCorrectionTargetCurrent,
  suggestBufferCorrection,
  type CorrectionVocabulary,
} from "./correction";
import { digestKey } from "./privacy";
import { SessionPredictionStore } from "./sessionStore";

const SCOPE: ScopeToken = {
  namespaceId: "ns-acceptance",
  leafId: 31,
  rustSessionId: null,
  shellEpoch: "epoch-acceptance-01",
  contextRevision: 0,
};

const ENVIRONMENT = {
  connectionKind: "local" as const,
  osFamily: "linux" as const,
  dialect: "bash" as const,
  targetKey: "target-a",
  userKey: "user-a",
  identityState: "verified" as const,
};

function predictRequest(overrides: Partial<PredictionRequest> = {}): PredictionRequest {
  return {
    requestId: "req-acceptance-1",
    task: "predict_next",
    scope: SCOPE,
    environment: ENVIRONMENT,
    inputVersion: 3,
    snapshotVersion: 0,
    cwdKey: null,
    limit: MAX_CANDIDATES,
    terminalState: "idle-empty",
    buffer: null,
    block: null,
    ...overrides,
  };
}

function correctRequest(
  text: string,
  overrides: Partial<PredictionRequest> = {},
): PredictionRequest {
  return {
    requestId: "req-acceptance-corr",
    task: "correct_buffer",
    scope: SCOPE,
    environment: ENVIRONMENT,
    inputVersion: 5,
    snapshotVersion: 0,
    cwdKey: null,
    limit: MAX_CANDIDATES,
    terminalState: "idle-with-input",
    buffer: { text, cursor: text.length },
    block: null,
    ...overrides,
  };
}

function runCommand(
  tracker: ObservationTracker,
  command: string,
  at: number,
) {
  const begin = tracker.begin("user", at);
  if (!begin.ok) throw new Error(`begin rejected: ${begin.reason}`);
  const result = tracker.complete(begin.handle, {
    sourceBlockId: null,
    endedAt: at + 10,
    exitCode: 0,
    commandRaw: command,
    cwdKey: null,
    learningGeneration: 1,
  });
  if (!result.ok) throw new Error(`complete rejected: ${result.reason}`);
  return result.event;
}

function seed(store: SessionPredictionStore, tracker: ObservationTracker) {
  let sequence = 0;
  for (const command of ["pwd", "ls", "pwd", "ls", "pwd", "ls"]) {
    sequence += 1;
    store.record(runCommand(tracker, command, sequence * 1000));
  }
}

function availabilityOf(...commands: string[]) {
  return new Map(
    commands.map((command) => [
      digestKey(SCOPE.namespaceId, command),
      "available" as const,
    ]),
  );
}

function riskOf(...commands: string[]) {
  return new Map(
    commands.map((command) => [digestKey(SCOPE.namespaceId, command), "L0" as const]),
  );
}

describe("首个可检查闭环（会话内）", () => {
  it("完成事件 → 候选 → 中文依据 → 只填入可见空行；切上下文后失效", () => {
    let observationSeq = 0;
    const tracker = new ObservationTracker(
      SCOPE,
      () => `obs-${(observationSeq += 1)}`,
    );
    const store = new SessionPredictionStore();
    seed(store, tracker);

    const view = store.suggest({
      request: predictRequest(),
      current: SCOPE,
      currentInputVersion: 3,
      now: 7000,
      availability: availabilityOf("pwd", "ls"),
      risk: riskOf("pwd", "ls"),
    });
    expect(validateCandidateView(view)).toEqual([]);
    expect(view.status).toBe("ok");
    const top = view.candidates[0];
    expect(top.displayText).toBe("pwd");
    expect(top.summaryZh).not.toBe("");
    expect(top.evidence.length).toBeGreaterThan(0);
    expect(top.evidence.some((item) => item.source === "markov")).toBe(true);

    // 明确选择 → 只把 insertText 交给“当前可见空行”，不追加换行、不执行。
    const decision = checkCandidateAcceptable(top, SCOPE, 3);
    expect(decision).toEqual({ ok: true, insertText: "pwd" });
    if (!decision.ok) return;
    let currentLine = "";
    const execute = vi.fn();
    currentLine += decision.insertText;
    expect(currentLine).toBe("pwd");
    expect(currentLine).not.toMatch(/[\r\n]/);
    expect(execute).not.toHaveBeenCalled();

    // 切 tab/目录/重连会推进 contextRevision；旧候选整批失效。
    const switched = { ...SCOPE, contextRevision: 1 };
    const stale = store.suggest({
      request: predictRequest(),
      current: switched,
      currentInputVersion: 3,
      now: 7000,
      availability: availabilityOf("pwd", "ls"),
      risk: riskOf("pwd", "ls"),
    });
    expect(stale.status).toBe("stale");
    expect(checkCandidateAcceptable(top, switched, 3)).toEqual({
      ok: false,
      reason: "owner-changed",
    });
  });

  it("buffer 纠错只改一个 token，不补 sudo、不改参数值、不执行", () => {
    const vocabulary: CorrectionVocabulary = {
      commands: ["systemctl", "journalctl", "grep", "ls", "pwd"],
      subcommands: { systemctl: ["status", "start", "stop"] },
    };
    const original = "sytemctl status httpd";
    const request = correctRequest(original);
    const view = suggestBufferCorrection({
      request,
      current: SCOPE,
      currentInputVersion: 5,
      now: 7000,
      vocabulary,
      availability: new Map([["systemctl", "available"]]),
      risk: new Map([["systemctl", "L0"]]),
    });
    expect(validateCandidateView(view)).toEqual([]);
    expect(view.status).toBe("ok");
    const candidate = view.candidates[0];
    expect(candidate.insertText).toBe("systemctl status httpd");

    // 接受前复核：原文本、光标、owner、输入版本完全相同。
    expect(
      isCorrectionTargetCurrent(request, SCOPE, 5, original, original.length),
    ).toBe(true);
    const decision = checkCandidateAcceptable(candidate, SCOPE, 5);
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;

    const before = original.split(" ");
    const after = decision.insertText.split(" ");
    expect(after.filter((token, index) => token !== before[index])).toHaveLength(1);
    expect(after.slice(1)).toEqual(before.slice(1));
    expect(decision.insertText).not.toMatch(/\bsudo\b/);
    expect(decision.insertText).not.toMatch(/[\r\n]/);

    const execute = vi.fn();
    expect(execute).not.toHaveBeenCalled();

    // 用户改了半行 → 原纠错候选不可接受。
    const edited = `${original} `;
    expect(
      isCorrectionTargetCurrent(request, SCOPE, 5, edited, edited.length),
    ).toBe(false);
  });
});
