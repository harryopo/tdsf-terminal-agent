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
import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  ToolApprovalCard,
  type ToolApprovalRespond,
} from "@/components/ai-elements/tool";
import { invokeRpc, onNeedsYou } from "@/lib/sidecar-bridge";
import { unwrapEventPayload } from "../lib/sidecar-adapter";
import { useChatStore } from "../store/chatStore";

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
}: {
  item: QuestionItem;
  onAnswer: (answer: string) => void;
}) {
  const [answer, setAnswer] = useState("");
  return (
    <div
      className="rounded-lg border border-border bg-card p-3 shadow-sm"
      data-question-card=""
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
          value={answer}
          onChange={(event) => setAnswer(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && answer.trim()) onAnswer(answer.trim());
          }}
        />
      )}
      <div className="mt-2 flex justify-end">
        <Button
          type="button"
          size="sm"
          disabled={!answer.trim()}
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
export function NeedsYouApprovalCards() {
  const [items, setItems] = useState<NeedsYouItem[]>([]);
  // 已响应/已终结请求集合（防双击重复 respond；responded/timeout 事件同样入集）
  const resolvedRef = useRef<Set<string>>(new Set());
  const activeSessionId = useChatStore((s) => s.activeSessionId);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void onNeedsYou((raw) => {
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
        // 用户已响应 / 5 分钟超时自动拒绝 / Agent 取消 → 移卡
        resolvedRef.current.add(reqId);
        setItems((cur) => cur.filter((i) => i.reqId !== reqId));
      }
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  // #59 补水合：needs_you 的 created 只推一次，页面重载 / 挂载竞态期间错过的
  // 事件不会重放。approval 还有 300s 超时兜底，而 question 的 deadline 恒为
  // None（needs_you.py 只给 approval 设超时），Python 侧 wait_for_response 会
  // 无限阻塞工具线程 —— 少这一次补拉就是"agent 卡死且界面上没有任何可点的东西"。
  // 故挂载时按 needs_you.list 拉一次 pending 请求，把错过的卡片补齐。
  useEffect(() => {
    let cancelled = false;
    void (async () => {
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
      if (pending.length === 0) return;
      setItems((cur) => {
        const seen = new Set(cur.map((i) => i.reqId));
        const next = cur.slice();
        for (const req of pending) {
          const reqId = req?.id;
          if (!reqId || seen.has(reqId)) continue;
          seen.add(reqId);
          next.push(buildItem({ needs_type: req.type, request: req }, reqId));
        }
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleRespond = (
    reqId: string,
    resp: Parameters<ToolApprovalRespond>[0],
  ) => {
    if (resolvedRef.current.has(reqId)) return; // 防重复点击
    resolvedRef.current.add(reqId);
    // ⚡会话免审：置位前端会话标志（幂等——⚡按钮点击时 tool.tsx 已置位，
    // 此处兜底覆盖其他触发路径）；Python 侧由 needs_you.respond 的 trust
    // 钩子（_record_trust_maybe → trust_store.record_session_trust）记录
    if (resp.sessionTrust) {
      useChatStore.getState().setSessionReadOnlyTrust(true);
    }
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
    void invokeRpc("needs_you.respond", { req_id: reqId, response })
      .then(() => setItems((cur) => cur.filter((i) => i.reqId !== reqId)))
      .catch((e: unknown) => {
        // 不静默吞错：打印并恢复可重试（请求保持 pending，Python 300s 超时兜底拒绝）
        console.error(`needs_you.respond failed (req_id=${reqId}):`, e);
        resolvedRef.current.delete(reqId);
      });
  };

  const handleQuestionAnswer = (reqId: string, answer: string) => {
    if (resolvedRef.current.has(reqId)) return;
    resolvedRef.current.add(reqId);
    void invokeRpc("needs_you.respond", { req_id: reqId, response: { answer } })
      .then(() => setItems((cur) => cur.filter((item) => item.reqId !== reqId)))
      .catch((error: unknown) => {
        console.error(`needs_you.respond failed (req_id=${reqId}):`, error);
        resolvedRef.current.delete(reqId);
      });
  };

  // 跨会话隔离：带 session_id 且与当前会话不符的请求不渲染（留给 Python 超时兜底）
  const visible = useMemo(
    () =>
      items.filter(
        (i) =>
          !i.sessionId || !activeSessionId || i.sessionId === activeSessionId,
      ),
    [items, activeSessionId],
  );

  if (visible.length === 0) return null;
  const active = visible[0];
  return (
    <div
      className="space-y-2"
      data-needs-you-cards=""
      data-queued-approvals={Math.max(0, visible.length - 1)}
    >
      {active.kind === "approval" ? (
        <ToolApprovalCard
          key={active.reqId}
          toolName={active.toolName}
          input={active.input}
          onRespond={(resp) => handleRespond(active.reqId, resp)}
        />
      ) : (
        <NeedsYouQuestionCard
          key={active.reqId}
          item={active}
          onAnswer={(answer) => handleQuestionAnswer(active.reqId, answer)}
        />
      )}
    </div>
  );
}
