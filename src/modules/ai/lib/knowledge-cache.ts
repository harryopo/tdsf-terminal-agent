/**
 * knowledge-cache.ts — 知识库浏览器模块级浏览缓存（TDSF 魔改 2026-08-29）
 * -----------------------------------------------------------------------------
 * list_files per source / get_doc per url 的浏览缓存：弹窗重复打开、分组
 * 折叠展开、面板视图切换均不重复请求。导入新文档后需重开面板才刷新，
 * 属可接受的浏览缓存（搜索/详情 RPC 语义不受影响）。
 * 独立成文件是为了让 KnowledgeBrowser.tsx 只导出组件（react-refresh 约束），
 * 缓存清理函数供测试用例隔离状态。
 */

/** knowledge.list_files 返回的文件级条目（同 url 分块聚合） */
export interface KnowledgeFile {
  url: string;
  filename: string;
  /** 该文件第一个块的标题（按块序号排序） */
  title0: string;
  chunks: number;
  total_chars: number;
  source: string;
}

/** knowledge.get_doc 返回（ok=false 时带 error） */
export interface KnowledgeDoc {
  ok: boolean;
  url?: string;
  filename?: string;
  source?: string;
  title?: string;
  content?: string;
  chunks?: number;
  total_chars?: number;
  error?: string;
}

/** 组内文件级列表缓存：source → files */
export const filesCache = new Map<string, KnowledgeFile[]>();

/** 完整文档缓存：url → doc（仅存 ok=true 的结果，失败不缓存以便重试） */
export const docCache = new Map<string, KnowledgeDoc>();

/** 测试专用：清空模块级浏览缓存（每个用例前调用，避免跨用例串扰） */
export function clearKnowledgeCaches(): void {
  filesCache.clear();
  docCache.clear();
}
