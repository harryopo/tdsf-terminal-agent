import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const target = { sessionId: 7, label: 'root@example.test:22' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

beforeEach(() => {
  vi.mocked(listCarapaceTargets).mockReset();
  vi.mocked(probeCarapaceTarget).mockReset();
  vi.mocked(installCarapaceTarget).mockReset();
});

describe('RemoteCarapaceCard lifecycle', () => {
  it('starts with refresh guidance and does not query until requested', () => {
    render(<RemoteCarapaceCard />);
    expect(screen.queryByTestId('carapace-empty')).toBeNull();
    expect(screen.getByRole('button', { name: '刷新' })).toBeTruthy();
    expect(screen.getByText(/点击刷新/)).toBeTruthy();
    expect(listCarapaceTargets).not.toHaveBeenCalled();
  });

  it('shows querying instead of an empty state while the list is pending', async () => {
    const listing = deferred<{ targets: typeof target[] }>();
    vi.mocked(listCarapaceTargets).mockReturnValue(listing.promise);
    render(<RemoteCarapaceCard />);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(screen.getByRole('button', { name: '查询中…' })).toBeTruthy();
    expect(screen.queryByTestId('carapace-empty')).toBeNull();
    await act(async () => {
      listing.resolve({ targets: [] });
      await listing.promise;
    });
    expect(await screen.findByTestId('carapace-empty')).toBeTruthy();
  });

  it('ignores a late probe from the previous refresh', async () => {
    const oldProbe = deferred<{ state: 'missing' | 'error'; detail?: string }>();
    vi.mocked(listCarapaceTargets)
      .mockResolvedValueOnce({ targets: [target] })
      .mockResolvedValueOnce({ targets: [target] });
    vi.mocked(probeCarapaceTarget)
      .mockReturnValueOnce(oldProbe.promise)
      .mockResolvedValueOnce({ state: 'installed' });
    render(<RemoteCarapaceCard />);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(probeCarapaceTarget).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(await screen.findByText('已安装')).toBeTruthy();
    await act(async () => {
      oldProbe.resolve({ state: 'missing' });
      await oldProbe.promise;
    });
    expect(screen.getByTestId('carapace-row-status').textContent).toBe('已安装');
  });

  it('does not restore a target removed by a newer refresh', async () => {
    const removedProbe = deferred<{ state: 'missing' }>();
    vi.mocked(listCarapaceTargets)
      .mockResolvedValueOnce({ targets: [target] })
      .mockResolvedValueOnce({ targets: [] });
    vi.mocked(probeCarapaceTarget).mockReturnValueOnce(removedProbe.promise);
    render(<RemoteCarapaceCard />);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(probeCarapaceTarget).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(await screen.findByTestId('carapace-empty')).toBeTruthy();
    await act(async () => {
      removedProbe.resolve({ state: 'missing' });
      await removedProbe.promise;
    });
    expect(screen.queryByTestId('carapace-row')).toBeNull();
  });

  it('keeps installation locked through refresh and does not start a second install', async () => {
    const installing = deferred<{ ok: boolean; message: string }>();
    vi.mocked(listCarapaceTargets)
      .mockResolvedValueOnce({ targets: [target] })
      .mockResolvedValue({ targets: [target] });
    vi.mocked(probeCarapaceTarget).mockResolvedValue({ state: 'missing' });
    vi.mocked(installCarapaceTarget).mockReturnValue(installing.promise);
    render(<RemoteCarapaceCard />);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    fireEvent.click(await screen.findByTestId('carapace-install'));
    await waitFor(() => expect(installCarapaceTarget).toHaveBeenCalledTimes(1));
    expect((screen.getByRole('button', { name: '刷新' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(listCarapaceTargets).toHaveBeenCalledTimes(1);
    expect((screen.getByTestId('carapace-install') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('carapace-install'));
    expect(installCarapaceTarget).toHaveBeenCalledTimes(1);
    await act(async () => {
      installing.resolve({ ok: true, message: '已装好' });
      await installing.promise;
    });
    expect(await screen.findByText('已安装')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(listCarapaceTargets).toHaveBeenCalledTimes(2));
  });

  it('does not let an old instance update a newly mounted card', async () => {
    const oldProbe = deferred<{ state: 'missing' }>();
    vi.mocked(listCarapaceTargets)
      .mockResolvedValueOnce({ targets: [target] })
      .mockResolvedValueOnce({ targets: [] });
    vi.mocked(probeCarapaceTarget).mockReturnValueOnce(oldProbe.promise);
    const first = render(<RemoteCarapaceCard />);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    await waitFor(() => expect(probeCarapaceTarget).toHaveBeenCalledTimes(1));
    first.unmount();
    render(<RemoteCarapaceCard />);
    fireEvent.click(screen.getByRole('button', { name: '刷新' }));
    expect(await screen.findByTestId('carapace-empty')).toBeTruthy();
    await act(async () => {
      oldProbe.resolve({ state: 'missing' });
      await oldProbe.promise;
    });
    expect(screen.queryByTestId('carapace-row')).toBeNull();
    expect(screen.getByTestId('carapace-empty')).toBeTruthy();
  });
});
