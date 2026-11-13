/**
 * F0 预测契约 v1（冻结候选，2026-11-12）
 * -----------------------------------------------------------------------------
 * 设计真源：docs/2026.11.5下一步规划/终端命令预测与纠错/实施定稿/01-开发方案书.md
 * §4 数据与身份契约、§5 下一命令算法、§6 纠错算法、§7 安全与 UI 接线。
 *
 * 本文件只冻结**可验证合同**（类型、字段语义、边界守卫、unknown 语义），不包含
 * 存储、RPC、UI 或统计实现。P5（SQLite）与 P6（候选视图）必须按这里冻结的字段
 * 实现，不能在各自模块里自定字段含义；任何修改都要提升版本并补契约用例。
 *
 * 三条硬语义：
 * 1. 身份与归属：候选只在生成它的 owner（namespace/leaf/rustSessionId/shellEpoch/
 *    contextRevision）仍当前时才可展示/接受；切 tab、重连、目录改变、过期响应即失效。
 * 2. unknown 不伪装：可用性、退出码、身份、风险都允许 unknown；unknown 不得被排序
 *    或展示层写成 "available/成功/安全"。
 * 3. 只插入不执行：Candidate.insertText 只能是单行文本；接受方绝不追加换行、回车、
 *    后台 SSH 或额外执行。
 */

export const PREDICTION_CONTRACT_VERSION = "prediction-contract-v1" as const;
export const PREDICTION_SCHEMA_VERSION = 1 as const;
export const RANKER_VERSION = "rank-v1" as const;

/** UI 最多返回 5 条；0 条合法，不凑满。 */
export const MAX_CANDIDATES = 5;
/** 每个召回来源最多 25 条，合并池最多 100 条（过滤有效性在截断之前）。 */
export const MAX_RECALL_PER_SOURCE = 25;
export const MAX_RECALL_POOL = 100;
/** 单 namespace 默认可学习快照上限（命令数）。 */
export const MAX_SNAPSHOT_COMMANDS = 512;
/** 生成入模的候选文本上限（UTF-8 字节由调用方另测，这里只约束字符长度）。 */
export const MAX_CANDIDATE_TEXT_LENGTH = 2048;

export type ConnectionKind = "local" | "wsl" | "ssh";
export type OsFamily = "linux" | "windows" | "macos" | "unknown";
export type ShellDialect = "bash" | "zsh" | "fish" | "powershell" | "unknown";
export type IdentityState = "verified" | "unknown";

/** 事件来源：Agent/补全探测不得强化成用户习惯。 */
export type EventOrigin = "user" | "agent" | "probe" | "unknown";
export type Eligibility = "eligible" | "ineligible" | "unknown";

export type PredictionTask = "predict_next" | "correct_buffer" | "correct_block";
export type TerminalState =
  | "idle-empty"
  | "idle-with-input"
  | "busy"
  | "unknown";

export type CandidateSource =
  | "markov"
  | "mfc"
  | "mru"
  | "decay"
  | "cwd"
  | "dictionary"
  | "spec"
  | "model";

/** 只展示已评估 L0/L1；unknown 一律不进入自动候选列表。 */
export type RiskLevel = "L0" | "L1" | "L2" | "L3" | "L4" | "unknown";
export type Availability = "available" | "unavailable" | "unknown";

/**
 * 请求身份快照：客户端当前 owner。
 * `namespaceId` 已按目标/有效用户/方言隔离；`shellEpoch` 每次可信连续流新建；
 * `contextRevision` 在切 tab、重连、目录改变、终端清空等失效点递增。
 */
export type ScopeToken = {
  namespaceId: string;
  leafId: number;
  rustSessionId: number | null;
  shellEpoch: string;
  contextRevision: number;
};

/** 环境只描述可核验事实；不从提示符文字猜身份。 */
export type Environment = {
  connectionKind: ConnectionKind;
  osFamily: OsFamily;
  dialect: ShellDialect;
  targetKey: string | null;
  userKey: string | null;
  identityState: IdentityState;
};

/**
 * 命令事件（唯一可学习单位）。
 * - `eventId` 由 epoch + observationId 唯一确定；重复结束/交叠/owner 不符一律弃权。
 * - `exitCode` 只允许整数或 null；-1 哨兵必须先归一为 null。
 * - `replayText` 只有完整、无未解析槽位、通过隐私投影的文本才非空；
 *   `<PATH>` 等模板占位符绝不能作为真实命令插入。
 */
export type CommandEvent = {
  schemaVersion: typeof PREDICTION_SCHEMA_VERSION;
  eventId: string;
  observationId: string;
  sourceBlockId: string | null;
  namespaceId: string;
  shellEpoch: string;
  sequence: number;
  learningGeneration: number;
  startedAt: number;
  durationMs: number | null;
  exitCode: number | null;
  origin: EventOrigin;
  commandKey: string;
  template: string | null;
  replayText: string | null;
  cwdKey: string | null;
  eligibility: Eligibility;
};

export type PredictionRequest = {
  requestId: string;
  task: PredictionTask;
  scope: ScopeToken;
  environment: Environment;
  /** 输入版本：每次可见输入变化递增；接受时必须与生成时相同。 */
  inputVersion: number;
  /** 客户端观察到的快照版本；DB 提交递增，返回version不得倒退。 */
  snapshotVersion: number;
  /** 当前目录摘要（cwdKeyOf）；无可靠 cwd 时为 null，C 特征按 0 计。 */
  cwdKey: string | null;
  /** 1..MAX_CANDIDATES。 */
  limit: number;
  terminalState: TerminalState;
  /** correct_buffer 的待修改原文与光标；其它任务为 null。 */
  buffer: { text: string; cursor: number } | null;
  /** correct_block 的来源块；其它任务为 null。 */
  block: { text: string; exitCode: number | null } | null;
};

export type CandidateEvidence = {
  source: CandidateSource;
  count?: number;
  lastUsedAt?: number;
  detailZh?: string;
};

export type Candidate = {
  candidateId: string;
  task: PredictionTask;
  displayText: string;
  /** 只允许填入当前行；null 表示不可插入（仅展示解释）。 */
  insertText: string | null;
  source: CandidateSource;
  summaryZh: string;
  evidence: CandidateEvidence[];
  rankScore: number;
  rankerVersion: string;
  risk: RiskLevel;
  availability: Availability;
  constraints: string[];
  ambiguities: string[];
  owner: ScopeToken;
  inputVersion: number;
};

/**
 * 候选视图状态：
 * - ok: 有可展示候选
 * - empty: 冷启动/无历史（不是错误，不冒充个人预测）
 * - unavailable: 功能或后端不可用（可降级到会话内快照）
 * - unknown: 关键状态未知（可用性/风险未评估），自动列表隐藏
 * - stale: owner/输入版本已变化，整批作废
 */
export type CandidateViewStatus =
  | "ok"
  | "empty"
  | "unavailable"
  | "unknown"
  | "stale";

export type CandidateView = {
  requestId: string;
  status: CandidateViewStatus;
  task: PredictionTask;
  candidates: Candidate[];
  owner: ScopeToken;
  snapshotVersion: number;
  generatedAt: number;
  reasonZh?: string;
};

/** 视图回调：调用方必须在渲染/接受前重新核 owner 与输入版本。 */
export type CandidateViewSink = (view: CandidateView) => void;

export type FeedbackAction = "accepted" | "dismissed" | "edited" | "executed";

export type Feedback = {
  requestId: string;
  displayed: string[];
  candidateId: string;
  action: FeedbackAction;
  at: number;
  learningGeneration: number;
};

export type SnapshotCommandStat = {
  commandKey: string;
  displayText: string;
  count: number;
  lastUsedAt: number;
  cwdCount: number;
  totalCount: number;
};

export type TransitionStat = {
  prevKey: string;
  nextKey: string;
  count: number;
};

export type Snapshot = {
  namespaceId: string;
  learningGeneration: number;
  commitRevision: number;
  commands: SnapshotCommandStat[];
  transitions: TransitionStat[];
  /** 是否因 512/20,000 上限发生截断；截断后仍须报告，不静默丢。 */
  bounded: boolean;
};

export type LearningState = {
  enabled: boolean;
  generation: number;
};

/** 关闭/清空先推进代际，旧队列与旧反馈即使晚到也拒绝。 */
export function canWriteWithGeneration(
  state: LearningState,
  generation: number,
): boolean {
  return state.enabled && state.generation === generation;
}

/** predict_next 只允许在空闲且无未提交输入时请求。 */
export function isPredictNextAllowed(request: PredictionRequest): boolean {
  return (
    request.task === "predict_next" &&
    request.terminalState === "idle-empty" &&
    request.buffer == null
  );
}

/**
 * 生成时 owner 是否仍是当前 owner。
 * 逐字段比较：namespace 相同只说明同一环境，leaf/epoch/revision 任一变化都失效。
 */
export function isSameOwner(a: ScopeToken, b: ScopeToken): boolean {
  return (
    a.namespaceId === b.namespaceId &&
    a.leafId === b.leafId &&
    a.rustSessionId === b.rustSessionId &&
    a.shellEpoch === b.shellEpoch &&
    a.contextRevision === b.contextRevision
  );
}

export type AcceptRejectReason =
  | "owner-changed"
  | "input-version-changed"
  | "insert-text-missing"
  | "multi-line"
  | "risk-not-low"
  | "availability-unavailable"
  | "unknown-state"
  | "template-placeholder"
  | "empty-text";

export type AcceptDecision =
  | { ok: true; insertText: string }
  | { ok: false; reason: AcceptRejectReason };

/**
 * 接受守卫（纯函数，供 UI 与测试共用）。
 * 只检查候选本身与当前 owner/输入版本；真正的终端写入仍由调用方复核可见终端
 * 与空闲状态，绝不在这里执行命令。
 */
export function checkCandidateAcceptable(
  candidate: Candidate,
  current: ScopeToken,
  currentInputVersion: number,
): AcceptDecision {
  if (!isSameOwner(candidate.owner, current)) {
    return { ok: false, reason: "owner-changed" };
  }
  if (candidate.inputVersion !== currentInputVersion) {
    return { ok: false, reason: "input-version-changed" };
  }
  const text = candidate.insertText;
  if (text == null) return { ok: false, reason: "insert-text-missing" };
  if (text.trim() === "") return { ok: false, reason: "empty-text" };
  if (/[\r\n]/.test(text)) return { ok: false, reason: "multi-line" };
  if (/<[A-Z][A-Z0-9_]*>/.test(text)) {
    return { ok: false, reason: "template-placeholder" };
  }
  if (candidate.risk !== "L0" && candidate.risk !== "L1") {
    return { ok: false, reason: "risk-not-low" };
  }
  if (candidate.availability === "unavailable") {
    return { ok: false, reason: "availability-unavailable" };
  }
  if (candidate.availability === "unknown") {
    return { ok: false, reason: "unknown-state" };
  }
  return { ok: true, insertText: text };
}

// ---------------------------------------------------------------------------
// 运行时校验（边界输入来自采集器/JSON/RPC，不能只靠 TS 类型）
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isNullableInt(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isInteger(value));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

const CONNECTION_KINDS = ["local", "wsl", "ssh"] as const;
const OS_FAMILIES = ["linux", "windows", "macos", "unknown"] as const;
const SHELL_DIALECTS = ["bash", "zsh", "fish", "powershell", "unknown"] as const;
const IDENTITY_STATES = ["verified", "unknown"] as const;
const EVENT_ORIGINS = ["user", "agent", "probe", "unknown"] as const;
const ELIGIBILITIES = ["eligible", "ineligible", "unknown"] as const;
const PREDICTION_TASKS = [
  "predict_next",
  "correct_buffer",
  "correct_block",
] as const;
const TERMINAL_STATES = [
  "idle-empty",
  "idle-with-input",
  "busy",
  "unknown",
] as const;
const CANDIDATE_SOURCES = [
  "markov",
  "mfc",
  "mru",
  "decay",
  "cwd",
  "dictionary",
  "spec",
  "model",
] as const;
const RISK_LEVELS = ["L0", "L1", "L2", "L3", "L4", "unknown"] as const;
const AVAILABILITIES = ["available", "unavailable", "unknown"] as const;
const VIEW_STATUSES = ["ok", "empty", "unavailable", "unknown", "stale"] as const;
const FEEDBACK_ACTIONS = ["accepted", "dismissed", "edited", "executed"] as const;

export function validateScopeToken(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["scope: not an object"];
  if (!isNonEmptyString(value.namespaceId)) errors.push("scope.namespaceId");
  if (!isNonNegativeInt(value.leafId)) errors.push("scope.leafId");
  if (!isNullableInt(value.rustSessionId)) errors.push("scope.rustSessionId");
  if (!isNonEmptyString(value.shellEpoch)) errors.push("scope.shellEpoch");
  if (!isNonNegativeInt(value.contextRevision)) errors.push("scope.contextRevision");
  return errors;
}

export function validateEnvironment(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["environment: not an object"];
  if (!oneOf(value.connectionKind, CONNECTION_KINDS)) {
    errors.push("environment.connectionKind");
  }
  if (!oneOf(value.osFamily, OS_FAMILIES)) errors.push("environment.osFamily");
  if (!oneOf(value.dialect, SHELL_DIALECTS)) errors.push("environment.dialect");
  if (!isNullableString(value.targetKey)) errors.push("environment.targetKey");
  if (!isNullableString(value.userKey)) errors.push("environment.userKey");
  if (!oneOf(value.identityState, IDENTITY_STATES)) {
    errors.push("environment.identityState");
  }
  return errors;
}

export function validateCommandEvent(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["event: not an object"];
  if (value.schemaVersion !== PREDICTION_SCHEMA_VERSION) {
    errors.push("event.schemaVersion");
  }
  if (!isNonEmptyString(value.eventId)) errors.push("event.eventId");
  if (!isNonEmptyString(value.observationId)) errors.push("event.observationId");
  if (!isNullableString(value.sourceBlockId)) errors.push("event.sourceBlockId");
  if (!isNonEmptyString(value.namespaceId)) errors.push("event.namespaceId");
  if (!isNonEmptyString(value.shellEpoch)) errors.push("event.shellEpoch");
  if (!isNonNegativeInt(value.sequence)) errors.push("event.sequence");
  if (!isNonNegativeInt(value.learningGeneration)) {
    errors.push("event.learningGeneration");
  }
  if (typeof value.startedAt !== "number" || !Number.isFinite(value.startedAt)) {
    errors.push("event.startedAt");
  }
  if (!isNullableInt(value.durationMs) && value.durationMs !== null) {
    errors.push("event.durationMs");
  }
  if (typeof value.durationMs === "number" && value.durationMs < 0) {
    errors.push("event.durationMs");
  }
  if (!isNullableInt(value.exitCode)) errors.push("event.exitCode");
  if (!oneOf(value.origin, EVENT_ORIGINS)) errors.push("event.origin");
  if (!isNonEmptyString(value.commandKey)) errors.push("event.commandKey");
  if (!isNullableString(value.template)) errors.push("event.template");
  if (!isNullableString(value.replayText)) errors.push("event.replayText");
  if (!isNullableString(value.cwdKey)) errors.push("event.cwdKey");
  if (!oneOf(value.eligibility, ELIGIBILITIES)) errors.push("event.eligibility");
  if (
    value.eligibility === "eligible" &&
    (value.origin !== "user" ||
      value.replayText == null ||
      value.exitCode === null)
  ) {
    errors.push("event.eligibility: eligible requires user + replayText + exitCode");
  }
  return errors;
}

export function validatePredictionRequest(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["request: not an object"];
  if (!isNonEmptyString(value.requestId)) errors.push("request.requestId");
  if (!oneOf(value.task, PREDICTION_TASKS)) errors.push("request.task");
  errors.push(...validateScopeToken(value.scope));
  errors.push(...validateEnvironment(value.environment));
  if (!isNonNegativeInt(value.inputVersion)) errors.push("request.inputVersion");
  if (!isNonNegativeInt(value.snapshotVersion)) {
    errors.push("request.snapshotVersion");
  }
  if (!isNullableString(value.cwdKey)) errors.push("request.cwdKey");
  if (
    !isNonNegativeInt(value.limit) ||
    value.limit < 1 ||
    value.limit > MAX_CANDIDATES
  ) {
    errors.push("request.limit");
  }
  if (!oneOf(value.terminalState, TERMINAL_STATES)) {
    errors.push("request.terminalState");
  }
  const buffer = value.buffer;
  if (buffer !== null) {
    if (!isRecord(buffer)) errors.push("request.buffer");
    else {
      if (typeof buffer.text !== "string") errors.push("request.buffer.text");
      const cursor = buffer.cursor;
      const text = buffer.text;
      if (
        !isNonNegativeInt(cursor) ||
        typeof text !== "string" ||
        cursor > text.length
      ) {
        errors.push("request.buffer.cursor");
      }
    }
  }
  const block = value.block;
  if (block !== null) {
    if (!isRecord(block)) errors.push("request.block");
    else {
      if (typeof block.text !== "string") errors.push("request.block.text");
      if (!isNullableInt(block.exitCode)) errors.push("request.block.exitCode");
    }
  }
  if (value.task === "correct_buffer" && buffer === null) {
    errors.push("request.task: correct_buffer requires buffer");
  }
  if (value.task === "correct_block" && block === null) {
    errors.push("request.task: correct_block requires block");
  }
  if (value.task === "predict_next" && (buffer !== null || block !== null)) {
    errors.push("request.task: predict_next forbids buffer/block");
  }
  return errors;
}

export function validateCandidate(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["candidate: not an object"];
  if (!isNonEmptyString(value.candidateId)) errors.push("candidate.candidateId");
  if (!oneOf(value.task, PREDICTION_TASKS)) errors.push("candidate.task");
  if (!isNonEmptyString(value.displayText)) errors.push("candidate.displayText");
  if (!isNullableString(value.insertText)) errors.push("candidate.insertText");
  if (!oneOf(value.source, CANDIDATE_SOURCES)) errors.push("candidate.source");
  if (typeof value.summaryZh !== "string") errors.push("candidate.summaryZh");
  if (!Array.isArray(value.evidence)) errors.push("candidate.evidence");
  if (typeof value.rankScore !== "number" || !Number.isFinite(value.rankScore)) {
    errors.push("candidate.rankScore");
  }
  if (value.rankerVersion !== RANKER_VERSION) {
    errors.push("candidate.rankerVersion");
  }
  if (!oneOf(value.risk, RISK_LEVELS)) errors.push("candidate.risk");
  if (!oneOf(value.availability, AVAILABILITIES)) {
    errors.push("candidate.availability");
  }
  if (!Array.isArray(value.constraints)) errors.push("candidate.constraints");
  if (!Array.isArray(value.ambiguities)) errors.push("candidate.ambiguities");
  errors.push(...validateScopeToken(value.owner));
  if (!isNonNegativeInt(value.inputVersion)) errors.push("candidate.inputVersion");
  if (
    typeof value.insertText === "string" &&
    value.insertText.length > MAX_CANDIDATE_TEXT_LENGTH
  ) {
    errors.push("candidate.insertText: too long");
  }
  if (
    typeof value.insertText === "string" &&
    /[\r\n]/.test(value.insertText)
  ) {
    errors.push("candidate.insertText: multi-line");
  }
  return errors;
}

export function validateCandidateView(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["view: not an object"];
  if (!isNonEmptyString(value.requestId)) errors.push("view.requestId");
  if (!oneOf(value.status, VIEW_STATUSES)) errors.push("view.status");
  if (!oneOf(value.task, PREDICTION_TASKS)) errors.push("view.task");
  if (!Array.isArray(value.candidates)) errors.push("view.candidates");
  else {
    if (value.candidates.length > MAX_CANDIDATES) {
      errors.push("view.candidates: over limit");
    }
    value.candidates.forEach((candidate, index) => {
      errors.push(...validateCandidate(candidate).map((e) => `view[${index}].${e}`));
    });
  }
  errors.push(...validateScopeToken(value.owner));
  if (!isNonNegativeInt(value.snapshotVersion)) {
    errors.push("view.snapshotVersion");
  }
  if (typeof value.generatedAt !== "number" || !Number.isFinite(value.generatedAt)) {
    errors.push("view.generatedAt");
  }
  if (value.status === "ok" && Array.isArray(value.candidates)) {
    if (value.candidates.length === 0) errors.push("view.status: ok requires candidates");
  }
  if (value.status !== "ok" && Array.isArray(value.candidates)) {
    if (value.candidates.length > 0) {
      errors.push("view.status: non-ok forbids candidates");
    }
  }
  return errors;
}

export function validateFeedback(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["feedback: not an object"];
  if (!isNonEmptyString(value.requestId)) errors.push("feedback.requestId");
  if (!Array.isArray(value.displayed)) errors.push("feedback.displayed");
  else if (!value.displayed.every((item) => typeof item === "string")) {
    errors.push("feedback.displayed");
  }
  if (!isNonEmptyString(value.candidateId)) errors.push("feedback.candidateId");
  if (!oneOf(value.action, FEEDBACK_ACTIONS)) errors.push("feedback.action");
  if (typeof value.at !== "number" || !Number.isFinite(value.at)) {
    errors.push("feedback.at");
  }
  if (!isNonNegativeInt(value.learningGeneration)) {
    errors.push("feedback.learningGeneration");
  }
  return errors;
}

export function validateSnapshot(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return ["snapshot: not an object"];
  if (!isNonEmptyString(value.namespaceId)) errors.push("snapshot.namespaceId");
  if (!isNonNegativeInt(value.learningGeneration)) {
    errors.push("snapshot.learningGeneration");
  }
  if (!isNonNegativeInt(value.commitRevision)) {
    errors.push("snapshot.commitRevision");
  }
  if (!Array.isArray(value.commands)) errors.push("snapshot.commands");
  else if (value.commands.length > MAX_SNAPSHOT_COMMANDS) {
    errors.push("snapshot.commands: over limit");
  }
  if (!Array.isArray(value.transitions)) errors.push("snapshot.transitions");
  if (typeof value.bounded !== "boolean") errors.push("snapshot.bounded");
  return errors;
}
