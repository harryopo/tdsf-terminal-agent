// TDSF 魔改: Skill 内容预览对话框
// -----------------------------------------------------------------------------
// 弹窗（shadcn Dialog）用于查看 skill 的 SKILL.md 完整内容：
//   - 标题：skill name（font-mono）+ 分类标签
//   - 内容：使用 streamdown 渲染 markdown（与 MarkdownPreviewPane 一致）
//   - 内容区域支持滚动（max-h 限制 + overflow-auto）
//   - 空内容（降级模式 / IPC 失败）显示提示文本
//   - 底部"关闭"按钮
//
// 数据来源:
//   skill.rawContent 由 registry.dictToMetadata 从 Python skill.list 返回的
//   body 字段透传而来；IPC 降级时为空字符串。

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EyeIcon, FolderOpenIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { Streamdown } from "streamdown";
import type { SkillMetadata } from "./types";

/** 分类 → 中文标签（与 SkillCard 中保持一致） */
const CATEGORY_LABEL: Record<string, string> = {
  linux: "Linux",
  docker: "Docker",
  ssh: "SSH",
  python: "Python",
  custom: "自定义",
};

interface Props {
  /** 要预览的 skill（null 时关闭） */
  skill: SkillMetadata | null;
  /** 关闭回调 */
  onOpenChange: (open: boolean) => void;
}

export function SkillContentDialog({ skill, onOpenChange }: Props) {
  const open = skill !== null;
  const content = skill?.rawContent ?? "";
  const hasContent = content.trim().length > 0;
  // TDSF 魔改: 是否可打开目录（仅当 Python sidecar 返回了 file_path 时）
  const canOpenDir = !!skill?.filePath;

  // TDSF 魔改: 调用系统文件管理器聚焦 SKILL.md
  const handleOpenDir = async () => {
    if (!skill?.filePath) return;
    try {
      await revealItemInDir(skill.filePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("打开 Skill 目录失败", { description: msg, duration: 3000 });
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[760px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <HugeiconsIcon
              icon={EyeIcon}
              size={16}
              strokeWidth={1.75}
              className="shrink-0 text-primary"
            />
            <span className="font-mono text-[14px]">{skill?.name ?? ""}</span>
            {skill?.category && (
              <span className="shrink-0 rounded-md bg-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-secondary-foreground">
                {CATEGORY_LABEL[skill.category] ?? skill.category}
              </span>
            )}
          </DialogTitle>
          <DialogDescription>Skill 完整内容（SKILL.md）</DialogDescription>
        </DialogHeader>

        {/* === 内容区：markdown 渲染 + 滚动 === */}
        <div className="max-h-[60vh] overflow-auto rounded-lg border border-border/60 bg-muted/30 p-4">
          {hasContent ? (
            <Streamdown
              className="select-text [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
              mode="static"
              parseIncompleteMarkdown={false}
            >
              {content}
            </Streamdown>
          ) : (
            <div className="flex h-32 items-center justify-center text-[12px] text-muted-foreground">
              暂无内容（Python sidecar 可能未启动，或 builtin 降级列表无
              SKILL.md 原文）
            </div>
          )}
        </div>

        <DialogFooter>
          {/* TDSF 魔改: 新增"打开目录"按钮,与"关闭"按钮并排
              - 仅当 skill.filePath 存在时显示
              - 使用 revealItemInDir 在文件管理器中聚焦 SKILL.md */}
          {canOpenDir && (
            <Button
              type="button"
              variant="outline"
              onClick={() => void handleOpenDir()}
              className="gap-1.5 text-[12px]"
              title={skill?.filePath ?? undefined}
            >
              <HugeiconsIcon
                icon={FolderOpenIcon}
                size={12}
                strokeWidth={1.75}
              />
              打开目录
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="text-[12px]"
          >
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
