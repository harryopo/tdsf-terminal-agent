import { describe, expect, it, vi } from "vitest";
import {
  commitModelGeneration,
  DEFAULT_MODEL_GENERATION,
  readModelGeneration,
  toSidecarGeneration,
  validateModelGeneration,
} from "./modelGeneration";

describe("model generation preferences", () => {
  it("migrates missing fields while preserving explicit zero and null", () => {
    expect(readModelGeneration({})).toEqual(DEFAULT_MODEL_GENERATION);
    expect(readModelGeneration({ temperature: 0, maxTokens: null })).toEqual({
      ...DEFAULT_MODEL_GENERATION,
      temperature: 0,
      maxTokens: null,
    });
  });

  it("maps only model fields to the sidecar, never reasoning display", () => {
    const generation = validateModelGeneration({
      temperature: 0,
      maxTokens: 64,
      thinking: "on",
      reasoningEffort: "high",
    });
    expect(toSidecarGeneration(generation)).toEqual({
      temperature: 0,
      max_tokens: 64,
      thinking: "on",
      reasoning_effort: "high",
    });
    expect(toSidecarGeneration(generation)).not.toHaveProperty("showReasoning");
  });

  it.each([true, -0.1, 2.1, Number.NaN, "0.1"])(
    "rejects invalid temperature %s without writes",
    async (temperature) => {
      const persist = vi.fn();
      const result = await commitModelGeneration(
        { ...DEFAULT_MODEL_GENERATION, temperature } as unknown as typeof DEFAULT_MODEL_GENERATION,
        DEFAULT_MODEL_GENERATION,
        persist,
        vi.fn(),
        vi.fn(),
      );
      expect(result.ok).toBe(false);
      expect(result.detail).toContain("temperature");
      expect(persist).not.toHaveBeenCalled();
    },
  );

  it.each([true, 0, -1, 1.5, "64"])("rejects invalid maxTokens %s", (maxTokens) => {
    expect(() => validateModelGeneration({ maxTokens })).toThrow(
      "maxTokens 必须是正整数或 null",
    );
  });

  it("commits in persist/sync order and returns the real receipt", async () => {
    const calls: string[] = [];
    const receipt = { turn_snapshot: { configGeneration: 4 } };
    const result = await commitModelGeneration(
      { ...DEFAULT_MODEL_GENERATION, temperature: 0 },
      DEFAULT_MODEL_GENERATION,
      async () => { calls.push("persist"); },
      async () => {
        calls.push("sync");
        return { ok: true, receipt } as const;
      },
      async () => { calls.push("rollback"); },
    );

    expect(result).toEqual({ ok: true, receipt });
    expect(calls).toEqual(["persist", "sync"]);
  });

  it("rolls back after sync failure and never reports the new config as effective", async () => {
    const previous = { ...DEFAULT_MODEL_GENERATION, temperature: 0.2 };
    const rollback = vi.fn();
    const result = await commitModelGeneration(
      { ...DEFAULT_MODEL_GENERATION, temperature: 0 },
      previous,
      vi.fn().mockResolvedValue(undefined),
      vi.fn()
        .mockResolvedValueOnce({ ok: false, detail: "construct failed" })
        .mockResolvedValueOnce({ ok: true }),
      rollback,
    );

    expect(result).toEqual({ ok: false, detail: "construct failed" });
    expect(rollback).toHaveBeenCalledWith(previous);
  });

  it("rejects invalid thinking and reasoningEffort values", () => {
    expect(() => validateModelGeneration({ thinking: "auto" })).toThrow(
      "thinking 必须是 provider_default/on/off",
    );
    expect(() => validateModelGeneration({ reasoningEffort: "max" })).toThrow(
      "reasoningEffort 必须是 provider_default/low/medium/high",
    );
  });

  it("returns persistence failure without attempting sync or rollback", async () => {
    const sync = vi.fn();
    const rollback = vi.fn();
    const result = await commitModelGeneration(
      DEFAULT_MODEL_GENERATION,
      DEFAULT_MODEL_GENERATION,
      vi.fn().mockRejectedValue(new Error("disk full")),
      sync,
      rollback,
    );
    expect(result).toEqual({ ok: false, detail: "disk full" });
    expect(sync).not.toHaveBeenCalled();
    expect(rollback).not.toHaveBeenCalled();
  });

  it("rolls back when sync rejects and supplies the default detail when absent", async () => {
    const rollback = vi.fn().mockResolvedValue(undefined);
    const rejected = await commitModelGeneration(
      DEFAULT_MODEL_GENERATION,
      DEFAULT_MODEL_GENERATION,
      vi.fn().mockResolvedValue(undefined),
      vi.fn()
        .mockRejectedValueOnce(new Error("IPC offline"))
        .mockResolvedValueOnce({ ok: true }),
      rollback,
    );
    expect(rejected).toEqual({ ok: false, detail: "IPC offline" });

    const withoutDetail = await commitModelGeneration(
      DEFAULT_MODEL_GENERATION,
      DEFAULT_MODEL_GENERATION,
      vi.fn().mockResolvedValue(undefined),
      vi.fn()
        .mockResolvedValueOnce({ ok: false })
        .mockResolvedValueOnce({ ok: true }),
      rollback,
    );
    expect(withoutDetail).toEqual({ ok: false, detail: "模型配置同步失败，已回滚" });
    expect(rollback).toHaveBeenCalledTimes(2);
  });
});