/**
 * activityBudget.test.ts — 无活动计时预算（#133 审批冻结）
 * ---------------------------------------------------------------------------
 * 为什么要单独有这个模块：原来「连续 N 秒没有事件就掐断整轮」这段逻辑内联在
 * sidecar-adapter 的异步生成器里，一条用例都跑不到它（生成器要 fake timers +
 * 多层 await 才能推进），所以审批挂起 300 秒把整轮打死这件事一直没人发现。
 *
 * 被测判据（真机日志 s-mufeww1j-g9aiur.jsonl 量到的就是这条）：
 *   tool_call → 300.1s 静默 → tool_result(needs_approval)
 * 审批窗口（Python 默认 300s）与前端无活动窗口（默认 300s）是同一个数，
 * 用户想久一点整轮就没了，而报错还写着「简化问题描述后重试」。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createActivityBudget } from "./activityBudget";

describe("createActivityBudget — 无活动计时", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("连续静默到点才超时（默认窗口内不触发）", () => {
    const onExpire = vi.fn();
    const budget = createActivityBudget(1000, onExpire);
    vi.advanceTimersByTime(999);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onExpire).toHaveBeenCalledTimes(1);
    budget.dispose();
  });

  it("noteActivity 重新给满一整段窗口（有进展就不算卡死）", () => {
    const onExpire = vi.fn();
    const budget = createActivityBudget(1000, onExpire);
    vi.advanceTimersByTime(900);
    budget.noteActivity();
    vi.advanceTimersByTime(900);
    expect(onExpire).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(onExpire).toHaveBeenCalledTimes(1);
    budget.dispose();
  });

  it("dispose 之后不再触发（整轮结束时清干净）", () => {
    const onExpire = vi.fn();
    const budget = createActivityBudget(1000, onExpire);
    budget.dispose();
    vi.advanceTimersByTime(5000);
    expect(onExpire).not.toHaveBeenCalled();
  });

  describe("pause / resume：等用户的时间不记账", () => {
    it("暂停期间永不到点", () => {
      const onExpire = vi.fn();
      const budget = createActivityBudget(1000, onExpire);
      budget.pause();
      vi.advanceTimersByTime(60_000);
      expect(onExpire).not.toHaveBeenCalled();
      expect(budget.isPaused()).toBe(true);
      budget.dispose();
    });

    it("恢复后重新给满一整段窗口（不是接着扣完剩下的秒）", () => {
      const onExpire = vi.fn();
      const budget = createActivityBudget(1000, onExpire);
      vi.advanceTimersByTime(950);
      budget.pause();
      budget.resume();
      vi.advanceTimersByTime(950);
      expect(onExpire).not.toHaveBeenCalled();
      vi.advanceTimersByTime(100);
      expect(onExpire).toHaveBeenCalledTimes(1);
      budget.dispose();
    });

    it("pause 幂等：两次 pause 一次 resume 仍算暂停中", () => {
      const onExpire = vi.fn();
      const budget = createActivityBudget(1000, onExpire);
      budget.pause();
      budget.pause();
      expect(budget.isPaused()).toBe(true);
      vi.advanceTimersByTime(5000);
      expect(onExpire).not.toHaveBeenCalled();
      budget.dispose();
    });

    it("resume 未暂停时是空操作（不会多挂一个计时器导致提前到点）", () => {
      const onExpire = vi.fn();
      const budget = createActivityBudget(1000, onExpire);
      budget.resume();
      budget.resume();
      vi.advanceTimersByTime(999);
      expect(onExpire).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2);
      expect(onExpire).toHaveBeenCalledTimes(1);
      budget.dispose();
    });

    it("暂停期间的 noteActivity 不吞掉恢复（恢复后仍然计时）", () => {
      const onExpire = vi.fn();
      const budget = createActivityBudget(1000, onExpire);
      budget.pause();
      budget.noteActivity();
      budget.resume();
      vi.advanceTimersByTime(1001);
      expect(onExpire).toHaveBeenCalledTimes(1);
      budget.dispose();
    });
  });

  // #143：第二条合法等待 —— **工具正在跑**。
  // 一次 tool-input(started) 到 tool-output(settled) 之间链路上一条事件都没有，
  // 而这条命令**被允许**跑多久是模型自己声明的 timeout（Rust 侧 clamp 到 300s）
  // 再叠加各层宽限：Python = timeout+200 → 最长 500s。前端窗口只有 300s，
  // 于是声明 timeout ≥ 100s 的长命令会被前端先判「无活动超时」，而下面两层还在
  // 合法等 —— 界面报超时、服务器上命令照跑（#119 同一族）。
  // 真机读数（79 次配对调用）最长静默已达 259.6s，余量只剩 40 秒。
  describe("beginTool / endTool：工具在飞的时间不记账（#143）", () => {
    it("工具在飞期间永不到点，落地后重新给满一整段窗口", () => {
      const onExpire = vi.fn();
      const budget = createActivityBudget(1000, onExpire);
      budget.beginTool();
      vi.advanceTimersByTime(60_000);
      expect(onExpire).not.toHaveBeenCalled();
      budget.endTool();
      vi.advanceTimersByTime(999);
      expect(onExpire).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2);
      expect(onExpire).toHaveBeenCalledTimes(1);
      budget.dispose();
    });

    it("两个工具并发时，只结算一个不许提前走表", () => {
      const onExpire = vi.fn();
      const budget = createActivityBudget(1000, onExpire);
      budget.beginTool();
      budget.beginTool();
      budget.endTool();
      vi.advanceTimersByTime(60_000);
      expect(onExpire).not.toHaveBeenCalled();
      budget.endTool();
      vi.advanceTimersByTime(1001);
      expect(onExpire).toHaveBeenCalledTimes(1);
      budget.dispose();
    });

    it("endTool 多出来的部分不许把计数打成负数（否则下一次 beginTool 直接失效）", () => {
      const onExpire = vi.fn();
      const budget = createActivityBudget(1000, onExpire);
      budget.endTool();
      budget.endTool();
      budget.beginTool();
      vi.advanceTimersByTime(60_000);
      expect(onExpire).not.toHaveBeenCalled();
      budget.dispose();
    });

    it("两条轴互不干扰：等用户期间工具落地，不许把整轮误恢复成走表", () => {
      const onExpire = vi.fn();
      const budget = createActivityBudget(1000, onExpire);
      budget.pause(); // 审批挂起
      budget.beginTool();
      budget.endTool(); // 工具结算了，但人还没回答
      vi.advanceTimersByTime(60_000);
      expect(onExpire).not.toHaveBeenCalled();
      expect(budget.isPaused()).toBe(true);
      budget.resume();
      vi.advanceTimersByTime(1001);
      expect(onExpire).toHaveBeenCalledTimes(1);
      budget.dispose();
    });

    it("反向也要成立：工具在飞时审批答完，也不许开始走表", () => {
      const onExpire = vi.fn();
      const budget = createActivityBudget(1000, onExpire);
      budget.beginTool();
      budget.pause();
      budget.resume();
      vi.advanceTimersByTime(60_000);
      expect(onExpire).not.toHaveBeenCalled();
      budget.endTool();
      vi.advanceTimersByTime(1001);
      expect(onExpire).toHaveBeenCalledTimes(1);
      budget.dispose();
    });

    it("工具在飞期间的 noteActivity 不吞掉恢复", () => {
      const onExpire = vi.fn();
      const budget = createActivityBudget(1000, onExpire);
      budget.beginTool();
      budget.noteActivity();
      budget.endTool();
      vi.advanceTimersByTime(999);
      expect(onExpire).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2);
      expect(onExpire).toHaveBeenCalledTimes(1);
      budget.dispose();
    });
  });
});
