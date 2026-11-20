/**
 * CORR-03 P2（ROOT v1.2 §P2.6）：10k 固定合成词表下的次级召回声门槛。
 * 这是工程耗时记录，不是自然用户准确率，也不作易抖 CI 硬断言（仅防爆炸上限）。
 * 产品路径的 availability/risk Map 是缓存的；此处预构建一次，不把建表计入。
 */
import { describe, expect, it } from "vitest";

import type {
  PredictionRequest,
  RiskLevel,
  ScopeToken,
} from "./contracts";
import { suggestBufferCorrectionMore } from "./correction";

const scope: ScopeToken = {
  namespaceId: "leaf:1:1",
  leafId: 1,
  rustSessionId: null,
  shellEpoch: "leaf:1:1:epoch-1",
  contextRevision: 0,
};

const BASE = [
  "ls",
  "less",
  "grep",
  "systemctl",
  "docker",
  "kubectl",
  "journalctl",
  "tar",
  "find",
  "awk",
  "sed",
  "curl",
  "wget",
  "ip",
  "ss",
];

function buildVocabulary(size: number): string[] {
  const commands = [...BASE];
  let i = 0;
  while (commands.length < size) {
    commands.push(`cmd${i.toString(36)}x${i % 97}`);
    i += 1;
  }
  return commands;
}

function request(text: string): PredictionRequest {
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
    inputVersion: 1,
    snapshotVersion: 0,
    cwdKey: null,
    limit: 5,
    terminalState: "idle-with-input",
    buffer: { text, cursor: text.length },
    block: null,
  };
}

function percentiles(times: number[]): { p50: number; p95: number } {
  const sorted = [...times].sort((a, b) => a - b);
  const at = (q: number) =>
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  return { p50: at(0.5), p95: at(0.95) };
}

describe("CORR-03 P2 门槛评测（10k 合成词表）", () => {
  it("记录 p50/p95 与召回条数（工程目标 P95 ≤ 30ms）", () => {
    const commands = buildVocabulary(10000);
    const availability = new Map<string, "available">();
    const risk = new Map<string, RiskLevel>();
    for (const command of commands) {
      availability.set(command, "available");
      risk.set(command, "L0");
    }
    const typos = [
      "systemctll",
      "systemctl1",
      "dockerr",
      "kubectll",
      "journalct1",
      "grpe",
      "gress",
      "lesss",
      "llsss",
      "lssss",
      "currl",
      "wgeet",
      "tarr",
      "finnd",
      "sedd",
    ];
    const times: number[] = [];
    let recalled = 0;
    let total = 0;
    for (let round = 0; round < 7; round += 1) {
      for (const typo of typos) {
        const input = {
          request: request(typo),
          current: scope,
          currentInputVersion: 1,
          now: 1,
          vocabulary: { commands },
          availability,
          risk,
        };
        const started = performance.now();
        const view = suggestBufferCorrectionMore(input);
        times.push(performance.now() - started);
        total += 1;
        if (view.candidates.length > 0) recalled += 1;
      }
    }
    const { p50, p95 } = percentiles(times);
    // eslint-disable-next-line no-console
    console.log(
      `[P2 bench] commands=${commands.length} requests=${total} recalled=${recalled} p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms`,
    );
    expect(p95).toBeLessThan(200);
    expect(recalled).toBeGreaterThan(0);
  });
});
