// 片段删除确认的文案（#166 ③）
// -----------------------------------------------------------------------------
// 与 SnippetsPanel 分开放：面板文件导出非组件函数会让 react-refresh 失效
// （HMR 时整棵子树重挂载），lint 的 only-export-components 就是钉这件事的。

import type { DeleteConfirmation } from "@/components/ConfirmDeleteDialog";
import type { Snippet } from "../types";

/**
 * 「不可恢复」这句要说，因为片段确实只存在这台机器上（store 落 localStorage/LazyStore，
 * 没有云端副本）；同时说清边界：只删这一条片段，终端和已连接的主机都不受影响。
 */
export function snippetConfirmation(s: Snippet): DeleteConfirmation {
  return {
    subject: "这个片段",
    name: s.name,
    impact: "片段只存在这台机器上，删除后无法恢复。终端与已连接的主机不受影响。",
    facts: [
      { label: "命令", value: s.command },
      ...(s.tags.length ? [{ label: "标签", value: s.tags.join(" · ") }] : []),
    ],
  };
}
