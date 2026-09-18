// TDSF 修复 2026-08-01: 欢迎界面
// -----------------------------------------------------------------------------
// 没有**活跃**工作区时显示（首次启动 / 全部删除后 / 重启后停在初始选择页）。
// 登录统一走"新建工作区"流程：本地工作区或 SSH 服务器。
// 对应需求：删除左侧 SSH 面板后，新建工作区是唯一的登录入口。
// TDSF 2026-09-18 (ROADMAP #61 方案 A): 启动不再自动进入上次的工作区，但注册表
// 会留存，所以这里还要给「打开已有工作区」的回程入口（existingCount > 0 时）。
import { Button } from "@/components/ui/button";
import {
  CloudServerIcon,
  CubeIcon,
  FolderOpenIcon,
  Square01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

type Props = {
  onCreateLocal: () => void;
  onCreateSsh: () => void;
  /** TDSF 2026-08-28（用户反馈）: WSL 加入工作区创建入口 */
  onCreateWsl: () => void;
  /**
   * TDSF 2026-09-18 (ROADMAP #61 方案 A)：注册表里已有的工作区数量。
   * 启动不再自动进入工作区，所以欢迎页可能带着旧清单出现——必须告诉用户
   * 从哪里进去，否则他只会看到三个「新建」按钮。
   */
  existingCount: number;
  /** 打开工作区总览（顶栏同一个弹层），供「打开已有工作区」按钮使用 */
  onOpenExisting: () => void;
};

export function WelcomeScreen({
  onCreateLocal,
  onCreateSsh,
  onCreateWsl,
  existingCount,
  onOpenExisting,
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
          {existingCount > 0
            ? "上次的工作区还留着，但没有自动连上——选一个回去，或再建一个新的。"
            : "终端优先的 Linux 运维工作台。创建一个工作区开始使用——本地终端、WSL 或连接 SSH 服务器。"}
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {existingCount > 0 && (
          // 有历史工作区时把「回去」放在最前面：欢迎页不再自动进入，
          // 不给入口就等于让用户重复新建。
          <Button
            size="lg"
            variant="secondary"
            className="w-64 gap-2"
            onClick={onOpenExisting}
            data-testid="welcome-open-existing"
          >
            <HugeiconsIcon icon={FolderOpenIcon} size={16} strokeWidth={1.75} />
            打开已有工作区（{existingCount}）
          </Button>
        )}
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
        {existingCount > 0
          ? "重启后停在欢迎页，不会自动连上上次的工作区；从上面按钮或顶栏「选择工作区」回去"
          : "全部工作区删除后从此界面重新开始"}
      </p>
    </div>
  );
}
