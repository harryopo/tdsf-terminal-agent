// TDSF 修复 2026-08-01: 欢迎界面
// -----------------------------------------------------------------------------
// 无任何工作区（首次启动 / 全部删除后）时显示全屏欢迎界面。
// 登录统一走"新建工作区"流程：本地工作区或 SSH 服务器。
// 对应需求：删除左侧 SSH 面板后，新建工作区是唯一的登录入口。
import { Button } from "@/components/ui/button";
import {
  CloudServerIcon,
  CubeIcon,
  Square01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

type Props = {
  onCreateLocal: () => void;
  onCreateSsh: () => void;
  /** TDSF 魔改 2026-08-28（用户反馈）: WSL 加入工作区创建入口 */
  onCreateWsl: () => void;
};

export function WelcomeScreen({
  onCreateLocal,
  onCreateSsh,
  onCreateWsl,
}: Props) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-8 bg-background">
      <div className="flex flex-col items-center gap-3">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 text-2xl font-bold text-primary">
          ⬡
        </div>
        <h1 className="text-2xl font-semibold text-foreground">
          TDSF Terminal Agent
        </h1>
        <p className="max-w-sm text-center text-[13px] text-muted-foreground">
          终端优先的 Linux 运维工作台。创建一个工作区开始使用——
          本地终端、WSL 或连接 SSH 服务器。
        </p>
      </div>

      <div className="flex flex-col gap-3">
        <Button
          size="lg"
          className="w-64 gap-2"
          onClick={onCreateLocal}
          data-testid="welcome-local"
        >
          <HugeiconsIcon icon={Square01Icon} size={16} strokeWidth={1.75} />
          新建本地工作区
        </Button>
        <Button
          size="lg"
          variant="outline"
          className="w-64 gap-2"
          onClick={onCreateWsl}
          data-testid="welcome-wsl"
        >
          <HugeiconsIcon icon={CubeIcon} size={16} strokeWidth={1.75} />
          新建 WSL 工作区
        </Button>
        <Button
          size="lg"
          variant="outline"
          className="w-64 gap-2"
          onClick={onCreateSsh}
          data-testid="welcome-ssh"
        >
          <HugeiconsIcon icon={CloudServerIcon} size={16} strokeWidth={1.75} />
          连接 SSH 服务器
        </Button>
      </div>

      <p className="text-[11px] text-muted-foreground/70">
        已有工作区将自动恢复；全部删除后从此界面重新开始
      </p>
    </div>
  );
}
