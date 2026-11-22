/**
 * 会话内下一命令引擎（ROOT 核心算法，2026-11-12）
 * -----------------------------------------------------------------------------
 * 设计真源：01-开发方案书 §5（召回与排序）、§7（安全与 UI 接线）。
 *
 * 只做**会话内**统计：不写数据库、不发 RPC、不调模型、不执行命令。事件来自
 * `ObservationTracker` 产出的合格 CommandEvent；切目录/重连/换 tab 由 scope 的
 * contextRevision 与 epoch 表达。持久化（P5）与视图（P6）不在本文件。
 *
 * 安全口径：
 * - 只召回 `replayText` 非空、risk 已评估为 L0/L1、availability 明确 available 的命令；
 *   任一为 unknown 一律隐藏，不猜“应该能用”。
 * - 返回的 Candidate 只允许填入当前行（insertText 单行），不接受执行。
 * - ranking 分数只是排序依据，不是成功率/安全置信度。
 */

import {
  MAX_CANDIDATES,
  MAX_RECALL_PER_SOURCE,
  MAX_RECALL_POOL,
  MAX_SNAPSHOT_COMMANDS,
  RANKER_VERSION,
  isPredictNextAllowed,
  isSameOwner,
  type Availability,
  type Candidate,
  type CandidateEvidence,
  type CandidateSource,
  type CandidateView,
  type CommandEvent,
  type PredictionRequest,
  type RiskLevel,
  type ScopeToken,
  type Snapshot,
  type SnapshotCommandStat,
  type TransitionStat,
} from "./contracts";
import { canChainTransitions } from "./context";
import { rankV1 } from "./rank";

export type AvailabilityTable = ReadonlyMap<string, Availability>;
export type RiskTable = ReadonlyMap<string, RiskLevel>;

type CommandStats = {
  key: string;
  insertText: string;
  count: number;
  lastUsedAt: number;
  cwdCounts: Map<string, number>;
};

type NamespaceState = {
  commands: Map<string, CommandStats>;
  transitions: Map<string, Map<string, number>>;
  lastByEpoch: Map<string, CommandEvent>;
  brokenEpochs: Set<string>;
  commitRevision: number;
  bounded: boolean;
};

function emptyNamespace(): NamespaceState {
  return {
    commands: new Map(),
    transitions: new Map(),
    lastByEpoch: new Map(),
    brokenEpochs: new Set(),
    commitRevision: 0,
    bounded: false,
  };
}

export type SuggestInput = {
  request: PredictionRequest;
  /** 当前客户端 owner / 输入版本（渲染前复核，防过期响应）。 */
  current: ScopeToken;
  currentInputVersion: number;
  now: number;
  availability: AvailabilityTable;
  risk: RiskTable;
};

export class SessionPredictionStore {
  private namespaces = new Map<string, NamespaceState>();

  /** 只接收合格事件；其它来源/模板化/隐私拒收的事件由调用方丢弃，不进统计。 */
  record(event: CommandEvent): void {
    if (event.eligibility !== "eligible") return;
    if (event.replayText == null) return;
    const state = this.ensure(event.namespaceId);
    const existing = state.commands.get(event.commandKey);
    if (existing) {
      existing.count += 1;
      existing.lastUsedAt = Math.max(existing.lastUsedAt, event.startedAt);
      existing.insertText = event.replayText;
    } else {
      state.commands.set(event.commandKey, {
        key: event.commandKey,
        insertText: event.replayText,
        count: 1,
        lastUsedAt: event.startedAt,
        cwdCounts: new Map(),
      });
    }
    if (event.cwdKey) {
      const stats = state.commands.get(event.commandKey);
      if (stats) {
        stats.cwdCounts.set(
          event.cwdKey,
          (stats.cwdCounts.get(event.cwdKey) ?? 0) + 1,
        );
      }
    }

    const prev = state.lastByEpoch.get(event.shellEpoch);
    if (
      prev &&
      !state.brokenEpochs.has(event.shellEpoch) &&
      canChainTransitions(prev, event)
    ) {
      const successors =
        state.transitions.get(prev.commandKey) ?? new Map<string, number>();
      successors.set(
        event.commandKey,
        (successors.get(event.commandKey) ?? 0) + 1,
      );
      state.transitions.set(prev.commandKey, successors);
    }
    state.lastByEpoch.set(event.shellEpoch, event);
    state.commitRevision += 1;
    this.evictIfNeeded(state);
  }

  /** 隐私拒收/未知状态/取消/漏块：该 epoch 不能再用旧前序造转移。 */
  reportGap(namespaceId: string, shellEpoch: string): void {
    const state = this.namespaces.get(namespaceId);
    if (!state) return;
    state.brokenEpochs.add(shellEpoch);
    state.lastByEpoch.delete(shellEpoch);
    state.commitRevision += 1;
  }

  snapshot(namespaceId: string): Snapshot {
    const state = this.namespaces.get(namespaceId);
    if (!state) {
      return {
        namespaceId,
        learningGeneration: 0,
        commitRevision: 0,
        commands: [],
        transitions: [],
        bounded: false,
      };
    }
    const commands: SnapshotCommandStat[] = [...state.commands.values()].map(
      (stats) => ({
        commandKey: stats.key,
        displayText: stats.insertText,
        count: stats.count,
        lastUsedAt: stats.lastUsedAt,
        cwdCount: [...stats.cwdCounts.values()].reduce(
          (sum, value) => sum + value,
          0,
        ),
        totalCount: stats.count,
      }),
    );
    const transitions: TransitionStat[] = [];
    for (const [prevKey, successors] of state.transitions) {
      for (const [nextKey, count] of successors) {
        transitions.push({ prevKey, nextKey, count });
      }
    }
    return {
      namespaceId,
      learningGeneration: 0,
      commitRevision: state.commitRevision,
      commands,
      transitions,
      bounded: state.bounded,
    };
  }

  suggest(input: SuggestInput): CandidateView {
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
    if (request.task !== "predict_next") {
      return {
        ...base,
        status: "unavailable",
        candidates: [],
        reasonZh: "该请求不是下一命令任务",
      };
    }
    if (!isPredictNextAllowed(request)) {
      return {
        ...base,
        status: "unavailable",
        candidates: [],
        reasonZh: "终端不空闲或存在未提交输入",
      };
    }

    const state = this.namespaces.get(request.scope.namespaceId);
    if (!state || state.commands.size === 0) {
      return { ...base, status: "empty", candidates: [], reasonZh: "暂无本机历史" };
    }

    const epoch = request.scope.shellEpoch;
    const prev = state.lastByEpoch.get(epoch);
    const chainVisible = !!prev && !state.brokenEpochs.has(epoch);

    const poolKeys = new Set<string>();
    const successors = chainVisible
      ? [...(state.transitions.get(prev.commandKey) ?? new Map())]
          .sort((a, b) => b[1] - a[1])
          .slice(0, MAX_RECALL_PER_SOURCE)
      : [];
    for (const [key] of successors) poolKeys.add(key);
    for (const stats of this.topBy(
      state,
      (item) => (request.cwdKey ? item.cwdCounts.get(request.cwdKey) ?? 0 : 0),
    )) {
      poolKeys.add(stats.key);
    }
    for (const stats of this.topBy(state, (item) => item.count)) {
      poolKeys.add(stats.key);
    }
    for (const stats of this.topBy(state, (item) => item.lastUsedAt)) {
      poolKeys.add(stats.key);
    }

    const pool = [...poolKeys]
      .map((key) => state.commands.get(key))
      .filter((stats): stats is CommandStats => !!stats)
      .slice(0, MAX_RECALL_POOL);

    const qualified = pool.filter((stats) => {
      const risk = input.risk.get(stats.key) ?? "unknown";
      const availability = input.availability.get(stats.key) ?? "unknown";
      return (
        (risk === "L0" || risk === "L1") && availability === "available"
      );
    });

    const snapshotVersion = state.commitRevision;
    if (qualified.length === 0) {
      if (pool.length === 0) {
        return {
          ...base,
          snapshotVersion,
          status: "empty",
          candidates: [],
          reasonZh: "暂无可召回命令",
        };
      }
      return {
        ...base,
        snapshotVersion,
        status: "unknown",
        candidates: [],
        reasonZh: "候选的可用性或风险未知，已保守隐藏",
      };
    }

    const maxFrequency = Math.max(...qualified.map((stats) => stats.count));
    const transitionTotal = chainVisible
      ? [...(state.transitions.get(prev.commandKey) ?? new Map()).values()].reduce(
          (sum, value) => sum + value,
          0,
        )
      : 0;

    const scored = qualified
      .map((stats) => {
        const transitionCount =
          chainVisible && prev
            ? state.transitions.get(prev.commandKey)?.get(stats.key) ?? 0
            : 0;
        const cwdCount =
          request.cwdKey ? stats.cwdCounts.get(request.cwdKey) ?? 0 : 0;
        const rankScore = rankV1({
          transitionCount,
          transitionTotal,
          frequency: stats.count,
          maxFrequency,
          lastUsedAt: stats.lastUsedAt,
          cwdCount,
          totalCount: stats.count,
          now,
        });
        const evidence: CandidateEvidence[] = [];
        if (transitionCount > 0) {
          evidence.push({
            source: "markov",
            count: transitionCount,
            detailZh: `曾在该命令后使用 ${transitionCount} 次`,
          });
        }
        if (cwdCount > 0) {
          evidence.push({
            source: "cwd",
            count: cwdCount,
            detailZh: `在此目录用过 ${cwdCount} 次`,
          });
        }
        evidence.push({
          source: "mfc",
          count: stats.count,
          detailZh: `本次会话用过 ${stats.count} 次`,
        });
        evidence.push({
          source: "mru",
          lastUsedAt: stats.lastUsedAt,
          detailZh: "最近使用过",
        });
        const source: CandidateSource =
          transitionCount > 0 ? "markov" : cwdCount > 0 ? "cwd" : "mru";
        const summaryZh =
          transitionCount > 0
            ? `在上一命令之后用过 ${transitionCount} 次`
            : cwdCount > 0
              ? `此目录用过 ${cwdCount} 次`
              : `本次会话用过 ${stats.count} 次`;
        return {
          stats,
          transitionCount,
          cwdCount,
          rankScore,
          evidence,
          source,
          summaryZh,
        };
      })
      .sort(
        (a, b) =>
          b.rankScore - a.rankScore ||
          b.stats.lastUsedAt - a.stats.lastUsedAt ||
          a.stats.key.localeCompare(b.stats.key),
      )
      .slice(0, Math.min(request.limit, MAX_CANDIDATES));

    const candidates: Candidate[] = scored.map((item) => ({
      candidateId: `${request.requestId}:${item.stats.key}`,
      task: "predict_next",
      displayText: item.stats.insertText,
      insertText: item.stats.insertText,
      source: item.source,
      summaryZh: item.summaryZh,
      evidence: item.evidence,
      rankScore: item.rankScore,
      rankerVersion: RANKER_VERSION,
      risk: input.risk.get(item.stats.key) ?? "unknown",
      availability: input.availability.get(item.stats.key) ?? "unknown",
      constraints: ["only-insert", "requires-idle-empty"],
      ambiguities: [],
      owner: request.scope,
      inputVersion: request.inputVersion,
    }));

    return {
      ...base,
      snapshotVersion,
      status: "ok",
      candidates,
    };
  }

  private ensure(namespaceId: string): NamespaceState {
    let state = this.namespaces.get(namespaceId);
    if (!state) {
      state = emptyNamespace();
      this.namespaces.set(namespaceId, state);
    }
    return state;
  }

  private topBy(
    state: NamespaceState,
    score: (stats: CommandStats) => number,
  ): CommandStats[] {
    return [...state.commands.values()]
      .filter((stats) => score(stats) > 0)
      .sort((a, b) => score(b) - score(a) || b.lastUsedAt - a.lastUsedAt)
      .slice(0, MAX_RECALL_PER_SOURCE);
  }

  private evictIfNeeded(state: NamespaceState): void {
    while (state.commands.size > MAX_SNAPSHOT_COMMANDS) {
      let oldestKey: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, stats] of state.commands) {
        if (stats.lastUsedAt < oldestAt) {
          oldestAt = stats.lastUsedAt;
          oldestKey = key;
        }
      }
      if (!oldestKey) break;
      state.commands.delete(oldestKey);
      state.transitions.delete(oldestKey);
      for (const successors of state.transitions.values()) {
        successors.delete(oldestKey);
      }
      state.bounded = true;
    }
  }
}
