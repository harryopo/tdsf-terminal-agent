/**
 * errorExplainStore.test.ts — B1-G3 报错解释节流与输入构造（TDSF 魔改 2026-08-28）
 * -----------------------------------------------------------------------------
 * 覆盖 spec add-b1-agent-safety-baseline T4.5：
 *   1. 全局单飞行：streaming 期间新请求被忽略
 *   2. 同块复用：done 后同块重复点击不重发
 *   3. 输入构造：tail 2KB 截断 + redactSensitive 脱敏后才进 LLM
 *   4. teachAgentEnabled=false → isExplainEnabled() false（按钮不渲染）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// mock sidecar-adapter：捕获每次调用的 input，可编程输出
const calls: Array<{ agentId: string; input: string }> = [];
let streamScript: "done" | "hang" = "done";

vi.mock("@/modules/ai/lib/sidecar-adapter", () => ({
  runSidecarStream: (opts: { agentId: string; input: string }) => {
    calls.push({ agentId: opts.agentId, input: opts.input });
    return (async function* () {
      if (streamScript === "done") {
        yield { type: "text-delta", id: "t", delta: "权限不足" };
        yield { type: "finish" };
      } else {
        // hang：等待 abort，模拟长时间流式
        await new Promise(() => {});
      }
    })();
  },
}));

import { useErrorExplainStore } from "./errorExplainStore";

const S = () => useErrorExplainStore.getState();

describe("errorExplainStore (B1-G3)", () => {
  beforeEach(() => {
    streamScript = "done";
    useErrorExplainStore.setState({
      blockId: null,
      status: "idle",
      text: "",
      error: null,
      requested: new Set(),
    });
    calls.length = 0;
  });

  it("正常请求：main agent（v3.1 收敛）+ explain-error 输入 + 完成态", async () => {
    await S().request({
      blockId: "b1",
      command: "systemctl status nginx",
      exitCode: 3,
      tail: "Unit nginx.service could not be found.",
    });
    expect(calls).toHaveLength(1);
    // v3.1: teach 子 agent 已删除，唯一入口 main
    expect(calls[0].agentId).toBe("main");
    expect(calls[0].input).toContain("explain-error:");
    expect(calls[0].input).toContain("systemctl status nginx");
    expect(calls[0].input).toContain("退出码: 3");
    expect(S().status).toBe("done");
    expect(S().text).toBe("权限不足");
  });

  it("全局单飞行：streaming 期间新请求被忽略", async () => {
    streamScript = "hang";
    const p1 = S().request({ blockId: "b1", command: "c1", exitCode: 1, tail: "" });
    // 等第一次调用真正发出（store 先 set streaming 再 await import 动态模块，
    // 所以不能只看 status——必须等 mock 被调用）
    await vi.waitFor(() => expect(calls.length).toBe(1));
    await S().request({ blockId: "b2", command: "c2", exitCode: 1, tail: "" });
    expect(calls).toHaveLength(1);
    expect(S().blockId).toBe("b1");
    // 清理：hang 的流没有 finish，测试结束前无需 abort（未持有的 promise 不阻塞）
    void p1;
  });

  it("同块复用：done 后同块重复点击不重发", async () => {
    await S().request({ blockId: "b1", command: "c", exitCode: 1, tail: "" });
    expect(calls).toHaveLength(1);
    await S().request({ blockId: "b1", command: "c", exitCode: 1, tail: "" });
    expect(calls).toHaveLength(1);
    // 不同块仍会发
    await S().request({ blockId: "b2", command: "c", exitCode: 1, tail: "" });
    expect(calls).toHaveLength(2);
  });

  it("tail 超 2KB 截断为尾部 2048 字符", async () => {
    const longTail = "a".repeat(3000) + "TOKEN_SECRET_END";
    await S().request({ blockId: "b1", command: "c", exitCode: 1, tail: longTail });
    const input = calls[0].input;
    // 尾部保留：最后 2048 字符包含 TOKEN_SECRET_END
    expect(input).toContain("TOKEN_SECRET_END");
    // 头部被截断
    expect(input).not.toContain("a".repeat(2500));
  });

  it("tail 中的敏感值被脱敏后才进 LLM", async () => {
    await S().request({
      blockId: "b1",
      command: "echo",
      exitCode: 1,
      tail: "password=hunter2hunter2 leaked",
    });
    const input = calls[0].input;
    expect(input).not.toContain("hunter2hunter2");
    expect(input).toContain("<REDACTED>");
  });

  it("isExplainEnabled 跟随 teachAgentEnabled", async () => {
    const { isExplainEnabled } = await import("./errorExplainStore");
    const { usePreferencesStore } = await import(
      "@/modules/settings/preferences"
    );
    expect(isExplainEnabled()).toBe(true); // 默认开启
    usePreferencesStore.setState({ teachAgentEnabled: false });
    expect(isExplainEnabled()).toBe(false);
    usePreferencesStore.setState({ teachAgentEnabled: true });
  });
});
