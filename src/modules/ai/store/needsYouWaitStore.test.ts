/**
 * needsYouWaitStore.test.ts — 「这一轮是不是停在等用户」的唯一记账处（#133）
 * ---------------------------------------------------------------------------
 * 这个 store 存在的理由只有一个：**同一个事实不许有两份判断**。
 * 「有没有卡在你身上」同时被两处消费：
 *   - 界面：审批卡下方那行转圈提示，等待时必须说「等待你的确认」而不是 Thinking…
 *   - sidecar-adapter：无活动计时器必须在这段期间停表
 * 两边各写一遍"什么算 pending / 会话怎么匹配"，就会出 #116/#127 那类病——
 * 一处更新了另一处没跟上。所以会话匹配口径也收在这里（matchesSession），
 * 审批卡组件改用自己的 filter 之前先复用这个函数。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  isAwaitingUser,
  matchesSession,
  pendingNeedsYouCount,
  subscribeAwaitingUser,
  useNeedsYouWait,
} from "./needsYouWaitStore";

const S = "s-abc";

function reset() {
  useNeedsYouWait.getState().reset();
}

beforeEach(reset);

describe("isAwaitingUser — 有 pending 请求才算在等人", () => {
  it("没有任何请求 → false", () => {
    expect(isAwaitingUser(useNeedsYouWait.getState(), S)).toBe(false);
  });

  it("本会话有 pending → true；结算后 → false", () => {
    useNeedsYouWait.getState().markPending("ny-1", S);
    expect(isAwaitingUser(useNeedsYouWait.getState(), S)).toBe(true);
    useNeedsYouWait.getState().markSettled("ny-1");
    expect(isAwaitingUser(useNeedsYouWait.getState(), S)).toBe(false);
  });

  it("别的会话在等 → 本会话不算（否则别人的审批会让我这轮永不停表）", () => {
    useNeedsYouWait.getState().markPending("ny-1", "s-other");
    expect(isAwaitingUser(useNeedsYouWait.getState(), S)).toBe(false);
    expect(isAwaitingUser(useNeedsYouWait.getState(), "s-other")).toBe(true);
  });

  it("两条里结算一条，另一条还在等 → 仍算在等", () => {
    useNeedsYouWait.getState().markPending("ny-1", S);
    useNeedsYouWait.getState().markPending("ny-2", S);
    useNeedsYouWait.getState().markSettled("ny-1");
    expect(isAwaitingUser(useNeedsYouWait.getState(), S)).toBe(true);
    useNeedsYouWait.getState().markSettled("ny-2");
    expect(isAwaitingUser(useNeedsYouWait.getState(), S)).toBe(false);
  });

  it("markPending 幂等：同一 reqId 重放不会留下两条", () => {
    useNeedsYouWait.getState().markPending("ny-1", S);
    useNeedsYouWait.getState().markPending("ny-1", S);
    expect(useNeedsYouWait.getState().pending).toHaveLength(1);
  });
});

describe("pendingNeedsYouCount — 待答条数（运行状态的输入）", () => {
  it("与 isAwaitingUser 同源：有就 >0，没有就 0", () => {
    expect(pendingNeedsYouCount(useNeedsYouWait.getState(), S)).toBe(0);
    useNeedsYouWait.getState().markPending("ny-1", S);
    useNeedsYouWait.getState().markPending("ny-2", S);
    expect(pendingNeedsYouCount(useNeedsYouWait.getState(), S)).toBe(2);
    expect(isAwaitingUser(useNeedsYouWait.getState(), S)).toBe(
      pendingNeedsYouCount(useNeedsYouWait.getState(), S) > 0,
    );
  });

  it("只数本会话的（别的会话不许算进来）", () => {
    useNeedsYouWait.getState().markPending("ny-1", "s-other");
    expect(pendingNeedsYouCount(useNeedsYouWait.getState(), S)).toBe(0);
    expect(pendingNeedsYouCount(useNeedsYouWait.getState(), "s-other")).toBe(1);
  });

  it("归属不明的（sidecar 没给 session_id）两边都算 —— 与审批卡显示口径一致", () => {
    useNeedsYouWait.getState().markPending("ny-1", null);
    expect(pendingNeedsYouCount(useNeedsYouWait.getState(), S)).toBe(1);
  });
});

describe("matchesSession — 会话归属口径（界面与计时器共用）", () => {
  it("请求没带 session_id 时算「谁的都是」——与审批卡的显示口径一致", () => {
    expect(matchesSession(null, S)).toBe(true);
    expect(matchesSession("", S)).toBe(true);
  });

  it("当前会话未知时也放行——卡面此刻同样会显示它，两边不许分叉", () => {
    expect(matchesSession(S, null)).toBe(true);
    expect(matchesSession(S, "")).toBe(true);
  });

  it("两边都有值且不同 → 不匹配", () => {
    expect(matchesSession("s-a", "s-b")).toBe(false);
    expect(matchesSession("s-a", "s-a")).toBe(true);
  });
});

describe("reset — 页面切走/整轮收尾时的兜底", () => {
  it("清空后谁都不算在等", () => {
    useNeedsYouWait.getState().markPending("ny-1", S);
    reset();
    expect(isAwaitingUser(useNeedsYouWait.getState(), S)).toBe(false);
  });
});

describe("subscribeAwaitingUser — 给非 React 消费者（无活动计时器）用", () => {
  it("订阅时立刻报当前状态，之后只在翻转时报（否则计时器不知道该停多久）", () => {
    const seen: boolean[] = [];
    const unsub = subscribeAwaitingUser(S, (v) => seen.push(v));
    expect(seen).toEqual([false]);

    useNeedsYouWait.getState().markPending("ny-1", S);
    expect(seen).toEqual([false, true]);

    // 第二条 pending 不是一次新的翻转：重复报 true 会让 resume/pause 抖动
    useNeedsYouWait.getState().markPending("ny-2", S);
    expect(seen).toEqual([false, true]);

    useNeedsYouWait.getState().markSettled("ny-1");
    expect(seen).toEqual([false, true]);

    useNeedsYouWait.getState().markSettled("ny-2");
    expect(seen).toEqual([false, true, false]);

    unsub();
    useNeedsYouWait.getState().markPending("ny-3", S);
    expect(seen).toEqual([false, true, false]);
  });

  it("只关心本会话：别的会话进出不报翻转", () => {
    const seen: boolean[] = [];
    const unsub = subscribeAwaitingUser(S, (v) => seen.push(v));
    useNeedsYouWait.getState().markPending("ny-1", "s-other");
    expect(seen).toEqual([false]);
    unsub();
  });
});
