import { useManagedAgentsStore } from "@/modules/agents/store/managedAgentsStore";
import {
  isSessionConnected,
  selectSessionCurrentPath,
  useSshStore,
} from "@/modules/ssh-explorer/sshStore";
import type { Tab } from "@/modules/tabs";
import {
  findLeafCwd,
  getLeafBlockMode,
  ptyIdForLeaf,
  type TerminalPaneHandle,
  whenSessionReady,
  writeToSession,
} from "@/modules/terminal";
import { useTerminalBlocksStore } from "@/modules/terminal/lib/terminalBlocksStore";
import { isUserLineDirty } from "@/modules/terminal/lib/terminalInputState";
// 代码审查 H1：判断"终端此刻能不能安全接命令"要的是真实执行信号，不是 blockMode
// （blockMode 只在 blocks 视图里更新，普通标签与 SSH leaf 恒为 "prompt"）。
import { isLeafBusy } from "@/modules/terminal/lib/useTerminalSession";
import { isLeafAltScreen } from "@/modules/terminal/lib/rendererPool";
// 代码审查 H3：注入必须打在**可见 leaf 自己绑定的**那个 SSH 会话上，
// 而不是 sshStore.activeSessionId（在列表里点一下就会改它）。
import { getLeafSshSession } from "@/lib/param-complete-client";
import {
  matchesVisibleTerminalCommand,
  useTeachingExecutionStore,
} from "@/modules/terminal/lib/teachingExecutionStore";
import type { TerminalBlock } from "@/modules/terminal/lib/terminalBlocks";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { invoke } from "@tauri-apps/api/core";
import { toast } from "sonner";
import { type RefObject, useEffect, useRef } from "react";
import type { Live, EnvironmentProbe } from "../store/chatStore";
import { useChatStore } from "../store/chatStore";
import { redactSensitive } from "./redact";
// TDSF 2026-08-28 (B1-G2 防伪造): 拦截命令注入 AI 上下文
import {
  armAgentCommandEcho,
  clearAgentCommandEcho,
  getRecentBlockedCommandText,
} from "@/modules/terminal/lib/useTerminalSession";

// TDSF B2 (2026-08-29): Rust human_type 命令返回值（pty_write_human / ssh_write_human）
type HumanTypeReport = {
  mode: "human" | "fallback";
  stopped: boolean;
  warning?: string;
};

/** 给守卫的提示语用的终端名：本地终端取目录末段，拿不到就说"本地终端"。 */
function terminalLabelOf(cwd: string | null | undefined): string {
  if (!cwd) return "本地终端";
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : cwd;
}

/** TDSF B2 (2026-08-29): 8 项之 8 —— 超过此长度的命令自动整段注入（前端判断） */
type HumanTypingEventPayload = {
  phase: "start" | "end";
  target: "pty" | "ssh";
  id: number;
  mode: "human" | "fallback";
  stopped: boolean;
};

type VisibleTerminalRequest = {
  requestId: string;
  sessionId: number;
  command: string;
  timeoutMs: number;
  operationId?: string;
};

type PendingVisibleTerminalExecution = VisibleTerminalRequest & {
  leafId: number;
  requestedAt: number;
  phase: "typing" | "running";
  timeoutHandle: number | null;
};

// Rust caps long-command visual typing by duration; never replace a long
// command with an instant injection merely because of its character count.
const HUMAN_TYPING_MAX_LEN = Number.POSITIVE_INFINITY;

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
  wslDistro: string | null;
  openPreviewTab: (url: string) => void;
  newAgentTab: (
    cwd: string | undefined,
    title: string,
  ) => { tabId: number; leafId: number };
  terminalRefs: RefObject<Map<number, TerminalPaneHandle>>;
  /**
   * TDSF (2026-08-09): 获取 SSH 终端的 leafId。
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
    // TDSF B1 (2026-08-29): SSH Rust session_id 查询提为局部函数，
    // 供 getSshRustSessionId（setLive）与 getEnvironmentProbe 共用。
    // #107 (2026-09-22): 取值口径改成"先问命令会打进哪块终端，再问它绑的会话"，
    // 与 getActiveTerminalTarget / 注入路径同源。旧实现只认 `sshStore.activeSessionId`
    // （外加"随便挑一条已连接的"兜底），而 #89 之后"全局活跃会话"与"可见 leaf 绑的
    // 会话"可以是**两条不同机器的连接** —— 后果正是用户报的两件事：逐字模式按全局
    // 那条的 PTY 写字节（用户看的终端没有回显），等待却挂在可见 leaf 上（永远等不到
    // 那块 OSC 块）→ `[indeterminate] 可见终端在命令提交后等待超时`。
    // 可见终端不是 SSH（本地壳 / 没有终端标签页）时保持旧行为回落全局会话，
    // 免得把"agent 用不了 SSH"做成这次的副作用。
    const sshRustSessionId = (): number | null => {
      const { activeId, tabs } = ref.current;
      const tab = tabs.find((x) => x.id === activeId);
      const leafId =
        ref.current.getSshLeafId?.() ??
        (tab?.kind === "terminal" ? tab.activeLeafId : null);
      const bound =
        leafId === null || leafId === undefined
          ? null
          : getLeafSshSession(leafId);
      if (bound !== null) return bound;
      const state = useSshStore.getState();
      const active = state.sessions.find((s) => s.id === state.activeSessionId);
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
        // 逐字节的命令必须打进**可见 leaf 自己绑定的**那个会话。原先用
        // sshStore.activeSessionId 判定，而它会在 SSH 面板里"点一下另一台服务器"
        // 时就改变（SshExplorer onSelect=setActiveSession）→ 字节进 B 机、
        // 回显却挂在 A 机上（代码审查 H3）。leaf→会话注册表才是对的来源；
        // 取不到（未注册/已断开）就返回 false，回落本地整段路径。
        const sessionId = getLeafSshSession(sshLeafId);
        if (sessionId === null) return false;
        useTerminalBlocksStore.getState().markAgentPending(sshLeafId);
        armAgentCommandEcho(sshLeafId, t, { waitForPrompt: true });
        void invoke<HumanTypeReport>("ssh_write_human", {
          sessionId,
          text: t,
          speed,
        })
          .then((r) => {
            // 逐字 pump 启动 / sudo 降级整段，都标记 author=agent
            if (r?.mode === "fallback" && r.warning) toast.warning(r.warning);
          })
          .catch((e) => {
            useTerminalBlocksStore.getState().clearAgentPending(sshLeafId);
            clearAgentCommandEcho(sshLeafId);
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
      useTerminalBlocksStore.getState().markAgentPending(tab.activeLeafId);
      armAgentCommandEcho(tab.activeLeafId, t, { waitForPrompt: true });
      void invoke<HumanTypeReport>("pty_write_human", { id, text: t, speed })
        .then((r) => {
          if (r?.mode === "fallback" && r.warning) toast.warning(r.warning);
        })
        .catch((e) => {
          useTerminalBlocksStore
            .getState()
            .clearAgentPending(tab.activeLeafId);
          clearAgentCommandEcho(tab.activeLeafId);
          console.warn("[tdsf] pty_write_human failed, fallback:", e);
          if (!injectFnCore(t)) toast.error("命令注入失败：终端会话不可用");
        });
      return true;
    };

    const findCwd = () => {
      const { activeId, tabs, explorerRoot, launchCwd, home } = ref.current;
      // TDSF (2026-08-09): SSH 终端优先——
      // SSH 场景下 activeId 对应的 tab 是 cold + SSH 接管，
      // 但 findLeafCwd 会读到本地终端的 cwd（如 C:\Users\Lenovo）。
      // 优先从 sshStore 读 SSH 远端 cwd，避免 agent 收到错误的本地路径。
      const sshLeafId = ref.current.getSshLeafId?.();
      if (sshLeafId !== null && sshLeafId !== undefined) {
        // 优先从 sshStore 读**可见 leaf 那条会话**的远端 cwd。
        // #107 同源横扫：这里原先直接吃 `sshState.activeSessionId`，而会话号
        // （sshRustSessionId）已经改成按 leaf 解析 —— 两边不同源就会让 agent
        // 拿到"B 机的会话号 + A 机的当前目录"，比修之前更糟，所以一起跟上。
        // leaf 注册表取不到（未注册/已断开）时仍退回全局活跃会话，保持旧行为。
        const sshState = useSshStore.getState();
        const bound = getLeafSshSession(sshLeafId);
        const session =
          (bound === null
            ? undefined
            : sshState.sessions.find((s) => s.rustSessionId === bound)) ??
          sshState.sessions.find((s) => s.id === sshState.activeSessionId);
        const cwd = selectSessionCurrentPath(sshState, session?.id);
        if (cwd) return cwd;
        // currentPath 未就绪时回退到 home 或 root
        return session?.params?.user ? `/home/${session.params.user}` : "/";
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

    /**
     * 教学执行必须有可见且已绑定 xterm 的终端 leaf；仅有 SSH 连接而没有
     * 可见终端时 fail-closed，不能把命令悄悄写入后台会话后又无法取证。
     */
    const getTeachingTerminalLeafId = (): number | null => {
      const sshLeafId = ref.current.getSshLeafId?.();
      if (sshLeafId !== null && sshLeafId !== undefined) {
        return terminalRefs.current.has(sshLeafId) ? sshLeafId : null;
      }
      const { activeId, tabs } = ref.current;
      const tab = tabs.find((x) => x.id === activeId);
      if (tab?.kind !== "terminal") return null;
      return terminalRefs.current.has(tab.activeLeafId)
        ? tab.activeLeafId
        : null;
    };

    // TDSF (2026-08-09): 整段注入核心逻辑（B2 起作为打字机失败时的回落路径）。
    const injectFnCore = (t: string): boolean => {
      const sshLeafId = ref.current.getSshLeafId?.();
      if (sshLeafId !== null && sshLeafId !== undefined) {
        const term = terminalRefs.current.get(sshLeafId);
        if (term) {
          useTerminalBlocksStore.getState().markAgentPending(sshLeafId);
          armAgentCommandEcho(sshLeafId, t);
          term.write(t);
          term.focus();
          return true;
        }
        return false;
      }
      const { activeId, tabs } = ref.current;
      const tab = tabs.find((x) => x.id === activeId);
      if (tab?.kind !== "terminal") return false;
      const term = terminalRefs.current.get(tab.activeLeafId);
      if (!term) return false;
      useTerminalBlocksStore.getState().markAgentPending(tab.activeLeafId);
      armAgentCommandEcho(tab.activeLeafId, t);
      term.write(t);
      term.focus();
      return true;
    };

    setLive({
      getCwd: findCwd,
      getTerminalContext: (maxLines = 300) => {
        const requestedLines = Math.max(1, Math.min(Math.trunc(maxLines), 2000));
        // TDSF (2026-08-09): SSH 终端优先——
        // 2026-08-11 (#21): SSH leaf 已进入 tab.paneTree，active tab 的 activeLeafId
        // 就是当前 pane；getSshLeafId 返回其 leafId（会话 connected 时）。
        // 优先读 SSH 终端的 scrollback，无内容时回退本地终端。
        // TDSF 2026-08-28 (B1-G2 防伪造): 尾部追加"最近被拦截命令"提示，
        // 让 LLM 知道该命令未执行，防止编造执行结果（见 useTerminalSession）。
        const appendBlockedHint = (ctx: string): string => {
          const blocked = getRecentBlockedCommandText();
          return blocked
            ? `${ctx}\n[TDSF] 最近被安全拦截的命令（未执行）: ${blocked}`
            : ctx;
        };
        const sshLeafId = ref.current.getSshLeafId?.();
        if (sshLeafId !== null && sshLeafId !== undefined) {
          const buf = terminalRefs.current.get(sshLeafId)?.getBuffer(requestedLines);
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
          const buf = terminalRefs.current.get(t.activeLeafId)?.getBuffer(requestedLines);
          return buf ? appendBlockedHint(redactSensitive(buf)) : null;
        }
        return null;
      },
      isActiveTerminalPrivate: () => {
        const { activeId, tabs } = ref.current;
        const t = tabs.find((x) => x.id === activeId);
        return t?.kind === "terminal" && t.private === true;
      },
      /**
       * 自动打字（无人点击）是否安全。命令卡渲染即注入，必须避开三种情况：
       * Private 终端、用户正在敲的半行、以及不在提示符（程序正在运行）的终端。
       * 手动 Run 不调用本函数——那是用户明示动作。
       */
      canAutoTypeToActiveTerminal: () => {
        const { activeId, tabs } = ref.current;
        const tab = tabs.find((x) => x.id === activeId);
        const sshLeafId = ref.current.getSshLeafId?.();
        const leafId =
          sshLeafId ??
          (tab?.kind === "terminal" ? tab.activeLeafId : null);
        if (leafId === null || leafId === undefined) return false;
        if (tab?.kind === "terminal" && tab.private === true) return false;
        if (isUserLineDirty(leafId)) return false;
        // 代码审查 M2：上一条 agent 打进去的命令还停在提示符没结算时，绝不能再打
        // 第二条 —— 同一条回复里的两张卡（工具卡 + 代码块）可能分属两次 commit，
        // 只靠"同一批次放行一张"拦不住，整段注入会把两条拼成一行。
        // agentPending 正是"这条已打出、尚未提交/结算"的现成领域信号。
        if (
          useTerminalBlocksStore.getState().agentPending[leafId] !== undefined
        )
          return false;
        // 代码审查 H1：这道"在提示符"的臂此前是死的 —— blockMode 只在 blocks 视图
        // 里被更新，普通标签与 SSH leaf 恒为 "prompt"。真正在跑什么要问执行信号：
        // 命令执行中、或程序占着备用屏（top / vim / mysql>）时都不能往里打字。
        // 未知 leaf 两个信号都返回 false → 仍然 fail-open，不会静默废掉自动打字。
        if (isLeafBusy(leafId) || isLeafAltScreen(leafId)) return false;
        return getLeafBlockMode(leafId) === "prompt";
      },
      /**
       * #91 第⑤条：命令卡首次渲染时记下"这条命令是给哪一条终端的"。
       * 取值口径与真正的注入路径完全一致（可见 leaf + leaf→会话注册表），
       * 否则守卫会拦错人或放错人。
       */
      getActiveTerminalTarget: () => {
        const { activeId, tabs } = ref.current;
        const tab = tabs.find((x) => x.id === activeId);
        if (tab?.kind !== "terminal") return null;
        const sshLeafId = ref.current.getSshLeafId?.();
        const leafId = sshLeafId ?? tab.activeLeafId;
        const sshRustSessionId = getLeafSshSession(leafId);
        const session =
          sshRustSessionId === null
            ? undefined
            : useSshStore
                .getState()
                .sessions.find((s) => s.rustSessionId === sshRustSessionId);
        const label = session
          ? `${session.params.user}@${session.params.host}`
          : terminalLabelOf(findLeafCwd(tab.paneTree, leafId) ?? tab.cwd);
        return { tabId: tab.id, leafId, sshRustSessionId, label };
      },
      injectIntoActivePty: (text) => {
        // TDSF B2 (2026-08-29): 逐字模式优先（tryHumanTyping），不适用或调用
        // 失败时回落整段注入 injectFnCore（打字机 → 整段，原路径零改动）。
        return tryHumanTyping(text) ? true : injectFnCore(text);
      },
      startTeachingCommand: (command) => {
        const leafId = getTeachingTerminalLeafId();
        if (leafId === null) {
          return { ok: false as const, reason: "no-active-terminal" as const };
        }
        // 先登记再写入：即使极快命令在同一事件循环内完成，也不会错过 block。
        const executionId = useTeachingExecutionStore.getState().begin({
          leafId,
          command,
        });
        if (!executionId) {
          return { ok: false as const, reason: "terminal-busy" as const };
        }
        const text = command.endsWith("\n") ? command : `${command}\n`;
        const injected = tryHumanTyping(text) || injectFnCore(text);
        if (!injected) {
          useTeachingExecutionStore.getState().cancel(executionId);
          return {
            ok: false as const,
            reason: "terminal-unavailable" as const,
          };
        }
        return { ok: true as const, executionId };
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
      // TDSF 2026-07-30: 暴露活跃 SSH 会话的 Rust session_id (u32)，
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
          return useTerminalBlocksStore
            .getState()
            .getRecent(t.activeLeafId, 10);
        }
        return [];
      },
      // TDSF 2026-08-31 (问题1修复): 当前是否有活动终端会话（权威信号）。
      // "ssh"=SSH 终端活跃 / "local"=本地终端 tab 活跃 / null=无任何终端会话。
      // workspace cwd（explorerRoot/launchCwd/home 回退）存在 ≠ 终端已打开——
      // 无终端时 transport 据此把 connection_mode 标为 none（而非误报 local）。
      // 判定逻辑与 getTerminalContext 的活跃终端判定保持一致（SSH 优先）。
      getActiveTerminalSession: (): "ssh" | "local" | "wsl" | null => {
        const sshLeafId = ref.current.getSshLeafId?.();
        if (sshLeafId !== null && sshLeafId !== undefined) return "ssh";
        const { activeId, tabs } = ref.current;
        const t = tabs.find((x) => x.id === activeId);
        return t?.kind === "terminal"
          ? ref.current.wslDistro
            ? "wsl"
            : "local"
          : null;
      },
      getWslDistro: () => ref.current.wslDistro,
    });

    // 可视终端执行（"visible-terminal" 通道）的待回执台账：每条命令等前端
    // 终端 OSC 块结束后结算，避免与后台 execute_via_ssh 结果串位。
    const pendingVisibleExecutions = new Map<
      string,
      PendingVisibleTerminalExecution
    >();

    const settleVisibleExecution = (
      pending: PendingVisibleTerminalExecution,
      result: Record<string, unknown>,
    ) => {
      if (!pendingVisibleExecutions.delete(pending.requestId)) return;
      useTerminalBlocksStore.getState().clearAgentPending(pending.leafId);
      if (pending.timeoutHandle !== null) {
        window.clearTimeout(pending.timeoutHandle);
      }
      void invoke("sidecar_visible_terminal_response", {
        requestId: pending.requestId,
        result: {
          operationId: pending.operationId ?? "",
          command: pending.command,
          ...result,
        },
      }).catch((e) => {
        console.warn("[tdsf] visible terminal response failed:", e);
      });
    };

    const markVisibleExecutionRunning = (
      pending: PendingVisibleTerminalExecution,
    ) => {
      if (pending.phase !== "typing") return;
      pending.phase = "running";
    };

    const armVisibleExecutionTimeout = (
      pending: PendingVisibleTerminalExecution,
    ) => {
      if (pending.timeoutHandle !== null) return;
      const timeoutMs = Math.min(Math.max(pending.timeoutMs, 1_000), 300_000);
      pending.timeoutHandle = window.setTimeout(() => {
        settleVisibleExecution(pending, {
          status: "timed_out",
          reason: "visible_terminal_timeout",
        });
      }, timeoutMs);
    };

    const settleVisibleTerminalBlock = (
      pending: PendingVisibleTerminalExecution,
      block: TerminalBlock,
    ): boolean => {
      if (
        pending.phase !== "running" ||
        !matchesVisibleTerminalCommand(pending, block)
      ) {
        return false;
      }
      if (block.exitCode === null) {
        settleVisibleExecution(pending, {
          status: "indeterminate",
          reason: "visible_terminal_missing_exit_code",
        });
      } else {
        settleVisibleExecution(pending, {
          status: "success",
          exitCode: block.exitCode,
          output: redactSensitive(block.outputTail),
          truncated: Boolean(block.outputTruncated),
          duration: block.durationMs / 1_000,
          cwd: block.cwd,
        });
      }
      return true;
    };

    const reconcileVisibleExecution = (
      pending: PendingVisibleTerminalExecution,
    ) => {
      // A command can complete between foreground input and the next store
      // notification. Check every completed block, not merely the latest one.
      const blocks =
        useTerminalBlocksStore.getState().blocksByLeaf[pending.leafId] ?? [];
      for (let index = blocks.length - 1; index >= 0; index -= 1) {
        if (settleVisibleTerminalBlock(pending, blocks[index])) return;
      }
    };

    const startVisibleExecutionTimer = (
      pending: PendingVisibleTerminalExecution,
    ) => {
      armVisibleExecutionTimeout(pending);
      reconcileVisibleExecution(pending);
    };

    const startVisibleTerminalExecution = (
      request: VisibleTerminalRequest,
    ) => {
      const currentSessionId = sshRustSessionId();
      const leafId = ref.current.getSshLeafId?.();
      const terminal =
        leafId === null || leafId === undefined
          ? undefined
          : terminalRefs.current.get(leafId);
      const reject = (reason: string, message: string) => {
        void invoke("sidecar_visible_terminal_response", {
          requestId: request.requestId,
          result: {
            status: "unavailable",
            reason,
            message,
            command: request.command,
            operationId: request.operationId ?? "",
          },
        }).catch((e) => {
          console.warn("[tdsf] visible terminal rejection failed:", e);
        });
      };
      if (
        request.requestId &&
        request.command &&
        usePreferencesStore.getState().agentExecutionChannel !==
          "visible-terminal"
      ) {
        void invoke("sidecar_visible_terminal_response", {
          requestId: request.requestId,
          result: {
            status: "reroute",
            reason: "execution_channel_changed",
            channel: "background",
            message: "执行通道已切换为后台 SSH，命令未写入可见终端。",
            command: request.command,
            operationId: request.operationId ?? "",
          },
        }).catch((e) => {
          console.warn("[tdsf] visible terminal reroute failed:", e);
        });
        return;
      }
      if (
        !request.requestId ||
        !request.command ||
        currentSessionId === null ||
        currentSessionId !== request.sessionId ||
        leafId === null ||
        leafId === undefined ||
        !terminal
      ) {
        reject(
          "visible_terminal_unavailable",
          "当前没有与该 SSH 会话匹配的可见终端，命令未执行。",
        );
        return;
      }
      if (getLeafBlockMode(leafId) !== "prompt") {
        reject(
          "visible_terminal_busy",
          "可见终端当前不在提示符，命令未写入，以免打断正在运行的任务。",
        );
        return;
      }
      if (
        [...pendingVisibleExecutions.values()].some(
          (pending) => pending.leafId === leafId,
        )
      ) {
        reject(
          "visible_terminal_busy",
          "可见终端正在等待另一条命令的真实结果；为避免乱序，本命令未执行。",
        );
        return;
      }

      const pending: PendingVisibleTerminalExecution = {
        ...request,
        leafId,
        requestedAt: Date.now(),
        phase: "typing",
        timeoutHandle: null,
      };
      pendingVisibleExecutions.set(request.requestId, pending);
      const text = request.command.endsWith("\n")
        ? request.command
        : `${request.command}\n`;
      const prefs = usePreferencesStore.getState();
      if (prefs.agentTypingMode !== "human") {
        // `terminal.write` immediately hands bytes to the SSH PTY. Enable
        // correlation first so a fast command cannot finish in that gap.
        markVisibleExecutionRunning(pending);
        useTerminalBlocksStore.getState().markAgentPending(leafId);
        armAgentCommandEcho(leafId, text);
        terminal.write(text);
        terminal.focus();
        // The timer starts only after the final Enter has been submitted.
        startVisibleExecutionTimer(pending);
        return;
      }

      useTerminalBlocksStore.getState().markAgentPending(leafId);
      armAgentCommandEcho(leafId, text, { waitForPrompt: true });
      void invoke<HumanTypeReport>("ssh_write_human", {
        sessionId: request.sessionId,
        text,
        speed: prefs.agentTypingSpeed,
      })
        .then((report) => {
          if (report.mode === "fallback") {
            markVisibleExecutionRunning(pending);
            startVisibleExecutionTimer(pending);
          }
        })
        .catch((e) => {
          clearAgentCommandEcho(leafId);
          console.warn("[tdsf] visible terminal typing failed:", e);
          settleVisibleExecution(pending, {
            status: "unavailable",
            reason: "visible_terminal_injection_failed",
            message: "可见终端输入未能启动，命令未改走后台执行。",
          });
        });
    };

    const unlistenVisibleBlocks = useTerminalBlocksStore.subscribe((state) => {
      for (const pending of pendingVisibleExecutions.values()) {
        const blocks = state.blocksByLeaf[pending.leafId] ?? [];
        for (let index = blocks.length - 1; index >= 0; index -= 1) {
          if (settleVisibleTerminalBlock(pending, blocks[index])) break;
        }
      }
    });

    let unlistenVisibleExecution: (() => void) | null = null;
    let unlistenHumanTyping: (() => void) | null = null;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      // The typing-complete listener must exist before accepting a visible
      // request. Registering both in parallel can lose the end event for a
      // short typewriter command and leave its SSH result waiting forever.
      unlistenHumanTyping = await listen<HumanTypingEventPayload>(
        "terminal:human_typing",
        (event) => {
          const typing = event.payload;
          if (typing.phase !== "end" || typing.target !== "ssh") return;
          for (const pending of pendingVisibleExecutions.values()) {
            if (
              pending.phase !== "typing" ||
              pending.sessionId !== typing.id
            ) {
              continue;
            }
            if (typing.stopped) {
              clearAgentCommandEcho(pending.leafId);
              settleVisibleExecution(pending, {
                status: "interrupted",
                reason: "visible_terminal_typing_interrupted",
              });
            } else {
              markVisibleExecutionRunning(pending);
              startVisibleExecutionTimer(pending);
            }
          }
        },
      );
      unlistenVisibleExecution = await listen<VisibleTerminalRequest>(
        "sidecar:visible-terminal-execute",
        (event) => startVisibleTerminalExecution(event.payload),
      );
    })().catch((e) => {
      console.warn("[tdsf] visible terminal listeners failed:", e);
    });

    // #71：sidecar:inject_terminal 监听已整体下线 —— 发送端（`ssh_command.py` 的
    // `if False:` 死块）删掉了，用户可见执行统一走 visible-terminal 通道
    // （sidecar:visible-terminal-execute），不再留第二条注入路径。

    // TDSF (2026-08-09): 监听 sidecar update_todos notification
    // Python todo_write 工具 → rust_bridge notification → Rust 转发 → 这里更新 TodoStore
    let unlistenTodos: (() => void) | null = null;
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const { useTodosStore } = await import("../store/todoStore");
      unlistenTodos = await listen<{
        sessionId: string;
        // T3 (2026-08-31): completedAt 完成时间由 Python todo_write 自动维护
        todos: Array<{
          id: string;
          title: string;
          description?: string;
          status: string;
          completedAt?: string | null;
        }>;
      }>("sidecar:update_todos", (event) => {
        const { sessionId, todos } = event.payload;
        if (!sessionId || !Array.isArray(todos)) return;
        useTodosStore.getState().setTodos(sessionId, todos as never);
      });
    })().catch((e) => {
      console.warn("[tdsf] update_todos listen failed:", e);
    });

    // TDSF 2026-08-28 (B1-F0): 响应 sidecar 的终端 scrollback 请求
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
        const { requestId, lines } = event.payload;
        if (!requestId) return;
        const live = useChatStore.getState().live;
        const output = live?.getTerminalContext?.(lines) ?? "";
        const available = live?.getActiveTerminalSession?.() != null;
        void invoke("sidecar_scrollback_response", {
          requestId,
          output: output ?? "",
          available,
        }).catch((e) => {
          console.warn("[tdsf] scrollback response failed:", e);
        });
      });
    })().catch((e) => {
      console.warn("[tdsf] scrollback listen failed:", e);
    });

    return () => {
      unlistenVisibleBlocks();
      unlistenVisibleExecution?.();
      unlistenHumanTyping?.();
      for (const pending of pendingVisibleExecutions.values()) {
        if (pending.timeoutHandle !== null) {
          window.clearTimeout(pending.timeoutHandle);
        }
        useTerminalBlocksStore.getState().clearAgentPending(pending.leafId);
      }
      pendingVisibleExecutions.clear();
      if (unlistenTodos) unlistenTodos();
      if (unlistenScrollback) unlistenScrollback();
    };
  }, [setLive, terminalRefs]);
}
