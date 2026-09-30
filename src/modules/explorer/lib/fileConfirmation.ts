// 文件树删除确认的文案（#166 ③）
// -----------------------------------------------------------------------------
// 单独立一个文件是为了能被直接调用测到 —— FileExplorer.tsx 是一整棵虚拟滚动的树，
// 只为一句文案去 import 它不值。
//
// 两句 impact 都是对着实现核过的真事实：
// - 本地走 `fs_delete` = `std::fs::remove_file` / `remove_dir_all`；远端走 `fsb_delete`。
//   两边都是**直接删、不进回收站**，所以"无法恢复"不是吓唬人。
// - 目录会连里面的内容一起删（`remove_dir_all`）；文件不许带上这句。

import type { DeleteConfirmation } from "@/components/ConfirmDeleteDialog";

export type DeleteTargetEntry = {
  path: string;
  name: string;
  isDir: boolean;
};

export function fileConfirmation(target: DeleteTargetEntry): DeleteConfirmation {
  return {
    subject: target.isDir ? "这个文件夹" : "这个文件",
    name: target.name,
    impact: target.isDir
      ? "文件夹里的内容会一并删除，不进回收站，也无法恢复。"
      : "不进回收站，删除后无法恢复。",
    facts: [{ label: "路径", value: target.path }],
  };
}
