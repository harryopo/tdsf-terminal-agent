/**
 * TeachCard.tsx — Teach 教学卡片（P2-1）
 * -----------------------------------------------------------------------------
 * teach 子 agent 输出结构化 markdown（6 大板块教学法）：
 *   概念与原理 / 路径拆解 / Linux 设计哲学 /
 *   操作示例 / 易错点与考点 / 练习
 *
 * 本组件解析该结构，渲染为分区教学卡片：
 *   - 头部：Teach Agent 徽标 + 主题
 *   - 分区卡片：概念（原理卡）/ 示例（命令块 + 复制 + 插入终端）/
 *     易错（警示卡）/ 练习（练习卡 + 追问）
 *   - 命令块复用 suggest_command 的 Insert 机制（只插入不执行）
 * 设计规范：不使用 emoji，图标统一 HugeiconsIcon，UI 组件用项目
 * 组件库（Badge/Button/Separator）。
 */

import { memo, useEffect, useMemo, useState } from "react";
import { useChatStore } from "../store/chatStore";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import {
  BookOpen01Icon,
  BulbIcon,
  CheckListIcon,
  Alert02Icon,
  PencilEdit02Icon,
  TerminalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { MessageResponse } from "@/components/ai-elements/message";
import {
  parseTeachSections,
  type TeachSection,
  type TeachSectionType,
} from "./teachParser";

// Keep lesson prose compact and consistent with normal assistant Markdown.
// Without this class Streamdown's default heading margins make each section
// look like a separate page and make accidental long text hard to scan.
const TEACH_MARKDOWN_CLASS =
  "max-w-none text-[12px] leading-[1.65] text-foreground [&>*:not(:first-child)]:mt-2 [&_[data-streamdown=heading-1]]:mt-2.5 [&_[data-streamdown=heading-1]]:text-[15px] [&_[data-streamdown=heading-1]]:font-semibold [&_[data-streamdown=heading-1]]:tracking-tight [&_[data-streamdown=heading-2]]:mt-2.5 [&_[data-streamdown=heading-2]]:text-[14px] [&_[data-streamdown=heading-2]]:font-semibold [&_[data-streamdown=heading-3]]:mt-2 [&_[data-streamdown=heading-3]]:text-[13px] [&_[data-streamdown=heading-3]]:font-semibold [&_ul]:my-1.5 [&_ul]:pl-4 [&_ol]:my-1.5 [&_ol]:pl-4 [&_li]:my-0.5 [&_blockquote]:my-1.5 [&_blockquote]:border-l-2 [&_blockquote]:border-primary/35 [&_blockquote]:pl-2.5 [&_blockquote]:text-muted-foreground [&_table]:my-1.5 [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto";

// ============================================================================
// TeachCard 组件
// ============================================================================

const TYPE_META: Record<
  TeachSectionType,
  { label: string; icon: typeof BulbIcon; cls: string }
> = {
  concept: {
    label: "概念与原理",
    icon: BulbIcon,
    cls: "border-sky-500/25 bg-sky-500/[0.035]",
  },
  path: {
    label: "路径拆解",
    icon: TerminalIcon,
    cls: "border-violet-500/25 bg-violet-500/[0.035]",
  },
  philosophy: {
    label: "设计哲学",
    icon: BookOpen01Icon,
    cls: "border-sky-500/30 bg-sky-500/[0.035]",
  },
  example: {
    label: "操作示例",
    icon: TerminalIcon,
    cls: "border-violet-500/30 bg-violet-500/[0.045]",
  },
  pitfall: {
    label: "易错点",
    icon: Alert02Icon,
    cls: "border-amber-500/40 bg-amber-500/[0.045]",
  },
  exercise: {
    label: "练习",
    icon: PencilEdit02Icon,
    cls: "border-emerald-500/30 bg-emerald-500/[0.035]",
  },
  // TDSF 2026-08-31 (问题4修复): other 兜底徽标「讲解」——承接标题前导语
  // （自我介绍/开场白）与无法归类的标题，避免内容与徽标错位。
  other: {
    label: "讲解",
    icon: CheckListIcon,
    cls: "border-border/50 bg-card/40",
  },
};

export const TeachCard = memo(
  function TeachCard({ content }: { content: string }) {
    const sections = useMemo(() => parseTeachSections(content), [content]);

    if (sections.length === 0) {
      return null;
    }

    // 主题 = 第一个非 concept 分节标题 或 concept 标题
    const topic =
      sections.find((s) => s.type !== "concept" && s.type !== "other")?.title ??
      sections[0].title ??
      "Linux 教学";

    return (
      <div
        data-testid="teach-card"
        className="not-prose overflow-hidden rounded-xl border border-violet-500/25 bg-card/70 shadow-sm"
      >
        {/* 头部 */}
        <div className="flex items-center gap-2 border-b border-violet-500/20 bg-violet-500/[0.04] px-3 py-2.5">
          <span className="flex size-6 items-center justify-center rounded-md bg-violet-500/15">
            <HugeiconsIcon
              icon={BookOpen01Icon}
              size={13}
              strokeWidth={1.75}
              className="text-violet-500"
            />
          </span>
          <span className="text-[11.5px] font-semibold text-foreground">
            Teach Agent
          </span>
          <span className="min-w-0 flex-1 truncate text-[10px] text-muted-foreground">
            {topic.length > 30 ? topic.slice(0, 30) + "…" : topic}
          </span>
          <Badge
            variant="secondary"
            className="shrink-0 border-violet-500/30 bg-violet-500/10 px-1.5 py-px text-[10px] font-medium text-violet-600 dark:text-violet-400"
          >
            教学
          </Badge>
        </div>

        <div className="flex gap-1 overflow-x-auto border-b border-border/40 px-3 py-1.5">
          {sections.map((section, i) => (
            <span
              key={`${section.type}-${i}`}
              className="shrink-0 rounded bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground"
            >
              {String(i + 1).padStart(2, "0")} {TYPE_META[section.type].label}
            </span>
          ))}
        </div>

        {/* 分区 */}
        <div className="space-y-2.5 p-3">
          {sections.map((s, i) => (
            <TeachSectionBlock key={i} section={s} index={i} />
          ))}
        </div>
      </div>
    );
  },
  (a, b) => a.content === b.content,
);

// ============================================================================
// 分区渲染
// ============================================================================

function TeachSectionBlock({
  section,
  index,
}: {
  section: TeachSection;
  index: number;
}) {
  const meta = TYPE_META[section.type];

  return (
    <div
      data-testid={`teach-section-${section.type}`}
      className={cn("rounded-lg border px-3 py-2.5 shadow-sm", meta.cls)}
    >
      <div className="mb-1 flex items-center gap-1.5">
        <span className="mr-0.5 rounded bg-background/60 px-1 py-0.5 font-mono text-[9px] text-muted-foreground/70">
          {String(index + 1).padStart(2, "0")}
        </span>
        <HugeiconsIcon icon={meta.icon} size={12} strokeWidth={1.75} />
        <span className="text-[11px] font-semibold text-foreground">
          {meta.label}
        </span>
        {section.title && section.title !== meta.label && (
          <span className="truncate text-[10.5px] text-muted-foreground/70">
            {section.title}
          </span>
        )}
      </div>

      {/* 命令块（示例节）：复制 + 插入终端 */}
      {section.commands.length > 0 && (
        <div className="mb-1.5 space-y-1">
          {section.commands.map((cmd, i) => (
            <CommandRow key={i} command={cmd} />
          ))}
        </div>
      )}

      {/* markdown 正文（复用项目 Streamdown 渲染） */}
      {section.content.trim() && (
        <div className="text-[11.5px] leading-relaxed text-muted-foreground">
          <MessageResponse className={TEACH_MARKDOWN_CLASS}>
            {section.content}
          </MessageResponse>
        </div>
      )}
    </div>
  );
}

/** 命令行：复制 + 插入终端（复用 suggest_command 的 Insert 机制） */
function CommandRow({ command }: { command: string }) {
  const [inserted, setInserted] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);

  const onInsert = () => {
    const ok = useChatStore.getState().live.injectIntoActivePty(command);
    if (ok) setInserted(true);
  };
  const onCopy = () => {
    void navigator.clipboard?.writeText(command);
    setCopied(true);
  };

  return (
    <div className="flex items-stretch overflow-hidden rounded-md border border-border/50 bg-muted/30">
      <pre className="flex-1 overflow-x-auto px-2 py-1 font-mono text-[11px] leading-relaxed text-foreground">
        {command}
      </pre>
      <button
        type="button"
        onClick={onCopy}
        title="复制命令"
        className="shrink-0 border-l border-border/50 px-2 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {copied ? "已复制" : "复制"}
      </button>
      <button
        type="button"
        onClick={onInsert}
        disabled={inserted}
        title="插入到当前终端（不执行）"
        className={cn(
          "shrink-0 border-l border-border/50 px-2 text-[10px] font-medium transition-colors",
          inserted
            ? "text-emerald-600 dark:text-emerald-400"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        {inserted ? "已插入" : "插入终端"}
      </button>
    </div>
  );
}
