import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ probeRemoteCarapace: vi.fn() }));

vi.mock('@/lib/param-complete-client', () => ({
  fetchRemoteCommands: vi.fn(),
  fetchRemoteOsInfo: vi.fn(),
  probeRemoteCarapace: mocks.probeRemoteCarapace,
}));
vi.mock('@/modules/settings/preferences', () => ({
  usePreferencesStore: { getState: () => ({ sshRemoteCarapacePrompt: true }) },
}));

import { useSshStore, type SshSessionInfo } from './sshStore';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function session(rustSessionId: number): SshSessionInfo {
  return {
    id: 'front-1',
    rustSessionId,
    params: { host: 'example.invalid', port: 22, user: 'tester', cols: 80, rows: 24, term: 'xterm' },
    state: 'connected',
    connectedAt: 1,
    handle: null,
  };
}

function reset(sessionList: SshSessionInfo[] = [session(7)]) {
  useSshStore.setState({
    sessions: sessionList,
    activeSessionId: sessionList[0]?.id ?? null,
    remoteCarapaceBySession: {},
  });
  mocks.probeRemoteCarapace.mockReset();
}

beforeEach(() => reset());

describe('detectRemoteCarapace lifecycle ownership', () => {
  it('does not replace a newer installed state with its late missing reply', async () => {
    const probe = deferred<'installed' | 'missing'>();
    mocks.probeRemoteCarapace.mockReturnValue(probe.promise);
    const request = useSshStore.getState().detectRemoteCarapace('front-1');
    await vi.waitFor(() => expect(mocks.probeRemoteCarapace).toHaveBeenCalledWith(7));
    expect(useSshStore.getState().remoteCarapaceBySession['front-1']).toBe('checking');

    useSshStore.getState().setRemoteCarapaceState('front-1', 'installed');
    probe.resolve('missing');
    await request;

    expect(useSshStore.getState().remoteCarapaceBySession['front-1']).toBe('installed');
  });

  it('does not let session 7 write after the frontend id has moved to Rust session 8', async () => {
    const probe = deferred<'installed' | 'missing'>();
    mocks.probeRemoteCarapace.mockReturnValue(probe.promise);
    const request = useSshStore.getState().detectRemoteCarapace('front-1');
    await vi.waitFor(() => expect(mocks.probeRemoteCarapace).toHaveBeenCalledWith(7));

    useSshStore.setState({ sessions: [session(8)] });
    useSshStore.getState().setRemoteCarapaceState('front-1', 'checking');
    probe.resolve('missing');
    await request;

    expect(useSshStore.getState().remoteCarapaceBySession['front-1']).toBe('checking');
    expect(mocks.probeRemoteCarapace).toHaveBeenCalledWith(7);
  });

  it('writes a normal missing result and keeps installed results supported', async () => {
    mocks.probeRemoteCarapace.mockResolvedValueOnce('missing');
    await useSshStore.getState().detectRemoteCarapace('front-1');
    expect(useSshStore.getState().remoteCarapaceBySession['front-1']).toBe('missing');

    reset([session(8)]);
    mocks.probeRemoteCarapace.mockResolvedValueOnce('installed');
    await useSshStore.getState().detectRemoteCarapace('front-1');
    expect(useSshStore.getState().remoteCarapaceBySession['front-1']).toBe('installed');
  });

  it('does not restore state after the session is removed during detection', async () => {
    const probe = deferred<'installed' | 'missing'>();
    mocks.probeRemoteCarapace.mockReturnValue(probe.promise);
    const request = useSshStore.getState().detectRemoteCarapace('front-1');
    await vi.waitFor(() => expect(mocks.probeRemoteCarapace).toHaveBeenCalledWith(7));
    expect(useSshStore.getState().remoteCarapaceBySession['front-1']).toBe('checking');
    useSshStore.setState({ sessions: [], activeSessionId: null, remoteCarapaceBySession: {} });
    probe.resolve('installed');
    await request;
    expect(useSshStore.getState().remoteCarapaceBySession['front-1']).toBeUndefined();
  });
});
