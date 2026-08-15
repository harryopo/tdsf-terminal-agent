// TDSF 魔改 (P4-T4.4): Skill 管理面板主组件
// -----------------------------------------------------------------------------
// 布局（侧边栏内嵌）:
//   ┌─────────────────────────────────────┐
//   │ 工具栏: Sparkles 图标 + 标题 + 刷新  │
//   ├─────────────────────────────────────┤
//   │ 搜索框 + 分类 tabs (All/Linux/...)  │
//   ├─────────────────────────────────────┤
//   │ SkillCard 网格（每行 2 个）          │
//   │  - 加载中: Spinner                  │
//   │  - 错误: retry 按钮                 │
//   │  - 空状态: 提示文本                 │
//   └─────────────────────────────────────┘
//
// 数据流:
//   - mount 时调用 store.loadAll() 加载 skill 列表
//   - 用户搜索/切换 tab 时本地筛选（filterSkills 纯函数）
//   - Agent 在允许时自动调用 skill，无手动调用窗口
//   - 点击"查看"按钮弹出 SkillContentDialog 预览 SKILL.md 定义
//   TDSF 魔改 2026-08-15: 移除 SkillInvoker 手动调用弹窗（用户反馈: 无需调用窗口）

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  AlertCircleIcon,
  Loading03Icon,
  RefreshIcon,
  Search01Icon,
  SparklesIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { SkillCard } from "./SkillCard";

// TDSF 魔改: SkillContentDialog 懒加载，避免 streamdown 进入启动 bundle（eager-budget 约束）
// 仅在用户点击"查看"按钮时才加载 streamdown
const SkillContentDialog = lazy(() =>
  import("./SkillContentDialog").then((m) => ({
    default: m.SkillContentDialog,
  })),
);

import {
  filterSkills,
  type SkillFilterTab,
  useSkillsStore,
} from "./skillsStore";
import type { SkillCategory, SkillMetadata } from "./types";

/** 分类 tab 列表（顺序固定） */
const FILTER_TABS: Array<{ id: SkillFilterTab; label: string }> = [
  { id: "all", label: "全部" },
  { id: "linux", label: "Linux" },
  { id: "docker", label: "Docker" },
  { id: "ssh", label: "SSH" },
  { id: "python", label: "Python" },
  { id: "custom", label: "自定义" },
];

interface Props {
  /** 父容器 className */
  className?: string;
}

export function SkillsPanel({ className }: Props) {
  const skills = useSkillsStore((s) => s.skills);
  const loading = useSkillsStore((s) => s.loading);
  const error = useSkillsStore((s) => s.error);
  const loaded = useSkillsStore((s) => s.loaded);
  const filterTab = useSkillsStore((s) => s.filterTab);
  const searchQuery = useSkillsStore((s) => s.searchQuery);
  const loadAll = useSkillsStore((s) => s.loadAll);
  const setFilterTab = useSkillsStore((s) => s.setFilterTab);
  const setSearchQuery = useSkillsStore((s) => s.setSearchQuery);
  const toggleEnabled = useSkillsStore((s) => s.toggleEnabled);

  // TDSF 魔改 2026-07-28: viewerSkill 管内容预览 dialog
  const [viewerSkill, setViewerSkill] = useState<SkillMetadata | null>(null);

  // mount 时加载 skill 列表（仅首次）
  useEffect(() => {
    if (!loaded && !loading) {
      void loadAll();
    }
  }, [loaded, loading, loadAll]);

  const filtered = useMemo(
    () => filterSkills(skills, filterTab, searchQuery),
    [skills, filterTab, searchQuery],
  );

  // TDSF 魔改 2026-07-28: 处理"查看"按钮点击, 弹 SkillContentDialog
  const handleViewContent = useCallback((skill: SkillMetadata) => {
    setViewerSkill(skill);
  }, []);

  const handleRetry = useCallback(() => {
    void loadAll();
  }, [loadAll]);

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col bg-card text-foreground",
        className,
      )}
      data-testid="skills-panel"
    >
      {/* === 工具栏 === */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border/60 px-2">
        {/* TDSF 魔改: 工具栏图标改用 text-primary 语义色 */}
        <HugeiconsIcon
          icon={SparklesIcon}
          size={14}
          strokeWidth={1.75}
          className="shrink-0 text-primary"
        />
        <span className="flex-1 truncate text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
          Skill 管理
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="刷新 Skill 列表"
          title="刷新"
          onClick={handleRetry}
          disabled={loading}
        >
          <HugeiconsIcon
            icon={RefreshIcon}
            size={12}
            strokeWidth={1.75}
            className={cn(loading && "animate-spin")}
          />
        </Button>
      </div>

      {/* === 搜索框 === */}
      <div className="shrink-0 border-b border-border/40 px-2 py-1.5">
        <div className="flex items-center gap-1.5 rounded-md border border-border/60 bg-background px-2 py-1">
          <HugeiconsIcon
            icon={Search01Icon}
            size={12}
            strokeWidth={1.75}
            className="shrink-0 text-muted-foreground"
          />
          <Input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="搜索 skill（名称/描述/标签）"
            className="h-5 border-none bg-transparent p-0 text-[11px] shadow-none focus-visible:ring-0"
            data-testid="skills-search-input"
          />
        </div>
      </div>

      {/* === 分类 tabs === */}
      <div className="flex shrink-0 items-center gap-0.5 border-b border-border/40 bg-muted/20 px-1.5 py-1 overflow-x-auto">
        {FILTER_TABS.map((tab) => {
          const active = tab.id === filterTab;
          const count =
            tab.id === "all"
              ? skills.length
              : skills.filter((s) => s.category === (tab.id as SkillCategory))
                  .length;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFilterTab(tab.id)}
              className={cn(
                "shrink-0 rounded-md px-2 py-1 text-[10.5px] font-medium transition-colors",
                // TDSF 魔改: 选中 tab 使用 bg-primary/10 + text-primary 语义色
                active
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
              )}
              data-testid={`skills-tab-${tab.id}`}
            >
              {tab.label}
              <span className="ml-1 tabular-nums opacity-70">{count}</span>
            </button>
          );
        })}
      </div>

      {/* === 主体: 卡片网格 / 加载 / 错误 / 空状态 === */}
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {/* TDSF 魔改: 修复重试时不显示 LoadingState 的问题
            原条件 `loading && !loaded` 在首次加载完成（无论成功/失败）后 loaded=true，
            导致后续重试（如点击刷新按钮）时 loading=true 但 !loaded=false，
            LoadingState 不会显示，用户感受不到反馈。
            改为仅判断 loading，任何加载中都显示加载状态。 */}
        {loading ? (
          <LoadingState />
        ) : error ? (
          <ErrorState error={error} onRetry={handleRetry} />
        ) : filtered.length === 0 ? (
          <EmptyState searchQuery={searchQuery} hasSkills={skills.length > 0} />
        ) : (
          <div
            className="grid grid-cols-1 gap-2"
            style={{
              gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            }}
          >
            {filtered.map((skill) => (
              <SkillCard
                key={skill.name}
                skill={skill}
                onToggleEnabled={toggleEnabled}
                onViewContent={handleViewContent}
              />
            ))}
          </div>
        )}
      </div>

      {/* === 内容预览对话框 === */}
      {/* TDSF 魔改: 由 SkillCard 的"查看内容"按钮触发
          懒加载：仅当 viewerSkill 非 null（用户点击"查看内容"按钮）时才挂载，
          避免 streamdown 进入启动 bundle（eager-budget 约束） */}
      {viewerSkill && (
        <Suspense fallback={null}>
          <SkillContentDialog
            skill={viewerSkill}
            onOpenChange={(v) => {
              if (!v) setViewerSkill(null);
            }}
          />
        </Suspense>
      )}
    </div>
  );
}

// === 子组件: 加载状态 =======================================================

function LoadingState() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 py-8 text-center">
      {/* TDSF 魔改: 加载图标改用 text-muted-foreground 语义色 */}
      <HugeiconsIcon
        icon={Loading03Icon}
        size={24}
        strokeWidth={1.5}
        className="animate-spin text-muted-foreground"
      />
      <p className="text-[11px] text-muted-foreground">
        正在加载 Skill 列表...
      </p>
    </div>
  );
}

// === 子组件: 错误状态 =======================================================

function ErrorState({
  error,
  onRetry,
}: {
  error: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-8 text-center">
      <HugeiconsIcon
        icon={AlertCircleIcon}
        size={28}
        strokeWidth={1.5}
        className="text-destructive"
      />
      <div className="space-y-1">
        <p className="text-[12px] font-medium text-foreground">加载失败</p>
        <p className="mx-auto max-w-[240px] text-[11px] text-muted-foreground">
          {error}
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={onRetry}
        className="gap-1.5 text-[11px]"
      >
        <HugeiconsIcon icon={RefreshIcon} size={11} strokeWidth={1.75} />
        重试
      </Button>
    </div>
  );
}

// === 子组件: 空状态 =========================================================

function EmptyState({
  searchQuery,
  hasSkills,
}: {
  searchQuery: string;
  hasSkills: boolean;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      <HugeiconsIcon
        icon={SparklesIcon}
        size={28}
        strokeWidth={1.5}
        className="text-muted-foreground/40"
      />
      <div className="space-y-1">
        <p className="text-[12px] font-medium text-foreground">
          {hasSkills ? "没有匹配的 Skill" : "还没有可用的 Skill"}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {hasSkills
            ? `没有找到与 "${searchQuery}" 匹配的 skill，试试调整搜索关键词或切换分类`
            : "Python sidecar 可能未启动，请稍后重试"}
        </p>
      </div>
    </div>
  );
}
