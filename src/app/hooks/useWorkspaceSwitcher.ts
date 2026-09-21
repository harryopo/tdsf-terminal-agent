import { native } from "@/modules/ai/lib/native";
import { isSshEnvConnected } from "@/modules/spaces/lib/sshSpaceSession";
import type { Tab } from "@/modules/tabs";
import {
  getWslHome,
  LOCAL_WORKSPACE,
  type WorkspaceEnv,
} from "@/modules/workspace";
import { homeDir } from "@tauri-apps/api/path";
import { type RefObject, useCallback, useEffect, useState } from "react";

async function resolveEnvHome(env: WorkspaceEnv): Promise<string> {
  if (env.kind === "wsl") return getWslHome(env.distro);
  // TDSF #93（2026-09-21）：SSH 工作区的身份现在跨断线留着，所以"是 ssh"不再等于
  // "连上了"。只有真活着的会话才把远程家目录当 home —— 否则这个 /home/<user>
  // 会被交给本地 PTY 与 workspaceAuthorize（`pty-bridge.ts` 把 ssh env 映射成
  // local 起壳），结果是本地 shell 试图 cd 进一个 Linux 路径。
  if (env.kind === "ssh" && isSshEnvConnected(env)) return `/home/${env.user}`;
  return (await homeDir()).replace(/\\/g, "/");
}

type Params = {
  tabsRef: RefObject<Tab[]>;
  workspaceEnv: WorkspaceEnv;
  setWorkspaceEnv: (env: WorkspaceEnv) => void;
  resetWorkspace: (home?: string) => void;
  /** Dispose live sessions and clear App-owned pane/handle ref maps. */
  clearWorkspaceState: () => void;
};

/**
 * Owns the resolved home / launch cwd. switchWorkspace runs an interactive
 * local⇄WSL switch (tears down sessions, re-authorizes home, resets tabs);
 * adoptWorkspaceEnv applies a space's env + home on restore, without teardown.
 */
export function useWorkspaceSwitcher({
  tabsRef,
  workspaceEnv,
  setWorkspaceEnv,
  resetWorkspace,
  clearWorkspaceState,
}: Params) {
  const [home, setHome] = useState<string | null>(null);
  const [localHome, setLocalHome] = useState<string | null>(null);
  const [launchCwd, setLaunchCwd] = useState<string | null>(null);
  const [launchCwdResolved, setLaunchCwdResolved] = useState(false);

  useEffect(() => {
    homeDir()
      .then(async (p) => {
        const normalized = p.replace(/\\/g, "/");
        setHome(normalized);
        setLocalHome(normalized);
        try {
          await native.workspaceAuthorize(normalized);
        } catch {
          // Bootstrap already authorizes home from Rust; ignore.
        }
      })
      .catch(() => setHome(null));
  }, []);

  useEffect(() => {
    native
      .workspaceCurrentDir()
      .then(setLaunchCwd)
      .catch(() => setLaunchCwd(null))
      .finally(() => setLaunchCwdResolved(true));
  }, []);

  const authorizeHome = useCallback(async (nextHome: string) => {
    setHome(nextHome);
    setLaunchCwd(nextHome);
    try {
      await native.workspaceAuthorize(nextHome);
    } catch {
      // Non-fatal — git panel will surface "not authorized" if needed.
    }
  }, []);

  const switchWorkspace = useCallback(
    async (env: WorkspaceEnv): Promise<boolean> => {
      const sameEnv =
        env.kind === workspaceEnv.kind &&
        (env.kind === "local" ||
          (env.kind === "wsl" &&
            workspaceEnv.kind === "wsl" &&
            env.distro === workspaceEnv.distro) ||
          (env.kind === "ssh" &&
            workspaceEnv.kind === "ssh" &&
            env.host === workspaceEnv.host &&
            env.user === workspaceEnv.user &&
            env.port === workspaceEnv.port));
      if (sameEnv) {
        return false;
      }
      const dirty = tabsRef.current.some((t) => t.kind === "editor" && t.dirty);
      if (dirty) {
        window.alert(
          "Save or close unsaved editor tabs before switching workspace.",
        );
        return false;
      }

      let nextHome: string;
      try {
        nextHome = await resolveEnvHome(env);
      } catch (e) {
        window.alert(String(e));
        return false;
      }

      clearWorkspaceState();
      setWorkspaceEnv(env.kind === "local" ? LOCAL_WORKSPACE : env);
      await authorizeHome(nextHome);
      resetWorkspace(nextHome);
      return true;
    },
    [
      workspaceEnv,
      setWorkspaceEnv,
      resetWorkspace,
      tabsRef,
      clearWorkspaceState,
      authorizeHome,
    ],
  );

  const adoptWorkspaceEnv = useCallback(
    async (env: WorkspaceEnv): Promise<string | null> => {
      setWorkspaceEnv(env.kind === "local" ? LOCAL_WORKSPACE : env);
      let nextHome: string;
      try {
        nextHome = await resolveEnvHome(env);
      } catch {
        return null;
      }
      await authorizeHome(nextHome);
      return nextHome;
    },
    [setWorkspaceEnv, authorizeHome],
  );

  return {
    home,
    localHome,
    launchCwd,
    launchCwdResolved,
    switchWorkspace,
    adoptWorkspaceEnv,
  };
}
