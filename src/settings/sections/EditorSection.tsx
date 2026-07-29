// TDSF 魔改 (P4-T4.1): 编辑器设置 (字体/缩进/LSP) — 全量中文化
// -----------------------------------------------------------------------------
// 涵盖:
//   - 字体大小
//   - 字体族
//   - 缩进 (Tab/空格)
//   - Tab 宽度
//   - 自动换行
//   - 启用 LSP
//
// 字体/换行等大部分选项在「通用」tab 内,这里聚焦"编辑器专属"行为.

import { LspServersGroup } from "../components/LspServersGroup";
import { SectionHeader } from "../components/SectionHeader";

export function EditorSection() {
  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        title="编辑器"
        description="缩进、字体、LSP 与自动换行等编辑器专属行为。"
      />

      <div className="rounded-lg border border-border/40 bg-muted/20 px-3 py-2 text-[11.5px] text-muted-foreground">
        字体大小、Vim 模式、保存时格式化等通用选项请前往「通用」tab。
      </div>

      <div className="flex flex-col gap-2">
        <Label>语言服务器 (LSP)</Label>
        <LspServersGroup />
      </div>

      <div className="flex flex-col gap-2">
        <Label>提示</Label>
        <p className="text-[11px] text-muted-foreground">
          通过 LSP
          协议,编辑器可获得代码补全、跳转定义、悬浮文档、引用查找、重命名等高级能力。
          已安装的 LSP 服务器会按文件类型自动启用。
        </p>
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
      {children}
    </span>
  );
}
