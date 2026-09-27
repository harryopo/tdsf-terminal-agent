import { invoke } from "@tauri-apps/api/core";
import { stop as stopSidecar } from "@/lib/sidecar-bridge";
import { stopGeneration, useChatStore } from "@/modules/ai/store/chatStore";
import { useNeedsYouWait } from "@/modules/ai/store/needsYouWaitStore";
import { useSshStore } from "@/modules/ssh-explorer/sshStore";
import { useTerminalBlocksStore } from "@/modules/terminal/lib/terminalBlocksStore";
import { getHeldUpdate, releaseHeldUpdate } from "./checkUpdate";
import {
  collectInstallBlockers,
  describeUpdateFailure,
  type InstallBlocker,
} from "./updateFacts";
import { useUpdateStore } from "./updateStore";

export type InstallDeps = {
  blockers: () => InstallBlocker[];
  cancelTurn: () => void;
  disconnectSsh: () => Promise<void>;
  closePty: () => Promise<void>;
  killLsp: () => Promise<void>;
  stopSidecar: () => Promise<void>;
  install: () => Promise<void>;
};

export type InstallOutcome =
  | { ok: true }
  | { ok: false; reason: "blocked"; blockers: InstallBlocker[] }
  | { ok: false; reason: "failed"; message: string };

function countPendingExecutions(): number {
  const { agentPending } = useTerminalBlocksStore.getState();
  return Object.values(agentPending).filter((v) => v !== undefined).length;
}

/**
 * Windows 上 update.install() 会拉起安装器然后 std::process::exit(0) ——
 * React 的清理、Rust 的 RunEvent::Exit（那里负责 sidecar.stop 与 lsp.kill_all）
 * 一个都不会跑。所以这些收尾必须在这里、在 install 之前全部做完，
 * 否则每次自动更新都在用户机器上留下一批孤儿子进程。
 *
 * 每一步都 best-effort：一条 SSH 断不开不该让安装整件事失败。
 */
export const liveInstallDeps: InstallDeps = {
  blockers: () => {
    const meta = useChatStore.getState().agentMeta;
    return collectInstallBlockers({
      sidecarApprovals: useNeedsYouWait.getState().pending.length,
      hostApprovals: useSshStore.getState().pendingApprovals.length,
      agentRunning:
        meta.status === "thinking" ||
        meta.status === "streaming" ||
        meta.status === "awaiting-approval",
      pendingExecutions: countPendingExecutions(),
    });
  },
  cancelTurn: () => stopGeneration(useChatStore.getState().activeSessionId),
  disconnectSsh: async () => {
    const { sessions, disconnect } = useSshStore.getState();
    for (const s of sessions) await disconnect(s.id);
  },
  closePty: async () => {
    await invoke("pty_close_all");
  },
  killLsp: async () => {
    await invoke("lsp_kill_all");
  },
  stopSidecar: async () => {
    await stopSidecar();
  },
  install: async () => {
    const update = getHeldUpdate();
    if (!update) throw new Error("no-held-update");
    await update.install();
  },
};

async function bestEffort(
  label: string,
  step: () => Promise<void> | void,
): Promise<void> {
  try {
    await step();
  } catch (error) {
    console.warn(`[update] 收尾步骤 ${label} 失败（继续）:`, error);
  }
}

export async function installHeldUpdate(
  deps: InstallDeps = liveInstallDeps,
): Promise<InstallOutcome> {
  const store = useUpdateStore.getState();
  const blockers = deps.blockers();
  if (blockers.length > 0) {
    store.refuseInstall(blockers);
    return { ok: false, reason: "blocked", blockers };
  }
  if (!getHeldUpdate()) {
    const message = "手上没有待安装的更新，请先检查更新。";
    store.markError(message);
    return { ok: false, reason: "failed", message };
  }
  store.markInstalling();
  await bestEffort("cancel-turn", deps.cancelTurn);
  await bestEffort("disconnect-ssh", deps.disconnectSsh);
  await bestEffort("close-pty", deps.closePty);
  await bestEffort("kill-lsp", deps.killLsp);
  await bestEffort("stop-sidecar", deps.stopSidecar);
  try {
    await deps.install();
    // Windows 走不到这里（进程已退出）；macOS/Linux 装完还要 relaunch
    releaseHeldUpdate();
    return { ok: true };
  } catch (error) {
    const message = describeUpdateFailure(error);
    useUpdateStore.getState().markError(message);
    return { ok: false, reason: "failed", message };
  }
}
