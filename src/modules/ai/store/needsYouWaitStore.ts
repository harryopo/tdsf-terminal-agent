/**
 * needsYouWaitStore — 「这一轮是不是停在等用户回答」的唯一记账处（#133）
 * ---------------------------------------------------------------------------
 * 起因是真机日志量出来的一条：tool_call 之后静默 300.1 秒才收到
 * tool_result(needs_approval)。Python 侧审批窗口默认 300s，前端"无活动就掐断
 * 整轮"的预算也正好是 300s —— 用户多想一会儿，整轮就被判超时，而报错写的是
 * 「简化问题描述后重试」。等用户不是卡死，这段时间不该记账。
 *
 * 这个 store 只有一份事实、两个消费者：
 *   - sidecar-adapter：awaiting 期间暂停无活动计时器
 *   - 对话界面：转圈那行改说「等待你的确认」，不再谎报 Thinking…
 * 会话归属口径（matchesSession）也收在这里，审批卡组件直接复用，
 * 免得出现"卡显示着但界面说在思考"这种自相矛盾（#116/#127 一族）。
 */
import { create } from "zustand";

export type NeedsYouPendingRow = {
  reqId: string;
  /** 请求自带的会话 id；空串与 null 都表示 sidecar 没给出归属 */
  sessionId: string | null;
};

type NeedsYouWaitState = {
  pending: NeedsYouPendingRow[];
  markPending(reqId: string, sessionId: string | null): void;
  markSettled(reqId: string): void;
  reset(): void;
};

export const useNeedsYouWait = create<NeedsYouWaitState>((set) => ({
  pending: [],
  markPending: (reqId, sessionId) =>
    set((s) => {
      const idx = s.pending.findIndex((p) => p.reqId === reqId);
      if (idx < 0) return { pending: [...s.pending, { reqId, sessionId }] };
      // 服务重放 / 热更新期间的同一请求按 reqId 幂等覆盖归属
      const next = s.pending.slice();
      next[idx] = { reqId, sessionId };
      return { pending: next };
    }),
  markSettled: (reqId) =>
    set((s) => ({ pending: s.pending.filter((p) => p.reqId !== reqId) })),
  reset: () => set({ pending: [] }),
}));

/**
 * 会话归属判定：任一方说不出会话时按"就是它"处理。
 *
 * 这是审批卡现有的显示口径（`!i.sessionId || !activeSessionId || 相等`），
 * 计时器必须用同一个，否则会出现"卡看得见但没停表"或反过来。
 */
export function matchesSession(
  requestSessionId: string | null | undefined,
  currentSessionId: string | null | undefined,
): boolean {
  if (!requestSessionId || !currentSessionId) return true;
  return requestSessionId === currentSessionId;
}

export function isAwaitingUser(
  state: NeedsYouWaitState,
  currentSessionId: string | null | undefined,
): boolean {
  return state.pending.some((p) => matchesSession(p.sessionId, currentSessionId));
}

/** 供非 React 消费者（sidecar-adapter）订阅本会话的等待翻转 */
export function subscribeAwaitingUser(
  currentSessionId: string | null | undefined,
  onChange: (awaiting: boolean) => void,
): () => void {
  let last = isAwaitingUser(useNeedsYouWait.getState(), currentSessionId);
  onChange(last);
  return useNeedsYouWait.subscribe((state) => {
    const next = isAwaitingUser(state, currentSessionId);
    if (next !== last) {
      last = next;
      onChange(next);
    }
  });
}
