// TDSF 阶段3: sidecar-adapter.ts 单元测试
// -----------------------------------------------------------------------------
// 测试覆盖（与任务清单 T3.3 一致）:
//   1. runSidecarStream 在 sidecar 不可用时降级到 mock（不抛错）— dev 模式 + invoke reject
//   2. Python agent name 映射正确（coder→coding 等）— 通过 invoke 调用参数断言
//   3. 流式消息转换为 UIMessageStreamPart 格式正确 — 测 sidecarStreamToUIMessageStream 输出
//   4. 成功路径：invoke 返回 {thinking, output, mood, tokens} → yield 多个 text-delta + finish
//   5. 错误路径：生产模式 + invoke 失败 → yield error
//
// mock 策略（与 riskClient.test.ts 一致）:
//   - vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }))
//   - vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockRejectedValue(...) }))
//     非 Tauri 环境（vitest）listen 会 reject，registerSidecarListeners 内部 try/catch 兜底
//   - _setDevModeCheck(() => true/false) 注入 dev/prod 模式，触发降级 mock 或 error 路径
//     （vitest 4.x 中 vi.stubEnv("DEV", ...) 无法可靠覆盖 import.meta.env.DEV，故用注入）
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// mock 必须在 import 之前
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockRejectedValue(new Error("not in tauri")),
}));

import type { UIMessage } from "@ai-sdk/react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  _setDevModeCheck,
  buildSidecarErrorHint,
  runSidecarStream,
  type SidecarStreamPart,
  sidecarStreamToUIMessageStream,
  toolFailureText,
} from "./sidecar-adapter";
import { markSidecarConfigSynced } from "./sidecar-config-sync";
import { useNeedsYouWait } from "../store/needsYouWaitStore";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockInvoke.mockReset();
  // 配置同步由 sidecar-config-sync.test.ts 覆盖；本文件仅验证 agent.invoke
  // 流程，避免首个用例在并发全量运行时被 keyring/配置读取拖慢。
  markSidecarConfigSynced();
  // vitest 中 import.meta.env.DEV 恒为 true，默认 dev 模式
  _setDevModeCheck(() => true);
});

// 关键: _devModeCheck / stubEnv / stubGlobal 在测试间不会自动重置，
// 必须 afterEach 显式还原，否则前一个用例的设置会污染下一个用例
afterEach(() => {
  _setDevModeCheck(() => true);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// 构造最小 UIMessage 测试数据
function makeMessages(text: string): UIMessage[] {
  return [
    {
      id: "user-1",
      role: "user",
      parts: [{ type: "text", text }],
    } as UIMessage,
  ];
}

// TDSF 2026-07-30 (Bug 5): runSidecarStream 新增必填 live 字段
// v3.1 (2026-08-29): live 新增可选 agentMode / teach 字段（三模式信任体系传参）
// 构造默认 live 上下文（无 SSH 会话），各用例按需覆盖字段
function makeLive(overrides: Partial<{
  cwd: string | null;
  terminalPrivate: boolean;
  workspaceRoot: string | null;
  activeFile: string | null;
  sshSessionId: number | null;
  agentMode: "observe" | "confirm" | "auto";
  teach: boolean;
}> = {}): {
  cwd: string | null;
  terminalPrivate: boolean;
  workspaceRoot: string | null;
  activeFile: string | null;
  sshSessionId: number | null;
  agentMode?: "observe" | "confirm" | "auto";
  teach?: boolean;
} {
  return {
    cwd: null,
    terminalPrivate: false,
    workspaceRoot: null,
    activeFile: null,
    sshSessionId: null,
    ...overrides,
  };
}

// 收集 AsyncIterable 的所有 part
async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of iter) out.push(v);
  return out;
}

// 读取 ReadableStream 的所有 chunk
async function readStream<T>(stream: ReadableStream<T>): Promise<T[]> {
  const reader = stream.getReader();
  const out: T[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value !== undefined) out.push(value);
  }
  return out;
}

describe("runSidecarStream — sidecar 不可用时降级", () => {
  it("dev 模式 + invoke 失败 → yield error（TDSF P0-3: 移除 mock 降级）", async () => {
    // TDSF P0-3: 原 mock 降级会让用户误以为 AI 在工作（[mock:coding]），
    // 现在改为直接报错让用户看到真实问题（如 LLM 未配置）。
    // 此测试验证新行为：dev 模式下 invoke 失败也直接 yield error。
    _setDevModeCheck(() => true);

    mockInvoke.mockRejectedValue(new Error("sidecar not running"));

    const parts = await collect(
      runSidecarStream({
        agentId: "main",
        messages: makeMessages("hello"),
        input: "hello",
        live: makeLive(),
      }),
    );

    // 应该只有 error，没有 text-delta / finish
    expect(parts.length).toBe(1);
    expect(parts[0].type).toBe("error");
    const err = parts[0] as { type: "error"; error: string };
    expect(err.error).toContain("sidecar not running");
    // P0-4: 结构化错误提示——not_running 类型应包含重启建议
    expect(err.error).toContain("重启应用后重试");
  }, 15_000);

  it("生产模式 + invoke 失败 → yield error（不降级）", async () => {
    // 确保生产模式：_devModeCheck() 返回 false，触发 error 路径（不降级到 mock）
    _setDevModeCheck(() => false);

    mockInvoke.mockRejectedValue(new Error("sidecar not running"));

    const parts = await collect(
      runSidecarStream({
        agentId: "main",
        messages: makeMessages("hello"),
        input: "hello",
        live: makeLive(),
      }),
    );

    // 应该只有 error，没有 text-delta / finish
    expect(parts.length).toBe(1);
    expect(parts[0].type).toBe("error");
    const err = parts[0] as { type: "error"; error: string };
    expect(err.error).toContain("sidecar not running");
  });
});

describe("runSidecarStream — Python agent name 映射", () => {
  it("main → 调用 invoke 时 params.name 应为 'main'（v3.1 收敛后唯一入口）", async () => {
    _setDevModeCheck(() => false);

    mockInvoke.mockResolvedValue({ output: "done" });

    const live = makeLive();
    await collect(
      runSidecarStream({
        agentId: "main",
        sessionId: "session-1",
        messages: makeMessages("test"),
        input: "test",
        live,
      }),
    );

    // TDSF 2026-07-30 (Bug 5): state 现在含 live 字段
    // P0 活动感知(2026-09-03): invoke 传 Rust timeoutMs=SIDECAR_TIMEOUT_MAX_MS(600000) 总时长硬上限；前端活动感知超时(默认300s无活动)另 race
    // v3.1 收敛: 旧 coder/explore/history/teach → coding/explore/history/teach
    // 的映射已随子 agent 委派机制删除，TDSF_AGENTS 仅 main 一项。
    expect(mockInvoke).toHaveBeenCalledWith("ipc_invoke", {
      method: "agent.invoke",
      params: {
        name: "main",
        state: {
          input: "test",
          messages: makeMessages("test"),
          live,
          session_id: "session-1",
        },
      },
      timeoutMs: 600000,
    });
  });

  it("state.live.agentMode / state.live.teach 原样透传（v3.1 三模式传参）", async () => {
    _setDevModeCheck(() => false);
    mockInvoke.mockResolvedValue({ output: "ok" });

    const live = makeLive({ agentMode: "observe", teach: true });
    await collect(
      runSidecarStream({
        agentId: "main",
        messages: makeMessages("test"),
        input: "test",
        live,
      }),
    );

    const call = mockInvoke.mock.calls[0];
    expect(call[1].params.name).toBe("main");
    // sidecar adapter.py 读 state.live.agentMode（缺省 confirm）+ state.live.teach
    expect(call[1].params.state.live.agentMode).toBe("observe");
    expect(call[1].params.state.live.teach).toBe(true);
  });
});

describe("runSidecarStream — 成功路径", () => {
  it("invoke 返回 {thinking, output, mood, tokens} → yield thinking + output + finish", async () => {
    _setDevModeCheck(() => false);

    mockInvoke.mockResolvedValue({
      thinking: "analyzing",
      output: "Hello world",
      mood: "streaming",
      tokens: {
        input: 10,
        output: 5,
        last_input_tokens: 8,
        last_cached_input_tokens: 3,
      },
    });

    const onMood = vi.fn();
    const onUsage = vi.fn();
    const onStep = vi.fn();

    const parts = await collect(
      runSidecarStream({
        agentId: "main",
        messages: makeMessages("hi"),
        input: "hi",
        live: makeLive(),
        onMood,
        onUsage,
        onStep,
      }),
    );

    // 应该有 thinking 段 text-delta + output 段 text-delta + finish
    const types = parts.map((p) => p.type);
    expect(types.filter((t) => t === "text-delta").length).toBeGreaterThan(0);
    expect(types).toContain("finish");
    expect(types).not.toContain("error");

    // mood / usage 回调应该被调用
    expect(onMood).toHaveBeenCalledWith("streaming");
    // 2026-09-01: onUsage 透传缓存命中字段（sidecar 未上报时为 0）
    expect(onUsage).toHaveBeenCalledWith({
      inputTokens: 10,
      outputTokens: 5,
      cachedInputTokens: 0,
      lastInputTokens: 8,
      lastCachedTokens: 3,
    });

    // onStep 应该被多次调用（"Thinking" → "Streaming" → null；2026-09-03 移除 "调用 Sidecar Agent"）
    expect(onStep.mock.calls.length).toBeGreaterThanOrEqual(3);
    const stepArgs = onStep.mock.calls.map((c) => c[0]);
    expect(stepArgs).toContain("Thinking");
    expect(stepArgs).toContain("Streaming");
    expect(stepArgs).toContain(null);
  });

  it("invoke 只返回 output（无 thinking/mood/tokens）→ 仅 output + finish", async () => {
    _setDevModeCheck(() => false);

    mockInvoke.mockResolvedValue({ output: "simple" });

    const parts = await collect(
      runSidecarStream({
        agentId: "main",
        messages: makeMessages("q"),
        input: "q",
        live: makeLive(),
      }),
    );

    const types = parts.map((p) => p.type);
    expect(types.filter((t) => t === "text-delta").length).toBeGreaterThan(0);
    expect(types).toContain("finish");
    expect(types).not.toContain("error");
  });
});

describe("sidecarStreamToUIMessageStream — UIMessageChunk 协议转换", () => {
  it("text-delta + finish → start / start-step / text-start / text-delta+ / text-end / finish-step / finish", async () => {
    _setDevModeCheck(() => false);

    // 构造 SidecarStreamPart 输入
    const input: SidecarStreamPart[] = [
      { type: "text-delta", id: "text-1", delta: "Hello" },
      { type: "text-delta", id: "text-1", delta: " world" },
      { type: "finish", id: "stream-1" },
    ];

    const stream = sidecarStreamToUIMessageStream(
      (async function* () {
        for (const p of input) yield p;
      })(),
    );

    const chunks = await readStream(stream);
    const types = chunks.map((c) => c.type);

    // 应该按顺序: start → start-step → text-start → text-delta+ → text-end → finish-step → finish
    expect(types[0]).toBe("start");
    expect(types[1]).toBe("start-step");
    expect(types[2]).toBe("text-start");
    expect(types.filter((t) => t === "text-delta").length).toBe(2);
    expect(types).toContain("text-end");
    expect(types).toContain("finish-step");
    expect(types[types.length - 1]).toBe("finish");

    // text-delta 的 delta 字段应该正确传递
    const deltas = chunks
      .filter((c) => c.type === "text-delta")
      .map((c) => (c as { delta: string }).delta);
    expect(deltas).toEqual(["Hello", " world"]);
  });

  it("切换 text id 时先关旧 text stream 再开新 text stream", async () => {
    _setDevModeCheck(() => false);

    const input: SidecarStreamPart[] = [
      { type: "text-delta", id: "thinking-1", delta: "hmm" },
      { type: "text-delta", id: "output-1", delta: "answer" },
      { type: "finish", id: "stream-1" },
    ];

    const stream = sidecarStreamToUIMessageStream(
      (async function* () {
        for (const p of input) yield p;
      })(),
    );

    const chunks = await readStream(stream);
    const types = chunks.map((c) => c.type);

    // 应该有 2 个 text-start（thinking-1 + output-1）和 2 个 text-end
    expect(types.filter((t) => t === "text-start").length).toBe(2);
    expect(types.filter((t) => t === "text-end").length).toBe(2);

    // text-start 的 id 应该按出现顺序: thinking-1, output-1
    const textStarts = chunks.filter((c) => c.type === "text-start") as Array<{
      type: "text-start";
      id: string;
    }>;
    expect(textStarts[0].id).toBe("thinking-1");
    expect(textStarts[1].id).toBe("output-1");
  });

  it("error part → finish-step + error（用 onError 格式化）", async () => {
    _setDevModeCheck(() => false);

    const input: SidecarStreamPart[] = [
      { type: "text-delta", id: "t1", delta: "partial" },
      { type: "error", error: "boom" },
    ];

    const stream = sidecarStreamToUIMessageStream(
      (async function* () {
        for (const p of input) yield p;
      })(),
      {
        onError: (e) => `[fmt] ${e instanceof Error ? e.message : String(e)}`,
      },
    );

    const chunks = await readStream(stream);
    const types = chunks.map((c) => c.type);

    // 应该: start → start-step → text-start → text-delta → text-end → finish-step → error
    expect(types[0]).toBe("start");
    expect(types).toContain("text-end");
    expect(types).toContain("finish-step");
    expect(types[types.length - 1]).toBe("error");

    const errChunk = chunks.find((c) => c.type === "error") as {
      type: "error";
      errorText: string;
    };
    expect(errChunk.errorText).toBe("[fmt] boom");
  });

  it("source 空结束（无 finish/error）→ 兜底 finish", async () => {
    _setDevModeCheck(() => false);

    const stream = sidecarStreamToUIMessageStream(
      (async function* () {
        // 空迭代
      })(),
    );

    const chunks = await readStream(stream);
    const types = chunks.map((c) => c.type);

    // 应该兜底: start → start-step → finish-step → finish
    expect(types).toEqual(["start", "start-step", "finish-step", "finish"]);
  });
});

describe("sidecarStreamToUIMessageStream — reasoning / 工具行 part 转换", () => {
  it("reasoning-delta → reasoning-start / reasoning-delta+ / reasoning-end", async () => {
    const input: SidecarStreamPart[] = [
      { type: "reasoning-delta", id: "r1", delta: "think" },
      { type: "reasoning-delta", id: "r1", delta: "ing" },
      { type: "finish", id: "s1" },
    ];
    const stream = sidecarStreamToUIMessageStream(
      (async function* () {
        for (const p of input) yield p;
      })(),
    );
    const chunks = await readStream(stream);
    const types = chunks.map((c) => c.type);

    expect(types).toContain("reasoning-start");
    expect(types.filter((t) => t === "reasoning-delta").length).toBe(2);
    expect(types).toContain("reasoning-end");
    // reasoning-end 必须在 finish 之前
    expect(types.indexOf("reasoning-end")).toBeLessThan(types.indexOf("finish"));
  });

  it("tool-input → dynamic tool-input-available（含 toolName/input）", async () => {
    const input: SidecarStreamPart[] = [
      {
        type: "tool-input",
        toolCallId: "t-1",
        toolName: "ssh_command",
        input: { command: "uptime" },
      },
      { type: "finish", id: "s1" },
    ];
    const stream = sidecarStreamToUIMessageStream(
      (async function* () {
        for (const p of input) yield p;
      })(),
    );
    const chunks = await readStream(stream);
    const toolChunk = chunks.find((c) => c.type === "tool-input-available") as {
      type: "tool-input-available";
      toolCallId: string;
      toolName: string;
      input: unknown;
      dynamic?: boolean;
    };
    expect(toolChunk).toBeDefined();
    expect(toolChunk.toolCallId).toBe("t-1");
    expect(toolChunk.toolName).toBe("ssh_command");
    expect(toolChunk.input).toEqual({ command: "uptime" });
    expect(toolChunk.dynamic).toBe(true);
  });

  it("tool-output（成功）→ tool-output-available；tool-output（错误）→ tool-output-error", async () => {
    const input: SidecarStreamPart[] = [
      {
        type: "tool-input",
        toolCallId: "t-1",
        toolName: "ssh_command",
        input: {},
      },
      {
        type: "tool-output",
        toolCallId: "t-1",
        toolName: "ssh_command",
        output: { stdout: "ok" },
        isError: false,
      },
      {
        type: "tool-input",
        toolCallId: "t-2",
        toolName: "sftp_read",
        input: {},
      },
      {
        type: "tool-output",
        toolCallId: "t-2",
        toolName: "sftp_read",
        output: "boom",
        isError: true,
      },
      { type: "finish", id: "s1" },
    ];
    const stream = sidecarStreamToUIMessageStream(
      (async function* () {
        for (const p of input) yield p;
      })(),
    );
    const chunks = await readStream(stream);
    const ok = chunks.find((c) => c.type === "tool-output-available") as {
      type: "tool-output-available";
      toolCallId: string;
      output: unknown;
    };
    expect(ok).toBeDefined();
    expect(ok.toolCallId).toBe("t-1");
    expect(ok.output).toEqual({ stdout: "ok" });

    const errChunk = chunks.find((c) => c.type === "tool-output-error") as {
      type: "tool-output-error";
      toolCallId: string;
      errorText: string;
    };
    expect(errChunk).toBeDefined();
    expect(errChunk.toolCallId).toBe("t-2");
    expect(errChunk.errorText).toBe("boom");
  });
});

describe("runSidecarStream — thinking 作为 reasoning part", () => {
  it("invoke 返回 thinking → yield reasoning-delta（不是 text-delta）", async () => {
    _setDevModeCheck(() => false);
    mockInvoke.mockResolvedValue({
      thinking: "let me think",
      output: "answer",
    });

    const parts = await collect(
      runSidecarStream({
        agentId: "main",
        messages: makeMessages("hi"),
        input: "hi",
        live: makeLive(),
      }),
    );
    const types = parts.map((p) => p.type);
    // thinking 走 reasoning-delta，output 走 text-delta
    expect(types).toContain("reasoning-delta");
    expect(types).toContain("text-delta");
    expect(types).toContain("finish");
    // reasoning 段应排在 text 段之前（reasoning → tools → text 顺序）
    const firstReasoning = types.indexOf("reasoning-delta");
    const firstText = types.indexOf("text-delta");
    expect(firstReasoning).toBeLessThan(firstText);
  });
});

describe("runSidecarStream — 孤儿 tool_call completed 事件忽略", () => {
  it("completed 无对应 started → 不产生 tool-output（防止 SDK 'No tool invocation found'）", async () => {
    _setDevModeCheck(() => false);
    const listeners = new Map<string, (e: unknown) => void>();
    vi.mocked(listen).mockImplementation(
      ((event: string, cb: (e: unknown) => void) => {
        listeners.set(event, cb);
        return Promise.resolve(() => {
          listeners.delete(event);
        });
      }) as never,
    );
    // 可控 invoke：先挂起，等事件触发后再 resolve，保证事件到达时 queue 未 close
    let resolveInvoke!: (v: unknown) => void;
    mockInvoke.mockImplementation(
      () =>
        new Promise((r) => {
          resolveInvoke = r;
        }),
    );

    const stream = runSidecarStream({
      agentId: "main",
      messages: makeMessages("hi"),
      input: "hi",
      live: makeLive(),
    });
    const iterator = stream[Symbol.asyncIterator]();
    // 启动执行（注册监听器 + 启动 invoke）
    const first = iterator.next();

    // 等监听器注册 + invoke 启动完成
    await vi.waitFor(() =>
      expect(listeners.has("sidecar:tool_call")).toBe(true),
    );
    await vi.waitFor(() => expect(typeof resolveInvoke).toBe("function"));
    const toolCallCb = listeners.get("sidecar:tool_call")!;

    // 孤儿 completed（无对应 started，模拟上轮 invoke 尾部事件迟到串台）
    toolCallCb({
      payload: {
        event_type: "tool_call",
        payload: { tool_name: "read_file", status: "completed", result: "ok" },
      },
    });
    resolveInvoke({ observation: "done", mood: "done" });

    const parts: SidecarStreamPart[] = [];
    parts.push((await first).value as SidecarStreamPart);
    for (;;) {
      const r = await iterator.next();
      if (r.done) break;
      parts.push(r.value);
    }

    // 孤儿 completed 被忽略：既无 tool-input 也无 tool-output
    // （原测试先发 started 再发 completed，两者配对成功会产出 tool-output——
    //   旧版因 queue shift 丢失 bug 假通过；P0-6 修复后改为纯孤儿场景）
    expect(parts.some((p) => p.type === "tool-input")).toBe(false);
    expect(parts.some((p) => p.type === "tool-output")).toBe(false);
  });
});

describe("runSidecarStream — agent 委派工具事件（P0-6）", () => {
  it("agent:teach started → tool-input part；completed → tool-output part", async () => {
    _setDevModeCheck(() => false);
    const listeners = new Map<string, (e: unknown) => void>();
    vi.mocked(listen).mockImplementation(
      ((event: string, cb: (e: unknown) => void) => {
        listeners.set(event, cb);
        return Promise.resolve(() => {
          listeners.delete(event);
        });
      }) as never,
    );
    let resolveInvoke!: (v: unknown) => void;
    mockInvoke.mockImplementation(
      () =>
        new Promise((r) => {
          resolveInvoke = r;
        }),
    );

    const stream = runSidecarStream({
      agentId: "main",
      messages: makeMessages("帮我讲 nginx"),
      input: "帮我讲 nginx",
      live: makeLive(),
    });
    const iterator = stream[Symbol.asyncIterator]();
    const first = iterator.next();

    await vi.waitFor(() =>
      expect(listeners.has("sidecar:tool_call")).toBe(true),
    );
    await vi.waitFor(() => expect(typeof resolveInvoke).toBe("function"));
    const toolCallCb = listeners.get("sidecar:tool_call")!;

    // main 委派 teach：started（含委派输入）
    toolCallCb({
      payload: {
        event_type: "tool_call",
        payload: {
          tool_name: "agent:teach",
          status: "started",
          params: { input: "讲一下 nginx" },
        },
      },
    });
    // completed（子 agent 全文）
    toolCallCb({
      payload: {
        event_type: "tool_call",
        payload: {
          tool_name: "agent:teach",
          status: "completed",
          result: "## 1. 概念\nnginx 是反向代理服务器",
        },
      },
    });
    resolveInvoke({ observation: "main 总结", mood: "done" });

    const parts: SidecarStreamPart[] = [];
    parts.push((await first).value as SidecarStreamPart);
    for (;;) {
      const r = await iterator.next();
      if (r.done) break;
      parts.push(r.value);
    }

    const toolInput = parts.find((p) => p.type === "tool-input") as
      | { type: "tool-input"; toolName: string; input: unknown }
      | undefined;
    expect(toolInput).toBeTruthy();
    expect(toolInput!.toolName).toBe("agent:teach");
    expect(toolInput!.input).toEqual({ input: "讲一下 nginx" });

    const toolOutput = parts.find((p) => p.type === "tool-output") as
      | { type: "tool-output"; toolName: string; output: unknown }
      | undefined;
    expect(toolOutput).toBeTruthy();
    expect(toolOutput!.toolName).toBe("agent:teach");
    expect(toolOutput!.output).toContain("nginx 是反向代理服务器");
  });
});

// ============================================================================
// v4.0 T9.2 前端契约：降级分档呈现（此前一律弹报错卡并丢弃后端中文说明）
// ============================================================================

describe("runSidecarStream — 可恢复降级走 assistant 正文", () => {
  // 后端四条可恢复降级：next_step=done + 中文 observation（对齐 adapter.py）
  const FRIENDLY_CASES: Array<[string, string]> = [
    ["invoke_watchdog_timeout", "AI 调用超时：模型超过 10 分钟没有输出，本轮已中止。"],
    ["invoke_stalled", "上一轮调用超时后仍在后台收尾，请稍等片刻再发消息。"],
    ["llm_transport_error", "模型服务连接异常，本轮已停止；你可以稍后重试。"],
    // P3 退避收口后限流会真的露出来，措辞要说"限流"而不是套连接异常那句
    ["llm_rate_limited", "模型服务正在限流，本轮已停止重试；请稍后再发。"],
  ];

  it.each(FRIENDLY_CASES)(
    "%s → observation 作为 text-delta 流出、无 error part、正常 finish",
    async (reason, observation) => {
      _setDevModeCheck(() => false);
      mockInvoke.mockResolvedValue({
        degraded: true,
        degraded_reason: reason,
        observation,
        mood: "error",
        next_step: "done",
      });

      const onMood = vi.fn();
      const parts = await collect(
        runSidecarStream({
          agentId: "main",
          messages: makeMessages("hi"),
          input: "hi",
          live: makeLive(),
          onMood,
        }),
      );

      const types = parts.map((p) => p.type);
      expect(types).not.toContain("error");
      expect(types).toContain("finish");
      const text = parts
        .filter((p) => p.type === "text-delta")
        .map((p) => (p as { delta: string }).delta)
        .join("");
      expect(text).toBe(observation);
      // 后端 mood 仍要透传（此前早退直接跳过 → pill 卡在思考中）
      expect(onMood).toHaveBeenCalledWith("error");
    },
  );

  it("llm_transport_error 优先展示 observation，不把原始异常文本给用户", async () => {
    _setDevModeCheck(() => false);
    mockInvoke.mockResolvedValue({
      degraded: true,
      degraded_reason: "llm_transport_error",
      degraded_message: "ConnectionError: [Errno 11001] getaddrinfo failed",
      observation: "模型服务连接异常，本轮已停止；你可以稍后重试。",
      mood: "error",
    });

    const parts = await collect(
      runSidecarStream({
        agentId: "main",
        messages: makeMessages("hi"),
        input: "hi",
        live: makeLive(),
      }),
    );

    const text = parts
      .filter((p) => p.type === "text-delta")
      .map((p) => (p as { delta: string }).delta)
      .join("");
    expect(text).toContain("模型服务连接异常");
    expect(text).not.toContain("getaddrinfo");
  });

  it("本轮已流出正文时，降级说明接在正文末尾且复用同一 text 段", async () => {
    _setDevModeCheck(() => false);
    const listeners = new Map<string, (e: unknown) => void>();
    vi.mocked(listen).mockImplementation(
      ((event: string, cb: (e: unknown) => void) => {
        listeners.set(event, cb);
        return Promise.resolve(() => {
          listeners.delete(event);
        });
      }) as never,
    );
    let resolveInvoke!: (v: unknown) => void;
    mockInvoke.mockImplementation(
      () =>
        new Promise((r) => {
          resolveInvoke = r;
        }),
    );

    const iterator = runSidecarStream({
      agentId: "main",
      messages: makeMessages("hi"),
      input: "hi",
      live: makeLive(),
    })[Symbol.asyncIterator]();
    const first = iterator.next();

    await vi.waitFor(() =>
      expect(listeners.has("sidecar:agent_message")).toBe(true),
    );
    await vi.waitFor(() => expect(typeof resolveInvoke).toBe("function"));
    listeners.get("sidecar:agent_message")!({
      payload: {
        event_type: "agent_message",
        payload: { type: "output", content: "已完成的半截回答" },
      },
    });
    resolveInvoke({
      degraded: true,
      degraded_reason: "invoke_watchdog_timeout",
      observation: "本轮已中止。",
      mood: "error",
    });

    const parts: SidecarStreamPart[] = [];
    parts.push((await first).value as SidecarStreamPart);
    for (;;) {
      const r = await iterator.next();
      if (r.done) break;
      parts.push(r.value);
    }

    const textParts = parts.filter(
      (p) => p.type === "text-delta",
    ) as Array<{ type: "text-delta"; id: string; delta: string }>;
    // 同一段（id 一致）→ 不会在 UI 上裂成两个气泡
    expect(new Set(textParts.map((p) => p.id)).size).toBe(1);
    const joined = textParts.map((p) => p.delta).join("");
    expect(joined).toBe("已完成的半截回答\n\n本轮已中止。");
    expect(parts.map((p) => p.type)).not.toContain("error");
  });
});

describe("runSidecarStream — 真实故障降级仍弹报错卡（分档建议）", () => {
  const ERROR_CASES: Array<[string, string]> = [
    ["strands_not_installed", "pip install strands-agents"],
    ["feature_flag_disabled", "TDSF_AGENT_BACKEND=strands"],
    ["strands_model_not_injected", "API Key"],
  ];

  it.each(ERROR_CASES)(
    "%s → 单个 error part + 原因专属行动建议",
    async (reason, expectedHint) => {
      _setDevModeCheck(() => false);
      mockInvoke.mockResolvedValue({
        degraded: true,
        degraded_reason: reason,
        degraded_message: `后端故障：${reason}`,
        mood: "done",
      });

      const parts = await collect(
        runSidecarStream({
          agentId: "main",
          messages: makeMessages("hi"),
          input: "hi",
          live: makeLive(),
        }),
      );

      expect(parts.length).toBe(1);
      expect(parts[0].type).toBe("error");
      const err = parts[0] as { type: "error"; error: string };
      expect(err.error).toContain(expectedHint);
      expect(err.error).toContain(`后端故障：${reason}`);
    },
  );

  it("只有 observation 无 degraded_message → 详情回退原文（不再显示空详情）", async () => {
    _setDevModeCheck(() => false);
    mockInvoke.mockResolvedValue({
      degraded: true,
      degraded_reason: "invoke_error",
      observation: "Strands Agent 执行出错: boom",
      mood: "error",
    });

    const parts = await collect(
      runSidecarStream({
        agentId: "main",
        messages: makeMessages("hi"),
        input: "hi",
        live: makeLive(),
      }),
    );

    const err = parts[0] as { type: "error"; error: string };
    expect(err.type).toBe("error");
    expect(err.error).toContain("Strands Agent 执行出错: boom");
    expect(err.error).toContain("详情：Strands Agent 执行出错: boom");
    expect(err.error).toContain("查看 sidecar 日志");
  });

  it("未知 degraded_reason → 回退通用建议（不静默丢信息）", async () => {
    _setDevModeCheck(() => false);
    mockInvoke.mockResolvedValue({
      degraded: true,
      degraded_reason: "brand_new_reason",
      degraded_message: "没见过的降级",
    });

    const parts = await collect(
      runSidecarStream({
        agentId: "main",
        messages: makeMessages("hi"),
        input: "hi",
        live: makeLive(),
      }),
    );

    const err = parts[0] as { type: "error"; error: string };
    expect(err.error).toContain("没见过的降级");
    expect(err.error).toContain("检查 Strands 依赖安装");
  });
});

describe("toolFailureText — 工具失败输出不再吐裸 JSON", () => {
  it("command_blocked 结果 → 状态标签 + 中文说明，剥掉 LLM 契约前缀", () => {
    const text = toolFailureText({
      status: "command_blocked",
      message: "command_blocked! 只读模式或安全规则禁止执行：命中硬底线黑名单。",
      risk: "L4",
      impact: { summary: "全盘删除" },
    });
    expect(text).toBe(
      "[command_blocked] 只读模式或安全规则禁止执行：命中硬底线黑名单。",
    );
    expect(text).not.toContain("impact");
  });

  it("error 状态不加 [error] 前缀（渲染处已是错误样式）", () => {
    expect(toolFailureText({ status: "error", error: "connection reset" })).toBe(
      "connection reset",
    );
  });

  it("字符串输出原样返回；无可用文本字段才回退 JSON", () => {
    expect(toolFailureText("boom")).toBe("boom");
    expect(toolFailureText(null)).toBe("");
    expect(toolFailureText({ exit_code: 1 })).toContain('"exit_code": 1');
  });
});

describe("buildSidecarErrorHint — degraded_reason 分档", () => {
  it("非降级路径不受 reason 影响（保持原特征分类）", () => {
    expect(buildSidecarErrorHint("Sidecar 调用超时（60s）", "main")).toContain(
      "AI 任务超时未完成",
    );
  });

  it("降级但 reason 未知 → 通用建议", () => {
    expect(buildSidecarErrorHint("x", "main", true, "weird")).toContain(
      "检查 Strands 依赖安装",
    );
  });
});

// ============================================================================
// #133 无活动计时器与「等用户确认」的联动
// ----------------------------------------------------------------------------
// 真机日志量到的原形状（.tdsf-data/agent-logs/s-mufeww1j-g9aiur.jsonl）：
//   tool_call → 静默 300.1s → tool_result(needs_approval)
// 审批窗口（Python 默认 300s）与前端无活动窗口（默认 300s）是同一个数，
// 于是"用户多想一会儿"＝"整轮被判超时"，而报错写着「简化问题描述后重试」。
// 下面三条钉住新口径：等用户的这段时间不记账；不等了重新给满整段；
// 文案不许再指向一个界面上根本不存在的设置项。
// ============================================================================
describe("runSidecarStream — 审批挂起不吃无活动预算（#133）", () => {
  // 把默认 300s 窗口压到可测的 10s（localStorage 覆盖是本仓既有配置入口）
  const WAIT_MS = 10_000;

  beforeEach(() => {
    localStorage.setItem("tdsf.sidecarTimeoutMs", String(WAIT_MS));
    useNeedsYouWait.getState().reset();
    // #143 的用例会把 listen 换成"注册成功"，逐条复位免得串到别的用例
    vi.mocked(listen).mockRejectedValue(new Error("not in tauri"));
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    localStorage.removeItem("tdsf.sidecarTimeoutMs");
    useNeedsYouWait.getState().reset();
  });

  /** 起一轮"invoke 永远不回"的调用，返回收集 promise + 手动结掉 invoke 的句柄 */
  function startHangingRound(sessionId = "sess-wait") {
    let settle: ((v: unknown) => void) | null = null;
    mockInvoke.mockImplementation(
      () => new Promise((resolve) => (settle = resolve)),
    );
    const collecting = collect(
      runSidecarStream({
        agentId: "main",
        sessionId,
        messages: makeMessages("查一下"),
        input: "查一下",
        live: makeLive(),
      }),
    );
    return {
      collecting,
      finish: (result: unknown) => settle?.(result),
    };
  }

  it("没有审批挂着一 → 到点仍然报无活动超时（重构没把原行为改掉）", async () => {
    _setDevModeCheck(() => false);
    const { collecting } = startHangingRound();
    await vi.advanceTimersByTimeAsync(WAIT_MS + 50);
    const parts = await collecting;

    const err = parts.find((p) => p.type === "error") as
      | { type: "error"; error: string }
      | undefined;
    expect(err?.error).toContain("无活动");
  });

  it("审批挂着 → 超过三个窗口也不掐断整轮（等用户不是卡死）", async () => {
    _setDevModeCheck(() => false);
    const { collecting, finish } = startHangingRound();

    useNeedsYouWait.getState().markPending("ny-1", "sess-wait");
    await vi.advanceTimersByTimeAsync(WAIT_MS * 3);
    finish({ output: "done" });
    await vi.advanceTimersByTimeAsync(100);
    const parts = await collecting;

    expect(parts.some((p) => p.type === "error")).toBe(false);
    expect(parts.some((p) => p.type === "finish")).toBe(true);
  });

  it("别的会话的审批不许给本会话停表（否则一条没人认领的请求让整轮永不过期）", async () => {
    _setDevModeCheck(() => false);
    const { collecting } = startHangingRound("sess-mine");

    useNeedsYouWait.getState().markPending("ny-other", "sess-other");
    await vi.advanceTimersByTimeAsync(WAIT_MS + 50);
    const parts = await collecting;

    expect(parts.some((p) => p.type === "error")).toBe(true);
  });

  it("用户答完（撤销记账）→ 重新给满一整段后才到点", async () => {
    _setDevModeCheck(() => false);
    const { collecting } = startHangingRound();
    // 每次推进都额外多走 100ms：万一真的报错了，把收尾的 TOOL_DRAIN_MS(30ms)
    // 也覆盖掉，让 collecting 结算完整，"还在跑"这件事才量得准。
    const drain = 100;

    // 先让预算烧掉大半，再看恢复后是"重新给满"还是"接着扣剩下的 200ms"
    await vi.advanceTimersByTimeAsync(WAIT_MS - 200);
    useNeedsYouWait.getState().markPending("ny-1", "sess-wait");
    await vi.advanceTimersByTimeAsync(WAIT_MS * 2 + drain);
    useNeedsYouWait.getState().markSettled("ny-1");
    await vi.advanceTimersByTimeAsync(WAIT_MS - 500 + drain);

    const early = await Promise.race([
      collecting.then(() => "done" as const),
      Promise.resolve("pending" as const),
    ]);
    expect(early).toBe("pending");

    await vi.advanceTimersByTimeAsync(500 + drain);
    const parts = await collecting;
    expect(parts.some((p) => p.type === "error")).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // #143 第二条合法等待：工具在跑。
  // started→completed 之间链路上本来就没有事件（loop_progress 是工具**结束后**才推），
  // 而一条命令被允许跑多久是模型声明的 timeout 决定的 —— 实测最坏合法静默 500s，
  // 而窗口只有 300s（真机 79 次配对里最长已经到 259.6s）。
  // ---------------------------------------------------------------------------

  /** 把 sidecar:tool_call 的回调捞出来（其余事件仍走"listen 失败"的降级路径） */
  function hookToolCallEvents() {
    const listeners = new Map<string, (event: unknown) => void>();
    vi.mocked(listen).mockImplementation(
      ((event: string, callback: (event: unknown) => void) => {
        listeners.set(event, callback);
        return Promise.resolve(() => listeners.delete(event));
      }) as never,
    );
    return (payload: Record<string, unknown>) => {
      const emit = listeners.get("sidecar:tool_call");
      if (!emit) throw new Error("sidecar:tool_call 监听器没注册上（用例量的是空气）");
      emit({
        payload: {
          event_type: "tool_call",
          session_id: "sess-tool",
          payload,
        },
      });
    };
  }

  it("工具在飞（started 到了、completed 没回）→ 超过三个窗口也不掐断", async () => {
    _setDevModeCheck(() => false);
    const emit = hookToolCallEvents();
    const { collecting, finish } = startHangingRound("sess-tool");
    await vi.advanceTimersByTimeAsync(0); // 让监听器注册完

    emit({
      tool_name: "ssh_command",
      tool_call_id: "a",
      status: "started",
      params: { command: "yum update -y", timeout: 300 },
    });
    await vi.advanceTimersByTimeAsync(WAIT_MS * 3);
    expect(await settleOrPending(collecting)).toBe("pending");

    finish({ output: "done" });
    await vi.advanceTimersByTimeAsync(100);
    const parts = await collecting;
    expect(parts.some((p) => p.type === "error")).toBe(false);
    expect(parts.some((p) => p.type === "finish")).toBe(true);
  });

  it("配对要正反都量：工具落地之后重新开始记账，再静默到点仍然报超时", async () => {
    _setDevModeCheck(() => false);
    const emit = hookToolCallEvents();
    const { collecting } = startHangingRound("sess-tool");
    await vi.advanceTimersByTimeAsync(0);

    emit({
      tool_name: "ssh_command",
      tool_call_id: "a",
      status: "started",
      params: { command: "uptime", timeout: 30 },
    });
    // 先吃掉大半段窗口，证明停表期间旧的账没在偷偷走
    await vi.advanceTimersByTimeAsync(WAIT_MS - 200);
    emit({
      tool_name: "ssh_command",
      tool_call_id: "a",
      status: "completed",
      result: { status: "success", stdout: "up 3 days" },
    });
    await vi.advanceTimersByTimeAsync(WAIT_MS - 500);
    expect(await settleOrPending(collecting)).toBe("pending");

    await vi.advanceTimersByTimeAsync(500 + 100);
    const parts = await collecting;
    expect(parts.some((p) => p.type === "error")).toBe(true);
  });
});

/** 结算了没有？给"还在跑"这件事一个可断言的读数（不靠 sleep 猜） */
function settleOrPending(collecting: Promise<unknown>) {
  return Promise.race([
    collecting.then(() => "done" as const),
    Promise.resolve("pending" as const),
  ]);
}

describe("buildSidecarErrorHint — 超时文案不再指向不存在的设置（#133）", () => {
  it("正在等用户确认时超时 → 说清是在等他，而不是让他简化问题", () => {
    const hint = buildSidecarErrorHint("ipc 调用超时", "main", false, "", true);
    expect(hint).toContain("等你确认");
    expect(hint).not.toContain("简化问题描述");
  });

  it("普通无活动超时 → 说明真实含义，且不给界面上没有的入口", () => {
    const hint = buildSidecarErrorHint(
      "Sidecar 调用超时（300s 无活动）",
      "main",
    );
    expect(hint).toContain("AI 任务超时未完成");
    // 「到设置调大 AI 调用超时」这条建议指向的控件在设置里根本不存在
    // （tdsf.sidecarTimeoutMs 只能手改 localStorage）——不许再这么写
    expect(hint).not.toContain("到设置");
    expect(hint).not.toContain("简化问题描述");
  });
});

// ============================================================================
// #133 接线断言：订阅必须随整轮释放
// ----------------------------------------------------------------------------
// 行为用例能证明"停表了"，证明不了"这一轮结束后订阅还在不在"。
// subscribeAwaitingUser 挂在 zustand 全局 store 上，而 runSidecarStream
// 每发一条消息就跑一遍 —— 漏一次 unsub 就是每轮泄一个监听器，
// 症状要几百条消息之后才看得见（同 #119 那条"实现了但没接上"只能靠读源码钉）。
// ============================================================================
describe("#133 接线：等待订阅随整轮释放", () => {
  const src = readFileSync(join(__dirname, "sidecar-adapter.ts"), "utf8");

  it("disposeActivityTimeout 里必须 unsubAwaitingUser", () => {
    // lastIndexOf：`let disposeActivityTimeout = () => {};` 那行声明也含同一串前缀
    const at = src.lastIndexOf("disposeActivityTimeout = () => {");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 260)).toMatch(/unsubAwaitingUser\(\)/);
  });

  it("流式事件走 noteActivity（旧的 resetTimeout 不许留在原地装作还在）", () => {
    expect(src).toMatch(/noteActivity\(\);/);
    expect(src).not.toMatch(/resetTimeout/);
  });
});
