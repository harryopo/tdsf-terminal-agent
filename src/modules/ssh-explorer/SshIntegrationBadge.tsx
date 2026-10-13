import { useEffect, useRef, useState } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getSshIntegrationContext, restoreSshIntegration } from "@/modules/terminal/lib/useTerminalSession";
import type { ShellReceipt } from "@/modules/terminal/lib/remoteShellIntegration";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useSshStore } from "./sshStore";

export function SshIntegrationBadge({ leafId, sessionId, active }: {
  leafId: number;
  sessionId: string;
  active: boolean;
}) {
  const session = useSshStore((s) => s.sessions.find((item) => item.id === sessionId));
  const zoomLevel = usePreferencesStore((s) => s.zoomLevel);
  const badgeSize = Math.max(24, Math.ceil(24 / zoomLevel));
  const [open, setOpen] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ShellReceipt | null>(null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => {
    setOpen(false);
    setConfirmed(false);
    setWaiting(false);
    setError(null);
    setReceipt(null);
    return () => {
      pending.current?.abort();
      pending.current = null;
    };
  }, [active, leafId, sessionId, session?.state]);

  if (!active || session?.state !== "connected") return null;
  const context = getSshIntegrationContext(leafId);
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) {
      pending.current?.abort();
      pending.current = null;
      setWaiting(false);
      setConfirmed(false);
    }
  };
  const restore = () => {
    if (!confirmed || !context?.bashHooksPath || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setWaiting(true);
    setError(null);
    setReceipt(null);
    void restoreSshIntegration(leafId, context.connectionId, controller.signal).then(
      (result) => {
        if (!controller.signal.aborted) setReceipt(result);
      },
      (reason: unknown) => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? `恢复未确认：${reason.message}` : "恢复未确认，请查看终端。");
      },
    ).finally(() => {
      if (pending.current === controller) {
        pending.current = null;
        setWaiting(false);
      }
    });
  };
  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <button type="button" title="终端集成" aria-label="终端集成"
          style={{ width: badgeSize, height: badgeSize, right: badgeSize + 16 }}
          className="group absolute bottom-2 z-10 grid place-items-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onMouseDown={(event) => event.stopPropagation()}>
          <span className="grid size-full place-items-center rounded-full border border-border bg-background text-muted-foreground shadow-sm transition-colors group-hover:bg-accent group-hover:text-foreground">
            <HugeiconsIcon icon={Refresh01Icon} size={13} strokeWidth={1.75} />
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-[min(360px,calc(100vw-24px))] gap-3 rounded-2xl p-4 text-xs motion-reduce:animate-none">
        <div>
          <h2 className="text-sm font-medium">终端集成</h2>
          <p className="mt-1 leading-relaxed text-muted-foreground">切换用户后，手动恢复目录跟随和命令记录。</p>
        </div>
        <div className="rounded-lg border border-border/60 px-3 py-2">
          <div className="text-muted-foreground">文件与后台工具仍使用原 SSH 认证身份</div>
          <div className="mt-1 break-all font-mono">{session.params.user}@{session.params.host}</div>
          {receipt ? <div className="mt-2 border-t border-border/50 pt-2">最近确认的 shell 用户：<span className="font-mono">{receipt.user}</span></div> : null}
        </div>
        <p className="leading-relaxed text-muted-foreground">仅加载当前连接已有的临时 Bash hooks，不改配置文件。嵌套 SSH 请创建独立连接，不能在这里恢复。</p>
        <label className="flex items-start gap-2 leading-relaxed">
          <input type="checkbox" checked={confirmed} disabled={waiting}
            className="mt-0.5 size-4 shrink-0 accent-current"
            onChange={(event) => setConfirmed(event.currentTarget.checked)} />
          我已完成登录，当前是同一服务器的空闲 Bash 提示符，且没有未提交输入
        </label>
        {!context?.bashHooksPath ? <p className="text-muted-foreground">当前连接尚未提供可恢复的 Bash 集成文件。</p> : null}
        <div aria-live="polite" className="break-words leading-relaxed">
          {waiting ? "等待终端回执…" : error ?? (receipt ? "终端集成已恢复，目录跟随和命令记录已重新连接。" : "写入成功不等于恢复成功，需等待本次真实回执。")}
        </div>
        <button type="button" disabled={!confirmed || !context?.bashHooksPath || waiting}
          onClick={restore}
          className="h-8 rounded-lg border border-border bg-foreground px-3 font-medium text-background transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40">
          恢复当前终端集成
        </button>
      </PopoverContent>
    </Popover>
  );
}
