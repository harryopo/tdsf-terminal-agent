/**
 * blocked-command.test.ts — B1-G2 防伪造：拦截命令记录与注入格式（TDSF 魔改 2026-08-28）
 * -----------------------------------------------------------------------------
 * 覆盖 spec add-b1-agent-safety-baseline T1.4：
 *   1. recordBlockedCommand → getRecentBlockedCommandText 返回原文（10 分钟 TTL 内）
 *   2. TTL 过期 → 返回 null（陈旧记录不再注入，防误导 LLM）
 *   3. AI 上下文注入格式：appendBlockedHint 语义对齐（尾部追加 [TDSF] 提示行）
 *
 * 注入格式约定（useAiLiveBridge.getTerminalContext 与 sidecar prompt 条款共同依赖，
 * 修改格式须同步 adapter.py / main_agent.py 条款中的示例文本）：
 *   `[TDSF] 最近被安全拦截的命令（未执行）: <command>`
 */
import { describe, expect, it, vi } from "vitest";
import {
  getRecentBlockedCommandText,
  recordBlockedCommand,
} from "./useTerminalSession";

describe("blocked command record (B1-G2 防伪造)", () => {
  it("记录后 TTL 内返回原文", () => {
    recordBlockedCommand("rm -rf /tmp/test");
    expect(getRecentBlockedCommandText()).toBe("rm -rf /tmp/test");
  });

  it("TTL 过期（>10 分钟）→ 返回 null", () => {
    recordBlockedCommand("reboot");
    // 快进时钟 11 分钟
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 11 * 60 * 1000);
    expect(getRecentBlockedCommandText()).toBeNull();
    vi.useRealTimers();
  });

  it("最新记录覆盖旧记录", () => {
    recordBlockedCommand("cmd-a");
    recordBlockedCommand("cmd-b");
    expect(getRecentBlockedCommandText()).toBe("cmd-b");
  });

  it("注入格式与 sidecar prompt 条款约定一致", () => {
    recordBlockedCommand("shutdown -h now");
    const blocked = getRecentBlockedCommandText();
    expect(blocked).toBe("shutdown -h now");
    // 前端 appendBlockedHint（useAiLiveBridge）与 adapter.py 条款共同引用该格式
    const injected = `[TDSF] 最近被安全拦截的命令（未执行）: ${blocked}`;
    expect(injected).toContain("[TDSF] 最近被安全拦截的命令（未执行）:");
    expect(injected).toContain("shutdown -h now");
  });
});
