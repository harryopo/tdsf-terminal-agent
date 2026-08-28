// TDSF 魔改 2026-08-28: Sidecar LLM 配置同步层
// =============================================================================
//
// 背景：Python sidecar（src-tauri/sidecar/）的 AI 引擎有自己独立的 LLM 配置
// （core/llm_config.py：{provider, api_key, base_url, model}），持久化在
// .tdsf-data/llm_config.json，与前端 keyring/偏好 store 相互独立。
// agent.configure JSON-RPC（agents/__init__.py _rpc_agent_configure）已实现
// 运行时重配置 + 落盘（一次 configure 永久生效，sidecar 重启后 load_config 自盘读）。
//
// 本模块职责：把前端"当前选中的对话模型配置"（chatStore.selectedModelId +
// preferences + keyring）映射为 sidecar 结构并通过 agent.configure 推送。
//
// 调用通道（与 sidecar-adapter.ts 的 agent.invoke 同构）：
//   invoke('ipc_invoke', { method: 'agent.configure', params: { config } })
//     → Rust ipc_invoke (src-tauri/src/modules/ipc.rs) → stdio JSON-RPC
//     → _rpc_agent_configure(config={...}) → reconfigure → save_config 落盘
//
// provider 映射结论（实测 sidecar 源码，勿凭猜测）：
//   - core/llm_config.py make_llm_call：仅 provider == "anthropic" 走原生分支，
//     其余任意字符串一律按 OpenAI 兼容（ChatOpenAI）处理，且尊重 base_url
//   - strands_backend/model_adapter.py create_strands_model：openai/未知 provider
//     均落 OpenAIModel（client_args 尊重 base_url），仅 anthropic 走原生
//   → 因此 anthropic 特判传 "anthropic"，其余一律传前端原 provider 名
//     （deepseek/qwen/ollama/...），两条路径等价且 sidecar 日志可读性更好
//
// 失败策略：静默降级（console.warn 单条）——配置同步失败不阻塞 AI 对话，
// sidecar 会沿用上次落盘配置或 mock LLM。

import { invoke } from "@tauri-apps/api/core";
import {
  DEFAULT_MODEL_ID,
  endpointIdFromCompatModel,
  getProvider,
  isCompatModelId,
  PROVIDER_BASE_URLS,
  type ProviderId,
  providerNeedsKey,
  resolveModel,
} from "../config";
import { getCustomEndpointKey, getKey } from "./keyring";

// === 类型 ====================================================================

/** 与 sidecar core/llm_config.py LLMConfig.to_dict() 对齐的配置结构 */
export type SidecarLlmConfig = {
  provider: string;
  api_key: string;
  base_url: string;
  model: string;
};

/** agent.configure 的返回值（agents/__init__.py：{ok, llm_call_set, message}） */
type SidecarConfigureResult = {
  ok?: boolean;
  llm_call_set?: boolean;
  message?: string;
};

export type SidecarSyncResult = { ok: boolean; detail?: string };

/**
 * 偏好快照（resolveSidecarTarget 的入参，纯数据便于单测）。
 * 字段均为 src/modules/settings/store.ts Preferences 的子集。
 */
export type SidecarPrefsSnapshot = {
  lmstudioBaseURL: string;
  lmstudioModelId: string;
  mlxBaseURL: string;
  mlxModelId: string;
  ollamaBaseURL: string;
  ollamaModelId: string;
  openaiCompatibleBaseURL: string;
  openaiCompatibleModelId: string;
  openrouterModelId: string;
  customEndpoints: readonly {
    id: string;
    baseURL: string;
    modelId: string;
  }[];
};

/**
 * 解析后的 sidecar 同步目标（ provider/model/baseURL + key 取法）。
 * endpointId 非空表示 key 需从 custom endpoint 专属 keyring 账户读取。
 */
export type SidecarSyncTarget = {
  provider: ProviderId;
  /** 传给 sidecar 的真实模型 id（本地/compat/openrouter 取用户填写的值） */
  model: string;
  baseURL: string;
  endpointId: string | null;
};

// === 纯函数：模型 id → 同步目标 ==============================================

/**
 * 把前端选中的模型 id 解析为 sidecar 同步目标。
 *
 * 与 agent.ts buildConfiguredLanguageModel 的 resolvedId/baseURL 解析规则一致：
 *   - compat-xxx 模型 → custom endpoint 的 modelId + baseURL
 *   - lmstudio/mlx/ollama 本地 → 偏好里用户填写的 modelId/baseURL
 *   - openai-compatible-custom → 偏好的 openaiCompatible* 字段
 *   - openrouter-custom → 偏好的 openrouterModelId（OpenRouter 固定端点）
 *   - 其余云端 → MODELS 注册的模型 id + PROVIDER_BASE_URLS 固定端点
 *
 * @returns 未知模型 id（resolveModel 抛错）时返回 null
 */
export function resolveSidecarTarget(
  modelId: string,
  prefs: SidecarPrefsSnapshot,
): SidecarSyncTarget | null {
  if (isCompatModelId(modelId)) {
    const endpointId = endpointIdFromCompatModel(modelId);
    const ep = prefs.customEndpoints.find((e) => e.id === endpointId);
    if (!ep || !ep.modelId.trim() || !ep.baseURL.trim()) return null;
    return {
      provider: "openai-compatible",
      model: ep.modelId.trim(),
      baseURL: ep.baseURL.trim(),
      endpointId: ep.id,
    };
  }

  const m = resolveModelSafe(modelId);
  if (!m) return null;
  switch (m.id) {
    case "lmstudio-local":
      return localTarget("lmstudio", prefs.lmstudioModelId, prefs.lmstudioBaseURL);
    case "mlx-local":
      return localTarget("mlx", prefs.mlxModelId, prefs.mlxBaseURL);
    case "ollama-local":
      return localTarget("ollama", prefs.ollamaModelId, prefs.ollamaBaseURL);
    case "openai-compatible-custom":
      return localTarget(
        "openai-compatible",
        prefs.openaiCompatibleModelId,
        prefs.openaiCompatibleBaseURL,
      );
    case "openrouter-custom":
      // OpenRouter 模型 id 用户自填（provider/model 完整格式），端点固定
      if (!prefs.openrouterModelId.trim()) return null;
      return {
        provider: "openrouter",
        model: prefs.openrouterModelId.trim(),
        baseURL: providerBaseUrl("openrouter"),
        endpointId: null,
      };
    default:
      return {
        provider: m.provider,
        model: m.id,
        baseURL: m.provider === "anthropic" ? "" : providerBaseUrl(m.provider),
        endpointId: null,
      };
  }
}

/** 云端 provider 的固定 OpenAI 兼容端点（config.ts 单一真源；anthropic 无需） */
function providerBaseUrl(provider: ProviderId): string {
  return PROVIDER_BASE_URLS[provider] ?? "";
}

/**
 * resolveModel 的容错包装：未知模型 id（如旧收藏/手动清空后的悬空引用）
 * 返回 null 而不是抛错，让调用方走"不可同步"降级路径。
 */
function resolveModelSafe(modelId: string): ReturnType<typeof resolveModel> | null {
  try {
    return resolveModel(modelId);
  } catch {
    return null;
  }
}

function localTarget(
  provider: ProviderId,
  modelId: string,
  baseURL: string,
): SidecarSyncTarget | null {
  if (!modelId.trim()) return null;
  return {
    provider,
    model: modelId.trim(),
    baseURL: baseURL.trim(),
    endpointId: null,
  };
}

// === 纯函数：同步目标 → sidecar LLM 配置 =====================================

/**
 * 映射为 sidecar 结构（provider 语义见文件头注释）。
 * 纯函数不拦截无 key 场景（由 syncSidecarLlmConfig 提前校验），
 * 便于单测直接覆盖 ollama 无 key 等输入形态。
 */
export function buildSidecarLlmConfig(input: {
  provider: ProviderId;
  model: string;
  apiKey: string | null;
  baseURL: string;
}): SidecarLlmConfig {
  const model = input.model.trim();
  const apiKey = input.apiKey?.trim() ?? "";
  if (input.provider === "anthropic") {
    // sidecar ChatAnthropic 固定官方端点（不支持自定义 base_url），置空
    return { provider: "anthropic", api_key: apiKey, base_url: "", model };
  }
  return {
    // 实测 sidecar：非 anthropic 的任意 provider 字符串均按 OpenAI 兼容处理
    // （llm_config.py make_llm_call 默认分支 + model_adapter.py 兜底分支），
    // 传原 provider 名（deepseek/qwen/ollama/...）而非硬编码 "openai"，
    // 两条后端路径（LangGraph/Strands）等价且 sidecar 日志可读性更好
    provider: input.provider,
    api_key: apiKey,
    base_url: input.baseURL.trim(),
    model,
  };
}

// === 模块级同步标志 ==========================================================

/**
 * 本次会话内是否已完成（或已放弃）一次 sidecar 配置同步。
 * 模块内存级——不持久化：sidecar 重启后前端进程仍持有旧标志也没关系，
 * 配置变更（ModelsSection 保存）会重置标志触发重新同步。
 */
let _sidecarConfigSynced = false;

export function isSidecarConfigSynced(): boolean {
  return _sidecarConfigSynced;
}

/** 置为已同步（失败也置位：本次会话不重复打，避免每条消息都多一次 IPC） */
export function markSidecarConfigSynced(): void {
  _sidecarConfigSynced = true;
}

/** 配置变更时重置标志（下次 runSidecarStream 会重新同步） */
export function resetSidecarConfigSyncFlag(): void {
  _sidecarConfigSynced = false;
}

// === 主流程：syncSidecarLlmConfig ============================================

/**
 * 把当前对话模型配置同步给 sidecar。
 *
 * 数据来源：
 *   - 对话模型：chatStore.selectedModelId（useAiBootstrap 已把偏好 defaultModelId
 *     mirror 进来，用户在 AI 面板切换模型时也会更新——是"当前选中"的唯一真源）
 *   - 本地 baseURL/modelId、customEndpoints：preferences zustand store 快照
 *   - API Key：keyring（云端按 provider 账户；custom endpoint 按专属账户）
 *
 * 失败一律返回 {ok:false} 静默（调用方 console.warn 单条），不抛异常。
 */
export async function syncSidecarLlmConfig(): Promise<SidecarSyncResult> {
  try {
    const modelId = await getCurrentChatModelId();
    const prefs = await getPrefsSnapshot();

    const target = resolveSidecarTarget(modelId, prefs);
    if (!target) {
      return {
        ok: false,
        detail: `当前模型不可同步（未配置完整的本地模型或未知模型）: ${modelId}`,
      };
    }

    // key：custom endpoint 专属账户优先，其次 provider 账户；本地 provider 无 key
    const apiKey = target.endpointId
      ? await getCustomEndpointKey(target.endpointId)
      : providerNeedsKey(target.provider)
        ? await getKey(target.provider)
        : null;

    if (!apiKey?.trim()) {
      // sidecar llm_config.py is_configured 要求非空 api_key——无 key 的本地
      // 模型（ollama/lmstudio/mlx）与未配 key 的端点无法在 sidecar 生效，
      // 提前拦截避免一次注定失败的 IPC
      return {
        ok: false,
        detail: `${getProvider(target.provider).label} 未配置 API Key（本地模型不走 sidecar 配置同步）`,
      };
    }

    const config = buildSidecarLlmConfig({
      provider: target.provider,
      model: target.model,
      apiKey,
      baseURL: target.baseURL,
    });

    const res = await invoke<SidecarConfigureResult>("ipc_invoke", {
      method: "agent.configure",
      params: { config },
    });

    if (res?.ok) return { ok: true };
    return {
      ok: false,
      detail: res?.message || "sidecar 返回配置失败（检查 API Key 与模型名）",
    };
  } catch (e) {
    // sidecar 未运行 / IPC 失败：静默降级，不影响前端对话主流程
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 立即同步并管理标志（置位 → 同步 → 失败 warn 单条）。
 * 无论成败都置位标志：成功后 sidecar 已持有最新配置，无需 runSidecarStream
 * 入口重复同步；失败也置位防止每条消息重试（配置再次变更时由本函数重置）。
 * ModelsSection 的 debounce 回调与测试使用。
 */
export async function runSidecarConfigSyncNow(): Promise<SidecarSyncResult> {
  markSidecarConfigSynced();
  const r = await syncSidecarLlmConfig();
  if (!r.ok) {
    // 静默策略：单条 warn，不阻塞 UI、不弹窗
    console.warn("[sidecar-config-sync] sidecar LLM 配置同步失败:", r.detail);
  }
  return r;
}

// === 防连击 debounce =========================================================

let syncTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 防连击调度（500ms debounce）：ModelsSection 的保存/切换回调高频触发
 * （如连续修改 endpoint 字段），只让最后一次变更真正同步。
 */
export function scheduleSidecarConfigSync(delayMs = 500): void {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    void runSidecarConfigSyncNow();
  }, delayMs);
}

// === 内部：读取运行时状态 ====================================================

/** 当前对话模型 id（chatStore.selectedModelId 是唯一真源，含 AI 面板内切换） */
async function getCurrentChatModelId(): Promise<string> {
  try {
    const { useChatStore } = await import("../store/chatStore");
    const id = useChatStore.getState().selectedModelId;
    if (id) return id;
  } catch {
    // 模块加载失败（极端环境）→ 回退默认模型
  }
  return DEFAULT_MODEL_ID;
}

async function getPrefsSnapshot(): Promise<SidecarPrefsSnapshot> {
  const { usePreferencesStore } = await import("@/modules/settings/preferences");
  const s = usePreferencesStore.getState();
  return {
    lmstudioBaseURL: s.lmstudioBaseURL,
    lmstudioModelId: s.lmstudioModelId,
    mlxBaseURL: s.mlxBaseURL,
    mlxModelId: s.mlxModelId,
    ollamaBaseURL: s.ollamaBaseURL,
    ollamaModelId: s.ollamaModelId,
    openaiCompatibleBaseURL: s.openaiCompatibleBaseURL,
    openaiCompatibleModelId: s.openaiCompatibleModelId,
    openrouterModelId: s.openrouterModelId,
    customEndpoints: s.customEndpoints,
  };
}
