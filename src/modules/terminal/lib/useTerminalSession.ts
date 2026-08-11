// TDSF 魔改: 接入 RiskEngine 前端拦截 (T2.2)
// 命令提交前调 evaluateRiskSync 快速拦截 L3+ 命令，命中后暂存并触发 listeners，
// UI 层订阅 pendingRiskCommand 弹出 RiskGuardDialog，用户确认后才执行。
// TDSF 2026-07-31: invalidate vite transform cache (Phase 2 remote cwd fix)

import { ensureMonoFontsLoaded } from "@/lib/fonts";
import type { RiskRpcAssessment } from "@/lib/risk-engine/riskClient";
import { evaluateRisk, evaluateRiskSync } from "@/lib/risk-engine/riskClient";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { invoke } from "@tauri-apps/api/core";
import type { SearchAddon } from "@xterm/addon-search";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  BlockDecorations,
  type BlockMatch,
  type VisibleBlocks,
} from "../block/lib/blockDecorations";
import type { BlockMode } from "../block/lib/modeMachine";
import { DormantRing } from "./dormantRing";
import {
  createShellIntegrationState,
  registerCwdHandler,
  registerOsc7TeachTrigger,
  registerOsc52ClipboardHandler,
  registerPromptTracker,
} from "./osc-handlers";
import { openPty, type TerminalTransport } from "./pty-bridge";
import "../block/block.css";
import { ensureAgentActivityListener, isAgentActivePty } from "./agentActivity";
import {
  acquireSlot,
  applyBackgroundActive,
  applyCursorBlink,
  applyLetterSpacing,
  applyTheme as applyPoolTheme,
  applyScrollback,
  applyTerminalFont,
  applyWebglPreference,
  configureRendererPool,
  discardRetainedSlot,
  disposeLeafSlot,
  focusSlot,
  getLiveSlotForLeaf,
  getSlotForLeaf,
  isLeafAltScreen,
  parkLeafSlot,
  poolSize,
  poolSlotStats,
  refreshLeafSlot,
  releaseSlot,
  setSlotFocused,
} from "./rendererPool";
import {
  getLastSubmittedCommand,
  notifyCommandExecuted,
  recordSubmittedCommand,
} from "./teach-trigger";
import { useTerminalFont } from "./useTerminalFont";

// TDSF 诊断 (Phase 2): 集中 OSC 7 cwd 同步调试日志，避免污染控制台。
// 通过 window.__TDSF_OSC7_LOG__ 收集，CDP 实测可读取。
type Osc7LogEntry = Record<string, unknown>;

declare global {
  interface Window {
    __TDSF_OSC7_LOG__?: Osc7LogEntry[];
  }
}

function getOsc7Log(): Osc7LogEntry[] | null {
  if (typeof window === "undefined") return null;
  if (!window.__TDSF_OSC7_LOG__) window.__TDSF_OSC7_LOG__ = [];
  return window.__TDSF_OSC7_LOG__;
}

type Callbacks = {
  onSearchReady?: (addon: SearchAddon) => void;
  onExit?: (code: number) => void;
  onCwd?: (cwd: string) => void;
};

type Session = {
  // TDSF 魔改 (#16): pty 类型升级为 TerminalTransport，兼容本地 PTY 与远程 SSH 传输。
  // 本地路径 s.pty 是 PtySession（结构子类型，id 是 number）；
  // SSH 路径 s.pty 是 SSH transport（id 是 sessionId 字符串）。
  pty: TerminalTransport | null;
  // TDSF 魔改 (#16): SSH 传输注入 seam。若提供，openPtyForSession 走 SSH 分支，
  // 跳过 terminalShell/ConPTY/resize-warmup 等本地专属逻辑。
  openTransport?: (
    h: { onData: (b: Uint8Array) => void; onExit: (c: number) => void },
  ) => Promise<TerminalTransport>;
  // TDSF 魔改 (#16): remote 护栏标志。控制 leafHasForegroundJob/Process、
  // kickPty、respawnSession 等 PTY 专属调用对 SSH 不生效。
  remote: boolean;
  ptyOpening: boolean;
  initialCwd: string | undefined;
  lastCwd: string | null;
  pendingExit: number | null;
  shellExited: boolean;
  callbacks: Callbacks;
  visibleNow: boolean;
  focusedNow: boolean;
  disposed: boolean;
  ready: Promise<void>;
  cols: number;
  rows: number;
  container: HTMLDivElement | null;
  snapshot: string | null;
  searchQuery: string | null;
  dormantRing: DormantRing;
  pendingInput: string;
  hasSlot: boolean;
  blocks: boolean;
  blockMode: BlockMode;
  blockListeners: Set<() => void>;
  blockDecorations: BlockDecorations | null;
  // Set by the block shell-input; called to pull focus back when the xterm
  // grid steals it at the prompt (e.g. on a click), so typing stays in the bar.
  inputFocus: (() => void) | null;
  // Per-leaf unsent shell-input text; the single workspace bar swaps it on focus change.
  inputDraft: string;
  // Live "input has text" flag from the block shell-input (gates the watermark).
  inputActive: boolean;
  // A command was submitted on this leaf; kills the watermark synchronously,
  // before the shell's OSC 133 C round-trips through the PTY.
  everSubmitted: boolean;
  // True if the slot was in alt-screen mode (TUI like vim, htop, dofek)
  // at the most recent release. Read once on the next bind to trigger a
  // SIGWINCH-driven repaint instead of replaying dormant bytes.
  altScreenAtRelease: boolean;
  // OSC 133 C..D window (or blocks running mode): a foreground process owns
  // the terminal, so the leaf must keep its live grid while hidden.
  commandRunning: boolean;
  hiddenReleaseTimer: ReturnType<typeof setTimeout> | null;
  spawnFailed: boolean;
  // TDSF 魔改: 待风险确认的命令（L3+ 拦截后暂存，UI 弹窗确认后执行）
  pendingRiskCommand: { text: string; assessment: RiskRpcAssessment } | null;
};

const sessions = new Map<number, Session>();

// Block-overlay viewport listeners, keyed by leafId at module scope so the
// overlay (a child) can subscribe before the parent effect creates the session.
const blockViewportListeners = new Map<number, Set<() => void>>();

// TDSF 魔改: 待风险确认命令的 listeners，UI 层订阅以弹出 RiskGuardDialog
const pendingRiskListeners = new Map<number, Set<() => void>>();

function notifyPendingRiskListeners(leafId: number): void {
  const set = pendingRiskListeners.get(leafId);
  if (set) for (const l of set) l();
}

const readyLeaves = new Set<number>();
const readyWaiters = new Map<
  number,
  { resolve: () => void; timer: ReturnType<typeof setTimeout> }[]
>();

function markSessionReady(leafId: number): void {
  if (readyLeaves.has(leafId)) return;
  readyLeaves.add(leafId);
  const waiters = readyWaiters.get(leafId);
  if (!waiters) return;
  readyWaiters.delete(leafId);
  for (const w of waiters) {
    clearTimeout(w.timer);
    w.resolve();
  }
}

export function whenSessionReady(
  leafId: number,
  timeoutMs = 4000,
): Promise<void> {
  if (readyLeaves.has(leafId)) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const arr = readyWaiters.get(leafId);
      const i = arr?.findIndex((w) => w.timer === timer) ?? -1;
      if (arr && i >= 0) arr.splice(i, 1);
      resolve();
    }, timeoutMs);
    const arr = readyWaiters.get(leafId) ?? [];
    arr.push({ resolve, timer });
    readyWaiters.set(leafId, arr);
  });
}

const PENDING_INPUT_MAX = 256 * 1024;

// Input typed before the pty attaches is queued and flushed on attach. Cap the
// queue so a large paste into a still-spawning pane can't grow it without bound.
function queuePendingInput(s: Session, data: string): void {
  if (s.pendingInput.length + data.length > PENDING_INPUT_MAX) return;
  s.pendingInput += data;
}

export function writeToSession(leafId: number, data: string): boolean {
  const s = sessions.get(leafId);
  if (!s || s.shellExited) return false;
  if (s.pty) {
    void s.pty.write(data);
    return true;
  }
  queuePendingInput(s, data);
  return true;
}

export function submitToLeaf(leafId: number, text: string): void {
  const s = sessions.get(leafId);
  if (!s || s.shellExited) return;

  // TDSF 魔改: 同步快速风险评估（< 1ms，保证终端不卡顿）
  const assessment = evaluateRiskSync(text);
  if (assessment.level === "high" || assessment.level === "deny") {
    // 命中 L3 (high) / L4 (deny) → 暂存命令，触发 listeners，不执行
    s.pendingRiskCommand = { text, assessment };
    notifyPendingRiskListeners(leafId);
    // 异步调 RPC 获取精确评分，更新 assessment（fail-open 时仍是 local 评分）
    void evaluateRisk(text).then((rpcAssessment) => {
      const current = sessions.get(leafId);
      if (current?.pendingRiskCommand?.text === text) {
        current.pendingRiskCommand = { text, assessment: rpcAssessment };
        notifyPendingRiskListeners(leafId);
      }
    });
    return;
  }

  // safe/low/medium → 静默放行，正常执行
  s.everSubmitted = true;
  // TDSF 魔改 (P4-T4.3): 记录命令文本供 OSC 7 teach 触发使用
  recordSubmittedCommand(text);
  // Bracketed paste keeps a multiline command atomic; trailing CR runs it.
  const data = text.includes("\n")
    ? `\x1b[200~${text}\x1b[201~\r`
    : `${text}\r`;
  if (s.pty) void s.pty.write(data);
  else queuePendingInput(s, data);
}

// TDSF 魔改: RiskEngine 拦截相关导出（供 UI 层订阅 + 确认/取消）

/** 获取当前待风险确认的命令（无拦截时返回 null） */
export function getPendingRiskCommand(
  leafId: number,
): { text: string; assessment: RiskRpcAssessment } | null {
  return sessions.get(leafId)?.pendingRiskCommand ?? null;
}

/** 订阅 pendingRiskCommand 变化（用于 UI 层弹窗） */
export function subscribePendingRiskCommand(
  leafId: number,
  cb: () => void,
): () => void {
  let set = pendingRiskListeners.get(leafId);
  if (!set) {
    set = new Set();
    pendingRiskListeners.set(leafId, set);
  }
  set.add(cb);
  return () => {
    const live = pendingRiskListeners.get(leafId);
    live?.delete(cb);
    if (live && live.size === 0) pendingRiskListeners.delete(leafId);
  };
}

/** 用户确认执行暂存命令（不再做风险检查，直接写入 PTY） */
export function confirmPendingRiskCommand(leafId: number): void {
  const s = sessions.get(leafId);
  if (!s?.pendingRiskCommand) return;
  const text = s.pendingRiskCommand.text;
  s.pendingRiskCommand = null;
  notifyPendingRiskListeners(leafId);
  // 执行命令
  s.everSubmitted = true;
  // TDSF 魔改 (P4-T4.3): 记录命令文本供 OSC 7 teach 触发使用
  recordSubmittedCommand(text);
  const data = text.includes("\n")
    ? `\x1b[200~${text}\x1b[201~\r`
    : `${text}\r`;
  if (s.pty) void s.pty.write(data);
  else queuePendingInput(s, data);
}

/** 用户取消暂存命令（清除暂存，不执行） */
export function cancelPendingRiskCommand(leafId: number): void {
  const s = sessions.get(leafId);
  if (!s) return;
  s.pendingRiskCommand = null;
  notifyPendingRiskListeners(leafId);
}

export function interruptLeaf(leafId: number): void {
  sessions.get(leafId)?.pty?.write("\x03");
}

export function leafCwd(leafId: number): string | null {
  return sessions.get(leafId)?.lastCwd ?? null;
}

export function navigateFocusedBlocks(dir: -1 | 1): boolean {
  for (const [, s] of sessions) {
    if (!s.visibleNow || !s.focusedNow || !s.blockDecorations) continue;
    s.blockDecorations.navigateBlocks(dir);
    return true;
  }
  return false;
}

export function clearLeafBlockSelection(leafId: number): boolean {
  return sessions.get(leafId)?.blockDecorations?.clearBlockSelection() ?? false;
}

export function leafGridSelection(leafId: number): string | null {
  const sel = getSlotForLeaf(leafId)?.term.getSelection() ?? "";
  return sel.length > 0 ? sel : null;
}

export function getLeafBlockMode(leafId: number): BlockMode {
  return sessions.get(leafId)?.blockMode ?? "prompt";
}

export function subscribeLeafBlockMode(
  leafId: number,
  cb: () => void,
): () => void {
  const s = sessions.get(leafId);
  if (!s) return () => {};
  s.blockListeners.add(cb);
  return () => {
    s.blockListeners.delete(cb);
  };
}

export function setLeafInputFocus(
  leafId: number,
  fn: (() => void) | null,
): void {
  const s = sessions.get(leafId);
  if (s) s.inputFocus = fn;
}

export function focusLeafInput(leafId: number): void {
  sessions.get(leafId)?.inputFocus?.();
}

export function getLeafDraft(leafId: number): string {
  return sessions.get(leafId)?.inputDraft ?? "";
}

export function setLeafDraft(leafId: number, text: string): void {
  const s = sessions.get(leafId);
  if (s) s.inputDraft = text;
}

export function setLeafInputActivity(leafId: number, active: boolean): void {
  const s = sessions.get(leafId);
  if (!s || s.inputActive === active) return;
  s.inputActive = active;
  const set = blockViewportListeners.get(leafId);
  if (set) for (const l of set) l();
}

export type WatermarkState = "visible" | "hidden" | "dead";

// Watermark gate: a block terminal that has never run a command, whose grid is
// still untouched, and whose input is empty. Synchronous so tab switches, slot
// rebinds and the Enter-to-OSC-133 gap never flash it over real content.
// "dead" is permanent and lets the component unmount for good. The grid check
// scans glyphs, not the cursor: the prompt integration prints a blank gap line
// at spawn, so the cursor sits below row 0 even on a visually empty terminal.
export function blockWatermarkState(leafId: number): WatermarkState {
  const s = sessions.get(leafId);
  if (!s || s.disposed) return "dead";
  if (s.everSubmitted || s.blockDecorations?.hasAnyBlock()) return "dead";
  if (!s.blockDecorations || s.inputActive) return "hidden";
  const slot = getSlotForLeaf(leafId);
  if (!slot) return "hidden";
  const buf = slot.term.buffer.active;
  if (buf.baseY > 0) return "dead";
  const rows = Math.min(buf.length, slot.term.rows);
  for (let i = 0; i < rows; i++) {
    if (buf.getLine(i)?.translateToString(true)) return "dead";
  }
  return "visible";
}

/**
 * Clear the scrollback and screen of the currently focused terminal, keeping
 * the active prompt line — macOS Terminal's ⌘K behaviour. Returns false when no
 * focused terminal slot is bound (e.g. focus is in the editor or AI panel).
 */
export function clearFocusedTerminal(): boolean {
  for (const [leafId, s] of sessions) {
    if (!s.visibleNow || !s.focusedNow) continue;
    const slot = getSlotForLeaf(leafId);
    if (!slot) continue;
    slot.term.clear();
    return true;
  }
  return false;
}

export function leafIdForPty(ptyId: number): number | null {
  for (const [leafId, s] of sessions) {
    if (s.pty?.id === ptyId) return leafId;
  }
  return null;
}

export function ptyIdForLeaf(leafId: number): number | null {
  // TDSF 魔改 (#16): SSH 终端 pty.id 是 sessionId 字符串，不返回给本地 ptyId 查询。
  const s = sessions.get(leafId);
  if (!s || s.remote || !s.pty) return null;
  return s.pty.id as number;
}

function leafBusy(s: Session): boolean {
  if (s.commandRunning) return true;
  // TDSF 魔改 (#16): SSH 终端不参与 agent activity 检测（pty.id 是 string，
  // isAgentActivePty 只跟踪本地 PTY 的数字 id）。
  if (s.remote || !s.pty) return false;
  return isAgentActivePty(s.pty.id as number);
}

const HIDDEN_RELEASE_DELAY_MS = 300;

// A parked hidden leaf went idle: give the post-command prompt a moment to
// render into the live buffer, then hand the slot back to the pool.
function scheduleHiddenRelease(leafId: number, s: Session): void {
  // TDSF 修复 2026-08-11 (SSH 终端 buffer 保留):
  // SSH leaf 隐藏不释放 slot —— 保持"buffer 常驻"，与竞品 (iTerm2/VS Code/
  // Tabby) 的每个终端独立 buffer、切换只改可见性的语义对齐。原因:
  //   1. SSH 无 pty_has_foreground_job 保护 (leafHasForegroundJob 对 remote
  //      恒 false)，命令运行中切走也会被 release；
  //   2. release 后内容进入 retained slot + dormantRing + snapshot 三段保活链，
  //      一旦 slot 被池满 steal/reap，切回只能靠快照重放（有 5000 行 cap 截断
  //      风险）。slot 常驻则 buffer 永不离开 xterm，内容零丢失。
  // 代价: SSH leaf 占用 slot（池上限 5）。池满时由 acquireSlot 的 steal 兜底
  // (steal 前必 storeSnapshot)。
  if (s.remote) return;
  if (s.visibleNow || !s.hasSlot) return;
  cancelHiddenRelease(s);
  s.hiddenReleaseTimer = setTimeout(() => {
    s.hiddenReleaseTimer = null;
    if (s.disposed || s.visibleNow || !s.hasSlot) return;
    if (s.blocks || isLeafAltScreen(leafId) || leafBusy(s)) return;
    unbindLeafFromSlot(leafId, s);
  }, HIDDEN_RELEASE_DELAY_MS);
}

function cancelHiddenRelease(s: Session): void {
  if (s.hiddenReleaseTimer !== null) {
    clearTimeout(s.hiddenReleaseTimer);
    s.hiddenReleaseTimer = null;
  }
}

async function releaseIfIdle(leafId: number, s: Session): Promise<void> {
  // TDSF 修复 2026-08-11 (SSH 终端 buffer 保留): 与 scheduleHiddenRelease 同因，
  // SSH leaf 的 slot 保持常驻，不做异步释放（remote 无 foreground job 探测，
  // 释放后内容进 retained/ring 三段保活链，被 steal/reap 即丢）。
  if (s.remote) return;
  const busy = await leafHasForegroundJob(leafId);
  if (busy || s.disposed || s.visibleNow || !s.hasSlot) return;
  if (s.blocks || isLeafAltScreen(leafId) || leafBusy(s)) return;
  unbindLeafFromSlot(leafId, s);
}

async function leafHasForegroundJob(leafId: number): Promise<boolean> {
  const s = sessions.get(leafId);
  if (!s?.pty || s.shellExited) return false;
  // TDSF 魔改 (#16): SSH 终端保持常驻，不调用 pty_has_foreground_job（无对应 Rust 命令）。
  if (s.remote) return false;
  try {
    return await invoke<boolean>("pty_has_foreground_job", {
      id: s.pty.id as number,
    });
  } catch (e) {
    console.error("[tdsf] pty_has_foreground_job failed for leaf", leafId, e);
    return false;
  }
}

function onLeafCommandState(leafId: number, running: boolean): void {
  const s = sessions.get(leafId);
  if (!s || s.commandRunning === running) return;
  s.commandRunning = running;
  if (!running) {
    scheduleHiddenRelease(leafId, s);
    return;
  }
  cancelHiddenRelease(s);
  // A command started in a hidden released leaf (e.g. submitted by the AI):
  // rebind its retained slot so output parses live instead of filling the
  // ring. Deferred: this callback fires inside xterm's parse loop and the
  // rebind touches the same terminal (fit/resize).
  if (!s.visibleNow && !s.hasSlot && s.container && !s.disposed) {
    setTimeout(() => {
      if (s.disposed || s.visibleNow || s.hasSlot || !s.container) return;
      if (!leafBusy(s)) return;
      bindLeafToSlot(leafId, s);
      parkLeafSlot(leafId);
    }, 0);
  }
}

ensureAgentActivityListener((ptyId) => {
  const leafId = leafIdForPty(ptyId);
  if (leafId === null) return;
  const s = sessions.get(leafId);
  if (s) scheduleHiddenRelease(leafId, s);
});

configureRendererPool({
  resolveLeaf(leafId) {
    const s = sessions.get(leafId);
    if (!s) return null;
    return {
      writeToPty: (data) => {
        // Shell spawn failed (bad cwd, missing binary): Enter retries.
        if (s.spawnFailed) {
          if (data.includes("\r")) void respawnSession(leafId);
          return;
        }
        if (s.pty) void s.pty.write(data);
        else queuePendingInput(s, data);
      },
      resizePty: (cols, rows) => {
        s.cols = cols;
        s.rows = rows;
        s.pty?.resize(cols, rows);
      },
      kickPty: (cols, rows) => {
        const pty = s.pty;
        if (!pty || cols <= 0 || rows <= 0) return;
        // TDSF 魔改 (#16): SSH 终端不做 SIGWINCH +1 bump（本地 ConPTY/Linux trick，
        // 远程不适用），仅普通 resize。
        if (s.remote) {
          void pty.resize(cols, rows);
          return;
        }
        // Linux only emits SIGWINCH when the winsize ioctl actually
        // changes dims, so bump +1 row then restore. The TUI receives
        // (possibly two) SIGWINCHes and repaints from scratch.
        // TDSF 魔改 (#16): TerminalTransport.resize 返回 Promise<void>|void，
        // 用 Promise.resolve 归一化为 Promise<void> 以链式 .then。
        Promise.resolve(pty.resize(cols, rows + 1))
          .then(() => pty.resize(cols, rows))
          .catch((e: unknown) =>
            console.warn("[tdsf] kickPty failed:", e),
          );
      },
    };
  },
  evictLeaf(leafId) {
    const s = sessions.get(leafId);
    if (!s) return;
    unbindLeafFromSlot(leafId, s);
  },
  isLeafFocused(leafId) {
    const s = sessions.get(leafId);
    return !!s && s.visibleNow && s.focusedNow;
  },
  isLeafBlocks(leafId) {
    return sessions.get(leafId)?.blocks ?? false;
  },
  isLeafBusy(leafId) {
    const s = sessions.get(leafId);
    return !!s && leafBusy(s);
  },
  isLeafVisible(leafId) {
    return sessions.get(leafId)?.visibleNow ?? false;
  },
  storeSnapshot(leafId, out) {
    const s = sessions.get(leafId);
    if (!s) return;
    s.snapshot = out.snapshot;
    if (out.cols > 0) s.cols = out.cols;
    if (out.rows > 0) s.rows = out.rows;
    s.altScreenAtRelease = out.altScreen;
  },
});

function ensureSession(
  leafId: number,
  initialCwd?: string,
  blocks = false,
): Session {
  const existing = sessions.get(leafId);
  if (existing) return existing;

  const session: Session = {
    pty: null,
    // TDSF 魔改 (#16): SSH 传输注入字段初始化（默认本地路径，由 hook 同步覆盖）。
    openTransport: undefined,
    remote: false,
    ptyOpening: false,
    initialCwd,
    lastCwd: null,
    pendingExit: null,
    shellExited: false,
    callbacks: {},
    visibleNow: false,
    focusedNow: false,
    disposed: false,
    ready: Promise.resolve(),
    cols: 0,
    rows: 0,
    container: null,
    snapshot: null,
    searchQuery: null,
    dormantRing: new DormantRing(),
    pendingInput: "",
    hasSlot: false,
    blocks,
    blockMode: "prompt",
    blockListeners: new Set(),
    blockDecorations: null,
    inputFocus: null,
    inputDraft: "",
    inputActive: false,
    everSubmitted: false,
    altScreenAtRelease: false,
    commandRunning: false,
    hiddenReleaseTimer: null,
    spawnFailed: false,
    pendingRiskCommand: null,
  };
  sessions.set(leafId, session);

  session.ready = (async () => {
    await ensureMonoFontsLoaded();
    await document.fonts.ready;
  })();

  return session;
}

function deliverPtyBytes(leafId: number, bytes: Uint8Array): void {
  const s = sessions.get(leafId);
  if (!s) return;
  // Retained slots keep parsing live (render paused); the ring is only for
  // leaves whose buffer was stolen or never bound.
  const slot = getLiveSlotForLeaf(leafId);
  if (slot) slot.term.write(bytes);
  else s.dormantRing.push(bytes);
}

const SPAWN_RETRY_DELAY_MS = 250;

async function openPtyWithRetry(
  leafId: number,
  s: Session,
  cwd: string | undefined,
): Promise<TerminalTransport> {
  try {
    return await openPtyForSession(leafId, s, cwd);
  } catch (e) {
    console.error("[tdsf] openPty failed, retrying once:", e);
    await new Promise((r) => setTimeout(r, SPAWN_RETRY_DELAY_MS));
    if (s.disposed) throw e;
    return openPtyForSession(leafId, s, cwd);
  }
}

// Spawn failure must not flow through onExit: handleLeafExit closes the pane
// (or respawns the last one, which would loop). Show the error in the pane
// and let Enter retry instead of leaving a dead black grid.
function surfaceSpawnFailure(leafId: number, s: Session, e: unknown): void {
  console.error("[tdsf] shell spawn failed:", e);
  s.shellExited = true;
  s.spawnFailed = true;
  const detail = String(e)
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .slice(0, 300);
  deliverPtyBytes(
    leafId,
    new TextEncoder().encode(
      `\r\n\x1b[31m[tdsf] failed to start shell: ${detail}\x1b[0m\r\n\x1b[2mpress Enter to retry\x1b[0m\r\n`,
    ),
  );
}

async function openPtyForSession(
  leafId: number,
  s: Session,
  cwd: string | undefined,
): Promise<TerminalTransport> {
  // TDSF 魔改 (#16): SSH 传输分支 —— 跳过本地 PTY/ConPTY/terminalShell 专属逻辑。
  // openTransport 工厂由 SshTerminalHost 提供：subscribeTerminalData + handle.write/resize。
  // close 只 unsubscribe 前端订阅，不断底层 SSH 连接（SFTP 共用）。
  if (s.openTransport) {
    const transport = await s.openTransport({
      onData: (bytes) => deliverPtyBytes(leafId, bytes),
      onExit: (code) => {
        s.shellExited = true;
        s.pty = null;
        s.pendingInput = "";
        s.commandRunning = false;
        const slot = getSlotForLeaf(leafId);
        if (slot) slot.term.options.disableStdin = true;
        scheduleHiddenRelease(leafId, s);
        if (s.callbacks.onExit) s.callbacks.onExit(code);
        else s.pendingExit = code;
      },
    });
    // SSH 初始尺寸同步（与本地路径对称：本地用 startCols/startRows 起步，
    // SSH 由 server 推送 MOTD 后客户端 resize 同步尺寸）。
    if (s.cols > 0 && s.rows > 0) {
      void transport.resize(s.cols, s.rows);
    }
    return transport;
  }
  // 本地 PTY 路径（原逻辑，零改动）
  const startCols = s.cols > 0 ? s.cols : 80;
  const startRows = s.rows > 0 ? s.rows : 24;
  const pty = await openPty(
    startCols,
    startRows,
    {
      onData: (bytes) => deliverPtyBytes(leafId, bytes),
      onExit: (code) => {
        s.shellExited = true;
        s.pty = null;
        s.pendingInput = "";
        s.commandRunning = false;
        const slot = getSlotForLeaf(leafId);
        if (slot) slot.term.options.disableStdin = true;
        scheduleHiddenRelease(leafId, s);
        if (s.callbacks.onExit) s.callbacks.onExit(code);
        else s.pendingExit = code;
      },
    },
    cwd,
    s.blocks,
    usePreferencesStore.getState().terminalShell || undefined,
  );
  // Only resize if the bound dims changed during the spawn: a same-size
  // ResizePseudoConsole during conhost warmup is a known ConPTY trigger for
  // a console that never renders (blank tab).
  if (
    s.cols > 0 &&
    s.rows > 0 &&
    (s.cols !== startCols || s.rows !== startRows)
  ) {
    void pty.resize(s.cols, s.rows);
  }
  return pty;
}

function applyBlockMode(leafId: number, mode: BlockMode): void {
  const s = sessions.get(leafId);
  if (!s) return;
  s.blockMode = mode;
  s.commandRunning = mode !== "prompt";
  const slot = getSlotForLeaf(leafId);
  if (slot) {
    const prompt = mode === "prompt";
    slot.term.options.disableStdin = prompt;
    // Disable the helper textarea at the prompt so a grid click can't focus the
    // xterm (no flashing cursor) and can't steal focus from the shell input.
    if (slot.term.textarea) slot.term.textarea.disabled = prompt;
    if (!prompt) {
      slot.term.focus();
    } else if (s.visibleNow && s.focusedNow) {
      const inputFocus = s.inputFocus;
      if (inputFocus) setTimeout(inputFocus, 0);
    }
  }
  for (const l of s.blockListeners) l();
}

function bindLeafToSlot(leafId: number, s: Session): void {
  if (!s.container) return;
  const altScreen = s.altScreenAtRelease;
  s.altScreenAtRelease = false;
  acquireSlot({
    leafId,
    container: s.container,
    snapshot: s.snapshot,
    altScreen,
    drainRing: (write) => s.dormantRing.drain(write),
    // Keep stdin alive after a spawn failure so Enter can trigger the retry.
    shellExited: s.shellExited && !s.spawnFailed,
    searchQuery: s.searchQuery,
    cols: s.cols,
    rows: s.rows,
    registerOsc: (term) => {
      if (s.blocks) {
        const osc52 = registerOsc52ClipboardHandler(term);
        const deco = new BlockDecorations(term, {
          onCwd: (next) => {
            markSessionReady(leafId);
            if (s.lastCwd === next) return;
            s.lastCwd = next;
            s.callbacks.onCwd?.(next);
          },
          onMode: (mode) => applyBlockMode(leafId, mode),
          onViewport: () => {
            const set = blockViewportListeners.get(leafId);
            if (set) for (const l of set) l();
          },
        });
        s.blockDecorations = deco;
        const onGridFocus = () => {
          if (s.blockMode === "prompt") s.inputFocus?.();
        };
        term.textarea?.addEventListener("focus", onGridFocus);
        return [
          () => {
            s.blockDecorations = null;
            osc52();
            deco.dispose();
            term.textarea?.removeEventListener("focus", onGridFocus);
          },
        ];
      }
      // For remote transports (SSH) the remote shell may not emit OSC 133
      // integration markers, and SshTerminalHost injects a trusted OSC 7
      // sequence right after `cd` commands from the transport seam. Use the
      // cwd handler without the in-command guard so our injected OSC 7 is
      // honored, and skip the local teach trigger for remote shells.
      const disposers: (() => void)[] = [];
      if (!s.remote) {
        // Shared in-command flag — see osc-handlers.ts. The prompt tracker
        // flips it on OSC 133 B/C/D/A; the cwd handler reads it to ignore OSC
        // 7 emitted by untrusted command output (`cat` of an attacker file, etc.).
        const shellState = createShellIntegrationState();
        const prompt = registerPromptTracker(term, shellState, (running) =>
          onLeafCommandState(leafId, running),
        );
        disposers.push(prompt.dispose);
        const cwd = registerCwdHandler(
          term,
          (next) => {
            markSessionReady(leafId);
            if (s.lastCwd === next) return;
            s.lastCwd = next;
            s.callbacks.onCwd?.(next);
          },
          shellState,
        );
        disposers.push(cwd);
        // TDSF 魔改 (P4-T4.3): 注册第二个 OSC 7 处理器，专用于 teach 触发。
        // 与上面的 registerCwdHandler 并存：cwd handler 仅在 cwd 变化时回调，
        // teach trigger 对每次合法 OSC 7 都回调（shell 在每条命令结束后都发 OSC 7），
        // 由 notifyCommandExecuted 内部做降频（默认每 3 条触发一次）。
        const teachTrigger = registerOsc7TeachTrigger(
          term,
          (oscCwd) => {
            const cmd = getLastSubmittedCommand();
            void notifyCommandExecuted(cmd, oscCwd);
          },
          shellState,
        );
        disposers.push(teachTrigger);
      } else {
        const cwd = registerCwdHandler(
          term,
          (next) => {
            const log = getOsc7Log();
            log?.push({
              source: "useTerminalSession.registerCwdHandler",
              cwd: next,
              leafId,
              remote: s.remote,
            });
            markSessionReady(leafId);
            if (s.lastCwd === next) return;
            s.lastCwd = next;
            s.callbacks.onCwd?.(next);
          },
          undefined,
        );
        disposers.push(cwd);
      }
      const osc52 = registerOsc52ClipboardHandler(term);
      disposers.push(osc52);
      return disposers;
    },
    onSearchReady: (addon) => s.callbacks.onSearchReady?.(addon),
  });
  s.snapshot = null;
  s.hasSlot = true;
  if (s.blocks) applyBlockMode(leafId, s.blockMode);
  if (s.lastCwd !== null) s.callbacks.onCwd?.(s.lastCwd);
  if (s.pendingExit !== null) {
    const code = s.pendingExit;
    s.pendingExit = null;
    s.callbacks.onExit?.(code);
  }
}

function unbindLeafFromSlot(leafId: number, s: Session): void {
  if (!s.hasSlot) return;
  const out = releaseSlot(leafId);
  if (out) {
    if (out.cols > 0) s.cols = out.cols;
    if (out.rows > 0) s.rows = out.rows;
  }
  s.hasSlot = false;
}

function attachSession(
  leafId: number,
  container: HTMLDivElement,
  callbacks: Callbacks,
): void {
  const s = sessions.get(leafId);
  if (!s || s.disposed) return;
  s.callbacks = callbacks;
  s.container = container;

  if (s.visibleNow) bindLeafToSlot(leafId, s);

  if (!s.pty && !s.ptyOpening && !s.shellExited) {
    s.ptyOpening = true;
    openPtyWithRetry(leafId, s, s.initialCwd)
      .then((pty) => {
        s.ptyOpening = false;
        if (s.disposed) {
          pty.close();
          return;
        }
        s.pty = pty;
        if (s.pendingInput) {
          void pty.write(s.pendingInput);
          s.pendingInput = "";
        }
        if (s.cols > 0 && s.rows > 0) pty.resize(s.cols, s.rows);
      })
      .catch((e) => {
        s.ptyOpening = false;
        if (!s.disposed) surfaceSpawnFailure(leafId, s, e);
      });
  }
}

function detachSession(leafId: number): void {
  const s = sessions.get(leafId);
  if (!s) return;
  unbindLeafFromSlot(leafId, s);
  s.callbacks = {};
  s.container = null;
}

export async function respawnSession(
  leafId: number,
  cwd?: string,
): Promise<void> {
  const s = sessions.get(leafId);
  if (!s || s.disposed) return;
  // TDSF 魔改 (#16): SSH 终端不支持本地 respawn（需走 sshStore 重连流程，后续接入）。
  // 直接 return，保留当前 pane（避免 close 后无法重连导致 pane 死掉）。
  if (s.remote) {
    console.warn(
      "[tdsf] respawnSession skipped for remote SSH leaf",
      leafId,
      "(use sshStore.reconnect instead)",
    );
    return;
  }
  s.pty?.close();
  s.pty = null;
  s.snapshot = null;
  s.dormantRing = new DormantRing();
  s.shellExited = false;
  s.pendingExit = null;
  s.pendingInput = "";
  s.altScreenAtRelease = false;
  s.commandRunning = false;
  s.spawnFailed = false;
  cancelHiddenRelease(s);

  const slot = getSlotForLeaf(leafId);
  if (slot) {
    slot.term.options.disableStdin = false;
    slot.term.clear();
    slot.term.reset();
  } else {
    discardRetainedSlot(leafId);
  }

  s.ptyOpening = true;
  // TDSF 魔改 (#16): pty 类型升级为 TerminalTransport（兼容本地 PTY 与 SSH 传输）。
  let pty: TerminalTransport;
  try {
    pty = await openPtyWithRetry(leafId, s, cwd ?? s.initialCwd);
  } catch (e) {
    s.ptyOpening = false;
    if (!s.disposed) surfaceSpawnFailure(leafId, s, e);
    return;
  }
  s.ptyOpening = false;
  if (s.disposed) {
    pty.close();
    return;
  }
  s.pty = pty;
  if (s.pendingInput) {
    void pty.write(s.pendingInput);
    s.pendingInput = "";
  }
  if (s.cols > 0 && s.rows > 0) pty.resize(s.cols, s.rows);
}

export async function leafHasForegroundProcess(
  leafId: number,
): Promise<boolean> {
  const s = sessions.get(leafId);
  if (!s?.pty || s.shellExited) return false;
  // TDSF 魔改 (#16): SSH 终端保持常驻，不调用 pty_has_foreground_process。
  if (s.remote) return false;
  try {
    const result = await invoke<boolean>("pty_has_foreground_process", {
      id: s.pty.id as number,
    });
    return result;
  } catch (e) {
    console.error(
      "[tdsf] pty_has_foreground_process failed for leaf",
      leafId,
      e,
    );
    return false;
  }
}

export function disposeSession(leafId: number): void {
  const s = sessions.get(leafId);
  if (!s) return;
  s.disposed = true;
  cancelHiddenRelease(s);
  disposeLeafSlot(leafId);
  s.hasSlot = false;
  s.snapshot = null;
  s.pty?.close();
  s.pty = null;
  s.pendingInput = "";
  sessions.delete(leafId);
  blockViewportListeners.delete(leafId);
  pendingRiskListeners.delete(leafId);
  readyLeaves.delete(leafId);
  const waiters = readyWaiters.get(leafId);
  if (waiters) {
    readyWaiters.delete(leafId);
    for (const w of waiters) {
      clearTimeout(w.timer);
      w.resolve();
    }
  }
}

type Options = {
  leafId: number;
  container: React.RefObject<HTMLDivElement | null>;
  visible: boolean;
  focused?: boolean;
  initialCwd?: string;
  blocks?: boolean;
  // TDSF 魔改 (#16): SSH 传输注入 seam。若提供，useTerminalSession 走 SSH 分支，
  // 由 SshTerminalHost 提供 subscribeTerminalData + handle.write/resize。
  openTransport?: (
    h: { onData: (b: Uint8Array) => void; onExit: (c: number) => void },
  ) => Promise<TerminalTransport>;
  // TDSF 魔改 (#16): remote 护栏标志。true 时跳过 PTY 专属 invoke。
  remote?: boolean;
  onSearchReady?: (addon: SearchAddon) => void;
  onExit?: (code: number) => void;
  onCwd?: (cwd: string) => void;
};

export function useTerminalSession({
  leafId,
  container,
  visible,
  focused = true,
  initialCwd,
  blocks = false,
  openTransport,
  remote = false,
  onSearchReady,
  onExit,
  onCwd,
}: Options) {
  const cbRef = useRef({ onSearchReady, onExit, onCwd });
  cbRef.current = { onSearchReady, onExit, onCwd };

  // initialCwd seeds the first PTY spawn only. It must NOT be an effect dep:
  // OSC 7 updates the leaf cwd on every `cd`, and re-running the bind effect
  // would detach/rebind the renderer slot (disposing block markers) on each cd.
  const initialCwdRef = useRef(initialCwd);
  initialCwdRef.current = initialCwd;

  // TDSF 魔改 (#16): openTransport/remote 同样不能是 effect dep（每次 render 引用变化
  // 会重订阅），用 ref 同步到 session，与 initialCwd 同模式。
  const openTransportRef = useRef(openTransport);
  openTransportRef.current = openTransport;
  const remoteRef = useRef(remote);
  remoteRef.current = remote;

  useEffect(() => {
    let cancelled = false;
    const s = ensureSession(leafId, initialCwdRef.current, blocks);
    // TDSF 魔改 (#16): 同步传输注入与护栏标志到 session。
    // 不放进 deps，防止每次 render 重订阅 effect。
    s.openTransport = openTransportRef.current;
    s.remote = remoteRef.current;
    s.ready.then(() => {
      if (cancelled || s.disposed) return;
      const node = container.current;
      if (!node) return;
      attachSession(leafId, node, {
        onSearchReady: (a) => cbRef.current.onSearchReady?.(a),
        onExit: (c) => cbRef.current.onExit?.(c),
        onCwd: (c) => cbRef.current.onCwd?.(c),
      });
      if (s.visibleNow && s.focusedNow && !s.blocks) focusSlot(leafId);
    });
    return () => {
      cancelled = true;
      detachSession(leafId);
    };
  }, [leafId, container, blocks]);

  const [blockMode, setBlockMode] = useState<BlockMode>("prompt");
  useEffect(() => {
    if (!blocks) return;
    const s = ensureSession(leafId, initialCwdRef.current, blocks);
    setBlockMode(s.blockMode);
    const cb = () => setBlockMode(sessions.get(leafId)?.blockMode ?? "prompt");
    s.blockListeners.add(cb);
    return () => {
      s.blockListeners.delete(cb);
    };
  }, [leafId, blocks]);

  const { fontFamily, fontWeight, fontSize } = useTerminalFont();
  const zoomLevel = usePreferencesStore((p) => p.zoomLevel);
  useLayoutEffect(() => {
    applyTerminalFont({
      fontFamily,
      fontWeight,
      fontSize: Math.max(4, Math.round(fontSize * zoomLevel)),
    });
  }, [fontFamily, fontWeight, fontSize, zoomLevel]);

  const letterSpacing = usePreferencesStore((p) => p.terminalLetterSpacing);
  useEffect(() => {
    applyLetterSpacing(letterSpacing);
  }, [letterSpacing]);

  const scrollback = usePreferencesStore((p) => p.terminalScrollback);
  useEffect(() => {
    applyScrollback(scrollback);
  }, [scrollback]);

  const webglPref = usePreferencesStore((p) => p.terminalWebglEnabled);
  useEffect(() => {
    applyWebglPreference(webglPref);
  }, [webglPref]);

  const cursorBlink = usePreferencesStore((p) => p.terminalCursorBlink);
  useEffect(() => {
    applyCursorBlink(cursorBlink);
  }, [cursorBlink]);

  const bgActive = usePreferencesStore(
    (p) => p.backgroundKind === "image" && !!p.backgroundImageId,
  );
  useEffect(() => {
    applyBackgroundActive(bgActive);
  }, [bgActive]);

  useEffect(() => {
    const s = sessions.get(leafId);
    if (!s) return;
    s.visibleNow = visible;
    s.focusedNow = focused;
    if (visible) {
      cancelHiddenRelease(s);
      if (s.container && !s.hasSlot) bindLeafToSlot(leafId, s);
      else if (s.hasSlot) refreshLeafSlot(leafId);
      setSlotFocused(leafId, focused);
      if (focused && !blocks) focusSlot(leafId);
    } else if (s.hasSlot) {
      // Always park first (keeps the grid live, pauses rendering); release
      // only after confirming nothing owns the terminal. Sync signals (OSC
      // 133, agent detect) short-circuit; the async foreground-process check
      // covers shells without integration.
      parkLeafSlot(leafId);
      if (!s.blocks && !isLeafAltScreen(leafId) && !leafBusy(s)) {
        void releaseIfIdle(leafId, s);
      }
    }
  }, [leafId, visible, focused, blocks]);

  const write = useCallback(
    (data: string) => {
      const s = sessions.get(leafId);
      if (!s || s.shellExited) return;
      if (s.pty) void s.pty.write(data);
      else queuePendingInput(s, data);
    },
    [leafId],
  );

  const focus = useCallback(() => focusSlot(leafId), [leafId]);

  const getBuffer = useCallback(
    (maxLines = 200): string | null => {
      const s = sessions.get(leafId);
      if (!s) return null;
      const slot = getLiveSlotForLeaf(leafId);
      if (slot) {
        const buf = slot.term.buffer.active;
        const total = buf.length;
        const lines: string[] = [];
        const start = Math.max(0, total - maxLines);
        for (let i = start; i < total; i++) {
          lines.push(buf.getLine(i)?.translateToString(true) ?? "");
        }
        while (lines.length && lines[lines.length - 1] === "") lines.pop();
        return lines.join("\n");
      }
      if (!s.snapshot) return "";
      const plain = stripAnsi(s.snapshot);
      const lines = plain.split(/\r?\n/);
      const tail = lines.slice(-maxLines);
      while (tail.length && tail[tail.length - 1] === "") tail.pop();
      return tail.join("\n");
    },
    [leafId],
  );

  const getSelection = useCallback((): string | null => {
    const slot = getSlotForLeaf(leafId);
    const sel = slot?.term.getSelection() ?? "";
    return sel.length > 0 ? sel : null;
  }, [leafId]);

  const applyTheme = useCallback(() => {
    applyPoolTheme();
  }, []);

  const selectBlockAt = useCallback(
    (clientY: number) =>
      sessions.get(leafId)?.blockDecorations?.selectBlockAt(clientY),
    [leafId],
  );

  const readBlockId = useCallback(
    (id: string) =>
      sessions.get(leafId)?.blockDecorations?.readById(id) ?? null,
    [leafId],
  );

  const subscribeBlocks = useCallback(
    (cb: () => void) => {
      let set = blockViewportListeners.get(leafId);
      if (!set) {
        set = new Set();
        blockViewportListeners.set(leafId, set);
      }
      set.add(cb);
      return () => {
        const live = blockViewportListeners.get(leafId);
        live?.delete(cb);
        if (live && live.size === 0) blockViewportListeners.delete(leafId);
      };
    },
    [leafId],
  );

  const visibleBlocks = useCallback(
    (): VisibleBlocks =>
      sessions.get(leafId)?.blockDecorations?.visibleBlocks() ?? {
        blocks: [],
        sticky: null,
      },
    [leafId],
  );

  const searchBlock = useCallback(
    (id: string, query: string) =>
      sessions.get(leafId)?.blockDecorations?.searchBlock(id, query) ?? [],
    [leafId],
  );

  const revealMatch = useCallback(
    (m: BlockMatch) => sessions.get(leafId)?.blockDecorations?.revealMatch(m),
    [leafId],
  );

  const clearSearch = useCallback(
    () => sessions.get(leafId)?.blockDecorations?.clearSearch(),
    [leafId],
  );

  return useMemo(
    () => ({
      write,
      focus,
      getBuffer,
      getSelection,
      applyTheme,
      blockMode,
      selectBlockAt,
      readBlockId,
      subscribeBlocks,
      visibleBlocks,
      searchBlock,
      revealMatch,
      clearSearch,
    }),
    [
      write,
      focus,
      getBuffer,
      getSelection,
      applyTheme,
      blockMode,
      selectBlockAt,
      readBlockId,
      subscribeBlocks,
      visibleBlocks,
      searchBlock,
      revealMatch,
      clearSearch,
    ],
  );
}

const ANSI_RE =
  /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][AB012]|\x1b[78=>]|\x1bc|\x1b[NOP\]X^_]/g;

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export function terminalDebugStats() {
  const liveSessions = [...sessions.entries()].map(([leafId, s]) => ({
    leafId,
    pty: !!s.pty,
    visible: s.visibleNow,
    focused: s.focusedNow,
    hasSlot: s.hasSlot,
    ringBytes: s.dormantRing.byteLength(),
    snapshotLen: s.snapshot?.length ?? 0,
    shellExited: s.shellExited,
  }));
  const ringTotal = liveSessions.reduce((n, s) => n + s.ringBytes, 0);
  const snapshotTotal = liveSessions.reduce((n, s) => n + s.snapshotLen, 0);
  const slots = poolSlotStats();
  return {
    poolSize: poolSize(),
    webglContexts: slots.filter((s) => s.webgl).length,
    idleSlots: slots.filter((s) => s.leafId === null).length,
    slots,
    sessionCount: liveSessions.length,
    sessions: liveSessions,
    ringBytesTotal: ringTotal,
    snapshotCharsTotal: snapshotTotal,
    domCanvases: document.querySelectorAll("canvas").length,
    domScreens: document.querySelectorAll(".xterm-screen").length,
    domRows: document.querySelectorAll(".xterm-rows > div").length,
    jsHeapBytes:
      (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory
        ?.usedJSHeapSize ?? null,
  };
}

if (import.meta.env?.DEV && typeof window !== "undefined") {
  (window as unknown as { __tdsfTerm?: unknown }).__tdsfTerm =
    terminalDebugStats;
}
