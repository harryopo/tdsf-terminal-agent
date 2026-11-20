/**
 * completionInjection.ts — 统一终端命令预测注入 (TDSF 2026-08-10 P0 重写)
 * -----------------------------------------------------------------------------
 * 核心设计：维护独立的按键输入缓冲区（不从 xterm buffer 反推），彻底解决
 * 提示符污染问题。适用于本地终端和 SSH 终端（统一通过 rendererPool 注入）。
 *
 * P0 修复（2026-08-10 架构审计后）：
 *   1. getCurrentPrefix 提示符污染 → 改为按键追踪缓冲区
 *   2. loadHistoryIfNeeded 从未调用 → 首次按键时自动调用
 *   3. Enter 不 acceptPrediction → 弹窗可见时 Enter 接受选中项
 *      （2026-08-28 用户钦定推翻：Enter 永远原样透传执行已敲入内容，
 *       接受预测仅限 → 右箭头/鼠标点击，终端操作终端优先）
 *   4. fuzzysort threshold 验证 → 改为保守值
 *
 * P2 #13 修复（2026-08-11 架构审计收尾）：
 *   5. 弹窗跟随终端光标定位 → 通过 xterm buffer.cursorX/Y + .xterm-screen
 *      DOM 尺寸换算像素坐标（measureCursorPx），弹窗出现在光标附近
 *      （computePopupPosition 处理视口边界/上下翻转），取代固定的面板底部居中
 * -----------------------------------------------------------------------------
 */
import type { Terminal as XTerm } from '@xterm/xterm';
import { IS_MAC, isTerminalCopy } from './keymap';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { PREDICTION_CLEAR_EVENT } from '@/lib/predictionEvents';
import {
  buildParamRequest,
  getLeafCwd,
  getLeafRemoteCwd,
  getLeafSshSession,
  getCachedRemoteCommands,
  getCachedRemoteOsInfo,
  mergeCandidates,
  remoteCarapaceInstalled,
  remoteParamComplete,
  type CarapaceCandidate,
} from '@/lib/param-complete-client';
import { commandSupportsFamily, type OsFamily } from '@/lib/os-family';
import {
  COMMAND_ABBREVS,
  findAbbrevSuggestions,
} from '@/lib/command-abbrevs';
import { getSuggestEngine, type SuggestionResult, type TerminalEnv } from '@/lib/suggest-engine';
import {
  isParamCandidateCommand,
  tldrOptionZh,
  tldrParamSuggestions,
} from '@/lib/spec-data/tldr-params';
import { getCommandSpec } from '@/lib/spec-data/loader';
import { suggestOptionValues, suggestParams } from '@/lib/spec-data/paramSuggest';
import { commandContext, completionReplacement } from '@/lib/command-context';
import {
  clearLeafEnvironment as clearEnvironment,
  getLeafEnvironment,
} from './executionHistory';

export { setLeafEnvironment } from './executionHistory';

// ============================================================================
// 类型
// ============================================================================

export interface CursorPx {
  /** 光标像素坐标（相对视口） */
  left: number;
  top: number;
}

export interface CompletionState {
  visible: boolean;
  items: SuggestionResult[];
  selectedIndex: number;
  prefix: string;
  leafId: number | null;
  /** 光标像素坐标（P2 #13，弹窗据此定位）；null = 无 xterm 实例可用 */
  cursor: CursorPx | null;
}

// ============================================================================
// 模块级状态
// ============================================================================

let activeState: CompletionState = {
  visible: false,
  items: [],
  selectedIndex: 0,
  prefix: '',
  leafId: null,
  cursor: null,
};

let activePredictionIsCurrent: (() => boolean) | null = null;

const subscribers = new Set<(state: CompletionState) => void>();

let writeFn: ((leafId: number, data: string) => void) | null = null;

/** P2 #13: 按 leafId 取 xterm 实例（rendererPool 注入），用于光标像素定位 */
let getTermFn: ((leafId: number) => XTerm | null) | null = null;

// ============================================================================
// 输入缓冲区（按键追踪，不从 buffer 反推 → 无提示符污染）
// ============================================================================

/** 每个终端的输入缓冲区 */
const inputBuffers = new Map<number, string>();
const unknownInputLines = new Set<number>();

export function clearLeafEnvironment(leafId: number): void {
  clearEnvironment(leafId);
  inputBuffers.delete(leafId);
  unknownInputLines.delete(leafId);
  if (activeState.visible && activeState.leafId === leafId) closeCompletion();
}

/** 每个终端的环境（windows=本地 pwsh/cmd，linux=SSH 远程）。
 * TDSF 2026-08-28：命令预测必须区分环境——本地终端预测 Windows 命令，
 * SSH 终端预测 Linux 命令，否则本地弹出的 Linux 命令输入了无效。
 * 由 useTerminalSession 在会话创建时按 s.remote 注册。 */
function getInputBuffer(leafId: number): string {
  return inputBuffers.get(leafId) ?? '';
}

function setInputBuffer(leafId: number, value: string): void {
  // Input changes invalidate replies immediately, not after the debounce fires.
  predictSeq++;
  inputBuffers.set(leafId, value);
  setState((s) => (s.visible ? { ...s, visible: false } : s));
}

function clearInputBuffer(leafId: number): void {
  unknownInputLines.delete(leafId);
  setInputBuffer(leafId, '');
}

function invalidateInputLine(leafId: number): void {
  setInputBuffer(leafId, '');
  unknownInputLines.add(leafId);
  closeCompletion();
}

// ============================================================================
// 初始化
// ============================================================================

export function initCompletionInjection(
  getTerm: (leafId: number) => XTerm | null,
  write: (leafId: number, data: string) => void,
): void {
  // P2 #13: 保存 getTerm 供光标像素定位（按键追踪本身不从 xterm buffer 反推）
  getTermFn = getTerm;
  writeFn = write;
}

/** 监听只注册一次 */
let clearListenerReady = false;

/**
 * 主窗启动时注册（src/main.tsx）：设置窗点「清空预测历史」时，动手的必须是本窗——
 * 预测历史活在主窗内存里，设置窗是独立 JS context，它自己那份引擎永远是空的。
 * 放在 main.tsx 而不是 initCompletionInjection：后者要等第一个终端渲染器创建，
 * 而用户可能一个终端都没开就去设置里点清空。
 * 浏览器预览模式没有 Tauri 事件总线，注册失败安静跳过。
 */
export function initPredictionClearListener(): void {
  if (clearListenerReady || typeof window === 'undefined') return;
  clearListenerReady = true;
  try {
    void listen(PREDICTION_CLEAR_EVENT, () => clearPredictionHistory()).catch(() => {
      // 无 Tauri 运行时（浏览器预览）：忽略
    });
  } catch {
    // 同上
  }
}

/**
 * 清空本窗预测历史（两个环境一起清），并把"历史已加载"钉成 true ——
 * 否则用户清空后第一次敲键又会触发一次 histfile 导入，清空当场被回填。
 */
export function clearPredictionHistory(): void {
  historyLoaded = true;
  getSuggestEngine().clearHistory();
}

// ============================================================================
// 光标像素定位（P2 #13：弹窗跟随终端光标）
// ============================================================================

/**
 * 计算 xterm 光标当前的像素坐标（相对视口）。
 *
 * 原理：xterm 的字符网格尺寸 = .xterm-screen（或 .xterm-rows）DOM 尺寸 ÷ cols/rows；
 * 光标位置 = 网格左上角 + cursorX/cursorY × 单格尺寸。
 * 不依赖 xterm 私有 API（_core），仅用公开的 buffer + DOM 结构。
 */
export function measureCursorPx(
  getTerm: ((leafId: number) => XTerm | null) | null,
  leafId: number,
): CursorPx | null {
  if (!getTerm) return null;
  const term = getTerm(leafId);
  if (!term || !term.element) return null;
  const buf = term.buffer.active;
  const screenEl = term.element.querySelector<HTMLElement>('.xterm-screen');
  const rowsEl = term.element.querySelector<HTMLElement>('.xterm-rows');
  const el = screenEl ?? rowsEl;
  if (!el) return null;
  const rect = el.getBoundingClientRect();
  const cols = Math.max(term.cols, 1);
  const rows = Math.max(term.rows, 1);
  return {
    left: rect.left + buf.cursorX * (rect.width / cols),
    top: rect.top + buf.cursorY * (rect.height / rows),
  };
}

/** 预测弹窗固定宽度（与 TerminalCompletionPopup 的 w-96 一致） */
export const POPUP_WIDTH = 384;

/**
 * 计算弹窗定位：优先贴在光标下方，视口右/下溢出时收拢，
 * 下方放不下时翻转到光标上方。返回弹窗左上角坐标。
 */
export function computePopupPosition(
  cursor: CursorPx,
  viewport: { width: number; height: number },
  itemsCount: number,
): { left: number; top: number } {
  // 估算弹窗高度：顶部提示栏 ~24px + 每行 ~30px + padding ~8px
  const estHeight = 24 + itemsCount * 30 + 8;
  const left = Math.min(
    Math.max(cursor.left, 8),
    Math.max(8, viewport.width - POPUP_WIDTH - 8),
  );
  const offsetBelow = 12;
  let top = cursor.top + offsetBelow;
  if (top + estHeight > viewport.height) {
    top = Math.max(8, cursor.top - estHeight - offsetBelow);
  }
  return { left, top };
}

// ============================================================================
// 状态管理
// ============================================================================

type SetStateArg = CompletionState | ((prev: CompletionState) => CompletionState);

function setState(arg: SetStateArg): void {
  const next = typeof arg === 'function' ? arg(activeState) : arg;
  if (next === activeState) return;
  if (!next.visible) activePredictionIsCurrent = null;
  activeState = next;
  for (const sub of subscribers) sub(next);
}

export function subscribeCompletion(cb: (state: CompletionState) => void): () => void {
  subscribers.add(cb);
  cb(activeState);
  return () => subscribers.delete(cb);
}

export function getCompletionState(): CompletionState {
  return activeState;
}

// ============================================================================
// 更新预测
// ============================================================================

/** 预测请求序号：防止异步参数加载结果覆盖更新的输入 */
let predictSeq = 0;

/**
 * 预测请求节流（#152，2026-09-27）。实测事实：连打 271 个字符曾打出 124 次
 * carapace 起停；单条 `carapace git export` 只要 ~190ms，而 20 条并发时每条
 * 涨到 474–599ms ⇒ 全部撞在 Rust 侧 500ms 强杀线上。**风暴本身就是超时的原因**，
 * 所以本地参数预测从来没出过候选。两层节流：
 *   ① 连打合并（debounce）：一次停顿只发一条；
 *   ② 同一时刻只允许一条在飞，在飞期间的新请求只留最后一次、回来后补打
 *      （人速打字 ~100ms/键，光靠 ① 仍会堆并发）。
 */
export const PREDICT_DEBOUNCE_MS = 120;

let predictTimer: ReturnType<typeof setTimeout> | null = null;
let predictInFlight = false;
let predictQueuedLeaf: number | null = null;

function schedulePredictionUpdate(leafId: number): void {
  if (predictTimer) clearTimeout(predictTimer);
  predictTimer = setTimeout(() => {
    predictTimer = null;
    void runPredictionUpdate(leafId);
  }, PREDICT_DEBOUNCE_MS);
}

async function runPredictionUpdate(leafId: number): Promise<void> {
  await updatePredictions(leafId);
}

/**
 * 撤掉待跑的更新。缓冲区已经清空或已改写的场合必须取消 —— 否则延迟到达的
 * 更新会拿旧行去请求参数，甚至把弹窗按一个已经不存在的 prefix 弹出来。
 */
function cancelScheduledPredictionUpdate(): void {
  predictSeq++;
  if (predictTimer) {
    clearTimeout(predictTimer);
    predictTimer = null;
  }
  predictQueuedLeaf = null;
}

/**
 * 命令模式候选按远端命令全集过滤（二轮改进：根治假预测）。
 * cmds 为 null（远端命令全集未拉到）→ 原样降级不过滤（无损）；
 * history 来源豁免（历史是真实执行过的，远端没有也可能是容器/临时装过）。
 */
export function filterCommandItems(
  items: readonly SuggestionResult[],
  cmds: Set<string> | null,
  limit = 5,
  family: OsFamily = 'unknown',
): SuggestionResult[] {
  return items
    .filter((it) =>
      it.source === 'history' ||
      (commandSupportsFamily(it.command, family) && (cmds === null || cmds.has(it.command))),
    )
    .slice(0, limit);
}

/**
 * 尾部无空格参数触发的存在性门禁（纯函数，可测）。
 *
 * - linux：token 必须在远端命令全集——tldr 有参数数据 ≠ 远端装了命令
 *   （用户实测：输 ag 弹 -l 且按 → 覆盖命令）；命令集未拉到 → 不触发（保守）
 * - windows：引擎词典必须命中——词典外命令的参数只会是假数据
 * - hasDataSrc：isParamCandidateCommand(token) || COMMAND_ABBREVS 有
 */
export function shouldTriggerTailParams(
  env: TerminalEnv,
  token: string,
  hasDataSrc: boolean,
  remoteCmds: Set<string> | null,
  engineHit: boolean,
  family: OsFamily = 'unknown',
): boolean {
  if (!hasDataSrc) return false;
  if (env === 'linux') {
    return remoteCmds !== null && remoteCmds.has(token) && commandSupportsFamily(token, family);
  }
  return engineHit;
}

/**
 * 命令预测 + 参数候选合并（尾部无空格触发用）：
 * 命令模式结果优先，参数候选按 command 去重追加，最多再带 paramLimit 条
 * （总上限 = 命令条数 + paramLimit，调用方命令侧已截 5 → 即"限 5+3"）。
 */
export function mergeCommandWithParamItems(
  cmdItems: readonly SuggestionResult[],
  paramItems: readonly SuggestionResult[],
  paramLimit = 3,
): SuggestionResult[] {
  const seen = new Set(cmdItems.map((it) => it.command));
  const out = [...cmdItems];
  for (const it of paramItems) {
    if (out.length >= cmdItems.length + paramLimit) break;
    if (seen.has(it.command)) continue;
    seen.add(it.command);
    out.push(it);
  }
  return out;
}

/**
 * 参数模式候选追加子命令缩写（二轮改进：ip a → address 等教学高频缩写）。
 * 子命令位置优先保留四条常用中文候选，不被满表选项挤掉，整体限 8。
 */
export function appendAbbrevItems(
  items: readonly SuggestionResult[],
  cmd: string,
  prefix: string,
): SuggestionResult[] {
  const { tokens, current } = buildParamRequest(prefix);
  const bare = tokens.length === 1;
  if (!bare && (tokens.length !== 2 || current === '')) return items.slice(0, 8);
  const abbrevs = findAbbrevSuggestions(cmd, bare ? '' : current);
  if (abbrevs.length === 0) return items.slice(0, 8);
  const seen = new Set<string>();
  const out: SuggestionResult[] = [];
  for (const it of [...abbrevs.slice(0, 4), ...items, ...abbrevs.slice(4)]) {
    if (out.length >= 8) break;
    if (seen.has(it.command)) continue;
    seen.add(it.command);
    out.push(it);
  }
  return out;
}

/** Static and dynamic sources publish independently; only dynamic work is single-flight. */
async function loadParamPredictions(
  leafId: number,
  env: TerminalEnv,
  cmd: string,
  prefix: string,
  isCurrent: () => boolean,
  showStatic: (items: SuggestionResult[]) => void,
): Promise<SuggestionResult[]> {
  const { tokens, current } = buildParamRequest(prefix);
  const sessionId = getLeafSshSession(leafId);
  const cmds = env === 'linux' && sessionId !== null ? getCachedRemoteCommands(sessionId) : null;
  const family = env === 'linux' && sessionId !== null ? getCachedRemoteOsInfo(sessionId)?.family ?? 'unknown' : 'unknown';
  if (!commandSupportsFamily(cmd, family)) return [];
  const remoteGate = cmds === null || cmds.has(cmd);
  const local: SuggestionResult[] = [];
  let dynamic: SuggestionResult[] = [];
  const merge = () => {
    const descriptions = new Map(local.map((item) => [item.command, item.description]));
    const result: SuggestionResult[] = dynamic.map((item) => ({ ...item, description: tldrOptionZh(cmd, item.command) ?? descriptions.get(item.command) ?? item.description }));
    for (const item of local) if (!result.some((entry) => entry.command === item.command) && result.length < 8) result.push(item);
    return result.slice(0, 8);
  };
  const push = (items: readonly SuggestionResult[]) => {
    for (const it of items) {
      if (local.some((item) => item.command === it.command) || local.length >= 8) continue;
      local.push({ ...it, description: tldrOptionZh(cmd, it.command) ?? it.description });
    }
  };
  const staticRequest = (async () => {
    const spec = remoteGate ? await getCommandSpec(cmd).catch(() => null) : null;
    if (!isCurrent()) return;
    const values = spec ? suggestOptionValues(spec, prefix, 8) : null;
    if (values !== null) {
      push(values);
    } else if (remoteGate) {
      const fig = spec ? suggestParams(spec, prefix, 8) : [];
      // Real nested subcommands/positional values must not be crowded out by flags.
      push(fig.filter((item) => !item.command.startsWith('-')));
      push(tldrParamSuggestions(cmd, current));
      push(fig);
    }
    showStatic(merge());
  })();
  const dynamicRequest = (async () => {
    if (predictInFlight) {
      predictQueuedLeaf = leafId;
      return;
    }
    predictInFlight = true;
    try {
      if (env === 'windows') {
        const candidates = await invoke<CarapaceCandidate[]>('param_complete', {
          cmd, tokens, current, cwd: getLeafCwd(leafId),
        });
        dynamic = mergeCandidates(candidates ?? [], [], { zhDescription: (value) => tldrOptionZh(cmd, value) });
      } else if (sessionId !== null && await remoteCarapaceInstalled(sessionId) && isCurrent()) {
        dynamic = await remoteParamComplete(sessionId, cmd, tokens.slice(1), current, getLeafRemoteCwd(leafId), {
          zhDescription: (value) => tldrOptionZh(cmd, value),
        }) ?? [];
      }
      if (isCurrent()) showStatic(merge());
    } catch {
      // The independent static source remains available on request failure.
    } finally {
      predictInFlight = false;
      if (predictQueuedLeaf !== null) {
        const next = predictQueuedLeaf;
        predictQueuedLeaf = null;
        schedulePredictionUpdate(next);
      }
    }
  })();
  await Promise.all([staticRequest, dynamicRequest]);
  return merge();
}

async function updatePredictions(leafId: number): Promise<void> {
  if (unknownInputLines.has(leafId)) return;
  const seq = predictSeq;
  const env = getLeafEnvironment(leafId);
  const prefix = getInputBuffer(leafId);
  const sessionId = getLeafSshSession(leafId);
  const cwd = sessionId !== null ? getLeafRemoteCwd(leafId) : getLeafCwd(leafId);
  const isContextCurrent = () => seq === predictSeq && prefix === getInputBuffer(leafId) &&
    env === getLeafEnvironment(leafId) && sessionId === getLeafSshSession(leafId) &&
    cwd === (sessionId !== null ? getLeafRemoteCwd(leafId) : getLeafCwd(leafId));
  const isCurrent = () => {
    const term = getTermFn?.(leafId);
    return isContextCurrent() &&
      (!term?.element || term.element.contains(document.activeElement));
  };
  if (!isCurrent()) return;
  if (!prefix || prefix.trim() === '') {
    setState((s) => (s.visible ? { ...s, visible: false } : s));
    return;
  }

  const context = commandContext(prefix);
  if (!context.cmd) {
    setState((s) => (s.visible ? { ...s, visible: false } : s));
    return;
  }
  if (context.tokens.length > 1 || context.current === '') {
    // ── 参数模式：命令 + 子命令/选项/参数值/动态值（分支/目录/PID）────────
    // TDSF 2026-08-28：移除 env === 'linux' 硬限制（spec: add-carapace-param-completion），
    // 按环境分流到本地 carapace（param_complete）/ 远端 carapace（ssh_command），
    // 失败统一回退 Fig specs 静态层（linux），Windows 无 spec 可回退则静默无预测。
    // TDSF 2026-08-28(二)：loadParamPredictions 内部已串联 carapace→tldr→Fig specs
    // 三源；此处再追加子命令缩写候选（ip a → address 等教学高频缩写）。
    const cmd = context.cmd;
    const show = (loaded: SuggestionResult[]) => {
      if (!isCurrent()) return;
      const items = appendAbbrevItems(loaded, cmd, prefix);
      if (!items.length) {
        setState((s) => (s.visible ? { ...s, visible: false } : s));
        return;
      }
      activePredictionIsCurrent = isContextCurrent;
      setState({
        visible: true,
        items,
        selectedIndex: 0,
        prefix,
        leafId,
        cursor: measureCursorPx(getTermFn, leafId),
      });
    };
    const loaded = await loadParamPredictions(leafId, env, cmd, prefix, isCurrent, show);
    show(loaded);
    return;
  }

  // ── 命令模式：history → 索引 startsWith → fuzzy（fish 三层，按环境分流）──
  // 可用性先参与候选选择，避免不存在的别名占满截断窗口。
  // 缓存未拉到时只应用已知发行版边界，历史候选继续保留。
  const engine = getSuggestEngine();
  const isLinux = env === 'linux';
  const cmds = isLinux && sessionId !== null ? getCachedRemoteCommands(sessionId) : null;
  // Seed before querying, including commands absent from the static dictionary.
  // Current-session filtering below still prevents cross-host candidates.
  if (cmds) engine.setEnvironmentCommands(cmds, 'linux');
  const family = sessionId !== null ? getCachedRemoteOsInfo(sessionId)?.family ?? 'unknown' : 'unknown';
  const acceptCommand = isLinux
    ? (command: string) => commandSupportsFamily(command, family) && (cmds === null || cmds.has(command))
    : undefined;
  let items = engine.getSuggestions(context.cmd, 5, env, acceptCommand);
  if (isLinux) {
    items = filterCommandItems(items, cmds, 5, family);
  }

  // P2 #13 的弹窗展示统一入口（光标像素坐标在按键后 xterm 已刷新）
  const show = (list: readonly SuggestionResult[]) => {
    activePredictionIsCurrent = isContextCurrent;
    setState({
      visible: true,
      items: [...list],
      selectedIndex: 0,
      prefix,
      leafId,
      cursor: measureCursorPx(getTermFn, leafId),
    });
  };

  const token = context.cmd;
  let shown = false;
  // 有命令候选先立即展示（参数加载是异步远端 exec，不能阻塞命令预测显示）
  if (items.length > 0) {
    show(items);
    shown = true;
  }

  // 尾部无空格参数触发（用户实测：输完 `ls` 应立刻弹参数窗口，不用先敲空格）：
  // 数据源判断含缩写表——ip 不在 tldr/Fig specs（实测确认），但缩写表有
  // a=address 等教学高频子命令，输完 `ip` 同样要能弹出。
  //
  // 存在性门禁（用户实测反馈：输无关的 ag 弹出 -l，按 → 还把命令覆盖成 -l）：
  // linux 以远端命令全集为准（不看词典——ip 不在词典但缩写表有，是用户要的
  // 场景）；windows 以引擎词典为准。详见 shouldTriggerTailParams。
  const engineHit =
    items.length > 0 || engine.getSuggestions(token, 1, env).length > 0;
  const remoteCmds =
    env === 'linux' && sessionId !== null
      ? getCachedRemoteCommands(sessionId)
      : null;
  const hasParamSource = shouldTriggerTailParams(
    env,
    token,
    isParamCandidateCommand(token) ||
      Object.prototype.hasOwnProperty.call(COMMAND_ABBREVS, token),
    remoteCmds,
    engineHit,
    family,
  );
  if (hasParamSource) {
    // 加尾空格使 buildParamRequest 的 current=''（全量参数候选）；
    // 缩写候选在 appendAbbrevItems 内追加（与参数模式同一套合并逻辑）
    const commandItems = items;
    const showParams = (params: SuggestionResult[]) => {
      if (!isCurrent()) return;
      items = mergeCommandWithParamItems(commandItems, appendAbbrevItems(params, token, prefix + ' '));
      if (items.length) { show(items); shown = true; }
    };
    const paramItems = await loadParamPredictions(leafId, env, token, prefix + ' ', isCurrent, showParams);
    if (!isCurrent()) return;
    const before = items.length;
    items = mergeCommandWithParamItems(commandItems, appendAbbrevItems(paramItems, token, prefix + ' '));
    if (items.length > before) {
      // 参数候选有新增 → 覆盖展示（命令候选在前，参数候选追加在后）
      show(items);
      shown = true;
    }
  }

  if (!shown) {
    setState((s) => (s.visible ? { ...s, visible: false } : s));
  }
}

export function closeCompletion(): void {
  cancelScheduledPredictionUpdate();
  setState((s) => (s.visible ? { ...s, visible: false } : s));
}

// ============================================================================
// 接受预测
// ============================================================================

function acceptPrediction(leafId: number, entry: SuggestionResult): boolean {
  if (!writeFn || /[\x00-\x1f\x7f]/.test(entry.command)) return false;
  // 鼠标点击会把焦点移到弹窗；接受时只复核候选所属行、环境、连接和目录。
  if (!activePredictionIsCurrent?.()) {
    closeCompletion();
    return false;
  }
  // 接受即改写缓冲区：待跑的更新必须撤掉，否则延迟到达的那次会按接受前的
  // 半行去请求参数，并把弹窗重新弹回来。
  cancelScheduledPredictionUpdate();

  const line = getInputBuffer(leafId);
  const { from, text } = completionReplacement(line, entry.command, entry.kind === 'arg', getLeafEnvironment(leafId) === 'windows');
  // Replace only the active token/command, preserving wrappers, pipes and quotes.
  writeFn(leafId, '\b'.repeat(Array.from(line.slice(from)).length) + text);
  setInputBuffer(leafId, line.slice(0, from) + text);
  // 历史污染止血（2026-08-28，用户实测反馈）：原来"接受预测即记历史"——
  // 输入 ag 点 → 就算执行过，ag: command not found 也进历史。第二轮 OSC
  // 真实执行记录（exit code + 完整命令行）上线前，停止一切运行时历史写入；
  // windows 环境保留启动时 shell history 文件注入（PSReadLine 只写执行过的）。
  // getSuggestEngine().addHistory(entry.command, getLeafEnvironment(leafId));
  setState((s) => ({ ...s, visible: false }));
  return true;
}

export function selectCompletionByIndex(index: number): void {
  const current = activeState;
  if (!current.visible || current.leafId === null || index < 0 || index >= current.items.length) return;
  acceptPrediction(current.leafId, current.items[index]);
}

// ============================================================================
// 核心：键盘拦截器
// ============================================================================

export function completionKeyHandler(
  leafId: number | null,
  event: KeyboardEvent,
): boolean {
  if (leafId === null) return true;

  // 只处理 keydown
  if (event.type !== 'keydown') return true;

  // IME 组合输入不处理
  if (event.isComposing || event.keyCode === 229) return true;

  // Copy never changes the shell's input line.
  if (isTerminalCopy(event, { isMac: IS_MAC })) return true;

  const current = activeState;
  const isVisible = current.visible && current.leafId === leafId;
  // Modified arrows belong to the terminal's readline/xterm handling.
  const hasModifiers = event.ctrlKey || event.altKey || event.metaKey || event.shiftKey;

  // === Ctrl+C / Ctrl+U → 清空缓冲区 + 关闭弹窗 ===
  if (event.ctrlKey && (event.key === 'c' || event.key === 'C' || event.key === 'u' || event.key === 'U')) {
    clearInputBuffer(leafId);
    cancelScheduledPredictionUpdate();
    setState((s) => (s.visible ? { ...s, visible: false } : s));
    return true;
  }

  // === 右箭头 = 接受第一条预测（只在弹窗可见时） ===
  if (event.key === 'ArrowRight' && !hasModifiers && isVisible && current.items.length > 0) {
    if (acceptPrediction(leafId, current.items[current.selectedIndex])) return false;
  }

  // === 向下箭头 = 选择下一条预测 ===
  if (event.key === 'ArrowDown' && !hasModifiers && isVisible && current.items.length > 1) {
    event.preventDefault();
    setState((s) => ({
      ...s,
      selectedIndex: (s.selectedIndex + 1) % s.items.length,
    }));
    return false;
  }

  // === 向上箭头 = 选择上一条预测 ===
  if (event.key === 'ArrowUp' && !hasModifiers && isVisible && current.items.length > 1) {
    event.preventDefault();
    setState((s) => ({
      ...s,
      selectedIndex: (s.selectedIndex - 1 + s.items.length) % s.items.length,
    }));
    return false;
  }

  // === Tab = 透传远端原生补全 + 关闭弹窗 ===
  if (event.key === 'Tab') {
    invalidateInputLine(leafId);
    return true;
  }

  // === Escape = 关闭弹窗 ===
  if (event.key === 'Escape') {
    closeCompletion();
    return true;
  }

  // === Enter = 永远原样透传（终端操作终端优先，用户钦定 2026-08-28）===
  // 弹窗可见时 Enter 也只执行"用户已敲入的内容"，绝不接受预测——
  // 接受预测仅限 → 右箭头（597-601 行）与鼠标点击候选项。历史运行时写入已停
  // （历史污染止血，见下方注释块），来源收敛到 shell history 文件注入。
  if (event.key === 'Enter') {
    // 历史污染止血（2026-08-28，用户实测反馈）：原来"Enter 即记"——没执行/
    // 执行失败的输入（lsb、拼错的词）都进历史，用户反馈"又惊喜又鸡肋"。
    // 停止运行时写入，历史来源收敛到 windows shell history 文件（真实执行）
    // 与第二轮 OSC 真实执行记录（exit code 过滤，待上线）。
    // const prefix = getInputBuffer(leafId);
    // if (prefix.trim()) {
    //   getSuggestEngine().addHistory(prefix.trim(), getLeafEnvironment(leafId));
    // }
    // Enter → 清空缓冲区（新的一行）
    clearInputBuffer(leafId);
    cancelScheduledPredictionUpdate();
    setState((s) => (s.visible ? { ...s, visible: false } : s));
    return true; // 透传 Enter 让命令执行
  }

  // === Backspace → 从缓冲区删除 + 更新预测 ===
  if (event.key === 'Backspace' && !event.ctrlKey && !event.altKey && !event.metaKey) {
    if (unknownInputLines.has(leafId)) return true;
    const buf = getInputBuffer(leafId);
    if (buf.length > 0) {
      setInputBuffer(leafId, buf.slice(0, -1));
    }
    schedulePredictionUpdate(leafId);
    return true;
  }

  // === 缓冲失效键（粘贴 / 删词 / 光标移动）===============================
  // 缓冲只追踪"追加输入", 粘贴 (Ctrl+V)、删词 (Ctrl/Alt+Backspace)、
  // 光标移动 (←→/Home/End) 会让缓冲区与终端实际行失配, 继续基于旧缓冲
  // 预测会给出错误补全破坏命令 (P1-10, 2026-08-18)。失配即失效:
  // 清空缓冲 + 关闭弹窗, 宁可无预测也不给错误预测。
  if (
    ((event.ctrlKey || event.metaKey) &&
      (event.key === 'v' || event.key === 'V')) ||
    (event.shiftKey && event.key === 'Insert')
  ) {
    invalidateInputLine(leafId);
    return true;
  }
  if (
    (event.ctrlKey || event.altKey || event.metaKey) &&
    event.key === 'Backspace'
  ) {
    invalidateInputLine(leafId);
    return true;
  }
  if (
    event.key === 'ArrowLeft' ||
    event.key === 'ArrowRight' ||
    event.key === 'ArrowUp' ||
    event.key === 'ArrowDown' ||
    event.key === 'Home' ||
    event.key === 'End' ||
    (event.ctrlKey && /^[aekwrdhy]$/i.test(event.key)) ||
    (event.altKey && /^[bfd]$/i.test(event.key))
  ) {
    // 弹窗可见时的 ArrowRight 已在上面"接受预测"分支拦截, 不会落此;
    // 光标移出行尾后缓冲已失配, 清空 + 关闭弹窗。
    invalidateInputLine(leafId);
    return true;
  }

  // === 可打印字符 → 追加到缓冲区 + 更新预测 ===
  if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    if (unknownInputLines.has(leafId)) return true;
    const buf = getInputBuffer(leafId);
    setInputBuffer(leafId, buf + event.key);
    schedulePredictionUpdate(leafId);
    return true;
  }

  return true; // 所有其他键透传
}

// ============================================================================
// Shell history 加载
// ============================================================================

let historyLoaded = false;

/**
 * 把 shell 历史行洗成"可以用于预测的命令名"（TDSF 2026-09-19，用户反馈
 * "有时候敲错命令也当成历史了"）。
 *
 * shell 的 histfile 不区分成功与失败（bash/zsh/pwsh 都会把 command not found
 * 那一行原样写进去），所以整份导入就等于把手误也变成预测候选。规则：
 * 取首词、先剥 `sudo` 再校验，长度 ≥2、只允许命令名字符、丢控制字符残行，
 * 最关键的是**必须在"真实环境命令集 ∪ 字典"里**——不在的一律不进预测历史。
 *
 * 纯函数：`isKnown` 由调用方注入，方便单测双向断言。
 */
export function sanitizeShellHistory(
  lines: readonly string[],
  isKnown: (name: string) => boolean,
): string[] {
  const out: string[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length < 2) continue;
    if (/[\x00-\x1f\x7f]/.test(line)) continue; // 历史文件里的控制字符残行
    const tokens = line.split(/\s+/);
    let name = tokens[0] ?? '';
    if (name === 'sudo' || name === 'doas') name = tokens[1] ?? '';
    if (name.length < 2) continue;
    if (!/^[A-Za-z0-9._+-]+$/.test(name)) continue; // 纯参数 / 路径 / 变量赋值残行
    if (!isKnown(name)) continue; // 字典与真实环境都没有 → 大概率是敲错的
    out.push(name);
  }
  return out;
}

export async function loadHistoryIfNeeded(): Promise<void> {
  if (historyLoaded) return;
  historyLoaded = true;
  try {
    // 用户可以从设置里关掉这条导入：否则「清空预测历史」一重启就被 histfile 里的
    // 手误行重新灌满，清空等于没做。判断放在读文件之前——关掉就应当连
    // ~/.bash_history / ConsoleHost_history.txt 都不去读，而不是读了再丢掉。
    const { usePreferencesStore } = await import('@/modules/settings/preferences');
    if (!usePreferencesStore.getState().predictionImportShellHistory) {
      return;
    }
    const { loadHistoryFromRust, parseShellHistory } = await import('@/lib/shell-history');
    const { historyCommands } = await import('@/modules/terminal/block/lib/history');
    const info = await loadHistoryFromRust();
    if (info.commands.length === 0) return;
    const engine = getSuggestEngine();
    // 先用真实环境命令集（本机 PATH 可执行文件 + 历史首词）扩充候选，再拿它当
    // 过滤器：这样"本机装了但静态字典没有"的工具仍然预测得到，而错拼的名字进不来。
    engine.setEnvironmentCommands(await historyCommands('', 2000), 'windows');
    const parsed = parseShellHistory(info.commands.join('\n'), info.shellType);
    // 本地 shell（pwsh/powershell/cmd）历史 → windows 环境
    // （SSH 会话的历史由远端 shell 自身管理，不在此加载）
    engine.loadHistory(
      sanitizeShellHistory(parsed, (name) => engine.isKnownCommand(name, 'windows')),
      'windows',
    );
  } catch (e) {
    // 非致命——浏览器预览模式或 Rust 命令未注册时降级
    console.warn('[completion] loadHistoryIfNeeded failed:', e);
  }
}
