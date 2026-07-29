// TDSF 魔改 (2026-07-28 P1-A): 未连接 SSH 且只有默认空 shell tab 时的占位页
// -----------------------------------------------------------------------------
// 需求: 用户在没连 SSH 之前, 右侧不应该显示一个空荡荡的 shell tab + 终端黑屏.
// 改为显示一个 "快速开始" 引导页, 给出两个动作:
//   1. 连接 SSH (主按钮, 自动切到 SSH 资源管理器面板 + 弹 SshConnectDialog)
//   2. 打开本地终端 (次按钮, 强行把默认 cold tab 变 warm, 启动本地 shell)
//
// 设计: 居中, 浅色背景, 灰色 logo 顶部, 标题 + 副标题 + 两个按钮.
// 不使用 AI 味渐变色, 不使用 emoji.

import { Button } from "@/components/ui/button";
import { useSshStore } from "@/modules/ssh-explorer/sshStore";
import {
  AiMagicIcon,
  CloudServerIcon,
  ComputerTerminal01Icon,
  FolderOpenIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMemo } from "react";
import { toast } from "sonner";

type Props = {
  /** 默认冷启动 tab 的 id (通常为 1) */
  defaultTabId: number;
  /** 强行 warm 冷 tab (从 App.tsx 传入, 因为 useTabs 是 hook 不是 store) */
  onWarmUp: (tabId: number) => void;
  /** 唤起 AI Agent 面板 */
  onOpenAgent: () => void;
  /**
   * 切换侧栏到 "ssh" 视图 (从 App.tsx 传入 persistSidebarView).
   * 不能在本组件直接调用 useSidebarPanel(), 因为 hook 实例 state 隔离,
   * 而 App.tsx 才是 sidebarView 的 single source of truth.
   */
  onSwitchToSsh: () => void;
};

export function NoTerminalEmptyState({
  defaultTabId,
  onWarmUp,
  onOpenAgent,
  onSwitchToSsh,
}: Props) {
  const openConnectDialog = useSshStore((s) => s.openConnectDialog);
  const hasSshSession = useSshStore((s) => s.sessions.length > 0);

  // 副标题文案
  const summary = useMemo(() => {
    if (hasSshSession) {
      return "已建立 SSH 会话, 可在左侧资源管理器中浏览远程文件.";
    }
    return "未连接 SSH 服务器, 终端保持空白以避免空跑 shell.";
  }, [hasSshSession]);

  // 处理"连接 SSH"按钮: 切到 SSH 面板 + 弹连接对话框
  const handleConnectSsh = () => {
    onSwitchToSsh();
    openConnectDialog();
  };

  // 处理"打开本地终端"按钮: 强制把默认 cold tab 变 warm, 启动本地 shell
  const handleOpenLocal = () => {
    onWarmUp(defaultTabId);
    toast.success("正在启动本地 shell", {
      description: "首次启动可能需要 1-2 秒, 请稍候",
      duration: 1500,
    });
  };

  return (
    <div
      data-testid="no-terminal-empty-state"
      className="flex h-full min-h-0 items-center justify-center bg-background"
    >
      <div className="flex w-full max-w-[440px] flex-col items-center px-6 py-10 text-center">
        {/* 顶部: 灰色 logo + 标题 */}
        <div className="mb-5 flex flex-col items-center gap-3">
          <div className="flex size-14 items-center justify-center rounded-2xl border border-border/50 bg-card/80 shadow-[inset_0_1px_0_0_color-mix(in_srgb,var(--color-foreground)_6%,transparent)]">
            <HugeiconsIcon
              icon={ComputerTerminal01Icon}
              size={26}
              strokeWidth={1.5}
              className="text-muted-foreground"
            />
          </div>
          <div className="space-y-1">
            <h2 className="text-[15px] font-semibold tracking-tight text-foreground">
              欢迎使用 TDSF 终端
            </h2>
            <p className="text-[11.5px] leading-relaxed text-muted-foreground">
              {summary}
            </p>
          </div>
        </div>

        {/* 主操作区: 连接 SSH (主按钮) + 打开本地终端 (次按钮) */}
        <div className="w-full space-y-2">
          <Button
            type="button"
            size="default"
            variant="default"
            onClick={handleConnectSsh}
            className="h-9 w-full justify-center gap-2 text-[12px] font-medium"
            data-testid="empty-state-connect-ssh"
          >
            <HugeiconsIcon
              icon={CloudServerIcon}
              size={14}
              strokeWidth={1.75}
            />
            连接 SSH 服务器
          </Button>

          <Button
            type="button"
            size="default"
            variant="outline"
            onClick={handleOpenLocal}
            className="h-9 w-full justify-center gap-2 text-[12px] font-medium"
            data-testid="empty-state-open-local"
          >
            <HugeiconsIcon
              icon={FolderOpenIcon}
              size={14}
              strokeWidth={1.75}
            />
            打开本地终端
          </Button>
        </div>

        {/* 辅助操作: 唤起 AI Agent */}
        <div className="mt-4 w-full">
          <button
            type="button"
            onClick={onOpenAgent}
            className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground/80 transition-colors hover:text-foreground"
            data-testid="empty-state-open-agent"
          >
            <HugeiconsIcon icon={AiMagicIcon} size={11} strokeWidth={1.75} />
            或者, 让 AI Agent 帮你完成工作
          </button>
        </div>

        {/* 底部提示: 风险拦截说明 */}
        <p className="mt-6 text-[10px] leading-relaxed text-muted-foreground/60">
          高危命令 (rm -rf /, mkfs, dd of=/dev/...) 会被自动拦截, 需人工审批.
        </p>
      </div>
    </div>
  );
}
