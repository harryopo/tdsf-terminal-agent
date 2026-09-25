/**
 * activityBudget — 「连续多久没有进展就算卡死」这一段计时逻辑
 * ---------------------------------------------------------------------------
 * 从 sidecar-adapter 的异步生成器里抽出来，原因很实际：那段内联计时器一条用例
 * 都跑不到（要 fake timers 加上生成器多层 await 才能推进），结果"审批挂起把
 * 整轮打死"这种病在代码里躺了一个多月没人发现。
 *
 * 计时只问一句话：**此刻有没有一件合法的事正在占着链路**。有两件事会占：
 *   pause()/resume()      等用户回答（#133）——审批窗口最长 300s
 *   beginTool()/endTool() 工具在跑（#143）——一次命令被允许跑多久由模型声明的
 *                         timeout 决定（Rust clamp 到 300s，再叠 Python 的 200s
 *                         宽限 ⇒ 最坏合法静默 500s，比默认窗口长 200 秒）
 * 两条轴各记各的账，任一还占着就不走表；两条都空了才**重新给满一整段窗口**
 * （不是补完被吃掉的那段——那等于拿别人的等待抵自己的债）。
 */

export type ActivityBudget = {
  /** 有进展：没有任何东西占着链路时重置为完整窗口；被占用时忽略（放开时会重置） */
  noteActivity(): void;
  /** 开始等用户：停止计时（幂等） */
  pause(): void;
  /** 不再等用户：若也没有工具在飞，恢复并重新给满完整窗口（未暂停时是空操作） */
  resume(): void;
  /** 一个工具开始跑：可重入（并发工具各自 begin/end 配对计数） */
  beginTool(): void;
  /** 一个工具结算：计数下界 0，多出来的调用是空操作 */
  endTool(): void;
  /** 此刻是否被占用（等用户 **或** 有工具在飞）——决定计时器走不走 */
  isPaused(): boolean;
  /** 收尾：清掉计时器，之后任何动作都不再触发 onExpire */
  dispose(): void;
};

export function createActivityBudget(
  timeoutMs: number,
  onExpire: () => void,
): ActivityBudget {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let awaitingUser = false;
  let toolsInFlight = 0;
  let disposed = false;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const held = () => awaitingUser || toolsInFlight > 0;

  const arm = () => {
    clear();
    if (disposed || held()) return;
    timer = setTimeout(() => {
      timer = null;
      if (!disposed && !held()) onExpire();
    }, timeoutMs);
  };

  arm();

  return {
    noteActivity() {
      arm();
    },
    pause() {
      if (awaitingUser) return;
      awaitingUser = true;
      arm();
    },
    resume() {
      if (!awaitingUser) return;
      awaitingUser = false;
      arm();
    },
    beginTool() {
      toolsInFlight += 1;
      arm();
    },
    endTool() {
      if (toolsInFlight === 0) return;
      toolsInFlight -= 1;
      arm();
    },
    isPaused() {
      return held();
    },
    dispose() {
      disposed = true;
      clear();
    },
  };
}

