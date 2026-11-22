// TDSF: Skill 内容预览对话框
// -----------------------------------------------------------------------------
// TEAM-FIX-01: 侧栏“查看”入口与 /skill 共用同一结果合同：
//   - 打开时经 skillsStore.invoke 读取参考资料（recordHistory=false，不污染调用历史）
//   - reference: 展示返回的参考内容；空资料明确提示“未提供参考资料”
//   - failed/unknown: 如实提示，并回退到本地 SKILL.md 预览（标注未执行）
//   - 始终说明“仅提供参考资料，未执行命令”，不推断执行主机
//
// 数据来源:
//   Python skill.invoke → get_reference（execution=not_run）；
//   skill.rawContent 由 registry.dictToMetadata 从 skill.list 的 body 透传，
//   仅在读取失败/加载中作为本地预览兜底。

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
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
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Streamdown } from "streamdown";
import { describeSkillContext, describeSkillResult } from "./resultNotice";
import { useSkillsStore } from "./skillsStore";
import type { SkillExecution, SkillMetadata } from "./types";

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
  const invoke = useSkillsStore((s) => s.invoke);
  const [result, setResult] = useState<SkillExecution | null>(null);
  const [loading, setLoading] = useState(false);

  const open = skill !== null;
  const skillName = skill?.name ?? "";
  const fallbackContent = skill?.rawContent ?? "";
  // TDSF: 是否可打开目录（仅当 Python sidecar 返回了 file_path 时）
  const canOpenDir = !!skill?.filePath;

  useEffect(() => {
    if (!skillName) {
      setResult(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setResult(null);
    setLoading(true);
    void invoke(skillName, "", { recordHistory: false })
      .then((res) => {
        if (!cancelled) setResult(res);
      })
      .catch((err) => {
        if (!cancelled) {
          setResult({
            success: false,
            output: err instanceof Error ? err.message : String(err),
            durationMs: 0,
            mode: "failed",
          });
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [skillName, invoke]);

  const notice = result ? describeSkillResult(skillName, result) : null;
  const referenceContent = result?.mode === "reference" ? result.output : "";
  const isReferenceEmpty =
    result?.mode === "reference" && result.empty === true;
  const executedContent = result?.mode === "executed" ? result.output : "";
  const readFailed =
    result?.mode === "failed" || result?.mode === "unknown";
  const content =
    referenceContent || executedContent || (readFailed ? fallbackContent : "");
  const hasContent = content.trim().length > 0;

  // TDSF: 调用系统文件管理器聚焦 SKILL.md
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
          <DialogDescription>
            Skill 完整内容（SKILL.md）
            <span className="mt-1 block text-[11px] opacity-80">
              {describeSkillContext(result)}
            </span>
            {loading && (
              <span className="mt-1 flex items-center gap-1.5 text-[11px] opacity-80">
                <Spinner className="size-3" />
                读取参考资料中…
              </span>
            )}
            {!loading && notice && (
              <span className="mt-1 block text-[11px] opacity-80">
                {notice.label}
              </span>
            )}
          </DialogDescription>
        </DialogHeader>

        {readFailed && hasContent && (
          <p className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
            读取参考资料失败，以下为本地 SKILL.md 预览（未执行命令）。
          </p>
        )}

        {/* === 内容区：markdown 渲染 + 滚动 === */}
        <div className="max-h-[60vh] overflow-auto rounded-lg border border-border/60 bg-muted/30 p-4">
          {loading && !hasContent ? (
            <div className="flex h-32 items-center justify-center text-[12px] text-muted-foreground">
              读取参考资料中，请稍候…
            </div>
          ) : hasContent ? (
            <Streamdown
              className="select-text [&>*:first-child]:mt-0 [&>*:last-child]:mb-0"
              mode="static"
              parseIncompleteMarkdown={false}
            >
              {content}
            </Streamdown>
          ) : (
            <div className="flex h-32 items-center justify-center text-[12px] text-muted-foreground">
              {isReferenceEmpty
                ? "该技能未提供参考资料。"
                : readFailed
                  ? "读取参考资料失败，且没有本地预览内容。"
                  : "暂无内容（Python sidecar 可能未启动，或 builtin 降级列表无 SKILL.md 原文）"}
            </div>
          )}
        </div>

        <DialogFooter>
          {/* TDSF: 新增"打开目录"按钮,与"关闭"按钮并排
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