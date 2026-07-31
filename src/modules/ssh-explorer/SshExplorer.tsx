// TDSF 魔改 (P4-T4.1): SSH 连接管理面板
// -----------------------------------------------------------------------------
// 仅负责 SSH 连接管理: 新建连接 / 会话切换 / 断开 / 主机审批 (TOFU)。
// 文件资源管理器已合并到左侧 FileExplorer (source="ssh" 模式),
// 不再在 SshExplorer 内显示文件树/编辑器/传输任务。
//
// 布局 (侧边栏内嵌):
//   ┌─────────────────────────────────────┐
//   │ 工具栏: [+ 连接]                     │
//   ├─────────────────────────────────────┤
//   │ 服务器切换器 (Popover)               │
//   ├─────────────────────────────────────┤
//   │ 连接状态 / 空状态提示                │
//   └─────────────────────────────────────┘
//
// 主机审批: 当 Rust 端 check_server_key 推送 ssh:host_verify 事件时,
// 设置 pendingApproval, 弹出 AlertDialog 询问用户是否信任。

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Separator } from "@/components/ui/separator";
import {
  type HostApprovalRequest,
  subscribeHostKeyMismatch,
  subscribeHostVerify,
} from "@/lib/ssh-bridge";
import { cn } from "@/lib/utils";
import {
  Add01Icon,
  AlertCircleIcon,
  ArrowDown01Icon,
  Cancel01Icon,
  CloudServerIcon,
  ComputerIcon,
  Loading03Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { generateRandomArt } from "./randomart";
import { SshConnectDialog } from "./SshConnectDialog";
import { SshStatusDot, stateLabel } from "./SshStatusDot";
import type { SshSessionInfo } from "./sshStore";
import {
  isSessionConnected,
  selectActiveSession,
  useSshStore,
} from "./sshStore";

// TDSF 魔改 2026-07-29: 文件资源管理器已合并到 FileExplorer,
// SshExplorer 只保留连接管理, 不再引用 SshFileTree/SshFileEditor/SshFileTransfer.

type Props = {
  /** 父容器 className (SshExplorer 自动填充) */
  className?: string;
};

export function SshExplorer({ className }: Props) {
  const sessions = useSshStore((s) => s.sessions);
  const activeSessionId = useSshStore((s) => s.activeSessionId);
  const connectDialogOpen = useSshStore((s) => s.connectDialogOpen);
  const openConnectDialog = useSshStore((s) => s.openConnectDialog);
  const closeConnectDialog = useSshStore((s) => s.closeConnectDialog);
  const setActiveSession = useSshStore((s) => s.setActiveSession);
  const disconnect = useSshStore((s) => s.disconnect);
  const pendingApproval = useSshStore((s) => s.pendingApproval);
  const resolveApproval = useSshStore((s) => s.resolveApproval);

  // === 主机审批事件订阅 ===
  useEffect(() => {
    const off1 = subscribeHostVerify((req) => {
      useSshStore.setState({ pendingApproval: req });
    });
    const off2 = subscribeHostKeyMismatch((req) => {
      useSshStore.setState({ pendingApproval: req });
    });
    return () => {
      off1();
      off2();
    };
  }, []);

  // === TDSF 魔改 2026-07-28 (P1-C): 自动登录逻辑已提升到 App.tsx 顶层 ===
  // ---------------------------------------------------------------
  // 原 useEffect 在此组件挂载时触发自动登录, 但 SshExplorer 只在 sidebarView === "ssh"
  // 时挂载, 应用启动默认视图是 "explorer", 导致自动登录不执行.
  // 修复: 自动登录 useEffect 已移到 App.tsx, launchCwdResolved 后即触发, 不依赖本组件挂载.
  // 此处保留空注释位, 避免破坏代码结构.

  const activeSession = useSshStore(selectActiveSession);

  const handleDisconnect = useCallback(
    async (id: string) => {
      try {
        await disconnect(id);
        toast.success("SSH 会话已断开");
      } catch (e) {
        toast.error("断开失败", {
          description: e instanceof Error ? e.message : String(e),
        });
      }
    },
    [disconnect],
  );

  const handleApprove = useCallback(async () => {
    await resolveApproval(true);
  }, [resolveApproval]);

  const handleReject = useCallback(async () => {
    await resolveApproval(false);
    toast.warning("已拒绝主机, 连接将中止");
  }, [resolveApproval]);

  return (
    <div
      className={cn(
        "flex h-full min-h-0 flex-col bg-card text-foreground",
        className,
      )}
    >
      {/* === 工具栏 === */}
      <div className="flex h-9 shrink-0 items-center gap-1.5 border-b border-border/60 px-2">
        <HugeiconsIcon
          icon={CloudServerIcon}
          size={14}
          strokeWidth={1.75}
          className="shrink-0 text-primary"
        />
        <span className="flex-1 truncate text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
          SSH 远程
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="新建 SSH 连接"
          title="新建连接"
          onClick={openConnectDialog}
        >
          <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
        </Button>
      </div>

      {/* === 服务器切换器 (弹窗式) =============================================
          TDSF 魔改 2026-07-29: 改横向 session tabs 为下拉弹窗。
          原因: 多服务器时横向 tab 会撑爆侧栏, 断开/关闭按钮 (右侧 X) 被遮。
          现在用一个紧凑的"当前服务器"按钮, 点击弹 Popover 列出所有
          session + 新建连接 + 断开按钮, 永远不会被遮挡。
          ==================================================================== */}
      {sessions.length > 0 ? (
        <SshSessionSwitcher
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelect={setActiveSession}
          onDisconnect={handleDisconnect}
          onNewConnection={openConnectDialog}
        />
      ) : null}

      {/* === 主体: 连接状态 / 空状态提示
          ---------------------------------------------------------------
          TDSF 魔改 2026-07-29: 文件资源管理器已合并到 FileExplorer,
          SshExplorer 仅作为连接管理面板。连接成功后用户会被自动带回
          explorer 视图, 左侧 FileExplorer 以 source="ssh" 显示远程文件。 === */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {activeSession ? (
          isSessionConnected(activeSession) ? (
            // TDSF 魔改 2026-07-31: 已连接状态不再显示居中大卡片
            // 原因: 该卡片在深色/浅色主题下形成明显色块, 与整体风格冲突;
            // 当前连接信息已在顶部 SessionSwitcher 和底部 StatusBar 展示, 无需重复。
            null
          ) : (
            <SessionStatusView session={activeSession} />
          )
        ) : (
          <EmptyState onConnect={openConnectDialog} />
        )}
      </div>

      {/* === 连接对话框 === */}
      <SshConnectDialog
        open={connectDialogOpen}
        onOpenChange={(v) => (v ? openConnectDialog() : closeConnectDialog())}
      />

      {/* === 主机审批对话框 (TOFU) === */}
      <HostApprovalDialog
        request={pendingApproval}
        onApprove={handleApprove}
        onReject={handleReject}
      />
    </div>
  );
}

// === 子组件: 服务器切换器 (弹窗式) =============================================
// TDSF 魔改 2026-07-29: 取代原横向 session tabs。
//
// 触发器: 一行紧凑的"当前服务器"按钮 (左侧状态点 + user@host + 下拉箭头)。
// 弹窗: 列出所有 session, 每行有: 状态点 + 完整 user@host:port + 状态文本 +
//        断开按钮 (右上角 X, hover 显现, 不会被遮挡)。
// 弹窗底部: "新建连接" 按钮 (打开 SshConnectDialog)。
// 优点: 永远不会被遮挡, 多服务器时也不撑爆侧栏。

function SshSessionSwitcher({
  sessions,
  activeSessionId,
  onSelect,
  onDisconnect,
  onNewConnection,
}: {
  sessions: SshSessionInfo[];
  activeSessionId: string | null;
  onSelect: (id: string) => void;
  onDisconnect: (id: string) => Promise<void>;
  onNewConnection: () => void;
}) {
  const active = sessions.find((s) => s.id === activeSessionId) ?? sessions[0];
  const [open, setOpen] = useState(false);

  return (
    <div className="shrink-0 border-b border-border/40 bg-card/50 px-1.5 py-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[12px] transition-colors",
              "hover:bg-accent/60",
              "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            )}
            title={
              active
                ? `${active.params.user}@${active.params.host}:${active.params.port ?? 22}\n状态: ${stateLabel(active.state)}${active.error ? `\n错误: ${active.error}` : ""}\n\n点击切换服务器`
                : "切换服务器"
            }
          >
            {active ? (
              <>
                <SshStatusDot state={active.state} />
                <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                  {active.params.user}@{active.params.host}
                </span>
                {sessions.length > 1 && (
                  <span className="shrink-0 rounded bg-primary/15 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-primary">
                    {sessions.length}
                  </span>
                )}
              </>
            ) : (
              <span className="text-muted-foreground">无服务器</span>
            )}
            <HugeiconsIcon
              icon={ArrowDown01Icon}
              size={12}
              strokeWidth={1.75}
              className="shrink-0 text-muted-foreground"
            />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" sideOffset={4} className="w-[280px] p-0">
          <div className="px-2.5 py-1.5 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
            SSH 服务器 ({sessions.length})
          </div>
          <Separator />
          <div className="max-h-[280px] overflow-y-auto py-1">
            {sessions.map((sess) => {
              const isActive = sess.id === activeSessionId;
              return (
                <div
                  key={sess.id}
                  className={cn(
                    "group flex items-center gap-1.5 px-1.5 py-1.5 text-[12px]",
                    isActive ? "bg-primary/10" : "hover:bg-accent/60",
                  )}
                >
                  <button
                    type="button"
                    onClick={() => {
                      onSelect(sess.id);
                      setOpen(false);
                    }}
                    className="flex min-w-0 flex-1 items-center gap-1.5 rounded text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    title={`${sess.params.user}@${sess.params.host}:${sess.params.port ?? 22}\n状态: ${stateLabel(sess.state)}${sess.error ? `\n错误: ${sess.error}` : ""}`}
                  >
                    <SshStatusDot state={sess.state} />
                    <HugeiconsIcon
                      icon={ComputerIcon}
                      size={12}
                      strokeWidth={1.75}
                      className={cn(
                        "shrink-0",
                        isActive ? "text-primary" : "text-muted-foreground",
                      )}
                    />
                    <div className="min-w-0 flex-1">
                      <div
                        className={cn(
                          "truncate font-medium",
                          isActive ? "text-foreground" : "text-foreground/85",
                        )}
                      >
                        {sess.params.user}@{sess.params.host}
                      </div>
                      <div className="truncate text-[10px] text-muted-foreground">
                        :{sess.params.port ?? 22} · {stateLabel(sess.state)}
                      </div>
                    </div>
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void onDisconnect(sess.id);
                      // 断开当前活跃时关闭弹窗, 否则保留以便切其他
                      if (sess.id === activeSessionId) setOpen(false);
                    }}
                    className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/15 hover:text-destructive group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none"
                    aria-label={`断开 ${sess.params.user}@${sess.params.host}`}
                    title="断开连接"
                  >
                    <HugeiconsIcon
                      icon={Cancel01Icon}
                      size={11}
                      strokeWidth={1.75}
                    />
                  </button>
                </div>
              );
            })}
          </div>
          <Separator />
          <div className="p-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full justify-start"
              onClick={() => {
                setOpen(false);
                onNewConnection();
              }}
            >
              <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
              新建连接
            </Button>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

// === 子组件: 空状态 =========================================================

function EmptyState({ onConnect }: { onConnect: () => void }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-8 text-center">
      <HugeiconsIcon
        icon={CloudServerIcon}
        size={32}
        strokeWidth={1.5}
        className="text-muted-foreground/40"
      />
      <div className="space-y-1">
        <p className="text-[13px] font-medium text-foreground">
          还没有 SSH 连接
        </p>
        <p className="text-[11px] text-muted-foreground">
          连接 Linux 服务器, 左侧 Files 面板将显示远程文件
        </p>
      </div>
      <Button type="button" size="sm" onClick={onConnect}>
        <HugeiconsIcon icon={Add01Icon} size={12} strokeWidth={1.75} />
        新建连接
      </Button>
    </div>
  );
}

// === 子组件: 会话状态视图 (连接中/失败等) ====================================

function SessionStatusView({
  session,
}: {
  session: ReturnType<typeof selectActiveSession>;
}) {
  if (!session) return null;

  const isBusy = [
    "connecting",
    "handshaking",
    "host_verifying",
    "authenticating",
    "reconnecting",
  ].includes(session.state);

  const isFailed = session.state === "failed";

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 py-8 text-center">
      {isBusy ? (
        <HugeiconsIcon
          icon={Loading03Icon}
          size={28}
          strokeWidth={1.5}
          className="animate-spin text-primary"
        />
      ) : isFailed ? (
        <HugeiconsIcon
          icon={AlertCircleIcon}
          size={28}
          strokeWidth={1.5}
          className="text-destructive"
        />
      ) : (
        <SshStatusDot state={session.state} className="size-3" />
      )}
      <div className="space-y-1">
        <p className="text-[13px] font-medium text-foreground">
          {session.params.user}@{session.params.host}
        </p>
        {/* TDSF 魔改: busy 状态文案追加 '...' 后缀, 视觉上更明确表示"正在进行中" */}
        <p className="text-[11px] text-muted-foreground">
          {stateLabel(session.state)}
          {isBusy ? "..." : ""}
        </p>
        {session.error && (
          <p className="mx-auto max-w-[240px] rounded-md bg-destructive/10 px-2 py-1 text-[11px] text-destructive">
            {session.error}
          </p>
        )}
      </div>
    </div>
  );
}

// === 子组件: 主机审批对话框 (TOFU) ===========================================

function HostApprovalDialog({
  request,
  onApprove,
  onReject,
}: {
  request: HostApprovalRequest | null;
  onApprove: () => Promise<void>;
  onReject: () => Promise<void>;
}) {
  const [handling, setHandling] = useState(false);

  const handle = (fn: () => Promise<void>) => async () => {
    setHandling(true);
    try {
      await fn();
    } finally {
      setHandling(false);
    }
  };

  return (
    <AlertDialog open={request !== null}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {request?.isMismatch ? "⚠ 主机密钥已变更" : "未知主机 (首次连接)"}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p>
                {request?.isMismatch
                  ? "已知主机的密钥与本地记录不一致, 可能存在中间人攻击。请仔细核对指纹后再决定是否继续。"
                  : "首次连接此主机, 请核对服务器 SSH 指纹, 确认无误后信任该主机 (TOFU 策略)。"}
              </p>
              {/* TDSF 魔改 (P2-1 修复 2026-07-28): OpenSSH 艺术指纹
                  在用户首次连接时, 用 randomart 直观展示密钥指纹.
                  算法来自 OpenSSH ssh-keygen -lv (Drijvers et al. 2012 "Hedgehog"). */}
              {request?.fingerprint ? (
                <pre
                  className="overflow-x-auto rounded-md border border-border/40 bg-muted/40 px-2.5 py-1.5 font-mono text-[10px] leading-tight text-foreground/80"
                  data-testid="ssh-host-randomart"
                  role="img"
                  aria-label="OpenSSH 艺术指纹"
                >
                  {generateRandomArt(
                    request.fingerprint,
                    request.keyType ?? "ssh-ed25519",
                  )}
                </pre>
              ) : null}
              <div className="rounded-md bg-muted/60 px-2.5 py-1.5 font-mono text-[11px]">
                <div>
                  <span className="text-muted-foreground">主机: </span>
                  {request?.host}:{request?.port}
                </div>
                <div>
                  <span className="text-muted-foreground">算法: </span>
                  {request?.keyType}
                </div>
                <div className="break-all">
                  <span className="text-muted-foreground">指纹: </span>
                  {request?.fingerprint}
                </div>
              </div>
              {/* TDSF 魔改 (P2-1 修复 2026-07-28): 引导用户验证指纹
                  提示用户通过 ssh-keygen -lf /etc/ssh/ssh_host_*_key.pub 在服务器核对
                  或与管理员确认. 这是 TOFU 策略的最后一道安全防线. */}
              <p className="text-[10.5px] text-muted-foreground">
                验证方法: 在服务器执行{" "}
                <code className="rounded bg-muted px-1 py-0.5 font-mono text-[10px]">
                  ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
                </code>{" "}
                (或 ssh-rsa), 比对指纹是否一致。
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            disabled={handling}
            onClick={() => void handle(onReject)}
          >
            拒绝
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={handling}
            onClick={() => void handle(onApprove)}
            className={cn(
              request?.isMismatch
                ? "bg-destructive text-destructive-foreground hover:bg-destructive/80"
                : "",
            )}
          >
            信任并连接
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
