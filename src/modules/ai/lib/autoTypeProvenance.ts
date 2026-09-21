/**
 * autoTypeProvenance — 命令卡自动打字的「消息出身」闸门
 * -----------------------------------------------------------------------------
 * 2026-09-21 用户实测：打开历史对话（含冷启动后重新打开）会把**过去**回答里的命令
 * 又往终端里打一遍，auto 档下等于重新执行一遍旧命令。
 *
 * autoTypeLedger 挡不住这条：它按「会话」分域记账，而记账表是模块级内存
 * ——应用重启即清空，同一会话第一次挂载时也没有任何记录。所以「这条消息是不是
 * 本次运行里 AI 刚生成的」必须由出身信息回答，不能指望去重账本。
 *
 * 规则一句话：**只有本次运行里生成的消息才允许自动打字；从盘上读回来的历史消息
 * 一律不注入（手动 Run 照旧）。**
 * 登记点唯一：`chatStore.switchSession` 从 `loadMessages` 拿到持久化消息时。
 * 传播方式用 context，因为命令卡（chat-code / tool 两处）拿不到自己所属的 message id。
 *
 * ⚠️ 默认值必须是 **false（fail-closed）**：任何没有显式提供 context 的渲染面
 * （知识库浏览器、独立卡片等）都不该往用户终端里打字。
 */

import { createContext, useContext } from "react";

/** 从盘上读回来的消息 id（本次运行没有生成过它们）。 */
const restored = new Set<string>();

/** 登记「这些消息来自持久化存储」——它们此后再也不参与自动打字。 */
export function markMessagesRestored(
  messages: readonly { id: string }[] | null | undefined,
): void {
  if (!messages) return;
  for (const m of messages) restored.add(m.id);
}

/** 这条消息是本次运行里生成的吗？（未登记过的都算） */
export function isLiveMessage(messageId: string): boolean {
  return !restored.has(messageId);
}

const LiveMessageCtx = createContext(false);

/** 由消息级渲染入口提供；不包就等于「不许自动打字」。 */
export const LiveMessageProvider = LiveMessageCtx.Provider;

/** 当前这张命令卡是否允许自动打字。 */
export function useAutoTypeAllowed(): boolean {
  return useContext(LiveMessageCtx);
}

/** 仅供测试重置模块级状态。 */
export function __resetAutoTypeProvenance(): void {
  restored.clear();
}
