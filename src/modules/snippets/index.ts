// TDSF 魔改 (P2 代码片段管理, 方案书 v1.1 §5): 模块入口
export { SnippetsPanel } from "./SnippetsPanel";
export {
  collectPlaceholders,
  interpolate,
  sortSnippets,
  useSnippetsStore,
} from "./lib/snippetStore";
export type { Snippet, SnippetVar } from "./types";
export { BUILTIN_VARS } from "./types";
