/** 词典条目类型 */
export interface DictEntry {
  zh: string;
  pos?: string;
  tag?: string;
}

/** 翻译结果（P2-5: 扩展 example/syntax/detail，来自 2279 条词典） */
export interface LookupResult {
  word: string;
  zh: string;
  pos?: string;
  tag?: string;
  exact: boolean;
  example?: string;
  syntax?: string;
  detail?: string;
  category?: string;
}
