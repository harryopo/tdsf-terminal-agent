// TDSF 魔改 (P4-T4.1): SSH 远程文件树
// -----------------------------------------------------------------------------
// 树形可展开/折叠文件浏览器 (与本地 FileExplorer 行为一致):
//   - 顶部面包屑显示当前路径 (/ > home > user), 点击片段跳转
//   - 主体递归渲染当前 cwd + 已展开子树, 目录点击展开/折叠, 文件点击打开
//   - lazy 加载: 第一次展开某目录才请求后端 sftp_list, 已展开过的复用缓存
//   - 选中高亮 (selectedPath)
//   - 加载中骨架 (loading)
//   - 空目录提示
//
// 关键设计:
//   - 节点来源: childrenByPathBySession[sessionId][path] (SshStore 维护)
//     - "/" 默认在 connect 成功后由 listDir("/") 填充, 作为树根
//   - 展开控制: expandedPathsBySession[sessionId] (Set<string>)
//   - 渲染: 当前 cwd 列表为根, 每个目录项按需递归展开
//   - 行高 24px (h-6), 缩进 14px/级 (与本地 FileExplorer 对齐)

import type { SftpEntry } from "@/lib/sftp-bridge";
import { cn } from "@/lib/utils";
import {
  ArrowRight01Icon,
  CloudServerIcon,
  File02Icon,
  Folder01Icon,
  FolderOpenIcon,
  Loading03Icon,
  RefreshIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useMemo } from "react";
import { useSshStore } from "./sshStore";

type Props = {
  sessionId: string;
};

/** 稳定的空数组, 避免 zustand selector 每次返回新引用触发无限重渲染 */
const EMPTY_ENTRIES: SftpEntry[] = [];
const EMPTY_EXPANDED = new Set<string>();
const EMPTY_LOADING_MAP: Record<string, boolean> = {};

/** 拆分远程路径为面包屑片段 (POSIX 风格) */
function splitPath(path: string): Array<{ name: string; path: string }> {
  if (!path || path === "/") {
    return [{ name: "/", path: "/" }];
  }
  const segments = path.split("/").filter(Boolean);
  const crumbs: Array<{ name: string; path: string }> = [
    { name: "/", path: "/" },
  ];
  let acc = "";
  for (const seg of segments) {
    acc = `${acc}/${seg}`;
    crumbs.push({ name: seg, path: acc });
  }
  return crumbs;
}

/** 格式化文件大小 (B/KB/MB) */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}M`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)}G`;
}

export function SshFileTree({ sessionId }: Props) {
  const currentPath = useSshStore(
    (s) => s.currentPathBySession[sessionId] ?? "/",
  );
  const entries = useSshStore(
    (s) => s.entriesBySession[sessionId] ?? EMPTY_ENTRIES,
  );
  const loading = useSshStore((s) => s.loadingBySession[sessionId] ?? false);
  const navigateTo = useSshStore((s) => s.navigateTo);
  const refreshCurrent = useSshStore((s) => s.refreshCurrent);

  const crumbs = useMemo(() => splitPath(currentPath), [currentPath]);

  const handleRefresh = useCallback(() => {
    void refreshCurrent(sessionId);
  }, [refreshCurrent, sessionId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* === 面包屑导航 === */}
      <div className="flex items-center gap-1 border-b border-border/40 px-2 py-1.5 text-[12px]">
        <HugeiconsIcon
          icon={CloudServerIcon}
          size={12}
          strokeWidth={1.75}
          className="shrink-0 text-muted-foreground"
        />
        <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
          {crumbs.map((c, i) => (
            <div key={c.path} className="flex shrink-0 items-center">
              {i > 0 && (
                <HugeiconsIcon
                  icon={ArrowRight01Icon}
                  size={10}
                  strokeWidth={1.75}
                  className="mx-0.5 text-muted-foreground/60"
                />
              )}
              <button
                type="button"
                onClick={() => void navigateTo(sessionId, c.path)}
                className={cn(
                  "max-w-[120px] truncate rounded px-1 py-0.5 transition-colors hover:bg-accent/70",
                  i === crumbs.length - 1
                    ? "font-medium text-foreground"
                    : "text-muted-foreground",
                )}
                title={c.path}
              >
                {c.name}
              </button>
            </div>
          ))}
        </div>
        <button
          type="button"
          onClick={handleRefresh}
          aria-label="刷新"
          title="刷新当前目录"
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-accent/70 hover:text-foreground"
        >
          <HugeiconsIcon
            icon={RefreshIcon}
            size={12}
            strokeWidth={1.75}
            className={loading ? "animate-spin" : ""}
          />
        </button>
      </div>

      {/* === 文件树 (递归可展开) ===
          TDSF 魔改 2026-07-29: 改单层列表为树形递归, 跟本地 FileExplorer
          行为一致。根节点 = currentPath 下的直接条目; 每个目录项按需
          递归展开 (调用 useSshStore.toggleExpand + lazy loadChildren). */}
      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {loading && entries.length === 0 ? (
          <div className="flex items-center gap-2 px-3 py-2 text-[13px] text-muted-foreground">
            <HugeiconsIcon
              icon={Loading03Icon}
              size={14}
              strokeWidth={1.75}
              className="animate-spin"
            />
            <span>加载中…</span>
          </div>
        ) : entries.length === 0 ? (
          <div className="px-3 py-6 text-center text-[12px] text-muted-foreground">
            空目录
          </div>
        ) : (
          <SshTreeLevel sessionId={sessionId} path={currentPath} depth={0} />
        )}
      </div>
    </div>
  );
}

// === 子组件: 单层树节点 + 递归 ==============================================
// TDSF 魔改 2026-07-29: 把单层列表与"目录展开"两个职责拆到独立组件, 避免
// SshFileTree 主体过于臃肿。每个 SshTreeLevel 渲染一个目录的子条目列表,
// 如果某条目是目录且已展开, 在它下面再渲染一个 SshTreeLevel (depth+1).

function SshTreeLevel({
  sessionId,
  path,
  depth,
}: {
  sessionId: string;
  path: string;
  depth: number;
}) {
  const entries = useSshStore(
    (s) => s.childrenByPathBySession[sessionId]?.[path] ?? EMPTY_ENTRIES,
  );
  const expanded = useSshStore(
    (s) => s.expandedPathsBySession[sessionId] ?? EMPTY_EXPANDED,
  );
  const loadingMap = useSshStore(
    (s) => s.loadingChildrenByPathBySession[sessionId] ?? EMPTY_LOADING_MAP,
  );
  const selectedPath = useSshStore((s) => s.selectedPath);
  const navigateTo = useSshStore((s) => s.navigateTo);
  const selectPath = useSshStore((s) => s.selectPath);
  const openFile = useSshStore((s) => s.openFile);
  const toggleExpand = useSshStore((s) => s.toggleExpand);

  const isLoading = !!loadingMap[path];

  const handleClickEntry = useCallback(
    (entry: SftpEntry) => {
      selectPath(entry.path);
      if (entry.isDir) {
        // 树形行为: 目录点击展开/折叠 (跟本地 FileExplorer 一致)
        toggleExpand(sessionId, entry.path);
      }
    },
    [selectPath, toggleExpand, sessionId],
  );

  const handleDoubleClickEntry = useCallback(
    (entry: SftpEntry) => {
      if (entry.isFile) {
        void openFile(sessionId, entry.path, entry.name);
      } else {
        // 双击目录: 跳到该目录 (跟终端 cd 一致, 同时展开整棵子树)
        void navigateTo(sessionId, entry.path);
      }
    },
    [openFile, navigateTo, sessionId],
  );

  // 目录缩进: 12px / 级, 第一级额外 6px 起始内边距
  const paddingLeft = 6 + depth * 12;

  return (
    <div>
      {isLoading && entries.length === 0 ? (
        <div
          className="flex h-6 items-center gap-2 text-[12px] text-muted-foreground"
          style={{ paddingLeft: paddingLeft + 18 }}
        >
          <HugeiconsIcon
            icon={Loading03Icon}
            size={12}
            strokeWidth={1.75}
            className="animate-spin"
          />
          <span>加载中…</span>
        </div>
      ) : null}
      {entries.map((entry) => {
        const isSelected = selectedPath === entry.path;
        const isExpanded = expanded.has(entry.path);
        return (
          <div key={entry.path}>
            <button
              type="button"
              onClick={() => handleClickEntry(entry)}
              onDoubleClick={() => handleDoubleClickEntry(entry)}
              title={
                entry.isDir
                  ? entry.name
                  : `${entry.name} (${formatSize(entry.size)})`
              }
              className={cn(
                "group flex h-6 w-full min-w-0 items-center gap-1.5 text-left text-[13px] transition-colors hover:bg-accent/70",
                isSelected
                  ? "bg-primary/15 text-foreground"
                  : "text-foreground/85",
              )}
              style={{ paddingLeft: paddingLeft + 4 }}
            >
              {/* 展开/折叠箭头: 仅目录显示, 文件留空对齐 */}
              <span className="flex size-3.5 shrink-0 items-center justify-center text-muted-foreground">
                {entry.isDir ? (
                  <HugeiconsIcon
                    icon={ArrowRight01Icon}
                    size={11}
                    strokeWidth={2.25}
                    className={cn(
                      "transition-transform",
                      isExpanded && "rotate-90",
                    )}
                  />
                ) : null}
              </span>
              <HugeiconsIcon
                icon={
                  entry.isDir
                    ? isExpanded
                      ? FolderOpenIcon
                      : Folder01Icon
                    : File02Icon
                }
                size={14}
                strokeWidth={1.75}
                className={cn(
                  "shrink-0",
                  entry.isDir ? "text-primary" : "text-muted-foreground",
                )}
              />
              <span className="min-w-0 flex-1 truncate">{entry.name}</span>
              {!entry.isDir && (
                <span className="shrink-0 pr-1.5 text-[11px] tabular-nums text-muted-foreground/70">
                  {formatSize(entry.size)}
                </span>
              )}
              {entry.permissions && (
                <span className="hidden shrink-0 pr-1.5 font-mono text-[10px] text-muted-foreground/60 group-hover:inline">
                  {entry.permissions}
                </span>
              )}
            </button>
            {/* 递归: 目录已展开时渲染下一层 */}
            {entry.isDir && isExpanded ? (
              <SshTreeLevel
                sessionId={sessionId}
                path={entry.path}
                depth={depth + 1}
              />
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
