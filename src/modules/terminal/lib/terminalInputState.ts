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
/** Ctrl-C 放弃、Ctrl-U 删到行首、Ctrl-W 删词：行内容已被用户清空 */
const LINE_WIPED = /[\x03\x15\x17]/;
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
  if (LINE_WIPED.test(data)) {
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
