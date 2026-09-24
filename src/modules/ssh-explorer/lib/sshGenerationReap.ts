/**
 * sshGenerationReap — 「这一页是新的，那上一条连接归谁」的对账口径（#117）
 * -----------------------------------------------------------------------------
 * Rust 的 SSH 会话注册表活在应用进程里，前端页面重载（dev 的 HMR 整页重载、
 * 设置页那个「重新加载应用以应用更改」按钮）时它不会跟着清。于是重载后：
 * 新页面的 store 是空的，启动自动连接又拨一条新的 ⇒ 上一代那条远端 shell
 * 从此没有任何人引用它，一直活到进程退出。实测一次重载 1→2 条，dev 机攒到
 * 14 条（其中 10 条当前 UI 永远达不到），MaxSessions 小的服务器会被自己的
 * 历史连接挡在门外。
 *
 * 所以判据只有一个来源：**这条会话是哪个 webview 窗口建的**（Rust 在
 * `ssh_connect` 时按调用方窗口记账，经 `ssh_sessions_detail` 暴露）。
 */
import {
  getAllWebviewWindows,
  getCurrentWebviewWindow,
} from "@tauri-apps/api/webviewWindow";

import { sshDisconnect, sshSessionsDetail } from "@/lib/ssh-bridge";
import { isTauriRuntime } from "@/lib/tauriRuntime";

import { useSshStore } from "../sshStore";

export type SshSessionOwnership = {
  sessionId: number;
  /** 建这条连接的 webview label；Rust 认不出出身时为 null */
  ownerWindow: string | null;
};

/**
 * 启动时该断开哪些 Rust 会话（纯函数，可离线断言）。
 *
 * - 主人就是我这个 label ⇒ 我的上一代页面留下的，收；
 * - 主人已经不在活着的面板里 ⇒ 它那个窗口关了，收；
 * - 认不出出身（null / 空串）⇒ **不动**，误杀一条用户正在用的连接比留一条僵尸更糟；
 * - 我这一代正在引用的 ⇒ **一律不动**（这个函数不该假设自己只被调用一次）。
 */
export function planSshReapAtBoot(input: {
  sessions: readonly SshSessionOwnership[];
  selfWindowLabel: string;
  liveWindowLabels: readonly string[];
  referencedSessionIds: readonly number[];
}): number[] {
  const live = new Set(input.liveWindowLabels);
  const referenced = new Set(input.referencedSessionIds);
  return input.sessions
    .filter((s) => {
      const owner = s.ownerWindow;
      if (owner === null || owner === "") return false;
      if (referenced.has(s.sessionId)) return false;
      return owner === input.selfWindowLabel || !live.has(owner);
    })
    .map((s) => s.sessionId)
    .sort((a, b) => a - b);
}

/** #126：等待超时后置真 —— 晚到的清单再也不许执行断开 */
let abandoned = false;
/** #126：整页只跑一次（`startSshBootReap` 幂等的凭据） */
let bootReap: Promise<number[]> | null = null;

/**
 * 页面这一代刚开始时对账一次：把无人认领的 Rust SSH 会话断开。
 *
 * 失败一律不抛给调用方 —— 回收是清理，不能因为它失败就不让用户开机连服务器。
 *
 * ⚠️ #126（2026-09-24）：**不要直接在 React effect 里调它**。Rust 的会话注册表活在
 * 应用进程里，而"谁该被收"这件事是**页面这一代**的账 —— 如果渲染挂了（白屏、模块求值期
 * 抛错），effect 永远不会跑，上一代那条 shell 就一直留在服务器上。实测就是这样漏的：
 * 我故意把页面搞崩的那一代，boot 回收只收了 id=9，id=10 从此无人引用。
 * 所以触发点提到 `main.tsx`（模块顶层，渲染之前），这里只留一个幂等的入口。
 *
 * @returns 实际断开的会话号（供日志/探针核对）
 */
export async function reapStaleSshSessionsAtBoot(): Promise<number[]> {
  if (!isTauriRuntime()) return [];
  const self = getCurrentWebviewWindow().label;
  const [details, windows] = await Promise.all([
    sshSessionsDetail(),
    getAllWebviewWindows(),
  ]);
  const doomed = planSshReapAtBoot({
    sessions: details.map((d) => ({
      sessionId: d.sessionId,
      ownerWindow: d.ownerWindow,
    })),
    selfWindowLabel: self,
    liveWindowLabels: windows.map((w) => w.label),
    referencedSessionIds: useSshStore
      .getState()
      .sessions.map((s) => s.rustSessionId)
      .filter((id): id is number => id !== null),
  });
  const reaped: number[] = [];
  for (const id of doomed) {
    if (abandoned) {
      // 见 waitForSshBootReap：等待已经超时放弃了，晚到的清单不许再杀连接
      // 见 waitForSshBootReap：等待已经超时放弃了，晚到的清单不许再杀连接
      console.warn(
        `[ssh] boot reap 已超时放弃 ⇒ 晚到的清单里 ${doomed.length - reaped.length} 条不再断开`,
      );
      return reaped;
    }
    try {
      await sshDisconnect(id);
      reaped.push(id);
    } catch (e) {
      console.warn("[ssh] boot reap 断开失败，跳过:", id, e);
    }
  }
  if (reaped.length > 0) {
    console.info(
      `[ssh] boot reap: 回收上一代页面留下的 ${reaped.length} 条 SSH 连接`,
      reaped,
    );
  }
  return reaped;
}

/** 等多久就放弃等回收（`ssh_sessions_detail` 在真机挂起过 ⇒ 不能因此连不上服务器） */
export const SSH_BOOT_REAP_DEADLINE_MS = 5000;

/**
 * #126：**启动回收的唯一触发点** —— 必须在渲染之前调用（`main.tsx` 模块顶层）。
 *
 * 为什么不再挂在 React effect 上：Rust 的会话注册表活在应用进程里，而"谁该被收"是
 * **页面这一代**的账。渲染挂了（白屏、模块求值期抛错）⇒ effect 永远不跑 ⇒ 上一代那条
 * shell 一直留在服务器上。实测就是这样漏的：被我故意搞崩的那一代，boot 回收只收了 id=9，
 * id=10 从此无人引用。
 *
 * 幂等：重复调用返回同一个 promise，整页只跑一次（所以 App 那边 await 它不会跑第二遍，
 * 也就不会杀掉自己刚建的连接 —— #117 那条"别假设清理函数只被调一次"的教训在这里根治）。
 */
export function startSshBootReap(): Promise<number[]> {
  if (!bootReap) {
    bootReap = reapStaleSshSessionsAtBoot().catch((e) => {
      console.warn("[ssh] boot reap 失败（不阻塞启动）:", e);
      return [];
    });
  }
  return bootReap;
}

/**
 * #126：自动连接之前等它 —— 但**等不到也必须放行**。
 *
 * 顺序是正确性的一部分（先收后拨，连接数才不会一边涨一边删）；可这一步走的是两条 IPC
 * （`ssh_sessions_detail` / `getAllWebviewWindows`），真机挂起过 ⇒ 死等的代价是用户
 * **连不上自己的服务器**，那比留一条僵尸 shell 严重得多。
 *
 * 所以超时时同时把 `abandoned` 置真：**晚到的清单一律不再执行断开**。必须这样做，
 * 是因为那时自动连接可能已经拨出新的一条，而它还在飞、没进 store ——
 * `planSshReapAtBoot` 的"我正在引用"一票否决挡不住一个尚未登记的会话号。
 *
 * @returns 实际断开的会话号；超时或失败时为空数组
 */
export async function waitForSshBootReap(
  timeoutMs = SSH_BOOT_REAP_DEADLINE_MS,
): Promise<number[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const raced = await Promise.race([startSshBootReap(), deadline]);
  clearTimeout(timer);
  if (raced === null) {
    abandoned = true;
    console.warn(
      `[ssh] boot reap ${timeoutMs}ms 没回来 ⇒ 不再等待，先让用户连服务器（晚到的清单不会执行断开）`,
    );
    return [];
  }
  return raced;
}
