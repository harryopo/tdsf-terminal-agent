// TDSF 魔改 2026-08-28: sidecar-config-sync 单测
// =============================================================================
// 覆盖三块：
//   1. buildSidecarLlmConfig 纯映射（anthropic 特例 / OpenAI 兼容原名透传 /
//      ollama 无 key）
//   2. resolveSidecarTarget 目标解析（云端 / compat endpoint / 本地 / openrouter /
//      未知模型）
//   3. syncSidecarLlmConfig 编排（key 校验拦截 / invoke 参数结构 / 失败静默）
// =============================================================================

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- mock 依赖（vi.hoisted 保证 mock 工厂可引用） ---------------------------

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const getKeyMock = vi.hoisted(() => vi.fn());
const getCustomEndpointKeyMock = vi.hoisted(() => vi.fn());
vi.mock("./keyring", () => ({
  getKey: getKeyMock,
  getCustomEndpointKey: getCustomEndpointKeyMock,
}));

/** chatStore 选中模型的可变桩（模拟用户切换模型） */
const currentModelId = vi.hoisted(() => ({ value: "deepseek-v4-flash" }));
vi.mock("../store/chatStore", () => ({
  useChatStore: {
    getState: () => ({ selectedModelId: currentModelId.value }),
  },
}));

/** 偏好快照的可变桩（模拟用户改本地模型/端点配置） */
const prefsState = vi.hoisted(() => ({
  value: {
    lmstudioBaseURL: "http://localhost:1234/v1",
    lmstudioModelId: "",
    mlxBaseURL: "http://127.0.0.1:8080/v1",
    mlxModelId: "",
    ollamaBaseURL: "http://localhost:11434/v1",
    ollamaModelId: "qwen3:8b",
    openaiCompatibleBaseURL: "",
    openaiCompatibleModelId: "",
    openrouterModelId: "openai/gpt-5.4-mini",
    customEndpoints: [] as { id: string; baseURL: string; modelId: string }[],
  },
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: () => prefsState.value,
  },
}));

import {
  buildSidecarLlmConfig,
  isSidecarConfigSynced,
  resolveSidecarTarget,
  runSidecarConfigSyncNow,
  type SidecarPrefsSnapshot,
  syncSidecarLlmConfig,
} from "./sidecar-config-sync";

const basePrefs: SidecarPrefsSnapshot = {
  lmstudioBaseURL: "http://localhost:1234/v1",
  lmstudioModelId: "",
  mlxBaseURL: "http://127.0.0.1:8080/v1",
  mlxModelId: "",
  ollamaBaseURL: "http://localhost:11434/v1",
  ollamaModelId: "qwen3:8b",
  openaiCompatibleBaseURL: "",
  openaiCompatibleModelId: "",
  openrouterModelId: "openai/gpt-5.4-mini",
  customEndpoints: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  currentModelId.value = "deepseek-v4-flash";
  prefsState.value = { ...basePrefs, customEndpoints: [] };
});

// === 1. buildSidecarLlmConfig 纯映射 =========================================

describe("buildSidecarLlmConfig", () => {
  it("anthropic 特例：原生 provider，base_url 置空", () => {
    const cfg = buildSidecarLlmConfig({
      provider: "anthropic",
      model: "claude-sonnet-5",
      apiKey: "sk-ant-x",
      baseURL: "https://should.be.ignored",
    });
    expect(cfg).toEqual({
      provider: "anthropic",
      api_key: "sk-ant-x",
      base_url: "",
      model: "claude-sonnet-5",
    });
  });

  it("deepseek：传原 provider 名 + base_url（sidecar 按 OpenAI 兼容处理）", () => {
    const cfg = buildSidecarLlmConfig({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      apiKey: "sk-ds",
      baseURL: "https://api.deepseek.com",
    });
    expect(cfg).toEqual({
      provider: "deepseek",
      api_key: "sk-ds",
      base_url: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
    });
  });

  it("新增国产 provider（qwen）同样原样透传", () => {
    const cfg = buildSidecarLlmConfig({
      provider: "qwen",
      model: "qwen3.8-flash",
      apiKey: "sk-qw",
      baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    });
    expect(cfg.provider).toBe("qwen");
    expect(cfg.base_url).toBe(
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    );
  });

  it("ollama 无 key：api_key 为空字符串（is_configured 校验由调用方拦截）", () => {
    const cfg = buildSidecarLlmConfig({
      provider: "ollama",
      model: "qwen3:8b",
      apiKey: null,
      baseURL: "http://localhost:11434/v1",
    });
    expect(cfg).toEqual({
      provider: "ollama",
      api_key: "",
      base_url: "http://localhost:11434/v1",
      model: "qwen3:8b",
    });
  });
});

// === 2. resolveSidecarTarget 目标解析 ========================================

describe("resolveSidecarTarget", () => {
  it("云端普通模型：注册模型 id + PROVIDER_BASE_URLS 固定端点", () => {
    const t = resolveSidecarTarget("deepseek-v4-flash", basePrefs);
    expect(t).toEqual({
      provider: "deepseek",
      model: "deepseek-v4-flash",
      baseURL: "https://api.deepseek.com",
      endpointId: null,
    });
  });

  it("新增国产模型（qwen3.8-flash）解析到阿里百炼端点", () => {
    const t = resolveSidecarTarget("qwen3.8-flash", basePrefs);
    expect(t?.provider).toBe("qwen");
    expect(t?.model).toBe("qwen3.8-flash");
    expect(t?.baseURL).toBe(
      "https://dashscope.aliyuncs.com/compatible-mode/v1",
    );
  });

  it("anthropic：baseURL 为空（sidecar 原生分支不需要）", () => {
    const t = resolveSidecarTarget("claude-sonnet-5", basePrefs);
    expect(t?.provider).toBe("anthropic");
    expect(t?.baseURL).toBe("");
  });

  it("compat 模型：取 endpoint 的 modelId/baseURL，key 走 endpoint 账户", () => {
    prefsState.value.customEndpoints = [
      { id: "ab12cd34", baseURL: "https://api.example.com/v1", modelId: "llama-3.3-70b" },
    ];
    const t = resolveSidecarTarget("compat-ab12cd34", prefsState.value);
    expect(t).toEqual({
      provider: "openai-compatible",
      model: "llama-3.3-70b",
      baseURL: "https://api.example.com/v1",
      endpointId: "ab12cd34",
    });
  });

  it("compat 模型 endpoint 缺失/不完整 → null", () => {
    expect(resolveSidecarTarget("compat-missing", basePrefs)).toBeNull();
  });

  it("ollama-local：取偏好里用户填写的模型与 baseURL", () => {
    const t = resolveSidecarTarget("ollama-local", basePrefs);
    expect(t).toEqual({
      provider: "ollama",
      model: "qwen3:8b",
      baseURL: "http://localhost:11434/v1",
      endpointId: null,
    });
  });

  it("本地 provider 未填模型 id → null", () => {
    expect(
      resolveSidecarTarget("lmstudio-local", {
        ...basePrefs,
        lmstudioModelId: "",
      }),
    ).toBeNull();
  });

  it("openrouter-custom：模型 id 来自偏好，端点固定", () => {
    const t = resolveSidecarTarget("openrouter-custom", basePrefs);
    expect(t).toEqual({
      provider: "openrouter",
      model: "openai/gpt-5.4-mini",
      baseURL: "https://openrouter.ai/api/v1",
      endpointId: null,
    });
  });

  it("未知模型 id → null", () => {
    expect(resolveSidecarTarget("no-such-model", basePrefs)).toBeNull();
  });
});

// === 3. syncSidecarLlmConfig 编排 ============================================

describe("syncSidecarLlmConfig", () => {
  it("成功路径：按 agent.configure 协议 invoke，params.config 结构正确", async () => {
    getKeyMock.mockResolvedValue("sk-ds-key");
    invokeMock.mockResolvedValue({ ok: true, message: "LLM 配置已更新" });

    const r = await syncSidecarLlmConfig();

    expect(r.ok).toBe(true);
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(invokeMock).toHaveBeenCalledWith("ipc_invoke", {
      method: "agent.configure",
      params: {
        config: {
          provider: "deepseek",
          api_key: "sk-ds-key",
          base_url: "https://api.deepseek.com",
          model: "deepseek-v4-flash",
        },
      },
    });
  });

  it("anthropic 配置同样走 agent.configure（provider=anthropic、无 base_url）", async () => {
    currentModelId.value = "claude-sonnet-5";
    getKeyMock.mockResolvedValue("sk-ant-key");
    invokeMock.mockResolvedValue({ ok: true });

    const r = await syncSidecarLlmConfig();

    expect(r.ok).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("ipc_invoke", {
      method: "agent.configure",
      params: {
        config: {
          provider: "anthropic",
          api_key: "sk-ant-key",
          base_url: "",
          model: "claude-sonnet-5",
        },
      },
    });
  });

  it("云端未配 key → ok:false，且不触发 invoke", async () => {
    getKeyMock.mockResolvedValue(null);

    const r = await syncSidecarLlmConfig();

    expect(r.ok).toBe(false);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("ollama-local（keyless）→ 占位 key 同步成功（本地部署在 Agent 面板可用）", async () => {
    currentModelId.value = "ollama-local";
    invokeMock.mockResolvedValue({ ok: true });

    const r = await syncSidecarLlmConfig();

    expect(r.ok).toBe(true);
    expect(getKeyMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("ipc_invoke", {
      method: "agent.configure",
      // 占位 key：Ollama 兼容端点不校验，但 sidecar is_configured 要求非空
      params: {
        config: expect.objectContaining({
          provider: "ollama",
          api_key: "tdsf-local",
          model: expect.any(String),
        }),
      },
    });
  });

  it("compat 模型：key 取 endpoint 专属账户", async () => {
    prefsState.value.customEndpoints = [
      { id: "ab12cd34", baseURL: "https://api.example.com/v1", modelId: "llama-3.3-70b" },
    ];
    currentModelId.value = "compat-ab12cd34";
    getCustomEndpointKeyMock.mockResolvedValue("sk-ep");
    getKeyMock.mockResolvedValue(null); // 不应被调用
    invokeMock.mockResolvedValue({ ok: true });

    const r = await syncSidecarLlmConfig();

    expect(r.ok).toBe(true);
    expect(getCustomEndpointKeyMock).toHaveBeenCalledWith("ab12cd34");
    expect(getKeyMock).not.toHaveBeenCalled();
    expect(invokeMock).toHaveBeenCalledWith("ipc_invoke", {
      method: "agent.configure",
      params: {
        config: {
          provider: "openai-compatible",
          api_key: "sk-ep",
          base_url: "https://api.example.com/v1",
          model: "llama-3.3-70b",
        },
      },
    });
  });

  it("sidecar 返回 ok:false → 透传失败信息", async () => {
    getKeyMock.mockResolvedValue("sk-x");
    invokeMock.mockResolvedValue({
      ok: false,
      message: "LLM 配置失败，请检查 API Key 和模型名称",
    });

    const r = await syncSidecarLlmConfig();

    expect(r.ok).toBe(false);
    expect(r.detail).toContain("LLM 配置失败");
  });

  it("sidecar 未运行（invoke 抛错）→ ok:false 静默，不抛异常", async () => {
    getKeyMock.mockResolvedValue("sk-x");
    invokeMock.mockRejectedValue(new Error("sidecar not running"));

    await expect(syncSidecarLlmConfig()).resolves.toEqual({
      ok: false,
      detail: "sidecar not running",
    });
  });
});

// === 4. 同步标志与立即同步编排 ===============================================

describe("sidecar config sync flag", () => {
  it("runSidecarConfigSyncNow 成功后置位标志，失败也置位（防重复打）", async () => {
    expect(isSidecarConfigSynced()).toBe(false);

    getKeyMock.mockResolvedValue("sk-ds-key");
    invokeMock.mockResolvedValue({ ok: true });
    await runSidecarConfigSyncNow();
    expect(isSidecarConfigSynced()).toBe(true);
  });

  it("runSidecarConfigSyncNow 失败路径：console.warn 单条且标志置位", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      getKeyMock.mockResolvedValue(null); // 无 key → 失败
      const r = await runSidecarConfigSyncNow();
      expect(r.ok).toBe(false);
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(isSidecarConfigSynced()).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
