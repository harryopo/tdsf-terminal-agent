import { beforeEach, describe, expect, it } from "vitest";
import { digestKey } from "./privacy";
import {
  acceptPredictionCandidate,
  correctionTargetIsCurrent,
  dropLeafPrediction,
  predictionScopeForLeaf,
  recordTerminalBlock,
  rotateLeafPrediction,
  suggestCorrectionForLeaf,
  suggestNextForLeaf,
  type ObservedBlock,
} from "./sessionBridge";

let clock = 1000;

function feed(leafId: number, command: string, overrides: Partial<ObservedBlock> = {}) {
  clock += 100;
  recordTerminalBlock({
    sessionId: leafId,
    command,
    cwd: "",
    exitCode: 0,
    durationMs: 10,
    author: "user",
    startedAt: clock,
    ...overrides,
  });
}

function tables(namespaceId: string, commands: string[]) {
  return {
    availability: new Map(
      commands.map((command) => [digestKey(namespaceId, command), "available" as const]),
    ),
    risk: new Map(
      commands.map((command) => [digestKey(namespaceId, command), "L0" as const]),
    ),
  };
}

describe("终端 block → 会话内预测桥", () => {
  beforeEach(() => {
    clock = 1000;
  });

  it("用户完整事件进入统计，Markov 候选可被接受", () => {
    const leaf = 901;
    for (const command of ["pwd", "ls", "pwd", "ls", "pwd", "ls"]) {
      feed(leaf, command);
    }
    const scope = predictionScopeForLeaf(leaf);
    const view = suggestNextForLeaf({
      leafId: leaf,
      inputVersion: 1,
      now: clock + 100,
      ...tables(scope.namespaceId, ["pwd", "ls"]),
    });
    expect(view.status).toBe("ok");
    expect(view.candidates[0].displayText).toBe("pwd");
    expect(view.candidates[0].evidence.some((item) => item.source === "markov")).toBe(
      true,
    );
    expect(acceptPredictionCandidate(view.candidates[0], leaf, 1)).toEqual({
      ok: true,
      insertText: "pwd",
    });
  });

  it("agent block 不进入统计也不造转移，下一条另开 epoch", () => {
    const leaf = 902;
    feed(leaf, "pwd");
    feed(leaf, "ls", { author: "agent" });
    const scope = predictionScopeForLeaf(leaf);
    const view = suggestNextForLeaf({
      leafId: leaf,
      inputVersion: 1,
      now: clock + 100,
      ...tables(scope.namespaceId, ["pwd", "ls"]),
    });
    expect(view.status).toBe("ok");
    const commands = view.candidates.map((item) => item.displayText);
    expect(commands).toContain("pwd");
    expect(commands).not.toContain("ls");
    expect(view.candidates.some((item) =>
      item.evidence.some((evidence) => evidence.source === "markov"),
    )).toBe(false);
  });

  it("退出码未知与隐私拒收的 block 不进入统计", () => {
    const unknownExit = 903;
    feed(unknownExit, "pwd");
    feed(unknownExit, "ls", { exitCode: null });
    const scopeA = predictionScopeForLeaf(unknownExit);
    const viewA = suggestNextForLeaf({
      leafId: unknownExit,
      inputVersion: 1,
      now: clock + 100,
      ...tables(scopeA.namespaceId, ["pwd", "ls"]),
    });
    expect(viewA.candidates.map((item) => item.displayText)).toEqual(["pwd"]);

    const sensitive = 904;
    feed(sensitive, "cat ~/.ssh/id_rsa");
    const scopeB = predictionScopeForLeaf(sensitive);
    const viewB = suggestNextForLeaf({
      leafId: sensitive,
      inputVersion: 1,
      now: clock + 100,
      ...tables(scopeB.namespaceId, ["cat ~/.ssh/id_rsa"]),
    });
    expect(viewB.status).toBe("empty");
  });

  it("rotate 后旧候选 owner-changed，新请求仍可用新 scope 召回", () => {
    const leaf = 905;
    for (const command of ["pwd", "ls", "pwd", "ls", "pwd", "ls"]) {
      feed(leaf, command);
    }
    const scope = predictionScopeForLeaf(leaf);
    const view = suggestNextForLeaf({
      leafId: leaf,
      inputVersion: 1,
      now: clock + 100,
      ...tables(scope.namespaceId, ["pwd", "ls"]),
    });
    const candidate = view.candidates[0];
    expect(acceptPredictionCandidate(candidate, leaf, 1).ok).toBe(true);

    rotateLeafPrediction(leaf);
    expect(acceptPredictionCandidate(candidate, leaf, 1)).toEqual({
      ok: false,
      reason: "owner-changed",
    });

    const nextView = suggestNextForLeaf({
      leafId: leaf,
      inputVersion: 1,
      now: clock + 200,
      ...tables(scope.namespaceId, ["pwd", "ls"]),
    });
    expect(nextView.status).toBe("ok");
    expect(nextView.owner.shellEpoch).not.toBe(candidate.owner.shellEpoch);
  });

  it("drop 后 leaf 复用不会继承旧统计", () => {
    const leaf = 906;
    feed(leaf, "pwd");
    const oldNamespace = predictionScopeForLeaf(leaf).namespaceId;
    dropLeafPrediction(leaf);
    const newNamespace = predictionScopeForLeaf(leaf).namespaceId;
    expect(newNamespace).not.toBe(oldNamespace);
    const view = suggestNextForLeaf({
      leafId: leaf,
      inputVersion: 1,
      now: clock + 100,
      ...tables(newNamespace, ["pwd"]),
    });
    expect(view.status).toBe("empty");
  });

  it("纠错桥返回可复核的 request，原文变化后拒绝", () => {
    const leaf = 907;
    feed(leaf, "systemctl status httpd");
    const text = "sytemctl status httpd";
    const result = suggestCorrectionForLeaf({
      leafId: leaf,
      inputVersion: 2,
      now: clock + 100,
      text,
      cursor: text.length,
      vocabulary: {
        commands: ["systemctl", "journalctl", "ls", "pwd"],
        subcommands: { systemctl: ["status", "start"] },
      },
      availability: new Map([["systemctl", "available"]]),
      risk: new Map([["systemctl", "L0"]]),
    });
    expect(result.view.status).toBe("ok");
    expect(result.view.candidates[0].insertText).toBe("systemctl status httpd");
    expect(
      correctionTargetIsCurrent(result.request, leaf, 2, text, text.length),
    ).toBe(true);
    expect(
      correctionTargetIsCurrent(result.request, leaf, 2, `${text} `, text.length + 1),
    ).toBe(false);
  });
});
