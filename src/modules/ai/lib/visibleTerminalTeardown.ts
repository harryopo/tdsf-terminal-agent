/**
 * #119（2026-09-23）：可见终端的请求被界面自己丢掉时，**怎么结算**由这里唯一决定。
 *
 * 实测现场：一条命令已经进了可见终端，紧接着界面整页重载（rust.log 里
 * `rust-emit req=vt-5` 之后再没有 `resolve`）。前端闭包里的待回执台账随 JS 上下文
 * 一起消失，Rust 只能白等到自己的传输预算耗尽 —— 用户看到的是"卡很久然后说没执行"。
 *
 * 这里只回答一个问题：**界面没了，不等于命令没跑**。所以按"字节有没有已经写进终端"
 * 分两档，口径与 visibleTerminalGate 一致——未执行的直说未执行，结果拿不回的绝不猜。
 */

export type AbandonedVisibleExecutionCause = "bridge-reset" | "page-unload";

export type AbandonedVisibleExecutionResult = {
  status: string;
  reason: string;
  message: string;
};

export function resultForAbandonedVisibleExecution(input: {
  phase: "typing" | "running";
  cause: AbandonedVisibleExecutionCause;
}): AbandonedVisibleExecutionResult {
  const reason =
    input.cause === "page-unload"
      ? "visible_terminal_page_reloaded"
      : "visible_terminal_bridge_reset";
  if (input.phase === "typing") {
    return {
      status: "unavailable",
      reason,
      message:
        "命令还没写进终端，界面就刷新／重挂了，这条命令未执行。" +
        "需要它的话，等界面稳定后让我再执行一次。",
    };
  }
  return {
    status: "indeterminate",
    reason,
    message:
      "命令已经写进终端，但界面在结果回来前刷新／重挂了，退出码取不回。" +
      "它可能仍在终端里跑到结束，请先看终端输出再决定下一步。",
  };
}
