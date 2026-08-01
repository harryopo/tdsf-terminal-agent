import type { ModelMessage } from "ai";

const KEEP_TAIL = 24;
const ELISION_TEXT =
  "[elided to save context — see prior tool call in history]";

type ToolPart = {
  type: string;
  toolName?: string;
  toolCallId?: string;
  input?: unknown;
  output?: unknown;
  [k: string]: unknown;
};

function approxBytes(messages: ModelMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (typeof m.content === "string") n += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const part of m.content as ToolPart[]) {
        if (part.type === "text" && typeof part.text === "string")
          n += (part.text as string).length;
        else if (part.type === "tool-result")
          n += JSON.stringify(part.output ?? "").length;
        else if (part.type === "tool-call")
          n += JSON.stringify(part.input ?? "").length;
        else n += 64;
      }
    }
  }
  return n;
}

function elideToolResult(part: ToolPart): { changed: boolean; part: ToolPart } {
  if (part.type !== "tool-result") return { changed: false, part };
  if (
    part.output &&
    typeof part.output === "object" &&
    (part.output as { __elided?: boolean }).__elided
  ) {
    return { changed: false, part };
  }
  return {
    changed: true,
    part: {
      ...part,
      output: { type: "text", value: ELISION_TEXT, __elided: true },
    },
  };
}

function pathOfInput(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const p = (input as { path?: unknown }).path;
  return typeof p === "string" && p.length > 0 ? p : null;
}

function collectMutationPaths(messages: ModelMessage[]): Set<string> {
  const paths = new Set<string>();
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as ToolPart[]) {
      if (part.type !== "tool-call") continue;
      const name = part.toolName;
      if (
        name === "edit" ||
        name === "multi_edit" ||
        name === "write_file" ||
        name === "create_directory"
      ) {
        const p = pathOfInput(part.input);
        if (p) paths.add(p);
      }
    }
  }
  return paths;
}

function collectLastReadIdxPerPath(
  messages: ModelMessage[],
): Map<string, number> {
  const lastIdx = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as ToolPart[]) {
      if (part.type !== "tool-call") continue;
      if (part.toolName !== "read_file") continue;
      const p = pathOfInput(part.input);
      if (p) lastIdx.set(p, i);
    }
  }
  return lastIdx;
}

function dropSupersededReads(messages: ModelMessage[]): {
  out: ModelMessage[];
  touched: boolean;
} {
  const mutated = collectMutationPaths(messages);
  const lastReadIdx = collectLastReadIdxPerPath(messages);

  const callIdxToPath = new Map<string, string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as ToolPart[]) {
      if (part.type !== "tool-call" || part.toolName !== "read_file") continue;
      const p = pathOfInput(part.input);
      const id = part.toolCallId;
      if (p && typeof id === "string") callIdxToPath.set(id, p);
    }
  }

  let touched = false;
  const out = messages.map((m, i): ModelMessage => {
    if (!Array.isArray(m.content)) return m;
    let local = false;
    const nextContent = (m.content as ToolPart[]).map((part) => {
      if (part.type !== "tool-result") return part;
      const id = part.toolCallId;
      if (typeof id !== "string") return part;
      const path = callIdxToPath.get(id);
      if (!path) return part;
      const isStale =
        mutated.has(path) ||
        (lastReadIdx.has(path) && (lastReadIdx.get(path) as number) > i);
      if (!isStale) return part;
      const r = elideToolResult(part);
      if (r.changed) local = true;
      return r.part;
    });
    if (!local) return m;
    touched = true;
    return { ...m, content: nextContent } as ModelMessage;
  });
  return { out, touched };
}

export type CompactResult = {
  messages: ModelMessage[];
  compacted: boolean;
  droppedCount: number;
  /**
   * TDSF 2026-08-01 (P1-v5-3): 5 级 compaction 等级（OPENDEV 范式）：
   * 0 = 无需压缩；1 = warning（70%，清 superseded reads）；
   * 2 = masking（80%，elide 超大 tool-result）；
   * 3 = pruning（85%，elide 全部 tool-result）；
   * 4 = aggressive（95%，截断旧文本）；
   * 5 = summarization（>105%，极端截断保留尾部；完整 LLM 摘要走
   *     sidecar long_context.summarize，前端侧为兜底实现）
   */
  level: number;
};

// L2 阈值：tool-result output 序列化超过该字节数才 elide（masking 阶段）
const L2_ELIDE_MIN_BYTES = 1024;
// L4/L5 的尾部保留消息数（aggressive 阶段收紧）
const KEEP_TAIL_AGGRESSIVE = 12;

function elideLargeToolResults(
  messages: ModelMessage[],
  minBytes: number,
  protect?: Set<string>,
): { out: ModelMessage[]; touched: boolean } {
  let touched = false;
  const out = messages.map((m): ModelMessage => {
    if (!Array.isArray(m.content)) return m;
    let local = false;
    const nextContent = (m.content as ToolPart[]).map((part) => {
      if (part.type !== "tool-result") return part;
      if (
        protect &&
        typeof part.toolCallId === "string" &&
        protect.has(part.toolCallId)
      ) {
        return part;
      }
      const size = JSON.stringify(part.output ?? "").length;
      if (size < minBytes) return part;
      const r = elideToolResult(part);
      if (r.changed) local = true;
      return r.part;
    });
    if (!local) return m;
    touched = true;
    return { ...m, content: nextContent } as ModelMessage;
  });
  return { out, touched };
}

/**
 * 计算"仍需保留的 read_file 结果"集合：每个路径最后一次 read（且文件未被
 * 后续修改）的 toolCallId。L2/L3 的 elide 都必须跳过这些结果——分级压缩
 * 不能把"仍被后续引用的最新 read"清掉（旧实现靠 0.6 阈值早停避免，分级后
 * 必须显式保护）。
 */
function latestReadResultIds(messages: ModelMessage[]): Set<string> {
  const lastReadIdx = collectLastReadIdxPerPath(messages);
  const mutated = collectMutationPaths(messages);
  const ids = new Set<string>();
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (!Array.isArray(m.content)) continue;
    for (const part of m.content as ToolPart[]) {
      if (part.type !== "tool-call" || part.toolName !== "read_file") continue;
      const p = pathOfInput(part.input);
      if (!p || typeof part.toolCallId !== "string") continue;
      if (mutated.has(p)) continue; // 文件已被修改，read 结果无引用价值
      if (lastReadIdx.get(p) === i) ids.add(part.toolCallId);
    }
  }
  return ids;
}

function truncateOldTexts(
  messages: ModelMessage[],
  keepTail: number,
): { out: ModelMessage[]; touched: boolean } {
  const stopIdx = Math.max(0, messages.length - keepTail);
  let touched = false;
  const out = messages.map((m, i): ModelMessage => {
    if (i >= stopIdx || m.role === "system") return m;
    if (typeof m.content === "string") {
      if (m.content.length <= 200) return m;
      touched = true;
      return { ...m, content: `${m.content.slice(0, 200)}…[压缩]` } as ModelMessage;
    }
    return m;
  });
  return { out, touched };
}

export function compactModelMessages(
  messages: ModelMessage[],
  contextLimit: number,
): ModelMessage[] {
  return compactModelMessagesDetailed(messages, contextLimit).messages;
}

export function compactModelMessagesDetailed(
  messages: ModelMessage[],
  contextLimit: number,
): CompactResult {
  let dropped = 0;
  let working = messages;
  let approxTokens = approxBytes(working) / 4;
  const ratio = approxTokens / contextLimit;
  let level = 0;
  // 最新 read 结果保护集（L2/L3 共用，压缩不破坏仍被引用的 read）
  const protectReads = latestReadResultIds(working);

  // L1 warning（≥55%）：清 superseded reads（不丢信息）
  if (ratio >= 0.55) {
    level = 1;
    const r = dropSupersededReads(working);
    if (r.touched) {
      working = r.out;
      dropped++;
      approxTokens = approxBytes(working) / 4;
    }
  }

  // L2 masking（≥70%）：只 elide 超大 tool-result（最新 read 保护）
  if (ratio >= 0.7) {
    level = 2;
    const r = elideLargeToolResults(working, L2_ELIDE_MIN_BYTES, protectReads);
    if (r.touched) {
      working = r.out;
      dropped++;
      approxTokens = approxBytes(working) / 4;
    }
  }

  // L3 pruning（≥85%）：elide 全部 tool-result（最新 read 保护）
  if (ratio >= 0.85) {
    level = 3;
    const out = working.slice();
    const stopIdx = Math.max(0, out.length - KEEP_TAIL);
    for (let i = 0; i < stopIdx; i++) {
      if (out[i].role === "system") continue;
      if (!Array.isArray(out[i].content)) continue;
      let local = false;
      const next = (out[i].content as ToolPart[]).map((part) => {
        if (
          part.type === "tool-result" &&
          typeof part.toolCallId === "string" &&
          protectReads.has(part.toolCallId)
        ) {
          return part;
        }
        const r = elideToolResult(part);
        if (r.changed) local = true;
        return r.part;
      });
      if (local) {
        out[i] = { ...out[i], content: next } as ModelMessage;
        dropped++;
      }
    }
    working = out;
    approxTokens = approxBytes(working) / 4;
  }

  // L4 aggressive（≥95%）：+ 截断旧文本消息
  if (ratio >= 0.95) {
    level = 4;
    const r = truncateOldTexts(working, KEEP_TAIL_AGGRESSIVE);
    if (r.touched) {
      working = r.out;
      dropped++;
      approxTokens = approxBytes(working) / 4;
    }
  }

  // L5 summarization（>105%）：极端兜底——仅保留尾部 + 首条 user 意图。
  // 完整 LLM 摘要（99% 压缩率）走 sidecar long_context.summarize，此处
  // 保证前端永不超限（保留最近 KEEP_TAIL_AGGRESSIVE 条 + 一条 user 摘要）。
  if (ratio >= 1.05) {
    level = 5;
    const tail = working.slice(-KEEP_TAIL_AGGRESSIVE);
    const firstUser = working.find((m) => m.role === "user");
    const combined: ModelMessage[] = [];
    if (firstUser && !tail.includes(firstUser)) {
      const text =
        typeof firstUser.content === "string"
          ? firstUser.content.slice(0, 300)
          : "[用户历史消息已压缩]";
      combined.push({
        role: "user",
        content: `[早期对话摘要] ${text}`,
      } as ModelMessage);
    }
    working = [...combined, ...tail];
    dropped++;
  }

  return {
    messages: working,
    compacted: dropped > 0,
    droppedCount: dropped,
    level,
  };
}
