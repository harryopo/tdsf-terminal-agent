import { usePreferencesStore } from "@/modules/settings/preferences";
import { Chat, type UIMessage } from "@ai-sdk/react";
import {
  type ChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from "ai";
import { getModel, type ModelId, providerNeedsKey } from "../config";
import { BUILTIN_AGENTS } from "../lib/agents";
import { createContextAwareTransport } from "../lib/transport";
import type { ToolContext } from "../tools/tools";
import { useAgentsStore } from "./agentsStore";
import {
  type AgentRunStatus,
  chats,
  getActiveProviderKey,
  seedMessages,
  touchChat,
  useChatStore,
} from "./chatStore";
import { usePlanStore } from "./planStore";

/**
 * 把 Python 端 mood 字符串映射到 clone 的 AgentRunStatus
 *
 * Python 端 mood（来自 BaseAgent._emit_mood）:
 *   "idle" / "thinking" / "streaming" / "working" / "waiting" / "done" / "error"
 *
 * clone 的 AgentRunStatus:
 *   "idle" / "thinking" / "streaming" / "awaiting-approval" / "error"
 *
 * 映射规则:
 *   - 严格匹配 status union 的 mood 直接透传
 *   - "working" → "streaming"（语义等价：Agent 正在输出）
 *   - "waiting" → "awaiting-approval"（语义等价：等待用户响应）
 *   - "done"    → "idle"（Agent 完成回到 idle）
 *   - 未知 mood 不更新 status（避免污染 UI 状态）
 */
function moodToStatus(mood: string): AgentRunStatus | null {
  switch (mood) {
    case "idle":
    case "thinking":
    case "streaming":
    case "error":
      return mood;
    case "awaiting-approval":
      return "awaiting-approval";
    case "working":
      return "streaming";
    case "waiting":
      return "awaiting-approval";
    case "done":
      return "idle";
    default:
      return null;
  }
}

function makeChat(sessionId: string): Chat<UIMessage> {
  const readCache = new Map<string, { size: number; hash: number }>();
  const toolContext: ToolContext = {
    getCwd: () => useChatStore.getState().live.getCwd(),
    getWorkspaceRoot: () => useChatStore.getState().live.getWorkspaceRoot(),
    getTerminalContext: () => useChatStore.getState().live.getTerminalContext(),
    isActiveTerminalPrivate: () =>
      useChatStore.getState().live.isActiveTerminalPrivate(),
    injectIntoActivePty: (text) =>
      useChatStore.getState().live.injectIntoActivePty(text),
    openPreview: (url) => useChatStore.getState().live.openPreview(url),
    spawnAgent: (prompt) =>
      useChatStore.getState().live.spawnManagedAgent(prompt, sessionId),
    readAgentOutput: (leafId) =>
      useChatStore.getState().live.readLeafBuffer(leafId),
    readCache,
    getSessionId: () => sessionId,
  };

  const transport = createContextAwareTransport({
    getKeys: () => useChatStore.getState().apiKeys,
    toolContext,
    getModelId: () => useChatStore.getState().selectedModelId,
    getCustomInstructions: () =>
      usePreferencesStore.getState().customInstructions,
    getAgentPersona: () => {
      const { activeId, customAgents } = useAgentsStore.getState();
      const all = [...BUILTIN_AGENTS, ...customAgents];
      const a = all.find((x) => x.id === activeId) ?? BUILTIN_AGENTS[0];
      return { name: a.name, instructions: a.instructions };
    },
    getLive: () => {
      const live = useChatStore.getState().live;
      return {
        cwd: live.getCwd(),
        terminalPrivate: live.isActiveTerminalPrivate(),
        workspaceRoot: live.getWorkspaceRoot(),
        activeFile: live.getActiveFile(),
      };
    },
    getPlanMode: () => usePlanStore.getState().active,
    // TDSF 阶段3: 注入当前 TDSF agent id，让 transport 路由到 Sidecar 路径
    getTdsfAgentId: () => useChatStore.getState().tdsfAgentId,
    // TDSF 阶段3: mood 变化时更新 agentMeta.status（驱动 UI mood 表情）
    onMood: (mood) => {
      const status = moodToStatus(mood);
      if (status) {
        useChatStore.getState().patchAgentMeta({ status });
      }
    },
    getLmstudioBaseURL: () => usePreferencesStore.getState().lmstudioBaseURL,
    getLmstudioModelId: () => usePreferencesStore.getState().lmstudioModelId,
    getMlxBaseURL: () => usePreferencesStore.getState().mlxBaseURL,
    getMlxModelId: () => usePreferencesStore.getState().mlxModelId,
    getOllamaBaseURL: () => usePreferencesStore.getState().ollamaBaseURL,
    getOllamaModelId: () => usePreferencesStore.getState().ollamaModelId,
    getOpenaiCompatibleBaseURL: () =>
      usePreferencesStore.getState().openaiCompatibleBaseURL,
    getOpenaiCompatibleModelId: () =>
      usePreferencesStore.getState().openaiCompatibleModelId,
    getOpenaiCompatibleContextLimit: () =>
      usePreferencesStore.getState().openaiCompatibleContextLimit,
    getOpenrouterModelId: () =>
      usePreferencesStore.getState().openrouterModelId,
    getCustomEndpoints: () => usePreferencesStore.getState().customEndpoints,
    getCustomEndpointKeys: () => useChatStore.getState().customEndpointKeys,
    onStep: (step) => {
      useChatStore.getState().patchAgentMeta({ step });
    },
    onCompact: (info) => {
      useChatStore.getState().patchAgentMeta({
        compactionNotice: { droppedCount: info.droppedCount, at: Date.now() },
      });
    },
    onFinishMeta: (info) => {
      useChatStore.getState().patchAgentMeta({ hitStepCap: info.hitStepCap });
    },
    onUsage: (delta) => {
      const cur = useChatStore.getState().agentMeta.tokens;
      useChatStore.getState().patchAgentMeta({
        tokens: {
          inputTokens: cur.inputTokens + delta.inputTokens,
          outputTokens: cur.outputTokens + delta.outputTokens,
          cachedInputTokens: cur.cachedInputTokens + delta.cachedInputTokens,
        },
        lastInputTokens: delta.lastInputTokens,
        lastCachedTokens: delta.lastCachedTokens,
      });
    },
  }) as unknown as ChatTransport<UIMessage>;

  const initialMessages = seedMessages.get(sessionId);
  seedMessages.delete(sessionId);

  return new Chat<UIMessage>({
    id: sessionId,
    transport,
    messages: initialMessages,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithApprovalResponses,
    onError: (e) => {
      useChatStore.getState().patchAgentMeta({
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
    },
  });
}

export function getOrCreateChat(sessionId: string): Chat<UIMessage> {
  const existing = chats.get(sessionId);
  if (existing) {
    touchChat(sessionId, existing);
    return existing;
  }
  const c = makeChat(sessionId);
  touchChat(sessionId, c);
  return c;
}

export async function sendMessage(text: string): Promise<boolean> {
  const state = useChatStore.getState();
  const sessionId = state.activeSessionId;
  if (!sessionId) return false;

  // TDSF 魔改 P0-3: 走 Sidecar 路径时跳过 Vercel SDK 的 API Key 检查
  // 原因: TDSF Sidecar 使用 Python 端自己配置的 LLM（.tdsf-data/llm_config.json），
  //       不依赖前端 Vercel SDK 的 provider key。若不跳过，用户未配置 OpenAI 等
  //       provider key 时 sendMessage 会返回 false，导致 TdsfAgentPanel 走
  //       focusInput 降级路径，用户输入无法到达 Python agent.invoke。
  //       参见 transport.ts:115 — tdsfAgentId 非 null 时走 runSidecarStream 分支。
  const tdsfAgentId = state.tdsfAgentId;
  if (!tdsfAgentId) {
    if (
      providerNeedsKey(getModel(state.selectedModelId as ModelId).provider) &&
      !getActiveProviderKey()
    )
      return false;
  }

  const c = getOrCreateChat(sessionId);
  await c.sendMessage({ text });
  return true;
}
