/**
 * knowledge-cache.ts — 知识库浏览器模块级浏览缓存（TDSF 2026-08-29）
 * -----------------------------------------------------------------------------
 * 按知识库隔离文件、文档和标题缓存；导入后统一失效。
 * 独立成文件是为了让 KnowledgeBrowser.tsx 只导出组件（react-refresh 约束），
 * 缓存清理函数供测试用例隔离状态。
 */

export type KnowledgeLibrary = "slim" | "full" | "builtin" | "personal" | "reference";

export interface KnowledgeDocument {
  id: string;
  url: string;
  title0: string;
  title_zh?: string;
  summary_zh?: string;
  source: string;
  category: string;
  chunks: number;
  total_chars: number;
  library: KnowledgeLibrary;
  possibly_truncated?: boolean;
  processing?: string;
}

export interface KnowledgeGroupSummary {
  category: string;
  source: string;
  entries: number;
  files: number;
}

export function knowledgeCacheKey(library: KnowledgeLibrary, key: string): string {
  return `${library}:${key}`;
}

/** knowledge.list_files 返回的文件级条目（同 url 分块聚合） */
export interface KnowledgeFile {
  url: string;
  filename: string;
  /** 该文件第一个块的标题（按块序号排序） */
  title0: string;
  chunks: number;
  total_chars: number;
  source: string;
  /** 6+1 分类 key（TDSF 2026-08-30；空 = 未分类，前端归「其他」） */
  category?: string;
}

/** knowledge.get_doc 返回（ok=false 时带 error） */
export interface KnowledgeDoc {
  ok: boolean;
  url?: string;
  filename?: string;
  source?: string;
  title?: string;
  content?: string;
  content_zh?: string;
  translation_complete?: boolean;
  translated_chunks?: number;
  possibly_truncated?: boolean;
  processing?: string;
  library?: KnowledgeLibrary;
  chunks?: number;
  total_chars?: number;
  /** 中文标题（doc_titles_zh 映射，无映射为空串，TDSF 2026-08-30） */
  title_zh?: string;
  /** 120 字中文内容摘要（gen_titles_zh.py 生成，详情弹窗顶部摘要条） */
  summary_zh?: string;
  error?: string;
}

/** 组内文件级列表缓存：library:category → files */
export const filesCache = new Map<string, KnowledgeFile[]>();

/** 完整文档缓存：library:url → doc（仅存 ok=true 的结果） */
export const docCache = new Map<string, KnowledgeDoc>();

/** 中文标题映射缓存：library:category → (url → 中文标题)。
 *  TDSF 2026-08-30: 6+1 分类分组后按组缓存（组内多 source 的 titles_zh
 *  合并结果）；底层请求仍 per source（knowledge.titles_zh） */
export const titlesZhCache = new Map<string, Map<string, string>>();

/** 导入后失效；测试也用它隔离每个用例。 */
export function clearKnowledgeCaches(): void {
  filesCache.clear();
  docCache.clear();
  titlesZhCache.clear();
}
