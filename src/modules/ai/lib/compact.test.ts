import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";
import { compactModelMessages, compactModelMessagesDetailed } from "./compact";

const BIG = "x".repeat(2000);

function readCall(id: string, path: string): ModelMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: id,
        toolName: "read_file",
        input: { path },
      },
    ],
  } as unknown as ModelMessage;
}

function readResult(id: string, value: string): ModelMessage {
  return {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: id, output: { type: "text", value } },
    ],
  } as unknown as ModelMessage;
}

function writeCall(id: string, path: string): ModelMessage {
  return {
    role: "assistant",
    content: [
      {
        type: "tool-call",
        toolCallId: id,
        toolName: "write_file",
        input: { path },
      },
    ],
  } as unknown as ModelMessage;
}

function outputOf(message: ModelMessage): { __elided?: boolean } {
  const parts = message.content as Array<{ output?: { __elided?: boolean } }>;
  return parts[0].output ?? {};
}

function isElided(message: ModelMessage): boolean {
  return outputOf(message).__elided === true;
}

describe("compactModelMessagesDetailed", () => {
  it("returns the input untouched when it fits the context budget", () => {
    const messages = [{ role: "user", content: "hi" }] as ModelMessage[];
    const result = compactModelMessagesDetailed(messages, 1000);
    expect(result.compacted).toBe(false);
    expect(result.messages).toBe(messages);
  });

  it("elides a read result once its file has been written", () => {
    const messages = [
      readCall("c1", "/a.txt"),
      readResult("c1", BIG),
      writeCall("c2", "/a.txt"),
      { role: "user", content: BIG } as ModelMessage,
    ];
    const result = compactModelMessagesDetailed(messages, 1000);
    expect(result.compacted).toBe(true);
    expect(isElided(result.messages[1])).toBe(true);
  });

  it("keeps the latest read of a path and elides the superseded one", () => {
    const messages = [
      readCall("c1", "/a.txt"),
      readResult("c1", BIG),
      readCall("c2", "/a.txt"),
      readResult("c2", BIG),
      { role: "user", content: BIG } as ModelMessage,
    ];
    // tokens ≈ 1552 → limit 1700 → ratio ≈ 0.91（L3：superseded elide + 最新 read 保留）
    const result = compactModelMessagesDetailed(messages, 1700);
    expect(isElided(result.messages[1])).toBe(true);
    expect(isElided(result.messages[3])).toBe(false);
  });

  it("does not elide superseded reads while under the budget", () => {
    const messages = [
      readCall("c1", "/a.txt"),
      readResult("c1", "tiny"),
      readCall("c2", "/a.txt"),
      readResult("c2", "tiny"),
    ];
    const result = compactModelMessagesDetailed(messages, 100_000);
    expect(result.compacted).toBe(false);
    expect(isElided(result.messages[1])).toBe(false);
  });

  it("is idempotent: re-running does not re-elide an already-elided result", () => {
    const messages = [
      readCall("c1", "/a.txt"),
      readResult("c1", BIG),
      writeCall("c2", "/a.txt"),
      { role: "user", content: BIG } as ModelMessage,
    ];
    const once = compactModelMessagesDetailed(messages, 1000);
    const twice = compactModelMessagesDetailed(once.messages, 1000);
    expect(twice.compacted).toBe(false);
    expect(isElided(twice.messages[1])).toBe(true);
  });
});

describe("compactModelMessages", () => {
  it("returns the messages array from the detailed result", () => {
    const messages = [{ role: "user", content: "hi" }] as ModelMessage[];
    expect(compactModelMessages(messages, 1000)).toBe(messages);
  });
});

describe("5 级 compaction（P1-v5-3）", () => {
  function messages(n: number, size = 4000) {
    return Array.from({ length: n }, () => ({
      role: "user" as const,
      content: size > 0 ? "z".repeat(size) : "",
    }));
  }

  it("低占比 → level 0（不压缩）", () => {
    const r = compactModelMessagesDetailed(messages(2, 100), 1_000_000);
    expect(r.level).toBe(0);
    expect(r.compacted).toBe(false);
  });

  it("55-70% → level 1", () => {
    // 2 条 4000 字符 ≈ 2000 tokens；contextLimit 3000 → ratio ≈ 0.67
    const r = compactModelMessagesDetailed(messages(2), 3000);
    expect(r.level).toBe(1);
  });

  it("70-85% → level 2（仅超大 tool-result 被 elide）", () => {
    const msgs = [
      { role: "user", content: "z".repeat(3000) },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "t1", toolName: "ssh_command", input: { command: "uptime" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool-result", toolCallId: "t1", output: { value: "z".repeat(3000) } }],
      },
    ] as ModelMessage[];
    // ≈ 1520 tokens；limit 2000 → ratio ≈ 0.76（L2：超大 tool-result elide）
    const r = compactModelMessagesDetailed(msgs, 2000);
    expect(r.level).toBe(2);
    // 超大 tool-result 被 elide
    const toolResult = (r.messages[2].content as Array<{ output?: { __elided?: boolean } }>)[0];
    expect(toolResult.output?.__elided).toBe(true);
  });

  it("85-95% → level 3（全部 tool-result elide）", () => {
    const msgs = [
      { role: "user", content: "z".repeat(4000) },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "t1", toolName: "read_file", input: { path: "/x" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool-result", toolCallId: "t1", output: { value: "ok" } }],
      },
    ] as ModelMessage[];
    // ≈ 4000/4 + 小部分 ≈ 1030 tokens；limit 1100 → ratio ≈ 0.94
    const r = compactModelMessagesDetailed(msgs, 1100);
    expect(r.level).toBe(3);
  });

  it("95-105% → level 4（旧文本截断）", () => {
    const msgs = messages(6, 4000);
    // ≈ 6*1000 = 6000 tokens；limit 6000 → ratio = 1.0
    const r = compactModelMessagesDetailed(msgs, 6000);
    expect(r.level).toBe(4);
  });

  it(">105% → level 5（极端兜底保留尾部+摘要）", () => {
    const msgs = messages(20, 4000);
    // ≈ 20*1000 = 20000 tokens；limit 15000 → ratio ≈ 1.33
    const r = compactModelMessagesDetailed(msgs, 15000);
    expect(r.level).toBe(5);
    expect(r.messages.length).toBeLessThanOrEqual(13); // 1 摘要 + 12 尾部
    expect(r.messages[0].content).toContain("早期对话摘要");
  });
});
