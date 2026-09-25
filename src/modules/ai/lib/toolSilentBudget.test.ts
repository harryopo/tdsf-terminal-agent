/**
 * toolSilentBudget.test.ts — 「一次合法的工具调用可以让整条链路静默多久」对账（#143）
 * ---------------------------------------------------------------------------
 * 为什么要有这条：#133 只挡住了"等人回答"那段时间，**工具自己在跑**期间同样一条
 * 流式事件都不发（`loop_progress` 是在工具**结束**时才推的）。所以必须回答一个问题：
 * 前端放弃计时的那一刻，下面两层是不是还在合法等待？
 *
 * 三层各自的预算（都从**源码**现读，不抄字面量）：
 *   模型声明 timeout            → Rust clamp 到 1..=300s
 *   Rust 内层等可见终端回执      → timeout + VISIBLE_TERMINAL_TRANSPORT_GRACE_SECS
 *   Python 等 Rust 的 ipc 回执   → timeout + VISIBLE_TERMINAL_IPC_OVERHEAD_SECS
 *   Rust 对整条 agent.invoke     → ipc_invoke 的 timeoutMs clamp 上限（硬顶）
 *
 * 判据是**不等式**而不是"某个数是不是 300"：整条 invoke 的硬顶必须大于最坏合法静默，
 * 否则前端（以及 Rust 自己）会在一条**完全合法**的长命令跑到一半时先撒手 ——
 * 界面报超时、服务器上命令照跑，正是 #119 那一族。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

function num(text: string, pattern: RegExp, what: string): number {
  const m = text.match(pattern);
  if (!m) throw new Error(`读不到 ${what}（判据正则失效，不是回归）：${pattern}`);
  return Number(m[1].replace(/_/g, ""));
}

const sidecarRs = SRC("src-tauri/src/modules/sidecar.rs");
const ipcRs = SRC("src-tauri/src/modules/ipc.rs");
const toolsInit = SRC("src-tauri/sidecar/strands_backend/tools/__init__.py");
const adapterTs = SRC("src/modules/ai/lib/sidecar-adapter.ts");

/** 模型可声明的 timeout 上限（Rust 那一侧 clamp 的右端点） */
const TIMEOUT_MAX_S = num(
  sidecarRs,
  /\.clamp\(\s*1\s*,\s*(\d+)\s*\)/,
  "visible_terminal_execute 的 timeout clamp 上限",
);
const RUST_GRACE_S = num(
  sidecarRs,
  /VISIBLE_TERMINAL_TRANSPORT_GRACE_SECS:\s*u64\s*=\s*(\d+)/,
  "Rust 传输宽限",
);
const PY_OVERHEAD_S = num(
  toolsInit,
  /VISIBLE_TERMINAL_IPC_OVERHEAD_SECS\s*=\s*([\d._]+)/,
  "Python ipc 宽限",
);
/** Rust 对整条 agent.invoke 的硬顶（ipc_invoke 的 timeoutMs clamp 右端点，单位 ms） */
const INVOKE_CEILING_MS = num(
  ipcRs,
  /ms\.clamp\(\s*[\d_]+\s*,\s*([\d_]+)\s*\)/,
  "ipc_invoke timeoutMs 上限",
);

describe("#143 一次工具调用的合法静默上限 vs 前端会不会先撒手", () => {
  const worstSilenceS = TIMEOUT_MAX_S + PY_OVERHEAD_S;

  it("三层宽限仍是 Python > Rust（#119 定的顺序，不许有人改成相等或倒过来）", () => {
    expect(PY_OVERHEAD_S).toBeGreaterThan(RUST_GRACE_S);
  });

  it("Rust 对整条 invoke 的硬顶 > 最坏合法静默 ⇒ 前端不需要用固定窗口去兜长命令", () => {
    expect(INVOKE_CEILING_MS / 1000).toBeGreaterThan(worstSilenceS);
  });

  it("前端在工具在飞期间确实停表（停的是计时器，不是把窗口调大）", () => {
    // 接线断言：这条闸只在「实现还在停表」时有意义，所以先钉住调用点存在。
    expect(adapterTs).toContain("budget.beginTool()");
    expect(adapterTs).toContain("budget.endTool()");
  });

  it("读数器：把四个数打出来，改任何一层都要看得见它把谁推过了头", () => {
    // 不是判据，是防"悄悄调一个数"。真机日志（79 次配对）最大静默 259.6s，
    // 而今天实际最大声明 timeout = 60s ⇒ 实际余量 = 60+200=260s，正好贴着。
    console.info(
      `[143] timeout 上限=${TIMEOUT_MAX_S}s  Rust 宽限=+${RUST_GRACE_S}s  ` +
        `Python 宽限=+${PY_OVERHEAD_S}s  最坏静默=${worstSilenceS}s  ` +
        `整条 invoke 硬顶=${INVOKE_CEILING_MS / 1000}s`,
    );
    expect(worstSilenceS).toBeGreaterThan(0);
  });
});
