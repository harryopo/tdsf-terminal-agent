// TDSF 魔改 (P4-T4.4): Skill 卡片组件
// -----------------------------------------------------------------------------
// 单个 skill 的展示卡片，含：
//   - 顶部：分类图标 + 名称 + 来源 badge + 启用开关
//   - 中部：description（2 行截断）+ whenToUse（折叠）
//   - 底部：查看内容按钮 + 打开目录按钮 + 展开示例（折叠区）
//
// 交互:
//   - 点击 Switch 切换 enabled（持久化到 localStorage）
//   - 点击"查看内容"按钮触发 onViewContent 回调（由 SkillsPanel 弹出 SkillContentDialog）
//   - 点击"打开目录"按钮在系统文件管理器中聚焦 SKILL.md
//   - 点击"详情"展开/收起 whenToUse / examples
//
// TDSF 魔改 2026-07-28 (P0-2 方案A):
//   - 原"调用"按钮名实不符（skill.invoke 仅返回 SKILL.md 文本, 无执行逻辑）
//   - 现统一为"查看内容"按钮, 弹 SkillContentDialog 显示完整 SKILL.md
//
// TDSF 魔改: UI 简约大气化，移除 emerald 硬编码，统一使用语义色（primary/secondary）。

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import {
  AiMagicIcon,
  ChevronDownIcon,
  EyeIcon,
  FolderOpenIcon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { useState } from "react";
import { toast } from "sonner";
import type { SkillMetadata } from "./types";

interface Props {
  skill: SkillMetadata;
  /** 切换启用状态 */
  onToggleEnabled: (name: string) => void;
  /** 触发查看内容（弹出 SkillContentDialog） */
  onViewContent: (skill: SkillMetadata) => void;
  /** TDSF 魔改 2026-07-28: 让 Agent 调用此 skill（弹出 SkillInvoker） */
  onInvoke?: (skill: SkillMetadata) => void;
}

// TDSF 魔改: 分类 → 图标颜色统一为 text-primary，避免硬编码颜色名
const CATEGORY_COLOR: Record<string, string> = {
  linux: "text-primary",
  docker: "text-primary",
  ssh: "text-primary",
  python: "text-primary",
  custom: "text-muted-foreground",
};

/** 分类 → 中文标签 */
const CATEGORY_LABEL: Record<string, string> = {
  linux: "Linux",
  docker: "Docker",
  ssh: "SSH",
  python: "Python",
  custom: "自定义",
};

// TDSF 魔改: 来源 → badge 样式统一使用语义色（bg-secondary / bg-muted）
const SOURCE_BADGE: Record<string, { label: string; className: string }> = {
  builtin: {
    label: "内置",
    className: "bg-secondary text-secondary-foreground",
  },
  installed: {
    label: "已安装",
    className: "bg-muted text-muted-foreground",
  },
  user: {
    label: "用户",
    className: "bg-muted text-muted-foreground",
  },
};

export function SkillCard({
  skill,
  onToggleEnabled,
  onViewContent,
  onInvoke,
}: Props) {
  const [expanded, setExpanded] = useState(false);
  const categoryColor = CATEGORY_COLOR[skill.category] ?? CATEGORY_COLOR.custom;
  const sourceBadge = SOURCE_BADGE[skill.source] ?? SOURCE_BADGE.user;
  const hasExamples = skill.examples.length > 0;
  // TDSF 魔改: 是否可打开目录（仅当 Python sidecar 返回了 file_path 时）
  const canOpenDir = !!skill.filePath;

  // TDSF 魔改: 调用 tauri-plugin-opener 的 revealItemInDir 在文件管理器中聚焦 SKILL.md
  const handleOpenDir = async () => {
    if (!skill.filePath) return;
    try {
      await revealItemInDir(skill.filePath);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error("打开 Skill 目录失败", { description: msg, duration: 3000 });
    }
  };

  return (
    <div
      className={cn(
        // TDSF 魔改: 卡片间距 p-3.5 → p-4, hover 边框使用语义色 border-border
        // TDSF 魔改 2026-07-28: 修复"按钮被遮挡"问题
        //   - 加 h-full 让 grid item 拉伸到同行最高卡片高度
        //   - 加 min-h-[180px] 给最小高度, 防止空描述时按钮贴顶
        //   - 中部描述区 max-h + overflow-y-auto, 描述过长时出滚动条
        //   - 底部按钮区 mt-auto 强制贴底, 不被内容挤出可视区
        "flex h-full min-h-[180px] max-h-[280px] flex-col gap-2 rounded-lg border border-border/60 bg-card/80 p-3.5 backdrop-blur transition-colors",
        "hover:border-border hover:bg-card",
        skill.enabled ? "opacity-100" : "opacity-60",
      )}
      data-testid={`skill-card-${skill.name}`}
    >
      {/* === 顶部：图标 + 名称 + 来源 + 开关 (固定不动) === */}
      <div className="flex shrink-0 items-start gap-2">
        <HugeiconsIcon
          icon={SparklesIcon}
          size={16}
          strokeWidth={1.75}
          className={cn("mt-0.5 shrink-0", categoryColor)}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span
              className="truncate font-mono text-[12px] font-semibold text-foreground"
              title={skill.name}
            >
              {skill.name}
            </span>
            <span
              className={cn(
                "shrink-0 rounded-md px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide",
                sourceBadge.className,
              )}
            >
              {sourceBadge.label}
            </span>
          </div>
          <span className="text-[10px] text-muted-foreground">
            {CATEGORY_LABEL[skill.category]}
            {skill.version ? ` · v${skill.version}` : ""}
          </span>
        </div>
        <Switch
          size="sm"
          checked={skill.enabled}
          onCheckedChange={() => onToggleEnabled(skill.name)}
          aria-label={`切换 ${skill.name} 启用状态`}
        />
      </div>

      {/* === 中部：description + whenToUse + examples (可滚动区) ===
          TDSF 魔改 2026-07-28: flex-1 + min-h-0 + overflow-y-auto
          让内容超出时只在这个区域内滚动, 按钮始终贴底可见 */}
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1">
        <p
          className="text-[11px] leading-relaxed text-muted-foreground"
          title={skill.description}
        >
          {skill.description}
        </p>

        {skill.whenToUse && expanded && (
          <div className="rounded-md bg-muted/40 px-2 py-1.5">
            <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
              触发条件
            </div>
            <p className="text-[10.5px] leading-relaxed text-foreground/80">
              {skill.whenToUse}
            </p>
          </div>
        )}

        {hasExamples && expanded && (
          <div className="rounded-md bg-muted/30 px-2 py-1.5">
            <div className="mb-0.5 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground">
              示例
            </div>
            <ul className="space-y-0.5">
              {skill.examples.map((ex) => (
                <li
                  key={`ex-${ex}`}
                  className="text-[10.5px] leading-relaxed text-foreground/70"
                >
                  {ex}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* === 底部: 让 Agent 调用 + 查看内容 + 目录 + 详情 (固定贴底, 永远可见) ===
          TDSF 魔改 2026-07-28: P0-2 方案B 修复 (用户反馈: 按钮语义要明确)
          - 主按钮改为"让 Agent 调用" (WandMagicSparkles 图标 + 语义色),
            表达"触发 Agent 使用此 skill", 弹 SkillInvoker 真正调用
          - 次按钮"查看" (EyeIcon), 弹 SkillContentDialog 显示 SKILL.md 定义
          - 移除 mt-auto (在 flex 中已自动贴底),
            移除 pt-1 减少上下间距, 让按钮更紧凑避免被挤压 */}
      <div className="flex shrink-0 items-center gap-1 border-t border-border/30 pt-1.5">
        {/* TDSF 魔改 2026-07-28: 主按钮"让 Agent 调用" - 真正调用 skill (有 args 输入 + 输出流式展示) */}
        {onInvoke && (
          <Button
            type="button"
            size="sm"
            variant="default"
            disabled={!skill.enabled}
            onClick={() => onInvoke(skill)}
            className={cn(
              "h-7 gap-1 rounded-md px-2 text-[10.5px] font-medium",
              "bg-primary text-primary-foreground hover:bg-primary/90",
              "disabled:cursor-not-allowed disabled:opacity-50",
            )}
            data-testid={`skill-invoke-btn-${skill.name}`}
            title="让 Agent 用此 skill 处理你的问题"
          >
            <HugeiconsIcon icon={AiMagicIcon} size={11} strokeWidth={1.75} />让
            Agent 调用
          </Button>
        )}
        {/* TDSF 魔改 2026-07-28: 次按钮"查看" - 弹 SkillContentDialog 显示 SKILL.md 定义 */}
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => onViewContent(skill)}
          className="h-7 gap-1 rounded-md px-2 text-[10.5px]"
          data-testid={`skill-view-content-btn-${skill.name}`}
          title="查看此 skill 的 SKILL.md 定义"
        >
          <HugeiconsIcon icon={EyeIcon} size={11} strokeWidth={1.75} />
          查看
        </Button>
        {/* TDSF 魔改: 新增"打开目录"按钮，调用系统文件管理器聚焦 SKILL.md
            - 仅当 skill.filePath 存在（Python sidecar 返回 file_path）时显示
            - builtin 降级列表无 file_path，按钮不显示，避免误导用户
            - 使用 revealItemInDir 而非 openPath，让用户直接看到 SKILL.md 文件本身 */}
        {canOpenDir && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => void handleOpenDir()}
            className="h-7 gap-1 px-2 text-[10.5px] text-muted-foreground hover:text-foreground"
            aria-label={`在文件管理器中打开 ${skill.name} 目录`}
            title={skill.filePath ?? undefined}
            data-testid={`skill-open-dir-btn-${skill.name}`}
          >
            <HugeiconsIcon icon={FolderOpenIcon} size={11} strokeWidth={1.75} />
            目录
          </Button>
        )}
        {(hasExamples || skill.whenToUse) && (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setExpanded((v) => !v)}
            className="h-7 gap-0.5 px-2 text-[10.5px] text-muted-foreground hover:text-foreground"
            aria-expanded={expanded}
            aria-label={expanded ? "收起详情" : "展开详情"}
          >
            <HugeiconsIcon
              icon={ChevronDownIcon}
              size={11}
              strokeWidth={1.75}
              className={cn(
                "transition-transform duration-150",
                expanded && "rotate-180",
              )}
            />
            {expanded ? "收起" : "详情"}
          </Button>
        )}
      </div>
    </div>
  );
}
