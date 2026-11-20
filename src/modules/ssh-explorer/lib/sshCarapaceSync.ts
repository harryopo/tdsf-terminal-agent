/**
 * sshCarapaceSync.ts — 主窗侧：收到「远端补全组件已变更」就重问一次服务器
 * -----------------------------------------------------------------------------
 * 存在性结果缓存在 `param-complete-client` 的模块级 Map 里，而设置窗与主窗是
 * 两个 JS context（`src/settings/main.tsx` / `src/main.tsx` 各自一份模块状态）。
 * 所以在设置页装完，主窗那份缓存还是"未安装"，SSH 终端右下角的图标会继续喊
 * 你去装 —— 与 #123/#127 同族：界面在报过期事实。
 *
 * 只在主窗注册（`src/main.tsx` 动态 import），设置窗不监听自己发的消息。
 */
import { listen } from '@tauri-apps/api/event';
import {
  invalidateRemoteCarapaceCache,
  probeRemoteCarapace,
} from '@/lib/param-complete-client';
import {
  CARAPACE_CHANGED_EVENT,
  type CarapaceChangedPayload,
} from '@/lib/sshCarapaceEvents';
import { useSshStore } from '../sshStore';

const syncRequests = new Map<string, symbol>();

/**
 * @returns 本窗处理了这条消息吗（没有对应会话 = 别的窗建的连接，安静忽略）
 */
export async function applyCarapaceChanged(
  payload: CarapaceChangedPayload,
): Promise<boolean> {
  const store = useSshStore.getState();
  const source = store.sessions.find((s) => s.rustSessionId === payload.sessionId);
  if (!source) return false;
  // 组件按服务器账号安装，但状态和预测缓存按连接保存；同身份会话各自重查。
  const targets = store.sessions.filter((s) => s.id === source.id || (
    s.state === 'connected' && s.params.host === source.params.host &&
    s.params.user === source.params.user && s.params.port === source.params.port
  ));
  await Promise.all(targets.map(async (sess) => {
    const rustSessionId = sess.rustSessionId;
    if (rustSessionId === null) return;
    const request = Symbol();
    syncRequests.set(sess.id, request);
    invalidateRemoteCarapaceCache(rustSessionId);
    store.setRemoteCarapaceState(sess.id, 'checking');
    try {
      const state = await probeRemoteCarapace(rustSessionId);
      const latest = useSshStore.getState();
      const current = latest.sessions.find((s) => s.id === sess.id);
      if (syncRequests.get(sess.id) !== request || current?.rustSessionId !== rustSessionId ||
          latest.remoteCarapaceBySession[sess.id] !== 'checking') return;
      latest.setRemoteCarapaceState(sess.id, state);
    } finally {
      if (syncRequests.get(sess.id) === request) syncRequests.delete(sess.id);
    }
  }));
  return true;
}

/** 注册监听（浏览器预览下没有 Tauri 运行时，listen 会 reject —— 静默降级） */
export function initCarapaceSyncListener(): void {
  void listen<CarapaceChangedPayload>(CARAPACE_CHANGED_EVENT, (e) =>
    applyCarapaceChanged(e.payload),
  ).catch(() => undefined);
}
