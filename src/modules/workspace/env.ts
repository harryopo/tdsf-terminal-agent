import { setLastWslDistro } from "@/modules/settings/store";
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";

export type WorkspaceEnv =
  | { kind: "local" }
  | { kind: "wsl"; distro: string }
  | {
      kind: "ssh";
      host: string;
      user: string;
      port: number;
      /** SSH 会话前端 UUID（sshStore.sessions[].id）。未连接时为 undefined。 */
      sessionId?: string;
      label: string;
    };

export type WslDistro = {
  name: string;
  default: boolean;
  running: boolean;
};

type State = {
  env: WorkspaceEnv;
  distros: WslDistro[];
  loading: boolean;
  error: string | null;
  setEnv: (env: WorkspaceEnv) => void;
  refreshDistros: () => Promise<WslDistro[]>;
};

export const LOCAL_WORKSPACE: WorkspaceEnv = { kind: "local" };

export const useWorkspaceEnvStore = create<State>((set) => ({
  env: LOCAL_WORKSPACE,
  distros: [],
  loading: false,
  error: null,
  setEnv: (env) => {
    set({ env });
    if (env.kind === "wsl") void setLastWslDistro(env.distro);
  },
  refreshDistros: async () => {
    set({ loading: true, error: null });
    try {
      const distros = await invoke<WslDistro[]>("wsl_list_distros");
      set({ distros, loading: false });
      return distros;
    } catch (e) {
      set({ distros: [], loading: false, error: String(e) });
      return [];
    }
  },
}));

export function currentWorkspaceEnv(): WorkspaceEnv {
  return useWorkspaceEnvStore.getState().env;
}

/**
 * 交给**只认 local / wsl** 的本地命令（`fs_*` / `git_*` / `lsp_*` / `watch_*` / `pty_open` …）
 * 的环境参数。
 *
 * Rust 侧的 `WorkspaceEnv` 枚举**没有 ssh 变体**（`src-tauri/src/modules/workspace.rs:313`），
 * 传 `{kind:"ssh"}` 会让命令在反序列化阶段就整体失败 —— 用户实测报
 * `invalid args 'workspace' for command 'fs_read_dir': unknown variant 'ssh',
 * expected 'local' or 'wsl'`，表现是"切到本地工作区后资源管理器不刷新，要点刷新才行"。
 *
 * 语义上也是对的：SSH 工作区的文件操作走 `fsb_*` + sessionId（另一条通道），
 * 真按本地盘寻址时那台机器就是本地盘。WSL 原样透传（Rust 认这个变体）。
 *
 * 需要**身份**的地方（scope key、"这是不是远端"的判断）请继续用 `currentWorkspaceEnv()`，
 * 别拿本函数当"当前环境"。
 */
export function ipcWorkspaceEnv(): WorkspaceEnv {
  const env = currentWorkspaceEnv();
  return env.kind === "ssh" ? LOCAL_WORKSPACE : env;
}

export function workspaceScopeKey(env: WorkspaceEnv): string {
  if (env.kind === "wsl") return `wsl:${env.distro}`;
  if (env.kind === "ssh")
    return `ssh:${env.user}@${env.host}:${env.port}:${env.label}`;
  return "local";
}

export function parseWorkspaceScopeKey(key: string): WorkspaceEnv {
  if (key.startsWith("wsl:")) {
    return { kind: "wsl", distro: key.slice("wsl:".length) };
  }
  if (key.startsWith("ssh:")) {
    const rest = key.slice("ssh:".length);
    const [userHost, portAndLabel] = rest.split(":", 2);
    if (!userHost) return LOCAL_WORKSPACE;
    const [user, host] = userHost.split("@", 2);
    if (!user || !host) return LOCAL_WORKSPACE;
    const [portStr, label] = (portAndLabel ?? "").split(":", 2);
    const port = Number(portStr) || 22;
    return {
      kind: "ssh",
      host,
      user,
      port,
      label: label ?? `${user}@${host}`,
    };
  }
  return LOCAL_WORKSPACE;
}

export function currentWorkspaceScopeKey(): string {
  return workspaceScopeKey(currentWorkspaceEnv());
}

export async function getWslHome(distro: string): Promise<string> {
  return invoke<string>("wsl_home", { distro });
}
