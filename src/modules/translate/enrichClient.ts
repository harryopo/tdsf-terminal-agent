/**
 * enrichClient.ts — 翻译未命中时的模型兜底（P6）
 * -----------------------------------------------------------------------------
 * 只做一件事：在**用户点了「AI 补全」之后**为单个词/短语生成一条中文释义，
 * 写进本地增量词库（enrichmentStore），下次同一个词直接本地命中。
 *
 * 三条硬约束，都不是风格问题：
 *   1. 只进展示层。生成的文本只作为"释义"返回给翻译卡片，绝不参与命令拼装 /
 *      自动打字 / 工具调用 —— 由 `enrich.test.ts` 的「红线」用例用源码级断言
 *      守住（本模块与增量词库只允许被翻译模块引用）。
 *   2. 必须用户点击触发，且带会话额度上限：不做静默预取，避免在用户不知情时
 *      产生模型费用。
 *   3. prompt 是独立常量，不塞进 sidecar 基础 skin（那边有 4000 字符预算），
 *      也不复用对话历史 —— 不带上下文，避免把终端内容整段发给模型。
 */
import { generateText } from "ai";
import { DEFAULT_MODEL_ID, getModel } from "@/modules/ai/config";
import { buildLanguageModel } from "@/modules/ai/lib/agent";
import { getAllKeys, hasAnyKey } from "@/modules/ai/lib/keyring";
import type { LookupResult } from "./linuxDictionary";
import { putEnrichment } from "./enrichmentStore";

/** 每次应用运行允许的兜底调用次数（防误触发刷额度） */
export const ENRICH_SESSION_QUOTA = 20;
/** 只兜底"像词"的输入：过长的选择更可能是代码片段，交给 Ask TDSF */
const MAX_TERM_CHARS = 40;
const MAX_ZH_CHARS = 160;

const ENRICH_SYSTEM_PROMPT = [
  "你是终端场景的中英词典补全器。",
  "输入是一个离线词典未收录的词、命令或短语，输出它的中文释义。",
  "严格输出一行 JSON，形如 {\"zh\":\"中文释义\",\"example\":\"可选示例\"}；",
  "zh 用简体中文、不超过 40 个汉字、不要前言后语、不要 Markdown；",
  "example 只在确实是 Linux 命令/工具时给出，且必须是可以直接照抄的安全只读示例，",
  "不得包含删除、覆写、提权、联网下载等破坏性操作。",
  "无法确定含义时输出 {\"zh\":\"\"}，不要编造。",
].join("");

let sessionCalls = 0;

export function enrichQuotaLeft(): number {
  return Math.max(0, ENRICH_SESSION_QUOTA - sessionCalls);
}

/** 测试用：重置会话计数 */
export function resetEnrichQuota(): void {
  sessionCalls = 0;
}

/** 输入是否值得走一次模型兜底（不发请求就能判掉的情况先挡掉） */
export function isEnrichableTerm(term: string): boolean {
  const t = term.trim();
  if (t.length === 0 || t.length > MAX_TERM_CHARS) return false;
  // 词 / 带连字符下划线的命令名，最多再接一个普通词；
  // 明确不允许路径、选项、重定向等 shell 元字符出现在兜底输入里。
  if (!/^[A-Za-z][A-Za-z0-9._+-]*(?: [A-Za-z][A-Za-z0-9._+-]*)?$/.test(t)) return false;
  return true;
}

/** 从模型回复里抠出 JSON（容忍被 ``` 包裹或前后带解释的情况） */
export function parseEnrichResponse(text: string): { zh: string; example?: string } | null {
  const match = /\{[\s\S]*\}/.exec(text ?? "");
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as { zh?: unknown; example?: unknown };
  if (typeof o.zh !== "string") return null;
  const zh = o.zh.trim();
  if (!zh || zh.length > MAX_ZH_CHARS) return null;
  const example = typeof o.example === "string" ? o.example.trim() : undefined;
  return { zh, example: example && example.length <= 160 ? example : undefined };
}

/**
 * 请求一条兜底释义并写入本地增量词库。
 *
 * @returns 命中后的词条；额度用尽 / 没有配 key / 输入不像词 / 模型没给可用结果时 null
 */
export async function enrichTerm(
  term: string,
): Promise<LookupResult[] | null> {
  const word = term.trim();
  if (!isEnrichableTerm(word)) return null;
  if (sessionCalls >= ENRICH_SESSION_QUOTA) return null;
  sessionCalls += 1;

  try {
    const keys = await getAllKeys();
    if (!hasAnyKey(keys)) return null;
    const meta = getModel(DEFAULT_MODEL_ID);
    const model = await buildLanguageModel(meta.provider, keys, meta.id);
    const { text } = await generateText({
      model,
      system: ENRICH_SYSTEM_PROMPT,
      prompt: word,
      maxOutputTokens: 160,
    });
    const parsed = parseEnrichResponse(text);
    if (!parsed) return null;
    putEnrichment({ word, zh: parsed.zh, example: parsed.example });
    return [{ word, zh: parsed.zh, example: parsed.example, exact: true }];
  } catch {
    // 兜底失败必须静默降级为原来的"未找到释义"，不打断终端操作
    return null;
  }
}
