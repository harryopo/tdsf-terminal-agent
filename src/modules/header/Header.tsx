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

// === TDSF Agent 类型 + SUB_AGENT_DISPLAY（v2026-07-29 改造：统一主 Agent 入口）
// 旧版：让用户手动切换 4 Agent Tab
// 新版：所有消息统一走 'main' 入口，main_agent 自动路由到 8 个子 Agent
// 顶部只读显示当前路由到的子 Agent 名
type TdsfAgentId = "main" | "coder" | "explore" | "history" | "teach";

/** 后端 agent name → 前端 label 映射（agent_switch 事件用） */
const SUB_AGENT_DISPLAY: Record<string, { label: string; tone: string }> = {
  main: { label: "Main", tone: "var(--color-foreground, currentColor)" },
  coding: { label: "Coding", tone: "var(--color-emerald-500, #10b981)" },
  explore: { label: "Explore", tone: "var(--color-sky-500, #0ea5e9)" },
  history: { label: "History", tone: "var(--color-amber-500, #f59e0b)" },
  teach: { label: "Teach", tone: "var(--color-violet-500, #8b5cf6)" },
  debug: { label: "Debug", tone: "var(--color-rose-500, #f43f5e)" },
  refactor: { label: "Refactor", tone: "var(--color-cyan-500, #06b6d4)" },
  test: { label: "Test", tone: "var(--color-lime-500, #84cc16)" },
  deploy: { label: "Deploy", tone: "var(--color-orange-500, #f97316)" },
};

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
  // TDSF 魔改: 新增可选 props 用于整合 TdsfTitlebar 功能
  /** 项目名（显示在 TDSF logo 右侧） */
  projectName?: string;
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
  projectName,
  agentId: agentIdProp,
  onAgentChange: onAgentChangeProp,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [compact, setCompact] = useState(false);
  const [narrow, setNarrow] = useState(false);

  // TDSF 魔改: 从 chatStore 读取 agent 状态（统一 Main 入口 + 子 Agent 路由状态 + mood）
  const agentMeta = useChatStore((s) => s.agentMeta);
  const storeAgentId = useChatStore((s) => s.tdsfAgentId);
  const storeSetAgent = useChatStore((s) => s.setTdsfAgent);
  const currentSubAgent = useChatStore((s) => s.currentSubAgent);
  // v2026-07-29: 统一主 Agent 入口后，agentId/onAgentChange 仅作为 prop 兼容入口保留
  // （保留对外 API 兼容性，但当前 Header 内部不再切换 Agent，统一只读显示 currentSubAgent）
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

        {/* TDSF 魔改: 品牌区域（logo.svg + 产品名 + 项目名），简约灰色风格 */}
        {projectName && !compact && (
          <div
            className="flex shrink-0 items-center gap-2 px-2"
            data-tauri-drag-region
          >
            <img
              src="/logo.svg"
              alt=""
              draggable={false}
              className="size-4 shrink-0 rounded-[3px]"
            />
            <span
              className="text-[12px] font-semibold tracking-tight text-foreground"
              title="TDSF Terminal Agent"
            >
              TDSF Terminal
            </span>
            <span className="text-[10px] text-muted-foreground/40">/</span>
            <span
              className="max-w-[120px] truncate text-[11px] text-muted-foreground"
              title={projectName}
            >
              {projectName}
            </span>
          </div>
        )}

        {/* TDSF 魔改: Agent 状态指示器（v2026-07-29 改造：只读显示）
            - 旧版是 4 Agent Segmented Control，让用户手动切换
            - 新版是只读 pill，显示 main_agent 当前路由到的子 Agent
            - 用户无需选择，main_agent 在 Python 端根据意图自动路由 */}
        {!narrow && (
          <div
            className="flex shrink-0 items-center gap-0.5 rounded-full p-0.5 mx-1"
            style={{
              background: "var(--color-muted, rgba(0,0,0,0.06))",
              height: "22px",
            }}
            data-testid="header-agent-status"
          >
            {(() => {
              const routed = currentSubAgent
                ? SUB_AGENT_DISPLAY[currentSubAgent] ?? SUB_AGENT_DISPLAY.main
                : SUB_AGENT_DISPLAY.main;
              const isRouted = currentSubAgent && currentSubAgent !== "main";
              const isBusy = mood === "thinking" || mood === "streaming";
              return (
                <div
                  className="flex items-center gap-1.5 rounded-full px-2 font-mono"
                  style={{
                    height: "18px",
                    fontSize: "10px",
                    fontWeight: 600,
                    color: routed.tone,
                    background: isRouted
                      ? "color-mix(in srgb, currentColor 12%, transparent)"
                      : "var(--color-background, transparent)",
                    cursor: "default",
                  }}
                  title={
                    isRouted
                      ? `主 Agent 正在调度 ${routed.label} Agent`
                      : "统一主 Agent（自动路由到子 Agent）"
                  }
                  data-testid="header-agent-status-pill"
                >
                  <span
                    className="inline-block size-1.5 rounded-full"
                    style={{
                      background: routed.tone,
                      animation: isBusy
                        ? "pulse 1.4s ease-in-out infinite"
                        : "none",
                    }}
                  />
                  {routed.label}
                </div>
              );
            })()}
          </div>
        )}

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
      <div
        className="flex min-w-0 flex-1 items-center gap-2"
        data-tauri-drag-region
      >
        {spaceSwitcher}
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
        <div data-tauri-drag-region className="h-full min-w-2 flex-1" />
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
