// ============================================================================
// AgentModeSwitcher — 四档信任模式抽屉卡片（v3.1.5，用户钦定参考图复刻）
// ============================================================================
//
// 四档：观察 / 确认 / 自动 / 教学（AgentMode = observe|confirm|auto|teach）。
// 教学档 = 只读 + 教学 prompt 的预置组合（toSidecarMode 展开为
// observe + teach=true 下发 sidecar），与其他三档的区别见 AGENT_MODE_META。
//
// v3.1.5 变更（用户反馈 2026-08-31 第二轮）：
//   - 面板改为 **Portal + fixed 定位**：彻底脱离 overflow 祖先的裁剪
//     （v3.1.4 absolute 面板在输入区工具行被相邻容器遮盖）
//   - 行布局复刻用户参考图：[✓选中] [彩色图标] [名称] [右侧灰色简短说明]
//     （brief 来自 AGENT_MODE_META.brief；长 desc 不再进卡片）
//   - 触发按钮保留当前模式显示；卡片大圆角 + 深阴影 + hover 高亮
//
// 状态：chatStore.agentMode（会话级，per-session 持久化到 SessionMeta，
// 切换会话/重启自动恢复）。切换即时生效：下一条消息的 agent.invoke 就会
// 带新模式（state.live.agentMode / state.live.teach）。
//
// 消费方：AiComposerInput 工具行、TdsfAgentPanel 头部。
// ============================================================================

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/utils";
import {
  ArrowDown01Icon,
  BookOpen01Icon,
  EyeIcon,
  FlashIcon,
  ShieldUserIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import {
  AGENT_MODES,
  AGENT_MODE_ACCENT,
  AGENT_MODE_META,
  type AgentMode,
} from "../agents/registry";
import { useChatStore } from "../store/chatStore";

/** 模式 → 图标（观察=眼 / 确认=盾 / 自动=闪电 / 教学=书，与 AgentStatusPill 一致） */
const MODE_ICON: Record<AgentMode, typeof EyeIcon> = {
  observe: EyeIcon,
  confirm: ShieldUserIcon,
  auto: FlashIcon,
  teach: BookOpen01Icon,
};

/** 模式强调色（用户钦定 2026-09-01：观察黄/确认绿/自动红/教学紫，单一真源 registry） */
function accentColorClass(mode: AgentMode): string {
  return AGENT_MODE_ACCENT[mode].text;
}

/** 卡片定位状态：top（向下弹）或 bottom（向上弹）二选一；
 *  anchorBottom = 触发按钮视口底边（改换弹出方向时用） */
type MenuPos = {
  left: number;
  top?: number;
  bottom?: number;
  anchorBottom: number;
};

/** 视口安全边距（卡片与窗口边缘最小间距） */
const VIEWPORT_MARGIN = 8;

export function AgentModeSwitcher({ className }: { className?: string }) {
  const agentMode = useChatStore((s) => s.agentMode);
  const setAgentMode = useChatStore((s) => s.setAgentMode);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<MenuPos | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const meta = AGENT_MODE_META[agentMode];
  const ActiveIcon = MODE_ICON[agentMode];

  // 打开：按 trigger 位置计算初始坐标（默认向上弹；渲染后 useLayoutEffect 实测校正）
  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // 水平预 clamp：估算卡片宽（w-56=224px），防止靠右时伸出窗口
    const estLeft = Math.max(
      VIEWPORT_MARGIN,
      Math.min(rect.left, window.innerWidth - 224 - VIEWPORT_MARGIN),
    );
    setPos({
      left: estLeft,
      bottom: window.innerHeight - rect.top + 6,
      anchorBottom: rect.bottom,
    });
    setOpen(true);
  };

  // 渲染后实测卡片尺寸做自适应校正（一次）：
  //   水平——按实际宽度 clamp；垂直——向上弹顶部放不下则改向下弹，向下也放不下则贴边
  useLayoutEffect(() => {
    if (!open || !menuRef.current) return;
    const el = menuRef.current;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setPos((prev) => {
      if (!prev) return prev;
      const left = Math.max(
        VIEWPORT_MARGIN,
        Math.min(prev.left, window.innerWidth - w - VIEWPORT_MARGIN),
      );
      if (prev.bottom !== undefined) {
        const topEdge = window.innerHeight - prev.bottom - h;
        if (topEdge < VIEWPORT_MARGIN) {
          if (
            prev.anchorBottom + h + VIEWPORT_MARGIN <=
            window.innerHeight
          ) {
            // 上方放不下 → 翻转到触发按钮下方
            return { left, top: prev.anchorBottom + 6, anchorBottom: prev.anchorBottom };
          }
          // 两头都放不下 → 贴视口底边
          return {
            left,
            bottom: Math.max(VIEWPORT_MARGIN, window.innerHeight - h - VIEWPORT_MARGIN),
            anchorBottom: prev.anchorBottom,
          };
        }
      } else if (prev.top !== undefined) {
        if (prev.top + h > window.innerHeight - VIEWPORT_MARGIN) {
          return {
            left,
            top: Math.max(VIEWPORT_MARGIN, window.innerHeight - h - VIEWPORT_MARGIN),
            anchorBottom: prev.anchorBottom,
          };
        }
      }
      return left === prev.left ? prev : { ...prev, left };
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (
        !triggerRef.current?.contains(t) &&
        !document.querySelector("[data-testid='agent-mode-menu']")?.contains(t)
      ) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const pick = (mode: AgentMode) => {
    setAgentMode(mode);
    setOpen(false);
  };

  return (
    <div className={cn("relative shrink-0", className)} data-testid="agent-mode-switcher">
      {/* 触发按钮：显示当前模式（强调色跟随档位） */}
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Agent 信任模式：${meta.label}`}
        onClick={() => (open ? setOpen(false) : openMenu())}
        data-testid="agent-mode-trigger"
        className={cn(
          "flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px] font-medium transition-colors",
          open
            ? "border-border/60 bg-accent/60"
            : "border-border/40 bg-card/40 hover:bg-accent/40",
          accentColorClass(agentMode),
        )}
      >
        <HugeiconsIcon icon={ActiveIcon} size={10} strokeWidth={1.75} />
        <span>{meta.label}</span>
        <HugeiconsIcon
          icon={ArrowDown01Icon}
          size={10}
          strokeWidth={1.75}
          className="opacity-60"
        />
      </button>

      {/* 抽屉卡片：Portal 到 body + fixed 定位（不受 overflow 祖先裁剪），
          位置经视口 clamp 自适应——靠右不伸出右缘，顶部放不下自动向下弹 */}
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="listbox"
            aria-label="Agent 信任模式"
            data-testid="agent-mode-menu"
            style={{
              left: pos.left,
              ...(pos.top !== undefined ? { top: pos.top } : { bottom: pos.bottom }),
            }}
            className="fixed z-[100] w-56 overflow-hidden rounded-2xl border border-border/50 bg-popover p-1.5 text-popover-foreground shadow-xl shadow-black/30"
          >
            {AGENT_MODES.map((mode) => {
              const active = mode === agentMode;
              const m = AGENT_MODE_META[mode];
              const Icon = MODE_ICON[mode];
              return (
                <button
                  key={mode}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => pick(mode)}
                  data-testid={`agent-mode-${mode}`}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left transition-colors",
                    active
                      ? "bg-accent/50"
                      : "hover:bg-accent/40",
                  )}
                >
                  {/* 选中勾（图3 左侧 ✓；未选中占位对齐） */}
                  <span className="flex w-3.5 shrink-0 justify-center">
                    {active && (
                      <HugeiconsIcon
                        icon={Tick02Icon}
                        size={13}
                        strokeWidth={2}
                        className="text-foreground"
                      />
                    )}
                  </span>
                  <HugeiconsIcon
                    icon={Icon}
                    size={14}
                    strokeWidth={1.75}
                    className={cn(
                      "shrink-0",
                      active ? accentColorClass(mode) : "text-muted-foreground",
                    )}
                  />
                  <span
                    className={cn(
                      "shrink-0 text-[12.5px] font-medium",
                      active ? "text-foreground" : "text-foreground/90",
                    )}
                  >
                    {m.label}
                  </span>
                  {/* 右侧简短说明（灰色小字，图3 布局） */}
                  <span className="ml-auto truncate pl-2 text-[11px] text-muted-foreground">
                    {m.brief}
                  </span>
                </button>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
