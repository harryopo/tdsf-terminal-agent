import { describe, expect, it } from "vitest";
import fixture from "../../../tests/fixtures/prediction/v1/synthetic-events.json";
import {
  MAX_CANDIDATES,
  PREDICTION_SCHEMA_VERSION,
  RANKER_VERSION,
  canWriteWithGeneration,
  checkCandidateAcceptable,
  isPredictNextAllowed,
  isSameOwner,
  validateCandidate,
  validateCandidateView,
  validateCommandEvent,
  validateFeedback,
  validatePredictionRequest,
  validateScopeToken,
  validateSnapshot,
  type Candidate,
  type CommandEvent,
  type PredictionRequest,
  type ScopeToken,
} from "./contracts";

const SCOPE: ScopeToken = {
  namespaceId: "ns-syn-bash-01",
  leafId: 101,
  rustSessionId: null,
  shellEpoch: "epoch-01",
  contextRevision: 3,
};

function makeEvent(overrides: Partial<CommandEvent> = {}): CommandEvent {
  return {
    schemaVersion: PREDICTION_SCHEMA_VERSION,
    eventId: "epoch-01:obs-01",
    observationId: "obs-01",
    sourceBlockId: "blk-01",
    namespaceId: SCOPE.namespaceId,
    shellEpoch: SCOPE.shellEpoch,
    sequence: 1,
    learningGeneration: 2,
    startedAt: 1000,
    durationMs: 120,
    exitCode: 0,
    origin: "user",
    commandKey: "0123456789abcdef",
    template: "pwd",
    replayText: "pwd",
    cwdKey: null,
    eligibility: "eligible",
    ...overrides,
  };
}

function makeCandidate(overrides: Partial<Candidate> = {}): Candidate {
  return {
    candidateId: "cand-1",
    task: "predict_next",
    displayText: "systemctl status httpd",
    insertText: "systemctl status httpd",
    source: "markov",
    summaryZh: "在 systemctl 之后常用",
    evidence: [{ source: "markov", count: 3 }],
    rankScore: 0.8,
    rankerVersion: RANKER_VERSION,
    risk: "L0",
    availability: "available",
    constraints: [],
    ambiguities: [],
    owner: SCOPE,
    inputVersion: 7,
    ...overrides,
  };
}

function makeRequest(overrides: Partial<PredictionRequest> = {}): PredictionRequest {
  return {
    requestId: "req-1",
    task: "predict_next",
    scope: SCOPE,
    environment: {
      connectionKind: "local",
      osFamily: "linux",
      dialect: "bash",
      targetKey: "target-a",
      userKey: "user-a",
      identityState: "verified",
    },
    inputVersion: 7,
    snapshotVersion: 12,
    cwdKey: null,
    limit: MAX_CANDIDATES,
    terminalState: "idle-empty",
    buffer: null,
    block: null,
    ...overrides,
  };
}

describe("F0 契约 v1", () => {
  it("合成夹具是 v1 且不含真实主机/用户", () => {
    expect(fixture.schemaVersion).toBe(1);
    const data = fixture as unknown as {
      streams: { observations: { command: string }[] }[];
    };
    expect(data.streams.length).toBeGreaterThan(0);
    const commands = data.streams.flatMap((stream) =>
      stream.observations.map((item) => item.command),
    );
    expect(commands).toContain("pwd");
    expect(commands.join(" ")).not.toMatch(/@[a-z0-9.-]+\.[a-z]{2,}/i);
  });

  it("ScopeToken 完整时可校验，缺字段会报出路径", () => {
    expect(validateScopeToken(SCOPE)).toEqual([]);
    const invalid = validateScopeToken({ ...SCOPE, leafId: -1 });
    expect(invalid).toContain("scope.leafId");
  });

  it("CommandEvent：合格事件通过，eligible 缺 replayText/exitCode 被拒", () => {
    expect(validateCommandEvent(makeEvent())).toEqual([]);
    expect(
      validateCommandEvent(makeEvent({ replayText: null })),
    ).toContain("event.eligibility: eligible requires user + replayText + exitCode");
    expect(
      validateCommandEvent(makeEvent({ exitCode: null })),
    ).toContain("event.eligibility: eligible requires user + replayText + exitCode");
    expect(validateCommandEvent(makeEvent({ origin: "agent" }))).toContain(
      "event.eligibility: eligible requires user + replayText + exitCode",
    );
  });

  it("PredictionRequest：任务与 buffer/block 互斥、limit 1..5", () => {
    expect(validatePredictionRequest(makeRequest())).toEqual([]);
    expect(
      validatePredictionRequest(
        makeRequest({ terminalState: "busy" }),
      ),
    ).toEqual([]);
    expect(
      validatePredictionRequest(
        makeRequest({ buffer: { text: "ls", cursor: 2 } }),
      ),
    ).toContain("request.task: predict_next forbids buffer/block");
    expect(
      validatePredictionRequest(makeRequest({ limit: MAX_CANDIDATES + 1 })),
    ).toContain("request.limit");
    expect(
      validatePredictionRequest(makeRequest({ task: "correct_buffer" })),
    ).toContain("request.task: correct_buffer requires buffer");
    expect(
      validatePredictionRequest(
        makeRequest({
          task: "correct_buffer",
          buffer: { text: "ls", cursor: 3 },
        }),
      ),
    ).toContain("request.buffer.cursor");
  });

  it("predict_next 只允许空闲且无未提交输入", () => {
    expect(isPredictNextAllowed(makeRequest())).toBe(true);
    expect(
      isPredictNextAllowed(makeRequest({ terminalState: "idle-with-input" })),
    ).toBe(false);
    expect(
      isPredictNextAllowed(makeRequest({ terminalState: "busy" })),
    ).toBe(false);
    expect(
      isPredictNextAllowed(
        makeRequest({ task: "correct_buffer", buffer: { text: "ls", cursor: 2 } }),
      ),
    ).toBe(false);
  });

  it("isSameOwner 逐字段比较，epoch/revision 变化即失效", () => {
    expect(isSameOwner(SCOPE, { ...SCOPE })).toBe(true);
    expect(isSameOwner(SCOPE, { ...SCOPE, contextRevision: 4 })).toBe(false);
    expect(isSameOwner(SCOPE, { ...SCOPE, shellEpoch: "epoch-02" })).toBe(false);
    expect(isSameOwner(SCOPE, { ...SCOPE, leafId: 102 })).toBe(false);
  });

  it("接受守卫：owner/输入版本/多行/占位符/风险/unknown 全部拒绝", () => {
    expect(checkCandidateAcceptable(makeCandidate(), SCOPE, 7)).toEqual({
      ok: true,
      insertText: "systemctl status httpd",
    });
    expect(
      checkCandidateAcceptable(makeCandidate(), SCOPE, 8),
    ).toEqual({ ok: false, reason: "input-version-changed" });
    expect(
      checkCandidateAcceptable(makeCandidate(), { ...SCOPE, contextRevision: 9 }, 7),
    ).toEqual({ ok: false, reason: "owner-changed" });
    expect(
      checkCandidateAcceptable(makeCandidate({ insertText: "ls\nrm -rf /" }), SCOPE, 7),
    ).toEqual({ ok: false, reason: "multi-line" });
    expect(
      checkCandidateAcceptable(makeCandidate({ insertText: "ls <PATH>" }), SCOPE, 7),
    ).toEqual({ ok: false, reason: "template-placeholder" });
    expect(
      checkCandidateAcceptable(makeCandidate({ insertText: null }), SCOPE, 7),
    ).toEqual({ ok: false, reason: "insert-text-missing" });
    expect(
      checkCandidateAcceptable(makeCandidate({ risk: "L2" }), SCOPE, 7),
    ).toEqual({ ok: false, reason: "risk-not-low" });
    expect(
      checkCandidateAcceptable(makeCandidate({ availability: "unknown" }), SCOPE, 7),
    ).toEqual({ ok: false, reason: "unknown-state" });
    expect(
      checkCandidateAcceptable(makeCandidate({ availability: "unavailable" }), SCOPE, 7),
    ).toEqual({ ok: false, reason: "availability-unavailable" });
    expect(
      checkCandidateAcceptable(makeCandidate({ insertText: "   " }), SCOPE, 7),
    ).toEqual({ ok: false, reason: "empty-text" });
  });

  it("Candidate 多行 insertText 在合同校验层就被拒绝", () => {
    expect(validateCandidate(makeCandidate())).toEqual([]);
    expect(
      validateCandidate(makeCandidate({ insertText: "pwd\nls" })),
    ).toContain("candidate.insertText: multi-line");
    expect(
      validateCandidate(makeCandidate({ rankerVersion: "rank-v0" })),
    ).toContain("candidate.rankerVersion");
  });

  it("CandidateView：ok 必须有候选，非 ok 必须为空", () => {
    const view = {
      requestId: "req-1",
      status: "ok",
      task: "predict_next",
      candidates: [makeCandidate()],
      owner: SCOPE,
      snapshotVersion: 12,
      generatedAt: 1000,
    };
    expect(validateCandidateView(view)).toEqual([]);
    expect(
      validateCandidateView({ ...view, status: "empty" }),
    ).toContain("view.status: non-ok forbids candidates");
    expect(
      validateCandidateView({ ...view, candidates: [] }),
    ).toContain("view.status: ok requires candidates");
    expect(
      validateCandidateView({ ...view, status: "stale" }),
    ).toContain("view.status: non-ok forbids candidates");
  });

  it("Feedback 与 Snapshot 的基本边界", () => {
    expect(
      validateFeedback({
        requestId: "req-1",
        displayed: ["pwd"],
        candidateId: "cand-1",
        action: "accepted",
        at: 1000,
        learningGeneration: 2,
      }),
    ).toEqual([]);
    expect(
      validateFeedback({
        requestId: "req-1",
        displayed: ["pwd"],
        candidateId: "cand-1",
        action: "clicked",
        at: 1000,
        learningGeneration: 2,
      }),
    ).toContain("feedback.action");
    expect(
      validateSnapshot({
        namespaceId: SCOPE.namespaceId,
        learningGeneration: 2,
        commitRevision: 1,
        commands: [],
        transitions: [],
        bounded: false,
      }),
    ).toEqual([]);
  });

  it("学习代际：关闭或用旧代际写入一律拒绝", () => {
    expect(canWriteWithGeneration({ enabled: true, generation: 3 }, 3)).toBe(true);
    expect(canWriteWithGeneration({ enabled: false, generation: 3 }, 3)).toBe(false);
    expect(canWriteWithGeneration({ enabled: true, generation: 3 }, 2)).toBe(false);
  });
});
