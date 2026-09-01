import { usePreferencesStore } from "@/modules/settings/preferences";
import { isSessionConnected, useSshStore } from "@/modules/ssh-explorer/sshStore";
import { Chat, type UIMessage } from "@ai-sdk/react";
import {
  type ChatTransport,
  lastAssistantMessageIsCompleteWithApprovalResponses,
} from "ai";
import { getModel, type ModelId, providerNeedsKey } from "../config";
import { toSidecarMode } from "../agents/registry";
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
      // A1 多服务器隔离 (2026-09-01, 用户钦定): 按当前会话绑定的 scope
      // 解析环境，不再全局跟随"当前活跃终端"——类比 AI 编程 agent 的工作
      // 目录隔离。本地对话不再看到 SSH 服务器；绑定 A 服务器的对话切到
      // B 服务器终端后上下文不串。老会话（scope 缺省）保持原全局行为。
      const { activeSessionId, sessions } = useChatStore.getState();
      const scope =
        sessions.find((s) => s.id === activeSessionId)?.scope ?? null;

      // B1 (2026-09-01, 用户实测): 欢迎页（无任何终端会话）不得把
      // explorerRoot/launchCwd/home 回退链的默认路径当"本地工作区"上报
      // ——agent 因此误答"当前在本地工作区"而不引导建工作区/连服务器。
      const activeTerminal = live.getActiveTerminalSession?.() ?? "none";

      // === SSH scope：环境只看绑定的那台服务器 ===
      if (scope?.kind === "ssh") {
        const sshState = useSshStore.getState();
        const bound = sshState.sessions.find(
          (s) =>
            s.params.host === scope.host &&
            s.params.user === scope.user &&
            (s.params.port ?? 22) === scope.port,
        );
        const connected = bound && isSessionConnected(bound) ? bound : null;
        // 终端上下文只在绑定会话恰为全局活跃 SSH 会话时注入
        // （隔离：其他服务器的 scrollback 不进入本对话）
        const activeSshId = live.getSshRustSessionId();
        const boundRustId = connected ? connected.rustSessionId : null;
        const terminalOutput =
          boundRustId !== null && activeSshId !== null && boundRustId === activeSshId
            ? live.getTerminalContext()
            : null;
        return {
          // 远程 scope 无本地工作区——python_run fail-closed 拒绝（符合预期）
          cwd: null,
          terminalPrivate: false,
          workspaceRoot: null,
          activeFile: live.getActiveFile(),
          // Rust u32 session id（SshSessionInfo.id 是前端 uuid，勿混用）
          sshSessionId: boundRustId,
          sshConnection: connected
            ? `${connected.params.user}@${connected.params.host}`
            : null,
          // 绑定服务器提示（formatEnvBlock 渲染 conversation_server 行）：
          // 未连接时 agent 仍知道本对话属于哪台服务器，可引导重连
          conversationServer: {
            user: scope.user,
            host: scope.host,
            connected: Boolean(connected),
          },
          terminalOutput,
          terminalSession: connected ? "ssh" : "none",
          autoExecuteInTerminal: useChatStore.getState().autoExecuteInTerminal,
          ...toSidecarMode(useChatStore.getState().agentMode),
        };
      }

      const isLocalScope = scope?.kind === "local";
      const noTerminal = activeTerminal === "none";
      const localActive = activeTerminal === "local";
      return {
        // B1: 无终端（欢迎页）→ cwd/workspace 置 null；local scope 只认
        // 本地终端（SSH 活跃也不算本对话的终端）
        cwd:
          localActive || (!isLocalScope && !noTerminal)
            ? live.getCwd()
            : null,
        terminalPrivate: live.isActiveTerminalPrivate(),
        workspaceRoot:
          localActive || (!isLocalScope && !noTerminal)
            ? live.getWorkspaceRoot()
            : null,
        activeFile: live.getActiveFile(),
        // A1: 本地 scope 的对话绝不操作 SSH（即便全局活跃着 SSH 会话）
        sshSessionId: isLocalScope ? null : live.getSshRustSessionId(),
        sshConnection: isLocalScope
          ? null
          : (() => {
              // TDSF 魔改 (2026-08-09): 友好的 SSH 连接标识（user@host），
              // 从 sshStore 取活跃 connected 会话的 params.host/user 组装。
              const sshState = useSshStore.getState();
              const active = sshState.sessions.find(
                (s) => s.id === sshState.activeSessionId,
              );
              const session =
                active && isSessionConnected(active)
                  ? active
                  : sshState.sessions.find((s) => isSessionConnected(s));
              if (!session) return null;
              const { user, host } = session.params;
              return `${user}@${host}`;
            })(),
        conversationServer: null,
        terminalOutput: isLocalScope
          ? localActive
            ? live.getTerminalContext()
            : null
          : live.getTerminalContext(),
        // TDSF 2026-08-31 (问题1修复): 活动终端会话权威信号（"ssh"|"local"|"none"），
        // transport 据此判定 connection_mode；无终端时标 none（非 local），
        // 防止"注入了默认 workspace cwd"被误判为"本地终端已打开"。
        // 注意：getter 返回 null 必须显式转 "none" 再透传——Python 侧
        // terminalSession 缺省（undefined）才走旧调用方启发式回退，
        // null（明确的"无终端"）若与缺省混同，无终端场景仍会误报 local。
        terminalSession: isLocalScope
          ? localActive
            ? "local"
            : "none"
          : activeTerminal,
        // TDSF 魔改 (2026-08-09): 终端执行模式开关传给 Python sidecar
        autoExecuteInTerminal: useChatStore.getState().autoExecuteInTerminal,
        // v3.1 三模式信任体系 + 教学皮肤：随每轮 invoke 的 state.live 下发
        // sidecar（adapter.py 读 state.live.agentMode / state.live.teach，
        // 缺省 confirm）。模式即时生效：切换后下一条消息即用新模式。
        // v3.1.3 四档化：teach 是前端第四档（= observe + teach 预置组合），
        // toSidecarMode 展开为 sidecar 认识的三模式 + teach 布尔。
        ...toSidecarMode(useChatStore.getState().agentMode),
      };
    },
    getPlanMode: () => usePlanStore.getState().active,
    // TDSF 阶段3: 注入当前 TDSF agent id，让 transport 路由到 Sidecar 路径
    getTdsfAgentId: () => useChatStore.getState().tdsfAgentId,
    // TDSF 阶段3: mood 变化时更新 agentMeta.status（驱动 UI mood 表情）
    onMood: (mood) => {
      const status = moodToStatus(mood);
      if (status) {
        // T2 循环护栏: 新一轮 thinking 开始时清空上一轮进度
        // （防旧值闪烁），终态（idle/error）一并归位
        useChatStore.getState().patchAgentMeta({
          status,
          ...(status === "thinking" || status === "idle" || status === "error"
            ? { loopProgress: null }
            : {}),
        });
      }
    },
    // T2 循环护栏 (2026-08-31): 循环进度（第 N 轮 / 已用工具 M）——
    // sidecar:loop_progress 事件驱动 AgentStatusPill 进度显示
    onLoopProgress: (progress) => {
      useChatStore.getState().patchAgentMeta({ loopProgress: progress });
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
