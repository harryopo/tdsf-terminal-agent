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
import { useChatStore } from "../store/chatStore";
import { redactSensitive } from "./redact";
// TDSF 魔改 2026-08-28 (B1-G2 防伪造): 拦截命令注入 AI 上下文
import { getRecentBlockedCommandText } from "@/modules/terminal/lib/useTerminalSession";

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
   * 2026-08-11 (#21): SSH leaf 已进入 tab.paneTree（PaneTreeView 渲染），
   * leafId 由 App 层从 active tab + active leaf 派生（会话 connected 才有效）。
   * getTerminalContext 用它回退读取 SSH 终端的 scrollback。
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
    // TDSF 魔改 (2026-08-09): 保存 injectIntoActivePty 引用，供 inject_terminal 事件监听器调用
    let injectFn: (text: string) => boolean = () => false;

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
        // 2026-08-11 (#21): SSH leaf 已进入 tab.paneTree，active tab 的 activeLeafId
        // 就是当前 pane；getSshLeafId 返回其 leafId（会话 connected 时）。
        // 优先读 SSH 终端的 scrollback，无内容时回退本地终端。
        // TDSF 魔改 2026-08-28 (B1-G2 防伪造): 尾部追加"最近被拦截命令"提示，
        // 让 LLM 知道该命令未执行，防止编造执行结果（见 useTerminalSession）。
        const appendBlockedHint = (ctx: string): string => {
          const blocked = getRecentBlockedCommandText();
          return blocked
            ? `${ctx}\n[TDSF] 最近被安全拦截的命令（未执行）: ${blocked}`
            : ctx;
        };
        const sshLeafId = ref.current.getSshLeafId?.();
        if (sshLeafId !== null && sshLeafId !== undefined) {
          const buf = terminalRefs.current.get(sshLeafId)?.getBuffer(300);
          if (buf) return appendBlockedHint(redactSensitive(buf));
          // SSH leaf 存在但 buffer 还没准备好（刚连接），不回退本地；
          // 仍注入拦截提示（若存在）——命令被拦截时终端无新输出，AI 也能感知
          const blockedOnly = getRecentBlockedCommandText();
          return blockedOnly
            ? `[TDSF] 最近被安全拦截的命令（未执行）: ${blockedOnly}`
            : null;
        }
        // 本地终端（无 SSH 会话活跃时）
        const { activeId, tabs } = ref.current;
        const t = tabs.find((x) => x.id === activeId);
        if (t?.kind === "terminal") {
          if (t.private) return null;
          const buf = terminalRefs.current.get(t.activeLeafId)?.getBuffer(300);
          return buf ? appendBlockedHint(redactSensitive(buf)) : null;
        }
        return null;
      },
      isActiveTerminalPrivate: () => {
        const { activeId, tabs } = ref.current;
        const t = tabs.find((x) => x.id === activeId);
        return t?.kind === "terminal" && t.private === true;
      },
      injectIntoActivePty: (text) => {
        // TDSF 魔改 (2026-08-09): 提取核心注入逻辑为共享函数，
        // 同时供 inject_terminal 事件监听器复用。
        const injectCore = (t: string): boolean => {
          const sshLeafId = ref.current.getSshLeafId?.();
          if (sshLeafId !== null && sshLeafId !== undefined) {
            const term = terminalRefs.current.get(sshLeafId);
            if (term) { term.write(t); term.focus(); return true; }
            return false;
          }
          const { activeId, tabs } = ref.current;
          const tab = tabs.find((x) => x.id === activeId);
          if (tab?.kind !== "terminal") return false;
          const term = terminalRefs.current.get(tab.activeLeafId);
          if (!term) return false;
          term.write(t); term.focus(); return true;
        };
        injectFn = injectCore; // 保存引用供 sidecar:inject_terminal 事件复用
        return injectCore(text);
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

    // TDSF 魔改 (2026-08-09): 监听 sidecar inject_terminal notification
    // 当 ssh_command(visible=True) 时，Python sidecar 发 notification → Rust 转发为
    // sidecar:inject_terminal 事件 → 这里监听并注入到前端终端（用户可见）
    let unlistenInject: (() => void) | null = null;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlistenInject = await listen<{ command: string; sessionId?: string }>(
        "sidecar:inject_terminal",
        (event) => {
          const { command } = event.payload;
          if (!command) return;
          // 终端执行模式开启时加换行符自动执行
          const autoExec = useChatStore.getState().autoExecuteInTerminal;
          const text = autoExec ? command + "\n" : command;
          // 复用 injectIntoActivePty 逻辑（SSH 优先 + 本地回退）
          injectFn(text);
        },
      );
    })().catch((e) => {
      console.warn("[tdsf] inject_terminal listen failed:", e);
    });

    // TDSF 魔改 (2026-08-09): 监听 sidecar update_todos notification
    // Python todo_write 工具 → rust_bridge notification → Rust 转发 → 这里更新 TodoStore
    let unlistenTodos: (() => void) | null = null;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const { useTodosStore } = await import("../store/todoStore");
      unlistenTodos = await listen<{
        sessionId: string;
        todos: Array<{ id: string; title: string; description?: string; status: string }>;
      }>("sidecar:update_todos", (event) => {
        const { sessionId, todos } = event.payload;
        if (!sessionId || !Array.isArray(todos)) return;
        useTodosStore.getState().setTodos(sessionId, todos as never);
      });
    })().catch((e) => {
      console.warn("[tdsf] update_todos listen failed:", e);
    });

    // TDSF 魔改 2026-08-28 (B1-F0): 响应 sidecar 的终端 scrollback 请求
    // Python get_terminal_output 工具 → rust_bridge.ipc_invoke("get_terminal_scrollback")
    // → Rust emit 本事件 → 这里读 getTerminalContext()（redact+SSH 优先+private 检查）
    // → invoke("sidecar_scrollback_response") 回传 → Rust oneshot resolve → Python。
    // 复用上方闭包的 getTerminalContext：从 live 对象取（setLive 已注册）。
    let unlistenScrollback: (() => void) | null = null;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlistenScrollback = await listen<{
        requestId: string;
        lines: number;
      }>("sidecar:get-terminal-scrollback", (event) => {
        const { requestId } = event.payload;
        if (!requestId) return;
        const live = useChatStore.getState().live;
        const output = live?.getTerminalContext?.() ?? "";
        void invoke("sidecar_scrollback_response", {
          requestId,
          output: output ?? "",
        }).catch((e) => {
          console.warn("[tdsf] scrollback response failed:", e);
        });
      });
    })().catch((e) => {
      console.warn("[tdsf] scrollback listen failed:", e);
    });

    return () => {
      if (unlistenInject) unlistenInject();
      if (unlistenTodos) unlistenTodos();
      if (unlistenScrollback) unlistenScrollback();
    };
  }, [setLive, terminalRefs]);
}
