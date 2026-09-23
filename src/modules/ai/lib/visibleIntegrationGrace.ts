/**
 * #113③（2026-09-23）：远端 shell 没有 OSC 块时的判定。
 *
 * 可见终端执行靠远端 shell integration（Rust 注入的 `BASH_INTEGRATION_SCRIPT`，
 * 发 OSC 133 A/B/C/D + 633;E/P）结算。bash/zsh 以外的 shell、DEBUG trap 被
 * extdebug 占用、或用户把 PROMPT_COMMAND 整个接管时，**一个块都不会来** ——
 * 旧行为是白等到超时再报"状态未知"。
 *
 * 判据只用一个事实：命令已注入终端之后，有没有看到过"命令开始执行"标记
 * （133;C / 633;E）。看到过就说明集成活着，只是命令本身慢，继续等；
 * 没看到过才认定这台机器的 shell 不回报，改道后台 exec 去拿真结果。
 *
 * 为什么以 `injectedAt` 为锚而不是发送时刻：打字机模式逐字注入，长命令本身
 * 就要好几秒，从请求时刻算会把"还在打字"误判成"shell 没反应"。
 */

/** 注入后等待"命令开始执行"标记的宽限期 */
export const VISIBLE_INTEGRATION_GRACE_MS = 8_000;

export function shouldRerouteForMissingIntegration(input: {
  /** 现在的墙钟（同 Date.now 基准） */
  now: number;
  /** 命令写进终端的时刻；null = 还没注入 */
  injectedAt: number | null;
  /** 该 leaf 最近一次"命令开始执行"标记时刻；undefined = 从未见过 */
  lastExecStartedAt: number | undefined;
  graceMs?: number;
}): boolean {
  const { now, injectedAt, lastExecStartedAt } = input;
  if (injectedAt === null) return false;
  if (now - injectedAt < (input.graceMs ?? VISIBLE_INTEGRATION_GRACE_MS)) {
    return false;
  }
  return (
    lastExecStartedAt === undefined || lastExecStartedAt < injectedAt
  );
}
