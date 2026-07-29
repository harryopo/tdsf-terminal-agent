/** 词典条目类型 */
export interface DictEntry {
  zh: string;
  pos?: string;
  tag?: string;
}

/** 翻译结果 */
export interface LookupResult {
  word: string;
  zh: string;
  pos?: string;
  tag?: string;
  exact: boolean;
}
