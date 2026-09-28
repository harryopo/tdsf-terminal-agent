/**
 * remoteCarapaceAdmin.test.ts — 设置页那块「远端补全组件」入口的逻辑
 * -----------------------------------------------------------------------------
 * 覆盖：
 *   1. pickCarapaceTargets：只认 connected、同机去重留最小会话号、异机都留
 *   2. listCarapaceTargets：超时 / IPC 抛错都降级成一句真话，不炸界面
 *   3. probeCarapaceTarget：已装 / 未装 / 测不出来三态分得开（-1 归"测不出来"）
 *   4. installCarapaceTarget：真走既有四步链（顺序可见）、成功发跨窗事件、
 *      并让缓存失效（装完再问要落到服务器，不是落到内存）
 *   5. installCarapaceTarget 失败：原因原文带出，且**不**发事件
 *
 * Mock 策略：只 mock Tauri 运行时（invoke/emit），让 param-complete-client 与
 * ssh-bridge 的真实实现继续跑 —— 这条链的承重正好在"有没有接对既有那四步"。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  /** invoke 调用序列（含参数摘要），用于断言顺序 */
  calls: [] as string[],
  detail: [] as unknown[],
  /** 'command -v' 那次探测的返回形态 */
  checkMark: true,
  checkExit: 0,
  checkThrows: false,
  chmodExit: 0,
  hangDetail: false,
  detailThrows: false,
  emitThrows: false,
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn((cmd: string, args?: Record<string, unknown>) => {
    state.calls.push(cmd);
    if (cmd === 'ssh_sessions_detail') {
      if (state.hangDetail) return new Promise(() => {});
      if (state.detailThrows) return Promise.reject(new Error('命令未注册'));
      return Promise.resolve(state.detail);
    }
    if (cmd === 'ssh_command') {
      const command = String(args?.command ?? '');
      state.calls.push(`ssh_command::${command}`);
      if (command.includes('command -v')) {
        if (state.checkThrows) return Promise.reject(new Error('会话已断开'));
        return Promise.resolve({
          ok: true,
          output: state.checkMark ? '__TDSF_CARAPACE_YES__\n' : '',
          stderr: '',
          exitCode: state.checkExit,
          duration: 0.1,
        });
      }
      if (command.includes('mkdir -p')) {
        state.calls.push('mkdir');
        return Promise.resolve({
          ok: true,
          output: '__TDSF_HOME__/root',
          stderr: '',
          exitCode: 0,
          duration: 0.1,
        });
      }
      if (command.includes('chmod +x')) {
        state.calls.push('chmod');
        return Promise.resolve({
          ok: true,
          output: '',
          stderr: state.chmodExit === 0 ? '' : 'Permission denied',
          exitCode: state.chmodExit,
          duration: 0.1,
        });
      }
      return Promise.resolve({
        ok: true,
        output: '',
        stderr: '',
        exitCode: 0,
        duration: 0.1,
      });
    }
    if (cmd === 'carapace_linux_path') {
      state.calls.push('linux-path');
      return Promise.resolve('C:\\app\\bin\\carapace-linux-amd64');
    }
    if (cmd === 'sftp_upload_file') {
      state.calls.push('upload');
      return Promise.resolve(81_000_000);
    }
    return Promise.resolve(null);
  }),
  Channel: class {},
}));

const emitMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/event', () => ({
  emit: emitMock,
  listen: vi.fn(() => Promise.resolve(() => undefined)),
}));

import {
  CARAPACE_CHECK_CMD,
  invalidateRemoteCarapaceCache,
  remoteCarapaceInstalled,
} from '@/lib/param-complete-client';
import { CARAPACE_CHANGED_EVENT } from '@/lib/sshCarapaceEvents';
import {
  installCarapaceTarget,
  listCarapaceTargets,
  pickCarapaceTargets,
  probeCarapaceTarget,
} from './remoteCarapaceAdmin';

function detail(
  sessionId: number,
  host: string,
  stateValue: string,
  user = 'root',
  port = 22,
) {
  return { sessionId, host, port, user, state: stateValue, ownerWindow: 'main' };
}

beforeEach(() => {
  state.calls = [];
  state.detail = [];
  state.checkMark = true;
  state.checkExit = 0;
  state.checkThrows = false;
  state.chmodExit = 0;
  state.hangDetail = false;
  state.detailThrows = false;
  state.emitThrows = false;
  emitMock.mockReset();
  emitMock.mockResolvedValue(undefined);
  invalidateRemoteCarapaceCache(7);
});

describe('pickCarapaceTargets', () => {
  it('只认已连上的会话（正向配对：connected 那条必须在）', () => {
    state.detail = [
      detail(1, '10.0.0.1', 'connected'),
      detail(2, '10.0.0.2', 'connecting'),
      detail(3, '10.0.0.3', 'closed'),
      detail(4, '10.0.0.4', 'failed'),
    ];
    const got = pickCarapaceTargets(state.detail as never);
    expect(got.map((t) => t.sessionId)).toEqual([1]);
    expect(got[0].label).toBe('root@10.0.0.1:22');
  });

  it('同一台服务器的多条会话（#89 之后一个标签页一条）只留一行', () => {
    const got = pickCarapaceTargets([
      detail(9, '10.0.0.1', 'connected'),
      detail(7, '10.0.0.1', 'connected'),
      detail(11, '10.0.0.1', 'connected'),
    ] as never);
    expect(got).toEqual([{ sessionId: 7, label: 'root@10.0.0.1:22' }]);
  });

  it('不同服务器各自一行，按会话号升序（不许被去重误伤）', () => {
    const got = pickCarapaceTargets([
      detail(5, '10.0.0.9', 'connected', 'ops'),
      detail(2, '10.0.0.8', 'connected'),
    ] as never);
    expect(got).toEqual([
      { sessionId: 2, label: 'root@10.0.0.8:22' },
      { sessionId: 5, label: 'ops@10.0.0.9:22' },
    ]);
  });
});

describe('listCarapaceTargets', () => {
  it('IPC 挂起时超时返回一句真话，不抛错也不永远等', async () => {
    state.hangDetail = true;
    const got = await listCarapaceTargets(10);
    expect(got.targets).toEqual([]);
    expect(got.error).toContain('超时');
  });

  it('IPC 抛错时降级成错误文案（界面不能因此整块消失）', async () => {
    state.detailThrows = true;
    const got = await listCarapaceTargets(50);
    expect(got.targets).toEqual([]);
    expect(got.error).toContain('命令未注册');
  });

  it('没有服务器可装时是空列表、不是错误（否则文案会说成"查询失败"）', async () => {
    state.detail = [];
    const got = await listCarapaceTargets();
    expect(got.targets).toEqual([]);
    expect(got.error).toBeUndefined();
  });

  it('拿到列表后按存在性去重（端到端走 invoke 那一条路）', async () => {
    state.detail = [
      detail(3, '10.0.0.1', 'connected'),
      detail(4, '10.0.0.1', 'connected'),
    ];
    const got = await listCarapaceTargets();
    expect(got.targets).toEqual([{ sessionId: 3, label: 'root@10.0.0.1:22' }]);
    expect(state.calls).toContain('ssh_sessions_detail');
  });
});

describe('probeCarapaceTarget', () => {
  it('有标记 = 已安装', async () => {
    state.checkMark = true;
    expect(await probeCarapaceTarget(7)).toEqual({ state: 'installed' });
  });

  it('链路正常、拿到退出码、没标记 = 未安装', async () => {
    state.checkMark = false;
    state.checkExit = 1;
    expect(await probeCarapaceTarget(7)).toEqual({ state: 'missing' });
  });

  it('没收到退出状态（-1）算"测不出来"，不许冒充"未安装"', async () => {
    state.checkMark = false;
    state.checkExit = -1;
    const got = await probeCarapaceTarget(7);
    expect(got.state).toBe('error');
    expect(got.detail).toBeTruthy();
  });

  it('invoke 抛错时把原因原文带出来', async () => {
    state.checkThrows = true;
    const got = await probeCarapaceTarget(7);
    expect(got.state).toBe('error');
    expect(got.detail).toContain('会话已断开');
  });
});

describe('installCarapaceTarget', () => {
  it('成功走既有四步链（建目录→取路径→上传→chmod 验证），并发一次跨窗事件', async () => {
    const stages: string[] = [];
    const got = await installCarapaceTarget(7, (s) => stages.push(s));
    expect(got.ok).toBe(true);
    // 顺序：mkdir 先于上传（SFTP 传不进不存在的目录），chmod 验证最后
    const order = state.calls.join(' > ');
    expect(order).toMatch(/mkdir.*upload.*chmod/);
    expect(order).toContain('linux-path');
    expect(stages).toEqual(['preparing', 'uploading', 'configuring', 'done']);
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(CARAPACE_CHANGED_EVENT, {
      sessionId: 7,
    });
  });

  it('探测用的是既有那条命令模板（不另抄一份路径）', async () => {
    await probeCarapaceTarget(7);
    expect(state.calls).toContain(`ssh_command::${CARAPACE_CHECK_CMD}`);
  });

  it('装完再问落到服务器（四步链第 4 步负责失效缓存，本层不重复做）', async () => {
    state.checkMark = true;
    expect(await remoteCarapaceInstalled(7)).toBe(true);
    // 反向确认缓存真的在工作（否则这条判据什么都没测）
    state.checkMark = false;
    expect(await remoteCarapaceInstalled(7)).toBe(true);
    state.chmodExit = 0;
    await installCarapaceTarget(7);
    expect(await remoteCarapaceInstalled(7)).toBe(false);
  });

  it('chmod 失败：原因原文带出、不发跨窗事件', async () => {
    state.chmodExit = 1;
    const got = await installCarapaceTarget(7);
    expect(got.ok).toBe(false);
    expect(got.message).toContain('Permission denied');
    expect(got.message).toContain('退出码 1');
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('发通知失败不算安装失败（服务器上确实装好了，只是主窗暂时不知道）', async () => {
    emitMock.mockRejectedValue(new Error('窗口不存在'));
    const got = await installCarapaceTarget(7);
    expect(got.ok).toBe(true);
  });
});
