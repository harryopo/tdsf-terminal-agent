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
        agentId: "coder",
        messages: makeMessages("hello"),
        input: "hello",
      }),
    );

    // 应该只有 error，没有 text-delta / finish
    expect(parts.length).toBe(1);
    expect(parts[0].type).toBe("error");
    const err = parts[0] as { type: "error"; error: string };
    expect(err.error).toContain("sidecar not running");
    // 错误提示应包含解决建议
    expect(err.error).toContain("LLM 未配置");
  });

  it("生产模式 + invoke 失败 → yield error（不降级）", async () => {
    // 确保生产模式：_devModeCheck() 返回 false，触发 error 路径（不降级到 mock）
    _setDevModeCheck(() => false);

    mockInvoke.mockRejectedValue(new Error("sidecar not running"));

    const parts = await collect(
      runSidecarStream({
        agentId: "coder",
        messages: makeMessages("hello"),
        input: "hello",
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
  it("coder → 调用 invoke 时 params.name 应为 'coding'", async () => {
    _setDevModeCheck(() => false);

    mockInvoke.mockResolvedValue({ output: "done" });

    await collect(
      runSidecarStream({
        agentId: "coder",
        messages: makeMessages("test"),
        input: "test",
      }),
    );

    expect(mockInvoke).toHaveBeenCalledWith("ipc_invoke", {
      method: "agent.invoke",
      params: {
        name: "coding",
        state: { input: "test", messages: makeMessages("test") },
      },
    });
  });

  it("explore → params.name='explore'", async () => {
    _setDevModeCheck(() => false);
    mockInvoke.mockResolvedValue({ output: "ok" });

    await collect(
      runSidecarStream({
        agentId: "explore",
        messages: makeMessages("scan"),
        input: "scan",
      }),
    );

    const call = mockInvoke.mock.calls[0];
    expect(call[1].params.name).toBe("explore");
  });

  it("history → params.name='history'", async () => {
    _setDevModeCheck(() => false);
    mockInvoke.mockResolvedValue({ output: "ok" });

    await collect(
      runSidecarStream({
        agentId: "history",
        messages: makeMessages("last"),
        input: "last",
      }),
    );

    const call = mockInvoke.mock.calls[0];
    expect(call[1].params.name).toBe("history");
  });

  it("teach → params.name='teach'", async () => {
    _setDevModeCheck(() => false);
    mockInvoke.mockResolvedValue({ output: "ok" });

    await collect(
      runSidecarStream({
        agentId: "teach",
        messages: makeMessages("explain"),
        input: "explain",
      }),
    );

    const call = mockInvoke.mock.calls[0];
    expect(call[1].params.name).toBe("teach");
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
        agentId: "coder",
        messages: makeMessages("hi"),
        input: "hi",
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
        agentId: "teach",
        messages: makeMessages("q"),
        input: "q",
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
