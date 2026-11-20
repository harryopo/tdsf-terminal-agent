/**
 * “下一步建议”显式入口（2026-11-12）
 * -----------------------------------------------------------------------------
 * 与逐键“预测补全”完全分开：本模块只在用户按 Ctrl+Shift+Space 时请求一次，
 * 不参与按键补全、不改 Tab/→/Enter 的原语义。候选来自 sessionBridge 的会话内统计；
 * 可用性/风险由调用方注入，未知一律隐藏（方案书 §5.1/§7）。
 *
 * 接受只把 insertText 写进当前可见输入行，不追加换行、不执行；写入复用
 * completionInjection 的 writeFn / noteUserInput / 输入缓冲区。
 */

import type {
  Availability,
  Candidate,
  PredictionRequest,
  RiskLevel,
} from "@/modules/prediction/contracts";
import {
  acceptPredictionCandidate,
  correctionTargetIsCurrent,
  sessionCommandEntriesForLeaf,
  suggestCorrectionForLeaf,
  suggestNextForLeaf,
} from "@/modules/prediction/sessionBridge";
import { registerShortcutInterceptor } from "@/modules/shortcuts/shortcuts";

export type NextCommandDeps = {
  getLine: (leafId: number) => string;
  writeLine: (leafId: number, nextLine: string) => boolean;
  getEnvironment: (leafId: number) => "windows" | "linux";
  getRustSessionId: (leafId: number) => number | null;
  getAvailableCommands: (rustSessionId: number | null) => Set<string> | null;
  /** 当前真正接收键盘输入的终端 leaf；用于全局快捷键入口。 */
  getActiveLeafId: () => number | null;
  evaluateRisk: (
    command: string,
  ) => Promise<{ level: RiskLevel; source: "rpc" | "local" }>;
};

export type NextCommandState = {
  visible: boolean;
  leafId: number | null;
  task: "next" | "correct";
  loading: boolean;
  candidates: Candidate[];
  selectedIndex: number;
  messageZh: string;
  requestVersion: number;
  correctionRequest: PredictionRequest | null;
  /** true = 自动检测触发，不是用户按快捷键。 */
  auto: boolean;
  /** line = 当前输入行；block = 刚执行失败的上一行命令。 */
  source: "line" | "block";
};

const EMPTY: NextCommandState = {
  visible: false,
  leafId: null,
  task: "next",
  loading: false,
  candidates: [],
  selectedIndex: 0,
  messageZh: "",
  requestVersion: 0,
  correctionRequest: null,
  auto: false,
  source: "line",
};

let deps: NextCommandDeps | null = null;
let state: NextCommandState = EMPTY;
let versionSeq = 0;
let interceptorRegistered = false;
// 自动纠错（2026-11-13）：用户输入停顿后自动检查行首命令是否拼错，
// 不再要求按 Ctrl+Shift+.；手动入口仍然保留。
let autoTimer: ReturnType<typeof setTimeout> | null = null;
let autoSeq = 0;
let autoVisible = false;
const subscribers = new Set<(state: NextCommandState) => void>();

function setState(patch: Partial<NextCommandState>): void {
  state = { ...state, ...patch };
  for (const notify of subscribers) notify(state);
}

export function initNextCommandInjection(next: NextCommandDeps): void {
  deps = next;
  // 全局快捷键入口（2026-11-13）：真实按键可能落在 xterm 之外（输入条、
  // 分屏容器、焦点被弹窗抢走），且 Ctrl+Shift+. 会被放大等全局快捷键抢占。
  // 这里把入口挂到快捷键层的预抢占钩子上，保证先于所有全局绑定运行。
  if (typeof window !== "undefined" && !interceptorRegistered) {
    interceptorRegistered = true;
    registerShortcutInterceptor(nextCommandShortcutInterceptor);
  }
}

export function subscribeNextCommand(
  fn: (state: NextCommandState) => void,
): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function getNextCommandState(): NextCommandState {
  return state;
}

export function closeNextCommand(): void {
  autoVisible = false;
  if (!state.visible) return;
  setState({ ...EMPTY, requestVersion: state.requestVersion });
}

/** 取消尚未执行的自动纠错检查（回车、粘贴、切上下文时调用）。 */
export function cancelAutoCorrection(): void {
  autoSeq += 1;
  if (autoTimer !== null) {
    clearTimeout(autoTimer);
    autoTimer = null;
  }
}

/** 用户输入变化后重新计时；停顿 delayMs 后再检查。 */
export function scheduleAutoCorrection(leafId: number, delayMs = 450): void {
  cancelAutoCorrection();
  const seq = autoSeq;
  autoTimer = setTimeout(() => {
    autoTimer = null;
    void runAutoCorrection(leafId, seq);
  }, delayMs);
}

/**
 * xterm 每次向 PTY 写用户输入时调用（rendererPool 的 term.onData）。
 * 回车/控制键立即取消；可打印字符与退格重新计时。
 */
export function handleAutoCorrectionInput(leafId: number, data: string): void {
  if (!data) return;
  if (data === "\x7f") {
    scheduleAutoCorrection(leafId);
    return;
  }
  if (/[\x00-\x1f]/.test(data)) {
    cancelAutoCorrection();
    if (autoVisible) closeNextCommand();
    return;
  }
  scheduleAutoCorrection(leafId);
}

/**
 * 行首命令的自动纠错前置条件；不满足 → null（静默）：
 * - 只处理简单命令，管道/重定向/变量不猜；
 * - 命令名必须不在可用集合里，且不是任何可用命令的前缀（仍在输入中）。
 */
function correctionContext(
  leafId: number,
  line: string,
): { first: string; available: Set<string> } | null {
  if (!deps) return null;
  const trimmed = line.trim();
  if (!trimmed || trimmed.length > 160) return null;
  if (/[|&;<>`$(){}[\]\\]/.test(trimmed)) return null;
  if (deps.getEnvironment(leafId) !== "linux") return null;
  const available = deps.getAvailableCommands(deps.getRustSessionId(leafId));
  if (!available || available.size === 0) return null;
  const first = trimmed.split(/\s+/)[0] ?? "";
  if (!first || first.includes("/") || first.includes("=") || first.startsWith("-")) {
    return null;
  }
  if (available.has(first)) return null;
  for (const name of available) {
    if (name.length > first.length && name.startsWith(first)) return null;
  }
  return { first, available };
}

/** python3→python 这类前后缀增删不算拼写错误，自动模式不打扰。 */
function isUsefulAutoCorrection(candidate: Candidate, first: string): boolean {
  const corrected = (candidate.insertText ?? candidate.displayText)
    .trim()
    .split(/\s+/)[0];
  if (!corrected || !first) return false;
  return !corrected.startsWith(first) && !first.startsWith(corrected);
}

async function runAutoCorrection(leafId: number, seq: number): Promise<void> {
  if (!deps || seq !== autoSeq || state.visible) return;
  if (!correctionContext(leafId, deps.getLine(leafId))) return;
  await openCorrection(leafId, { auto: true });
}

/**
 * 上一行命令执行失败后（exitCode 127）自动提示纠错：先让命令执行、看到报错，
 * 再弹窗；接受后只把修正后的命令填回空提示符，不自动执行。
 */
export async function openCorrectionForCommand(
  leafId: number,
  command: string,
): Promise<void> {
  const text = command.trim();
  if (!text) return;
  if (!deps) return;
  // 用户已经开始敲下一条命令时不打扰。
  if (deps.getLine(leafId).trim() !== "") return;
  if (state.visible) closeNextCommand();
  await openCorrection(leafId, { auto: true, text });
}

function explain(status: string, reason?: string): string {
  if (status === "empty") return "本次会话还没有可学习的命令";
  if (status === "unavailable") return reason ?? "当前终端不满足下一步建议条件";
  if (status === "stale") return "上下文已变化，请重新请求";
  if (status === "unknown") return "候选的可用性或风险未知，已保守隐藏";
  return "";
}

/**
 * 纠错词表（2026-11-13）：直接用远端命令全集，而不是只取“本次会话用过的
 * 命令名”。否则应用重启/页面重载后会话统计为空，纠错会一直提示“没有可纠错
 * 的命令名”，自动纠错完全失效。可用性与风险仍在候选生成后逐条按 RPC 复核。
 * 以 Set 实例做缓存键，重连/失效后自然重建。
 */
type CorrectionVocabularyCache = {
  source: Set<string>;
  names: string[];
  availability: Map<string, Availability>;
  risk: Map<string, RiskLevel>;
};

let correctionVocabularyCache: CorrectionVocabularyCache | null = null;

function getCorrectionVocabulary(available: Set<string>): CorrectionVocabularyCache {
  if (correctionVocabularyCache?.source === available) {
    return correctionVocabularyCache;
  }
  const names = [...available];
  const availability = new Map<string, Availability>();
  const risk = new Map<string, RiskLevel>();
  for (const name of names) {
    availability.set(name, "available");
    risk.set(name, "L0");
  }
  correctionVocabularyCache = { source: available, names, availability, risk };
  return correctionVocabularyCache;
}

/** 显式请求一次下一步建议；异步结果只接受最新一次请求。 */
export async function openNextCommand(leafId: number): Promise<void> {
  if (!deps) return;
  cancelAutoCorrection();
  autoVisible = false;
  const requestVersion = ++versionSeq;
  if (deps.getLine(leafId).trim() !== "") {
    setState({
      ...EMPTY,
      visible: true,
      leafId,
      requestVersion,
      messageZh: "当前输入行不为空；下一步建议只用于空行",
    });
    return;
  }
  if (deps.getEnvironment(leafId) !== "linux") {
    setState({
      ...EMPTY,
      visible: true,
      leafId,
      requestVersion,
      messageZh: "当前终端不是 Bash/SSH，暂不提供下一步建议",
    });
    return;
  }
  const available = deps.getAvailableCommands(deps.getRustSessionId(leafId));
  if (!available || available.size === 0) {
    setState({
      ...EMPTY,
      visible: true,
      leafId,
      requestVersion,
      messageZh: "缺少可用命令信息；先在「设置 → 终端预测 → 远端补全组件」刷新",
    });
    return;
  }
  const entries = sessionCommandEntriesForLeaf(leafId);
  if (entries.length === 0) {
    setState({
      ...EMPTY,
      visible: true,
      leafId,
      requestVersion,
      messageZh: "本次会话还没有可学习的命令",
    });
    return;
  }

  setState({
    visible: true,
    leafId,
    loading: true,
    candidates: [],
    selectedIndex: 0,
    messageZh: "正在计算…",
    requestVersion,
  });

  const evaluate = deps.evaluateRisk;
  const evaluated = await Promise.all(
    entries.map(async (entry) => ({
      entry,
      risk: await evaluate(entry.displayText),
    })),
  );
  if (requestVersion !== versionSeq) return;

  const availability = new Map<string, Availability>();
  const risk = new Map<string, RiskLevel>();
  for (const { entry, risk: result } of evaluated) {
    // 远端命令缓存（carapace）里是命令名（如 systemctl），不是整行命令；
    // 用整行去查会把所有带参数的命令误判为 unknown 而全部隐藏。
    const commandName = entry.displayText.trim().split(/\s+/)[0] ?? "";
    availability.set(
      entry.commandKey,
      commandName && available.has(commandName) ? "available" : "unknown",
    );
    risk.set(
      entry.commandKey,
      result.source === "rpc" ? result.level : "unknown",
    );
  }
  if (deps.getLine(leafId).trim() !== "") {
    setState({
      ...EMPTY,
      visible: true,
      leafId,
      requestVersion,
      messageZh: "输入行已变化，请重新请求",
    });
    return;
  }

  const view = suggestNextForLeaf({
    leafId,
    inputVersion: requestVersion,
    now: Date.now(),
    availability,
    risk,
  });
  setState({
    visible: true,
    leafId,
    task: "next",
    loading: false,
    candidates: view.candidates,
    selectedIndex: 0,
    messageZh: view.status === "ok" ? "" : explain(view.status, view.reasonZh),
    requestVersion,
    correctionRequest: null,
    auto: false,
  });
}

/** 显式“当前行纠错”：只改一个 token，保留其它参数，不执行。 */
export async function openCorrection(
  leafId: number,
  opts?: { auto?: boolean; text?: string },
): Promise<void> {
  if (!deps) return;
  const source: "line" | "block" = opts?.text ? "block" : "line";
  if (!opts?.auto) {
    cancelAutoCorrection();
    autoVisible = false;
  }
  const requestVersion = ++versionSeq;
  const line = opts?.text ?? deps.getLine(leafId);
  if (line.trim() === "") {
    if (opts?.auto) return;
    setState({
      ...EMPTY,
      visible: true,
      leafId,
      task: "correct",
      requestVersion,
      messageZh: "当前输入行为空，没有可纠错的内容",
    });
    return;
  }
  if (deps.getEnvironment(leafId) !== "linux") {
    if (opts?.auto) return;
    setState({
      ...EMPTY,
      visible: true,
      leafId,
      task: "correct",
      requestVersion,
      messageZh: "当前终端不是 Bash/SSH，暂不提供纠错",
    });
    return;
  }
  const available = deps.getAvailableCommands(deps.getRustSessionId(leafId));
  if (!available || available.size === 0) {
    if (opts?.auto) return;
    setState({
      ...EMPTY,
      visible: true,
      leafId,
      task: "correct",
      requestVersion,
      messageZh: "缺少可用命令信息；先在「设置 → 终端预测 → 远端补全组件」刷新",
    });
    return;
  }
  const vocabulary = getCorrectionVocabulary(available);
  const names = vocabulary.names;
  if (names.length === 0) {
    if (opts?.auto) return;
    setState({
      ...EMPTY,
      visible: true,
      leafId,
      task: "correct",
      requestVersion,
      messageZh: "远端命令列表为空，暂不提供纠错",
    });
    return;
  }

  if (!opts?.auto) {
    setState({
      visible: true,
      leafId,
      task: "correct",
      loading: true,
      candidates: [],
      selectedIndex: 0,
      messageZh: "正在计算…",
      requestVersion,
      correctionRequest: null,
    });
  }

  const result = suggestCorrectionForLeaf({
    leafId,
    inputVersion: requestVersion,
    now: Date.now(),
    text: line,
    cursor: line.length,
    vocabulary: { commands: names },
    availability: vocabulary.availability,
    risk: vocabulary.risk,
  });
  if (requestVersion !== versionSeq) return;
  if (source === "line") {
    if (deps.getLine(leafId) !== line) {
      if (opts?.auto) return;
      setState({
        ...EMPTY,
        visible: true,
        leafId,
        task: "correct",
        requestVersion,
        messageZh: "输入行已变化，请重新请求",
      });
      return;
    }
  } else if (deps.getLine(leafId).trim() !== "") {
    // 失败命令的纠错：用户已经开始敲下一条命令，不打扰。
    return;
  }
  if (result.view.status !== "ok") {
    if (opts?.auto) return;
    setState({
      ...EMPTY,
      visible: true,
      leafId,
      task: "correct",
      requestVersion,
      messageZh: result.view.reasonZh ?? explain(result.view.status),
    });
    return;
  }

  const evaluate = deps.evaluateRisk;
  const evaluated = await Promise.all(
    result.view.candidates.map(async (candidate) => ({
      candidate,
      risk: await evaluate(candidate.insertText ?? candidate.displayText),
    })),
  );
  if (requestVersion !== versionSeq) return;
  const firstToken = line.trim().split(/\s+/)[0] ?? "";
  const candidates = evaluated
    .filter(
      ({ risk }) =>
        risk.source === "rpc" && (risk.level === "L0" || risk.level === "L1"),
    )
    .filter(
      ({ candidate }) =>
        !opts?.auto || isUsefulAutoCorrection(candidate, firstToken),
    )
    .map(({ candidate, risk }) => ({ ...candidate, risk: risk.level }));
  if (opts?.auto) {
    if (candidates.length === 0) return;
    autoVisible = true;
  }
  setState({
    visible: true,
    leafId,
    task: "correct",
    loading: false,
    candidates,
    selectedIndex: 0,
    messageZh: candidates.length
      ? ""
      : "纠错候选的可用性或风险未确认，已保守隐藏",
    requestVersion,
    correctionRequest: result.request,
    auto: opts?.auto === true,
    source,
  });
}

/** 接受选中候选：只写输入行，不追加换行、不执行。 */
export function acceptNextCommand(index?: number): boolean {
  if (!state.visible || state.leafId === null) return false;
  const candidate = state.candidates[index ?? state.selectedIndex];
  if (!candidate) return false;
  const leafId = state.leafId;
  if (state.task === "correct") {
    if (!state.correctionRequest) return false;
    const current = deps?.getLine(leafId) ?? "";
    if (state.source === "block") {
      // 失败命令纠错：只要求当前提示符仍为空，不要求与失败命令相同。
      if (current.trim() !== "") {
        closeNextCommand();
        return false;
      }
    } else if (
      !correctionTargetIsCurrent(
        state.correctionRequest,
        leafId,
        state.requestVersion,
        current,
        current.length,
      )
    ) {
      closeNextCommand();
      return false;
    }
  }
  const decision = acceptPredictionCandidate(
    candidate,
    leafId,
    state.requestVersion,
  );
  if (!decision.ok) {
    closeNextCommand();
    return false;
  }
  if (!deps?.writeLine(leafId, decision.insertText)) return false;
  closeNextCommand();
  return true;
}

/**
 * 显式入口组合键匹配。按 e.code（物理键）而不是 e.key 判定：
 * 中文输入法/键盘布局下 Shift+. 的 e.key 会变成 ">"，按 key 匹配必然漏。
 *
 * 主组合 Ctrl+Shift+Space / Ctrl+Shift+.；备用 Ctrl+Alt+Space / Ctrl+Alt+.，
 * 用于 IME 或系统占用了主组合的场景。
 */
export type NextCommandAction = "next" | "correct";

export function matchNextCommandAccelerator(
  event: KeyboardEvent,
): NextCommandAction | null {
  if (event.metaKey) return null;
  if (event.ctrlKey && event.shiftKey && event.altKey) return null;
  if (!(event.ctrlKey && (event.shiftKey || event.altKey))) return null;
  if (event.code === "Space") return "next";
  if (event.code === "Period") return "correct";
  return null;
}

/**
 * 组合键只在终端或非编辑区生效：焦点在 AI 输入框、搜索框、设置表单时
 * 不抢按键，避免把正在编辑的内容打断。
 */
function isTerminalShortcutTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return true;
  if (el.closest(".xterm")) return true;
  const tag = el.tagName;
  return !(
    tag === "INPUT" ||
    tag === "TEXTAREA" ||
    tag === "SELECT" ||
    el.isContentEditable
  );
}

/**
 * 全局快捷键入口（预抢占）：不依赖 xterm 焦点，也不让全局快捷键先消费。
 * 返回 true = 已消费本次按键。
 */
export function nextCommandShortcutInterceptor(
  event: KeyboardEvent,
): boolean {
  if (event.type !== "keydown") return false;
  if (event.isComposing || event.keyCode === 229) return false;
  if (!isTerminalShortcutTarget(event.target)) return false;

  if (state.visible && event.key === "Escape") {
    event.preventDefault();
    event.stopImmediatePropagation();
    closeNextCommand();
    return true;
  }

  const action = matchNextCommandAccelerator(event);
  if (!action || !deps) return false;
  if (event.repeat) {
    // 长按不反复开关弹窗。
    event.preventDefault();
    event.stopImmediatePropagation();
    return true;
  }
  const leafId = deps.getActiveLeafId();
  if (leafId === null) return false;

  event.preventDefault();
  event.stopImmediatePropagation();
  // 重复按同一组合键 = 关闭后重新请求（刷新候选）。
  if (state.visible) closeNextCommand();
  if (action === "next") void openNextCommand(leafId);
  else void openCorrection(leafId);
  return true;
}

/**
 * 键盘入口：弹窗打开时消费 ↑↓/Enter/→/Esc；未打开时只消费显式组合键。
 * 返回 false = 已拦截，xterm 不再处理该按键。
 */
export function nextCommandKeyHandler(
  leafId: number,
  event: KeyboardEvent,
): boolean {
  if (event.type !== "keydown") return true;
  if (state.visible && state.leafId === leafId) {
    if (event.key === "Escape") {
      closeNextCommand();
      return false;
    }
    if (
      (event.key === "ArrowDown" || event.key === "ArrowUp") &&
      state.candidates.length > 1
    ) {
      event.preventDefault();
      setState({
        selectedIndex:
          event.key === "ArrowDown"
            ? (state.selectedIndex + 1) % state.candidates.length
            : (state.selectedIndex - 1 + state.candidates.length) %
              state.candidates.length,
      });
      return false;
    }
    if (
      (event.key === "Enter" || event.key === "ArrowRight") &&
      state.candidates.length > 0
    ) {
      event.preventDefault();
      acceptNextCommand();
      return false;
    }
    // 用户开始输入其它内容：关闭弹窗并透传按键。
    closeNextCommand();
    return true;
  }
  const action = matchNextCommandAccelerator(event);
  if (action) {
    event.preventDefault();
    if (action === "next") void openNextCommand(leafId);
    else void openCorrection(leafId);
    return false;
  }
  return true;
}
