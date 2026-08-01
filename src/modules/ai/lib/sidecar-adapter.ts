// TDSF 阶段3: Sidecar 适配层
// =============================================================================
//
// 本模块是前端 AI 对话流与 Python Sidecar JSON-RPC 之间的协议适配层。
//
// 设计目标:
//   1. 暴露与 Vercel AI SDK 兼容的 `runSidecarStream(opts): AsyncIterable<...>`
//      接口，让 transport.ts 能像调用 `runAgentStream` 一样切换到 Sidecar 路径
//   2. 把 Python 端 `agent.invoke` 同步返回的 dict（{thinking, output, mood, tokens}）
//      转换为流式 UIMessageStreamPart（text-delta / finish / error），让 useChat
//      能像消费 Vercel SDK 流一样逐 chunk 渲染
//   3. sidecar 不可用时（IPC 失败 / 超时）降级到 mock 响应（仅开发模式），
//      不阻塞 UI；生产模式 yield error，由 useChat 显示错误
//   4. 监听 Tauri event `sidecar:mood_change` / `sidecar:tool_call`
//      接收 Python 端 event_bus 推送的流式更新（mood/step）
//
// 协议链路:
//   前端 invoke('ipc_invoke', {method:'agent.invoke', params:{name, state}})
//     → Rust ipc_invoke (src-tauri/src/modules/ipc.rs:278)
//     → IPCClient.invoke → stdio JSON-RPC → Python MethodDispatcher
//     → agents.__init__._rpc_agent_invoke → invoke_agent(name, state)
//     → BaseAgent.invoke (PAOR 监督循环) → 返回 dict
//     → 前端拿到 dict 后切片流式 yield（模拟真实流式输出）
//
// 同时 Python 端通过 event_bus 推送 mood_change / agent_message 事件 →
//   Rust sidecar.rs reader_task 接收 notification → emit Tauri event →
//   本模块 listen 接收，回调 onMood / onStep（不阻塞主流程）。

import type { UIMessage } from "@ai-sdk/react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { UIMessageChunk } from "ai";
import { TDSF_AGENTS, type TdsfAgentId } from "../agents/registry";

// === 常量 ====================================================================

/**
 * Sidecar 调用超时（60s）。
 *
 * TDSF 修复 2026-07-31 (P2): 从 30s 提升到 60s。
 * 30s 超时对 Strands 后端 agentic loop（多轮工具调用 + LLM 推理）太紧，
 * 导致长对话/复杂任务频繁超时。60s 给 Strands Agent 足够时间完成
 * 3-5 轮工具调用的 agentic loop。
 */
const SIDECAR_TIMEOUT_MS = 60_000;

/**
 * 读取 Sidecar 调用超时（ms）。
 *
 * P0-3 (2026-08-01): 超时可配置——localStorage `tdsf.sidecarTimeoutMs`
 * 覆盖默认 60s（夹取 10s-600s，防误配）。同时把值传给 Rust 侧
 * ipc_invoke 的 timeoutMs（Rust 默认 60s，长任务可放宽）。
 */
const SIDECAR_TIMEOUT_MIN_MS = 10_000;
const SIDECAR_TIMEOUT_MAX_MS = 600_000;
const SIDECAR_TIMEOUT_STORAGE_KEY = "tdsf.sidecarTimeoutMs";

export function getSidecarTimeoutMs(): number {
  if (typeof localStorage === "undefined") return SIDECAR_TIMEOUT_MS;
  try {
    const raw = localStorage.getItem(SIDECAR_TIMEOUT_STORAGE_KEY);
    if (!raw) return SIDECAR_TIMEOUT_MS;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return SIDECAR_TIMEOUT_MS;
    return Math.min(SIDECAR_TIMEOUT_MAX_MS, Math.max(SIDECAR_TIMEOUT_MIN_MS, parsed));
  } catch {
    return SIDECAR_TIMEOUT_MS;
  }
}

/**
 * 构建结构化 Sidecar 错误提示（P0-4）。
 *
 * 按错误特征区分文案与行动建议：超时 / Sidecar 未运行 / Strands 降级 /
 * LLM 配置 / 其他。替代旧的静态模板（三种可能原因堆在一起，排障成本高）。
 *
 * @param rawError 原始错误文本（invokeError 或 degraded_message）
 * @param pythonName 调用的后端 agent 名
 * @param isDegraded 是否来自后端 degraded 标志
 */
export function buildSidecarErrorHint(
  rawError: string,
  pythonName: string,
  isDegraded = false,
): string {
  if (isDegraded) {
    return [
      "AI 后端降级运行（当前无法完成本次调用）。",
      rawError ? `详情：${rawError}` : "",
      "",
      "建议：1) 检查 AI 模型配置（设置 → AI 模型）2) 检查 Strands 依赖安装",
    ]
      .filter(Boolean)
      .join("\n");
  }

  const lower = rawError.toLowerCase();
  if (lower.includes("超时") || lower.includes("timeout")) {
    return [
      `AI 任务超时未完成：${rawError}`,
      "",
      "建议：1) 复杂任务可到设置调大 AI 调用超时 2) 简化问题描述后重试",
    ].join("\n");
  }
  if (
    lower.includes("not running") ||
    lower.includes("not_running") ||
    lower.includes("sidecar")
  ) {
    return [
      `AI Sidecar 未就绪：${rawError}`,
      "",
      "建议：重启应用后重试；若反复出现，查看 sidecar 日志",
    ].join("\n");
  }
  if (lower.includes("llm") || lower.includes("api key") || lower.includes("model")) {
    return [
      `AI 模型调用失败：${rawError}`,
      "",
      "建议：到设置 → AI 模型检查 API Key 与模型配置",
    ].join("\n");
  }
  return [
    `Sidecar Agent 调用失败：${rawError}`,
    "",
    `当前调用: ${pythonName}；建议检查 sidecar 日志定位原因`,
  ].join("\n");
}

/**
 * 兜底切片流式（仅 LangGraph 后端 / 无事件推送时使用）的 chunk 大小（字符数）。
 *
 * TDSF 修复 2026-07-31 (P1): 从 24 提升到 96。
 * P0-2 (2026-08-01) 说明：Strands 后端（默认主路径）已通过
 * `sidecar:agent_message` 事件实现**真流式**（LLM data 增量实时推送，
 * 见 runSidecarStream 第 3 步消费循环），streamText 仅作兜底——当
 * invokeResult 返回了 observation 但事件未推送 output 时（如 LangGraph
 * 后端），按块切片让 UI 逐块渲染。
 * 24 字符/chunk 对长文本（5000+ 字符）会产生 200+ chunks，
 * 每个 chunk 走一次 useChat 的 state 更新 + React 重渲染，
 * 累积延迟明显（5000 字符 = 200 chunks × 8ms = 1.6s 额外延迟）。
 * 96 字符/chunk 减少 75% 的 chunk 数，配合 delay=0 让兜底切片接近实时。
 */
const STREAM_CHUNK_SIZE = 96;

/**
 * 兜底切片流式的 chunk 间隔（ms，让 useChat 能逐 chunk 渲染）。
 *
 * TDSF 修复 2026-07-31 (P1): 从 8ms 降为 0ms。
 * 8ms 延迟累积起来对长文本很显著（200 chunks × 8ms = 1.6s）。
 * 0ms 仍会通过 `await new Promise(r => setTimeout(r, 0))` 让出事件循环
 * （让 React 有机会渲染当前 chunk），但不引入额外延迟。
 */
const STREAM_CHUNK_DELAY_MS = 0;

/**
 * invoke 完成后等待 in-flight `sidecar:tool_call` / `sidecar:agent_message`
 * 事件 drain 的窗口（ms）。
 *
 * agent.invoke 返回即 PAOR 循环结束，事件应已发完，但 Tauri event
 * 跨进程传输有微小延迟，留一个短窗口避免漏掉最后一个事件。
 */
const TOOL_DRAIN_MS = 30;

/** Tauri event 名（与 src-tauri/src/modules/ipc.rs:329-339 对齐） */
const EVENT_MOOD_CHANGE = "sidecar:mood_change";
const EVENT_TOOL_CALL = "sidecar:tool_call";
const EVENT_AGENT_SWITCH = "sidecar:agent_switch"; // v2026-07-29: 主 Agent 路由子 Agent 事件

// ============================================================================
// 事件 payload 解包
// ============================================================================

/**
 * 解包 Python event_bus 发送的事件 payload。
 *
 * Python 侧通过 JSON-RPC notification 推送的是 Event.to_dict()：
 *   { event_type, payload, session_id, timestamp, source }
 * Rust sidecar.rs 直接把这个 dict 作为 params 转发给前端，
 * 因此前端 `e.payload` 是外层 Event dict，真正的业务数据在 `e.payload.payload`。
 *
 * 本 helper 统一处理两种形态（已包装 / 裸 payload），避免每个 listener 重复解包。
 */
function unwrapEventPayload<T>(payload: unknown): T | undefined {
  if (payload == null) return undefined;
  if (typeof payload !== "object") return payload as T;
  const obj = payload as Record<string, unknown>;
  // Python Event.to_dict 一定有 event_type + payload 字段
  if (
    "event_type" in obj &&
    typeof obj.event_type === "string" &&
    "payload" in obj
  ) {
    return obj.payload as T;
  }
  return payload as T;
}
/**
 * TDSF 修复 2026-07-31 (P1): 新增 agent_message 事件订阅。
 *
 * Python 端 Strands 后端 TdsfStrandsCallbackHandler 把 Strands 的 `data`
 * 事件（LLM 文本增量）通过 event_bus.emit_agent_message 实时推送，
 * 前端订阅此事件实现**真正流式输出**（替代伪流式切片）。
 *
 * 同时 base.py BaseAgent._emit_message 在 plan/act/observe 各阶段推送
 * thinking 类型消息，前端订阅后实现**深度思考 UI**（Reasoning 折叠段）。
 */
const EVENT_AGENT_MESSAGE = "sidecar:agent_message";

// === 类型 ====================================================================

/** `runSidecarStream` 调用参数 */
export interface SidecarStreamOptions {
  /** TDSF agent id（前端业务 id，会被映射到 Python AGENT_REGISTRY key） */
  agentId: TdsfAgentId;
  /** 完整对话历史（含 parts，传给 Python 端做上下文） */
  messages: UIMessage[];
  /** 最后一条 user 消息文本（由 transport 提取，避免 Python 端再解析） */
  input: string;
  /**
   * 终端运行时上下文快照（cwd / activeFile / workspaceRoot / sshSessionId 等）。
   *
   * TDSF 魔改 2026-07-30 (Bug 5): 通过 state.live 传给 Python agent，
   * Strands 适配层 StrandsAgentAdapter._build_tool_context() 从 state.live
   * 提取 sshSessionId 填充 ToolContext.ssh_session_id，运维工具据此调
   * ssh_command / sftp_* 命令。Python 端 _build_prompt 也从此处读 cwd /
   * activeFile 注入 <live_context> 块给 LLM。
   *
   * 字段说明:
   *   - cwd:             当前终端工作目录（OSC seq 捕获）
   *   - terminalPrivate: 隐私模式标记（true 时不发送终端上下文给 LLM）
   *   - workspaceRoot:   工作区根目录（资源管理器根）
   *   - activeFile:      当前激活的编辑器文件路径
   *   - sshSessionId:    活跃 SSH 会话的 Rust session_id (u32)，null 表示无 SSH 会话
   */
  live: {
    cwd: string | null;
    terminalPrivate: boolean;
    workspaceRoot: string | null;
    activeFile: string | null;
    sshSessionId: number | null;
  };
  /** 中断信号（与 useChat 的 abortSignal 联动） */
  abortSignal?: AbortSignal;
  /** 步骤变更回调（如 "Thinking" / "Streaming" / null） */
  onStep?: (step: string | null) => void;
  /** mood 变更回调（如 "thinking" / "streaming"） */
  onMood?: (mood: string) => void;
  /** token 使用量增量回调 */
  onUsage?: (delta: { inputTokens: number; outputTokens: number }) => void;
}

/**
 * Sidecar 内部流式输出 part（简化版协议，便于 yield）
 *
 * 与 ai 包的 UIMessageChunk 不同——这里只是模块内部协议，
 * 由 `sidecarStreamToUIMessageStream` 转换为标准 UIMessageChunk
 * 后才喂给 useChat。
 */
export type SidecarStreamPart =
  | { type: "text-delta"; id: string; delta: string }
  | { type: "reasoning-delta"; id: string; delta: string }
  | {
      type: "tool-input";
      toolCallId: string;
      toolName: string;
      input: unknown;
    }
  | {
      type: "tool-output";
      toolCallId: string;
      toolName: string;
      output: unknown;
      isError: boolean;
    }
  | { type: "finish"; id: string }
  | { type: "error"; error: string };

/**
 * Python `agent.invoke` 返回值结构（BaseAgent.invoke 的 PAOR 输出）
 *
 * 字段都是 optional——不同 Agent 可能不返回 thinking / mood / tokens。
 * 实际字段由 agents/base.py BaseAgent.invoke 决定。
 *
 * TDSF 魔改: 字段对齐 Python 实际返回值
 * - Python BaseAgent.invoke() 通过 AgentResult.to_state_update() 返回 `observation`（不是 `output`）
 * - TeachAgent.reflect_on_result() 额外返回 `teaching_content`（结构化教学内容）
 * - 前端为兼容旧测试与未来扩展，两个字段都接受：优先 observation，回退 output
 */
interface AgentInvokeResult {
  /** Agent 内部思考过程（可选，作为 reasoning 显示） */
  thinking?: string;
  /**
   * Agent 最终输出（必填，作为 assistant message 文本）
   *
   * TDSF 魔改: Python 端 BaseAgent.invoke() 实际返回的字段名是 `observation`
   * （见 agents/base.py AgentResult.to_state_update()）。
   * 前端优先读 observation，回退到 output 以兼容旧 mock 测试。
   */
  observation?: string;
  /** 兼容字段：部分旧测试与早期实现使用 output（同 observation 语义） */
  output?: string;
  /**
   * TeachAgent 专属：结构化教学内容（教程 + 知识卡 + 学习路径）
   *
   * 由 agents/teach_agent.py TeachAgent.reflect_on_result() 返回，
   * BaseAgent.invoke() 通过 extra_update 合并到状态更新中传给前端。
   * 前端在 observation/output 之后追加展示，确保教学内容不丢失。
   */
  teaching_content?: string;
  /** Agent 心情标识（如 "thinking" / "streaming" / "done"） */
  mood?: string;
  /** token 使用量 */
  tokens?: { input?: number; output?: number };
}

/**
 * `sidecar:tool_call` 事件 payload（与 Python event_bus.emit_tool_call 对齐）
 *
 * event_bus.py:emit_tool_call 发布结构:
 *   { tool_name, params, status: "started"|"completed"|"error", result? }
 * 每个工具调用发两次：started（带 params）+ completed/error（带 result）。
 * 前端据此配对成 tool-input（started）→ tool-output（completed/error）part。
 */
interface ToolCallPayload {
  tool_name?: string;
  params?: unknown;
  status?: string;
  result?: unknown;
}

/**
 * `sidecar:agent_message` 事件 payload（与 Python event_bus.emit_agent_message 对齐）
 *
 * TDSF 修复 2026-07-31 (P1): 新增。
 *
 * event_bus.py:emit_agent_message 发布结构:
 *   { content, type, agent, [tool], [params], ... }
 *
 * type 字段语义:
 *   - "thinking": Agent 思考过程（plan/act/observe 各阶段）→ 前端 reasoning-delta
 *   - "output":   LLM 文本增量（Strands callback_handler data 事件）→ 前端 text-delta
 *   - "tool_call":工具调用描述（已被 sidecar:tool_call 覆盖，这里忽略）
 *   - "working":  工作中状态（已被 sidecar:mood_change 覆盖，这里忽略）
 *
 * Strands 后端 TdsfStrandsCallbackHandler._emit_agent_message 把 LLM `data`
 * 事件（文本增量）以 type="output" 推送，前端订阅后实现真正流式输出。
 * BaseAgent._emit_message 在 plan 阶段推送 type="thinking"，前端订阅后
 * 实现深度思考 UI（Reasoning 折叠段）。
 */
interface AgentMessagePayload {
  content?: string;
  type?: string; // "thinking" | "output" | "tool_call" | "working"
  message_type?: string; // 兼容旧字段名（event_bus 早期使用 message_type）
  agent?: string;
  [k: string]: unknown;
}

// === 内部工具函数 ============================================================

/**
 * 检测当前是否为开发模式
 *
 * 注意：vitest 中 `import.meta.env.DEV` 恒为 `true`，且 `vi.stubEnv("DEV", false)`
 * 在 vitest 4.x 中无法可靠覆盖 `DEV`（Vite built-in env 变量由 vitest 内部管理），
 * 因此提供 `_setDevModeCheck` 作为测试注入点，让单测能精确控制 dev/prod 路径。
 *
 * 生产环境由 Vite 在 build 时注入 `import.meta.env.DEV = false`，行为不变。
 */
let _devModeCheck: () => boolean = () =>
  Boolean((import.meta as { env?: { DEV?: boolean } }).env?.DEV);

/**
 * 当前是否为开发模式（供本模块内部判断 dev/prod 路径使用）
 *
 * 生产环境由 Vite 在 build 时注入 `import.meta.env.DEV = false`，行为不变。
 * 注意：vitest 中 `import.meta.env.DEV` 恒为 `true`。
 */
export function isDevMode(): boolean {
  return _devModeCheck();
}

/**
 * @internal 仅供测试使用：覆盖 dev 模式检测函数
 *
 * 测试结束后应调用 `_setDevModeCheck(() => true)` 恢复默认值（vitest 中 DEV 恒为 true）。
 *
 * @param fn 新的 dev 模式检测函数
 */
export function _setDevModeCheck(fn: () => boolean): void {
  _devModeCheck = fn;
}

/**
 * 把 TdsfAgentId 映射到 Python AGENT_REGISTRY key
 *
 * 映射规则（与 PLANS §11.1.2 一致）:
 *   coder   → coding
 *   explore → explore
 *   history → history
 *   teach   → teach
 *
 * 通过查 TDSF_AGENTS 表实现，避免硬编码 if-else。
 */
function mapToPythonName(agentId: TdsfAgentId): string {
  return TDSF_AGENTS[agentId].pythonName;
}

/**
 * 简单的 async queue（生产者-消费者模式）
 *
 * TDSF 修复 2026-07-31 (P1): 新增。
 *
 * 用途：解决"async generator 在 await invoke() 期间无法 yield"的矛盾。
 *
 * 架构问题：
 *   - runSidecarStream 是 async generator，主流程 `await invoke(...)` 阻塞
 *     等待完整结果
 *   - sidecar:agent_message / sidecar:tool_call 事件在 invoke 期间实时到达，
 *     需要实时 yield 给 useChat 渲染
 *   - 但 async generator 不能在 await 期间 yield
 *
 * 解决方案：AsyncQueue
 *   - 事件监听器（生产者）把 SidecarStreamPart push 到 queue
 *   - 主流程（消费者）用 Promise.race 在 invoke 和 queue.next() 之间竞争
 *   - queue 有 item → yield item
 *   - invoke 完成 → close queue，drain 剩余 items，处理最终 result
 *
 * 这样实现**真正流式输出**：Strands 后端的 LLM 文本增量、工具调用、
 * 思考过程都实时推送到前端，不再等 invoke 完成后一次性 yield。
 */
function createAsyncQueue<T>() {
  const items: T[] = [];
  const waiters: Array<(v: IteratorResult<T>) => void> = [];
  let closed = false;

  return {
    /** 生产者：push 一个 item 到 queue，唤醒等待的消费者 */
    push(item: T): void {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter) {
        waiter({ value: item, done: false });
      } else {
        items.push(item);
      }
    },
    /** 消费者：取下一个 item（如果没有就等待，queue close 后返回 done） */
    next(): Promise<IteratorResult<T>> {
      if (items.length > 0) {
        return Promise.resolve({ value: items.shift()!, done: false });
      }
      if (closed) {
        return Promise.resolve({ value: undefined as never, done: true });
      }
      return new Promise<IteratorResult<T>>((resolve) => {
        waiters.push(resolve);
      });
    },
    /** 关闭 queue：所有等待的消费者收到 done */
    close(): void {
      if (closed) return;
      closed = true;
      while (waiters.length > 0) {
        const waiter = waiters.shift()!;
        waiter({ value: undefined as never, done: true });
      }
    },
    /** 当前 queue 中的 item 数（不含已消费的） */
    get size(): number {
      return items.length;
    },
    /** queue 是否已关闭 */
    get isClosed(): boolean {
      return closed;
    },
  };
}

/**
 * 把长文本切成若干 chunk 流式 yield（兜底路径：LangGraph 后端 / 无事件推送）
 *
 * P0-2 (2026-08-01) 说明：Strands 后端（默认主路径）走事件真流式
 * （sidecar:agent_message → text-delta 实时渲染），此函数仅用于
 * `agent.invoke` 同步返回完整 dict 的后端（LangGraph）或事件缺失时兜底，
 * 避免一次性渲染长文本造成 UI 卡顿。
 *
 * @param text 待流式输出的完整文本
 * @param id   text stream id（同一 id 的 chunk 会被合并到同一个 text part）
 */
async function* streamText(
  text: string,
  id: string,
  kind: "text" | "reasoning" = "text",
): AsyncIterable<SidecarStreamPart> {
  if (!text) return;
  for (let i = 0; i < text.length; i += STREAM_CHUNK_SIZE) {
    const delta = text.slice(i, i + STREAM_CHUNK_SIZE);
    yield kind === "reasoning"
      ? { type: "reasoning-delta", id, delta }
      : { type: "text-delta", id, delta };
    // 让出事件循环，让 useChat 有机会渲染当前 chunk
    await new Promise((r) => setTimeout(r, STREAM_CHUNK_DELAY_MS));
  }
}

/**
 * 注册 Tauri event 监听器，把 Python event_bus 推送的 mood/step/tool/message 事件
 * 转发给上层回调
 *
 * 监听的事件:
 *   - sidecar:mood_change: Agent 心情变化（如 thinking → streaming）
 *   - sidecar:tool_call:   Agent 调用工具（用于显示 step 进度 + 工具行渲染）
 *   - sidecar:agent_message: Agent 中途推送的消息片段（thinking/output 流式）
 *     TDSF 修复 2026-07-31 (P1): 新增订阅，实现真正流式输出 + 深度思考 UI
 *   - sidecar:agent_switch: 主 Agent 路由子 Agent 事件
 *
 * 监听失败不致命（如非 Tauri 环境运行测试时），主流程继续。
 *
 * @returns unlisten 函数（调用后取消所有监听）
 */
async function registerSidecarListeners(
  onMood?: (mood: string) => void,
  onStep?: (step: string | null) => void,
  onToolCall?: (payload: ToolCallPayload) => void,
  onAgentMessage?: (payload: AgentMessagePayload) => void,
): Promise<() => void> {
  const unlisteners: UnlistenFn[] = [];

  // mood 变化事件
  if (onMood) {
    try {
      unlisteners.push(
        await listen<unknown>(EVENT_MOOD_CHANGE, (e) => {
          const p = unwrapEventPayload<{ mood?: string }>(e.payload);
          const mood = p?.mood;
          if (mood) onMood(mood);
        }),
      );
    } catch {
      // 非 Tauri 环境（如 vitest）listen 会 reject，忽略
    }
  }

  // 工具调用事件：既驱动顶栏 step 文字提示（started 时），又转发完整 payload
  // 给 onToolCall 供 runSidecarStream 收集成 tool part（工具行渲染）。
  // payload 结构与 event_bus.emit_tool_call 对齐：{tool_name, params, status, result}。
  if (onStep || onToolCall) {
    try {
      unlisteners.push(
        await listen<unknown>(EVENT_TOOL_CALL, (e) => {
          const p = unwrapEventPayload<ToolCallPayload>(e.payload);
          if (!p) return;
          const name = p.tool_name;
          if (name && p.status === "started") onStep?.(`调用 ${name}`);
          if (name) onToolCall?.(p);
        }),
      );
    } catch {
      // 同上
    }
  }

  // TDSF 修复 2026-07-31 (P1): agent_message 事件订阅
  // Strands 后端 TdsfStrandsCallbackHandler 把 LLM `data` 事件（文本增量）
  // 以 type="output" 推送，BaseAgent._emit_message 在 plan 阶段推送 type="thinking"。
  // 前端订阅后实时 yield 为 text-delta / reasoning-delta，实现真正流式 +
  // 深度思考 UI（替代伪流式切片 + 无 thinking 的旧方案）。
  if (onAgentMessage) {
    try {
      unlisteners.push(
        await listen<unknown>(EVENT_AGENT_MESSAGE, (e) => {
          const p = unwrapEventPayload<AgentMessagePayload>(e.payload);
          if (!p) return;
          onAgentMessage(p);
        }),
      );
    } catch {
      // 同上
    }
  }

  // v2026-07-29: 主 Agent 路由子 Agent 事件
  // 后端 main_agent.invoke() 在 PAOR 循环中通过 event_bus 推送 agent_switch 事件，
  // 前端订阅后更新 chatStore.currentSubAgent，让顶部 AgentStatusPill 实时显示
  // 当前路由到的子 Agent（Teach / Coding / Debug / ...）。
  try {
    unlisteners.push(
      await listen<unknown>(EVENT_AGENT_SWITCH, (e) => {
        const p = unwrapEventPayload<{ agent?: string; task?: string }>(
          e.payload,
        );
        const agent = p?.agent;
        if (agent) {
          // 动态 import 避免循环依赖
          import("../store/chatStore").then((mod) => {
            mod.useChatStore.getState().setCurrentSubAgent(agent);
          });
        }
      }),
    );
  } catch {
    // 同上
  }

  return () => {
    for (const un of unlisteners) {
      try {
        un();
      } catch {
        // ignore
      }
    }
  };
}

// === 主函数: runSidecarStream ================================================

/**
 * 调用 Sidecar Agent 并以 AsyncIterable 形式返回流式输出
 *
 * TDSF 修复 2026-07-31 (P1): 重构为 AsyncQueue 模式，实现真正流式输出。
 *
 * 旧方案问题：
 *   - `await invoke(...)` 阻塞等待完整结果，期间 sidecar:agent_message /
 *     sidecar:tool_call 事件实时到达但无法 yield（async generator 限制）
 *   - invoke 完成后才一次性 yield 所有工具调用 + 切片 output（伪流式）
 *   - 无深度思考 UI（result.thinking 通常为空，event 推送的 thinking 被丢弃）
 *
 * 新方案（AsyncQueue）：
 *   1. 创建 AsyncQueue<SidecarStreamPart>
 *   2. 事件监听器（生产者）：
 *      - onToolCall → push tool-input/tool-output part（工具实时流式）
 *      - onAgentMessage type="thinking" → push reasoning-delta（深度思考 UI）
 *      - onAgentMessage type="output" → push text-delta（LLM 文本实时流式）
 *   3. 主流程（消费者）：
 *      - 启动 invoke（不 await，用 Promise）
 *      - Promise.race([invokePromise, queue.next()])
 *        - queue 有 item → yield item（实时流式）
 *        - invoke 完成 → break
 *      - close queue，drain 剩余 items
 *   4. invoke 完成后处理最终 result：
 *      - 如果 event 推送了 output（streamedOutput 非空）→ 跳过 result.observation 切片（避免重复）
 *      - 否则 → 走伪流式切片 result.observation（LangGraph 后端兼容）
 *      - yield result.teaching_content（TeachAgent 专属，event 不推送）
 *   5. yield finish
 *
 * 协议:
 *   1. 映射 agentId → Python AGENT_REGISTRY key（如 coder → coding）
 *   2. 注册 Tauri event 监听器（mood / tool_call / agent_message）
 *   3. 调用 invoke('ipc_invoke', {method:'agent.invoke', params:{name, state:{input, messages, live}}})
 *      带 60s 超时保护
 *   4. 错误时:
 *      - 生产模式 + invoke 失败 → yield error
 *      - 任意模式 + 超时 → yield error
 *   5. abortSignal 触发时立即返回（已 yield 的 chunk 保留）
 *
 * @param opts 调用参数（agentId / messages / input / abortSignal / 回调）
 * @yields SidecarStreamPart（text-delta / reasoning-delta / tool-input / tool-output / finish / error）
 */
export async function* runSidecarStream(
  opts: SidecarStreamOptions,
): AsyncIterable<SidecarStreamPart> {
  const { agentId, messages, input, live, abortSignal, onMood, onStep, onUsage } = opts;
  const pythonName = mapToPythonName(agentId);
  const streamId = `tdsf-${agentId}-${Date.now()}`;
  const thinkingId = `${streamId}-thinking`;
  const outputId = `${streamId}-output`;
  // TDSF 魔改: TeachAgent 教学内容独立 stream id（与 thinking/output 同级）
  const teachingId = `${streamId}-teaching`;

  // === AsyncQueue：生产者（事件监听器）push part，消费者（主流程）yield ===
  const queue = createAsyncQueue<SidecarStreamPart>();

  // 跟踪 event 推送的 thinking/output（用于 invoke 完成后去重，避免与 result 重复）
  let streamedThinking = "";
  let streamedOutput = "";

  // 工具调用配对：toolIdByName 把同一工具的 started/completed 两个事件
  // 配对到同一 toolCallId（sidecar PAOR 串行执行，按 tool_name 配对即可）。
  const toolIdByName = new Map<string, string>();
  let toolSeq = 0;

  // onToolCall 回调：把工具事件转成 tool-input/tool-output part，push 到 queue
  // （TDSF 修复 2026-07-31 P1: 实时流式，不再收集到数组等 invoke 完成）
  const onToolCall = (p: ToolCallPayload) => {
    console.info("[sidecar-adapter] tool_call", p.tool_name, p.status);
    const name = p.tool_name;
    if (!name) return;
    if (p.status === "started") {
      const toolCallId = `${streamId}-tool-${++toolSeq}`;
      toolIdByName.set(name, toolCallId);
      queue.push({
        type: "tool-input",
        toolCallId,
        toolName: name,
        input: p.params ?? {},
      });
    } else if (p.status === "completed" || p.status === "error") {
      const toolCallId = toolIdByName.get(name);
      // 孤儿 completed 事件（无对应 started）：通常是上一次 invoke 的尾部
      // tool_call 事件迟到，被新 invoke 的全局监听器捕获。若 fallback 生成
      // 新 ID 会产出无 tool-input 配对的 tool-output，AI SDK 找不到对应
      // tool invocation 直接抛错（"No tool invocation found for tool call ID"），
      // 长对话连续发送时频繁复现。正确做法：忽略，不产生 part。
      if (!toolCallId) {
        console.info(
          "[sidecar-adapter] tool_call completed without matching started, ignoring",
          name,
        );
        return;
      }
      toolIdByName.delete(name);
      queue.push({
        type: "tool-output",
        toolCallId,
        toolName: name,
        output: p.result ?? null,
        isError: p.status === "error",
      });
    }
  };

  // onAgentMessage 回调：把 agent_message 事件转成 reasoning-delta/text-delta part
  // （TDSF 修复 2026-07-31 P1: 实现深度思考 UI + LLM 文本真正流式）
  const onAgentMessage = (p: AgentMessagePayload) => {
    // TDSF debug 2026-07-31: 记录 agent_message 事件到 console，便于 CDP 排障
    // 生产环境日志量极小（每条消息一次），不影响性能
    const msgType = p.type ?? p.message_type ?? "output";
    console.info(
      "[sidecar-adapter] agent_message",
      msgType,
      p.content?.slice(0, 80),
    );
    const content = p.content;
    if (!content) return;
    if (msgType === "thinking") {
      // Agent 思考过程 → reasoning-delta（Reasoning 折叠段）
      streamedThinking += content;
      queue.push({ type: "reasoning-delta", id: thinkingId, delta: content });
    } else if (msgType === "output") {
      // LLM 文本增量 → text-delta（assistant message 主体）
      streamedOutput += content;
      queue.push({ type: "text-delta", id: outputId, delta: content });
    }
    // type="tool_call" / "working" 已被 sidecar:tool_call / sidecar:mood_change 覆盖，忽略
  };

  // 1. 注册事件监听器（传入 onAgentMessage 订阅 sidecar:agent_message）
  const unlisten = await registerSidecarListeners(
    onMood,
    onStep,
    onToolCall,
    onAgentMessage,
  );

  try {
    onStep?.("调用 Sidecar Agent");

    // 2. 启动 invoke（不 await，用 Promise 在 race 中竞争）
    let invokeError: string | null = null;
    let invokeResolve: ((v: AgentInvokeResult | null) => void) | null = null;
    const invokePromise = new Promise<AgentInvokeResult | null>((resolve) => {
      invokeResolve = resolve;
    });

    // 超时 + abort 保护
    // P0-3 (2026-08-01): 超时可配置（getSidecarTimeoutMs，默认 60s）
    const timeoutMs = getSidecarTimeoutMs();
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Sidecar 调用超时（${timeoutMs / 1000}s）`)),
        timeoutMs,
      );
      abortSignal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("用户取消"));
        },
        { once: true },
      );
    });

    // TDSF 魔改 2026-07-30 (Bug 5): 把 live 上下文通过 state.live 传给 Python agent。
    // Python 端 StrandsAgentAdapter._build_tool_context() 从 state.live 取 sshSessionId
    // 填充 ToolContext.ssh_session_id（运维工具据此调 ssh_command/sftp_*），
    // _build_prompt() 从 state.live 取 cwd/activeFile 注入 <live_context> 块给 LLM。
    const invokeTask = (async () => {
      try {
        const raw = await Promise.race([
          invoke<AgentInvokeResult>("ipc_invoke", {
            method: "agent.invoke",
            params: {
              name: pythonName,
              state: { input, messages, live },
            },
            // P0-3: 把可配置超时传给 Rust 侧（Rust 默认 60s 硬超时，
            // 不传则长任务仍可能在 Rust 层被掐断）
            timeoutMs,
          }),
          timeout,
        ]);
        return raw;
      } catch (err) {
        invokeError = err instanceof Error ? err.message : String(err);
        return null;
      }
    })();
    // invokeTask 完成后 resolve invokePromise
    invokeTask.then((r) => invokeResolve?.(r));

    // 3. 消费循环：Promise.race 在 invoke 和 queue.next() 之间竞争
    //    - queue 有 item → yield item（实时流式）
    //    - invoke 完成 → break
    let invokeDone = false;
    while (!invokeDone) {
      if (abortSignal?.aborted) {
        queue.close();
        return;
      }
      // 等待 queue 有 item 或 invoke 完成
      const queueNext = queue.next();
      const result = await Promise.race([
        invokePromise.then((r) => ({ kind: "invoke" as const, value: r })),
        queueNext.then((r) => ({ kind: "queue" as const, value: r })),
      ]);
      if (result.kind === "queue") {
        // queue 有 item → yield
        if (result.value.done) {
          // queue 被 close（不应发生在 invoke 完成前，防御性 break）
          break;
        }
        yield result.value.value;
      } else {
        // invoke 完成 → 标记 done，继续 drain queue 剩余 items
        invokeDone = true;
      }
    }

    // 4. invoke 完成，close queue（让 queue.next() 不再阻塞）
    //    留 TOOL_DRAIN_MS 窗口让最后一个 in-flight 事件落地
    await new Promise((r) => setTimeout(r, TOOL_DRAIN_MS));
    queue.close();

    // drain queue 剩余 items（invoke 完成前 push 但未被消费的 part）
    while (true) {
      const next = await queue.next();
      if (next.done) break;
      yield next.value;
    }

    // 5. 中断信号检查（用户取消时直接返回）
    if (abortSignal?.aborted) {
      return;
    }

    // 6. 获取 invoke 结果
    const invokeResult = await invokePromise;

    // 7. 错误处理: sidecar 不可用
    if (!invokeResult && invokeError) {
      // TDSF 魔改 P0-3: 移除 mock 降级，直接报错让用户看到真实问题
      // P0-4 (2026-08-01): 结构化错误提示——按错误类型区分文案与行动建议
      yield { type: "error", error: buildSidecarErrorHint(invokeError, pythonName) };
      return;
    }

    // 8. result 为空但无 error（异常情况）
    if (!invokeResult) {
      yield { type: "error", error: "Sidecar 返回空结果" };
      return;
    }

    // 8.5 P0-4: 后端返回 degraded 标志（Strands 运行时降级）→ 友好提示
    if (invokeResult.degraded) {
      yield {
        type: "error",
        error: buildSidecarErrorHint(invokeResult.degraded_message ?? "", pythonName, true),
      };
      return;
    }

    // 9. 处理 mood / tokens 回调
    if (invokeResult.mood) {
      onMood?.(invokeResult.mood);
    }
    if (invokeResult.tokens) {
      onUsage?.({
        inputTokens: invokeResult.tokens.input ?? 0,
        outputTokens: invokeResult.tokens.output ?? 0,
      });
    }

    // 10. 处理 thinking：如果 event 未推送 thinking（LangGraph 后端），走伪流式
    //     如果 event 已推送（Strands 后端），跳过避免重复
    if (!streamedThinking && invokeResult.thinking) {
      onStep?.("Thinking");
      yield* streamText(invokeResult.thinking, thinkingId, "reasoning");
    }

    // 11. 处理 output：如果 event 未推送 output（LangGraph 后端），走伪流式切片
    //     如果 event 已推送（Strands 后端），跳过避免重复
    //     Python BaseAgent.invoke() 返回 `observation` 字段（非 `output`），
    //     优先读 observation，回退到 output 兼容旧测试。
    const outputText = invokeResult.observation ?? invokeResult.output ?? "";
    if (!streamedOutput && outputText) {
      onStep?.("Streaming");
      yield* streamText(outputText, outputId);
    }

    // 12. TeachAgent.teaching_content 追加输出
    //     TeachAgent.reflect_on_result() 在最后一步生成结构化教学内容
    //     （教程 + 知识卡 + 学习路径），event 不推送，这里走伪流式切片。
    if (invokeResult.teaching_content) {
      onStep?.("Teaching");
      yield* streamText(invokeResult.teaching_content, teachingId);
    }

    // 13. finish
    onStep?.(null);
    yield { type: "finish", id: streamId };
  } finally {
    // 无论成功失败，都取消事件监听 + close queue，避免内存泄漏
    queue.close();
    unlisten();
  }
}

// === 适配器: sidecarStreamToUIMessageStream ===================================

/**
 * 把 Sidecar 内部的 AsyncIterable<SidecarStreamPart> 转换为 ai 包期望的
 * ReadableStream<UIMessageChunk>，让 transport.sendMessages 返回值符合
 * ChatTransport 协议
 *
 * 转换规则（SidecarStreamPart → UIMessageChunk 序列）:
 *   - 第一个 text-delta（id=X）→
 *       {type:"start", messageId} → {type:"start-step"} →
 *       {type:"text-start", id:X} → {type:"text-delta", id:X, delta}
 *   - 后续同 id 的 text-delta →
 *       {type:"text-delta", id:X, delta}
 *   - 切换到新 id 的 text-delta →
 *       {type:"text-end", id:旧X} → {type:"text-start", id:新X} →
 *       {type:"text-delta", id:新X, delta}
 *   - finish →
 *       {type:"text-end", id:当前X}（若未关闭）→
 *       {type:"finish-step"} → {type:"finish", finishReason:"stop"}
 *   - error →
 *       {type:"text-end", id:当前X}（若未关闭）→
 *       {type:"finish-step"} → {type:"error", errorText}
 *
 * @param source  Sidecar 内部 AsyncIterable
 * @param options.originalMessages  原始消息列表（透传给 Vercel SDK 协议）
 * @param options.onError  错误格式化函数（与 runAgentStream 一致）
 * @returns ReadableStream<UIMessageChunk>，符合 ChatTransport.sendMessages 返回值协议
 */
export function sidecarStreamToUIMessageStream(
  source: AsyncIterable<SidecarStreamPart>,
  options: {
    originalMessages?: UIMessage[];
    onError?: (e: unknown) => string;
  } = {},
): ReadableStream<UIMessageChunk> {
  // originalMessages 透传给 Vercel SDK 协议（部分版本会用它做 message id 分配）
  void options.originalMessages;

  return new ReadableStream<UIMessageChunk>({
    async start(controller) {
      const messageId = `msg-${Date.now()}`;
      let currentTextId: string | null = null;
      let currentReasoningId: string | null = null;
      let finished = false;
      let errored = false;

      // 关闭当前开着的 text / reasoning 流（切到工具行或另一种流之前必须先关）。
      const closeText = () => {
        if (currentTextId) {
          controller.enqueue({ type: "text-end", id: currentTextId });
          currentTextId = null;
        }
      };
      const closeReasoning = () => {
        if (currentReasoningId) {
          controller.enqueue({ type: "reasoning-end", id: currentReasoningId });
          currentReasoningId = null;
        }
      };

      try {
        // 消息开始
        controller.enqueue({ type: "start", messageId });
        controller.enqueue({ type: "start-step" });

        for await (const part of source) {
          if (part.type === "text-delta") {
            // 文本段开始前先关闭 reasoning 段
            closeReasoning();
            if (currentTextId !== part.id) {
              closeText();
              currentTextId = part.id;
              controller.enqueue({ type: "text-start", id: part.id });
            }
            controller.enqueue({
              type: "text-delta",
              id: part.id,
              delta: part.delta,
            });
          } else if (part.type === "reasoning-delta") {
            // reasoning 段（Reasoned 折叠）开始前先关闭 text 段
            closeText();
            if (currentReasoningId !== part.id) {
              closeReasoning();
              currentReasoningId = part.id;
              controller.enqueue({ type: "reasoning-start", id: part.id });
            }
            controller.enqueue({
              type: "reasoning-delta",
              id: part.id,
              delta: part.delta,
            });
          } else if (part.type === "tool-input") {
            // 工具行输入：独立 part 边界，先关掉当前 text / reasoning 流。
            // dynamic:true → 成为 dynamic-tool part，AiChat 的 RenderedTool 能渲染。
            closeText();
            closeReasoning();
            controller.enqueue({
              type: "tool-input-available",
              toolCallId: part.toolCallId,
              toolName: part.toolName,
              input: part.input,
              dynamic: true,
            });
          } else if (part.type === "tool-output") {
            closeText();
            closeReasoning();
            if (part.isError) {
              controller.enqueue({
                type: "tool-output-error",
                toolCallId: part.toolCallId,
                errorText:
                  typeof part.output === "string"
                    ? part.output
                    : JSON.stringify(part.output),
                dynamic: true,
              });
            } else {
              controller.enqueue({
                type: "tool-output-available",
                toolCallId: part.toolCallId,
                output: part.output,
                dynamic: true,
              });
            }
          } else if (part.type === "finish") {
            closeText();
            closeReasoning();
            controller.enqueue({ type: "finish-step" });
            controller.enqueue({ type: "finish", finishReason: "stop" });
            finished = true;
          } else if (part.type === "error") {
            closeText();
            closeReasoning();
            controller.enqueue({ type: "finish-step" });
            const errorText = options.onError
              ? options.onError(new Error(part.error))
              : part.error;
            controller.enqueue({ type: "error", errorText });
            errored = true;
          }
        }

        // 兜底: source 结束但没显式 yield finish / error
        if (!finished && !errored) {
          closeText();
          closeReasoning();
          controller.enqueue({ type: "finish-step" });
          controller.enqueue({ type: "finish", finishReason: "stop" });
        }
      } catch (err) {
        // 兜底异常处理（如 source 抛错）
        closeText();
        closeReasoning();
        const errorText = options.onError
          ? options.onError(err)
          : err instanceof Error
            ? err.message
            : String(err);
        controller.enqueue({ type: "error", errorText });
      } finally {
        controller.close();
      }
    },
  });
}
