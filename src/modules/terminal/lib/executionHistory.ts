import { getSuggestEngine, type TerminalEnv } from "@/lib/suggest-engine";
import { historyRecord } from "@/modules/terminal/block/lib/history";
import type { TerminalBlock } from "./terminalBlocks";

const leafEnvironments = new Map<number, TerminalEnv>();
/** leaf 代次：重新注册环境即换代，用于拒绝迟到的异步缓存/结果。 */
const leafEpochs = new Map<number, number>();
let leafEpochSeq = 0;

export function setLeafEnvironment(leafId: number, env: TerminalEnv): void {
  if (!leafEnvironments.has(leafId)) {
    leafEpochSeq += 1;
    leafEpochs.set(leafId, leafEpochSeq);
  }
  leafEnvironments.set(leafId, env);
}

export function clearLeafEnvironment(leafId: number): void {
  leafEnvironments.delete(leafId);
  leafEpochs.delete(leafId);
}

export function getLeafEnvironment(leafId: number): TerminalEnv {
  return leafEnvironments.get(leafId) ?? "windows";
}

/** 当前 leaf 代次；未注册为 0。leaf 销毁/重建后旧代次不再命中。 */
export function getLeafEpoch(leafId: number): number {
  return leafEpochs.get(leafId) ?? 0;
}

/**
 * Prediction history is written only after the terminal protocol has observed
 * a complete, successful command block. Non-zero and unknown results remain
 * available for teaching and error explanation but never influence prediction.
 */
export function recordSuccessfulTerminalBlock(block: TerminalBlock): void {
  const command = block.command.trim();
  // CORR-02 C3：片段/复合命令没有可靠原文与退出码归属，不参与成功学习。
  if (block.commandComplete === false) return;
  if (block.exitCode !== 0 || !command) return;

  historyRecord(command);
  getSuggestEngine().addHistory(command, getLeafEnvironment(block.sessionId));
}
