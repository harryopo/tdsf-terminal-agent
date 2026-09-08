import type { UIMessage } from "@ai-sdk/react";
import { describe, expect, it } from "vitest";
import { contextBreakdownRows } from "../lib/contextUsage";

describe("contextBreakdownRows", () => {
  it("does not zero later categories when provider usage is below estimates", () => {
    const messages = [
      {
        id: "m1",
        role: "user",
        parts: [{ type: "text", text: "x".repeat(400) }],
      },
    ] as UIMessage[];
    const rows = contextBreakdownRows(messages, 2600);

    expect(rows.reduce((sum, row) => sum + row.tokens, 0)).toBe(2600);
    expect(rows.find((row) => row.label === "工具定义")?.tokens).toBeGreaterThan(0);
    expect(rows.find((row) => row.label === "系统提示词")?.tokens).toBeGreaterThan(0);
    expect(rows.find((row) => row.label === "技能")?.tokens).toBeGreaterThan(0);
  });
});
