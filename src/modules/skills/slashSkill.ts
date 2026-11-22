// TEAM-FIX-01: `/skill:<name> <args>` 消费段
// -----------------------------------------------------------------------------
// TdsfAgentPanel 只负责解析斜杠命令与 toast 展示；真正的“调用 + 结果通知”
// 统一在这里完成，便于用假 IPC 做消费段回归：
//   - 只发一次 store.invoke（内部方法固定 skill.invoke）
//   - 通知内容与返回的 mode 一致
//   - 不触达 shell/SSH/终端写入
import { describeSkillResult, type SkillResultNotice } from "./resultNotice";
import type { SkillExecution } from "./types";

export interface SlashSkillInput {
  /** 解析出的 skill 名称 */
  name: string;
  /** 解析出的补充参数 */
  args: string;
}

export type SlashSkillInvoke = (
  name: string,
  args: string,
) => Promise<SkillExecution>;

export type SlashSkillNotify = (notice: SkillResultNotice) => void;

/**
 * 执行 `/skill` 消费段：调用一次结果适配器并发出与 mode 一致的通知
 */
export async function runSlashSkillCommand(
  input: SlashSkillInput,
  invoke: SlashSkillInvoke,
  notify: SlashSkillNotify,
): Promise<SkillExecution> {
  const result = await invoke(input.name, input.args);
  notify(describeSkillResult(input.name, result));
  return result;
}