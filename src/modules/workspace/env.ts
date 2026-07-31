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
