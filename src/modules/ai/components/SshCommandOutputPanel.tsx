import {
  onSshCommandOutput,
  type SshCommandOutputEvent,
} from "@/lib/sidecar-bridge";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";
import { useChatStore } from "../store/chatStore";

const MAX_VISIBLE_OUTPUT = 65_536;

type LiveCommand = SshCommandOutputEvent & {
  key: string;
  output: string;
};

function commandKey(event: SshCommandOutputEvent): string {
  return (
    event.operationId ??
    `${event.sshSessionId}:${event.toolName}:${event.command}`
  );
}

function appendOutput(current: string, chunk: string): string {
  const combined = current + chunk;
  return combined.length <= MAX_VISIBLE_OUTPUT
    ? combined
    : combined.slice(-MAX_VISIBLE_OUTPUT);
}

export function SshCommandOutputPanel() {
  const sessionId = useChatStore((state) => state.activeSessionId);
  const [live, setLive] = useState<LiveCommand | null>(null);

  useEffect(() => {
    setLive(null);
    let disposed = false;
    let unlisten = () => {};

    void onSshCommandOutput((event) => {
      if (disposed) return;
      if (
        event.conversationSessionId &&
        event.conversationSessionId !== sessionId
      ) {
        return;
      }

      const key = commandKey(event);
      setLive((current) => {
        const isStart = event.status === "running" && event.stream === "status";
        const output =
          !current || current.key !== key || isStart
            ? event.chunk
            : appendOutput(current.output, event.chunk);
        return { ...event, key, output };
      });
    }).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });

    return () => {
      disposed = true;
      unlisten();
    };
  }, [sessionId]);

  if (!live) return null;

  const completed = live.status === "completed";
  const failed = live.status === "failed";
  const label = completed ? "已完成" : failed ? "执行失败" : "实时执行中";

  return (
    <section
      aria-label="SSH 命令实时输出"
      className="overflow-hidden rounded-md border border-border/50 bg-card/60"
    >
      <header className="flex items-center gap-2 border-b border-border/40 px-2.5 py-1.5 text-[11px]">
        <span
          aria-hidden="true"
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            completed && "bg-emerald-500",
            failed && "bg-destructive",
            !completed && !failed && "animate-pulse bg-sky-500",
          )}
        />
        <span className="font-medium text-foreground">SSH Output</span>
        <code className="min-w-0 flex-1 truncate text-muted-foreground">
          {live.command}
        </code>
        <span
          className={cn(
            "shrink-0",
            completed && "text-emerald-600 dark:text-emerald-400",
            failed && "text-destructive",
            !completed && !failed && "text-sky-600 dark:text-sky-400",
          )}
        >
          {label}
        </span>
      </header>
      <pre
        aria-live="polite"
        className="max-h-56 overflow-auto whitespace-pre-wrap break-all px-2.5 py-2 font-mono text-[11px] leading-relaxed text-foreground/90"
      >
        {live.output ||
          (live.status === "running" ? "等待远端输出…" : "（无输出）")}
      </pre>
    </section>
  );
}
