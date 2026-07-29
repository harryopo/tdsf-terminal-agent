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

/** Sidecar 调用超时（30s，与 PLANS 验收点一致） */
const SIDECAR_TIMEOUT_MS = 30_000;

/** 模拟流式输出的 chunk 大小（字符数） */
const STREAM_CHUNK_SIZE = 24;

/** 模拟流式输出的 chunk 间隔（ms，让 useChat 能逐 chunk 渲染） */
const STREAM_CHUNK_DELAY_MS = 8;

/** Tauri event 名（与 src-tauri/src/modules/ipc.rs:329-339 对齐） */
const EVENT_MOOD_CHANGE = "sidecar:mood_change";
const EVENT_TOOL_CALL = "sidecar:tool_call";
const EVENT_AGENT_SWITCH = "sidecar:agent_switch"; // v2026-07-29: 主 Agent 路由子 Agent 事件

// === 类型 ====================================================================

/** `runSidecarStream` 调用参数 */
export interface SidecarStreamOptions {
  /** TDSF agent id（前端业务 id，会被映射到 Python AGENT_REGISTRY key） */
  agentId: TdsfAgentId;
  /** 完整对话历史（含 parts，传给 Python 端做上下文） */
  messages: UIMessage[];
  /** 最后一条 user 消息文本（由 transport 提取，避免 Python 端再解析） */
  input: string;
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
 * 把长文本切成若干 chunk 流式 yield（模拟真实 LLM 流式输出）
 *
 * Python 端 `agent.invoke` 是同步返回完整 dict，不是流式。
 * 为了让 useChat 能像消费 Vercel SDK 流一样逐 chunk 渲染（避免一次性
 * 渲染长文本造成 UI 卡顿），这里按 STREAM_CHUNK_SIZE 字符切片，
 * 每个 chunk 之间 await STREAM_CHUNK_DELAY_MS 让出事件循环。
 *
 * @param text 待流式输出的完整文本
 * @param id   text stream id（同一 id 的 chunk 会被合并到同一个 text part）
 */
async function* streamText(
  text: string,
  id: string,
): AsyncIterable<SidecarStreamPart> {
  if (!text) return;
  for (let i = 0; i < text.length; i += STREAM_CHUNK_SIZE) {
    yield {
      type: "text-delta",
      id,
      delta: text.slice(i, i + STREAM_CHUNK_SIZE),
    };
    // 让出事件循环，让 useChat 有机会渲染当前 chunk
    await new Promise((r) => setTimeout(r, STREAM_CHUNK_DELAY_MS));
  }
}

/**
 * 注册 Tauri event 监听器，把 Python event_bus 推送的 mood/step 事件
 * 转发给上层回调
 *
 * 监听的事件:
 *   - sidecar:mood_change: Agent 心情变化（如 thinking → streaming）
 *   - sidecar:tool_call:   Agent 调用工具（用于显示 step 进度）
 *   - sidecar:agent_message: Agent 中途推送的消息片段（暂不处理，预留）
 *
 * 监听失败不致命（如非 Tauri 环境运行测试时），主流程继续。
 *
 * @returns unlisten 函数（调用后取消所有监听）
 */
async function registerSidecarListeners(
  onMood?: (mood: string) => void,
  onStep?: (step: string | null) => void,
): Promise<() => void> {
  const unlisteners: UnlistenFn[] = [];

  // mood 变化事件
  if (onMood) {
    try {
      unlisteners.push(
        await listen<{ mood?: string }>(EVENT_MOOD_CHANGE, (e) => {
          const mood = e.payload?.mood;
          if (mood) onMood(mood);
        }),
      );
    } catch {
      // 非 Tauri 环境（如 vitest）listen 会 reject，忽略
    }
  }

  // 工具调用事件（用于显示 step 进度）
  if (onStep) {
    try {
      unlisteners.push(
        await listen<{ step?: string; tool?: string }>(EVENT_TOOL_CALL, (e) => {
          const p = e.payload;
          if (!p) return;
          if (p.step) onStep(p.step);
          else if (p.tool) onStep(`Calling ${p.tool}`);
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
      await listen<{ agent?: string; task?: string }>(EVENT_AGENT_SWITCH, (e) => {
        const agent = e.payload?.agent;
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
 * 协议:
 *   1. 映射 agentId → Python AGENT_REGISTRY key（如 coder → coding）
 *   2. 注册 Tauri event 监听器（mood / tool_call）
 *   3. 调用 invoke('ipc_invoke', {method:'agent.invoke', params:{name, state:{input, messages}}})
 *      带 30s 超时保护
 *   4. 拿到 dict 结果后，把 thinking + output 切片流式 yield
 *   5. 错误时:
 *      - 开发模式 + invoke 失败 → 降级到 mock 响应（不抛错，让 UI 继续）
 *      - 生产模式 + invoke 失败 → yield error
 *      - 任意模式 + 超时 → yield error
 *   6. abortSignal 触发时立即返回（已 yield 的 chunk 保留）
 *
 * @param opts 调用参数（agentId / messages / input / abortSignal / 回调）
 * @yields SidecarStreamPart（text-delta / finish / error）
 */
export async function* runSidecarStream(
  opts: SidecarStreamOptions,
): AsyncIterable<SidecarStreamPart> {
  const { agentId, messages, input, abortSignal, onMood, onStep, onUsage } = opts;
  const pythonName = mapToPythonName(agentId);
  const streamId = `tdsf-${agentId}-${Date.now()}`;
  const thinkingId = `${streamId}-thinking`;
  const outputId = `${streamId}-output`;
  // TDSF 魔改: TeachAgent 教学内容独立 stream id（与 thinking/output 同级）
  const teachingId = `${streamId}-teaching`;

  // 1. 注册事件监听器
  const unlisten = await registerSidecarListeners(onMood, onStep);

  try {
    onStep?.("调用 Sidecar Agent");

    // 2. 调用 Python agent.invoke（带 30s 超时）
    let result: AgentInvokeResult | null = null;
    let invokeError: string | null = null;

    try {
      const timeout = new Promise<never>((_, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Sidecar 调用超时（30s）")),
          SIDECAR_TIMEOUT_MS,
        );
        // 让 abortSignal 触发时能立即 reject（避免 Promise 泄漏）
        abortSignal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("用户取消"));
          },
          { once: true },
        );
      });

      const raw = await Promise.race([
        invoke<AgentInvokeResult>("ipc_invoke", {
          method: "agent.invoke",
          params: {
            name: pythonName,
            state: { input, messages },
          },
        }),
        timeout,
      ]);
      result = raw;
    } catch (err) {
      invokeError = err instanceof Error ? err.message : String(err);
    }

    // 3. 中断信号检查（用户取消时直接返回）
    if (abortSignal?.aborted) {
      return;
    }

    // 4. 错误处理: sidecar 不可用
    if (!result && invokeError) {
      // TDSF 魔改 P0-3: 移除 mock 降级，直接报错让用户看到真实问题
      // 原 mock 模式会让用户误以为 AI 在工作（[mock:coding]），实际 sidecar 调用已失败
      const hint = `Sidecar Agent 调用失败: ${invokeError}\n\n可能原因：\n1) LLM 未配置 — 请到设置 → AI 模型配置 API Key\n2) Sidecar 未启动 — 请检查 sidecar 日志\n3) Agent 名称错误 — 当前调用: ${pythonName}`;
      yield { type: "error", error: hint };
      return;
    }

    // 5. result 为空但无 error（异常情况）
    if (!result) {
      yield { type: "error", error: "Sidecar 返回空结果" };
      return;
    }

    // 6. 处理 mood / tokens 回调
    if (result.mood) {
      onMood?.(result.mood);
    }
    if (result.tokens) {
      onUsage?.({
        inputTokens: result.tokens.input ?? 0,
        outputTokens: result.tokens.output ?? 0,
      });
    }

    // 7. 流式输出 thinking（如有，作为前置 reasoning 段）
    if (result.thinking) {
      onStep?.("Thinking");
      yield* streamText(result.thinking, thinkingId);
    }

    // TDSF 魔改: 字段对齐 Python 实际返回
    // Python BaseAgent.invoke() 通过 AgentResult.to_state_update() 返回 `observation` 字段
    // （agents/base.py:89），而非 `output`。优先读 observation，回退到 output 兼容旧测试。
    // TeachAgent 还会返回 teaching_content（结构化教学内容），追加到主输出后展示。
    const outputText = result.observation ?? result.output ?? "";

    // 8. 流式输出 output（必填字段，作为 assistant message 主体）
    if (outputText) {
      onStep?.("Streaming");
      yield* streamText(outputText, outputId);
    }

    // TDSF 魔改: TeachAgent.teaching_content 追加输出
    // TeachAgent.reflect_on_result() 在最后一步生成结构化教学内容
    // （教程 + 知识卡 + 学习路径），通过 BaseAgent.invoke() 的 extra_update 传给前端。
    // 这里追加到主输出之后，作为独立 text stream 段（与 thinking/output 同级）。
    if (result.teaching_content) {
      onStep?.("Teaching");
      yield* streamText(result.teaching_content, teachingId);
    }

    // 9. finish
    onStep?.(null);
    yield { type: "finish", id: streamId };
  } finally {
    // 无论成功失败，都取消事件监听，避免内存泄漏
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
      let finished = false;
      let errored = false;

      try {
        // 消息开始
        controller.enqueue({ type: "start", messageId });
        controller.enqueue({ type: "start-step" });

        for await (const part of source) {
          if (part.type === "text-delta") {
            // 切换 text stream id 时关闭旧的、开启新的
            if (currentTextId !== part.id) {
              if (currentTextId) {
                controller.enqueue({ type: "text-end", id: currentTextId });
              }
              currentTextId = part.id;
              controller.enqueue({ type: "text-start", id: part.id });
            }
            controller.enqueue({
              type: "text-delta",
              id: part.id,
              delta: part.delta,
            });
          } else if (part.type === "finish") {
            // 关闭当前 text stream（如有）
            if (currentTextId) {
              controller.enqueue({ type: "text-end", id: currentTextId });
              currentTextId = null;
            }
            controller.enqueue({ type: "finish-step" });
            controller.enqueue({ type: "finish", finishReason: "stop" });
            finished = true;
          } else if (part.type === "error") {
            // 关闭当前 text stream（如有）
            if (currentTextId) {
              controller.enqueue({ type: "text-end", id: currentTextId });
              currentTextId = null;
            }
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
          if (currentTextId) {
            controller.enqueue({ type: "text-end", id: currentTextId });
          }
          controller.enqueue({ type: "finish-step" });
          controller.enqueue({ type: "finish", finishReason: "stop" });
        }
      } catch (err) {
        // 兜底异常处理（如 source 抛错）
        if (currentTextId) {
          controller.enqueue({ type: "text-end", id: currentTextId });
        }
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
