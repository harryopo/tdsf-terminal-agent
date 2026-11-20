export type ThinkingMode = "provider_default" | "on" | "off";
export type ReasoningEffort = "provider_default" | "low" | "medium" | "high";

export type ModelGenerationPreferences = {
  temperature: number | null;
  maxTokens: number | null;
  thinking: ThinkingMode;
  reasoningEffort: ReasoningEffort;
};

export type ModelTurnSnapshot = {
  configSnapshotId?: string;
  configGeneration?: number;
  provider?: string;
  requestedModel?: string;
  resolvedModel?: string;
  requestedMaxTokens?: number | null;
  effectiveMaxTokens?: number | null;
  applied?: Record<string, boolean>;
};

export type ModelConfigureReceipt = {
  requested?: Record<string, unknown>;
  effective?: Record<string, unknown>;
  applied?: Record<string, boolean>;
  sources?: Record<string, string>;
  warnings?: { field: string; code: string }[];
  capabilities?: {
    supports_temperature?: boolean;
    supports_thinking_off?: boolean;
    supported_efforts?: string[];
    reasoning_parameter_style?: string;
    adaptive_sdk_unsupported?: boolean;
  };
  turn_snapshot?: ModelTurnSnapshot;
};

export type SidecarGenerationFields = {
  temperature: number | null;
  max_tokens: number | null;
  thinking: ThinkingMode;
  reasoning_effort: ReasoningEffort;
};

export type GenerationSyncResult = {
  ok: boolean;
  detail?: string;
  receipt?: ModelConfigureReceipt;
};

export type GenerationCapabilityPreview = {
  supports_temperature: boolean;
  supports_thinking_off: boolean;
  supported_efforts: string[];
  reasoning_parameter_style: "openai_effort" | "anthropic_budget" | "anthropic_adaptive" | "none" | "unknown";
};

export function previewGenerationCapabilities(
  provider: string,
  model: string,
  baseURL = "",
): GenerationCapabilityPreview {
  const normalizedProvider = provider.trim().toLowerCase();
  const normalizedModel = model.trim().toLowerCase();
  const normalizedURL = baseURL.trim().toLowerCase().replace(/\/+$/, "");
  const officialOpenAI = normalizedProvider === "openai" && (
    !normalizedURL || normalizedURL === "https://api.openai.com" || normalizedURL === "https://api.openai.com/v1"
  );
  const openAIReasoning = /^(gpt-5|gpt-6|o1|o3|o4)/.test(normalizedModel);
  if (officialOpenAI) {
    return {
      supports_temperature: !openAIReasoning,
      supports_thinking_off: false,
      supported_efforts: openAIReasoning ? ["low", "medium", "high"] : [],
      reasoning_parameter_style: openAIReasoning ? "openai_effort" : "none",
    };
  }
  if (normalizedProvider === "anthropic" && normalizedModel.startsWith("claude-")) {
    const adaptive = /^(claude-fable-5|claude-mythos-5|claude-opus-5|claude-sonnet-5|claude-haiku-5|claude-opus-4\.[6-8]|claude-sonnet-4\.[6-8])/.test(normalizedModel);
    const offUnsupported = /^(claude-fable-|claude-mythos-|claude-opus-5\.5)/.test(normalizedModel);
    return {
      supports_temperature: true,
      supports_thinking_off: !offUnsupported,
      supported_efforts: adaptive ? ["low", "medium", "high"] : [],
      reasoning_parameter_style: adaptive ? "anthropic_adaptive" : "anthropic_budget",
    };
  }
  return {
    supports_temperature: !openAIReasoning,
    supports_thinking_off: false,
    supported_efforts: [],
    reasoning_parameter_style: "unknown",
  };
}

export const DEFAULT_MODEL_GENERATION: ModelGenerationPreferences = {
  temperature: 0.1,
  maxTokens: null,
  thinking: "provider_default",
  reasoningEffort: "provider_default",
};

const THINKING = new Set<ThinkingMode>(["provider_default", "on", "off"]);
const EFFORTS = new Set<ReasoningEffort>([
  "provider_default",
  "low",
  "medium",
  "high",
]);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function validateModelGeneration(input: unknown): ModelGenerationPreferences {
  const raw = input && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : {};
  const temperature = Object.hasOwn(raw, "temperature")
    ? raw.temperature
    : DEFAULT_MODEL_GENERATION.temperature;
  if (
    temperature !== null &&
    (typeof temperature !== "number" ||
      !Number.isFinite(temperature) ||
      temperature < 0 ||
      temperature > 2)
  ) {
    throw new Error("temperature 必须是 0 到 2 的有限数值或 null");
  }
  const maxTokens = Object.hasOwn(raw, "maxTokens")
    ? raw.maxTokens
    : DEFAULT_MODEL_GENERATION.maxTokens;
  if (
    maxTokens !== null &&
    (typeof maxTokens !== "number" || !Number.isInteger(maxTokens) || maxTokens <= 0)
  ) {
    throw new Error("maxTokens 必须是正整数或 null");
  }
  const thinking = raw.thinking ?? DEFAULT_MODEL_GENERATION.thinking;
  if (typeof thinking !== "string" || !THINKING.has(thinking as ThinkingMode)) {
    throw new Error("thinking 必须是 provider_default/on/off");
  }
  const reasoningEffort = raw.reasoningEffort ?? DEFAULT_MODEL_GENERATION.reasoningEffort;
  if (
    typeof reasoningEffort !== "string" ||
    !EFFORTS.has(reasoningEffort as ReasoningEffort)
  ) {
    throw new Error("reasoningEffort 必须是 provider_default/low/medium/high");
  }
  return {
    temperature: temperature as number | null,
    maxTokens: maxTokens as number | null,
    thinking: thinking as ThinkingMode,
    reasoningEffort: reasoningEffort as ReasoningEffort,
  };
}

export function readModelGeneration(input: unknown): ModelGenerationPreferences {
  return validateModelGeneration(input);
}

export function toSidecarGeneration(
  generation: ModelGenerationPreferences,
): SidecarGenerationFields {
  const value = validateModelGeneration(generation);
  return {
    temperature: value.temperature,
    max_tokens: value.maxTokens,
    thinking: value.thinking,
    reasoning_effort: value.reasoningEffort,
  };
}

export async function commitModelGeneration(
  candidate: ModelGenerationPreferences,
  previous: ModelGenerationPreferences,
  persist: (value: ModelGenerationPreferences) => Promise<void>,
  sync: () => Promise<GenerationSyncResult>,
  rollback: (value: ModelGenerationPreferences) => Promise<void>,
): Promise<GenerationSyncResult> {
  let next: ModelGenerationPreferences;
  try {
    next = validateModelGeneration(candidate);
  } catch (error) {
    return { ok: false, detail: errorText(error) };
  }
  try {
    await persist(next);
  } catch (error) {
    return { ok: false, detail: errorText(error) };
  }
  const restorePrevious = async (failure: string): Promise<GenerationSyncResult> => {
    try {
      await rollback(previous);
      const restored = await sync();
      return {
        ok: false,
        detail: restored.ok
          ? failure
          : `${failure}；旧配置恢复同步也失败：${restored.detail || "未知错误"}`,
      };
    } catch (error) {
      return { ok: false, detail: `${failure}；旧配置恢复异常：${errorText(error)}` };
    }
  };
  try {
    const result = await sync();
    if (result.ok) return result;
    return restorePrevious(result.detail || "模型配置同步失败，已回滚");
  } catch (error) {
    return restorePrevious(errorText(error));
  }
}