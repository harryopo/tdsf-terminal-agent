/**
 * 翻译 API 层 — 七级策略链（P2-5 升级）
 *
 * 查询优先级（参考旧版 translator.ts，category 守卫防误匹配）：
 * 1. 路径 path（/usr/local、/etc、~/ 整体识别 + 逐段）
 * 2. 选项 option（-l、--version）
 * 3. 精确短语 exact-phrase（error/phrase 类别，含空格）
 * 4. 命令 command（字母开头）
 * 5. 短语贪心 phrase-greedy（最长短语）
 * 6. 单词 word（linux + programming 词典）
 * 7. 复合词拆分
 *
 * 词典合并：
 * - linux-commands-zh.json（2279 条：1911 command + 250 option + 33 error +
 *   85 term，字段含 example/syntax/detail/category/level）
 * - linuxDictionary.ts（现有）
 * - programmingDictionary.ts（编程术语，旧词典不含）
 *
 * 设计：
 * - 零网络依赖，纯本地词典
 * - 路径/选项/短语精确匹配，category 守卫
 * - 调用方只需传入文本，返回翻译结果
 */

import {
  lookupWord as lookupLinux,
  formatLookupResult,
  DICT_SIZE as LINUX_DICT_SIZE,
  type LookupResult,
} from "./linuxDictionary";
import {
  PROGRAMMING_DICT,
  PROGRAMMING_DICT_SIZE,
} from "./programmingDictionary";
import zhDictJson from "./dict/linux-commands-zh.json";
// T3 词库增强（ECDICT 子集 + lemma 词形还原）
import ecdictCommonJson from "./dict/ecdict-common.json";
import lemmaReverseJson from "./dict/lemma-reverse.json";

/** 翻译结果 */
export interface TranslationResult {
  /** 原文 */
  source: string;
  /** 译文 */
  target: string;
  /** 是否成功 */
  success: boolean;
  /** 详细结果 */
  entries: LookupResult[];
}

// ============================================================================
// 合并词典
// ============================================================================

/** 总词典大小 */
export const TOTAL_DICT_SIZE = LINUX_DICT_SIZE + PROGRAMMING_DICT_SIZE;

/**
 * 在编程词典中查找单词
 * 支持：精确匹配 + 小写降级 + 复合词拆分 + 短语拆分
 */
function lookupProgramming(word: string): LookupResult[] {
  const results: LookupResult[] = [];
  const exact = word.trim();
  if (!exact) return results;

  // 1. 精确匹配
  if (PROGRAMMING_DICT[exact]) {
    const e = PROGRAMMING_DICT[exact];
    results.push({ word: exact, zh: e.zh, pos: e.pos, tag: e.tag, exact: true });
    return results;
  }

  // 2. 小写匹配
  const lower = exact.toLowerCase();
  if (lower !== exact && PROGRAMMING_DICT[lower]) {
    const e = PROGRAMMING_DICT[lower];
    results.push({ word: lower, zh: e.zh, pos: e.pos, tag: e.tag, exact: true });
    return results;
  }

  // 3. 拆分 camelCase / snake_case / kebab-case
  const words = splitCompoundWord(exact);
  if (words.length > 1) {
    for (const w of words) {
      const lowerW = w.toLowerCase();
      if (PROGRAMMING_DICT[lowerW]) {
        results.push({ word: w, ...PROGRAMMING_DICT[lowerW], exact: false });
      } else if (PROGRAMMING_DICT[w]) {
        results.push({ word: w, ...PROGRAMMING_DICT[w], exact: false });
      }
    }
    if (results.length > 0) return results;
  }

  // 4. 短语拆分（空格分隔）
  const phraseWords = exact.split(/\s+/);
  if (phraseWords.length > 1) {
    // 先尝试短语整体匹配
    if (PROGRAMMING_DICT[lower]) {
      return [{ word: lower, ...PROGRAMMING_DICT[lower], exact: true }];
    }
    // 短语逐词翻译
    for (const pw of phraseWords) {
      const lowerPw = pw.toLowerCase();
      if (PROGRAMMING_DICT[lowerPw]) {
        results.push({ word: pw, ...PROGRAMMING_DICT[lowerPw], exact: false });
      }
    }
    if (results.length > 0) return results;
  }

  return results;
}

/**
 * 翻译英文文本为中文（十级策略链）
 *
 * 1. 路径 path（含 / 斜杠整体识别 + 逐段）
 * 2. 选项 option（-l / --version）
 * 3. 精确短语（error/phrase 类别，含空格）
 * 4. 命令（字母开头，2279 条词典）
 * 5. 单词 linux 词典
 * 6. 单词 programming 词典
 * 7. ECDICT 81557 词
 * 8. lemma 词形还原（复数/过去式/比较级等还原后重查）
 * 9. 模糊前缀（startsWith 近似匹配）
 * 10. 复合词拆分（空格/连字符分段后逐段查）
 *
 * 纯符号（如 "/" 单独）不翻译——用户选中斜杠时返回空。
 *
 * @param text 要翻译的文本
 * @returns 翻译结果
 */
export function translateText(text: string): TranslationResult {
  const raw = text ?? "";
  const trimmed = raw.trim();
  if (!trimmed) {
    return { source: text, target: "", success: true, entries: [] };
  }

  let entries: LookupResult[] = [];

  // 纯符号/单字符符号过滤（如 "/" "." ":"）——无翻译价值
  if (/^[^\w\u4e00-\u9fff]+$/.test(trimmed) && !trimmed.startsWith("-")) {
    return { source: text, target: "", success: false, entries: [] };
  }

  // 1. 路径（含前导斜杠/波浪号：/usr/local、~/config、/etc）
  if (trimmed.startsWith("/") || trimmed.startsWith("~")) {
    entries = lookupZhPath(trimmed);
    if (entries.length > 0) {
      return finishTranslate(text, entries);
    }
  }

  // 2. 选项（-l / --version）
  if (trimmed.startsWith("-")) {
    entries = lookupZhOption(trimmed);
    if (entries.length > 0) {
      return finishTranslate(text, entries);
    }
  }

  // 3. 精确短语（error/phrase 类别，含空格）
  if (trimmed.includes(" ")) {
    entries = lookupZhPhrase(trimmed);
    if (entries.length > 0) {
      return finishTranslate(text, entries);
    }
  }

  // 4. 命令 / 术语（2279 条词典精确 + 小写降级）
  entries = lookupZhCommand(trimmed);
  if (entries.length > 0) {
    return finishTranslate(text, entries);
  }

  // 5-6. 单词（linux + programming 词典）
  entries = lookupLinux(trimmed);
  if (entries.length === 0) {
    entries = lookupProgramming(trimmed);
  }
  if (entries.length > 0) {
    return finishTranslate(text, entries);
  }

  // 7. ECDICT 通用/计算机词库（8.1 万条：give/database/network/algorithm…）
  entries = lookupEcdictCommon(trimmed);
  if (entries.length > 0) {
    return finishTranslate(text, entries);
  }

  // 8. lemma 词形还原（gave→give / teeth→tooth）→ 再查全部词库
  const restored = lookupLemmaRestored(trimmed);
  if (restored.length > 0) {
    return finishTranslate(text, restored);
  }

  // 9. 模糊兜底：前缀匹配（输入是长词/复合词时提示最接近词）
  const fuzzy = lookupFuzzyPrefix(trimmed);
  if (fuzzy.length > 0) {
    return finishTranslate(text, fuzzy);
  }

  // 10. 复合词拆分
  const words = splitCompoundWord(trimmed);
  if (words.length > 1) {
    for (const w of words) {
      const linuxResults = lookupLinux(w);
      if (linuxResults.length > 0) {
        entries.push(...linuxResults.map((r) => ({ ...r, exact: false })));
      } else {
        const progResults = lookupProgramming(w);
        if (progResults.length > 0) {
          entries.push(...progResults.map((r) => ({ ...r, exact: false })));
        }
      }
    }
  }

  return finishTranslate(text, entries);
}

// ============================================================================
// ECDICT 通用词库查询（8.1 万条）
// ============================================================================

const ECDICT_COMMON = ecdictCommonJson.entries as Record<
  string,
  { zh: string; pos?: string; tag?: string }
>;
const LEMMA_REVERSE = lemmaReverseJson.entries as Record<string, string>;

/** ECDICT 通用词查询（精确 → 小写降级） */
function lookupEcdictCommon(word: string): LookupResult[] {
  if (!/^[a-zA-Z]/.test(word)) return [];
  const exact = ECDICT_COMMON[word];
  if (exact) {
    return [
      { word, zh: exact.zh, pos: exact.pos, tag: exact.tag ?? "common", exact: true },
    ];
  }
  const lower = word.toLowerCase();
  if (lower !== word) {
    const e = ECDICT_COMMON[lower];
    if (e) {
      return [
        { word: lower, zh: e.zh, pos: e.pos, tag: e.tag ?? "common", exact: true },
      ];
    }
  }
  return [];
}

/** lemma 词形还原：form→lemma → 查 zhDict/ECDICT */
function lookupLemmaRestored(word: string): LookupResult[] {
  const lower = word.toLowerCase();
  const lemma = LEMMA_REVERSE[lower];
  if (!lemma || lemma === lower) return [];
  // 还原后查 ECDICT 与命令词典
  const e = ECDICT_COMMON[lemma];
  if (e) {
    return [
      {
        word: `${lower}（${lemma}）`,
        zh: e.zh,
        pos: e.pos,
        tag: "词形还原",
        exact: false,
        detail: `原形：${lemma}`,
      },
    ];
  }
  const z = ZH_DICT[lemma];
  if (z) {
    return [
      { word: `${lower}（${lemma}）`, zh: z.zh, pos: z.pos, tag: "词形还原", exact: false },
    ];
  }
  return [];
}

/** 模糊前缀匹配（长词/未收录词 → 提示最接近的 ECDICT 词） */
function lookupFuzzyPrefix(word: string): LookupResult[] {
  if (word.length < 4) return [];
  const lower = word.toLowerCase();
  const hits: LookupResult[] = [];
  // 前缀匹配（前 50 条内找 3 个）
  let count = 0;
  for (const [k, e] of Object.entries(ECDICT_COMMON)) {
    if (k.startsWith(lower) && k !== lower) {
      hits.push({ word: k, zh: e.zh, pos: e.pos, tag: "近似", exact: false });
      count += 1;
      if (count >= 3) break;
    }
  }
  // 前缀无果 → 包含匹配（词内含输入）
  if (hits.length === 0) {
    for (const [k, e] of Object.entries(ECDICT_COMMON)) {
      if (k.includes(lower) && k.length > lower.length) {
        hits.push({ word: k, zh: e.zh, pos: e.pos, tag: "近似", exact: false });
        count += 1;
        if (count >= 2) break;
      }
    }
  }
  return hits;
}

function finishTranslate(source: string, entries: LookupResult[]): TranslationResult {
  return {
    source,
    target: formatLookupResult(entries),
    success: entries.length > 0,
    entries,
  };
}

// ============================================================================
// 2279 条词典查询（linux-commands-zh.json）
// ============================================================================

type ZhEntry = {
  zh: string;
  pos?: string;
  example?: string;
  syntax?: string;
  detail?: string;
  category?: "command" | "option" | "term" | "error" | "phrase";
  level?: string;
};

const ZH_DICT = zhDictJson.entries as Record<string, ZhEntry>;

function toResult(
  word: string,
  e: ZhEntry,
  exact: boolean,
  tag = e.category ?? "linux",
): LookupResult {
  return {
    word,
    zh: e.zh,
    pos: e.pos,
    tag,
    exact,
    example: e.example,
    syntax: e.syntax,
    detail: e.detail,
    category: e.category,
  };
}

/** 命令/术语查询（精确 → 小写降级，category 守卫：跳过 option） */
function lookupZhCommand(word: string): LookupResult[] {
  if (!/^[a-zA-Z]/.test(word)) return [];
  const exact = ZH_DICT[word];
  if (exact && exact.category !== "option") {
    return [toResult(word, exact, true)];
  }
  const lower = word.toLowerCase();
  if (lower !== word) {
    const e = ZH_DICT[lower];
    if (e && e.category !== "option") {
      return [toResult(lower, e, true)];
    }
  }
  return [];
}

/** 选项查询（-l / --version，含 "l" → "-l" 容错） */
function lookupZhOption(word: string): LookupResult[] {
  const keys = [word, word.toLowerCase()];
  if (!word.startsWith("-")) {
    keys.unshift(`-${word}`);
  }
  for (const k of keys) {
    const e = ZH_DICT[k];
    if (e) return [toResult(k, e, k === word || k === word.toLowerCase())];
  }
  return [];
}

/** 精确短语（error/phrase/term 类别，含空格的多词条目） */
function lookupZhPhrase(word: string): LookupResult[] {
  const keys = [word, word.toLowerCase()];
  for (const k of keys) {
    const e = ZH_DICT[k];
    if (e && (e.category === "error" || e.category === "phrase" || e.category === "term")) {
      return [toResult(k, e, true)];
    }
  }
  return [];
}

/** 路径翻译（/etc → 整体 + 逐段） */
function lookupZhPath(path: string): LookupResult[] {
  const results: LookupResult[] = [];
  // 1. 整体匹配（如 "/etc" 是词条）
  const whole = ZH_DICT[path];
  if (whole) {
    results.push(toResult(path, whole, true));
    return results;
  }
  const wholeLower = ZH_DICT[path.toLowerCase()];
  if (wholeLower) {
    results.push(toResult(path.toLowerCase(), wholeLower, true));
    return results;
  }
  // 2. 逐段翻译（/usr/local → /usr + local）
  const segments = path.split("/").filter(Boolean);
  for (const seg of segments) {
    const e = ZH_DICT[seg] ?? ZH_DICT[seg.toLowerCase()];
    if (e) results.push(toResult(seg, e, false));
  }
  return results;
}

/**
 * 批量翻译
 */
export function translateBatch(texts: string[]): TranslationResult[] {
  return texts.map((t) => translateText(t));
}

// ============================================================================
// 复合词拆分（复用 linuxDictionary 的拆分逻辑）
// ============================================================================

/**
 * 拆分复合词（camelCase, snake_case, kebab-case, PascalCase）
 */
function splitCompoundWord(word: string): string[] {
  // 处理 snake_case
  if (word.includes("_")) {
    return word.split("_").filter(Boolean);
  }
  // 处理 kebab-case
  if (word.includes("-")) {
    return word.split("-").filter(Boolean);
  }
  // 处理 camelCase / PascalCase
  const parts = word.match(/[A-Z]?[a-z]+|[A-Z]+(?=[A-Z][a-z]|\d|$|\b)|\d+/g);
  return parts ? parts.filter(Boolean) : [word];
}
