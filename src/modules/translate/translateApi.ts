/**
 * 翻译 API 层 — 三层词典降级查询
 *
 * 查询优先级：
 * 1. Linux 终端专用词典（linuxDictionary.ts）
 * 2. 编程语言词典（programmingDictionary.ts）
 * 3. 复合词拆分（camelCase / snake_case / kebab-case）
 *
 * 设计：
 * - 零网络依赖，纯本地词典
 * - 支持精确匹配 + 小写降级 + 复合词拆分
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
 * 翻译英文文本为中文
 *
 * 三层降级查询：
 * 1. Linux 终端词典（精确匹配 + 小写降级 + 复合词拆分）
 * 2. 编程词典（精确匹配 + 小写降级）
 * 3. 返回空（未找到）
 *
 * @param text 要翻译的文本
 * @returns 翻译结果
 */
export function translateText(text: string): TranslationResult {
  if (!text || !text.trim()) {
    return {
      source: text,
      target: "",
      success: true,
      entries: [],
    };
  }

  // 第一层：Linux 终端词典
  let entries = lookupLinux(text);

  // 第二层：编程词典（降级，支持复合词拆分）
  if (entries.length === 0) {
    entries = lookupProgramming(text.trim());
  }

  // 第三层：复合词拆分（同时查Linux词典和编程词典）
  if (entries.length === 0) {
    const words = splitCompoundWord(text.trim());
    if (words.length > 1) {
      for (const w of words) {
        // 先查Linux词典
        const linuxResults = lookupLinux(w);
        if (linuxResults.length > 0) {
          entries.push(...linuxResults.map((r) => ({ ...r, exact: false })));
        } else {
          // 再查编程词典（支持复合词拆分）
          const progResults = lookupProgramming(w);
          if (progResults.length > 0) {
            entries.push(...progResults.map((r) => ({ ...r, exact: false })));
          }
        }
      }
    }
  }

  const target = formatLookupResult(entries);

  return {
    source: text,
    target,
    success: entries.length > 0,
    entries,
  };
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
