import { describe, expect, it } from "vitest";
import fixture from "../../../tests/fixtures/prediction/v1/synthetic-events.json";
import {
  ObservationTracker,
  advanceLearningGeneration,
  canChainTransitions,
  type CompletionResult,
  type ObservationHandle,
} from "./context";
import type { CommandEvent, ScopeToken } from "./contracts";

type FixtureObservation = {
  observationId: string;
  origin: "user" | "agent" | "probe" | "unknown";
  startedAt: number;
  endedAt: number;
  command: string;
  exitCode: number | null;
  cwd: string | null;
  sourceBlockId: string | null;
};

type FixtureStream = {
  namespaceId: string;
  leafId: number;
  rustSessionId: number | null;
  shellEpoch: string;
  observations: FixtureObservation[];
};

const DATA = fixture as unknown as { streams: FixtureStream[] };

function scopeOf(stream: FixtureStream): ScopeToken {
  return {
    namespaceId: stream.namespaceId,
    leafId: stream.leafId,
    rustSessionId: stream.rustSessionId,
    shellEpoch: stream.shellEpoch,
    contextRevision: 0,
  };
}

function makeTracker(scope: ScopeToken) {
  let counter = 0;
  return new ObservationTracker(scope, () => {
    counter += 1;
    return `obs-${counter}`;
  });
}

function beginOk(tracker: ObservationTracker, at: number): ObservationHandle {
  const result = tracker.begin("user", at);
  if (!result.ok) throw new Error(`unexpected begin rejection: ${result.reason}`);
  return result.handle;
}

function completeOk(
  tracker: ObservationTracker,
  handle: ObservationHandle,
  observation: FixtureObservation,
): CommandEvent {
  const result = tracker.complete(handle, {
    sourceBlockId: observation.sourceBlockId,
    endedAt: observation.endedAt,
    exitCode: observation.exitCode,
    commandRaw: observation.command,
    cwdKey: observation.cwd ? `cwd-${observation.cwd}` : null,
    learningGeneration: 1,
  });
  if (!result.ok) throw new Error(`unexpected complete rejection: ${result.reason}`);
  return result.event;
}

describe("F0 生命周期观察句柄", () => {
  it("完整流：sequence 单调、eventId 稳定、非零退出不惩罚", () => {
    const stream = DATA.streams[0];
    const tracker = makeTracker(scopeOf(stream));
    const events = stream.observations.map((observation) =>
      completeOk(tracker, beginOk(tracker, observation.startedAt), observation),
    );

    expect(events.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(events[0].eventId).toBe(`${stream.shellEpoch}:${events[0].observationId}`);
    expect(events[4].exitCode).toBe(1);
    expect(events[4].eligibility).toBe("eligible");
    expect(events[4].replayText).toBe("grep -i error syslog");
    for (let index = 1; index < events.length; index += 1) {
      expect(canChainTransitions(events[index - 1], events[index])).toBe(true);
    }
    expect(tracker.debugState().pending).toBeNull();
  });

  it("跨 epoch 的相邻 sequence 不构成转移", () => {
    const [first, second] = DATA.streams;
    const trackerA = makeTracker(scopeOf(first));
    const trackerB = makeTracker(scopeOf(second));
    const eventsA = first.observations.map((observation) =>
      completeOk(trackerA, beginOk(trackerA, observation.startedAt), observation),
    );
    const eventsB = second.observations.map((observation) =>
      completeOk(trackerB, beginOk(trackerB, observation.startedAt), observation),
    );
    expect(canChainTransitions(eventsA[0], eventsB[0])).toBe(false);
    expect(canChainTransitions(eventsA[eventsA.length - 1], eventsB[0])).toBe(false);
  });

  it("缺开始：没有 begin 的 complete 被拒", () => {
    const stream = DATA.streams[0];
    const tracker = makeTracker(scopeOf(stream));
    const fakeHandle: ObservationHandle = {
      observationId: "obs-missing-start",
      owner: scopeOf(stream),
      origin: "user",
      startedAt: 0,
      sequence: 99,
    };
    const result = tracker.complete(fakeHandle, {
      sourceBlockId: null,
      endedAt: 10,
      exitCode: 0,
      commandRaw: "pwd",
      cwdKey: null,
      learningGeneration: 1,
    });
    expect(result).toEqual({ ok: false, reason: "missing-start" });
  });

  it("重复结束：同一 observation 第二次 complete 被拒", () => {
    const stream = DATA.streams[0];
    const observation = stream.observations[0];
    const tracker = makeTracker(scopeOf(stream));
    const handle = beginOk(tracker, observation.startedAt);
    completeOk(tracker, handle, observation);
    const result: CompletionResult = tracker.complete(handle, {
      sourceBlockId: observation.sourceBlockId,
      endedAt: observation.endedAt,
      exitCode: 0,
      commandRaw: observation.command,
      cwdKey: null,
      learningGeneration: 1,
    });
    expect(result).toEqual({ ok: false, reason: "duplicate-end" });
  });

  it("交叠：上一条未结束时再次 begin 被拒并断链", () => {
    const stream = DATA.streams[0];
    const tracker = makeTracker(scopeOf(stream));
    beginOk(tracker, 100);
    expect(tracker.begin("user", 200)).toEqual({
      ok: false,
      reason: "overlapping",
    });
    const next = tracker.begin("user", 300);
    expect(next.ok).toBe(true);
    if (next.ok) expect(next.chainBroken).toBe(true);
  });

  it("owner 不符：切 tab/epoch 后旧 handle 被拒", () => {
    const [first, second] = DATA.streams;
    const tracker = makeTracker(scopeOf(first));
    const handle = beginOk(tracker, 100);
    tracker.updateOwner(scopeOf(second));
    const result = tracker.complete(handle, {
      sourceBlockId: "blk-x",
      endedAt: 200,
      exitCode: 0,
      commandRaw: "pwd",
      cwdKey: null,
      learningGeneration: 1,
    });
    expect(result).toEqual({ ok: false, reason: "owner-mismatch" });
  });

  it("时长倒退：endedAt 早于 startedAt 被拒", () => {
    const stream = DATA.streams[0];
    const tracker = makeTracker(scopeOf(stream));
    const handle = beginOk(tracker, 500);
    const result = tracker.complete(handle, {
      sourceBlockId: null,
      endedAt: 400,
      exitCode: 0,
      commandRaw: "pwd",
      cwdKey: null,
      learningGeneration: 1,
    });
    expect(result).toEqual({ ok: false, reason: "invalid-duration" });
  });

  it("隐私拒收：凭据路径与前导空格不进入事件，且断链", () => {
    const stream = DATA.streams[0];
    const tracker = makeTracker(scopeOf(stream));
    const sensitiveHandle = beginOk(tracker, 100);
    const sensitive = tracker.complete(sensitiveHandle, {
      sourceBlockId: null,
      endedAt: 200,
      exitCode: 0,
      commandRaw: "cat ~/.ssh/id_rsa",
      cwdKey: null,
      learningGeneration: 1,
    });
    expect(sensitive).toEqual({
      ok: false,
      reason: "privacy-rejected",
      privacyReason: "sensitive",
    });
    expect(tracker.debugState().chainBroken).toBe(true);

    const hiddenHandle = beginOk(tracker, 300);
    const hidden = tracker.complete(hiddenHandle, {
      sourceBlockId: null,
      endedAt: 400,
      exitCode: 0,
      commandRaw: " echo hidden",
      cwdKey: null,
      learningGeneration: 1,
    });
    expect(hidden).toEqual({
      ok: false,
      reason: "privacy-rejected",
      privacyReason: "leading-space",
    });
  });

  it("模板化命令可学习但不可重放（not replayable → ineligible）", () => {
    const stream = DATA.streams[0];
    const tracker = makeTracker(scopeOf(stream));
    const handle = beginOk(tracker, 100);
    const result = tracker.complete(handle, {
      sourceBlockId: null,
      endedAt: 200,
      exitCode: 0,
      commandRaw: "ls ~/project",
      cwdKey: null,
      learningGeneration: 1,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.replayText).toBeNull();
      expect(result.event.template).toBe("ls <HOME>");
      expect(result.event.eligibility).toBe("ineligible");
    }
  });

  it("Agent/补全探测不进入可学习事件", () => {
    const stream = DATA.streams[0];
    const tracker = makeTracker(scopeOf(stream));
    const result = tracker.begin("agent", 100);
    if (!result.ok) throw new Error("unexpected begin rejection");
    const completed = tracker.complete(result.handle, {
      sourceBlockId: null,
      endedAt: 200,
      exitCode: 0,
      commandRaw: "systemctl status httpd",
      cwdKey: null,
      learningGeneration: 1,
    });
    expect(completed.ok).toBe(true);
    if (completed.ok) {
      expect(completed.event.eligibility).toBe("ineligible");
      expect(canChainTransitions(completed.event, completed.event)).toBe(false);
    }
  });

  it("学习代际推进后旧代际不可写", () => {
    const next = advanceLearningGeneration(4, true);
    expect(next).toEqual({ enabled: true, generation: 5 });
    expect(advanceLearningGeneration(4, false)).toEqual({
      enabled: false,
      generation: 5,
    });
  });
});
