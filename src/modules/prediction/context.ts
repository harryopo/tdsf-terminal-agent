/**
 * F0 生命周期观察句柄 v1（冻结候选，2026-11-12）
 * -----------------------------------------------------------------------------
 * 设计真源：01-开发方案书 §4.1 环境与事件、§4.2 记录规则。
 *
 * 现有 `onExecStart` 没有参数，block 计数也不跨重启唯一，所以不能让采集器自己猜
 * 开始/结束的对应关系。本模块给出**同步、只观察**的句柄语义：
 * - begin（命令开始）抓 owner，返回 observationId + 流内 sequence；
 * - complete（命令结束）必须携带同一 handle，并核对 owner；
 * - 缺开始、重复结束、交叠、owner 不符、时长倒退、隐私拒收 → 拒绝并断链；
 * - 断链后下一条必须另开 epoch（sequence 按 epoch 独立，不跨缺口续接）。
 *
 * 这里不写数据库、不 await、不发 RPC、不改回显；调用方只把合格事件投递给旁路队列。
 */

import {
  PREDICTION_SCHEMA_VERSION,
  isSameOwner,
  type CommandEvent,
  type Eligibility,
  type EventOrigin,
  type ScopeToken,
} from "./contracts";
import {
  projectCommand,
  type PrivacyRejectReason,
} from "./privacy";

export type ObservationRejectReason =
  | "missing-start"
  | "duplicate-end"
  | "overlapping"
  | "owner-mismatch"
  | "invalid-duration"
  | "privacy-rejected";

export type ChainBreakReason =
  | "missing-block"
  | "unknown-state"
  | "cancelled"
  | "queue-drop"
  | "context-switch"
  | "reconnect";

export type ObservationHandle = {
  observationId: string;
  owner: ScopeToken;
  origin: EventOrigin;
  startedAt: number;
  /** 同一 shellEpoch 内单调递增；过滤/隐私丢弃不重新编号。 */
  sequence: number;
};

export type BeginResult =
  | { ok: true; handle: ObservationHandle; chainBroken: boolean }
  | { ok: false; reason: "overlapping" };

export type CompletionInput = {
  sourceBlockId: string | null;
  endedAt: number;
  exitCode: number | null;
  commandRaw: string;
  cwdKey: string | null;
  learningGeneration: number;
};

export type CompletionResult =
  | { ok: true; event: CommandEvent }
  | {
      ok: false;
      reason: ObservationRejectReason;
      privacyReason?: PrivacyRejectReason;
    };

const COMPLETED_MEMORY = 512;

/**
 * 单个 leaf/epoch 的观察链。一个 tracker 只服务当前 owner；owner 变化时调用
 * `updateOwner()`（或新建 tracker），不能把旧 handle 混进新上下文。
 */
export class ObservationTracker {
  private owner: ScopeToken;
  private readonly newId: () => string;
  private pending: ObservationHandle | null = null;
  private completed = new Set<string>();
  private completedOrder: string[] = [];
  private lastSequence = new Map<string, number>();
  private chainBroken = false;

  constructor(owner: ScopeToken, newId: () => string) {
    this.owner = owner;
    this.newId = newId;
  }

  get currentOwner(): ScopeToken {
    return this.owner;
  }

  /** 切 tab / 重连 / 目录改变后更新 owner；未完成的观察保留为陈旧句柄，
   *  complete 时按 owner-mismatch 拒绝（不会静默当成本轮事件）。 */
  updateOwner(owner: ScopeToken): void {
    if (isSameOwner(this.owner, owner)) {
      this.owner = owner;
      return;
    }
    this.chainBroken = true;
    this.owner = owner;
  }

  /** 已知漏块/未知状态/取消/队列丢弃：清掉未完成观察并断链。 */
  breakChain(_reason: ChainBreakReason): void {
    this.pending = null;
    this.chainBroken = true;
  }

  begin(origin: EventOrigin, startedAt: number): BeginResult {
    if (this.pending) {
      if (!isSameOwner(this.pending.owner, this.owner)) {
        // 旧上下文的未完成观察：丢弃后按新上下文继续，不算本轮交叠。
        this.pending = null;
        this.chainBroken = true;
      } else {
        // Bash 同一时刻只应有一条前台命令；交叠说明采集时序不可信。
        this.pending = null;
        this.chainBroken = true;
        return { ok: false, reason: "overlapping" };
      }
    }
    const epoch = this.owner.shellEpoch;
    const sequence = (this.lastSequence.get(epoch) ?? 0) + 1;
    this.lastSequence.set(epoch, sequence);
    const handle: ObservationHandle = {
      observationId: this.newId(),
      owner: this.owner,
      origin,
      startedAt,
      sequence,
    };
    this.pending = handle;
    const chainBroken = this.chainBroken;
    this.chainBroken = false;
    return { ok: true, handle, chainBroken };
  }

  complete(
    handle: ObservationHandle,
    input: CompletionInput,
  ): CompletionResult {
    if (this.completed.has(handle.observationId)) {
      return { ok: false, reason: "duplicate-end" };
    }
    if (!this.pending || this.pending.observationId !== handle.observationId) {
      return { ok: false, reason: "missing-start" };
    }
    if (!isSameOwner(handle.owner, this.owner)) {
      this.pending = null;
      this.chainBroken = true;
      return { ok: false, reason: "owner-mismatch" };
    }
    this.pending = null;
    if (input.endedAt < handle.startedAt) {
      this.chainBroken = true;
      return { ok: false, reason: "invalid-duration" };
    }

    const projected = projectCommand(
      input.commandRaw,
      handle.owner.namespaceId,
    );
    if (!projected.allowed) {
      this.chainBroken = true;
      return {
        ok: false,
        reason: "privacy-rejected",
        privacyReason: projected.reason,
      };
    }

    const eligibility: Eligibility =
      handle.origin === "user" &&
      projected.replayText !== null &&
      input.exitCode !== null
        ? "eligible"
        : "ineligible";

    const event: CommandEvent = {
      schemaVersion: PREDICTION_SCHEMA_VERSION,
      eventId: `${handle.owner.shellEpoch}:${handle.observationId}`,
      observationId: handle.observationId,
      sourceBlockId: input.sourceBlockId,
      namespaceId: handle.owner.namespaceId,
      shellEpoch: handle.owner.shellEpoch,
      sequence: handle.sequence,
      learningGeneration: input.learningGeneration,
      startedAt: handle.startedAt,
      durationMs: input.endedAt - handle.startedAt,
      exitCode: input.exitCode,
      origin: handle.origin,
      commandKey: projected.commandKey,
      template: projected.template,
      replayText: projected.replayText,
      cwdKey: input.cwdKey,
      eligibility,
    };

    this.rememberCompleted(handle.observationId);
    return { ok: true, event };
  }

  /** 供测试/诊断：当前是否有未完成观察与已观测 sequence。 */
  debugState(): {
    pending: string | null;
    lastSequence: Record<string, number>;
    chainBroken: boolean;
  } {
    return {
      pending: this.pending?.observationId ?? null,
      lastSequence: Object.fromEntries(this.lastSequence),
      chainBroken: this.chainBroken,
    };
  }

  private rememberCompleted(observationId: string): void {
    this.completed.add(observationId);
    this.completedOrder.push(observationId);
    if (this.completedOrder.length > COMPLETED_MEMORY) {
      const evicted = this.completedOrder.shift();
      if (evicted) this.completed.delete(evicted);
    }
  }
}

/**
 * 断链判定：两条事件能否建立转移。
 * 必须同 namespace、同 epoch、sequence 相邻，且两端都 eligible。
 */
export function canChainTransitions(
  previous: CommandEvent,
  next: CommandEvent,
): boolean {
  return (
    previous.namespaceId === next.namespaceId &&
    previous.shellEpoch === next.shellEpoch &&
    previous.sequence + 1 === next.sequence &&
    previous.eligibility === "eligible" &&
    next.eligibility === "eligible"
  );
}

/** 学习代际：关闭/清空先推进代际，旧队列与旧反馈即使晚到也拒绝。 */
export function advanceLearningGeneration(
  previousGeneration: number,
  enabled: boolean,
): { enabled: boolean; generation: number } {
  return { enabled, generation: previousGeneration + 1 };
}
