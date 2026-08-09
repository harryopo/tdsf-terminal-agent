/**
 * TranslateTooltip.tsx — 终端翻译卡片（P2-5 重构）
 * -----------------------------------------------------------------------------
 * Terax 风格灰黑/白灰卡片：
 *   - 暗色主题：灰黑卡片（bg-card/95 + 细边框 + 圆角）
 *   - 亮色主题：白灰卡片（语义 token 自动适配）
 * 词条分区：词头（等宽）+ 释义 + 示例（左边框徽章）+ 详细说明。
 *
 * 消失逻辑（修复"点击不消失"）：
 *   - 点击卡片外部任意位置 → hideTooltip
 *   - Esc → hideTooltip
 *   - 再次触发翻译/选择浮层 → 自然替换
 */

import { BookOpen01Icon, SparklesIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { useTranslateStore } from "./translateStore";

type Props = {
  /** 点击「Ask TDSF」：把选中文本 attach 到 AI 面板 */
  onAsk?: (text: string) => void;
};

/** 卡片与选中点的间隙（px） */
const GAP = 12;
/** 卡片距视口边缘的最小边距（px） */
const EDGE = 8;

export function TranslateTooltip({ onAsk }: Props) {
  const result = useTranslateStore((s) => s.result);
  const missing = useTranslateStore((s) => s.missing);
  const x = useTranslateStore((s) => s.x);
  const y = useTranslateStore((s) => s.y);

  const cardRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  // 卡片相对选中点的方向：below=下方(默认)；above=下方空间不足时翻转上方
  const [dir, setDir] = useState<"below" | "above">("below");

  // 阶段 1：估算下方位置先渲染（实际高度未知，layout effect 再修正/翻转）
  useEffect(() => {
    if (!result && !missing) {
      setVisible(false);
      return;
    }
    setPos({
      top: y + GAP,
      left: Math.max(EDGE, Math.min(x + EDGE, window.innerWidth - 320 - EDGE)),
    });
    setDir("below");
    setVisible(true);
  }, [result, missing, x, y]);

  // 阶段 2：测量实际卡片尺寸，底部空间不足 → 智能翻转到选中点上方（layout 阶段，
  // paint 前同步修正，无闪跳）。左右边界一并收进视口内留 EDGE 边距。
  useLayoutEffect(() => {
    if (!visible) return;
    const el = cardRef.current;
    if (!el) return;
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    let top = y + GAP;
    let nextDir: "below" | "above" = "below";
    if (top + h > window.innerHeight - EDGE) {
      top = Math.max(EDGE, y - h - GAP);
      nextDir = "above";
    }
    const left = Math.max(EDGE, Math.min(x + EDGE, window.innerWidth - w - EDGE));
    setPos((prev) => (prev.top === top && prev.left === left ? prev : { top, left }));
    setDir((prev) => (prev === nextDir ? prev : nextDir));
  }, [visible, y, x]);

  // P2-5: 消失逻辑——点击卡片外部 / Esc 隐藏
  useEffect(() => {
    if (!result && !missing) return;
    const onDown = (e: MouseEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el?.closest("[data-translate-tooltip]")) {
        useTranslateStore.getState().hideTooltip();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useTranslateStore.getState().hideTooltip();
    };
    // 窗口失焦兜底（拖出窗口 mouseup 丢失时防卡片残留）
    const onBlur = () => useTranslateStore.getState().hideTooltip();
    // 延迟注册：避免触发本次翻译的 mouseup 立即关掉卡片
    const t = window.setTimeout(() => {
      document.addEventListener("mousedown", onDown);
      document.addEventListener("keydown", onKey);
      window.addEventListener("blur", onBlur);
    }, 80);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [result, missing]);

  if (!result && !missing) return null;

  const sourceText = result?.source ?? missing ?? "";

  return (
    <div
      ref={cardRef}
      data-translate-tooltip
      className={cn(
        "fixed z-[10000] w-[320px] max-w-[320px] overflow-hidden rounded-lg border shadow-lg backdrop-blur-md",
        "border-border/60 bg-card/95",
        visible
          ? cn(
              "animate-in fade-in-0 zoom-in-95 duration-150",
              dir === "above" ? "slide-in-from-top-1" : "slide-in-from-bottom-1",
            )
          : "opacity-0",
      )}
      style={{ left: pos.left, top: pos.top }}
    >
      {missing ? (
        /* 未命中：中性提示（Ask 按钮由底部统一追问区提供） */
        <div data-testid="translate-tooltip-missing" className="p-3">
          <div className="font-mono text-[12px] font-semibold text-foreground">
            {missing}
          </div>
          <div className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
            未在离线词典中找到释义——可让 AI 解释这段
          </div>
        </div>
      ) : (
        /* 命中：词头 + 释义 + 示例/详细 */
        <div data-testid="translate-tooltip">
          {/* 词头 */}
          <div className="flex items-center gap-1.5 border-b border-border/50 bg-muted/20 px-3 py-2">
            <HugeiconsIcon
              icon={BookOpen01Icon}
              size={13}
              strokeWidth={1.75}
              className="shrink-0 text-muted-foreground"
            />
            <span className="truncate font-mono text-[12px] font-semibold text-foreground">
              {result!.source}
            </span>
            {result!.entries[0]?.pos && (
              <span className="shrink-0 rounded bg-muted px-1 py-px text-[9.5px] text-muted-foreground/80">
                {result!.entries[0].pos}
              </span>
            )}
            {result!.entries[0]?.tag && (
              <span className="shrink-0 rounded bg-muted px-1 py-px text-[9.5px] text-muted-foreground/70">
                {result!.entries[0].tag}
              </span>
            )}
          </div>

          {/* 释义列表 */}
          <div className="space-y-2 p-3">
            {result!.entries.map((entry, i) => (
              <div key={`${entry.word}-${i}`}>
                <div className="text-[12px] leading-relaxed text-foreground">
                  {entry.word !== result!.source && (
                    <span className="mr-1 font-mono text-[11px] text-muted-foreground/80">
                      {entry.word}
                    </span>
                  )}
                  {entry.zh}
                </div>

                {/* 示例（左边框徽章）— 核心命令解释 + 作用/效果, 精简展示 */}
                {entry.example && (
                  <div className="mt-1 border-l-2 border-sky-500/60 bg-sky-500/5 py-0.5 pl-2 text-[11px] leading-relaxed text-muted-foreground">
                    <span className="mr-1 rounded bg-muted px-1 py-px text-[9px] text-muted-foreground/70">
                      示例
                    </span>
                    {entry.example}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 追问 */}
      {onAsk && (
        <div className="border-t border-border/50 p-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="translate-ask"
            onClick={() => {
              onAsk(sourceText);
              useTranslateStore.getState().hideTooltip();
            }}
            className="h-6 w-full gap-1.5 text-[11px]"
          >
            <HugeiconsIcon icon={SparklesIcon} size={11} strokeWidth={1.75} />
            Ask TDSF 解释这段
          </Button>
        </div>
      )}
    </div>
  );
}
