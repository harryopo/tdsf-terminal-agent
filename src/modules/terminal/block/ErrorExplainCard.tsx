/**
 * ErrorExplainCard — 失败块"AI 解释"浮层卡片（B1-G3，TDSF 魔改 2026-08-28）
 * -----------------------------------------------------------------------------
 * 用户拍板：手动触发。由 BlockOverlay 在失败块工具条下方渲染，
 * 订阅 errorExplainStore（streaming/done/error 三态）。
 * 用户偏好：Teach 模式轻量化——此卡片为单块解释，无知识点轰炸。
 */
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { Cancel01Icon, Copy01Icon, SparklesIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { toast } from "sonner";
import { useErrorExplainStore } from "./errorExplainStore";

type Props = {
  /** 该块是否为当前展示解释的块 */
  active: boolean;
  /** 卡片锚点（块分隔线 y 坐标，卡片放其下方） */
  top: number;
};

export function ErrorExplainCard({ active, top }: Props) {
  const status = useErrorExplainStore((s) => s.status);
  const text = useErrorExplainStore((s) => s.text);
  const error = useErrorExplainStore((s) => s.error);

  if (!active) return null;

  const close = () => useErrorExplainStore.getState().close();
  const copy = () => {
    void navigator.clipboard
      .writeText(text)
      .then(() => toast.success("解释已复制"))
      .catch(() => {});
  };
  const openInChat = () => {
    // 把解释上下文附到 AI 面板继续追问（复用 attachSelection 通道）
    useChatStore.getState().attachSelection(text, "terminal");
    close();
  };

  return (
    <div
      className="bt-explain-card pointer-events-auto absolute right-3 z-20 w-80 max-w-[calc(100%-24px)] rounded-md border bg-popover/95 shadow-md backdrop-blur"
      style={{ top: top + 8 }}
    >
      <div className="flex items-center gap-1.5 border-b px-2.5 py-1.5">
        <HugeiconsIcon
          icon={SparklesIcon}
          size={12}
          strokeWidth={1.75}
          className="text-muted-foreground"
        />
        <span className="text-[11px] font-medium">AI 错误解释</span>
        <span className="flex-1" />
        {status === "done" && (
          <>
            <Button
              variant="ghost"
              size="icon"
              className="size-5"
              title="复制解释"
              onClick={copy}
            >
              <HugeiconsIcon icon={Copy01Icon} size={12} strokeWidth={1.75} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-5"
              title="在 AI 面板继续问"
              onClick={openInChat}
            >
              <HugeiconsIcon
                icon={SparklesIcon}
                size={12}
                strokeWidth={1.75}
              />
            </Button>
          </>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-5"
          title="关闭"
          onClick={close}
        >
          <HugeiconsIcon icon={Cancel01Icon} size={12} strokeWidth={1.75} />
        </Button>
      </div>
      <div className="max-h-56 overflow-y-auto px-2.5 py-2">
        {status === "streaming" && !text && (
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <span className="size-1.5 animate-pulse rounded-full bg-muted-foreground" />
            正在分析错误…
          </div>
        )}
        {status === "error" && (
          <div className="text-[11px] text-destructive">
            {error ?? "AI 解释请求失败"}
          </div>
        )}
        <div
          className={cn(
            "whitespace-pre-wrap break-words text-xs leading-relaxed",
            status === "error" && !text && "hidden",
          )}
        >
          {text}
          {status === "streaming" && text && (
            <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-foreground/40 align-middle" />
          )}
        </div>
      </div>
    </div>
  );
}
