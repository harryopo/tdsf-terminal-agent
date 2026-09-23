import { describe, expect, it } from "vitest";

import {
  resultForAbandonedVisibleExecution,
  type AbandonedVisibleExecutionCause,
} from "./visibleTerminalTeardown";

/**
 * #119（2026-09-23）实测现场：Agent 一条命令进了可见终端，紧接着界面被整页重载
 * （rust.log：16:12:44 `rust-emit req=vt-5`，16:12:52 同一条 leaf 换成了新会话 id=6，
 * 而 vt-5 始终没有 `resolve`）。Rust 白等满 200 秒，Python 的 ipc 计时器在同一秒
 * 先炸 ⇒ 模型只拿到 `ipc_invoke_exception`，用户看到的是"卡住很久然后说没执行"。
 *
 * 这里钉的是**结算口径**：界面没了 ≠ 命令没跑。所以必须按"命令有没有已经写进终端"
 * 分两档，并且每一档都要像 #118 那样把"执行了没有 / 该怎么办"说人话。
 */

const CAUSES: AbandonedVisibleExecutionCause[] = ["bridge-reset", "page-unload"];

describe("可见终端在飞请求被丢弃时的结算", () => {
  it("命令还没写进终端 → unavailable（诚实：确实没执行，可以让模型重来）", () => {
    for (const cause of CAUSES) {
      const r = resultForAbandonedVisibleExecution({phase: "typing", cause});
      expect(r.status, cause).toBe("unavailable");
      expect(r.message, cause).toContain("未执行");
    }
  });

  it("命令已经写进终端 → indeterminate（不许假装没执行，也不许猜成功）", () => {
    for (const cause of CAUSES) {
      const r = resultForAbandonedVisibleExecution({phase: "running", cause});
      expect(r.status, cause).toBe("indeterminate");
      expect(r.message, cause).toContain("可能仍在终端");
    }
  });

  it("两种 phase 必须落在不同 status（否则'分档'是假的）", () => {
    expect(
      resultForAbandonedVisibleExecution({phase: "typing", cause: "page-unload"})
        .status,
    ).not.toBe(
      resultForAbandonedVisibleExecution({phase: "running", cause: "page-unload"})
        .status,
    );
  });

  it("reason 要能区分是谁丢的：界面重载 vs 桥重挂", () => {
    expect(
      resultForAbandonedVisibleExecution({phase: "typing", cause: "page-unload"})
        .reason,
    ).toBe("visible_terminal_page_reloaded");
    expect(
      resultForAbandonedVisibleExecution({phase: "typing", cause: "bridge-reset"})
        .reason,
    ).toBe("visible_terminal_bridge_reset");
  });

  it("每条都要给出下一步动作（用户/模型照着做就行）", () => {
    for (const phase of ["typing", "running"] as const) {
      for (const cause of CAUSES) {
        const r = resultForAbandonedVisibleExecution({phase, cause});
        expect(r.message.length).toBeGreaterThan(20);
        expect(r.message, `${phase}/${cause}`).toMatch(
          /再执行一次|先看终端输出/,
        );
      }
    }
  });
});
