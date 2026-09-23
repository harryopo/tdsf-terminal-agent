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

/**
 * 页面这一代刚开始时对账一次：把无人认领的 Rust SSH 会话断开。
 *
 * 必须在**任何自动连接之前**跑完，否则回收和新建会撞在一起。
 * 失败一律不抛给调用方 —— 回收是清理，不能因为它失败就不让用户开机连服务器。
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
