// TDSF 魔改: Header 整合 TdsfTitlebar 功能（项目名 / 4 Agent / 主题切换 / mood）
// -----------------------------------------------------------------------------
// 原设计: Header 仅承载 tab 栏 + 命令面板 + 通知 + 设置
// 魔改后: 单层顶栏整合所有功能，避免双层 UI 冲突
//
// 布局（h-10, 40px）:
//   左: [侧栏切换] [TDSF logo + 项目名] [4 Agent Segmented] | [命令面板] [NotificationBell]
//   中: [SpaceSwitcher] [TabBar] (flex-1)
//   右: [SearchInline] [mood] [主题切换] [设置] [WindowControls]
import { Button } from "@/components/ui/button";
import { WindowControls } from "@/components/WindowControls";
import { IS_MAC, USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { NotificationBell } from "@/modules/agents";
import type { AgentLaunchRequest } from "@/modules/agents/lib/launcher";
import { useTheme } from "@/modules/theme";
import { useTranslateStore } from "@/modules/translate";
import type { Tab } from "@/modules/tabs";
import { TabBar } from "@/modules/tabs";
import {
  CommandIcon,
  Moon01Icon,
  Settings01Icon,
  SidebarLeftIcon,
  Sun01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  SearchInline,
  type SearchInlineHandle,
  type SearchTarget,
} from "./SearchInline";

// TDSF 魔改 2026-07-31: Header 内 Agent 状态 pill 直接复用 AgentStatusPill,
// 与右下角状态栏风格统一, 去除独立彩色标签, 节省水平空间。
import { AgentStatusPill } from "@/modules/ai/components/AgentStatusPill";

// 新版：所有消息统一走 'main' 入口，main_agent 自动路由到 8 个子 Agent。
// 顶部只读显示当前路由到的子 Agent 名（通过 AgentStatusPill）。
type TdsfAgentId = "main" | "coder" | "explore" | "history" | "teach";

// === mood 表情映射（与原 TdsfTitlebar 一致） ===============================
const MOOD_FACE: Record<string, string> = {
  idle: "⬡‿⬡",
  thinking: "⬡_⬡",
  streaming: "⬡~⬡",
  "awaiting-approval": "⬡⏸⬡",
  error: "⬡✗⬡",
};

type Props = {
  tabs: Tab[];
  activeId: number;
  onSelect: (id: number) => void;
  onNew: () => void;
  onNewBlock: () => void;
  onNewPrivate: () => void;
  onNewPreview: () => void;
  onNewEditor: () => void;
  onNewGitGraph: () => void;
  onLaunchAgents: (request: AgentLaunchRequest) => void;
  onClose: (id: number) => void;
  /** Promote a preview (transient) tab to persistent. */
  onPin: (id: number) => void;
  /** Set a terminal tab's custom label; empty string resets to default. */
  onRename: (id: number, title: string) => void;
  /** Move a dragged tab to a new position (insertion gap index). */
  onReorder: (fromId: number, toGapIndex: number) => void;
  onOverrideLanguage?: (id: number, lang: string | null) => void;
  onToggleSidebar: () => void;
  onOpenCommandPalette: () => void;
  onActivateAgent: (tabId: number, leafId: number) => void;
  onActivateLocalAgent: () => void;
  onOpenSettings: () => void;
  spaceSwitcher: ReactNode;
  searchTarget: SearchTarget;
  searchRef: RefObject<SearchInlineHandle | null>;
  /** 当前 TDSF Agent（不传则从 chatStore 读取） */
  agentId?: TdsfAgentId;
  /** 切换 TDSF Agent（不传则用 chatStore 的 setter） */
  onAgentChange?: (id: TdsfAgentId) => void;
};

const COMPACT_WIDTH = 720;
const NARROW_WIDTH = 960; // 4 Agent 切换隐藏的阈值

export function Header({
  tabs,
  activeId,
  onSelect,
  onNew,
  onNewBlock,
  onNewPrivate,
  onNewPreview,
  onNewEditor,
  onNewGitGraph,
  onLaunchAgents,
  onClose,
  onPin,
  onRename,
  onReorder,
  onOverrideLanguage,
  onToggleSidebar,
  onOpenCommandPalette,
  onActivateAgent,
  onActivateLocalAgent,
  onOpenSettings,
  spaceSwitcher,
  searchTarget,
  searchRef,
  agentId: agentIdProp,
  onAgentChange: onAgentChangeProp,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const [narrow, setNarrow] = useState(false);

  // TDSF 魔改: 从 chatStore 读取 agent 状态（mood）
  const agentMeta = useChatStore((s) => s.agentMeta);
  const storeAgentId = useChatStore((s) => s.tdsfAgentId);
  const storeSetAgent = useChatStore((s) => s.setTdsfAgent);
  // v2026-07-29: 统一主 Agent 入口后，agentId/onAgentChange 仅作为 prop 兼容入口保留。
  // 子 Agent 路由状态由 AgentStatusPill 内部读取，Header 不再直接订阅 currentSubAgent。
  const agentId = agentIdProp ?? storeAgentId;
  const onAgentChange = onAgentChangeProp ?? storeSetAgent;
  void agentId;
  void onAgentChange;

  // TDSF 魔改: 主题切换（通过 ThemeProvider，持久化 + 响应 system 偏好）
  const { resolvedMode, setMode } = useTheme();
  const toggleTheme = () => {
    setMode(resolvedMode === "dark" ? "light" : "dark");
  };

  // TDSF 魔改 2026-07-29: 终端翻译开关
  const translateEnabled = useTranslateStore((s) => s.enabled);
  const toggleTranslate = useTranslateStore((s) => s.toggleEnabled);

  useEffect(() => {
    const el = rootRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 0;
      setCompact(w < COMPACT_WIDTH);
      setNarrow(w < NARROW_WIDTH);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const settingsButton = (
    <Button
      data-testid="settings-button"
      variant="ghost"
      size="icon"
      className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      onClick={onOpenSettings}
      title="Settings"
    >
      <HugeiconsIcon icon={Settings01Icon} size={15} strokeWidth={1.75} />
    </Button>
  );

  // TDSF 魔改: mood 表情（紧凑显示，仅占 ~70px）
  const mood = agentMeta.status;
  const moodFace = MOOD_FACE[mood] ?? "⬡‿⬡";

  return (
    <div
      ref={rootRef}
      data-tauri-drag-region
      className={`flex h-10 shrink-0 items-center gap-2 border-b border-border/60 bg-card select-none ${
        IS_MAC ? "pl-20 pr-2" : "pl-2 pr-0"
      }`}
    >
      {/* ===== 左侧: 侧栏 + 品牌 + 4 Agent + 命令面板 + 通知 ===== */}
      <div className="flex shrink-0 items-center gap-0.5">
        <Button
          onClick={onToggleSidebar}
          title="Toggle sidebar (Ctrl+B)"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={SidebarLeftIcon} size={18} strokeWidth={1.75} />
        </Button>

        {/* TDSF 魔改: Agent 状态指示器（v2026-07-29 改造：只读显示）
            - 旧版是 4 Agent Segmented Control，让用户手动切换
            - 新版是只读 pill，显示 main_agent 当前路由到的子 Agent
            - 用户无需选择，main_agent 在 Python 端根据意图自动路由 */}
        {/* TDSF 魔改 2026-07-31: 复用 AgentStatusPill, 与右下角状态栏风格统一,
            去除 Header 独立的彩色标签, 节省水平空间。 */}
        {!narrow && <AgentStatusPill data-testid="header-agent-status-pill" />}

        {/* mood 表情（紧凑显示） */}
        {!narrow && (
          <span
            className="shrink-0 font-mono text-[10px] text-muted-foreground px-1"
            title={`Agent status: ${mood}`}
            data-testid="header-mood"
          >
            {moodFace}
          </span>
        )}

        <Button
          size="icon-sm"
          variant="ghost"
          onClick={onOpenCommandPalette}
          title="Command palette"
          className="shrink-0 gap-1.5 rounded-md px-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={CommandIcon} size={14} strokeWidth={1.75} />
        </Button>

        {!IS_MAC && (
          <NotificationBell
            onActivate={onActivateAgent}
            onActivateLocal={onActivateLocalAgent}
          />
        )}
      </div>

      {!IS_MAC && <span className="mx-1 h-full w-px shrink-0 bg-border/70" />}

      {IS_MAC && <span className="mr-1 h-full w-px shrink-0 bg-border/70" />}

      {/* ===== 中间: SpaceSwitcher + TabBar ===== */}
      {/* TDSF 魔改 2026-07-30: 多 space 时防止 TabBar 溢出遮住左侧工作区
          - 容器加 overflow-hidden, 内部 TabBar 用 overflow-x-auto 横向滚动
          - SpaceSwitcher 允许 shrink 并收窄 (max-w-24) 在空间不足时让位
          - 移除末尾的 flex-1 占位 div, 改为 min-w-0 让容器真正受父级 flex-1 约束 */}
      <div
        className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden"
        data-tauri-drag-region
      >
        <div className="min-w-0 shrink">
          {spaceSwitcher}
        </div>
        <TabBar
          tabs={tabs}
          activeId={activeId}
          onSelect={onSelect}
          onNew={onNew}
          onNewBlock={onNewBlock}
          onNewPrivate={onNewPrivate}
          onNewPreview={onNewPreview}
          onNewEditor={onNewEditor}
          onNewGitGraph={onNewGitGraph}
          onLaunchAgents={onLaunchAgents}
          onClose={onClose}
          onPin={onPin}
          onRename={onRename}
          onReorder={onReorder}
          onOverrideLanguage={onOverrideLanguage}
          compact={compact}
        />
        <div data-tauri-drag-region className="h-full min-w-1 flex-1" />
      </div>

      <SearchInline ref={searchRef} target={searchTarget} compact={compact} />

      {/* ===== 右侧: 主题切换 + 设置 + 窗口控制 ===== */}
      {/* TDSF 魔改: 主题切换按钮（亮/暗模式切换，使用 ThemeProvider 持久化） */}
      <Button
        variant="ghost"
        size="icon"
        onClick={toggleTheme}
        title={resolvedMode === "dark" ? "切换到亮色模式" : "切换到暗色模式"}
        className="size-7 shrink-0 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        data-testid="header-theme-toggle"
      >
        <HugeiconsIcon
          icon={resolvedMode === "dark" ? Sun01Icon : Moon01Icon}
          size={15}
          strokeWidth={1.75}
        />
      </Button>

      {/* TDSF 魔改 2026-07-29: 终端翻译开关 (Ctrl+Shift+T) */}
      <Button
        variant="ghost"
        size="icon"
        onClick={toggleTranslate}
        title={
          translateEnabled
            ? "关闭终端翻译 (Ctrl+Shift+T)"
            : "开启终端翻译 (Ctrl+Shift+T)"
        }
        className={`size-7 shrink-0 rounded-md transition-colors ${
          translateEnabled
            ? "text-emerald-500 bg-emerald-500/10 hover:bg-emerald-500/20"
            : "text-muted-foreground hover:bg-accent hover:text-foreground"
        }`}
        data-testid="header-translate-toggle"
      >
        <span
          className="text-[11px] font-bold select-none"
          style={{ fontFamily: "'JetBrains Mono', monospace" }}
        >
          译
        </span>
      </Button>

      {IS_MAC && (
        <>
          <NotificationBell
            onActivate={onActivateAgent}
            onActivateLocal={onActivateLocalAgent}
          />
          {settingsButton}
        </>
      )}

      {!IS_MAC && settingsButton}

      {USE_CUSTOM_WINDOW_CONTROLS && (
        <>
          <span className="ml-1 h-5 w-px shrink-0 bg-border/60" />
          <WindowControls />
        </>
      )}
    </div>
  );
}
