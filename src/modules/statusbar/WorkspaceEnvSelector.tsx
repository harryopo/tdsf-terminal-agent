import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IS_WINDOWS } from "@/lib/platform";
import { useSpaces } from "@/modules/spaces";
import { isSshEnvConnected } from "@/modules/spaces/lib/sshSpaceSession";
import { useSshStore } from "@/modules/ssh-explorer/sshStore";
import {
  LOCAL_WORKSPACE,
  useWorkspaceEnvStore,
  type WorkspaceEnv,
} from "@/modules/workspace";
import { ServerStack03Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";

type Props = {
  onSelect: (env: WorkspaceEnv) => void;
  /**
   * TDSF 2026-08-28（用户反馈）: SSH 选项——SSH 无法像 WSL 一样
   * 一步切换（需要主机/凭据），点击后打开"新建 SSH 工作区"对话框，
   * 与欢迎页/新建工作区的 SSH 链路保持同源。
   */
  onSelectSsh?: () => void;
  /** 环境切换进行中（按钮 pending 态，防止"卡一下"的错觉） */
  switching?: boolean;
  /**
   * TDSF 2026-09-18（用户实测）: 当前终端 leaf 实际绑定的已连接 SSH 地址
   * （user@host）。优先级高于 Space env——本地 Space 里开 SSH 终端时
   * Space.env 仍是 local，旧口径会让标签恒显 "Windows"。
   */
  terminalAddress?: string | null;
};

export function WorkspaceEnvSelector({
  onSelect,
  onSelectSsh,
  switching = false,
  terminalAddress = null,
}: Props) {
  const globalEnv = useWorkspaceEnvStore((s) => s.env);
  // TDSF 2026-09-02: 标签以「活跃 Space 的 env」为持久化真源，回退全局 env。
  // 修复：初次加载 SSH Space 时全局 env 尚未被 adoptWorkspaceEnv 同步
  // （App.tsx prevSpaceRef 的 prev===null 早退守卫），导致底部仍显示 "Windows"
  // 而非服务器地址。活跃 Space 的 env 总是跟随连接状态（含 ssh user@host）。
  const spaceEnv = useSpaces(
    (s) => s.spaces.find((x) => x.id === s.activeId)?.env,
  );
  const env = spaceEnv ?? globalEnv;
  const distros = useWorkspaceEnvStore((s) => s.distros);
  const loading = useWorkspaceEnvStore((s) => s.loading);
  const error = useWorkspaceEnvStore((s) => s.error);
  const refreshDistros = useWorkspaceEnvStore((s) => s.refreshDistros);
  // TDSF #93（2026-09-21）：SSH 工作区身份跨断线留着，所以这里要分开两件事——
  // **地址是什么**（身份，一直显示）与**命令实际落在哪**（只有真连着才算远端）。
  // 未连接时如实标出来，否则 tooltip 会说谎："当前终端命令执行于 root@…"。
  // 订阅必须放在下面那个提前 return 之前（Hook 顺序不能变）。
  const sshSessions = useSshStore((s) => s.sessions);
  const sshConnected = isSshEnvConnected(env, sshSessions);

  // TDSF 2026-09-02（用户钦定）: SSH 工作区跨平台显示服务器地址（user@host），
  // 本地/WSL 环境选择仅 Windows 有意义——非 Windows 且非 SSH 时才隐藏整个选择器。
  // TDSF 2026-09-18: 终端已连 SSH 时同样保留（Space 可能仍是 local）。
  if (!IS_WINDOWS && env.kind !== "ssh" && !terminalAddress) return null;

  // 每次打开菜单都重新拉取 WSL 发行版列表（取代已删除的手动 Refresh 项，
  // 保证新建/删除发行版后列表始终最新）
  const handleOpenChange = (open: boolean) => {
    if (open && !loading) {
      void refreshDistros();
    }
  };

  // SSH 时显示服务器地址（如 root@192.168.45.200），而非笼统的 "Windows"。
  // terminalAddress 优先：它表示"当前终端的命令实际落在哪台机器"。
  const label =
    terminalAddress ??
    (env.kind === "ssh"
      ? `${env.user}@${env.host}${sshConnected ? "" : " · 未连接"}`
      : env.kind === "wsl"
        ? `WSL: ${env.distro}`
        : "Windows");
  const remote = sshConnected || terminalAddress !== null;

  return (
    <DropdownMenu onOpenChange={handleOpenChange}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={switching}
          className="flex h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 text-[11px] text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus:outline-none focus-visible:outline-none focus-visible:ring-0 data-[state=open]:bg-accent data-[state=open]:text-foreground disabled:opacity-60"
          title={
            switching
              ? "正在切换环境…"
              : remote
                ? `当前终端命令执行于 ${label}`
                : "切换工作区环境"
          }
        >
          <HugeiconsIcon
            icon={ServerStack03Icon}
            size={13}
            strokeWidth={1.75}
            className={switching ? "animate-pulse" : undefined}
          />
          <span className="max-w-44 truncate">
            {switching ? "切换中…" : label}
          </span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-48">
        <DropdownMenuItem onSelect={() => onSelect(LOCAL_WORKSPACE)}>
          本地
        </DropdownMenuItem>
        {/* 2026-09-20 用户实测：三类条目必须等距——分隔线会让 SSH 与 WSL 之间
            多出一次空隙，看着像"间距不一样"；条目文案一律纯文字、不带省略号。 */}
        <DropdownMenuItem onSelect={onSelectSsh}>SSH 服务器</DropdownMenuItem>
        {/* WSL 发行版仅 Windows 平台有意义 */}
        {IS_WINDOWS &&
          (distros.length === 0 ? (
            <DropdownMenuItem disabled>
              {loading
                ? "读取 WSL 发行版…"
                : error
                  ? "WSL 不可用"
                  : "无 WSL 发行版"}
            </DropdownMenuItem>
          ) : (
            distros.map((distro) => (
              <DropdownMenuItem
                key={distro.name}
                onSelect={() => onSelect({ kind: "wsl", distro: distro.name })}
              >
                WSL · {distro.name}
              </DropdownMenuItem>
            ))
          ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
