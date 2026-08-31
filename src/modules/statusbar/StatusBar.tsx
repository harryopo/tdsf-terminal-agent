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
import { IncognitoIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { CwdBreadcrumb } from "./CwdBreadcrumb";
import { DiagnosticsBadge } from "./DiagnosticsBadge";
import { WorkspaceEnvSelector } from "./WorkspaceEnvSelector";

type Props = {
  cwd: string | null;
  filePath?: string | null;
  home: string | null;
  onCd: (path: string) => void;
  onWorkspaceChange: (env: WorkspaceEnv) => void;
  /** TDSF 魔改 2026-08-28: 环境选择器 SSH 选项 → 打开新建 SSH 工作区对话框 */
  onWorkspaceSshClick?: () => void;
  /** TDSF 魔改 2026-08-28: 环境切换进行中（pending 态） */
  workspaceSwitching?: boolean;
  onOpenMini: () => void;
  /** Only rendered when the AI panel is open and a key is loaded. */
  hasComposer: boolean;
  privateActive: boolean;
};

export function StatusBar({
  cwd,
  filePath,
  home,
  onCd,
  onWorkspaceChange,
  onWorkspaceSshClick,
  workspaceSwitching,
  onOpenMini,
  hasComposer,
  privateActive,
}: Props) {
  const panelOpen = useChatStore((s) => s.panelOpen);

  return (
    <footer
      data-testid="statusbar"
      className="flex h-8 shrink-0 items-center justify-between gap-3 border-t border-border/60 bg-card/60 pl-3 pr-4 text-[11px]"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <WorkspaceEnvSelector
          onSelect={onWorkspaceChange}
          onSelectSsh={onWorkspaceSshClick}
          switching={workspaceSwitching}
        />
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
              AI can&apos;t see this terminal&apos;s output. Use it for secrets, SSH, or
              anything you don&apos;t want sent to the model.
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
      {/* TDSF 魔改 2026-07-31: 统一 AI 入口为 Ctrl+I, 右下角只保留 AgentStatusPill。
          点击 pill 打开 AI 面板, Ctrl+I 切换面板。移除重复的 "Open AI agent" 按钮。 */}
      <div className="flex shrink-0 items-center gap-1.5">
        <MockLLMWarning />
        {/* 2026-08-31 用户钦定调换：Agent 模式在前、Strands 后端在后（显示更全面） */}
        <AgentStatusPill data-testid="statusbar-agent-status-pill" onClick={onOpenMini} />
        <BackendPill />
        {panelOpen && hasComposer ? <AiStatusBarControls /> : null}
      </div>
    </footer>
  );
}
