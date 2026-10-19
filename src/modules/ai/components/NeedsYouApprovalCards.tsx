/**
 * NeedsYouApprovalCards — sidecar needs_you 审批渲染闭环（Task 6.5，方案书 v3.1 §4.4）
 * -----------------------------------------------------------------------------
 * 数据流（Python HITL 审批 → 前端四层审批卡 → RPC 回传）：
 *   1. Python strands 工具命中高危命令 → needs_you 服务 request_approval
 *      （拿 req_id `ny-*`）→ needs_you 服务按队首状态推送：
 *        event=created/responded/execution_finished/timeout/cancelled，
 *        详细字段位于 request=to_dict().extra。
 *   2. Rust ipc 转发 Tauri event `sidecar:needs_you`（外层 Event dict，
 *      业务数据在 .payload → unwrapEventPayload 解包）
 *   3. 本组件订阅 → approval 渲染 ToolApprovalCard；question 渲染提问卡，
 *      两者都通过 needs_you.respond 唤醒后端等待线程。
 *   4. 用户点击三按钮 → invokeRpc("needs_you.respond", { req_id, response })
 *      → Python 唤醒 wait_for_response 阻塞的工具线程（真实 HITL 闭环）；
 *      ⚡响应经 _record_trust_maybe 钩子记 SessionTrustStore（本会话免审）
 *
 * error / handoff 类型仍由既有状态提示处理；responded / timeout / cancelled
 * 事件到达时自动移卡。
 */
import {
  useCallback, useEffect, useMemo, useRef, useState, type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ToolApprovalCard,
  type ToolApprovalRespond,
} from "@/components/ai-elements/tool";
import { invokeRpc, onNeedsYou } from "@/lib/sidecar-bridge";
import { unwrapEventPayload } from "../lib/sidecar-adapter";
import { useChatStore } from "../store/chatStore";
import { useSshCommandOutputStore } from "../store/sshCommandOutputStore";
import { NeedsYouApprovalContext } from "../lib/needsYouApprovalContext";
import {
  matchesSession,
  useNeedsYouWait,
} from "../store/needsYouWaitStore";

/** `sidecar:needs_you` 事件 payload（Python event_bus.emit_needs_you 扁平结构） */
type NeedsYouEventPayload = {
  /** 请求类型（approval / error / question / handoff） */
  needs_type?: string;
  /** 子事件名；兼容旧 sidecar 缺省 event 时按 created 处理。 */
  event?: string;
  /** 请求 id（工具直发副本扁平携带；服务事件在 request.id） */
  id?: string;
  /** 服务事件附带的请求完整 dict（NeedsYouRequest.to_dict()） */
  request?: {
    id?: string;
    type?: string;
    session_id?: string | null;
    extra?: Record<string, unknown> | null;
    title?: string;
    description?: string;
  };
  // 工具直发副本的扁平四层字段（strands_backend/tools/__init__.py 透传）
  command?: unknown;
  semantic?: unknown;
  explanation?: unknown;
  impact?: unknown;
  risk_l?: unknown;
  tool_name?: unknown;
  title?: string;
  description?: string;
};

type ApprovalItem = {
  kind: "approval";
  reqId: string;
  sessionId: string | null;
  toolName: string;
  backendToolCallId?: string;
  operationId?: string;
  sshSessionId?: number;
  /** ToolApprovalCard 四层卡面 input（semantic/command/explanation/impact/risk_l） */
  input: Record<string, unknown>;
};

type QuestionItem = {
  kind: "question";
  reqId: string;
  sessionId: string | null;
  title: string;
  question: string;
  options: string[];
  confirmLabel: string;
};

type NeedsYouItem = ApprovalItem | QuestionItem;

const asStr = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

const asSshSessionId = (value: unknown): number | undefined => {
  const id =
    typeof value === "string" || typeof value === "number" ? Number(value) : NaN;
  return Number.isInteger(id) && id > 0 ? id : undefined;
};

/** 从事件 payload 组装审批卡数据（扁平字段优先，request.extra 兜底） */
function buildApprovalItem(
  payload: NeedsYouEventPayload,
  reqId: string,
): ApprovalItem {
  const req = payload.request ?? {};
  const extra = (req.extra ?? {}) as Record<string, unknown>;
  return {
    kind: "approval",
    reqId,
    sessionId: req.session_id ?? null,
    toolName: asStr(payload.tool_name) ?? asStr(extra.tool_name) ?? "approval",
    backendToolCallId: asStr(extra.tool_call_id),
    operationId: asStr(extra.operation_id),
    sshSessionId: asSshSessionId(extra.ssh_session_id),
    input: {
      semantic: payload.semantic ?? extra.semantic,
      command: payload.command ?? extra.command ?? "",
      explanation: payload.explanation ?? extra.explanation,
      impact: payload.impact ?? extra.impact ?? null,
      risk_l: payload.risk_l ?? extra.risk_l,
    },
  };
}

function buildQuestionItem(
  payload: NeedsYouEventPayload,
  reqId: string,
): QuestionItem {
  const req = payload.request ?? {};
  const extra = (req.extra ?? {}) as Record<string, unknown>;
  const rawOptions = Array.isArray(extra.options) ? extra.options : [];
  return {
    kind: "question",
    reqId,
    sessionId: req.session_id ?? null,
    title: payload.title ?? req.title ?? "Agent 需要你的回答",
    question:
      asStr(extra.question) ??
      payload.description ??
      req.description ??
      "请确认后继续。",
    options: rawOptions.filter(
      (value): value is string =>
        typeof value === "string" && value.trim() !== "",
    ),
    confirmLabel: asStr(extra.confirm_label) ?? "确认并继续",
  };
}

/** 按 needs_type 组装卡片（事件推送与挂载补水合两条路径共用同一套字段解析） */
function buildItem(
  payload: NeedsYouEventPayload,
  reqId: string,
): NeedsYouItem {
  return payload.needs_type === "question"
    ? buildQuestionItem(payload, reqId)
    : buildApprovalItem(payload, reqId);
}

function NeedsYouQuestionCard({
  item,
  onAnswer,
  submitting,
}: {
  item: QuestionItem;
  onAnswer: (answer: string) => void;
  submitting: boolean;
}) {
  const [answer, setAnswer] = useState("");
  return (
    <div
      className="rounded-lg border border-border bg-card p-3 shadow-sm"
      data-question-card=""
      aria-busy={submitting}
    >
      <div className="text-xs font-medium text-foreground">{item.title}</div>
      <div className="mt-1 text-sm leading-relaxed text-foreground">
        {item.question}
      </div>
      {item.options.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {item.options.map((option) => (
            <Button
              key={option}
              type="button"
              size="sm"
              variant={answer === option ? "default" : "outline"}
              disabled={submitting}
              onClick={() => setAnswer(option)}
            >
              {option}
            </Button>
          ))}
        </div>
      ) : (
        <Input
          className="mt-2"
          aria-label="回答"
          disabled={submitting}
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !submitting && answer.trim()) {
              event.preventDefault();
              onAnswer(answer.trim());
            }
          }}
        />
      )}
      <div className="mt-2 flex items-center justify-end gap-2">
        {submitting && (
          <span role="status" className="text-xs text-muted-foreground">
            正在提交回答…
          </span>
        )}
        <Button
          type="button"
          size="sm"
          disabled={submitting || !answer.trim()}
          onClick={() => onAnswer(answer.trim())}
        >
          {item.confirmLabel}
        </Button>
      </div>
    </div>
  );
}

/**
 * 当前会话的 pending needs_you approval 请求渲染（四层审批卡 × N）。
 * 无 pending 请求时渲染 null。
 */
export function NeedsYouApprovalCards({ children }: { children?: ReactNode }) {
  const [items, setItems] = useState<NeedsYouItem[]>([]);
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [slots, setSlots] = useState<
    Record<string, { toolCallId: string; toolName: string }>
  >({});
  const calls = useSshCommandOutputStore((s) => s.calls);
  const registerTool = useCallback(
    (toolCallId: string, toolName: string, slotId: string) => {
      setSlots((cur) => ({ ...cur, [slotId]: { toolCallId, toolName } }));
      return () => {
        setSlots((cur) => {
          const next = { ...cur };
          delete next[slotId];
          return next;
        });
      };
    },
    [],
  );
  const [responses, setResponses] = useState<
    Record<string, { submitting: boolean; error?: string }>
  >({});
  // 终态与在飞答复分开：迟到的 RPC 失败不能撤销已收到的终态。
  const resolvedRef = useRef<Set<string>>(new Set());
  const inFlightRef = useRef<Set<string>>(new Set());
  const activeSessionId = useChatStore((s) => s.activeSessionId);

  const settleRequest = useCallback((reqId: string) => {
    resolvedRef.current.add(reqId);
    useNeedsYouWait.getState().markSettled(reqId);
    setItems((cur) => cur.filter((item) => item.reqId !== reqId));
    setNotes((cur) => {
      const next = { ...cur };
      delete next[reqId];
      return next;
    });
    setResponses((cur) => {
      const next = { ...cur };
      delete next[reqId];
      return next;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    const subscription = onNeedsYou((raw) => {
      if (cancelled) return;
      const payload = unwrapEventPayload<NeedsYouEventPayload>(raw);
      if (!payload || typeof payload !== "object") return;
      if (
        payload.needs_type !== "approval" &&
        payload.needs_type !== "question"
      )
        return;
      const reqId = payload.request?.id ?? payload.id;
      if (!reqId) return;
      const eventName = asStr(payload.event) ?? "created";
      if (eventName === "created") {
        if (resolvedRef.current.has(reqId)) return;
        const item = buildItem(payload, reqId);
        // #133 等待事实：本组件是 needs_you 的唯一订阅者，"这一轮是不是停在
        // 等用户"只能由这里记进 store —— 无活动计时器与转圈提示都读它。
        useNeedsYouWait.getState().markPending(reqId, item.sessionId);
        setItems((cur) => {
          const idx = cur.findIndex((i) => i.reqId === reqId);
          if (idx < 0) return [...cur, item];
          // 服务重放或热更新期间的同一请求按 reqId 幂等覆盖。
          const next = cur.slice();
          next[idx] = item;
          return next;
        });
      } else if (
        eventName === "responded" ||
        eventName === "timeout" ||
        eventName === "cancelled"
      ) {
        // 用户已响应 / 5 分钟超时自动拒绝 / Agent 取消 → 移卡 + 撤销等待记账
        settleRequest(reqId);
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    }, () => {
      // 事件订阅失败时仍补拉既有请求，保留可回答的卡片。
    });

    // #59：先等订阅就绪，再补拉一次，避免列表快照与监听注册之间漏掉请求。
    // question 无审批超时兜底，漏卡会让工具线程一直等不到用户回答。
    const previousPending = useNeedsYouWait.getState().pending;
    void (async () => {
      await subscription;
      if (cancelled) return;
      // sidecar 未起 / 浏览器模式下这个 RPC 会 reject：属正常启动时序，静默跳过，
      // 事件订阅通道仍在（created 后续到达照样出卡）。
      let rows: NeedsYouEventPayload["request"][] | null = null;
      try {
        rows = await invokeRpc<NeedsYouEventPayload["request"][]>(
          "needs_you.list",
          {},
        );
      } catch {
        return;
      }
      if (cancelled || !Array.isArray(rows)) return;
      const pending = rows.filter(
        (req) => req?.type === "approval" || req?.type === "question",
      );
      const pendingIds = new Set(pending.map((req) => req?.id));
      const waitingIds = new Set(
        useNeedsYouWait.getState().pending.map((item) => item.reqId),
      );
      // 只核对补拉前已知的等待：不清新事件，也不复活补拉期间已确认的答复。
      for (const { reqId } of previousPending) {
        if (!pendingIds.has(reqId) || !waitingIds.has(reqId)) settleRequest(reqId);
      }
      if (pending.length === 0) return;
      setItems((cur) => {
        const seen = new Set(cur.map((i) => i.reqId));
        const next = cur.slice();
        for (const req of pending) {
          const reqId = req?.id;
          // 终态事件可能先于列表快照返回；已结算的请求不能被补水重新挂起。
          if (!reqId || resolvedRef.current.has(reqId) || seen.has(reqId)) continue;
          seen.add(reqId);
          const item = buildItem({ needs_type: req.type, request: req }, reqId);
          // 补拉回来的同样要记账：这一轮可能正因为这条没人答而在等，
          // 只补卡不补账 = 界面写着在思考、计时器却把等待算成卡死。
          useNeedsYouWait.getState().markPending(reqId, item.sessionId);
          next.push(item);
        }
        return next;
      });
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [settleRequest]);

  const submitResponse = useCallback(async (
    item: NeedsYouItem,
    response: Record<string, unknown>,
    expectedStatus: "approved" | "rejected" | "resolved",
    sessionTrust = false,
  ) => {
    const reqId = item.reqId;
    if (resolvedRef.current.has(reqId) || inFlightRef.current.has(reqId)) return;
    inFlightRef.current.add(reqId);
    setResponses((cur) => ({ ...cur, [reqId]: { submitting: true } }));
    try {
      const result = await invokeRpc<unknown>("needs_you.respond", {
        req_id: reqId,
        response,
      });
      const ack =
        result && typeof result === "object" && !Array.isArray(result)
          ? (result as Record<string, unknown>)
          : null;
      if (
        !ack ||
        ack.id !== reqId ||
        ack.type !== item.kind ||
        ack.status !== expectedStatus ||
        (item.sessionId && ack.session_id !== item.sessionId)
      ) {
        throw new Error("needs_you.respond did not acknowledge this response");
      }
      // 只更新已知原归属且仍是当前聊天的显示标记，不从回执猜测归属。
      if (
        sessionTrust &&
        expectedStatus === "approved" &&
        item.sessionId &&
        useChatStore.getState().activeSessionId === item.sessionId
      ) {
        useChatStore.getState().setSessionReadOnlyTrust(true);
      }
      settleRequest(reqId);
    } catch (error: unknown) {
      // 服务终态可能先于 RPC 回包；绝不删除终态屏障或重新挂起等待。
      if (!resolvedRef.current.has(reqId)) {
        console.error(`needs_you.respond failed (req_id=${reqId}):`, error);
        setResponses((cur) => ({
          ...cur,
          [reqId]: {
            submitting: false,
            error: "答复提交失败，请重试答复；这里不会重新发送命令。",
          },
        }));
      }
    } finally {
      inFlightRef.current.delete(reqId);
    }
  }, [settleRequest]);

  const handleRespond = useCallback((
    item: ApprovalItem,
    resp: Parameters<ToolApprovalRespond>[0],
  ) => {
    const response: Record<string, unknown> = { approved: resp.approved };
    if (resp.note) {
      // 拒绝附言：reason 对齐 Python needs_you.reject(reason=...) 消费习惯；
      // note 保留审批卡字段名（上层消费者二选一）
      response.reason = resp.note;
      response.note = resp.note;
    }
    if (resp.sessionTrust) {
      // trust 决策字段：decision="trust" → Python 状态机 APPROVED + 会话标记；
      // sessionTrust 为双保险（_record_trust_maybe 两者任一即触发）
      response.decision = "trust";
      response.sessionTrust = true;
    }
    void submitResponse(
      item,
      response,
      resp.approved ? "approved" : "rejected",
      resp.sessionTrust,
    );
  }, [submitResponse]);

  const handleQuestionAnswer = useCallback((item: QuestionItem, answer: string) => {
    void submitResponse(item, { answer }, "resolved");
  }, [submitResponse]);

  // 跨会话隔离：带 session_id 且与当前会话不符的请求不渲染（留给 Python 超时兜底）。
  // 口径与 #133 的等待计时共用 matchesSession——不许出现"卡看得见但没停表"
  // 或"停着表却没有卡"这种自相矛盾。
  const visible = useMemo(
    () => items.filter((i) => matchesSession(i.sessionId, activeSessionId)),
    [items, activeSessionId],
  );

  const active = visible[0];
  const boundSlot = useMemo(() => {
    if (
      active?.kind !== "approval" || !active.sessionId ||
      !active.backendToolCallId || active.sshSessionId === undefined
    ) return null;
    const matchingCalls = Object.values(calls).filter((call) =>
      !call.ended &&
      call.backendToolCallId === active.backendToolCallId &&
      call.conversationSessionId === active.sessionId &&
      call.toolName === active.toolName &&
      call.sshSessionId === active.sshSessionId &&
      (!call.operationId || !active.operationId ||
        call.operationId === active.operationId),
    );
    if (matchingCalls.length !== 1) return null;
    const call = matchingCalls[0];
    const matchingSlots = Object.entries(slots).filter(([, slot]) =>
      slot.toolCallId === call.toolCallId && slot.toolName === call.toolName,
    );
    // No guessed owner, and never two clickable copies of the same request.
    return matchingSlots.length === 1
      ? { slotId: matchingSlots[0][0], toolCallId: call.toolCallId }
      : null;
  }, [active, calls, slots]);

  const card = useMemo(() => active ? (
    <div
      className="space-y-2"
      data-needs-you-cards=""
      data-needs-you-request-id={active.reqId}
      data-queued-approvals={Math.max(0, visible.length - 1)}
    >
      {active.kind === "approval" ? (
        <>
          <div className="text-[11px] text-muted-foreground">
            目标：{active.sshSessionId === undefined
              ? "未提供目标会话"
              : `SSH 会话 #${active.sshSessionId}（主机待执行前核验）`}
          </div>
          <ToolApprovalCard
            key={active.reqId}
            toolName={active.toolName}
            input={active.input}
            submitting={responses[active.reqId]?.submitting ?? false}
            draftNote={notes[active.reqId] ?? ""}
            onDraftNoteChange={(note) => {
              setNotes((cur) => ({ ...cur, [active.reqId]: note }));
            }}
            onRespond={(resp) => handleRespond(active, resp)}
          />
        </>
      ) : (
        <NeedsYouQuestionCard
          key={active.reqId}
          item={active}
          submitting={responses[active.reqId]?.submitting ?? false}
          onAnswer={(answer) => handleQuestionAnswer(active, answer)}
        />
      )}
      {responses[active.reqId]?.error && (
        <div role="alert" className="text-xs text-destructive">
          {responses[active.reqId].error}
        </div>
      )}
    </div>
  ) : null, [active, visible.length, notes, responses, handleRespond, handleQuestionAnswer]);

  const context = useMemo(() => ({
    registerTool,
    inline: boundSlot && card ? { ...boundSlot, card } : null,
    fallback: boundSlot ? null : card,
  }), [registerTool, boundSlot, card]);
  return (
    <NeedsYouApprovalContext.Provider value={context}>
      {children === undefined ? context.fallback : children}
    </NeedsYouApprovalContext.Provider>
  );
}
