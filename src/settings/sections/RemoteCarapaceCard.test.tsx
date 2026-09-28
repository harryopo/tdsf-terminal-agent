/**
 * RemoteCarapaceCard.test.tsx — 设置页那张卡片的可见行为
 * -----------------------------------------------------------------------------
 * 用户这次的反馈是"找不到入口 / 装失败不知道怎么了"，所以判据按**他看得见的东西**写：
 *   1. 空态要说"现在没有正连着的服务器"并给出下一步（不能一片空白）；
 *   2. 查询失败不许说成"没有服务器"（#118/#123 同族：两个原因糊成一句）；
 *   3. 每一行的状态要能看，未装的那行能点装；
 *   4. 上传那一档要写出体积在等什么；
 *   5. 失败原因原文出现在那一行，不是"安装失败"三个字。
 *
 * 逻辑层整体 mock —— 这里测的是渲染与接线，链路本身由 remoteCarapaceAdmin.test.ts 管。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RemoteCarapaceCard } from './RemoteCarapaceCard';
import {
  installCarapaceTarget,
  listCarapaceTargets,
  probeCarapaceTarget,
} from '@/settings/lib/remoteCarapaceAdmin';

vi.mock('@/settings/lib/remoteCarapaceAdmin', () => ({
  CARAPACE_BINARY_MB: 80,
  listCarapaceTargets: vi.fn(),
  probeCarapaceTarget: vi.fn(),
  installCarapaceTarget: vi.fn(),
}));

const TARGETS = [
  { sessionId: 3, label: 'root@192.168.45.128:22' },
  { sessionId: 5, label: 'ops@10.0.0.9:22' },
];

beforeEach(() => {
  vi.mocked(listCarapaceTargets).mockReset();
  vi.mocked(probeCarapaceTarget).mockReset();
  vi.mocked(installCarapaceTarget).mockReset();
});

describe('RemoteCarapaceCard', () => {
  it('空列表给的是"没有服务器 + 下一步"，不是一片空白', async () => {
    vi.mocked(listCarapaceTargets).mockResolvedValue({ targets: [] });
    render(<RemoteCarapaceCard />);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    const empty = await screen.findByTestId('carapace-empty');
    expect(empty.textContent).toContain('先连上一台');
  });

  it('查询失败不许讲成"没有服务器"（两个原因是两句话）', async () => {
    vi.mocked(listCarapaceTargets).mockResolvedValue({
      targets: [],
      error: '没拿到会话列表（查询超时），请稍后再点一次刷新',
    });
    render(<RemoteCarapaceCard />);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    const err = await screen.findByTestId('carapace-list-error');
    expect(err.textContent).toContain('超时');
    expect(screen.queryByTestId('carapace-empty')).toBeNull();
  });

  it('逐行列出服务器与各自状态，只有未装的那行能点装', async () => {
    vi.mocked(listCarapaceTargets).mockResolvedValue({ targets: TARGETS });
    vi.mocked(probeCarapaceTarget).mockImplementation(async (id: number) =>
      id === 3 ? { state: 'installed' } : { state: 'missing' },
    );
    render(<RemoteCarapaceCard />);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));

    const rows = await screen.findAllByTestId('carapace-row');
    expect(rows).toHaveLength(2);
    expect(await screen.findByText('root@192.168.45.128:22')).toBeTruthy();
    await waitFor(() =>
      expect(
        screen.getAllByTestId('carapace-row-status').map((n) => n.textContent),
      ).toEqual(['已安装', '未安装']),
    );
    const installButtons = screen.getAllByTestId('carapace-install');
    expect((installButtons[0] as HTMLButtonElement).disabled).toBe(true); // 已装的不能重复点
    expect((installButtons[1] as HTMLButtonElement).disabled).toBe(false);
  });

  it('点安装：先显示上传体积，成功后按钮变成已装好并禁用', async () => {
    vi.mocked(listCarapaceTargets).mockResolvedValue({ targets: [TARGETS[1]] });
    vi.mocked(probeCarapaceTarget).mockResolvedValue({ state: 'missing' });
    vi.mocked(installCarapaceTarget).mockImplementation(
      async (_id, onStage) => {
        onStage?.('uploading');
        return { ok: true, message: '已装好，远端参数补全启用' };
      },
    );
    render(<RemoteCarapaceCard />);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    fireEvent.click(await screen.findByTestId('carapace-install'));

    expect(await screen.findByText(/上传中：约 80 MB/)).toBeTruthy();
    await waitFor(() =>
      expect(
        (screen.getByTestId('carapace-install') as HTMLButtonElement).disabled,
      ).toBe(true),
    );
    expect(screen.getByTestId('carapace-row-status').textContent).toBe('已安装');
    expect(screen.getByTestId('carapace-row-message').textContent).toContain(
      '已装好',
    );
  });

  it('安装失败：原因原文摆出来，并重新问一次服务器', async () => {
    vi.mocked(listCarapaceTargets).mockResolvedValue({ targets: [TARGETS[1]] });
    vi.mocked(probeCarapaceTarget)
      .mockResolvedValueOnce({ state: 'missing' })
      .mockResolvedValueOnce({ state: 'error', detail: 'Permission denied' });
    vi.mocked(installCarapaceTarget).mockResolvedValue({
      ok: false,
      message: '设置可执行权限或验证失败（退出码 1）：Permission denied',
    });
    render(<RemoteCarapaceCard />);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    fireEvent.click(await screen.findByTestId('carapace-install'));

    const errorLine = await screen.findByTestId('carapace-row-error');
    expect(errorLine.textContent ?? '').toContain('Permission denied');
    // 失败后不许留着"未安装"这个假装知道的读数
    await waitFor(() =>
      expect(screen.getByTestId('carapace-row-status').textContent).toContain(
        '检测不出来',
      ),
    );
    expect(probeCarapaceTarget).toHaveBeenCalledTimes(2);
  });
});
