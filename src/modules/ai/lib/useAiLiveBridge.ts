import { useManagedAgentsStore } from "@/modules/agents/store/managedAgentsStore";
import { isSessionConnected, selectSessionCurrentPath, useSshStore } from "@/modules/ssh-explorer/sshStore";
import type { Tab } from "@/modules/tabs";
import {
  findLeafCwd,
  type TerminalPaneHandle,
  whenSessionReady,
  writeToSession,
} from "@/modules/terminal";
import { invoke } from "@tauri-apps/api/core";
import { type RefObject, useEffect, useRef } from "react";
import type { Live } from "../store/chatStore";
import { redactSensitive } from "./redact";

type TuiWaitResult = "ready" | "gone" | "timeout";

async function waitForClaudeTuiReady(
  readBuf: () => string | null,
  timeoutMs = 8000,
): Promise<TuiWaitResult> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const buf = readBuf();
    if (buf === null) return "gone";
    if (buf.includes("shortcuts") || buf.includes("? for")) return "ready";
    await new Promise((r) => setTimeout(r, 120));
  }
  return "timeout";
}

type Params = {
  setLive: (live: Live) => void;
  activeId: number;
  tabs: Tab[];
  explorerRoot: string | null;
  launchCwd: string | null;
  home: string | null;
  openPreviewTab: (url: string) => void;
  newAgentTab: (
    cwd: string | undefined,
    title: string,
  ) => { tabId: number; leafId: number };
  terminalRefs: RefObject<Map<number, TerminalPaneHandle>>;
  /**
   * TDSF 魔改 (2026-08-09): 获取 SSH 终端的 leafId。
   * SSH 终端（SshTerminalHost）不在 tabs 数组里，getTerminalContext
   * 原本只查 tabs → SSH 场景返回 null → agent 看不到 SSH 终端内容。
   * 现在增加回退：tabs 找不到活跃终端时，尝试用 SSH leafId 读 buffer。
   */
  getSshLeafId?: () => number | null;
};

/**
 * Publishes the live workspace context (cwd, terminal buffer, active file,
 * managed-agent spawning, ...) into the chat store so AI tools can read and
 * act on the foreground state.
 *
 * The live object's getters read the latest state through a ref, so the bridge
 * is published once instead of re-running on every tab/cwd change — cwd updates
 * arrive from terminal OSC on shell output and would otherwise churn constantly.
 */
export function useAiLiveBridge(params: Params) {
  const { setLive, terminalRefs } = params;
  const ref = useRef(params);
  ref.current = params;

  useEffect(() => {
    const findCwd = () => {
      const { activeId, tabs, explorerRoot, launchCwd, home } = ref.current;
      // TDSF 魔改 (2026-08-09): SSH 终端优先——
      // SSH 场景下 activeId 对应的 tab 是 cold + SSH 接管，
      // 但 findLeafCwd 会读到本地终端的 cwd（如 C:\Users\Lenovo）。
      // 优先从 sshStore 读 SSH 远端 cwd，避免 agent 收到错误的本地路径。
      const sshLeafId = ref.current.getSshLeafId?.();
      if (sshLeafId !== null && sshLeafId !== undefined) {
        // 优先从 sshStore 读当前 SSH 会话的远端 cwd
        const sshState = useSshStore.getState();
        const cwd = selectSessionCurrentPath(sshState, sshState.activeSessionId);
        if (cwd) return cwd;
        // currentPath 未就绪时回退到 home 或 root
        const active = sshState.sessions.find(
          (s) => s.id === sshState.activeSessionId,
        );
        const fallback = active?.params?.user
          ? `/home/${active.params.user}`
          : "/";
        return fallback;
      }
      const active = tabs.find((x) => x.id === activeId);
      if (active?.kind === "terminal") {
        return (
          findLeafCwd(active.paneTree, active.activeLeafId) ??
          active.cwd ??
          null
        );
      }
      for (let i = tabs.length - 1; i >= 0; i--) {
        const t = tabs[i];
        if (t.kind !== "terminal") continue;
        const cwd = findLeafCwd(t.paneTree, t.activeLeafId) ?? t.cwd;
        if (cwd) return cwd;
      }
      return explorerRoot ?? launchCwd ?? home ?? null;
    };

    setLive({
      getCwd: findCwd,
      getTerminalContext: () => {
        // TDSF 魔改 (2026-08-09): SSH 终端优先——
        // SSH 场景下 WorkspaceSurface 用 SshTerminalHost 覆盖本地终端栈，
        // 但 activeId 对应的 tab 仍然是 terminal 类型（cold + SSH 接管）。
        // 如果不优先判断 SSH，会读到被 invisible 隐藏的本地终端 buffer。
        // 只有 SSH 终端没有内容时才回退到本地终端。
        const sshLeafId = ref.current.getSshLeafId?.();
        if (sshLeafId !== null && sshLeafId !== undefined) {
          const buf = terminalRefs.current.get(sshLeafId)?.getBuffer(300);
          if (buf) return redactSensitive(buf);
          // SSH leaf 存在但 buffer 还没准备好（刚连接），不回退本地
          return null;
        }
        // 本地终端（无 SSH 会话活跃时）
        const { activeId, tabs } = ref.current;
        const t = tabs.find((x) => x.id === activeId);
        if (t?.kind === "terminal") {
          if (t.private) return null;
          const buf = terminalRefs.current.get(t.activeLeafId)?.getBuffer(300);
          return buf ? redactSensitive(buf) : null;
        }
        return null;
      },
      isActiveTerminalPrivate: () => {
        const { activeId, tabs } = ref.current;
        const t = tabs.find((x) => x.id === activeId);
        return t?.kind === "terminal" && t.private === true;
      },
      injectIntoActivePty: (text) => {
        // TDSF 魔改 (2026-08-09): SSH 终端优先——
        // SSH 终端不在 tabs 数组里，原实现只查 tabs 导致 SSH 场景命令注入失败。
        // 优先通过 getSshLeafId 读 SSH 终端的 TerminalPaneHandle。
        const sshLeafId = ref.current.getSshLeafId?.();
        if (sshLeafId !== null && sshLeafId !== undefined) {
          const term = terminalRefs.current.get(sshLeafId);
          if (term) {
            term.write(text);
            term.focus();
            return true;
          }
          return false;
        }
        // 本地终端
        const { activeId, tabs } = ref.current;
        const t = tabs.find((x) => x.id === activeId);
        if (t?.kind !== "terminal") return false;
        const term = terminalRefs.current.get(t.activeLeafId);
        if (!term) return false;
        term.write(text);
        term.focus();
        return true;
      },
      getWorkspaceRoot: () => {
        const { explorerRoot, launchCwd, home } = ref.current;
        return explorerRoot ?? launchCwd ?? home ?? null;
      },
      getActiveFile: () => {
        const { activeId, tabs } = ref.current;
        const t = tabs.find((x) => x.id === activeId);
        return t?.kind === "editor" ? t.path : null;
      },
      openPreview: (url: string) => {
        ref.current.openPreviewTab(url);
        return true;
      },
      spawnManagedAgent: (prompt: string, sessionId: string) => {
        const trimmed = prompt.trim();
        if (!trimmed) return null;
        const oneLine = trimmed.replace(/\s*\r?\n\s*/g, " ");
        const cwd = findCwd();
        const short =
          oneLine.length > 32 ? `${oneLine.slice(0, 32)}…` : oneLine;
        const { tabId, leafId } = ref.current.newAgentTab(
          cwd ?? undefined,
          `claude · ${short}`,
        );
        useManagedAgentsStore
          .getState()
          .register({ leafId, tabId, sessionId, task: oneLine, cwd });
        const hooksReady = invoke("agent_enable_hooks", {
          agent: "claude",
        }).catch(() => {});
        void (async () => {
          await Promise.all([whenSessionReady(leafId), hooksReady]);
          if (!writeToSession(leafId, "claude\r")) {
            useManagedAgentsStore.getState().remove(leafId);
            return;
          }
          const readBuf = () => {
            const term = terminalRefs.current.get(leafId);
            return term ? term.getBuffer(120) : null;
          };
          const result = await waitForClaudeTuiReady(readBuf);
          if (result !== "ready") {
            if (result === "timeout") {
              console.warn(
                "[tdsf] Claude TUI did not appear in time; aborting prompt send",
              );
            }
            useManagedAgentsStore.getState().remove(leafId);
            return;
          }
          if (!writeToSession(leafId, `\x1b[200~${trimmed}\x1b[201~`)) {
            useManagedAgentsStore.getState().remove(leafId);
            return;
          }
          setTimeout(() => writeToSession(leafId, "\r"), 120);
          useManagedAgentsStore.getState().setPhase(leafId, "working");
        })();
        return { tabId, leafId };
      },
      readLeafBuffer: (leafId: number) => {
        const buf = terminalRefs.current.get(leafId)?.getBuffer(300);
        return buf ? redactSensitive(buf) : null;
      },
      // TDSF 魔改 2026-07-30: 暴露活跃 SSH 会话的 Rust session_id (u32)，
      // 供 Strands 运维工具通过 RustBridge 调 ssh_command / sftp_* 命令。
      // 取值逻辑与 useDocument.ts:getRustSessionId 一致：
      //   - 实时查询 sshStore（不缓存，SSH 重连后 rustSessionId 会变）
      //   - 仅返回 connected 且 rustSessionId 非 null 的会话
      // TDSF 修复 2026-08-01: activeSessionId 可能指向已删除的幽灵 session
      // （Space 持久化旧 UUID / 断连后未清理），此时回退到任意 connected
      // 会话，保证 AI 至少拿到一个可用的 ssh_session_id，而不是误判
      // "未连接 SSH" 而拒绝执行远程命令。
      getSshRustSessionId: () => {
        const state = useSshStore.getState();
        const active = state.sessions.find(
          (s) => s.id === state.activeSessionId,
        );
        if (active && isSessionConnected(active)) return active.rustSessionId;
        const fallback = state.sessions.find((s) => isSessionConnected(s));
        return fallback ? fallback.rustSessionId : null;
      },
    });
  }, [setLive, terminalRefs]);
}
