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
  remoteCarapaceInstalled,
} from '@/lib/param-complete-client';
import {
  CARAPACE_CHANGED_EVENT,
  type CarapaceChangedPayload,
} from '@/lib/sshCarapaceEvents';
import { useSshStore } from '../sshStore';

/**
 * @returns 本窗处理了这条消息吗（没有对应会话 = 别的窗建的连接，安静忽略）
 */
export async function applyCarapaceChanged(
  payload: CarapaceChangedPayload,
): Promise<boolean> {
  const store = useSshStore.getState();
  const sess = store.sessions.find((s) => s.rustSessionId === payload.sessionId);
  if (!sess) return false;
  // 清掉本窗缓存，让下一次读真去问服务器（受 preferences 开关控制的那个
  // detectRemoteCarapace 这里不走：它"已有结果就不重查"，而我们要的正是重查）
  invalidateRemoteCarapaceCache(payload.sessionId);
  store.setRemoteCarapaceState(sess.id, 'checking');
  const installed = await remoteCarapaceInstalled(payload.sessionId);
  const latest = useSshStore.getState();
  // 探测期间可能断开：会话不在了就别把清掉的状态又写回来（同 detectRemoteCarapace 的守卫）
  if (!latest.sessions.some((s) => s.id === sess.id)) return true;
  latest.setRemoteCarapaceState(sess.id, installed ? 'installed' : 'missing');
  return true;
}

/** 注册监听（浏览器预览下没有 Tauri 运行时，listen 会 reject —— 静默降级） */
export function initCarapaceSyncListener(): void {
  void listen<CarapaceChangedPayload>(CARAPACE_CHANGED_EVENT, (e) =>
    applyCarapaceChanged(e.payload),
  ).catch(() => undefined);
}
