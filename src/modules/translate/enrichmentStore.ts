/**
 * enrichmentStore.ts — 本地增量词库（P6）
 * -----------------------------------------------------------------------------
 * 离线词库是只读的、会漏词；这里存"用户在翻译卡片上点过「AI 补全」后留下的释义"，
 * 让同一个词第二次遇到时直接本地命中，不再重复花模型额度。
 *
 * 定位边界（两条都是硬约束）：
 *   - 只服务**展示层**：这里的文本永远不会进命令执行链（见 enrichClient.ts 注释与测试）；
 *   - 只是缓存：可整体清空，不含任何用户数据，落在 localStorage（随 dev/release
 *     profile 天然隔离），删除它不影响离线词库与 shell。
 */
import type { LookupResult } from "./linuxDictionary";

const STORAGE_KEY = "tdsf.translate.enrichments.v1";

/** 条目上限：超出按先进先出丢弃（词条很小，500 条约几十 KB） */
export const ENRICHMENT_LIMIT = 500;

export interface EnrichmentEntry {
  /** 原词（保存用户看到的形式） */
  word: string;
  /** 中文释义 */
  zh: string;
  /** 可选示例（命令类词条） */
  example?: string;
  /** 生成时间戳（ms），用于审计"这条什么时候来的" */
  at: number;
  /** 来源标记：目前只有模型兜底会写入 */
  source: "llm";
}

function readAll(): EnrichmentEntry[] {
  try {
    if (typeof window === "undefined") return [];
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isEntry);
  } catch {
    return [];
  }
}

function isEntry(v: unknown): v is EnrichmentEntry {
  if (typeof v !== "object" || v === null) return false;
  const e = v as Partial<EnrichmentEntry>;
  return (
    typeof e.word === "string" &&
    typeof e.zh === "string" &&
    typeof e.at === "number" &&
    e.source === "llm"
  );
}

function writeAll(entries: EnrichmentEntry[]): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
  } catch {
    // 隐私模式 / 配额不足：缓存丢失可接受，不影响离线词库
  }
}

/** 命中用的键：小写去空格，避免 `grep` / `GREP` 各存一条 */
function canonical(word: string): string {
  return word.trim().toLowerCase();
}

/**
 * 查增量词库（供 translateText 在离线词库之后、ECDICT 之前调用）。
 * 返回的条目带 `exact`，并且 example 缺失时不伪造。
 */
export function lookupEnrichments(word: string): LookupResult[] {
  const key = canonical(word);
  if (!key) return [];
  return readAll()
    .filter((e) => canonical(e.word) === key)
    .map((e) => ({
      word: e.word,
      zh: e.zh,
      example: e.example,
      exact: true,
    }));
}

/** 写入 / 覆盖一个词条（同词重写，不产生重复条目），并按上限 FIFO 截断 */
export function putEnrichment(entry: Omit<EnrichmentEntry, "at" | "source">): void {
  const word = entry.word.trim();
  const zh = entry.zh.trim();
  if (!word || !zh) return;
  const key = canonical(word);
  const rest = readAll().filter((e) => canonical(e.word) !== key);
  const next: EnrichmentEntry[] = [
    ...rest,
    { word, zh, example: entry.example?.trim() || undefined, at: Date.now(), source: "llm" },
  ];
  writeAll(next.length > ENRICHMENT_LIMIT ? next.slice(next.length - ENRICHMENT_LIMIT) : next);
}

export function listEnrichments(): EnrichmentEntry[] {
  return readAll();
}

export function clearEnrichments(): void {
  writeAll([]);
}
