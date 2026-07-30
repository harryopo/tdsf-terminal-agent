import type { UIMessage } from "@ai-sdk/react";
import type { TdsfAgentId } from "../agents/registry";
import type { CustomEndpoint } from "../config";
import type { ToolContext } from "../tools/tools";
import { type AgentUsageDelta, runAgentStream } from "./agent";
import { formatAiError } from "./errors";
import type { CustomEndpointKeys, ProviderKeys } from "./keyring";
import { native } from "./native";
import {
  runSidecarStream,
  sidecarStreamToUIMessageStream,
} from "./sidecar-adapter";

const TDSF_MD_MAX_BYTES = 32 * 1024;
type MemoryCacheEntry = { content: string | null; mtime: number };
const projectMemoryCache = new Map<string, MemoryCacheEntry>();

async function readTdsfMd(
  workspaceRoot: string | null,
): Promise<string | null> {
  if (!workspaceRoot) return null;
  // TDSF 魔改: TERAX.md → TDSF.md
  const path = `${workspaceRoot.replace(/\/$/, "")}/TDSF.md`;
  const cached = projectMemoryCache.get(workspaceRoot);
  if (cached && Date.now() - cached.mtime < 30_000) return cached.content;
  try {
    const r = await native.readFile(path);
    if (r.kind !== "text") {
      projectMemoryCache.set(workspaceRoot, {
        content: null,
        mtime: Date.now(),
      });
      return null;
    }
    const content =
      r.content.length > TDSF_MD_MAX_BYTES
        ? r.content.slice(0, TDSF_MD_MAX_BYTES)
        : r.content;
    projectMemoryCache.set(workspaceRoot, { content, mtime: Date.now() });
    return content;
  } catch {
    projectMemoryCache.set(workspaceRoot, { content: null, mtime: Date.now() });
    return null;
  }
}

type LiveSnapshot = {
  cwd: string | null;
  terminalPrivate: boolean;
  workspaceRoot: string | null;
  activeFile: string | null;
};

type Deps = {
  getKeys: () => ProviderKeys;
  toolContext: ToolContext;
  getModelId: () => string;
  getCustomInstructions: () => string;
  getAgentPersona: () => { name: string; instructions: string } | null;
  getLive: () => LiveSnapshot;
  getLmstudioBaseURL?: () => string | undefined;
  getLmstudioModelId?: () => string | undefined;
  getMlxBaseURL?: () => string | undefined;
  getMlxModelId?: () => string | undefined;
  getOllamaBaseURL?: () => string | undefined;
  getOllamaModelId?: () => string | undefined;
  getOpenaiCompatibleBaseURL?: () => string | undefined;
  getOpenaiCompatibleModelId?: () => string | undefined;
  getOpenaiCompatibleContextLimit?: () => number | undefined;
  getOpenrouterModelId?: () => string | undefined;
  getCustomEndpoints?: () => readonly CustomEndpoint[];
  getCustomEndpointKeys?: () => CustomEndpointKeys;
  onStep?: (step: string | null) => void;
  onUsage?: (delta: AgentUsageDelta) => void;
  onCompact?: (info: { droppedCount: number }) => void;
  onFinishMeta?: (info: { hitStepCap: boolean; finishReason: string }) => void;
  getPlanMode?: () => boolean;
  /**
   * 读取当前激活的 TDSF agent id（来自 chatStore.tdsfAgentId）
   *
   * 返回值决定 run 函数的路由分支:
   *   - 非 null → 走 runSidecarStream（Python Sidecar 路径）
   *   - null / undefined → 走 runAgentStream（Vercel AI SDK fallback 路径）
   *
   * 未注入此依赖时（旧调用方）默认走 Vercel SDK 路径，保持向后兼容。
   */
  getTdsfAgentId?: () => TdsfAgentId | null;
  /**
   * mood 变更回调（sidecar 路径专用，用于更新 agentMeta.status）
   *
   * Vercel SDK 路径不需要此回调（status 由 streamText 内部状态推断）
   */
  onMood?: (mood: string) => void;
};

type SendOptions = {
  messages: UIMessage[];
  abortSignal?: AbortSignal;
  [k: string]: unknown;
};

export function createContextAwareTransport(deps: Deps) {
  const run = async (options: SendOptions) => {
    const live = deps.getLive();
    const projectMemory = await readTdsfMd(live.workspaceRoot);
    const envBlock = formatEnvBlock(live);
    const messagesForRun = envBlock
      ? injectEnvIntoLastUser(options.messages, envBlock)
      : options.messages;

    // === TDSF 阶段3: Sidecar 路由分支 =========================================
    //
    // 当 chatStore.tdsfAgentId 非 null 时走 Python Sidecar 路径:
    //   1. 从 messages 取最后一条 user text 作为 input
    //   2. 调 runSidecarStream → invoke('ipc_invoke', {method:'agent.invoke'})
    //   3. 把 AsyncIterable<SidecarStreamPart> 转换为 ReadableStream<UIMessageChunk>
    //   4. 返回给 useChat 消费（与 Vercel SDK 路径返回值结构一致）
    //
    // 否则走原 Vercel AI SDK 路径（runAgentStream），保持向后兼容。
    const tdsfAgent = deps.getTdsfAgentId?.() ?? null;
    if (tdsfAgent) {
      // v2026-07-30 P1-b 修复: 从 messagesForRun（已注入 <env> 块）取 input，
      // 而非 options.messages（裸用户文本）。这样 Python agent.invoke 收到的
      // input 字段会包含 <env>workspace_root/active_terminal_cwd/active_file/
      // active_terminal_mode</env> 前缀，main_agent.plan_task 的关键词路由
      // 能感知到当前终端上下文（之前 input 是裸文本，Python agent 看不到 cwd）。
      const input = extractLastUserText(messagesForRun);
      const sidecarStream = runSidecarStream({
        agentId: tdsfAgent,
        messages: messagesForRun,
        input,
        abortSignal: options.abortSignal,
        onStep: deps.onStep,
        onMood: deps.onMood,
        onUsage: deps.onUsage
          ? (delta) =>
              deps.onUsage?.({
                inputTokens: delta.inputTokens,
                outputTokens: delta.outputTokens,
                cachedInputTokens: 0,
                lastInputTokens: delta.inputTokens,
                lastCachedTokens: 0,
              })
          : undefined,
      });
      return sidecarStreamToUIMessageStream(sidecarStream, {
        originalMessages: options.messages,
        onError: formatAiError,
      });
    }
    // === /Sidecar 路由分支 ===================================================

    const result = await runAgentStream({
      keys: deps.getKeys(),
      modelId: deps.getModelId(),
      customInstructions: deps.getCustomInstructions(),
      agentPersona: deps.getAgentPersona(),
      toolContext: deps.toolContext,
      onStep: deps.onStep,
      onUsage: deps.onUsage,
      onCompact: deps.onCompact,
      onFinishMeta: deps.onFinishMeta,
      lmstudioBaseURL: deps.getLmstudioBaseURL?.(),
      lmstudioModelId: deps.getLmstudioModelId?.(),
      mlxBaseURL: deps.getMlxBaseURL?.(),
      mlxModelId: deps.getMlxModelId?.(),
      ollamaBaseURL: deps.getOllamaBaseURL?.(),
      ollamaModelId: deps.getOllamaModelId?.(),
      openaiCompatibleBaseURL: deps.getOpenaiCompatibleBaseURL?.(),
      openaiCompatibleModelId: deps.getOpenaiCompatibleModelId?.(),
      openaiCompatibleContextLimit: deps.getOpenaiCompatibleContextLimit?.(),
      openrouterModelId: deps.getOpenrouterModelId?.(),
      customEndpoints: deps.getCustomEndpoints?.(),
      customEndpointKeys: deps.getCustomEndpointKeys?.(),
      planMode: deps.getPlanMode?.(),
      projectMemory,
      uiMessages: messagesForRun,
      abortSignal: options.abortSignal,
    });
    return result.toUIMessageStream({
      originalMessages: options.messages,
      onError: formatAiError,
    });
  };

  return {
    sendMessages: run,
    async reconnectToStream(): Promise<null> {
      return null;
    },
  };
}

/**
 * 从 messages 数组提取最后一条 user 消息的文本内容
 *
 * 用于 Sidecar 路径: 把最后一条 user text 作为 input 传给 Python agent.invoke，
 * 避免 Python 端再解析 UIMessage 结构。
 *
 * 实现与 injectEnvIntoLastUser 一致的遍历逻辑（从后往前找 role=user）。
 */
function extractLastUserText(messages: UIMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const parts = m.parts as ReadonlyArray<{ type: string; text?: string }>;
    for (const p of parts) {
      if (p.type === "text" && typeof p.text === "string") {
        return p.text;
      }
    }
  }
  return "";
}

function injectEnvIntoLastUser(
  messages: UIMessage[],
  envBlock: string,
): UIMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    const parts = m.parts as ReadonlyArray<{ type: string; text?: string }>;
    let textIdx = -1;
    for (let j = 0; j < parts.length; j++) {
      if (parts[j].type === "text") {
        textIdx = j;
        break;
      }
    }
    const nextParts =
      textIdx === -1
        ? [{ type: "text", text: envBlock }, ...parts]
        : parts.map((p, idx) =>
            idx === textIdx
              ? { ...p, text: `${envBlock}\n\n${p.text ?? ""}` }
              : p,
          );
    const out = messages.slice();
    out[i] = { ...m, parts: nextParts } as UIMessage;
    return out;
  }
  return messages;
}

// TDSF 修复 2026-07-30 (Bug 3): 导出 formatEnvBlock 供 CDP 调试验证 <env> 注入
// 之前未 export, App.tsx 的 __TDSF_DBG__ 无法暴露此函数, CDP 没法验证
// Python agent 收到的 input 是否含 <env> 块
export function formatEnvBlock(live: LiveSnapshot): string | null {
  const lines: string[] = [];
  if (live.workspaceRoot) lines.push(`workspace_root: ${live.workspaceRoot}`);
  if (live.cwd) lines.push(`active_terminal_cwd: ${live.cwd}`);
  if (live.activeFile) lines.push(`active_file: ${live.activeFile}`);
  if (live.terminalPrivate) lines.push("active_terminal_mode: private");
  if (lines.length === 0) return null;
  return `<env>\n${lines.join("\n")}\n</env>`;
}

export const CONTEXT_BLOCK_RE =
  /^<terminal-context[^>]*>[\s\S]*?<\/terminal-context>\n*/;

export function stripContextBlock(text: string): string {
  return text.replace(CONTEXT_BLOCK_RE, "");
}
