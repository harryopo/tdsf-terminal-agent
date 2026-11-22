import { invoke } from "@tauri-apps/api/core";
import { getAllWindows, getCurrentWindow } from "@tauri-apps/api/window";
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
  blockers: () => InstallBlocker[] | Promise<InstallBlocker[]>;
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
  blockers: async () => {
    let windowBlocker: InstallBlocker | undefined;
    try {
      const currentLabel = getCurrentWindow().label;
      const windows = await getAllWindows();
      if (!windows.some((window) => window.label === currentLabel)) {
        throw new Error("current-window-missing");
      }
      if (
        windows.some(
          (window) =>
            window.label !== currentLabel && /^main(?:-\d+)?$/.test(window.label),
        )
      ) {
        windowBlocker = {
          key: "other-windows",
          text: "安装更新会退出整个应用，请先保存并关闭其他主窗口，再回到本窗口安装。",
        };
      }
    } catch {
      windowBlocker = {
        key: "window-state",
        text: "无法确认其他窗口的编辑状态，暂不安装更新。请稍后重试。",
      };
    }
    const meta = useChatStore.getState().agentMeta;
    const blockers = collectInstallBlockers({
      sidecarApprovals: useNeedsYouWait.getState().pending.length,
      hostApprovals: useSshStore.getState().pendingApprovals.length,
      agentRunning:
        meta.status === "thinking" ||
        meta.status === "streaming" ||
        meta.status === "awaiting-approval",
      pendingExecutions: countPendingExecutions(),
    });
    if (windowBlocker) blockers.push(windowBlocker);
    return blockers;
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
  if (store.phase !== "ready") {
    return {
      ok: false,
      reason: "failed",
      message:
        store.phase === "installing"
          ? "更新正在安装，请勿重复操作。"
          : "更新尚未下载完成，请等待下载完成后再安装。",
    };
  }
  const update = getHeldUpdate();
  if (!update) {
    const message = "手上没有待安装的更新，请先检查更新。";
    store.markError(message);
    return { ok: false, reason: "failed", message };
  }
  store.markInstalling();
  try {
    const blockers = await deps.blockers();
    if (blockers.length > 0) {
      store.refuseInstall(blockers);
      return { ok: false, reason: "blocked", blockers };
    }
    await bestEffort("cancel-turn", deps.cancelTurn);
    await bestEffort("disconnect-ssh", deps.disconnectSsh);
    await bestEffort("close-pty", deps.closePty);
    await bestEffort("kill-lsp", deps.killLsp);
    await bestEffort("stop-sidecar", deps.stopSidecar);
    const finalBlockers = await deps.blockers();
    if (finalBlockers.length > 0) {
      useUpdateStore.getState().refuseInstall(finalBlockers);
      return { ok: false, reason: "blocked", blockers: finalBlockers };
    }
    if (getHeldUpdate() !== update) {
      const message = "待安装的更新已变化，请重新检查并下载更新。";
      useUpdateStore.getState().markError(message);
      return { ok: false, reason: "failed", message };
    }
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
