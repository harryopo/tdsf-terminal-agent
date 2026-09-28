/**
 * sshCarapaceSync.test.ts — 主窗侧收到「补全组件已变更」之后做的事
 * -----------------------------------------------------------------------------
 * 这条链存在的理由：检测缓存是**每个窗各自一份**模块级 Map（设置窗与主窗是两个
 * JS context），装完不通知的话主窗图标继续喊"未安装"。所以判据要证明的是
 * "重问了服务器"，而不是"改了个字段"。
 *
 * sshStore 与 param-complete-client 都按模块路径 mock，`remoteCarapaceInstalled`
 * 用真实现（它带缓存）才能看出失效有没有生效 —— 这里改成假实现就什么都测不到，
 * 所以只 mock 它底下的 invoke。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  invoke: vi.fn(),
  sessions: [] as Array<{ id: string; rustSessionId: number | null }>,
  states: {} as Record<string, string>,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: m.invoke,
  Channel: class {},
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));

vi.mock('../sshStore', () => ({
  useSshStore: {
    getState: () => ({
      sessions: m.sessions,
      setRemoteCarapaceState: (id: string, state: string) => {
        m.states[id] = state;
      },
    }),
  },
}));

import { applyCarapaceChanged } from './sshCarapaceSync';
import { invalidateRemoteCarapaceCache } from '@/lib/param-complete-client';

/** 让 ssh_command 按 mark 参数回"已装/未装" */
function answerCheck(installed: boolean) {
  m.invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
    if (cmd !== 'ssh_command') return Promise.resolve(null);
    const command = String(args?.command ?? '');
    return Promise.resolve({
      ok: true,
      output: installed && command.includes('command -v') ? '__TDSF_CARAPACE_YES__' : '',
      stderr: '',
      exitCode: installed ? 0 : 1,
      duration: 0.1,
    });
  });
}

beforeEach(() => {
  m.invoke.mockReset();
  m.sessions = [{ id: 's-1', rustSessionId: 7 }];
  m.states = {};
  // 检测结果缓存在模块级 Map 里，跨用例残留会让"有没有真去问服务器"这条断言假绿
  invalidateRemoteCarapaceCache(7);
});

describe('applyCarapaceChanged', () => {
  it('重新问服务器并按结果写状态（先 checking 再落定，界面不留空档）', async () => {
    answerCheck(true);
    const handled = await applyCarapaceChanged({ sessionId: 7 });
    expect(handled).toBe(true);
    expect(m.states['s-1']).toBe('installed');
    // 检测命令真的发出去了，不是只改了字段
    const checked = m.invoke.mock.calls.filter(
      ([cmd, args]) =>
        cmd === 'ssh_command' && String((args as Record<string, unknown>)?.command).includes('command -v'),
    );
    expect(checked.length).toBe(1);
  });

  it('这一窗没有对应会话时安静忽略（别的窗建的连接不越界改别人的状态）', async () => {
    answerCheck(true);
    m.sessions = [{ id: 's-9', rustSessionId: 11 }];
    expect(await applyCarapaceChanged({ sessionId: 7 })).toBe(false);
    expect(m.states['s-9']).toBeUndefined();
  });

  it('探测期间会话断开 ⇒ 不把已清掉的状态写回来', async () => {
    m.invoke.mockImplementation(() => {
      // 模拟断开：会话表清空、该会话的状态也被清掉
      m.sessions = [];
      delete m.states['s-1'];
      return Promise.resolve({
        ok: true,
        output: '__TDSF_CARAPACE_YES__',
        stderr: '',
        exitCode: 0,
        duration: 0.1,
      });
    });
    const handled = await applyCarapaceChanged({ sessionId: 7 });
    expect(handled).toBe(true); // 一开始认领到了这条会话
    expect(m.states['s-1']).toBeUndefined(); // 但结果不复活它
  });
});
