/**
 * activityBudget — 「连续多久没有进展就算卡死」这一段计时逻辑
 * ---------------------------------------------------------------------------
 * 从 sidecar-adapter 的异步生成器里抽出来，原因很实际：那段内联计时器一条用例
 * 都跑不到（要 fake timers 加上生成器多层 await 才能推进），结果"审批挂起把
 * 整轮打死"这种病在代码里躺了一个多月没人发现。
 *
 * 三个动作就是它的全部语义：
 *   noteActivity() 收到任何流式事件 = 有进展 → 重新给满一整段窗口
 *   pause()         整轮停在"等用户回答"上 → 这段时间不该记账
 *   resume()        用户答完了 → 重新给满一整段窗口（不是补完被吃掉的那段）
 */

export type ActivityBudget = {
  /** 有进展：非暂停时重置为完整窗口；暂停时忽略（恢复时会重置） */
  noteActivity(): void;
  /** 开始等用户：停止计时（幂等） */
  pause(): void;
  /** 不再等用户：恢复并重新给满完整窗口（未暂停时是空操作） */
  resume(): void;
  isPaused(): boolean;
  /** 收尾：清掉计时器，之后任何动作都不再触发 onExpire */
  dispose(): void;
};

export function createActivityBudget(
  timeoutMs: number,
  onExpire: () => void,
): ActivityBudget {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let paused = false;
  let disposed = false;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const arm = () => {
    clear();
    if (disposed || paused) return;
    timer = setTimeout(() => {
      timer = null;
      if (!disposed && !paused) onExpire();
    }, timeoutMs);
  };

  arm();

  return {
    noteActivity() {
      if (paused) return;
      arm();
    },
    pause() {
      if (paused) return;
      paused = true;
      clear();
    },
    resume() {
      if (!paused) return;
      paused = false;
      arm();
    },
    isPaused() {
      return paused;
    },
    dispose() {
      disposed = true;
      clear();
    },
  };
}
