/**
 * 终端 block → 预测会话的桥（2026-11-12）
 * -----------------------------------------------------------------------------
 * 数据源复用现有 `TerminalBlockCollector.onBlock`（OSC 133/633 已有链路），不新增
 * shell trap、不改输入/回显。block 只在旁路转成 CommandEvent；写失败或隐私拒收只
 * 断链，不影响终端。
 *
 * 会话内身份：
 * - namespace 按 leaf **incarnation** 隔离（`leaf:<id>:<n>`），关闭标签页后旧统计
 *   不会泄漏到新标签页；
 * - `shellEpoch` 在 respawn/上下文切换时轮换；agent、退出码未知、隐私拒收的 block
 *   不造转移，并让下一条另开 epoch（方案书 §4.2）。
 *
 * 本模块不决定可用性/风险来源：调用方显式传入表；未知一律由引擎保守隐藏。
 */

import {
  checkCandidateAcceptable,
  type AcceptDecision,
  type Availability,
  type Candidate,
  type CandidateView,
  type PredictionRequest,
  type ScopeToken,
} from "./contracts";
import { ObservationTracker } from "./context";
import {
  isCorrectionTargetCurrent,
  suggestBufferCorrection,
  type CorrectionAvailability,
  type CorrectionRisk,
  type CorrectionVocabulary,
} from "./correction";
import { cwdKeyOf } from "./privacy";
import { SessionPredictionStore, type RiskTable } from "./sessionStore";

export type ObservedBlock = {
  /** terminal leaf id（本地/SSH 统一） */
  sessionId: number;
  command: string;
  cwd: string;
  exitCode: number | null;
  durationMs: number;
  author: "user" | "agent";
  startedAt: number;
};

type LeafState = {
  namespaceId: string;
  scope: ScopeToken;
  tracker: ObservationTracker;
  incarnation: number;
};

const store = new SessionPredictionStore();
const leaves = new Map<number, LeafState>();
let incarnationSeq = 0;

function ensureLeaf(leafId: number): LeafState {
  const existing = leaves.get(leafId);
  if (existing) return existing;
  incarnationSeq += 1;
  const namespaceId = `leaf:${leafId}:${incarnationSeq}`;
  const scope: ScopeToken = {
    namespaceId,
    leafId,
    rustSessionId: null,
    shellEpoch: `${namespaceId}:epoch-1`,
    contextRevision: 0,
  };
  const state: LeafState = {
    namespaceId,
    scope,
    tracker: new ObservationTracker(scope, makeObservationId(leafId)),
    incarnation: incarnationSeq,
  };
  leaves.set(leafId, state);
  return state;
}

function makeObservationId(leafId: number): () => string {
  let seq = 0;
  return () => {
    seq += 1;
    return `leaf-${leafId}-obs-${seq}`;
  };
}

/** respawn / 嵌套 shell / 上下文切换：轮换 epoch，旧 pending 作废。 */
export function rotateLeafPrediction(leafId: number): void {
  const state = leaves.get(leafId);
  if (!state) return;
  state.scope = {
    ...state.scope,
    shellEpoch: `${state.namespaceId}:epoch-${Date.now()}`,
    contextRevision: state.scope.contextRevision + 1,
  };
  state.tracker.updateOwner(state.scope);
}

/** 标签页关闭：删除该 leaf 的会话统计，避免 leaf id 复用时串数据。 */
export function dropLeafPrediction(leafId: number): void {
  leaves.delete(leafId);
}

/** 只观察：把一条完成的 block 转成事件（不产生任何终端副作用）。 */
export function recordTerminalBlock(block: ObservedBlock): void {
  const state = ensureLeaf(block.sessionId);
  const origin = block.author === "agent" ? "agent" : "user";
  const begin = state.tracker.begin(origin, block.startedAt);
  if (!begin.ok) {
    store.reportGap(state.namespaceId, state.scope.shellEpoch);
    rotateLeafPrediction(block.sessionId);
    return;
  }
  const result = state.tracker.complete(begin.handle, {
    sourceBlockId: `tb-${block.sessionId}`,
    endedAt: block.startedAt + Math.max(0, block.durationMs),
    exitCode: block.exitCode,
    commandRaw: block.command,
    cwdKey: cwdKeyOf(state.namespaceId, block.cwd || null),
    learningGeneration: 0,
  });
  if (!result.ok || result.event.eligibility !== "eligible") {
    // 不可学习事件不造邻接；下一条另开 epoch。
    store.reportGap(state.namespaceId, state.scope.shellEpoch);
    rotateLeafPrediction(block.sessionId);
    return;
  }
  store.record(result.event);
}

/** 供显式入口使用：当前 leaf 的 owner（不存在则创建）。 */
export function predictionScopeForLeaf(leafId: number): ScopeToken {
  return ensureLeaf(leafId).scope;
}

/** 会话内已知命令（commandKey + 可展示文本），供 UI 预取风险/可用性。 */
export function sessionCommandEntriesForLeaf(
  leafId: number,
): { commandKey: string; displayText: string }[] {
  const state = leaves.get(leafId);
  if (!state) return [];
  return store.snapshot(state.namespaceId).commands.map((item) => ({
    commandKey: item.commandKey,
    displayText: item.displayText,
  }));
}

export type NextSuggestionInput = {
  leafId: number;
  inputVersion: number;
  now: number;
  availability: ReadonlyMap<string, Availability>;
  risk: RiskTable;
};

/** 显式“下一步建议”请求；调用方必须已确认终端空闲且输入为空。 */
export function suggestNextForLeaf(input: NextSuggestionInput): CandidateView {
  const state = ensureLeaf(input.leafId);
  const request: PredictionRequest = {
    requestId: `next:${input.leafId}:${input.inputVersion}`,
    task: "predict_next",
    scope: state.scope,
    environment: {
      connectionKind: "local",
      osFamily: "linux",
      dialect: "bash",
      targetKey: null,
      userKey: null,
      identityState: "unknown",
    },
    inputVersion: input.inputVersion,
    snapshotVersion: 0,
    cwdKey: null,
    limit: 5,
    terminalState: "idle-empty",
    buffer: null,
    block: null,
  };
  return store.suggest({
    request,
    current: state.scope,
    currentInputVersion: input.inputVersion,
    now: input.now,
    availability: input.availability,
    risk: input.risk,
  });
}

export type CorrectionSuggestionInput = {
  leafId: number;
  inputVersion: number;
  now: number;
  text: string;
  cursor: number;
  vocabulary: CorrectionVocabulary;
  availability: CorrectionAvailability;
  risk: CorrectionRisk;
};

/** 显式“当前行纠错”请求；buffer 原文/光标必须与请求时一致才可接受。 */
export type CorrectionSuggestionResult = {
  view: CandidateView;
  request: PredictionRequest;
};

export function suggestCorrectionForLeaf(
  input: CorrectionSuggestionInput,
): CorrectionSuggestionResult {
  const state = ensureLeaf(input.leafId);
  const request: PredictionRequest = {
    requestId: `corr:${input.leafId}:${input.inputVersion}`,
    task: "correct_buffer",
    scope: state.scope,
    environment: {
      connectionKind: "local",
      osFamily: "linux",
      dialect: "bash",
      targetKey: null,
      userKey: null,
      identityState: "unknown",
    },
    inputVersion: input.inputVersion,
    snapshotVersion: 0,
    cwdKey: null,
    limit: 5,
    terminalState: "idle-with-input",
    buffer: { text: input.text, cursor: input.cursor },
    block: null,
  };
  const snapshot = store.snapshot(state.namespaceId);
  const sessionCounts = new Map(
    snapshot.commands.map((item) => [item.displayText, item.count]),
  );
  return {
    view: suggestBufferCorrection({
      request,
      current: state.scope,
      currentInputVersion: input.inputVersion,
      now: input.now,
      vocabulary: input.vocabulary,
      availability: input.availability,
      risk: input.risk,
      sessionCounts,
    }),
    request,
  };
}

/** 接受前统一复核：owner + 输入版本 + 候选自身安全条件。 */
export function acceptPredictionCandidate(
  candidate: Candidate,
  leafId: number,
  currentInputVersion: number,
): AcceptDecision {
  const state = leaves.get(leafId);
  if (!state) return { ok: false, reason: "owner-changed" };
  return checkCandidateAcceptable(
    candidate,
    state.scope,
    currentInputVersion,
  );
}

/** 纠错接受前复核原文本/光标。 */
export function correctionTargetIsCurrent(
  request: PredictionRequest,
  leafId: number,
  currentInputVersion: number,
  currentText: string,
  currentCursor: number,
): boolean {
  const state = leaves.get(leafId);
  if (!state) return false;
  return isCorrectionTargetCurrent(
    request,
    state.scope,
    currentInputVersion,
    currentText,
    currentCursor,
  );
}
