/**
 * 会话内保守纠错 v1（ROOT 核心算法，2026-11-12）
 * -----------------------------------------------------------------------------
 * 设计真源：01-开发方案书 §6。
 *
 * 只处理 Bash 简单命令里的**一个 token**：命令名、已知子命令、静态规格明确的
 * `--option`。每个候选只做一次插入/删除/替换/相邻换位，保留其它 token 原样。
 *
 * 明确不做：引号/展开、管道/重定向/复合运算、赋值前缀、嵌套 shell、别名/函数、
 * 路径或参数值替换、多 token 联合修复、补 sudo/提权参数。不执行任何命令。
 */

import {
  MAX_CANDIDATES,
  RANKER_VERSION,
  isSameOwner,
  type Availability,
  type Candidate,
  type CandidateView,
  type CommandEvent,
  type PredictionRequest,
  type RiskLevel,
  type ScopeToken,
} from "./contracts";

/** 纠错词表：命令名、子命令、选项。全部由调用方显式提供，不从全局猜。 */
export type CorrectionVocabulary = {
  commands: readonly string[];
  subcommands?: Readonly<Record<string, readonly string[]>>;
  options?: Readonly<Record<string, readonly string[]>>;
};

/** 纠错可用性/风险按**候选命令文本**索引（不是 commandKey 摘要）。 */
export type CorrectionAvailability = ReadonlyMap<string, Availability>;
export type CorrectionRisk = ReadonlyMap<string, RiskLevel>;

export type CorrectionInput = {
  request: PredictionRequest;
  current: ScopeToken;
  currentInputVersion: number;
  now: number;
  vocabulary: CorrectionVocabulary;
  availability: CorrectionAvailability;
  risk: CorrectionRisk;
  /** 会话内已见命令次数，用于同分排序；缺省为空。 */
  sessionCounts?: ReadonlyMap<string, number>;
};

type TokenSpan = {
  text: string;
  start: number;
  end: number;
};

const COMPLEX_BUFFER = /[|&;<>`$(){}[\]*?\\"'\n\r]/;

function tokenize(text: string): TokenSpan[] {
  const tokens: TokenSpan[] = [];
  const pattern = /\S+/g;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match) {
    tokens.push({
      text: match[0],
      start: match.index,
      end: match.index + match[0].length,
    });
    match = pattern.exec(text);
  }
  return tokens;
}

/** 只接受一次插入/删除/替换/相邻换位。 */
export function isSingleEdit(a: string, b: string): boolean {
  if (a === b) return false;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    const diffs: number[] = [];
    for (let i = 0; i < a.length; i += 1) {
      if (a[i] !== b[i]) diffs.push(i);
      if (diffs.length > 2) return false;
    }
    if (diffs.length === 1) return true;
    if (diffs.length === 2) {
      const [i, j] = diffs;
      return j === i + 1 && a[i] === b[j] && a[j] === b[i];
    }
    return false;
  }
  const longer = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  let i = 0;
  let j = 0;
  let skipped = false;
  while (i < longer.length && j < shorter.length) {
    if (longer[i] === shorter[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (skipped) return false;
    skipped = true;
    i += 1;
  }
  return true;
}

type Replacement = {
  span: TokenSpan;
  text: string;
  /** 修正后这条命令的命令名（用于可用性/风险查询）。 */
  commandText: string;
  source: "dictionary" | "spec";
};

function collectReplacements(
  text: string,
  vocabulary: CorrectionVocabulary,
): Replacement[] {
  const tokens = tokenize(text);
  if (tokens.length === 0) return [];
  const commandToken = tokens[0];
  const replacements: Replacement[] = [];
  const seen = new Set<string>();
  const push = (
    span: TokenSpan,
    candidate: string,
    source: "dictionary" | "spec",
    commandText: string,
  ) => {
    if (candidate === span.text) return;
    if (candidate === "sudo" || candidate === "doas") return;
    const key = `${span.start}:${candidate}`;
    if (seen.has(key)) return;
    seen.add(key);
    replacements.push({ span, text: candidate, commandText, source });
  };

  for (const command of vocabulary.commands) {
    if (isSingleEdit(commandToken.text, command)) {
      push(commandToken, command, "dictionary", command);
    }
  }

  if (tokens.length > 1 && !tokens[1].text.startsWith("-")) {
    const subcommands = vocabulary.subcommands?.[commandToken.text];
    if (subcommands) {
      for (const subcommand of subcommands) {
        if (isSingleEdit(tokens[1].text, subcommand)) {
          push(tokens[1], subcommand, "spec", commandToken.text);
        }
      }
    }
  }

  const options = vocabulary.options?.[commandToken.text];
  if (options) {
    for (let index = 1; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (!token.text.startsWith("--")) continue;
      for (const option of options) {
        if (option === token.text) continue;
        if (isSingleEdit(token.text, option)) {
          push(token, option, "spec", commandToken.text);
        }
      }
    }
  }

  return replacements.slice(0, 32);
}

/**
 * 生成纠错候选。只返回可插入的替换文本；接受方仍需复核原文本/光标/owner/输入
 * 版本完全相同，并且只替换那一行里的一个 token。
 */
export function suggestBufferCorrection(input: CorrectionInput): CandidateView {
  const { request, current, currentInputVersion, now } = input;
  const base = {
    requestId: request.requestId,
    task: request.task,
    owner: request.scope,
    snapshotVersion: 0,
    generatedAt: now,
  };
  if (!isSameOwner(request.scope, current)) {
    return { ...base, status: "stale", candidates: [], reasonZh: "上下文已切换" };
  }
  if (request.inputVersion !== currentInputVersion) {
    return { ...base, status: "stale", candidates: [], reasonZh: "输入已变化" };
  }
  if (request.task !== "correct_buffer" || request.buffer == null) {
    return {
      ...base,
      status: "unavailable",
      candidates: [],
      reasonZh: "该请求不是当前行纠错",
    };
  }
  const text = request.buffer.text;
  if (text.trim() === "" || COMPLEX_BUFFER.test(text)) {
    return {
      ...base,
      status: "unavailable",
      candidates: [],
      reasonZh: "复杂语法不自动纠正",
    };
  }

  const replacements = collectReplacements(text, input.vocabulary);
  if (replacements.length === 0) {
    return { ...base, status: "empty", candidates: [], reasonZh: "没有可修正的词形" };
  }

  const sessionCounts = input.sessionCounts ?? new Map<string, number>();
  const maxSession = Math.max(
    1,
    ...replacements.map((item) => sessionCounts.get(item.text) ?? 0),
  );

  const accepted: { candidate: Candidate; sortKey: string }[] = [];
  for (const replacement of replacements) {
    const availability =
      input.availability.get(replacement.commandText) ?? "unknown";
    const risk = input.risk.get(replacement.commandText) ?? "unknown";
    if (availability !== "available") continue;
    // 候选只回填、不执行：L2（中风险，需用户确认）可以展示，L3/L4 仍隐藏。
    // 与 nextCommandInjection 的最终过滤保持一致，避免两层规则分叉。
    if (risk !== "L0" && risk !== "L1" && risk !== "L2") continue;
    const insertText = `${text.slice(0, replacement.span.start)}${replacement.text}${text.slice(replacement.span.end)}`;
    if (/[\r\n]/.test(insertText)) continue;
    const sameSpan = replacements.filter(
      (item) => item.span.start === replacement.span.start,
    );
    const sessionCount = sessionCounts.get(replacement.text) ?? 0;
    accepted.push({
      sortKey: `${replacement.span.start}:${replacement.text}`,
      candidate: {
        candidateId: `${request.requestId}:corr:${replacement.span.start}:${replacement.text}`,
        task: "correct_buffer",
        displayText: insertText,
        insertText,
        source: replacement.source,
        summaryZh: `词形校正：${replacement.span.text} → ${replacement.text}（单 token 替换，语义未经校验）`,
        evidence: [
          {
            source: replacement.source,
            count: sessionCount,
            detailZh:
              replacement.source === "dictionary" ? "命令词典" : "命令规格",
          },
        ],
        rankScore: sessionCount / maxSession,
        rankerVersion: RANKER_VERSION,
        risk,
        availability,
        constraints: [
          "single-token",
          "only-insert",
          "no-execution",
          "no-privilege-change",
        ],
        ambiguities: sameSpan.length > 1 ? ["存在多个相近词形"] : [],
        owner: request.scope,
        inputVersion: request.inputVersion,
      },
    });
  }

  if (accepted.length === 0) {
    return {
      ...base,
      status: "unknown",
      candidates: [],
      reasonZh: "候选的可用性或风险未知，已保守隐藏",
    };
  }

  accepted.sort(
    (a, b) =>
      b.candidate.rankScore - a.candidate.rankScore ||
      (a.candidate.source === b.candidate.source
        ? 0
        : a.candidate.source === "spec"
          ? -1
          : 1) ||
      a.sortKey.localeCompare(b.sortKey),
  );

  return {
    ...base,
    status: "ok",
    candidates: accepted
      .slice(0, MAX_CANDIDATES)
      .map((item) => item.candidate),
  };
}

/**
 * 接受前的原文本/光标复核：纠错接受必须保证“改的还是请求时那一行”。
 * 与 offer 生成时的 owner/inputVersion 一起用，任一变化即拒绝。
 */
export function isCorrectionTargetCurrent(
  request: PredictionRequest,
  currentScope: ScopeToken,
  currentInputVersion: number,
  currentText: string,
  currentCursor: number,
): boolean {
  return (
    request.buffer != null &&
    isSameOwner(request.scope, currentScope) &&
    request.inputVersion === currentInputVersion &&
    request.buffer.text === currentText &&
    request.buffer.cursor === currentCursor
  );
}

/** 会话内统计（可选）：供 ROOT 接线时把已见命令次数带进纠错排序。 */
export function countsFromEvents(events: readonly CommandEvent[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (event.eligibility !== "eligible" || event.replayText == null) continue;
    counts.set(event.replayText, (counts.get(event.replayText) ?? 0) + 1);
  }
  return counts;
}

// ============================================================================
// CORR-03 P2：显式“更多词形候选”（次级入口，不影响自动层单编辑）
// ============================================================================

/**
 * 有界编辑距离（含相邻换位，算 1 次）。超过 max 立即返回 max+1。
 * 只用于次级入口的“有界相邻换位编辑距离 ≤2”门槛；自动层仍用 isSingleEdit。
 */
export function boundedEditDistance(a: string, b: string, max = 2): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] | null = null;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const cur = new Array<number>(b.length + 1);
    cur[0] = i;
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let value = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1] &&
        prev2
      ) {
        value = Math.min(value, prev2[j - 2] + 1);
      }
      cur[j] = value;
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > max) return max + 1;
    prev2 = prev;
    prev = cur;
  }
  return prev[b.length] > max ? max + 1 : prev[b.length];
}

/** 次级召回门槛（ROOT v1.2 §P2.2）。 */
const MORE_MIN_INPUT = 5;
const MORE_MAX_INPUT = 64;
const MORE_MIN_CANDIDATE = 4;
const MORE_MAX_DISTANCE = 2;
const MORE_MAX_RATIO = 0.4;
const MORE_MAX_RESULTS = 3;

function collectMoreReplacements(
  text: string,
  vocabulary: CorrectionVocabulary,
): { span: TokenSpan; text: string; commandText: string; distance: number }[] {
  const tokens = tokenize(text);
  if (tokens.length === 0) return [];
  const head = tokens[0];
  if (head.text.length < MORE_MIN_INPUT || head.text.length > MORE_MAX_INPUT) {
    return [];
  }
  const found: {
    span: TokenSpan;
    text: string;
    commandText: string;
    distance: number;
  }[] = [];
  for (const command of vocabulary.commands) {
    if (command.length < MORE_MIN_CANDIDATE) continue;
    if (command === head.text) continue;
    const distance = boundedEditDistance(head.text, command, MORE_MAX_DISTANCE);
    if (distance < 1 || distance > MORE_MAX_DISTANCE) continue;
    const longest = Math.max(head.text.length, command.length);
    if (longest === 0 || distance / longest > MORE_MAX_RATIO) continue;
    found.push({ span: head, text: command, commandText: command, distance });
  }
  found.sort(
    (a, b) => a.distance - b.distance || a.text.localeCompare(b.text),
  );
  return found;
}

/**
 * 显式“更多词形候选”：只在用户点按钮/快捷键后调用。
 * 规则：首 token 5–64 字符、候选 ≥4 字符、有界距离 ≤2 且 ≤40% 长度、最多 3 条。
 * 自动层（suggestBufferCorrection）完全不调用本函数。
 */
export function suggestBufferCorrectionMore(input: CorrectionInput): CandidateView {
  const { request, current, currentInputVersion, now } = input;
  const base = {
    requestId: request.requestId,
    task: request.task,
    owner: request.scope,
    snapshotVersion: 0,
    generatedAt: now,
  };
  if (!isSameOwner(request.scope, current)) {
    return { ...base, status: "stale", candidates: [], reasonZh: "上下文已切换" };
  }
  if (request.inputVersion !== currentInputVersion) {
    return { ...base, status: "stale", candidates: [], reasonZh: "输入已变化" };
  }
  if (request.task !== "correct_buffer" || request.buffer == null) {
    return { ...base, status: "unavailable", candidates: [], reasonZh: "该请求不是当前行纠错" };
  }
  const text = request.buffer.text;
  if (text.trim() === "" || COMPLEX_BUFFER.test(text)) {
    return { ...base, status: "unavailable", candidates: [], reasonZh: "复杂语法不自动纠正" };
  }
  const head = tokensOf(text)[0]?.text ?? "";
  if (head.length < MORE_MIN_INPUT) {
    return {
      ...base,
      status: "empty",
      candidates: [],
      reasonZh: "短命令名不做二次编辑扩展",
    };
  }
  const replacements = collectMoreReplacements(text, input.vocabulary);
  if (replacements.length === 0) {
    return { ...base, status: "empty", candidates: [], reasonZh: "没有更宽的相近词形" };
  }
  const accepted: { candidate: Candidate; distance: number }[] = [];
  for (const replacement of replacements) {
    const availability = input.availability.get(replacement.commandText) ?? "unknown";
    const risk = input.risk.get(replacement.commandText) ?? "unknown";
    if (availability !== "available") continue;
    if (risk !== "L0" && risk !== "L1" && risk !== "L2") continue;
    const insertText = `${text.slice(0, replacement.span.start)}${replacement.text}${text.slice(replacement.span.end)}`;
    if (/[\r\n]/.test(insertText)) continue;
    accepted.push({
      distance: replacement.distance,
      candidate: {
        candidateId: `${request.requestId}:more:${replacement.span.start}:${replacement.text}`,
        task: "correct_buffer",
        displayText: insertText,
        insertText,
        source: "dictionary",
        summaryZh: `相近命令：${replacement.span.text} → ${replacement.text}（二次编辑，语义未经校验）`,
        evidence: [{ source: "dictionary", count: 0, detailZh: "命令词典（更多词形）" }],
        rankScore: 0,
        rankerVersion: RANKER_VERSION,
        risk,
        availability,
        constraints: ["single-token", "only-insert", "no-execution", "no-privilege-change"],
        ambiguities: accepted.length > 0 ? ["存在多个相近词形"] : [],
        owner: request.scope,
        inputVersion: request.inputVersion,
      },
    });
  }
  if (accepted.length === 0) {
    return {
      ...base,
      status: "unknown",
      candidates: [],
      reasonZh: "候选的可用性或风险未知，已保守隐藏",
    };
  }
  accepted.sort(
    (a, b) =>
      a.distance - b.distance ||
      a.candidate.displayText.localeCompare(b.candidate.displayText),
  );
  return {
    ...base,
    status: "ok",
    candidates: accepted.slice(0, MORE_MAX_RESULTS).map((item) => item.candidate),
  };
}

function tokensOf(text: string): TokenSpan[] {
  const spans: TokenSpan[] = [];
  const pattern = /\S+/g;
  let match: RegExpExecArray | null = pattern.exec(text);
  while (match) {
    spans.push({ text: match[0], start: match.index, end: match.index + match[0].length });
    match = pattern.exec(text);
  }
  return spans;
}
