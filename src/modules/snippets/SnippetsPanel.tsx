// TDSF 魔改 (P2 代码片段管理, 方案书 v1.1 §5): 侧边栏代码片段面板
// -----------------------------------------------------------------------------
// 布局（侧边栏内嵌）:
//   ┌─────────────────────────────────────┐
//   │ 工具栏: Code 图标 + 标题 + 新建按钮  │
//   ├─────────────────────────────────────┤
//   │ 搜索框 + 标签 tabs (全部 + 动态标签) │
//   ├─────────────────────────────────────┤
//   │ 片段列表（Frecency 排序）           │
//   │  - 空状态: 引导新建                 │
//   └─────────────────────────────────────┘
//
// 数据流:
//   - mount 时调用 store.hydrate() 加载片段（LazyStore / localStorage 降级）
//   - 搜索/标签切换本地筛选 + Frecency 排序
//   - 点击"插入"→ 有变量弹 SnippetRunDialog（变量解析 + 确认），无变量直接写入终端
//   - 点击"编辑/删除"→ 弹 SnippetEditorDialog / 删除确认 Dialog
//   - 插入成功后 recordUsage 更新 Frecency

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  CodeIcon,
  Delete02Icon,
  Edit02Icon,
  PlusSignIcon,
  Search01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  collectPlaceholders,
  sortSnippets,
  useSnippetsStore,
} from "./lib/snippetStore";
import type { Snippet } from "./types";

// 懒加载 Dialog：仅在用户交互时挂载，避免增大启动 bundle（eager-budget 约束）
const SnippetEditorDialog = lazy(() =>
  import("./SnippetEditorDialog").then((m) => ({
    default: m.SnippetEditorDialog,
  })),
);
const SnippetRunDialog = lazy(() =>
  import("./SnippetRunDialog").then((m) => ({ default: m.SnippetRunDialog })),
);

interface Props {
  className?: string;
  /** 插入命令到当前活动终端（App 层组装），返回是否成功 */
  onInsertCommand: (cmd: string) => boolean;
  /** 当前活动终端 cwd（解析 {{cwd}} 内置变量） */
  currentCwd?: string;
}

/** 新建/编辑弹窗的编辑目标 */
type EditorTarget = { mode: "create" } | { mode: "edit"; snippet: Snippet };

export function SnippetsPanel({ className, onInsertCommand, currentCwd }: Props) {
  const snippets = useSnippetsStore((s) => s.snippets);
  const hydrated = useSnippetsStore((s) => s.hydrated);
  const hydrate = useSnippetsStore((s) => s.hydrate);
  const removeSnippet = useSnippetsStore((s) => s.removeSnippet);

  const [searchQuery, setSearchQuery] = useState("");
  const [filterTag, setFilterTag] = useState<string | null>(null);
  const [editorTarget, setEditorTarget] = useState<EditorTarget | null>(null);
  const [runSnippet, setRunSnippet] = useState<Snippet | null>(null);
  const [deleting, setDeleting] = useState<Snippet | null>(null);

  // mount 时加载片段（仅首次）
  useEffect(() => {
    if (!hydrated) void hydrate();
  }, [hydrated, hydrate]);

  // 动态标签（去重 + 排序），用于过滤 tabs
  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const s of snippets) for (const t of s.tags) set.add(t);
    return [...set].sort((a, b) => a.localeCompare(b, "zh"));
  }, [snippets]);

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return sortSnippets(snippets).filter((s) => {
      if (filterTag && !s.tags.includes(filterTag)) return false;
      if (!q) return true;
      return (
        s.name.toLowerCase().includes(q) ||
        s.command.toLowerCase().includes(q) ||
        (s.description ?? "").toLowerCase().includes(q) ||
        s.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [snippets, searchQuery, filterTag]);

  const handleInsert = useCallback(
    (snippet: Snippet) => {
      const placeholders = collectPlaceholders(snippet.command);
      // 有变量（含内置 cwd）→ 弹确认 Dialog；无变量 → 直接写入终端
      if (placeholders.length > 0) {
        setRunSnippet(snippet);
        return;
      }
      const ok = onInsertCommand(snippet.command);
      if (ok) {
        useSnippetsStore.getState().recordUsage(snippet.id);
      } else {
        toast.error("没有活动的终端，无法插入片段");
      }
    },
    [onInsertCommand],
  );

  const handleEditorSave = useCallback(
    (data: {
      name: string;
      command: string;
      description?: string;
      tags: string[];
    }) => {
      if (!editorTarget) return;
      // variables 从 command 自动派生：保留已存在变量的 defaultValue
      const placeholders = collectPlaceholders(data.command);
      const existing =
        editorTarget.mode === "edit" ? editorTarget.snippet.variables : [];
      const variables = placeholders.map((name) => ({
        name,
        defaultValue: existing.find((v) => v.name === name)?.defaultValue,
      }));
      if (editorTarget.mode === "create") {
        useSnippetsStore.getState().addSnippet({ ...data, variables });
      } else {
        useSnippetsStore
          .getState()
          .updateSnippet(editorTarget.snippet.id, { ...data, variables });
      }
    },
    [editorTarget],
  );

  const handleConfirmDelete = useCallback(() => {
    if (!deleting) return;
    removeSnippet(deleting.id);
    setDeleting(null);
  }, [deleting, removeSnippet]);

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col bg-card text-foreground",
        className,
      )}
      data-testid="snippets-panel"
    >
      {/* === 工具栏 === */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border/60 px-2">
        <HugeiconsIcon
          icon={CodeIcon}
          size={14}
          strokeWidth={1.75}
          className="shrink-0 text-primary"
        />
        <span className="flex-1 truncate text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
          Snippets
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="新建代码片段"
          title="新建片段"
          onClick={() => setEditorTarget({ mode: "create" })}
        >
          <HugeiconsIcon icon={PlusSignIcon} size={13} strokeWidth={1.75} />
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
            placeholder="搜索片段（名称/命令/标签）"
            className="h-5 border-none bg-transparent p-0 text-[11px] shadow-none focus-visible:ring-0"
            data-testid="snippets-search-input"
          />
        </div>
      </div>

      {/* === 标签 tabs === */}
      {allTags.length > 0 && (
        <div className="flex shrink-0 items-center gap-0.5 overflow-x-auto border-b border-border/40 bg-muted/20 px-1.5 py-1">
          <button
            type="button"
            onClick={() => setFilterTag(null)}
            className={cn(
              "shrink-0 rounded-md px-2 py-1 text-[10.5px] font-medium transition-colors",
              filterTag === null
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
            )}
            data-testid="snippets-tab-all"
          >
            全部
            <span className="ml-1 tabular-nums opacity-70">{snippets.length}</span>
          </button>
          {allTags.map((tag) => {
            const active = tag === filterTag;
            const count = snippets.filter((s) => s.tags.includes(tag)).length;
            return (
              <button
                key={tag}
                type="button"
                onClick={() => setFilterTag(active ? null : tag)}
                className={cn(
                  "shrink-0 rounded-md px-2 py-1 text-[10.5px] font-medium transition-colors",
                  active
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                )}
                data-testid={`snippets-tab-${tag}`}
              >
                {tag}
                <span className="ml-1 tabular-nums opacity-70">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* === 主体: 片段列表 / 空状态 === */}
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {filtered.length === 0 ? (
          <EmptyState
            searchQuery={searchQuery}
            hasSnippets={snippets.length > 0}
            onCreate={() => setEditorTarget({ mode: "create" })}
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            {filtered.map((snippet) => (
              <SnippetRow
                key={snippet.id}
                snippet={snippet}
                onInsert={() => handleInsert(snippet)}
                onEdit={() => setEditorTarget({ mode: "edit", snippet })}
                onDelete={() => setDeleting(snippet)}
              />
            ))}
          </div>
        )}
      </div>

      {/* === 新建/编辑对话框 === */}
      {editorTarget && (
        <Suspense fallback={null}>
          <SnippetEditorDialog
            mode={editorTarget.mode}
            snippet={editorTarget.mode === "edit" ? editorTarget.snippet : undefined}
            onOpenChange={(v) => {
              if (!v) setEditorTarget(null);
            }}
            onSave={handleEditorSave}
          />
        </Suspense>
      )}

      {/* === 插入确认对话框（变量解析） === */}
      {runSnippet && (
        <Suspense fallback={null}>
          <SnippetRunDialog
            snippet={runSnippet}
            currentCwd={currentCwd}
            onInsertCommand={onInsertCommand}
            onOpenChange={(v) => {
              if (!v) setRunSnippet(null);
            }}
          />
        </Suspense>
      )}

      {/* === 删除确认对话框 === */}
      <DeleteConfirmDialog
        snippet={deleting}
        onOpenChange={(v) => {
          if (!v) setDeleting(null);
        }}
        onConfirm={handleConfirmDelete}
      />
    </div>
  );
}

// === 子组件: 片段行 =========================================================

function SnippetRow({
  snippet,
  onInsert,
  onEdit,
  onDelete,
}: {
  snippet: Snippet;
  onInsert: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <div
      className="group relative cursor-pointer rounded-md border border-border/50 bg-background/60 px-2.5 py-2 transition-colors hover:border-border hover:bg-muted/40"
      onClick={onInsert}
      data-testid={`snippet-row-${snippet.name}`}
    >
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
          {snippet.name}
        </span>
        {snippet.usageCount > 0 && (
          <span className="shrink-0 rounded-full border border-border/60 bg-card px-1.5 py-px text-[9.5px] tabular-nums text-muted-foreground">
            ×{snippet.usageCount}
          </span>
        )}
        {/* hover 操作按钮 */}
        <div className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
          <RowAction
            label="插入"
            title="插入到终端"
            onClick={(e) => {
              e.stopPropagation();
              onInsert();
            }}
          >
            <HugeiconsIcon
              icon={CodeIcon}
              size={12}
              strokeWidth={1.75}
              className="text-primary"
            />
          </RowAction>
          <RowAction
            label="编辑"
            title="编辑片段"
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
          >
            <HugeiconsIcon icon={Edit02Icon} size={12} strokeWidth={1.75} />
          </RowAction>
          <RowAction
            label="删除"
            title="删除片段"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            <HugeiconsIcon
              icon={Delete02Icon}
              size={12}
              strokeWidth={1.75}
              className="text-destructive/80"
            />
          </RowAction>
        </div>
      </div>
      {snippet.command && (
        <p className="mt-1 truncate font-mono text-[10.5px] leading-relaxed text-muted-foreground/80">
          {snippet.command}
        </p>
      )}
      {snippet.tags.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {snippet.tags.map((tag) => (
            <span
              key={tag}
              className="rounded border border-border/50 bg-muted/50 px-1 py-px text-[9.5px] text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/** 行内小操作按钮 */
function RowAction({
  label,
  title,
  onClick,
  children,
}: {
  label: string;
  title: string;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={label}
      onClick={onClick}
      className="flex h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
    >
      {children}
    </button>
  );
}

// === 子组件: 空状态 =========================================================

function EmptyState({
  searchQuery,
  hasSnippets,
  onCreate,
}: {
  searchQuery: string;
  hasSnippets: boolean;
  onCreate: () => void;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      <HugeiconsIcon
        icon={CodeIcon}
        size={28}
        strokeWidth={1.5}
        className="text-muted-foreground/40"
      />
      <div className="space-y-1">
        <p className="text-[12px] font-medium text-foreground">
          {hasSnippets ? "没有匹配的片段" : "还没有代码片段"}
        </p>
        <p className="text-[11px] text-muted-foreground">
          {hasSnippets
            ? `没有找到与 "${searchQuery}" 匹配的片段，试试调整关键词或标签`
            : "收藏常用 Linux 命令，一键插入终端"}
        </p>
      </div>
      {!hasSnippets && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={onCreate}
          className="gap-1.5 text-[11px]"
        >
          <HugeiconsIcon icon={PlusSignIcon} size={11} strokeWidth={1.75} />
          新建片段
        </Button>
      )}
    </div>
  );
}

// === 子组件: 删除确认 =======================================================

function DeleteConfirmDialog({
  snippet,
  onOpenChange,
  onConfirm,
}: {
  snippet: Snippet | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Dialog open={snippet !== null} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>删除片段</DialogTitle>
          <DialogDescription>
            确定删除片段「{snippet?.name}」吗？该操作不可撤销。
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
          >
            取消
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={onConfirm}
          >
            删除
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
