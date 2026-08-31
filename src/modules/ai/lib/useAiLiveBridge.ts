import { useManagedAgentsStore } from "@/modules/agents/store/managedAgentsStore";
import { isSessionConnected, selectSessionCurrentPath, useSshStore } from "@/modules/ssh-explorer/sshStore";
import type { Tab } from "@/modules/tabs";
import {
  findLeafCwd,
  ptyIdForLeaf,
  type TerminalPaneHandle,
  whenSessionReady,
  writeToSession,
} from "@/modules/terminal";
import { useTerminalBlocksStore } from "@/modules/terminal/lib/terminalBlocksStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { type RefObject, useEffect, useRef } from "react";
import type { Live, EnvironmentProbe } from "../store/chatStore";
import { useChatStore } from "../store/chatStore";
import { redactSensitive } from "./redact";
// TDSF 魔改 2026-08-28 (B1-G2 防伪造): 拦截命令注入 AI 上下文
import { getRecentBlockedCommandText } from "@/modules/terminal/lib/useTerminalSession";

// TDSF B2 (2026-08-29): Rust human_type 命令返回值（pty_write_human / ssh_write_human）
type HumanTypeReport = {
  mode: "human" | "fallback";
  stopped: boolean;
  warning?: string;
};

/** TDSF B2 (2026-08-29): 8 项之 8 —— 超过此长度的命令自动整段注入（前端判断） */
const HUMAN_TYPING_MAX_LEN = 200;

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

    // TDSF B1 (2026-08-29): SSH Rust session_id 查询提为局部函数，
    // 供 getSshRustSessionId（setLive）与 getEnvironmentProbe 共用。
    // 取值逻辑与原 inline 实现一致（实时查 sshStore，SSH 重连后 rustSessionId 会变）。
    const sshRustSessionId = (): number | null => {
      const state = useSshStore.getState();
      const active = state.sessions.find(
        (s) => s.id === state.activeSessionId,
      );
      if (active && isSessionConnected(active)) return active.rustSessionId;
      const fallback = state.sessions.find((s) => isSessionConnected(s));
      return fallback ? fallback.rustSessionId : null;
    };

    // TDSF B2 (2026-08-29): 可视教学打字机分流 —— 设置为"逐字演示"时，
    // 命令交由 Rust human_type pump 按人味节奏逐字写入 PTY/SSH channel
    // （远端 echo 天然形成打字视觉）。失败/不适用时返回 false 回落整段。
    // 警告（`!` 告警 / sudo 降级提示）统一由 terminal:human_typing end 事件
    // 的 toast 处理（AgentTypingIndicator），避免与 report 重复弹。
    const tryHumanTyping = (t: string): boolean => {
      const prefs = usePreferencesStore.getState();
      if (prefs.agentTypingMode !== "human") return false;
      // 8 项之 8：超长命令自动整段 + toast 提示
      if (t.length > HUMAN_TYPING_MAX_LEN) {
        toast(`命令过长（${t.length} 字符），已整段注入`, {
          description: "可在 设置 → 智能体 → 可视执行演示 调整打字模式",
        });
        return false;
      }
      const speed = prefs.agentTypingSpeed;
      const sshLeafId = ref.current.getSshLeafId?.();
      if (sshLeafId !== null && sshLeafId !== undefined) {
        const sessionId = sshRustSessionId();
        if (sessionId === null) return false;
        void invoke<HumanTypeReport>("ssh_write_human", {
          sessionId,
          text: t,
          speed,
        })
          .then((r) => {
            // 逐字 pump 启动 / sudo 降级整段，都标记 author=agent
            useTerminalBlocksStore.getState().markAgentPending(sshLeafId);
            if (r?.mode === "fallback" && r.warning) toast.warning(r.warning);
          })
          .catch((e) => {
            console.warn("[tdsf] ssh_write_human failed, fallback:", e);
            if (!injectFnCore(t)) toast.error("命令注入失败：SSH 终端不可用");
          });
        return true;
      }
      const { activeId, tabs } = ref.current;
      const tab = tabs.find((x) => x.id === activeId);
      if (tab?.kind !== "terminal") return false;
      const id = ptyIdForLeaf(tab.activeLeafId);
      if (id === null) return false;
      void invoke<HumanTypeReport>("pty_write_human", { id, text: t, speed })
        .then((r) => {
          useTerminalBlocksStore.getState().markAgentPending(tab.activeLeafId);
          if (r?.mode === "fallback" && r.warning) toast.warning(r.warning);
        })
        .catch((e) => {
          console.warn("[tdsf] pty_write_human failed, fallback:", e);
          if (!injectFnCore(t)) toast.error("命令注入失败：终端会话不可用");
        });
      return true;
    };

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

    // TDSF 魔改 (2026-08-09): 整段注入核心逻辑（inject_terminal 事件与
    // injectIntoActivePty 共用；B2 起也作为打字机失败时的回落路径）。
    const injectFnCore = (t: string): boolean => {
      const sshLeafId = ref.current.getSshLeafId?.();
      if (sshLeafId !== null && sshLeafId !== undefined) {
        const term = terminalRefs.current.get(sshLeafId);
        if (term) {
          term.write(t); term.focus();
          // TDSF B1 (2026-08-29): agent 注入的命令 → 下一条 block 标 author=agent
          useTerminalBlocksStore.getState().markAgentPending(sshLeafId);
          return true;
        }
        return false;
      }
      const { activeId, tabs } = ref.current;
      const tab = tabs.find((x) => x.id === activeId);
      if (tab?.kind !== "terminal") return false;
      const term = terminalRefs.current.get(tab.activeLeafId);
      if (!term) return false;
      term.write(t); term.focus();
      // TDSF B1 (2026-08-29): 同上（本地终端注入路径）
      useTerminalBlocksStore.getState().markAgentPending(tab.activeLeafId);
      return true;
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
        // TDSF B2 (2026-08-29): 逐字模式优先分流（tryHumanTyping），不适用或
        // 调用失败时回落整段注入（injectFnCore，原路径零改动）。
        injectFn = (t: string) => (tryHumanTyping(t) ? true : injectFnCore(t));
        return injectFn(text);
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
      getSshRustSessionId: sshRustSessionId,
      // TDSF B1 (2026-08-29): 环境探测（os-release/内核/shell）。
      // sidecar system.probe_env 会话级缓存（首探测后毫秒级返回）；
      // 前端加 5s 超时与异常降级——探测失败绝不阻塞对话，只是少了
      // <environment> 分区（agent 退化为不知道发行版）。
      getEnvironmentProbe: async () => {
        try {
          const res = await Promise.race([
            invoke<EnvironmentProbe>("ipc_invoke", {
              method: "system.probe_env",
              params: { sessionId: "", sshSessionId: sshRustSessionId() },
            }),
            new Promise<null>((resolve) =>
              setTimeout(() => resolve(null), 5000),
            ),
          ]);
          if (!res || res.ok === false) return null;
          return res;
        } catch (e) {
          // sidecar 未就绪 / 超时：静默降级（不阻塞对话）
          console.warn("[tdsf] system.probe_env failed (degraded):", e);
          return null;
        }
      },
      // TDSF B1 (2026-08-29): 活跃终端最近 10 条 block 流水账。
      // SSH 优先（与 getTerminalContext 的活跃终端判定一致）；
      // private 终端不注入（隐私模式，与 getTerminalContext 对齐）。
      getTerminalHistory: () => {
        const sshLeafId = ref.current.getSshLeafId?.();
        if (sshLeafId !== null && sshLeafId !== undefined) {
          return useTerminalBlocksStore.getState().getRecent(sshLeafId, 10);
        }
        const { activeId, tabs } = ref.current;
        const t = tabs.find((x) => x.id === activeId);
        if (t?.kind === "terminal") {
          if (t.private) return [];
          return useTerminalBlocksStore.getState().getRecent(t.activeLeafId, 10);
        }
        return [];
      },
      // TDSF 2026-08-31 (问题1修复): 当前是否有活动终端会话（权威信号）。
      // "ssh"=SSH 终端活跃 / "local"=本地终端 tab 活跃 / null=无任何终端会话。
      // workspace cwd（explorerRoot/launchCwd/home 回退）存在 ≠ 终端已打开——
      // 无终端时 transport 据此把 connection_mode 标为 none（而非误报 local）。
      // 判定逻辑与 getTerminalContext 的活跃终端判定保持一致（SSH 优先）。
      getActiveTerminalSession: (): "ssh" | "local" | null => {
        const sshLeafId = ref.current.getSshLeafId?.();
        if (sshLeafId !== null && sshLeafId !== undefined) return "ssh";
        const { activeId, tabs } = ref.current;
        const t = tabs.find((x) => x.id === activeId);
        return t?.kind === "terminal" ? "local" : null;
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
