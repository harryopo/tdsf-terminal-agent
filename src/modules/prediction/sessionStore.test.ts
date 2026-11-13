import { describe, expect, it } from "vitest";
import { digestKey } from "./privacy";
import { SessionPredictionStore } from "./sessionStore";
import {
  PREDICTION_SCHEMA_VERSION,
  type CommandEvent,
  type PredictionRequest,
  type ScopeToken,
} from "./contracts";

const NS = "ns-session-test";
const EPOCH = "epoch-session-01";

const SCOPE: ScopeToken = {
  namespaceId: NS,
  leafId: 11,
  rustSessionId: null,
  shellEpoch: EPOCH,
  contextRevision: 0,
};

function event(
  sequence: number,
  command: string,
  startedAt: number,
  overrides: Partial<CommandEvent> = {},
): CommandEvent {
  return {
    schemaVersion: PREDICTION_SCHEMA_VERSION,
    eventId: `${EPOCH}:${sequence}`,
    observationId: `obs-${sequence}`,
    sourceBlockId: null,
    namespaceId: NS,
    shellEpoch: EPOCH,
    sequence,
    learningGeneration: 1,
    startedAt,
    durationMs: 10,
    exitCode: 0,
    origin: "user",
    commandKey: digestKey(NS, command),
    template: command,
    replayText: command,
    cwdKey: null,
    eligibility: "eligible",
    ...overrides,
  };
}

function request(overrides: Partial<PredictionRequest> = {}): PredictionRequest {
  return {
    requestId: "req-session-1",
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
    inputVersion: 3,
    snapshotVersion: 0,
    cwdKey: null,
    limit: 5,
    terminalState: "idle-empty",
    buffer: null,
    block: null,
    ...overrides,
  };
}

function availabilityOf(...commands: string[]) {
  return new Map(
    commands.map((command) => [digestKey(NS, command), "available" as const]),
  );
}

function riskOf(...commands: string[]) {
  return new Map(
    commands.map((command) => [digestKey(NS, command), "L0" as const]),
  );
}

function seedCycle(store: SessionPredictionStore): void {
  // pwd, ls, pwd, ls, pwd, ls —— ls→pwd 累计 2 次，满足 T 的“后继 ≥2”门槛。
  store.record(event(1, "pwd", 1000));
  store.record(event(2, "ls", 2000));
  store.record(event(3, "pwd", 3000));
  store.record(event(4, "ls", 4000));
  store.record(event(5, "pwd", 5000));
  store.record(event(6, "ls", 6000));
}

describe("会话内下一命令引擎", () => {
  it("Markov 候选在同环境、同 epoch、相邻 sequence 下排到第一", () => {
    const store = new SessionPredictionStore();
    seedCycle(store);
    const view = store.suggest({
      request: request(),
      current: SCOPE,
      currentInputVersion: 3,
      now: 6100,
      availability: availabilityOf("pwd", "ls"),
      risk: riskOf("pwd", "ls"),
    });
    expect(view.status).toBe("ok");
    expect(view.candidates[0].displayText).toBe("pwd");
    expect(
      view.candidates[0].evidence.some((item) => item.source === "markov"),
    ).toBe(true);
    expect(view.candidates[0].summaryZh).toContain("上一命令");
    expect(view.candidates[0].insertText).not.toMatch(/[\r\n]/);
    expect(view.candidates.map((item) => item.displayText)).toContain("ls");
  });

  it("空历史返回冷启动空态，不冒充个人预测", () => {
    const store = new SessionPredictionStore();
    const view = store.suggest({
      request: request(),
      current: SCOPE,
      currentInputVersion: 3,
      now: 1000,
      availability: availabilityOf("pwd"),
      risk: riskOf("pwd"),
    });
    expect(view.status).toBe("empty");
    expect(view.candidates).toEqual([]);
  });

  it("available/risk 未知时候选保守隐藏（unknown，不写成 ok）", () => {
    const store = new SessionPredictionStore();
    seedCycle(store);
    const noAvailability = store.suggest({
      request: request(),
      current: SCOPE,
      currentInputVersion: 3,
      now: 6100,
      availability: new Map(),
      risk: riskOf("pwd", "ls"),
    });
    expect(noAvailability.status).toBe("unknown");
    expect(noAvailability.candidates).toEqual([]);

    const noRisk = store.suggest({
      request: request(),
      current: SCOPE,
      currentInputVersion: 3,
      now: 6100,
      availability: availabilityOf("pwd", "ls"),
      risk: new Map(),
    });
    expect(noRisk.status).toBe("unknown");
    expect(noRisk.candidates).toEqual([]);
  });

  it("owner 或输入版本变化返回 stale，旧候选不可继续展示", () => {
    const store = new SessionPredictionStore();
    seedCycle(store);
    const staleOwner = store.suggest({
      request: request(),
      current: { ...SCOPE, contextRevision: 1 },
      currentInputVersion: 3,
      now: 6100,
      availability: availabilityOf("pwd", "ls"),
      risk: riskOf("pwd", "ls"),
    });
    expect(staleOwner.status).toBe("stale");
    expect(staleOwner.candidates).toEqual([]);

    const staleInput = store.suggest({
      request: request(),
      current: SCOPE,
      currentInputVersion: 4,
      now: 6100,
      availability: availabilityOf("pwd", "ls"),
      risk: riskOf("pwd", "ls"),
    });
    expect(staleInput.status).toBe("stale");
  });

  it("终端不空闲或非 predict_next 任务返回 unavailable", () => {
    const store = new SessionPredictionStore();
    seedCycle(store);
    const busy = store.suggest({
      request: request({ terminalState: "idle-with-input" }),
      current: SCOPE,
      currentInputVersion: 3,
      now: 6100,
      availability: availabilityOf("pwd", "ls"),
      risk: riskOf("pwd", "ls"),
    });
    expect(busy.status).toBe("unavailable");

    const wrongTask = store.suggest({
      request: request({ task: "correct_buffer" }),
      current: SCOPE,
      currentInputVersion: 3,
      now: 6100,
      availability: availabilityOf("pwd", "ls"),
      risk: riskOf("pwd", "ls"),
    });
    expect(wrongTask.status).toBe("unavailable");
  });

  it("Agent/补全事件不进入统计", () => {
    const store = new SessionPredictionStore();
    store.record(event(1, "systemctl status httpd", 1000, { origin: "agent", eligibility: "ineligible" }));
    const view = store.suggest({
      request: request(),
      current: SCOPE,
      currentInputVersion: 3,
      now: 2000,
      availability: availabilityOf("systemctl status httpd"),
      risk: riskOf("systemctl status httpd"),
    });
    expect(view.status).toBe("empty");
  });

  it("reportGap 后不再用旧前序造转移", () => {
    const store = new SessionPredictionStore();
    store.record(event(1, "pwd", 1000));
    store.record(event(2, "ls", 2000));
    const before = store.snapshot(NS);
    expect(before.transitions).toContainEqual({
      prevKey: digestKey(NS, "pwd"),
      nextKey: digestKey(NS, "ls"),
      count: 1,
    });

    store.reportGap(NS, EPOCH);
    store.record(event(3, "pwd", 3000));
    const after = store.snapshot(NS);
    expect(
      after.transitions.some(
        (item) =>
          item.prevKey === digestKey(NS, "ls") &&
          item.nextKey === digestKey(NS, "pwd"),
      ),
    ).toBe(false);
  });

  it("快照有界：超过 512 个命令后淘汰最久未用并标记 bounded", () => {
    const store = new SessionPredictionStore();
    for (let index = 0; index < 513; index += 1) {
      store.record(event(index + 1, `cmd-${index}`, 1000 + index));
    }
    const snapshot = store.snapshot(NS);
    expect(snapshot.commands.length).toBe(512);
    expect(snapshot.bounded).toBe(true);
    expect(snapshot.commands.map((item) => item.displayText)).not.toContain(
      "cmd-0",
    );
  });
});
