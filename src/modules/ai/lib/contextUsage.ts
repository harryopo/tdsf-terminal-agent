import type { UIMessage } from "@ai-sdk/react";

export const CONTEXT_TOOL_DEF_TOKENS = 3600;
export const CONTEXT_SYS_PROMPT_TOKENS = 1000;
export const CONTEXT_SKILL_TOKENS = 600;

export function estimateTokens(messages: UIMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type === "text" || part.type === "reasoning") {
        chars += (part as { text?: string }).text?.length ?? 0;
      } else if (
        typeof part.type === "string" &&
        part.type.startsWith("tool-")
      ) {
        const toolPart = part as unknown as {
          input?: unknown;
          output?: unknown;
        };
        if (toolPart.input) chars += JSON.stringify(toolPart.input).length;
        if (toolPart.output) chars += JSON.stringify(toolPart.output).length;
      }
    }
  }
  return Math.ceil(chars / 4);
}

/**
 * 上下文占用分解。消息按内容估算，固定项按当前工具、提示词和技能规模估算；
 * 有供应商回传时按总量同比缩放，避免较小总量把后续分类错误显示为零。
 */
export function contextBreakdownRows(
  messages: UIMessage[],
  used: number,
): { label: string; tokens: number }[] {
  const messageTokens = estimateTokens(messages);
  const knownTotal =
    messageTokens +
    CONTEXT_TOOL_DEF_TOKENS +
    CONTEXT_SYS_PROMPT_TOKENS +
    CONTEXT_SKILL_TOKENS;
  const total = used > 0 ? used : knownTotal;
  let remaining = Math.max(0, total);
  const scale = Math.min(1, total / Math.max(knownTotal, 1));
  const rows = [
    { label: "消息", tokens: messageTokens },
    { label: "工具定义", tokens: CONTEXT_TOOL_DEF_TOKENS },
    { label: "系统提示词", tokens: CONTEXT_SYS_PROMPT_TOKENS },
    { label: "技能", tokens: CONTEXT_SKILL_TOKENS },
  ].map((part) => {
    const tokens = Math.min(Math.floor(part.tokens * scale), remaining);
    remaining -= tokens;
    return { label: part.label, tokens };
  });
  rows.push({ label: "其他", tokens: Math.max(0, remaining) });
  return rows;
}
