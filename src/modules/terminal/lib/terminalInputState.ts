/**
 * terminalInputState.ts — 「用户是否正在当前提示行上输入」信号
 * -----------------------------------------------------------------------------
 * 存在的理由：AI 命令卡会自动把命令打字到活动终端，而注入前会先清行
 * （逐字路径 Rust 发 `\x03\r`）或直接追加（整段路径 `term.write`）。
 * 两种都会破坏用户正在敲、尚未回车的那一行。
 *
 * rendererPool 的 `term.onData` 是全站唯一的用户按键漏斗，在这里记账，
 * 自动打字前查一下即可避开。
 *
 * 同时修作者误标：agentPending 是"下一条结算的 block 算 agent 的"时间窗口标记。
 * 若 AI 注入了命令但用户没回车、改自己敲一条并回车，那条会被误标成 agent。
 * 用户提交了自己弄脏的行时把标记清掉即可精确纠正。
 */
import { useTerminalBlocksStore } from "./terminalBlocksStore";

/** 有未提交输入内容的 leaf */
const dirtyLines = new Set<number>();

/** Enter / Ctrl-M / Ctrl-J：这一行已提交 */
const SUBMITTED = /[\r\n]/;
/**
 * 只有 Ctrl-C 才是"整行作废"。
 *
 * TDSF 修复 2026-09-18（深度体检 Q3）：以前把 Ctrl-U(\x15) 与 Ctrl-W(\x17) 也算成
 * 清行，但它们都只删一部分 —— 本仓 `keymap.ts` 自己就写着 `\x17` 是
 * "kill-word-backward"、`\x15` 是"删到行首"（光标在行中时后半行还在）。
 * 反例：用户敲 `docker-compose -f ` 后按一次 Ctrl-W，行里还剩 `docker-compose `，
 * 但记账被清 → 闸门放行 → AI 把命令打在用户残行上（正是 M1 要防的事）。
 * 保持"脏"只会让自动打字保守一点，方向安全。
 */
const LINE_ABANDONED = /\x03/;
/** 至少含一个可见字符才算"往行上打了东西"（纯方向键不改变脏否状态） */
const PRINTABLE = /[^\x00-\x1f\x7f]/;

/** 由 rendererPool 的 term.onData 调用：记录用户对当前行的操作。 */
export function noteUserInput(leafId: number, data: string): void {
  if (SUBMITTED.test(data)) {
    // 用户提交了这一行。若这行是用户自己敲脏的，说明待结算的 block 属于用户，
    // 不是 AI 注入的那条 → 撤销 agent 待命标记，避免作者误标。
    if (dirtyLines.delete(leafId)) {
      useTerminalBlocksStore.getState().clearAgentPending(leafId);
    }
    return;
  }
  if (LINE_ABANDONED.test(data)) {
    dirtyLines.delete(leafId);
    return;
  }
  if (PRINTABLE.test(data)) dirtyLines.add(leafId);
}

/** 该 leaf 的提示行上有用户未提交的内容。 */
export function isUserLineDirty(leafId: number): boolean {
  return dirtyLines.has(leafId);
}

/** 终端被销毁/重建时清账，避免 leafId 复用后串台。 */
export function clearUserLine(leafId: number): void {
  dirtyLines.delete(leafId);
}

/** 仅供测试。 */
export function __resetTerminalInputState(): void {
  dirtyLines.clear();
}
