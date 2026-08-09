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
  /**
   * 活跃 SSH 会话的 Rust session_id (u32)。
   *
   * TDSF 魔改 2026-07-30: 从 Live.getSshRustSessionId() 取值，
   * 注入到 state.live.sshSessionId，供 Python 侧 Strands 运维工具
   * 通过 RustBridge 调 ssh_command / sftp_* 命令时使用。
   * null 表示当前无活跃 SSH 会话（本地终端模式）。
   *
   * 注意：此字段是内部实现细节（Rust u32），绝不暴露给 LLM/用户。
   * 见 sshConnection（友好格式 user@host，面向 LLM 的 <env> 块）。
   */
  sshSessionId: number | null;
  /**
   * 活跃 SSH 会话的友好标识（如 "root@192.168.45.130"）。
   *
   * TDSF 魔改 (2026-08-09): 用户反馈 agent 向用户暴露 "SSH 会话 #15"
   * （即 sshSessionId 数字）——这是实现细节，不应让最终用户看到。
   * 现改为 <env> 块注入 friendly 的 connected_to 字段，让 LLM 自然表达
   * "你已连接到 root@192.168.45.130"，而不是泄露内部 id。
   * null 表示无 SSH 会话。
   */
  sshConnection: string | null;
  /**
   * 活跃终端的 scrollback 尾部摘要（已脱敏）。
   *
   * TDSF 魔改 (2026-08-09): 用户反馈"agent 看不到终端，不知道我在干啥"。
   * 根因：Python Sidecar 路径的 <env> 块只注入元数据（cwd/sshSessionId），
   * 没有终端屏幕内容 → agent 无上下文感知。
   * 现在每轮自动注入终端尾部输出（截取 N 行），让 agent 收到消息时就能看到
   * 用户最近在终端做了什么，无需额外工具调用。
   * null = 无活跃终端 / 隐私模式。
   */
  terminalOutput: string | null;
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
    // TDSF 魔改 (2026-08-09): 自动注入终端尾部输出到每轮对话，
    // 让 agent 无需额外工具调用就能感知用户在终端做了什么。
    // 双轨受益：Python Sidecar（<env>+<terminal-context> 注入 input）+
    // Vercel SDK（注入 messagesForRun 最后一条 user message）。
    const terminalBlock = formatTerminalContextBlock(live);
    const contextBlock = [envBlock, terminalBlock]
      .filter(Boolean)
      .join("\n\n");
    const messagesForRun = contextBlock
      ? injectEnvIntoLastUser(options.messages, contextBlock)
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
      // TDSF 修复 2026-07-31 (P2): 长对话消息裁剪
      // 完整 messages 数组可能几十条，JSON 序列化后几 MB，导致 sidecar 传输慢 +
      // LLM token 超限 + 长对话"卡住不回复"。保留最近 20 条，避免 token 爆炸。
      // input 已从完整 messages 提取最后一条 user text，裁剪不影响 input。
      const trimmedMessages = trimMessagesForSidecar(messagesForRun);
      // TDSF 魔改 2026-07-30 (Bug 5): 把 live 上下文传给 Python agent
      // SidecarStreamOptions.live 必填，Python 侧 _build_tool_context / _build_prompt
      // 从 state.live 取 sshSessionId / cwd / activeFile 等
      const sidecarStream = runSidecarStream({
        agentId: tdsfAgent,
        messages: trimmedMessages,
        input,
        live,
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

/**
 * TDSF 修复 2026-07-31 (P2): 长对话消息裁剪
 *
 * 问题：长对话（几十轮）时，完整 messages 数组通过 JSON-RPC 传给 Python
 * sidecar，JSON 序列化后可能几 MB，导致：
 *   1. JSON-RPC 传输慢
 *   2. Python 端 json.loads 慢
 *   3. LLM token 超限（多模型上下文窗口 8K-32K tokens）
 *   4. 长对话"卡住不回复"（Python 端处理超时或 LLM 拒绝）
 *
 * 裁剪策略：保留最近 N 条消息（默认 20），避免长对话 token 爆炸。
 *   - 消息总数 <= maxMessages → 不裁剪
 *   - 消息总数 > maxMessages → 取最后 maxMessages 条
 *   - 保留最后一条 user 消息（extractLastUserText 依赖它）
 *
 * 注意：这里只裁剪传给 sidecar 的 messages（用于 Python agent 上下文），
 * 不影响 input 字段（已从完整 messages 提取最后一条 user text）。
 *
 * @param messages 完整对话历史
 * @param maxMessages 最大保留条数（默认 20）
 * @returns 裁剪后的 messages（如果是原数组的子数组，引用不变）
 */
function trimMessagesForSidecar(
  messages: UIMessage[],
  maxMessages: number = 20,
): UIMessage[] {
  if (messages.length <= maxMessages) return messages;
  // 取最后 maxMessages 条（保留最近的对话上下文）
  return messages.slice(messages.length - maxMessages);
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
  // TDSF 魔改 (2026-08-09): 不再向 <env> 块注入 ssh_session_id 数字。
  // 原实现 (2026-07-30) 把 Rust 内部 session u32 注入到 env 块，
  // LLM 把它当成"SSH 会话 #15"直接告诉用户——内部实现细节泄露。
  // 现改为 friendly 的 connected_to 字段（user@host），让 LLM 自然表达。
  // 真正传给 Rust 的 sessionId 通过 state.live.sshSessionId 单独走（见 runSidecarStream）。
  if (live.sshConnection) {
    lines.push(`connected_to: ${live.sshConnection}`);
  }
  if (lines.length === 0) return null;
  return `<env>\n${lines.join("\n")}\n</env>`;
}

/**
 * 构建终端尾部输出上下文块，注入到每轮对话让 agent 自动感知终端状态。
 *
 * TDSF 魔改 (2026-08-09): 用户反馈"agent 看不到终端"。
 * 上游 terax 的 <terminal-context> 标签已有 strip 正则（CONTEXT_BLOCK_RE），
 * 说明原设计就有终端上下文注入的预留位——现在补全实现。
 *
 * 设计：
 * - 截取尾部 MAX_LINES 行（避免 token 爆炸，30 行约 500-1500 tokens）
 * - 隐私模式不注入（terminalPrivate 已在 getTerminalContext 中过滤）
 * - 空终端不注入（返回 null）
 * - 已脱敏（getTerminalContext 内部调 redactSensitive）
 */
const TERMINAL_CONTEXT_MAX_LINES = 30;

export function formatTerminalContextBlock(live: LiveSnapshot): string | null {
  if (!live.terminalOutput) return null;
  const lines = live.terminalOutput.split("\n");
  const tail =
    lines.length > TERMINAL_CONTEXT_MAX_LINES
      ? lines.slice(-TERMINAL_CONTEXT_MAX_LINES).join("\n")
      : live.terminalOutput;
  return `<terminal-context>\n${tail}\n</terminal-context>`;
}

export const CONTEXT_BLOCK_RE =
  /^<terminal-context[^>]*>[\s\S]*?<\/terminal-context>\n*/;

export function stripContextBlock(text: string): string {
  return text.replace(CONTEXT_BLOCK_RE, "");
}
