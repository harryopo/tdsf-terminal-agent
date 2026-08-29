// TDSF B2 (2026-08-29): 可视教学打字机 —— "演示中"状态条 + 警告 toast
// -----------------------------------------------------------------------------
// 监听 Rust human_type pump 的 `terminal:human_typing` 事件：
//   - start: 顶部居中显示"Agent 正在演示输入…（按任意键接管）"
//   - end:   状态条消失；warning（`!` 告警 / sudo 降级提示）弹 sonner toast；
//            stopped（用户按键接管）提示已交还控制权
//
// 挂载于 App.tsx 顶层（跟随 ServerMonitorEntry 的全局入口惯例）。
// 打断机制本身在 Rust 侧（pty_write/ssh_write 用户键盘写入 → bump
// user_input_seq → pump 轮询停止），此组件只负责可视化。

import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { toast } from "sonner";

import { cn } from "@/lib/utils";
import { HugeiconsIcon } from "@hugeicons/react";
import { KeyboardIcon } from "@hugeicons/core-free-icons";

type HumanTypingEventPayload = {
  phase: "start" | "end";
  target: "pty" | "ssh";
  id: number;
  mode: "human" | "fallback";
  stopped: boolean;
  warning?: string | null;
};

const HUMAN_TYPING_EVENT = "terminal:human_typing";

export function AgentTypingIndicator() {
  const [typing, setTyping] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let disposed = false;
    void (async () => {
      try {
        const stop = await listen<HumanTypingEventPayload>(
          HUMAN_TYPING_EVENT,
          (event) => {
            const p = event.payload;
            if (!p) return;
            if (p.phase === "start") {
              setTyping(true);
              return;
            }
            // end：状态条消失（无论 human 结束、用户接管还是 fallback）
            setTyping(false);
            if (p.warning) {
              toast.warning(p.warning);
            } else if (p.mode === "human" && p.stopped) {
              toast.info("已接管终端输入（Agent 演示被打断）");
            }
          },
        );
        if (disposed) stop();
        else unlisten = stop;
      } catch (e) {
        // 非 Tauri 环境（pnpm dev）或事件 API 不可用：静默降级，状态条不显示
        console.warn("[tdsf] human_typing listen failed:", e);
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (!typing) return null;

  return (
    <div
      data-testid="agent-typing-indicator"
      className={cn(
        "fixed left-1/2 top-14 z-50 -translate-x-1/2",
        "flex items-center gap-2 rounded-full border border-sky-500/40 bg-card/95 px-3 py-1",
        "text-[11px] font-medium text-sky-600 shadow-lg backdrop-blur-md",
        "dark:text-sky-400",
      )}
    >
      <HugeiconsIcon icon={KeyboardIcon} size={12} strokeWidth={1.75} />
      <span>Agent 正在演示输入…</span>
      <span className="text-muted-foreground">按任意键接管</span>
    </div>
  );
}
