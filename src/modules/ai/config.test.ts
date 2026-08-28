import { describe, expect, it } from "vitest";
import {
  type CustomEndpoint,
  compatModelIdForEndpoint,
  DEFAULT_MODEL_ID,
  DEFAULT_STT_PROVIDER,
  endpointIdFromCompatModel,
  getModelContextLimit,
  isCompatModelId,
  MODEL_PRICING,
  migrateLegacyCompatEndpoint,
  modelKeepsReasoning,
  modelSupportsTemperature,
  modelUsesReasoningTokens,
  PROVIDERS,
  resolveModel,
} from "./config";

const endpoint: CustomEndpoint = {
  id: "ab12cd34",
  name: "My LLM",
  baseURL: "https://api.example.com/v1",
  modelId: "llama-3.3-70b",
  contextLimit: 64_000,
};

describe("compat model id helpers", () => {
  it("round-trips endpoint id through the synthetic model id", () => {
    const mid = compatModelIdForEndpoint(endpoint.id);
    expect(isCompatModelId(mid)).toBe(true);
    expect(endpointIdFromCompatModel(mid)).toBe(endpoint.id);
  });

  it("treats static model ids as non-compat", () => {
    expect(isCompatModelId("gpt-5.4-mini")).toBe(false);
    expect(endpointIdFromCompatModel("gpt-5.4-mini")).toBe("");
  });
});

describe("resolveModel", () => {
  it("resolves a compat model id against its endpoint", () => {
    const mid = compatModelIdForEndpoint(endpoint.id);
    const info = resolveModel(mid, [endpoint]);
    expect(info.provider).toBe("openai-compatible");
    expect(info.id).toBe(mid);
    expect(info.label).toBe(endpoint.modelId);
  });

  it("falls back to a placeholder when the endpoint is gone", () => {
    const info = resolveModel(compatModelIdForEndpoint("missing"), []);
    expect(info.provider).toBe("openai-compatible");
  });

  it("resolves a static model id from the registry", () => {
    expect(resolveModel("gpt-5.4-mini").provider).toBe("openai");
  });

  it.each([
    ["gpt-5.6", "openai"],
    ["gpt-5.6-terra", "openai"],
    ["gpt-5.6-luna", "openai"],
    ["claude-fable-5", "anthropic"],
    ["claude-sonnet-5", "anthropic"],
    ["grok-4.5", "xai"],
  ] as const)("resolves current model %s through %s", (modelId, provider) => {
    expect(resolveModel(modelId).provider).toBe(provider);
  });

  it("throws on an unknown static model id", () => {
    expect(() => resolveModel("nope-not-real")).toThrow();
  });
});

describe("getModelContextLimit", () => {
  it("uses the per-endpoint override for compat models", () => {
    const mid = compatModelIdForEndpoint(endpoint.id);
    expect(getModelContextLimit(mid, endpoint.contextLimit)).toBe(64_000);
  });

  it("reads the static table for known models", () => {
    expect(getModelContextLimit("claude-opus-4-7")).toBe(1_000_000);
  });

  it.each([
    ["gpt-5.6", 1_050_000],
    ["gpt-5.6-terra", 1_050_000],
    ["gpt-5.6-luna", 1_050_000],
    ["claude-fable-5", 1_000_000],
    ["claude-sonnet-5", 1_000_000],
    ["grok-4.5", 500_000],
  ] as const)("uses the published context limit for %s", (modelId, limit) => {
    expect(getModelContextLimit(modelId)).toBe(limit);
  });
});

describe("current model pricing", () => {
  it.each([
    ["gpt-5.6", 5, 30, 0.5],
    ["gpt-5.6-terra", 2.5, 15, 0.25],
    ["gpt-5.6-luna", 1, 6, 0.1],
    ["claude-fable-5", 10, 50, 1],
    ["claude-sonnet-5", 3, 15, 0.3],
    ["grok-4.5", 2, 6, 0.5],
  ] as const)(
    "uses the published token pricing for %s",
    (modelId, input, output, cacheRead) => {
      expect(MODEL_PRICING[modelId]).toEqual({ input, output, cacheRead });
    },
  );
});

describe("modelKeepsReasoning", () => {
  it("keeps reasoning for compat endpoints (freeform provider)", () => {
    const info = resolveModel(compatModelIdForEndpoint(endpoint.id), [
      endpoint,
    ]);
    expect(modelKeepsReasoning(info)).toBe(true);
  });

  it("drops reasoning for plain non-reasoning models", () => {
    expect(modelKeepsReasoning(resolveModel("gpt-5.4-mini"))).toBe(false);
  });

  it("keeps reasoning for tagged reasoning models", () => {
    expect(modelKeepsReasoning(resolveModel("claude-opus-4-7"))).toBe(true);
  });
});

describe("model sampling capabilities", () => {
  it.each([
    ["openai", "gpt-5.4-nano"],
    ["openai", "gpt-5.6"],
    ["anthropic", "claude-fable-5"],
    ["anthropic", "claude-sonnet-5"],
  ] as const)("omits temperature for %s/%s", (provider, modelId) => {
    expect(modelSupportsTemperature(provider, modelId)).toBe(false);
  });

  it("keeps temperature for models that accept sampling parameters", () => {
    expect(modelSupportsTemperature("openai", "gpt-4.1-mini")).toBe(true);
    expect(modelSupportsTemperature("xai", "grok-4.5")).toBe(true);
  });

  it("defaults unknown provider models to temperature support", () => {
    expect(modelSupportsTemperature("openai-compatible", "custom-model")).toBe(
      true,
    );
  });

  it.each([
    ["openai", "gpt-5.4-nano"],
    ["openai", "gpt-5.6-luna"],
    ["anthropic", "claude-sonnet-5"],
    ["xai", "grok-4.5"],
    ["groq", "openai/gpt-oss-20b"],
  ] as const)(
    "allocates a reasoning output budget for %s/%s",
    (provider, modelId) => {
      expect(modelUsesReasoningTokens(provider, modelId)).toBe(true);
    },
  );
});

describe("migrateLegacyCompatEndpoint", () => {
  it("migrates a fully configured legacy endpoint", () => {
    const out = migrateLegacyCompatEndpoint(
      "https://api.example.com/v1",
      "llama-3.3-70b",
      32_000,
      "fixedid1",
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      id: "fixedid1",
      baseURL: "https://api.example.com/v1",
      modelId: "llama-3.3-70b",
      contextLimit: 32_000,
    });
  });

  it("skips migration when base URL or model id is missing", () => {
    expect(migrateLegacyCompatEndpoint("", "m", 1, "x")).toEqual([]);
    expect(migrateLegacyCompatEndpoint("u", "  ", 1, "x")).toEqual([]);
  });
});

// ── TDSF 魔改 2026-08-28: AI 配置国产化（spec: add-domestic-first-ai-config） ──
describe("domestic-first AI config", () => {
  it("defaults the chat model to DeepSeek V4 Flash", () => {
    expect(DEFAULT_MODEL_ID).toBe("deepseek-v4-flash");
  });

  it("defaults STT to the local whisper.cpp server", () => {
    expect(DEFAULT_STT_PROVIDER).toBe("whispercpp");
  });

  it("orders providers domestic-first with the domestic set present", () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(ids[0]).toBe("deepseek");
    // qwen 即"阿里百炼"（dashscope 端点），provider id 用模型家族名
    for (const domestic of ["zhipu", "qwen", "moonshot"] as const) {
      expect(ids).toContain(domestic);
    }
    // 国产 provider 必须排在 OpenAI 之前（UI 下拉按数组序展示）
    expect(ids.indexOf("qwen")).toBeLessThan(ids.indexOf("openai"));
    expect(ids.indexOf("zhipu")).toBeLessThan(ids.indexOf("openai"));
    expect(ids.indexOf("moonshot")).toBeLessThan(ids.indexOf("openai"));
  });

  it("keeps legacy models resolvable for stored preferences", () => {
    // 老用户 localStorage 可能仍存 legacy id——目录必须可解析
    expect(() => resolveModel("gpt-5.4-mini")).not.toThrow();
    expect(resolveModel("gpt-5.4-mini").provider).toBe("openai");
    expect(() => resolveModel("gpt-4.1-mini")).not.toThrow();
  });

  it.each([
    ["glm-5.3", "zhipu"],
    ["glm-5.3-flash", "zhipu"],
    ["kimi-k3", "moonshot"],
    ["qwen3.8-flash", "qwen"],
  ] as const)("resolves domestic model %s through %s", (modelId, provider) => {
    expect(resolveModel(modelId).provider).toBe(provider);
  });

  it("prices the domestic default chat model", () => {
    expect(MODEL_PRICING["deepseek-v4-flash"]).toEqual({
      input: 0.07,
      output: 0.27,
      cacheRead: 0.007,
    });
  });

  it("prices the new domestic models (2026-08 snapshot)", () => {
    expect(MODEL_PRICING["glm-5.3"]).toEqual({ input: 1.2, output: 4.2 });
    expect(MODEL_PRICING["glm-5.3-flash"]).toEqual({
      input: 0.12,
      output: 0.5,
    });
    // ¥1/¥3 折算 USD（¥1 ≈ $0.14）
    expect(MODEL_PRICING["qwen3.8-flash"]).toEqual({
      input: 0.14,
      output: 0.42,
    });
    expect(MODEL_PRICING["kimi-k3"]).toEqual({ input: 0.6, output: 2.5 });
  });
});
