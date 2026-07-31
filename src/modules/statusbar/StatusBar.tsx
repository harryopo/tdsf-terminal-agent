import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useChatStore } from "@/modules/ai";
import { AgentStatusPill } from "@/modules/ai/components/AgentStatusPill";
import { BackendPill } from "@/modules/ai/components/BackendPill";
import { AiStatusBarControls } from "@/modules/ai/components/AiStatusBarControls";
import { MockLLMWarning } from "@/modules/ai/components/MockLLMWarning";
import { LspStatusPill } from "@/modules/lsp";
import type { WorkspaceEnv } from "@/modules/workspace";
import { IncognitoIcon, ServerStack03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { CwdBreadcrumb } from "./CwdBreadcrumb";
import { DiagnosticsBadge } from "./DiagnosticsBadge";
import { WorkspaceEnvSelector } from "./WorkspaceEnvSelector";

/**
 * TDSF 魔改 2026-07-30: SSH 已连接时显示服务器地址的 pill。
 *
 * 替代 WorkspaceEnvSelector (Windows/WSL 选择器)，让用户在 SSH 模式下
 * 右下角看到的是 "user@host:path" 而非 "Windows"。
 * 视觉风格与 WorkspaceEnvSelector 一致 (h-6, 11px, muted-foreground)，
 * 用 emerald 色调强调"已连接"状态。
 */
function SshLocationPill({ label }: { label: string }) {
  // label 格式: "user@host:/path" — 只显示 user@host 部分, path 由 CwdBreadcrumb 显示
  const hostPart = label.split(":")[0] ?? label;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className="flex h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 text-[11px] text-emerald-600 dark:text-emerald-400 outline-none"
          title="SSH 远程会话"
        >
          <HugeiconsIcon
            icon={ServerStack03Icon}
            size={13}
            strokeWidth={1.75}
          />
          <span className="max-w-40 truncate font-medium">{hostPart}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-72 text-[11px] leading-relaxed">
        <div className="font-medium text-emerald-600 dark:text-emerald-400">
          SSH 远程会话已连接
        </div>
        <div className="mt-0.5 text-muted-foreground">{label}</div>
        <div className="mt-1 text-[10px] text-muted-foreground/70">
          断开连接后此处恢复为本地环境选择器
        </div>
      </TooltipContent>
    </Tooltip>
  );
}

type Props = {
  cwd: string | null;
  filePath?: string | null;
  home: string | null;
  onCd: (path: string) => void;
  onWorkspaceChange: (env: WorkspaceEnv) => void;
  onOpenMini: () => void;
  /** Only rendered when the AI panel is open and a key is loaded. */
  hasComposer: boolean;
  privateActive: boolean;
  /**
   * TDSF 魔改 2026-07-30: SSH 已连接时显示的服务器位置标签。
   * 格式: "user@host" 或 "user@host:path"。非 null 时替代 WorkspaceEnvSelector。
   */
  sshLocation?: string | null;
};

export function StatusBar({
  cwd,
  filePath,
  home,
  onCd,
  onWorkspaceChange,
  onOpenMini,
  hasComposer,
  privateActive,
  sshLocation,
}: Props) {
  const panelOpen = useChatStore((s) => s.panelOpen);

  return (
    <footer
      data-testid="statusbar"
      className="flex h-8 shrink-0 items-center justify-between gap-3 border-t border-border/60 bg-card/60 pl-3 pr-4 text-[11px]"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {/* TDSF 魔改 2026-07-30: SSH 连接时显示服务器地址, 替代 Windows/WSL 选择器 */}
        {sshLocation ? (
          <SshLocationPill label={sshLocation} />
        ) : (
          <WorkspaceEnvSelector onSelect={onWorkspaceChange} />
        )}
        <CwdBreadcrumb cwd={cwd} filePath={filePath} home={home} onCd={onCd} />
        <LspStatusPill filePath={filePath ?? null} />
        <DiagnosticsBadge filePath={filePath ?? null} />
        {privateActive ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="flex shrink-0 cursor-default items-center gap-1 rounded-full bg-amber-500/15 px-2 py-0.5 text-[10.5px] font-medium text-amber-700 dark:text-amber-400">
                <HugeiconsIcon icon={IncognitoIcon} size={11} strokeWidth={2} />
                <span>Private: hidden from AI</span>
              </span>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              className="max-w-64 text-[11px] leading-relaxed"
            >
              AI can't see this terminal's output. Use it for secrets, SSH, or
              anything you don't want sent to the model.
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      {/* TDSF 魔改 2026-07-31: 统一 AI 入口为 Ctrl+I, 右下角只保留 AgentStatusPill。
          点击 pill 打开 AI 面板, Ctrl+I 切换面板。移除重复的 "Open AI agent" 按钮。 */}
      <div className="flex shrink-0 items-center gap-1.5">
        <MockLLMWarning />
        <BackendPill />
        <AgentStatusPill data-testid="statusbar-agent-status-pill" onClick={onOpenMini} />
        {panelOpen && hasComposer ? <AiStatusBarControls /> : null}
      </div>
    </footer>
  );
}
