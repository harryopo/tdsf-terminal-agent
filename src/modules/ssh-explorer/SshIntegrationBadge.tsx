import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Refresh01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { getSshIntegrationContext, refreshSshIntegrationContext, restoreSshIntegration, subscribeSshIntegrationContext } from "@/modules/terminal/lib/useTerminalSession";
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
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<ShellReceipt | null>(null);
  const pending = useRef<AbortController | null>(null);
  const [checking, setChecking] = useState(false);
  const [checkError, setCheckError] = useState<string | null>(null);
  const checkController = useRef<AbortController | null>(null);
  const checkTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const subscribe = useCallback((cb: () => void) => subscribeSshIntegrationContext(leafId, cb), [leafId]);
  const snapshot = useCallback(() => getSshIntegrationContext(leafId), [leafId]);
  const context = useSyncExternalStore(subscribe, snapshot);
  const cancelCheck = useCallback(() => {
    checkController.current?.abort();
    checkController.current = null;
    if (checkTimer.current !== null) clearTimeout(checkTimer.current);
    checkTimer.current = null;
  }, []);
  useEffect(() => {
    setOpen(false);
    setWaiting(false);
    setError(null);
    setReceipt(null);
    setChecking(false);
    setCheckError(null);
    return () => {
      pending.current?.abort();
      pending.current = null;
      cancelCheck();
    };
  }, [active, leafId, sessionId, session?.state, session?.rustSessionId, session?.handle,
    session?.params.host, session?.params.port, session?.params.user, cancelCheck]);

  useEffect(() => {
    pending.current?.abort();
    pending.current = null;
    setWaiting(false);
    setError(null);
    setReceipt(null);
  }, [context?.connectionId, context?.bashHooksPath]);

  if (!active || session?.state !== "connected") return null;
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) {
      pending.current?.abort();
      pending.current = null;
      setWaiting(false);
      cancelCheck();
      setChecking(false);
      setCheckError(null);
    }
  };
  const recheck = () => {
    if (checkController.current || pending.current) return;
    const controller = new AbortController();
    checkController.current = controller;
    setChecking(true);
    setCheckError(null);
    setReceipt(null);
    setError(null);
    checkTimer.current = setTimeout(() => {
      if (checkController.current !== controller) return;
      // Only end the UI wait; the read-only RPC and SSH connection are untouched.
      cancelCheck();
      setChecking(false);
      setCheckError("检测未确认，可重试");
    }, 4000);
    void refreshSshIntegrationContext(leafId).then((result) => {
      if (!controller.signal.aborted && checkController.current === controller) {
        setCheckError(result ? null : "检测未确认，可重试");
      }
    }, () => {
      if (!controller.signal.aborted && checkController.current === controller) {
        setCheckError("检测未确认，可重试");
      }
    }).finally(() => {
      if (checkController.current === controller) {
        cancelCheck();
        setChecking(false);
      }
    });
  };
  const restore = () => {
    if (!context?.bashHooksPath || pending.current || checkController.current) return;
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
        <button type="button" title="恢复目录跟随" aria-label="恢复目录跟随"
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
          <h2 className="text-sm font-medium">恢复目录跟随</h2>
          <p className="mt-1 leading-relaxed text-muted-foreground">
            使用 su 切换用户后，新 shell 可能停止上报当前目录，文件树便不会继续跟随。
          </p>
        </div>
        <div className="rounded-lg bg-muted/40 px-3 py-2">
          <div className="text-muted-foreground">文件与后台工具仍使用原 SSH 认证身份</div>
          <div className="mt-1 break-all font-mono">{session.params.user}@{session.params.host}</div>
          {receipt ? <div className="mt-2 border-t border-border/50 pt-2">最近确认的 shell 用户：<span className="font-mono">{receipt.user}</span></div> : null}
        </div>
        <p className="leading-relaxed text-muted-foreground">
          请先完成登录，回到同一服务器的空闲 Bash 提示符；不要停留在密码输入、编辑器或尚未提交的命令中。
        </p>
        <button type="button" disabled={!context?.bashHooksPath || waiting || checking}
          onClick={restore}
          className="h-9 rounded-lg border border-border bg-foreground px-3 font-medium text-background transition-opacity hover:opacity-85 disabled:cursor-not-allowed disabled:opacity-40">
          已登录，恢复目录跟随
        </button>
        <div aria-live="polite" className="break-words leading-relaxed">
          {waiting ? "等待终端回执…" : error ?? (receipt ? "终端集成已恢复，目录跟随和命令记录已重新连接。" : null)}
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3">
          <p aria-live="polite" className="leading-relaxed text-muted-foreground">
            {checking ? "正在检测连接信息…" : checkError ?? (context
              ? context.bashHooksPath ? "连接信息已确认" : "当前连接不提供 Bash 集成文件"
              : "尚未获取有效连接信息")}
          </p>
          <button type="button" disabled={checking || waiting} aria-busy={checking}
            onClick={recheck}
            className="h-8 rounded-lg border border-border px-3 transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-40">
            重新检测连接信息
          </button>
        </div>
        <p className="leading-relaxed text-muted-foreground">
          只恢复本次终端的目录与命令上报，不修改服务器配置。若在终端中再次 SSH 到另一台服务器，请新建独立连接来浏览它的文件。
        </p>
      </PopoverContent>
    </Popover>
  );
}
