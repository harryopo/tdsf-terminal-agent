import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AgentModeSwitcher } from "@/modules/ai/components/AgentModeSwitcher";
import { BackendPill } from "@/modules/ai/components/BackendPill";
import { AiStatusBarControls } from "@/modules/ai/components/AiStatusBarControls";
import { MockLLMWarning } from "@/modules/ai/components/MockLLMWarning";
import { LspStatusPill } from "@/modules/lsp";
import type { WorkspaceEnv } from "@/modules/workspace";
import { IncognitoIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { CwdBreadcrumb } from "./CwdBreadcrumb";
import { DiagnosticsBadge } from "./DiagnosticsBadge";
import { RemoteOsBadge, type RemoteOsBadgeInfo } from "./RemoteOsBadge";
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
  /** 已配置模型/API key（composer 可用）——useAiBootstrap 派生（hasAnyKey || hasLocalModel），
   *  与 panelOpen 无关。true 时底部常驻完整 AI 控件（AiStatusBarControls）；false 时引导去设置配 key。 */
  hasComposer: boolean;
  privateActive: boolean;
  /** Only a known, currently connected SSH session may supply this badge. */
  remoteOsInfo?: RemoteOsBadgeInfo | null;
};

export function StatusBar({
  cwd,
  filePath,
  home,
  onCd,
  onWorkspaceChange,
  onWorkspaceSshClick,
  workspaceSwitching,
  hasComposer,
  privateActive,
  remoteOsInfo = null,
}: Props) {
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
        <RemoteOsBadge info={remoteOsInfo} />
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
      {/* TDSF 魔改 2026-09-02（用户钦定）: 模式选择器移到底部状态栏——
          AgentModeSwitcher（交互式四档抽屉）取代原只读 AgentStatusPill，
          紧邻 BackendPill(Strands)，对话区不再挂切换器保持干净。
          busy/循环进度反馈仍由顶栏 Header 的 AgentStatusPill 承载。 */}
      <div className="flex shrink-0 items-center gap-1.5">
        <MockLLMWarning />
        <AgentModeSwitcher />
        <BackendPill />
        {/* 方案A（2026-09-03 用户钦定）：AiStatusBarControls 常驻（不再依赖 panelOpen），
            统一底部为完整形态（修“面板未展开时简化”的两种模式 bug）。气泡=开关 agent 面板、
            箭头=开关对话框均在其中；已删除重复的 statusbar-open-ai 气泡（功能并入 AiStatusBarControls）。 */}
        {hasComposer ? <AiStatusBarControls /> : null}
      </div>
    </footer>
  );
}
