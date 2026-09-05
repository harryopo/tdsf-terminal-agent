import { getSuggestEngine, type TerminalEnv } from "@/lib/suggest-engine";
import { historyRecord } from "@/modules/terminal/block/lib/history";
import type { TerminalBlock } from "./terminalBlocks";

const leafEnvironments = new Map<number, TerminalEnv>();

export function setLeafEnvironment(leafId: number, env: TerminalEnv): void {
  leafEnvironments.set(leafId, env);
}

export function clearLeafEnvironment(leafId: number): void {
  leafEnvironments.delete(leafId);
}

export function getLeafEnvironment(leafId: number): TerminalEnv {
  return leafEnvironments.get(leafId) ?? "windows";
}

/**
 * Prediction history is written only after the terminal protocol has observed
 * a complete, successful command block. Non-zero and unknown results remain
 * available for teaching and error explanation but never influence prediction.
 */
export function recordSuccessfulTerminalBlock(block: TerminalBlock): void {
  const command = block.command.trim();
  if (block.exitCode !== 0 || !command) return;

  historyRecord(command);
  getSuggestEngine().addHistory(command, getLeafEnvironment(block.sessionId));
}
