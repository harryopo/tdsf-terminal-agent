// TDSF 魔改 (P2 SSH 隧道, 方案书 v1.1 §四): 侧边栏 SSH 隧道面板
// -----------------------------------------------------------------------------
// 布局（侧边栏内嵌）:
//   ┌─────────────────────────────────────┐
//   │ 工具栏: Router 图标 + 标题 + 新建/刷新 │
//   ├─────────────────────────────────────┤
//   │ 无 SSH 会话 → 引导提示               │
//   │ 隧道列表（状态 badge + 端点映射）     │
//   │  - 空状态: 引导新建                  │
//   └─────────────────────────────────────┘
//
// 数据流:
//   - mount 时 store.refresh() 从 Rust tunnel_list 拉取
//   - 新建 → CreateTunnelDialog → store.startTunnel（成功后自动刷新）
//   - 停止 → store.stopTunnel（成功后自动刷新，不弹二次确认：
//     停止只是释放本地端口，SSH 断开时隧道也会自动清理）
//   - SSH 会话断开时 Rust 端自动清理所属隧道，刷新后列表同步

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useSshStore, isSessionConnected } from "@/modules/ssh-explorer";
import {
  PlusSignIcon,
  RefreshIcon,
  Router01Icon,
  StopIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { CreateTunnelDialog } from "./CreateTunnelDialog";
import { useTunnelsStore } from "./lib/tunnelStore";
import { TUNNEL_STATE_META, TUNNEL_TYPE_META, type Tunnel } from "./types";

interface Props {
  className?: string;
}

/** 端点映射展示（按隧道类型分支，P3 #24） */
function formatEndpoint(t: Tunnel): string {
  if (t.kind === "socks5") {
    return `SOCKS5 ${t.localHost}:${t.localPort}`;
  }
  if (t.kind === "remote") {
    // 服务器监听地址: bindAddress:实际端口（自动分配时用返回的 bindPort）
    const serverPort = t.bindPort ?? t.localPort;
    return `${t.bindAddress}:${serverPort} → ${t.localTargetHost ?? "?"}:${t.localTargetPort ?? "?"}`;
  }
  return `${t.localHost}:${t.localPort} → ${t.remoteHost}:${t.remotePort}`;
}

/** 创建时间短格式（HH:MM:SS） */
function formatCreatedAt(ts: number): string {
  try {
    return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
  } catch {
    return "";
  }
}

export function TunnelPanel({ className }: Props) {
  const tunnels = useTunnelsStore((s) => s.tunnels);
  const loaded = useTunnelsStore((s) => s.loaded);
  const busy = useTunnelsStore((s) => s.busy);
  const refresh = useTunnelsStore((s) => s.refresh);
  const stopTunnel = useTunnelsStore((s) => s.stopTunnel);

  const sessions = useSshStore((s) => s.sessions);
  const connectedCount = useMemo(
    () => sessions.filter(isSessionConnected).length,
    [sessions],
  );

  const [createOpen, setCreateOpen] = useState(false);

  // mount 时拉取隧道列表（仅首次）
  useEffect(() => {
    if (!loaded) void refresh();
  }, [loaded, refresh]);

  const handleStop = useCallback(
    async (t: Tunnel) => {
      const result = await stopTunnel(t.id);
      if (result.ok) {
        toast.success(`隧道「${t.name}」已停止`);
      } else {
        toast.error(result.error ?? "停止隧道失败");
      }
    },
    [stopTunnel],
  );

  const hasSshSession = connectedCount > 0;

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col bg-card text-foreground",
        className,
      )}
      data-testid="tunnel-panel"
    >
      {/* === 工具栏 === */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border/60 px-2">
        <HugeiconsIcon
          icon={Router01Icon}
          size={14}
          strokeWidth={1.75}
          className="shrink-0 text-primary"
        />
        <span className="flex-1 truncate text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
          SSH 隧道
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="刷新隧道列表"
          title="刷新"
          onClick={() => void refresh()}
          disabled={busy}
        >
          <HugeiconsIcon icon={RefreshIcon} size={13} strokeWidth={1.75} />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="新建隧道"
          title="新建隧道"
          onClick={() => setCreateOpen(true)}
          disabled={!hasSshSession}
        >
          <HugeiconsIcon icon={PlusSignIcon} size={13} strokeWidth={1.75} />
        </Button>
      </div>

      {/* === 主体: 隧道列表 / 引导 / 空状态 === */}
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {!hasSshSession ? (
          <NoSshSessionHint />
        ) : tunnels.length === 0 ? (
          <EmptyState onCreate={() => setCreateOpen(true)} />
        ) : (
          <div className="flex flex-col gap-1.5">
            {tunnels.map((t) => (
              <TunnelRow key={t.id} tunnel={t} onStop={() => void handleStop(t)} />
            ))}
          </div>
        )}
      </div>

      {/* === 新建隧道对话框 === */}
      <CreateTunnelDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

// === 子组件: 隧道行 =========================================================

function TunnelRow({
  tunnel,
  onStop,
}: {
  tunnel: Tunnel;
  onStop: () => void;
}) {
  const meta = TUNNEL_STATE_META[tunnel.state];
  const typeMeta = TUNNEL_TYPE_META[tunnel.kind];
  const stopping = tunnel.state === "stopping" || tunnel.state === "stopped";

  return (
    <div
      className="group relative rounded-md border border-border/50 bg-background/60 px-2.5 py-2 transition-colors hover:border-border hover:bg-muted/40"
      data-testid={`tunnel-row-${tunnel.id}`}
    >
      {/* 第一行: 名称 + 类型 badge + 状态 badge */}
      <div className="flex items-center gap-1.5">
        <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
          {tunnel.name}
        </span>
        <span
          className={cn(
            "inline-flex shrink-0 items-center rounded-full border px-1.5 py-px text-[9.5px] font-medium",
            typeMeta.badgeClass,
          )}
          title={typeMeta.hint}
          data-testid={`tunnel-kind-${tunnel.id}`}
        >
          {typeMeta.label}
        </span>
        <span
          className={cn(
            "inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-px text-[9.5px] font-medium",
            meta.badgeClass,
          )}
          data-testid={`tunnel-state-${tunnel.id}`}
        >
          <span className={cn("h-1.5 w-1.5 rounded-full", meta.dotClass)} />
          {meta.label}
        </span>
      </div>

      {/* 第二行: 端点映射（mono） */}
      <p className="mt-1 truncate font-mono text-[10.5px] leading-relaxed text-muted-foreground/85">
        {formatEndpoint(tunnel)}
      </p>

      {/* 第三行: 连接数 + 创建时间 + hover 停止按钮 */}
      <div className="mt-1.5 flex items-center gap-2 text-[10px] text-muted-foreground/70">
        <span className="tabular-nums">
          连接 {tunnel.connections}
        </span>
        <span className="tabular-nums">建于 {formatCreatedAt(tunnel.createdAt)}</span>
        <span className="flex-1" />
        {!stopping && (
          <button
            type="button"
            title="停止隧道"
            aria-label="停止隧道"
            onClick={onStop}
            className="hidden h-5 w-5 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive group-hover:flex"
            data-testid={`tunnel-stop-${tunnel.id}`}
          >
            <HugeiconsIcon icon={StopIcon} size={12} strokeWidth={1.75} />
          </button>
        )}
      </div>
    </div>
  );
}

// === 子组件: 无 SSH 会话提示 =================================================

function NoSshSessionHint() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      <HugeiconsIcon
        icon={Router01Icon}
        size={28}
        strokeWidth={1.5}
        className="text-muted-foreground/40"
      />
      <div className="space-y-1">
        <p className="text-[12px] font-medium text-foreground">
          需要 SSH 会话
        </p>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          先连接一台 SSH 服务器（右侧工作区「连接 SSH
          服务器」），即可通过隧道访问其内网服务（如数据库）。
        </p>
      </div>
    </div>
  );
}

// === 子组件: 空状态 =========================================================

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 py-8 text-center">
      <HugeiconsIcon
        icon={Router01Icon}
        size={28}
        strokeWidth={1.5}
        className="text-muted-foreground/40"
      />
      <div className="space-y-1">
        <p className="text-[12px] font-medium text-foreground">
          还没有隧道
        </p>
        <p className="text-[11px] text-muted-foreground">
          本地端口转发：免 VPN 访问跳板机内网服务
        </p>
      </div>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={onCreate}
        className="gap-1.5 text-[11px]"
      >
        <HugeiconsIcon icon={PlusSignIcon} size={11} strokeWidth={1.75} />
        新建隧道
      </Button>
    </div>
  );
}
