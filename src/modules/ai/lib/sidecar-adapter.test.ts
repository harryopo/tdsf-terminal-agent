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
  runSidecarStream,
  type SidecarStreamPart,
  sidecarStreamToUIMessageStream,
} from "./sidecar-adapter";

const mockInvoke = invoke as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockInvoke.mockReset();
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

// TDSF 魔改 2026-07-30 (Bug 5): runSidecarStream 新增必填 live 字段
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
  it("dev 模式 + invoke 失败 → yield error（TDSF 魔改 P0-3: 移除 mock 降级）", async () => {
    // TDSF 魔改 P0-3: 原 mock 降级会让用户误以为 AI 在工作（[mock:coding]），
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
  });

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
        messages: makeMessages("test"),
        input: "test",
        live,
      }),
    );

    // TDSF 魔改 2026-07-30 (Bug 5): state 现在含 live 字段
    // P0-3: invoke 额外携带 timeoutMs（可配置超时，默认 60000）
    // v3.1 收敛: 旧 coder/explore/history/teach → coding/explore/history/teach
    // 的映射已随子 agent 委派机制删除，TDSF_AGENTS 仅 main 一项。
    expect(mockInvoke).toHaveBeenCalledWith("ipc_invoke", {
      method: "agent.invoke",
      params: {
        name: "main",
        state: { input: "test", messages: makeMessages("test"), live },
      },
      timeoutMs: 60000,
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
      tokens: { input: 10, output: 5 },
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
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 10, outputTokens: 5 });

    // onStep 应该被多次调用（"调用 Sidecar Agent" → "Thinking" → "Streaming" → null）
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
