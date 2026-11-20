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

export type TerminalLineState = "known-empty" | "known-text" | "unknown";

/**
 * 回填守卫（CORR-02 C2）：写入方在同一同步调用里复核真实输入行，
 * 未知状态或版本/原文不一致一律拒绝——不猜清行，也不发送 Ctrl+C。
 */
export type WriteLineGuard =
  | { requireState: "known-empty"; expectedVersion?: number }
  | { requireState: "known-text"; expectedText: string; expectedVersion?: number };

export type NextCommandDeps = {
  getLine: (leafId: number) => string;
  writeLine: (leafId: number, nextLine: string, guard?: WriteLineGuard) => boolean;
  getEnvironment: (leafId: number) => "windows" | "linux";
  getRustSessionId: (leafId: number) => number | null;
  getAvailableCommands: (
    leafId: number,
    rustSessionId: number | null,
  ) => Set<string> | null;
  /** 命令集尚未就绪时按需拉取（WSL 本地 compgen；SSH 可不实现）。 */
  ensureAvailableCommands?: (leafId: number) => Promise<Set<string> | null>;
  /** 当前真正接收键盘输入的终端 leaf；用于全局快捷键入口。 */
  getActiveLeafId: () => number | null;
  evaluateRisk: (
    command: string,
  ) => Promise<{ level: RiskLevel; source: "rpc" | "local" }>;
  /** 输入行三态（粘贴/光标移动后为 unknown）；缺省时退化为文本判断。 */
  getLineState?: (leafId: number) => TerminalLineState;
  /** 输入行版本：每次可见输入变化递增。 */
  getLineVersion?: (leafId: number) => number;
  /** 终端/连接作用域摘要（环境 + 连接代次 + leaf 代次）；await 后复核。 */
  getScopeToken?: (leafId: number) => string;
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
  /** false = 只显示最优先的一条（默认）；true = 展开全部候选。 */
  expanded: boolean;
  /** 请求时的终端/连接作用域；接受前必须仍然一致。 */
  scopeToken: string | null;
  /** 请求时的输入行版本（line 来源纠错）；接受前必须仍然一致。 */
  lineVersion: number | null;
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
  expanded: false,
  scopeToken: null,
  lineVersion: null,
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

/** 请求时的作用域摘要；未注入 scope 回调时退化为环境 + 连接代次。 */
function readScopeToken(leafId: number): string | null {
  if (!deps) return null;
  if (deps.getScopeToken) return deps.getScopeToken(leafId);
  return `${deps.getEnvironment(leafId)}|${deps.getRustSessionId(leafId) ?? "local"}`;
}

function scopeStillCurrent(leafId: number, scope: string | null): boolean {
  const activeLeaf = deps?.getActiveLeafId();
  if (activeLeaf != null && activeLeaf !== leafId) return false;
  return scope !== null && readScopeToken(leafId) === scope;
}

function readLineState(leafId: number): TerminalLineState | null {
  return deps?.getLineState?.(leafId) ?? null;
}

function readLineVersion(leafId: number): number | null {
  return deps?.getLineVersion?.(leafId) ?? null;
}

/** await 之后、写状态之前：请求代次与真实 owner 都必须仍然有效。 */
function requestStillCurrent(
  leafId: number,
  requestVersion: number,
  scope: string | null,
  lineVersion: number | null,
): boolean {
  return (
    requestVersion === versionSeq &&
    scopeStillCurrent(leafId, scope) &&
    readLineVersion(leafId) === lineVersion
  );
}

/**
 * 请求已失效但面板仍是它自己打开的（例如上下文在计算期间变化）→ 收起。
 * 若已被更新的请求替换（state.requestVersion 不同），不能误关新面板。
 */
function abandonRequest(leafId: number, requestVersion: number): void {
  if (
    state.visible &&
    state.leafId === leafId &&
    state.requestVersion === requestVersion
  ) {
    closeNextCommand();
  }
}

/**
 * 关闭/取消/终端变更都必须让在飞请求过期：代次递增后，任何 await 返回都在
 * 写状态前被 requestStillCurrent 拦下，不能重新打开面板或覆盖新面板。
 */
export function closeNextCommand(): void {
  versionSeq += 1;
  cancelAutoCorrection();
  autoVisible = false;
  if (!state.visible) return;
  setState({ ...EMPTY, requestVersion: versionSeq });
}

/** leaf 销毁/重建/切换：只作废该 leaf 的请求与面板，不影响其它终端。 */
export function handleLeafInvalidated(leafId: number): void {
  versionSeq += 1;
  cancelAutoCorrection();
  autoVisible = false;
  if (state.visible && state.leafId === leafId) {
    setState({ ...EMPTY, requestVersion: versionSeq });
  }
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
  // 多字符输入（粘贴/IME/ESC 序列）不经过逐键缓冲，不能当作“仍在敲同一行”。
  if (data.length > 1) {
    cancelAutoCorrection();
    if (autoVisible) closeNextCommand();
    return;
  }
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
  const available = deps.getAvailableCommands(
    leafId,
    deps.getRustSessionId(leafId),
  );
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
  opts?: { blockId?: string },
): Promise<void> {
  const text = command.trim();
  if (!text) return;
  if (!deps) return;
  // 用户已经切到别的终端：不要在其他 pane 上弹出旧终端的纠错。
  const activeLeaf = deps.getActiveLeafId();
  if (activeLeaf !== null && activeLeaf !== leafId) return;
  // 只能在“可证明的空提示符”上回填：未知输入（粘贴/光标移动）或被用户
  // 改了半行时都不打扰，避免候选写进错误位置。
  const lineState = readLineState(leafId);
  if (lineState !== null && lineState !== "known-empty") return;
  if (deps.getLine(leafId).trim() !== "") return;
  // CORR-03 P1：同一 block 的零候选说明只提示一次；关闭后不晚弹。
  const scope = readScopeToken(leafId);
  const noticeKey = opts?.blockId ? `${scope ?? ""}|${opts.blockId}` : null;
  if (noticeKey && lastEmptyNoticeKey === noticeKey) return;
  if (state.visible) closeNextCommand();
  await openCorrection(leafId, {
    auto: true,
    text,
    notifyEmpty: true,
    blockKey: opts?.blockId,
  });
}

/**
 * CORR-03 P2：显式“更多词形候选”。只有用户点击按钮才调用；
 * 使用有界距离 ≤2 的次级规则，候选仍只回填、不执行，并沿用当前面板的
 * scope/行守卫（unknown 行、已切 leaf、输入已变化都拒绝）。
 */
export async function requestMoreCorrection(): Promise<void> {
  if (!deps || !state.visible || state.leafId === null) return;
  if (state.task !== "correct") return;
  const leafId = state.leafId;
  if (!scopeStillCurrent(leafId, state.scopeToken)) return;
  if (readLineVersion(leafId) !== state.lineVersion) return;
  const fromBlock = state.source === "block";
  const text = fromBlock
    ? (state.correctionRequest?.buffer?.text ?? "")
    : deps.getLine(leafId);
  if (!text.trim()) return;
  await openCorrection(leafId, {
    auto: false,
    text: fromBlock ? text : undefined,
    more: true,
  });
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
  const scope = readScopeToken(leafId);
  const lineVersion = readLineVersion(leafId);
  if (readLineState(leafId) === "unknown") {
    setState({
      ...EMPTY,
      visible: true,
      leafId,
      requestVersion,
      scopeToken: scope,
      messageZh: "输入状态未知（粘贴或光标移动后）；请按 Ctrl+C 清空后再试",
    });
    return;
  }
  if (deps.getLine(leafId).trim() !== "") {
    setState({
      ...EMPTY,
      visible: true,
      leafId,
      requestVersion,
      scopeToken: scope,
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
      scopeToken: scope,
      messageZh: "当前终端不是 Bash/SSH，暂不提供下一步建议",
    });
    return;
  }
  let available = deps.getAvailableCommands(
    leafId,
    deps.getRustSessionId(leafId),
  );
  if ((!available || available.size === 0) && deps.ensureAvailableCommands) {
    available = await deps.ensureAvailableCommands(leafId);
    // 词表可能跨 leaf/连接返回：写任何状态之前复核代次与真实 owner。
    if (!requestStillCurrent(leafId, requestVersion, scope, lineVersion)) {
      abandonRequest(leafId, requestVersion);
      return;
    }
  }
  if (!available || available.size === 0) {
    setState({
      ...EMPTY,
      visible: true,
      leafId,
      requestVersion,
      scopeToken: scope,
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
      scopeToken: scope,
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
    scopeToken: scope,
    expanded: false,
  });

  const evaluate = deps.evaluateRisk;
  const evaluated = await Promise.all(
    entries.map(async (entry) => ({
      entry,
      risk: await evaluate(entry.displayText),
    })),
  );
  if (!requestStillCurrent(leafId, requestVersion, scope, lineVersion)) {
    abandonRequest(leafId, requestVersion);
    return;
  }

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
  const lineState = readLineState(leafId);
  if (lineState === "unknown") {
    closeNextCommand();
    return;
  }
  if (lineState === "known-text") {
    setState({
      ...EMPTY,
      visible: true,
      leafId,
      requestVersion,
      scopeToken: scope,
      messageZh: "输入行已变化，请重新请求",
    });
    return;
  }
  if (deps.getLine(leafId).trim() !== "") {
    setState({
      ...EMPTY,
      visible: true,
      leafId,
      requestVersion,
      scopeToken: scope,
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
    expanded: false,
    scopeToken: scope,
    lineVersion,
  });
}

/**
 * CORR-03 P1：失败命令零候选时的“一次简短反馈”。
 * 键 = scope 代次 + block id，只用于防止同一结果重复提示；不做命令文本永久去重。
 */
let lastEmptyNoticeKey: string | null = null;

function emptyNoticeMessage(status: string): string {
  if (status === "empty") return "上一条命令未找到；没有可靠的单字符修正建议";
  if (status === "unavailable") return "上一条命令未找到；该命令不是可自动纠正的简单命令";
  return "上一条命令未找到；未生成可用的修正建议";
}

function showEmptyCorrectionNotice(args: {
  leafId: number;
  requestVersion: number;
  scope: string | null;
  lineVersion: number | null;
  source: "line" | "block";
  messageZh: string;
  blockKey?: string;
  request?: PredictionRequest | null;
}): void {
  if (args.blockKey) {
    lastEmptyNoticeKey = `${args.scope ?? ""}|${args.blockKey}`;
  }
  // 空候选说明面板：不设置 autoVisible、不提供接受路径；Esc 关闭、Enter/→ 继续终端语义。
  setState({
    ...EMPTY,
    visible: true,
    leafId: args.leafId,
    task: "correct",
    requestVersion: args.requestVersion,
    scopeToken: args.scope,
    lineVersion: args.lineVersion,
    messageZh: args.messageZh,
    source: args.source,
    auto: true,
    correctionRequest: args.request ?? null,
  });
}

/** 显式“当前行纠错”：只改一个 token，保留其它参数，不执行。 */
export async function openCorrection(
  leafId: number,
  opts?: {
    auto?: boolean;
    text?: string;
    /** CORR-03 P1：block 来源零候选时给出一次准确反馈（行内自动检测保持静默）。 */
    notifyEmpty?: boolean;
    blockKey?: string;
    /** CORR-03 P2：使用“更多词形候选”次级规则（有界距离 ≤2）。 */
    more?: boolean;
  },
): Promise<void> {
  if (!deps) return;
  const source: "line" | "block" = opts?.text ? "block" : "line";
  if (!opts?.auto) {
    cancelAutoCorrection();
    autoVisible = false;
  }
  const requestVersion = ++versionSeq;
  const scope = readScopeToken(leafId);
  const lineState = readLineState(leafId);
  // 失败命令纠错只在“可证明的空提示符”上回填；未知输入不弹，避免覆盖用户内容。
  if (source === "block" && lineState !== null && lineState !== "known-empty") {
    return;
  }
  const lineVersion = readLineVersion(leafId);
  const line = opts?.text ?? deps.getLine(leafId);
  if (lineState === "unknown") {
    if (opts?.auto) return;
    setState({
      ...EMPTY,
      visible: true,
      leafId,
      task: "correct",
      requestVersion,
      scopeToken: scope,
      messageZh: "输入状态未知（粘贴或光标移动后）；请按 Ctrl+C 清空后再试",
    });
    return;
  }
  if (line.trim() === "") {
    if (opts?.auto) return;
    setState({
      ...EMPTY,
      visible: true,
      leafId,
      task: "correct",
      requestVersion,
      scopeToken: scope,
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
      scopeToken: scope,
      messageZh: "当前终端不是 Bash/SSH，暂不提供纠错",
    });
    return;
  }
  let available = deps.getAvailableCommands(
    leafId,
    deps.getRustSessionId(leafId),
  );
  if ((!available || available.size === 0) && deps.ensureAvailableCommands) {
    available = await deps.ensureAvailableCommands(leafId);
    if (!requestStillCurrent(leafId, requestVersion, scope, lineVersion)) {
      abandonRequest(leafId, requestVersion);
      return;
    }
  }
  if (!available || available.size === 0) {
    if (opts?.auto) {
      if (opts.notifyEmpty) {
        showEmptyCorrectionNotice({
          leafId,
          requestVersion,
          scope,
          lineVersion,
          source,
          messageZh: "上一条命令未找到；当前无法读取可用命令表，未能生成建议",
          blockKey: opts.blockKey,
        });
      }
      return;
    }
    setState({
      ...EMPTY,
      visible: true,
      leafId,
      task: "correct",
      requestVersion,
      scopeToken: scope,
      messageZh: "缺少可用命令信息；先在「设置 → 终端预测 → 远端补全组件」刷新",
    });
    return;
  }
  const vocabulary = getCorrectionVocabulary(available);
  const names = vocabulary.names;
  if (names.length === 0) {
    if (opts?.auto) {
      if (opts.notifyEmpty) {
        showEmptyCorrectionNotice({
          leafId,
          requestVersion,
          scope,
          lineVersion,
          source,
          messageZh: "上一条命令未找到；当前可用命令表为空，未能生成建议",
          blockKey: opts.blockKey,
        });
      }
      return;
    }
    setState({
      ...EMPTY,
      visible: true,
      leafId,
      task: "correct",
      requestVersion,
      scopeToken: scope,
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
      expanded: false,
      scopeToken: scope,
      lineVersion,
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
    more: opts?.more === true,
  });
  if (!requestStillCurrent(leafId, requestVersion, scope, lineVersion)) return;
  if (source === "line") {
    if (deps.getLine(leafId) !== line) {
      if (opts?.auto) return;
      setState({
        ...EMPTY,
        visible: true,
        leafId,
        task: "correct",
        requestVersion,
        scopeToken: scope,
        messageZh: "输入行已变化，请重新请求",
      });
      return;
    }
  } else if (readLineState(leafId) === "unknown" || deps.getLine(leafId).trim() !== "") {
    // 失败命令的纠错：用户已经开始敲下一条命令（或输入状态未知）时不打扰。
    return;
  }
  if (result.view.status !== "ok") {
    if (opts?.auto) {
      if (opts.notifyEmpty && result.view.status !== "stale") {
        showEmptyCorrectionNotice({
          leafId,
          requestVersion,
          scope,
          lineVersion,
          source,
          messageZh: emptyNoticeMessage(result.view.status),
          blockKey: opts.blockKey,
          request: result.request,
        });
      }
      return;
    }
    setState({
      ...EMPTY,
      visible: true,
      leafId,
      task: "correct",
      requestVersion,
      scopeToken: scope,
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
  if (!requestStillCurrent(leafId, requestVersion, scope, lineVersion)) {
    abandonRequest(leafId, requestVersion);
    return;
  }
  if (source === "line" && deps.getLine(leafId) !== line) {
    abandonRequest(leafId, requestVersion);
    return;
  }
  if (source === "block") {
    const currentState = readLineState(leafId);
    if (currentState === "unknown" || deps.getLine(leafId).trim() !== "") return;
  }
  const firstToken = line.trim().split(/\s+/)[0] ?? "";
  // 纠错只“填入、不执行”；L2（medium，需确认）可以展示并标记，L3/L4 仍隐藏。
  // 不能只放行 L0/L1：read-only 命令（如 grep）在风险引擎里常因 no rule matched
  // 落到 L2，否则纠错对最常见的安全命令永远不出候选。
  const candidates = evaluated
    .filter(
      ({ risk }) =>
        risk.source === "rpc" &&
        (risk.level === "L0" ||
          risk.level === "L1" ||
          risk.level === "L2"),
    )
    .filter(
      ({ candidate }) =>
        !opts?.auto || isUsefulAutoCorrection(candidate, firstToken),
    )
    .map(({ candidate, risk }) => ({ ...candidate, risk: risk.level }));
  if (opts?.auto) {
    if (candidates.length === 0) {
      if (opts.notifyEmpty) {
        showEmptyCorrectionNotice({
          leafId,
          requestVersion,
          scope,
          lineVersion,
          source,
          messageZh: "上一条命令未找到；候选可用性或风险未确认，已保守隐藏",
          blockKey: opts.blockKey,
          request: result.request,
        });
      }
      return;
    }
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
    expanded: false,
    scopeToken: scope,
    lineVersion,
  });
}

/** 点击弹窗头部“展开/收起”：只改展示状态，不改变候选与当前选中项。 */
export function toggleNextCommandExpanded(): void {
  if (!state.visible) return;
  if (state.expanded) {
    setState({ expanded: false, selectedIndex: 0 });
  } else {
    setState({ expanded: true });
  }
}

/** 接受选中候选：只写输入行，不追加换行、不执行。 */
export function acceptNextCommand(index?: number): boolean {
  if (!state.visible || state.leafId === null) return false;
  const candidate = state.candidates[index ?? state.selectedIndex];
  if (!candidate) return false;
  const leafId = state.leafId;
  // 请求代次与真实 owner（leaf/连接/环境）任一变化即作废，不写半行。
  if (state.requestVersion !== versionSeq) {
    closeNextCommand();
    return false;
  }
  if (
    !scopeStillCurrent(leafId, state.scopeToken) ||
    readLineVersion(leafId) !== state.lineVersion
  ) {
    closeNextCommand();
    return false;
  }
  const current = deps?.getLine(leafId) ?? "";
  const lineState = readLineState(leafId);
  if (lineState === "unknown") {
    closeNextCommand();
    return false;
  }
  const knownEmpty = lineState === null ? current.trim() === "" : lineState === "known-empty";
  if (state.task === "correct") {
    if (!state.correctionRequest) return false;
    if (state.source === "block") {
      // 失败命令纠错：只要求当前提示符仍是“可证明的空”。
      if (!knownEmpty) {
        closeNextCommand();
        return false;
      }
    } else {
      // 当前行纠错：目标行必须仍可证明（known-text），再核对原文/光标/版本。
      const knownLine = lineState === null ? current.trim() !== "" : lineState === "known-text";
      if (!knownLine) {
        closeNextCommand();
        return false;
      }
      if (
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
  } else if (!knownEmpty) {
    closeNextCommand();
    return false;
  }
  const decision = acceptPredictionCandidate(
    candidate,
    leafId,
    state.requestVersion,
    state.task === "correct" ? ["L0", "L1", "L2"] : undefined,
  );
  if (!decision.ok) {
    closeNextCommand();
    return false;
  }
  const guard: WriteLineGuard | undefined =
    lineState === null
      ? undefined
      : state.task === "correct" && state.source === "line"
        ? {
            requireState: "known-text",
            expectedText: state.correctionRequest?.buffer?.text ?? "",
            expectedVersion: state.lineVersion ?? undefined,
          }
        : {
            requireState: "known-empty",
            expectedVersion: state.lineVersion ?? undefined,
          };
  if (!deps?.writeLine(leafId, decision.insertText, guard)) {
    closeNextCommand();
    return false;
  }
  closeNextCommand();
  return true;
}

/**
 * 失败命令（exit 127）是否允许自动弹出纠错（CORR-02 C3）：
 * 只有“用户手动输入 + 命令行完整且为单一简单命令 + 非空文本”才成立；
 * 片段/复合命令、Agent 自动执行、旧 shell 无完整性证据都不参与。
 */
export function shouldOfferBlockCorrection(block: {
  author: "user" | "agent";
  exitCode: number | null;
  command: string;
  commandComplete?: boolean;
}): boolean {
  return (
    block.author === "user" &&
    block.exitCode === 127 &&
    block.command.trim() !== "" &&
    block.commandComplete === true
  );
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
  // 面板属于另一个 leaf：用户已切到新终端，旧面板必须在按键路径上失效。
  if (state.visible && state.leafId !== null && state.leafId !== leafId) {
    handleLeafInvalidated(state.leafId);
    return true;
  }
  if (state.visible && state.leafId === leafId) {
    if (event.key === "Escape") {
      closeNextCommand();
      return false;
    }
    // ↓ 第一次只展开（保留首选），已展开后再移动；↑ 在首项时收起。
    // 弹窗可见期间上下键一律不落到 shell（否则会翻到上一条命令）。
    if (
      state.candidates.length > 0 &&
      (event.key === "ArrowDown" || event.key === "ArrowUp")
    ) {
      event.preventDefault();
      if (event.key === "ArrowDown") {
        if (!state.expanded) {
          setState({ expanded: true });
        } else {
          setState({
            selectedIndex:
              (state.selectedIndex + 1) % state.candidates.length,
          });
        }
      } else if (state.expanded) {
        if (state.selectedIndex === 0) {
          setState({ expanded: false, selectedIndex: 0 });
        } else {
          setState({ selectedIndex: state.selectedIndex - 1 });
        }
      }
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
