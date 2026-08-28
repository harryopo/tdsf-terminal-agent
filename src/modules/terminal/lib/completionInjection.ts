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
 *   4. fuzzysort threshold 验证 → 改为保守值
 *
 * P2 #13 修复（2026-08-11 架构审计收尾）：
 *   5. 弹窗跟随终端光标定位 → 通过 xterm buffer.cursorX/Y + .xterm-screen
 *      DOM 尺寸换算像素坐标（measureCursorPx），弹窗出现在光标附近
 *      （computePopupPosition 处理视口边界/上下翻转），取代固定的面板底部居中
 * -----------------------------------------------------------------------------
 */
import type { Terminal as XTerm } from '@xterm/xterm';
import { invoke } from '@tauri-apps/api/core';
import {
  buildParamRequest,
  getLeafCwd,
  getLeafRemoteCwd,
  getLeafSshSession,
  getCachedRemoteCommands,
  mergeCandidates,
  remoteCarapaceInstalled,
  remoteParamComplete,
  type CarapaceCandidate,
} from '@/lib/param-complete-client';
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
import { parseCommandLine, suggestParams } from '@/lib/spec-data/paramSuggest';

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

const subscribers = new Set<(state: CompletionState) => void>();

let writeFn: ((leafId: number, data: string) => void) | null = null;

/** P2 #13: 按 leafId 取 xterm 实例（rendererPool 注入），用于光标像素定位 */
let getTermFn: ((leafId: number) => XTerm | null) | null = null;

// ============================================================================
// 输入缓冲区（按键追踪，不从 buffer 反推 → 无提示符污染）
// ============================================================================

/** 每个终端的输入缓冲区 */
const inputBuffers = new Map<number, string>();

/** 每个终端的环境（windows=本地 pwsh/cmd，linux=SSH 远程）。
 * TDSF 2026-08-28：命令预测必须区分环境——本地终端预测 Windows 命令，
 * SSH 终端预测 Linux 命令，否则本地弹出的 Linux 命令输入了无效。
 * 由 useTerminalSession 在会话创建时按 s.remote 注册。 */
const leafEnvironments = new Map<number, TerminalEnv>();

export function setLeafEnvironment(leafId: number, env: TerminalEnv): void {
  leafEnvironments.set(leafId, env);
}

export function clearLeafEnvironment(leafId: number): void {
  leafEnvironments.delete(leafId);
}

function getLeafEnvironment(leafId: number): TerminalEnv {
  // 未注册的 leaf 按本地环境处理（保守：本地终端占比高，且 Linux 命令集更大）
  return leafEnvironments.get(leafId) ?? 'windows';
}

function getInputBuffer(leafId: number): string {
  return inputBuffers.get(leafId) ?? '';
}

function setInputBuffer(leafId: number, value: string): void {
  inputBuffers.set(leafId, value);
}

function clearInputBuffer(leafId: number): void {
  inputBuffers.set(leafId, '');
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
 * 命令模式候选按远端命令全集过滤（二轮改进：根治假预测）。
 * cmds 为 null（远端命令全集未拉到）→ 原样降级不过滤（无损）；
 * history 来源豁免（历史是真实执行过的，远端没有也可能是容器/临时装过）。
 */
export function filterCommandItems(
  items: readonly SuggestionResult[],
  cmds: Set<string> | null,
  limit = 5,
): SuggestionResult[] {
  if (!cmds) return items.slice(0, limit);
  return items
    .filter((it) => it.source === 'history' || cmds.has(it.command))
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
): boolean {
  if (!hasDataSrc) return false;
  if (env === 'linux') return remoteCmds !== null && remoteCmds.has(token);
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
 * 缩写排在 carapace/tldr/Fig specs 之后（真实数据优先），整体限 8。
 */
export function appendAbbrevItems(
  items: readonly SuggestionResult[],
  cmd: string,
  prefix: string,
): SuggestionResult[] {
  if (items.length >= 8) return items.slice(0, 8);
  const { current } = parseCommandLine(prefix);
  const abbrevs = findAbbrevSuggestions(cmd, current);
  if (abbrevs.length === 0) return items.slice(0, 8);
  const seen = new Set(items.map((it) => it.command));
  const out = [...items.slice(0, 8)];
  for (const it of abbrevs) {
    if (out.length >= 8) break;
    if (seen.has(it.command)) continue;
    seen.add(it.command);
    out.push(it);
  }
  return out;
}

/**
 * 参数模式候选加载（按环境分流 + 三源串联，TDSF 2026-08-28 二轮改进）。
 *
 * - windows（本地 pwsh）：invoke param_complete（Rust spawn 打包内 carapace.exe），
 *   结果与 tldr 参数候选合并（tldr 对 windows 命令查不到返回 []，无害）；
 *   param_complete 不可用（后端旧版本/浏览器 dev）→ 降级 tldr 单源。
 * - linux（SSH）：三源按优先级串联去重（限 8）：
 *     1. 远端 carapace（远端真实环境的动态值：分支/文件/PID），
 *        描述经 tldr 中文钩子中文化（MergeOptions.zhDescription 预留钩子在此接上）
 *     2. tldr 选项级中文（ls/systemctl/grep/chmod 等基础命令的主力数据源——
 *        carapace/Fig specs 都不覆盖这些命令，用户实测确认）
 *     3. Fig specs 静态层回退（行为与历史版本一致）
 *
 * 过期结果由调用方 predictSeq 校验统一丢弃，本函数内部不再重复校验。
 */
async function loadParamPredictions(
  leafId: number,
  env: TerminalEnv,
  cmd: string,
  prefix: string,
): Promise<SuggestionResult[]> {
  const { tokens, current } = buildParamRequest(prefix);

  if (env === 'windows') {
    try {
      // tokens 约定【含命令名】（param_complete.rs 接口约定，Rust 侧自行消费）
      // cwd：本地 leaf 的 OSC 7 跟踪目录 —— git 分支等动态 action 按 cwd 取数据，
      // 不传则 carapace 继承应用进程目录（几乎总是错的仓库）
      const candidates = await invoke<CarapaceCandidate[]>('param_complete', {
        cmd,
        tokens,
        current,
        cwd: getLeafCwd(leafId),
      });
      // tldr 作为 fallback 合并（按 value 去重，carapace 动态值优先）
      return mergeCandidates(candidates ?? [], tldrParamSuggestions(cmd, current));
    } catch {
      // 后端旧版本无 param_complete 命令 / 浏览器 dev 模式 → 静默降级，
      // 仍给 tldr 候选（如 git/curl 等跨平台命令在 Windows 也有中文参数提示）
      console.warn('[completion] param_complete unavailable, fallback to tldr');
      return tldrParamSuggestions(cmd, current);
    }
  }

  // ── linux（SSH）：三源串联 ─────────────────────────────────────────────
  const sessionId = getLeafSshSession(leafId);
  // 远端存在性门禁（用户实测反馈：输 ag 弹出 -l，远端根本没装 ag）：
  // tldr/Fig specs 是静态数据——有这个命令的参数 ≠ 远端装了这个命令。
  // 远端命令集就绪时：cmd 不在其中 → 只保留 carapace 源（它对无 completer
  // 的命令返回空），tldr/Fig 全跳过 → 不弹假参数。
  // 命令集未拉到（null，连接初期/失败）→ 不过滤，避免 ls/git 等正常场景失效。
  const cmds = sessionId !== null ? getCachedRemoteCommands(sessionId) : null;
  const remoteGate = cmds === null || cmds.has(cmd);
  const merged: SuggestionResult[] = [];
  const seen = new Set<string>();
  const push = (items: readonly SuggestionResult[]) => {
    for (const it of items) {
      if (seen.has(it.command) || merged.length >= 8) continue;
      seen.add(it.command);
      merged.push(it);
    }
  };

  // 源 1：远端 carapace（tokens 去掉命令名——carapace CLI 语义；
  // remoteCwd：exec 通道默认在远端 home，git 分支会取错仓库 → cd 到跟踪目录）
  if (sessionId !== null && (await remoteCarapaceInstalled(sessionId))) {
    const remote = await remoteParamComplete(
      sessionId,
      cmd,
      tokens.slice(1),
      current,
      getLeafRemoteCwd(leafId),
      { zhDescription: (v) => tldrOptionZh(cmd, v) },
    );
    if (remote !== null) push(remote);
  }

  // 源 2：tldr 选项级中文（键序稳定输出，高频示例在前）——受远端门禁约束
  if (remoteGate) push(tldrParamSuggestions(cmd, current));

  // 源 3：Fig specs 静态层兜底（首次触发全量 spec 懒加载，~11MB 独立 chunk）
  // —— 同受远端门禁约束（specs 里的 ag/adb 等远端没装就不弹参数）
  if (remoteGate && merged.length < 8) {
    const spec = await getCommandSpec(cmd);
    if (spec) push(suggestParams(spec, prefix, 8));
  }
  return merged;
}

async function updatePredictions(leafId: number): Promise<void> {
  const seq = ++predictSeq;
  const env = getLeafEnvironment(leafId);
  const prefix = getInputBuffer(leafId);
  if (!prefix || prefix.trim() === '') {
    setState((s) => (s.visible ? { ...s, visible: false } : s));
    return;
  }

  if (prefix.includes(' ')) {
    // ── 参数模式：命令 + 子命令/选项/参数值/动态值（分支/目录/PID）────────
    // TDSF 2026-08-28：移除 env === 'linux' 硬限制（spec: add-carapace-param-completion），
    // 按环境分流到本地 carapace（param_complete）/ 远端 carapace（ssh_command），
    // 失败统一回退 Fig specs 静态层（linux），Windows 无 spec 可回退则静默无预测。
    // TDSF 2026-08-28(二)：loadParamPredictions 内部已串联 carapace→tldr→Fig specs
    // 三源；此处再追加子命令缩写候选（ip a → address 等教学高频缩写）。
    const { cmd } = parseCommandLine(prefix);
    if (!cmd) {
      setState((s) => (s.visible ? { ...s, visible: false } : s));
      return;
    }
    const loaded = await loadParamPredictions(leafId, env, cmd, prefix);
    if (seq !== predictSeq) return; // 输入已变化，丢弃过期结果
    const items = appendAbbrevItems(loaded, cmd, prefix);
    if (items.length === 0) {
      setState((s) => (s.visible ? { ...s, visible: false } : s));
    } else {
      setState({
        visible: true,
        items,
        selectedIndex: 0,
        prefix,
        leafId,
        cursor: measureCursorPx(getTermFn, leafId),
      });
    }
    return;
  }

  // ── 命令模式：history → 索引 startsWith → fuzzy（fish 三层，按环境分流）──
  // TDSF 2026-08-28(二)：linux 环境先取 30 条，再按远端命令全集（compgen -c
  // 预取缓存）过滤假候选后截 5——词典/fuzzy 层会弹远端根本没装的命令。
  // 缓存未拉到（null）→ 降级不过滤，照旧取 5（无损）。
  const engine = getSuggestEngine();
  const isLinux = env === 'linux';
  let items = engine.getSuggestions(prefix, isLinux ? 30 : 5, env);
  if (isLinux) {
    const sessionId = getLeafSshSession(leafId);
    const cmds = sessionId !== null ? getCachedRemoteCommands(sessionId) : null;
    items = filterCommandItems(items, cmds);
  }

  // P2 #13 的弹窗展示统一入口（光标像素坐标在按键后 xterm 已刷新）
  const show = (list: readonly SuggestionResult[]) => {
    setState({
      visible: true,
      items: [...list],
      selectedIndex: 0,
      prefix,
      leafId,
      cursor: measureCursorPx(getTermFn, leafId),
    });
  };

  const token = prefix.trim();
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
  const sessionId = getLeafSshSession(leafId);
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
  );
  if (hasParamSource) {
    // 加尾空格使 buildParamRequest 的 current=''（全量参数候选）；
    // 缩写候选在 appendAbbrevItems 内追加（与参数模式同一套合并逻辑）
    const paramItems = await loadParamPredictions(leafId, env, token, prefix + ' ');
    if (seq !== predictSeq) return; // 输入已变化，丢弃过期结果
    const before = items.length;
    items = mergeCommandWithParamItems(items, appendAbbrevItems(paramItems, token, prefix + ' '));
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
  setState((s) => (s.visible ? { ...s, visible: false } : s));
}

// ============================================================================
// 接受预测
// ============================================================================

function acceptPrediction(leafId: number, entry: SuggestionResult): void {
  if (!writeFn) return;

  // ── 参数模式：替换当前 token（-n/--noheadings/子命令/参数值） ──────────
  if (entry.kind === 'arg') {
    const line = getInputBuffer(leafId);
    if (/\s+$/.test(line)) {
      // 刚打完空格（如 `lsblk -o ` 选 NAME）：直接追加建议文本 + 空格
      writeFn(leafId, entry.command + ' ');
      setInputBuffer(leafId, line + entry.command + ' ');
    } else {
      // 光标在行尾 token 中间（如 `lsblk -` 选 --noheadings）：
      // 先退格删掉已回显的当前 token，再写入建议文本
      const tokens = line.trimEnd().split(/\s+/).filter(Boolean);
      const current = tokens[tokens.length - 1] ?? '';
      if (current) {
        writeFn(leafId, '\b'.repeat(current.length) + entry.command);
        // 缓冲区同步替换（保留前面的 "cmd sub " 前缀）
        setInputBuffer(
          leafId,
          line.slice(0, line.length - current.length) + entry.command,
        );
      } else {
        writeFn(leafId, entry.command);
        setInputBuffer(leafId, line + entry.command);
      }
    }
    setState((s) => ({ ...s, visible: false }));
    return;
  }

  // ── 命令模式 ────────────────────────────────────────────────────────────
  const prefix = getInputBuffer(leafId);
  // 修复 ipp bug（2026-08-15）：屏幕上已回显 prefix，若直接追加 remaining
  // 会拼成 prefix+remaining（输入 ip 接受 pip 变 ipp）；且 fuzzy 匹配的
  // 命令不以 prefix 开头，slice(prefix.length) 取剩余部分不可靠。
  // 方案：先发等量退格清掉屏幕上已回显的 prefix（PTY canonical 行编辑
  // 删除行尾字符并回显），再写入完整命令，保证结果精确等于选中项。
  const backspaces = prefix.length > 0 ? '\b'.repeat(prefix.length) : '';
  writeFn(leafId, backspaces + entry.command);
  // 更新输入缓冲区为完整命令
  setInputBuffer(leafId, entry.command);
  // 历史污染止血（2026-08-28，用户实测反馈）：原来"接受预测即记历史"——
  // 输入 ag 点 → 就算执行过，ag: command not found 也进历史。第二轮 OSC
  // 真实执行记录（exit code + 完整命令行）上线前，停止一切运行时历史写入；
  // windows 环境保留启动时 shell history 文件注入（PSReadLine 只写执行过的）。
  // getSuggestEngine().addHistory(entry.command, getLeafEnvironment(leafId));
  setState((s) => ({ ...s, visible: false }));
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

  const current = activeState;
  const isVisible = current.visible && current.leafId === leafId;

  // === Ctrl+C / Ctrl+U → 清空缓冲区 + 关闭弹窗 ===
  if (event.ctrlKey && (event.key === 'c' || event.key === 'C' || event.key === 'u' || event.key === 'U')) {
    clearInputBuffer(leafId);
    setState((s) => (s.visible ? { ...s, visible: false } : s));
    return true;
  }

  // === 右箭头 = 接受第一条预测（只在弹窗可见时） ===
  if (event.key === 'ArrowRight' && isVisible && current.items.length > 0) {
    acceptPrediction(leafId, current.items[current.selectedIndex]);
    return false; // 拦截
  }

  // === 向下箭头 = 选择下一条预测 ===
  if (event.key === 'ArrowDown' && isVisible && current.items.length > 1) {
    event.preventDefault();
    setState((s) => ({
      ...s,
      selectedIndex: (s.selectedIndex + 1) % s.items.length,
    }));
    return false;
  }

  // === 向上箭头 = 选择上一条预测 ===
  if (event.key === 'ArrowUp' && isVisible && current.items.length > 1) {
    event.preventDefault();
    setState((s) => ({
      ...s,
      selectedIndex: (s.selectedIndex - 1 + s.items.length) % s.items.length,
    }));
    return false;
  }

  // === Tab = 透传远端原生补全 + 关闭弹窗 ===
  if (event.key === 'Tab') {
    setState((s) => (s.visible ? { ...s, visible: false } : s));
    return true;
  }

  // === Escape = 关闭弹窗 ===
  if (event.key === 'Escape' && isVisible) {
    setState((s) => ({ ...s, visible: false }));
    return true;
  }

  // === Enter = 接受选中预测（如果可见）或记录历史 + 清空缓冲区 ===
  if (event.key === 'Enter') {
    if (isVisible && current.items.length > 0) {
      // P0-3 修复：弹窗可见时 Enter 接受选中项（不拦截 Enter，先接受再透传）
      acceptPrediction(leafId, current.items[current.selectedIndex]);
      // 接受后缓冲区已是完整命令，Enter 透传执行
    } else {
      // 历史污染止血（2026-08-28，用户实测反馈）：原来"Enter 即记"——没执行/
      // 执行失败的输入（lsb、拼错的词）都进历史，用户反馈"又惊喜又鸡肋"。
      // 停止运行时写入，历史来源收敛到 windows shell history 文件（真实执行）
      // 与第二轮 OSC 真实执行记录（exit code 过滤，待上线）。
      // const prefix = getInputBuffer(leafId);
      // if (prefix.trim()) {
      //   getSuggestEngine().addHistory(prefix.trim(), getLeafEnvironment(leafId));
      // }
    }
    // Enter → 清空缓冲区（新的一行）
    clearInputBuffer(leafId);
    setState((s) => (s.visible ? { ...s, visible: false } : s));
    return true; // 透传 Enter 让命令执行
  }

  // === Backspace → 从缓冲区删除 + 更新预测 ===
  if (event.key === 'Backspace') {
    const buf = getInputBuffer(leafId);
    if (buf.length > 0) {
      setInputBuffer(leafId, buf.slice(0, -1));
    }
    setTimeout(() => updatePredictions(leafId), 0);
    return true;
  }

  // === 缓冲失效键（粘贴 / 删词 / 光标移动）===============================
  // 缓冲只追踪"追加输入", 粘贴 (Ctrl+V)、删词 (Ctrl/Alt+Backspace)、
  // 光标移动 (←→/Home/End) 会让缓冲区与终端实际行失配, 继续基于旧缓冲
  // 预测会给出错误补全破坏命令 (P1-10, 2026-08-18)。失配即失效:
  // 清空缓冲 + 关闭弹窗, 宁可无预测也不给错误预测。
  if (
    (event.ctrlKey || event.metaKey) &&
    (event.key === 'v' || event.key === 'V')
  ) {
    clearInputBuffer(leafId);
    setState((s) => (s.visible ? { ...s, visible: false } : s));
    return true;
  }
  if (
    (event.ctrlKey || event.altKey || event.metaKey) &&
    event.key === 'Backspace'
  ) {
    clearInputBuffer(leafId);
    setState((s) => (s.visible ? { ...s, visible: false } : s));
    return true;
  }
  if (
    event.key === 'ArrowLeft' ||
    event.key === 'Home' ||
    event.key === 'End'
  ) {
    // 弹窗可见时的 ArrowRight 已在上面"接受预测"分支拦截, 不会落此;
    // 光标移出行尾后缓冲已失配, 清空 + 关闭弹窗。
    clearInputBuffer(leafId);
    setState((s) => (s.visible ? { ...s, visible: false } : s));
    return true;
  }

  // === 可打印字符 → 追加到缓冲区 + 更新预测 ===
  if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    const buf = getInputBuffer(leafId);
    setInputBuffer(leafId, buf + event.key);
    setTimeout(() => updatePredictions(leafId), 0);
    return true;
  }

  return true; // 所有其他键透传
}

// ============================================================================
// Shell history 加载
// ============================================================================

let historyLoaded = false;

export async function loadHistoryIfNeeded(): Promise<void> {
  if (historyLoaded) return;
  historyLoaded = true;
  try {
    const { loadHistoryFromRust, parseShellHistory } = await import('@/lib/shell-history');
    const info = await loadHistoryFromRust();
    if (info.commands.length > 0) {
      const parsed = parseShellHistory(info.commands.join('\n'), info.shellType);
      const commandNames = parsed
        .map((cmd) => cmd.trim().split(/\s+/)[0] ?? '')
        .filter((cmd) => cmd.length > 0);
      // 本地 shell（pwsh/powershell/cmd）历史 → windows 环境
      // （SSH 会话的历史由远端 shell 自身管理，不在此加载）
      getSuggestEngine().loadHistory(commandNames, 'windows');
    }
  } catch (e) {
    // 非致命——浏览器预览模式或 Rust 命令未注册时降级
    console.warn('[completion] loadHistoryIfNeeded failed:', e);
  }
}
