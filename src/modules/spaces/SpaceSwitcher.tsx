import { Kbd } from "@/components/ui/kbd";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useShortcutLabel } from "@/modules/shortcuts";
import {
  isSessionConnected,
  useSshStore,
} from "@/modules/ssh-explorer/sshStore";
import { labelFor, type Tab, TabIcon } from "@/modules/tabs";
import { effectiveLeafSsh, findLeafCwd } from "@/modules/terminal/lib/panes";
import {
  ArrowDown01Icon,
  ArrowRight01Icon,
  Cancel01Icon,
  Delete02Icon,
  PencilEdit02Icon,
  PlusSignIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { InlineRename } from "./components/InlineRename";
import { accentFor } from "./lib/spaceColor";
import type { SpaceMeta } from "./lib/store";
import { useSpaces } from "./lib/useSpaces";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tabs: Tab[];
  onNewSpace: () => void;
  onDeleteSpace: (id: string) => void;
  onNewTabInSpace: (spaceId: string) => void;
  onJumpTab: (id: number) => void;
  onCloseTab: (id: number) => void;
  onMoveTabToSpace: (tabId: number, spaceId: string) => void;
  onReorderTab: (
    tabId: number,
    targetTabId: number,
    edge: "top" | "bottom",
  ) => void;
  onReorderSpaces: (orderedIds: string[]) => void;
};

type Edge = "top" | "bottom";

/**
 * 行内小字副标：说「这个工作区现在落在哪儿、还需不需要我动手」，不重复工作区名。
 *
 * TDSF 2026-09-20（用户实测）：原来这里放的是"环境徽章"，SSH 工作区渲染成
 * `user@host`——跟工作区名一模一样，等于把名字抄了两遍。改成状态/落点：
 * SSH 看有没有活着的会话（决定要不要重连），其余看落点。落点与工作区名重合时
 * 只留类型词，否则又变成"名字抄两遍"（本地工作区常以目录名命名）。
 */
function spaceSubtitle(space: SpaceMeta, connected: boolean): string {
  const { env, name, root } = space;
  if (env.kind === "ssh")
    return connected ? "SSH · 已连接" : "SSH · 未连接";
  const kind = env.kind === "wsl" ? "WSL" : "本地";
  const detail =
    env.kind === "wsl"
      ? env.distro
      : (root?.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? null);
  if (!detail || name.includes(detail)) return kind;
  return `${kind} · ${detail}`;
}

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  kind: "space" | "tab";
  id: string | number;
  active: boolean;
};

type DropTarget =
  | { kind: "space"; spaceId: string; edge: Edge }
  | { kind: "tab"; tabId: number; edge: Edge }
  | { kind: "into-space"; spaceId: string };

/**
 * 标签页这一行的**实时**落点。
 *
 * 不能读 `tab.cwd` —— 那是建 tab 那一刻的快照，之后没人再写它，所以用户在 shell 里
 * `cd` 到 `/usr/bin`，下拉里还写着 `/`（2026-09-21 用户实测）。口径与状态栏、
 * 资源管理器保持一致：
 * - SSH：跟着**这个 tab 自己那条会话**的 OSC7 路径（#89 之后每条 tab 一条会话）；
 * - 本地：跟着可见 leaf 的 cwd（OSC7 由 `setLeafCwd` 写进 paneTree）。
 * 拿不到就返回 null（宁可少写一行，也不写一个会撒谎的路径）。
 */
function liveCwdOf(
  tab: Tab,
  sshPaths: Record<string, string>,
): string | null {
  if (tab.kind !== "terminal") return null;
  const ssh = effectiveLeafSsh(
    tab.paneTree,
    tab.activeLeafId,
    tab.sshSessionId,
  );
  if (ssh) return sshPaths[ssh] ?? null;
  return findLeafCwd(tab.paneTree, tab.activeLeafId) ?? tab.cwd ?? null;
}

function subtitleFor(tab: Tab, cwd: string | null): string | null {
  if (tab.kind === "terminal") {
    if (!cwd) return null;
    const segs = cwd.split(/[\\/]/).filter(Boolean);
    return segs.slice(-2).join("/") || cwd;
  }
  if (tab.kind === "editor" || tab.kind === "markdown") {
    const segs = tab.path.split(/[\\/]/).filter(Boolean);
    return segs.slice(-2, -1)[0] ?? null;
  }
  return null;
}

export function SpaceSwitcher({
  open,
  onOpenChange,
  tabs,
  onNewSpace,
  onDeleteSpace,
  onNewTabInSpace,
  onJumpTab,
  onCloseTab,
  onMoveTabToSpace,
  onReorderTab,
  onReorderSpaces,
}: Props) {
  const spaces = useSpaces((s) => s.spaces);
  const activeId = useSpaces((s) => s.activeId);
  const setActive = useSpaces((s) => s.setActive);
  const rename = useSpaces((s) => s.rename);
  const sshSessions = useSshStore((s) => s.sessions);
  const sshPaths = useSshStore((s) => s.currentPathBySession);
  const shortcut = useShortcutLabel("space.overview");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(() =>
    activeId ? new Set([activeId]) : new Set(),
  );

  const drag = useRef<DragState | null>(null);
  const dropRef = useRef<DropTarget | null>(null);
  const [dragging, setDragging] = useState<{
    kind: "space" | "tab";
    id: string | number;
  } | null>(null);
  const [drop, setDrop] = useState<DropTarget | null>(null);
  const [overlay, setOverlay] = useState<{ x: number; y: number } | null>(null);

  const current = spaces.find((s) => s.id === activeId);

  // 小字副标要区分"这个 Space 的 SSH 会话还活着吗"——只有真正 connected 且
  // 拿到 Rust 句柄才算（判据复用 sshStore.isSessionConnected，不另立一套）。
  const liveSshIds = useMemo(
    () => new Set(sshSessions.filter(isSessionConnected).map((s) => s.id)),
    [sshSessions],
  );

  const tabsBySpace = useMemo(() => {
    const m = new Map<string, Tab[]>();
    for (const t of tabs) {
      const arr = m.get(t.spaceId);
      if (arr) arr.push(t);
      else m.set(t.spaceId, [t]);
    }
    return m;
  }, [tabs]);

  const draggedTab =
    dragging?.kind === "tab"
      ? (tabs.find((t) => t.id === dragging.id) ?? null)
      : null;
  const draggedSpace =
    dragging?.kind === "space"
      ? (spaces.find((s) => s.id === dragging.id) ?? null)
      : null;

  useEffect(() => {
    if (!open || !activeId) return;
    setExpanded((prev) =>
      prev.has(activeId) ? prev : new Set(prev).add(activeId),
    );
  }, [open, activeId]);

  const toggleExpand = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const endDrag = (el: Element) => {
    const st = drag.current;
    if (st) el.releasePointerCapture?.(st.pointerId);
    drag.current = null;
    dropRef.current = null;
    setDragging(null);
    setDrop(null);
    setOverlay(null);
    document.body.style.userSelect = "";
  };

  const onPointerDown = (
    e: React.PointerEvent,
    kind: "space" | "tab",
    id: string | number,
  ) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("[data-no-drag]")) return;
    drag.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      kind,
      id,
      active: false,
    };
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const st = drag.current;
    if (!st || st.pointerId !== e.pointerId) return;
    if (!st.active) {
      if (Math.hypot(e.clientX - st.startX, e.clientY - st.startY) < 5) return;
      st.active = true;
      setDragging({ kind: st.kind, id: st.id });
      document.body.style.userSelect = "none";
    }
    e.preventDefault();
    setOverlay({ x: e.clientX, y: e.clientY });

    const hit = document
      .elementFromPoint(e.clientX, e.clientY)
      ?.closest("[data-drop]");
    if (!hit) {
      dropRef.current = null;
      setDrop(null);
      return;
    }
    const rect = hit.getBoundingClientRect();
    const edge: Edge =
      e.clientY < rect.top + rect.height / 2 ? "top" : "bottom";
    const kind = hit.getAttribute("data-drop");
    let next: DropTarget | null = null;
    if (st.kind === "space") {
      if (kind === "space") {
        const spaceId = hit.getAttribute("data-space-id");
        if (spaceId && spaceId !== st.id)
          next = { kind: "space", spaceId, edge };
      }
    } else if (kind === "tab") {
      const tabId = Number(hit.getAttribute("data-tab-id"));
      if (tabId !== st.id) next = { kind: "tab", tabId, edge };
    } else if (kind === "space") {
      const spaceId = hit.getAttribute("data-space-id");
      if (spaceId) next = { kind: "into-space", spaceId };
    }
    dropRef.current = next;
    setDrop(next);
  };

  const commit = () => {
    const st = drag.current;
    const dt = dropRef.current;
    if (!st?.active || !dt) return;
    if (st.kind === "space" && dt.kind === "space") {
      const without = spaces.map((s) => s.id).filter((id) => id !== st.id);
      let idx = without.indexOf(dt.spaceId);
      if (idx < 0) return;
      if (dt.edge === "bottom") idx += 1;
      without.splice(idx, 0, st.id as string);
      onReorderSpaces(without);
    } else if (st.kind === "tab") {
      if (dt.kind === "tab") onReorderTab(st.id as number, dt.tabId, dt.edge);
      else if (dt.kind === "into-space")
        onMoveTabToSpace(st.id as number, dt.spaceId);
    }
  };

  const onPointerUp = (e: React.PointerEvent, onActivate?: () => void) => {
    const st = drag.current;
    if (st?.active) commit();
    else if (st) onActivate?.();
    endDrag(e.currentTarget);
  };

  // TDSF 修复 2026-09-18 (ROADMAP #61 方案 A)：启动后不再自动进入工作区
  // （activeId 恒为 null），所以「没有 current」不再是「没有工作区」。
  // 注册表里还有历史工作区时必须照旧渲染触发器，否则留存下来的清单在 UI 上
  // 一个入口都没有——用户只能重复「新建」，#61-A 就白做了。
  if (!current && spaces.length === 0) return null;

  // TDSF 2026-09-01（用户钦定工作区-窗口重构）: 顶栏收敛为"单触发器 + 单窗口栏"。
  // 旧版每 Space 一个 chip（带字母头像）+ 独立新建加号，与 TabBar 的窗口加号
  // 并存——用户反馈"两个加号 / R 头像多余 / 工作区与窗口混一行分不清"。
  // 现在：触发器只显示当前工作区名（无头像），点击弹总览面板（切换/重命名/
  // 删除/管理窗口都在面板里）；TabBar 只展示当前工作区的窗口 + 唯一加号，
  // 即"窗口栏只展示一个工作区打开的窗口"。
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <div className="flex min-w-0 items-center" data-testid="space-tabs-row">
        <PopoverTrigger asChild>
          <button
            type="button"
            title={
              shortcut
                ? `工作区总览（切换/重命名/删除工作区） · ${shortcut}`
                : "工作区总览（切换/重命名/删除工作区）"
            }
            aria-label="工作区总览"
            data-testid="space-trigger"
            className="flex h-7 max-w-44 min-w-0 shrink-0 items-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground data-[state=open]:bg-accent data-[state=open]:text-foreground"
          >
            <span className="truncate">{current?.name ?? "选择工作区"}</span>
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              size={13}
              strokeWidth={2}
              className="shrink-0 opacity-80"
            />
          </button>
        </PopoverTrigger>
      </div>
      <PopoverContent align="start" sideOffset={6} className="w-[20rem] p-1.5">
        <div className="flex items-center justify-between px-1.5 pb-1.5 pt-0.5">
          <span className="text-xs font-semibold text-foreground">Spaces</span>
          {shortcut && (
            <Kbd className="h-5 bg-muted/70 text-[10px]">{shortcut}</Kbd>
          )}
        </div>
        <div className="-mx-0.5 max-h-[60vh] overflow-y-auto px-0.5">
          {spaces.map((sp) => (
            <SpaceRow
              key={sp.id}
              space={sp}
              tabs={tabsBySpace.get(sp.id) ?? []}
              isActive={sp.id === activeId}
              // TDSF 修复 2026-08-01: 允许全部删除（全删后进入欢迎界面）
              canDelete={spaces.length >= 1}
              expanded={expanded.has(sp.id)}
              editing={editingId === sp.id}
              subtitle={spaceSubtitle(
                sp,
                sp.env.kind === "ssh" && sp.env.sessionId
                  ? liveSshIds.has(sp.env.sessionId)
                  : false,
              )}
              tabCwd={(t) => liveCwdOf(t, sshPaths)}
              dragging={dragging}
              drop={drop}
              draggingTabFromOther={
                draggedTab !== null && draggedTab.spaceId !== sp.id
              }
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onToggle={() => toggleExpand(sp.id)}
              onSwitch={() => {
                setActive(sp.id);
                onOpenChange(false);
              }}
              onStartRename={() => setEditingId(sp.id)}
              onCommitRename={(name) => {
                const v = name.trim();
                if (v) rename(sp.id, v);
                setEditingId(null);
              }}
              onCancelRename={() => setEditingId(null)}
              onDelete={() => onDeleteSpace(sp.id)}
              onNewTab={() => onNewTabInSpace(sp.id)}
              onJumpTab={onJumpTab}
              onCloseTab={onCloseTab}
            />
          ))}
        </div>
        <div className="mt-1.5 border-t border-border/60 pt-1.5">
          <button
            type="button"
            onClick={onNewSpace}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
          >
            <HugeiconsIcon icon={PlusSignIcon} size={14} strokeWidth={1.75} />
            <span className="flex-1">New space</span>
          </button>
        </div>
      </PopoverContent>
      {overlay &&
        (draggedSpace || draggedTab) &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[60]"
            style={{ left: overlay.x + 12, top: overlay.y + 8 }}
          >
            {draggedSpace ? (
              <OverlayChip
                color={accentFor(draggedSpace)}
                label={draggedSpace.name}
              />
            ) : draggedTab ? (
              <OverlayChip tab={draggedTab} label={labelFor(draggedTab)} />
            ) : null}
          </div>,
          document.body,
        )}
    </Popover>
  );
}

type SpaceRowProps = {
  space: SpaceMeta;
  tabs: Tab[];
  isActive: boolean;
  canDelete: boolean;
  expanded: boolean;
  editing: boolean;
  /** 名字后的小字：状态/落点，不重复工作区名（见 spaceSubtitle） */
  subtitle: string;
  /** 标签页那一行的实时落点（见 liveCwdOf），不读 tab.cwd 那个建 tab 时的快照 */
  tabCwd: (tab: Tab) => string | null;
  dragging: { kind: "space" | "tab"; id: string | number } | null;
  drop: DropTarget | null;
  draggingTabFromOther: boolean;
  onPointerDown: (
    e: React.PointerEvent,
    kind: "space" | "tab",
    id: string | number,
  ) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent, onActivate?: () => void) => void;
  onToggle: () => void;
  onSwitch: () => void;
  onStartRename: () => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
  onDelete: () => void;
  onNewTab: () => void;
  onJumpTab: (id: number) => void;
  onCloseTab: (id: number) => void;
};

function SpaceRow({
  space,
  tabs,
  isActive,
  canDelete,
  expanded,
  editing,
  subtitle,
  tabCwd,
  dragging,
  drop,
  draggingTabFromOther,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onToggle,
  onSwitch,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onDelete,
  onNewTab,
  onJumpTab,
  onCloseTab,
}: SpaceRowProps) {
  const isDragging = dragging?.kind === "space" && dragging.id === space.id;
  const moveTarget = drop?.kind === "into-space" && drop.spaceId === space.id;
  const reorderEdge =
    drop?.kind === "space" && drop.spaceId === space.id ? drop.edge : null;

  return (
    <div className={cn("relative", isDragging && "opacity-50")}>
      {reorderEdge && <DropLine edge={reorderEdge} />}
      {/* biome-ignore lint/a11y/useSemanticElements: drag row hosts nested buttons, cannot be a <button> */}
      <div
        data-drop="space"
        data-space-id={space.id}
        role="button"
        tabIndex={editing ? -1 : 0}
        onPointerDown={
          editing ? undefined : (e) => onPointerDown(e, "space", space.id)
        }
        onPointerMove={onPointerMove}
        onPointerUp={editing ? undefined : (e) => onPointerUp(e, onSwitch)}
        onPointerCancel={(e) => onPointerUp(e)}
        onKeyDown={(e) => {
          if (editing) return;
          if (e.key === "Enter") {
            e.preventDefault();
            onSwitch();
          }
        }}
        className={cn(
          "group relative flex cursor-pointer select-none items-center gap-1.5 rounded-md px-1.5 py-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-primary/40",
          moveTarget
            ? "bg-primary/10 ring-1 ring-inset ring-primary/40"
            : isActive
              ? "bg-accent"
              : "hover:bg-accent/50",
        )}
      >
        <button
          type="button"
          data-no-drag
          aria-label={expanded ? "Collapse" : "Expand"}
          onClick={(e) => {
            e.stopPropagation();
            onToggle();
          }}
          className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground/60 hover:text-foreground"
        >
          <HugeiconsIcon
            icon={expanded ? ArrowDown01Icon : ArrowRight01Icon}
            size={13}
            strokeWidth={2}
          />
        </button>
        {/* 用户钦定 2026-09-01: 工作区不再放字母头像（R 图标）——环境凭徽章区分 */}
        {editing ? (
          <InlineRename
            initial={space.name}
            onCommit={onCommitRename}
            onCancel={onCancelRename}
            className="ml-0.5"
          />
        ) : (
          <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
            {space.name}
            {/* 小字=状态/落点，不再重复工作区名（2026-09-20 用户实测：SSH 工作区
                曾把 `user@host` 抄两遍）；命名撞车时仍靠它区分本地/WSL/服务器 */}
            <span className="ml-1.5 text-[10px] font-normal text-muted-foreground/60">
              {subtitle}
            </span>
          </span>
        )}
        {!editing && (
          <>
            <span className="shrink-0 px-1 text-[10px] tabular-nums text-muted-foreground/50">
              {tabs.length}
            </span>
            <div
              data-no-drag
              className="flex shrink-0 items-center gap-0.5"
            >
              <RowAction
                icon={PencilEdit02Icon}
                label="Rename space"
                onClick={onStartRename}
              />
              <RowAction
                icon={PlusSignIcon}
                label="New tab"
                onClick={onNewTab}
              />
              {canDelete && (
                <RowAction
                  icon={Delete02Icon}
                  label="Delete space"
                  destructive
                  onClick={onDelete}
                />
              )}
            </div>
          </>
        )}
      </div>

      {expanded && (
        <div className="flex flex-col gap-px py-0.5 pl-10 pr-0.5">
          {tabs.map((t) => (
            <TabRow
              key={t.id}
              tab={t}
              cwd={tabCwd(t)}
              dragging={dragging}
              drop={drop}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onJump={() => onJumpTab(t.id)}
              onClose={() => onCloseTab(t.id)}
            />
          ))}
          {tabs.length === 0 && (
            <span className="px-2 py-1 text-[10.5px] text-muted-foreground/50">
              {draggingTabFromOther ? "Drop to move here" : "No tabs"}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function TabRow({
  tab,
  cwd,
  dragging,
  drop,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onJump,
  onClose,
}: {
  tab: Tab;
  /** 实时落点（终端类标签页），由 SpaceRow 用 liveCwdOf 算好传进来 */
  cwd: string | null;
  dragging: { kind: "space" | "tab"; id: string | number } | null;
  drop: DropTarget | null;
  onPointerDown: (
    e: React.PointerEvent,
    kind: "space" | "tab",
    id: string | number,
  ) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent, onActivate?: () => void) => void;
  onJump: () => void;
  onClose: () => void;
}) {
  const subtitle = subtitleFor(tab, cwd);
  const isDragging = dragging?.kind === "tab" && dragging.id === tab.id;
  const reorderEdge =
    drop?.kind === "tab" && drop.tabId === tab.id ? drop.edge : null;

  return (
    <div className="relative">
      {reorderEdge && <DropLine edge={reorderEdge} />}
      {/* biome-ignore lint/a11y/useSemanticElements: drag row hosts a nested close button, cannot be a <button> */}
      <div
        data-drop="tab"
        data-tab-id={tab.id}
        role="button"
        tabIndex={0}
        onPointerDown={(e) => onPointerDown(e, "tab", tab.id)}
        onPointerMove={onPointerMove}
        onPointerUp={(e) => onPointerUp(e, onJump)}
        onPointerCancel={(e) => onPointerUp(e)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onJump();
          }
        }}
        className={cn(
          "group/tab relative flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1 outline-none transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-primary/40",
          isDragging && "opacity-50",
        )}
      >
        <TabIcon tab={tab} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[11.5px] leading-tight">
            {labelFor(tab)}
          </span>
          {subtitle && (
            <span className="truncate text-[9.5px] leading-tight text-muted-foreground/55">
              {subtitle}
            </span>
          )}
        </span>
        <button
          type="button"
          data-no-drag
          onClick={(e) => {
            e.stopPropagation();
            onClose();
          }}
          aria-label="Close tab"
          className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover/tab:opacity-70 hover:opacity-100"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={11} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}

function DropLine({ edge }: { edge: Edge }) {
  return (
    <span
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-x-1 z-10 h-0.5 rounded-full bg-primary",
        edge === "top" ? "top-0 -translate-y-1/2" : "bottom-0 translate-y-1/2",
      )}
    />
  );
}

function OverlayChip({
  tab,
  color,
  label,
}: {
  tab?: Tab;
  color?: string;
  label: string;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md border border-border bg-popover px-2 py-1.5 text-xs shadow-lg">
      {tab ? (
        <TabIcon tab={tab} />
      ) : (
        <span
          aria-hidden
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: color }}
        />
      )}
      <span className="max-w-44 truncate font-medium">{label}</span>
    </div>
  );
}

function RowAction({
  icon,
  label,
  onClick,
  destructive,
}: {
  icon: typeof Delete02Icon;
  label: string;
  onClick: () => void;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "flex size-5 items-center justify-center rounded text-muted-foreground/70 transition-colors",
        destructive
          ? "hover:bg-destructive/10 hover:text-destructive"
          : "hover:bg-accent hover:text-foreground",
      )}
    >
      <HugeiconsIcon icon={icon} size={13} strokeWidth={1.75} />
    </button>
  );
}
