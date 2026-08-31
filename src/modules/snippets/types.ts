/**
 * snippets/types.ts — 代码片段数据模型
 *
 * P2 代码片段管理（方案书 v1.1 §5）：常用 Linux 命令片段一键插入终端。
 * 支持标签分组、自定义变量插值（{{name}}）、置顶排序（最后置顶最靠上）。
 */

/** 片段自定义变量定义（{{name}} 占位符） */
export interface SnippetVar {
  /** 变量名（不含花括号，命令中以 {{name}} 引用） */
  name: string;
  /** 默认值（插入时可修改） */
  defaultValue?: string;
}

/** 代码片段 */
export interface Snippet {
  /** 唯一 id（crypto.randomUUID 生成） */
  id: string;
  /** 名称（列表展示） */
  name: string;
  /** 命令模板（可含 {{var}} 占位符） */
  command: string;
  /** 描述 */
  description?: string;
  /** 标签（分组过滤） */
  tags: string[];
  /** 自定义变量定义 */
  variables: SnippetVar[];
  createdAt: number;
  updatedAt: number;
  /** 置顶时间戳（存在即置顶；列表按置顶先后排列，最后置顶的最靠上） */
  pinnedAt?: number;
}

/** 内置变量（插入时自动解析，无需用户填写） */
export const BUILTIN_VARS = ["cwd"] as const;
