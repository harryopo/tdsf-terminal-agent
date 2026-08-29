/**
 * NeedsYouApprovalCards — sidecar needs_you 审批渲染闭环（Task 6.5，方案书 v3.1 §4.4）
 * -----------------------------------------------------------------------------
 * 数据流（Python HITL 审批 → 前端四层审批卡 → RPC 回传）：
 *   1. Python strands 工具命中高危命令 → needs_you 服务 request_approval
 *      （拿 req_id `ny-*`）→ event_bus.emit_needs_you 双通道推送：
 *        a. 服务事件（needs_you.py _emit_event：含 event=created/responded/
 *           timeout/cancelled + request=to_dict()）
 *        b. 工具直发副本（strands_backend/tools request_approval_and_wait：
 *           扁平携带 id/command/semantic/explanation/impact/risk_l/tool_name）
 *   2. Rust ipc 转发 Tauri event `sidecar:needs_you`（外层 Event dict，
 *      业务数据在 .payload → unwrapEventPayload 解包）
 *   3. 本组件订阅 → 只接管 approval 类型的 created 事件 → 渲染
 *      ToolApprovalCard（四层卡面）
 *   4. 用户点击三按钮 → invokeRpc("needs_you.respond", { req_id, response })
 *      → Python 唤醒 wait_for_response 阻塞的工具线程（真实 HITL 闭环）；
 *      ⚡响应经 _record_trust_maybe 钩子记 SessionTrustStore（本会话免审）
 *
 * 边界：question / error / handoff 类型不在此渲染（保持既有行为不破坏）；
 * responded / timeout / cancelled 事件到达时自动移卡（300s 超时 fail-closed
 * 由 Python 侧负责）。
 */
import { useEffect, useMemo, useRef, useState } from "react";
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
  /** 子事件名（created / responded / timeout / cancelled；工具直发副本缺省视为 created） */
  event?: string;
  /** 请求 id（工具直发副本扁平携带；服务事件在 request.id） */
  id?: string;
  /** 服务事件附带的请求完整 dict（NeedsYouRequest.to_dict()） */
  request?: {
    id?: string;
    type?: string;
    session_id?: string | null;
    extra?: Record<string, unknown> | null;
  };
  // 工具直发副本的扁平四层字段（strands_backend/tools/__init__.py 透传）
  command?: unknown;
  semantic?: unknown;
  explanation?: unknown;
  impact?: unknown;
  risk_l?: unknown;
  tool_name?: unknown;
};

type ApprovalItem = {
  reqId: string;
  sessionId: string | null;
  toolName: string;
  /** ToolApprovalCard 四层卡面 input（semantic/command/explanation/impact/risk_l） */
  input: Record<string, unknown>;
};

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

/**
 * 当前会话的 pending needs_you approval 请求渲染（四层审批卡 × N）。
 * 无 pending 请求时渲染 null。
 */
export function NeedsYouApprovalCards() {
  const [items, setItems] = useState<ApprovalItem[]>([]);
  // 已响应/已终结请求集合（防双击重复 respond；responded/timeout 事件同样入集）
  const resolvedRef = useRef<Set<string>>(new Set());
  const activeSessionId = useChatStore((s) => s.activeSessionId);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void onNeedsYou((raw) => {
      const payload = unwrapEventPayload<NeedsYouEventPayload>(raw);
      if (!payload || typeof payload !== "object") return;
      // 只接管 approval；question / error / handoff 不新增 UI（不破坏现状）
      if (payload.needs_type !== "approval") return;
      const reqId = payload.request?.id ?? payload.id;
      if (!reqId) return;
      const eventName = asStr(payload.event) ?? "created";
      if (eventName === "created") {
        if (resolvedRef.current.has(reqId)) return;
        const item = buildApprovalItem(payload, reqId);
        setItems((cur) => {
          const idx = cur.findIndex((i) => i.reqId === reqId);
          if (idx < 0) return [...cur, item];
          // 双通道（服务事件 + 工具直发）同一请求会到两次，按 reqId 幂等覆盖
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
  return (
    <div className="space-y-2" data-needs-you-cards="">
      {visible.map((item) => (
        <ToolApprovalCard
          key={item.reqId}
          toolName={item.toolName}
          input={item.input}
          onRespond={(resp) => handleRespond(item.reqId, resp)}
        />
      ))}
    </div>
  );
}
