import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useChatStore } from "@/modules/ai";
import { AgentModeSwitcher } from "@/modules/ai/components/AgentModeSwitcher";
import { BackendPill } from "@/modules/ai/components/BackendPill";
import { AiStatusBarControls } from "@/modules/ai/components/AiStatusBarControls";
import { MockLLMWarning } from "@/modules/ai/components/MockLLMWarning";
import { LspStatusPill } from "@/modules/lsp";
import { openSettingsWindow } from "@/modules/settings/openSettingsWindow";
import type { WorkspaceEnv } from "@/modules/workspace";
import { IncognitoIcon, Message01Icon } from "@hugeicons/core-free-icons";
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
  hasComposer,
  privateActive,
}: Props) {
  const panelOpen = useChatStore((s) => s.panelOpen);
  // TDSF 修复 2026-09-03: 恢复“打开 AI 对话框”常驻入口——上一轮 AgentStatusPill
  // 被 AgentModeSwitcher 取代后，面板关闭时底部无点击打开入口（用户打不开对话框）。
  const miniOpen = useChatStore((s) => s.mini.open);
  const toggleMini = useChatStore((s) => s.toggleMini);
  const openAiDialog = () => {
    if (!hasComposer) {
      void openSettingsWindow("models");
      return;
    }
    toggleMini();
  };

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
      {/* TDSF 魔改 2026-09-02（用户钦定）: 模式选择器移到底部状态栏——
          AgentModeSwitcher（交互式四档抽屉）取代原只读 AgentStatusPill，
          紧邻 BackendPill(Strands)，对话区不再挂切换器保持干净。
          busy/循环进度反馈仍由顶栏 Header 的 AgentStatusPill 承载。
          TDSF 修复 2026-09-03: 补回常驻“打开 AI 对话框”图标按钮（上一轮删
          AgentStatusPill 的 onClick 后，面板关闭时底部无点击入口 → 打不开对话框）。 */}
      <div className="flex shrink-0 items-center gap-1.5">
        <MockLLMWarning />
        <button
          type="button"
          onClick={openAiDialog}
          title={`${miniOpen ? "关闭" : "打开"} AI 对话框 (Ctrl+I)`}
          aria-label="打开 AI 对话框"
          data-testid="statusbar-open-ai"
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <HugeiconsIcon icon={Message01Icon} size={14} strokeWidth={1.75} />
        </button>
        <AgentModeSwitcher />
        <BackendPill />
        {panelOpen && hasComposer ? <AiStatusBarControls /> : null}
      </div>
    </footer>
  );
}
