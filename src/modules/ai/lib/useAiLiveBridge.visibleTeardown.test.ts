import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * #119（2026-09-23）接线门禁：结算口径写在 visibleTerminalTeardown.ts 里，
 * 但**桥真的在两个离场时刻叫它**才是修复本身。
 *
 * 实测现场：一条命令进了可见终端后界面整页重载，Rust 侧只有 `rust-emit req=vt-5`
 * 没有 `resolve`，白等 200 秒。原因在前端 effect 的清理函数里 —— 它把待回执台账
 * `pendingVisibleExecutions.clear()` 一清了之，从不回话（`settleVisibleExecution`
 * 开头是 `if (!map.delete(id)) return`，所以清完连超时回调都变哑）。
 *
 * 所以这里钉的不是"有没有这段代码"，而是"还有没有静默丢弃这条路"：
 * 只要 `clear()` 还在，台账就又可以在不回话的情况下被抹掉。
 */

const SOURCE = readFileSync(
  join(__dirname, "useAiLiveBridge.ts"),
  "utf8",
);

/** 只取代码行：注释里出现 "clear()" 这类字样不能算进断言。 */
function codeLines(source: string): string {
  return source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
}

const CODE = codeLines(SOURCE);

describe("可见终端离场结算的接线（#119）", () => {
  it("不许再静默清空台账：唯一退出路径是逐条回话", () => {
    expect(CODE).not.toContain("pendingVisibleExecutions.clear()");
  });

  it("离场结算收成一个带 cause 的函数（两个时刻共用一份口径）", () => {
    expect(CODE).toMatch(
      /const abandonPendingVisibleExecutions = \(\s*cause: AbandonedVisibleExecutionCause/,
    );
    expect(CODE).toContain("resultForAbandonedVisibleExecution");
  });

  it("两个离场时刻都得叫它：effect 清理 + 页面卸载", () => {
    const calls = [...CODE.matchAll(/abandonPendingVisibleExecutions\("/g)].map(
      (m) => m[0],
    );
    expect(calls).toHaveLength(2);
    expect(CODE).toContain('abandonPendingVisibleExecutions("bridge-reset")');
    expect(CODE).toContain('abandonPendingVisibleExecutions("page-unload")');
  });

  it("卸载监听要成对注册与注销（漏注销会随每次重挂累加）", () => {
    expect(CODE).toContain('addEventListener("pagehide"');
    expect(CODE).toContain('removeEventListener("pagehide"');
    expect(
      [...CODE.matchAll(/addEventListener\("pagehide"/g)].length,
    ).toBeLessThanOrEqual(1);
  });

  it("每条在飞请求都要带上自己那份 phase 去结算（两档口径不许塌成一档）", () => {
    expect(CODE).toMatch(
      /resultForAbandonedVisibleExecution\(\{\s*phase: pending\.phase,\s*cause,?\s*\}\)/,
    );
  });
});
