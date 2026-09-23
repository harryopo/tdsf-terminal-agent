import { describe, expect, it } from "vitest";

import {
  shouldRerouteForMissingIntegration,
  VISIBLE_INTEGRATION_GRACE_MS,
} from "./visibleIntegrationGrace";

/**
 * #113③：远端 shell 不吐 OSC 块时的兜底判据。
 *
 * 判错的代价不对称：
 * - 集成其实活着却判它死了 → 提前改道，只读命令可能跑两遍（可接受）、写命令由
 *   sidecar 的风险闸拦住（另有用例）；
 * - 集成死了却判它活着 → 白等到超时，用户看到的是"状态未知"。
 * 所以宽限期只在"注入之后仍没有任何执行标记"时才成立。
 */
const T0 = 1_700_000_000_000;

describe("shouldRerouteForMissingIntegration（#113③）", () => {
  it("还没注入 → 不判（打字前谈不上 shell 没反应）", () => {
    expect(
      shouldRerouteForMissingIntegration({
        now: T0 + 60_000,
        injectedAt: null,
        lastExecStartedAt: undefined,
      }),
    ).toBe(false);
  });

  it("注入后还在宽限期内 → 不判（慢链路不该被当成没集成）", () => {
    expect(
      shouldRerouteForMissingIntegration({
        now: T0 + VISIBLE_INTEGRATION_GRACE_MS - 1,
        injectedAt: T0,
        lastExecStartedAt: undefined,
      }),
    ).toBe(false);
  });

  it("注入后超过宽限期、始终没见过执行标记 → 判定 shell 不回报", () => {
    expect(
      shouldRerouteForMissingIntegration({
        now: T0 + VISIBLE_INTEGRATION_GRACE_MS,
        injectedAt: T0,
        lastExecStartedAt: undefined,
      }),
    ).toBe(true);
  });

  it("注入之后见过执行标记 → 集成活着，命令慢也要继续等", () => {
    expect(
      shouldRerouteForMissingIntegration({
        now: T0 + 120_000,
        injectedAt: T0,
        lastExecStartedAt: T0 + 500,
      }),
    ).toBe(false);
  });

  it("执行标记早于本次注入（上一条命令留下的）→ 不算证据", () => {
    expect(
      shouldRerouteForMissingIntegration({
        now: T0 + VISIBLE_INTEGRATION_GRACE_MS + 1,
        injectedAt: T0,
        lastExecStartedAt: T0 - 10_000,
      }),
    ).toBe(true);
  });

  it("宽限期可注入更短值（测试与将来调参用），默认 8 秒", () => {
    expect(VISIBLE_INTEGRATION_GRACE_MS).toBe(8_000);
    expect(
      shouldRerouteForMissingIntegration({
        now: T0 + 1_000,
        injectedAt: T0,
        lastExecStartedAt: undefined,
        graceMs: 500,
      }),
    ).toBe(true);
  });
});
