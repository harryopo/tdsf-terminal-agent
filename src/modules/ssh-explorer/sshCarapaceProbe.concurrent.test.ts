import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CARAPACE_CHECK_CMD,
  CARAPACE_YES_MARK,
  invalidateRemoteCarapaceCache,
  remoteCarapaceInstalled,
} from '@/lib/param-complete-client';
import type { SshCommandResult } from '@/lib/ssh-bridge';
import { usePreferencesStore } from '@/modules/settings/preferences';
import { applyCarapaceChanged } from './lib/sshCarapaceSync';
import { useSshStore, type SshSessionInfo } from './sshStore';

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  calls: [] as Array<{ command: string; args?: Record<string, unknown> }>,
  pending: [] as Array<Deferred<SshCommandResult>>,
  running: [] as Promise<unknown>[],
}));

vi.mock('@tauri-apps/api/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tauri-apps/api/core')>();
  return { ...actual, invoke: ipc.invoke };
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const sessionA = 'probe-concurrent-a';
const sessionB = 'probe-concurrent-b';
const rustA = 71;
const rustB = 72;
const allRustSessionIds = [rustA, rustB];

function session(id: string, rustSessionId: number): SshSessionInfo {
  return {
    id,
    rustSessionId,
    params: { host: 'fixture.invalid', port: 22, user: 'fixture', cols: 80, rows: 24, term: 'xterm-256color' },
    state: 'connected',
    connectedAt: 1,
    handle: null,
  };
}

function result(state: 'installed' | 'missing'): SshCommandResult {
  return state === 'installed'
    ? { ok: true, exitCode: 0, stderr: '', output: `${CARAPACE_YES_MARK}\n`, duration: 0.1 }
    : { ok: true, exitCode: 1, stderr: '', output: '', duration: 0.1 };
}

let savedPreferences: ReturnType<typeof usePreferencesStore.getState>;
let savedSshState: ReturnType<typeof useSshStore.getState>;

function resetFixture(sessions = [session(sessionA, rustA)]) {
  for (const rustSessionId of allRustSessionIds) invalidateRemoteCarapaceCache(rustSessionId);
  ipc.calls.length = 0;
  ipc.pending.length = 0;
  ipc.running.length = 0;
  ipc.invoke.mockReset().mockImplementation((command: string, args?: Record<string, unknown>) => {
    ipc.calls.push({ command, args });
    if (command !== 'ssh_command' || args?.command !== CARAPACE_CHECK_CMD) {
      throw new Error(`Unexpected RPC: ${command}`);
    }
    const request = deferred<SshCommandResult>();
    ipc.pending.push(request);
    return request.promise;
  });
  useSshStore.setState({
    sessions,
    activeSessionId: sessions[0]?.id ?? null,
    remoteCarapaceBySession: {},
  });
}

async function waitForProbeCount(count: number) {
  await vi.waitFor(() => expect(ipc.calls).toHaveLength(count));
  expect(ipc.calls.every(({ command, args }) =>
    command === 'ssh_command' && args?.command === CARAPACE_CHECK_CMD,
  )).toBe(true);
}

async function startInitial(id = sessionA) {
  const count = ipc.calls.length + 1;
  const request = useSshStore.getState().detectRemoteCarapace(id);
  ipc.running.push(request);
  await waitForProbeCount(count);
  return { done: request };
}

async function startRefresh(rustSessionId = rustA) {
  const count = ipc.calls.length + 1;
  const request = applyCarapaceChanged({ sessionId: rustSessionId });
  ipc.running.push(request);
  await waitForProbeCount(count);
  return { done: request };
}

beforeEach(() => {
  savedPreferences = usePreferencesStore.getState();
  savedSshState = useSshStore.getState();
  usePreferencesStore.setState({ ...savedPreferences, sshRemoteCarapacePrompt: true });
  resetFixture();
});

afterEach(async () => {
  for (const pending of ipc.pending) pending.resolve(result('missing'));
  await Promise.allSettled(ipc.running);
  for (const rustSessionId of allRustSessionIds) invalidateRemoteCarapaceCache(rustSessionId);
  usePreferencesStore.setState(savedPreferences, true);
  useSshStore.setState(savedSshState, true);
  ipc.calls.length = 0;
  ipc.pending.length = 0;
  ipc.running.length = 0;
  ipc.invoke.mockReset();
});

describe('concurrent initial and refreshed remote carapace probes', () => {
  it.each([
    ['missing', 'missing'],
    ['missing', 'installed'],
    ['installed', 'missing'],
    ['installed', 'installed'],
    ['error', 'missing'],
    ['error', 'installed'],
  ] as const)('does not let an older initial %s result end a newer %s refresh', async (oldState, freshState) => {
    const warn = oldState === 'error'
      ? vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      : undefined;
    try {
      const initial = await startInitial();
      const refresh = await startRefresh();
      expect(useSshStore.getState().remoteCarapaceBySession[sessionA]).toBe('checking');

      if (oldState === 'error') ipc.pending[0]!.reject(new Error('fixture transport failure'));
      else ipc.pending[0]!.resolve(result(oldState));
      await initial.done;
      expect(useSshStore.getState().remoteCarapaceBySession[sessionA]).toBe('checking');

      ipc.pending[1]!.resolve(result(freshState));
      await refresh.done;
      expect(useSshStore.getState().remoteCarapaceBySession[sessionA]).toBe(freshState);
      await expect(remoteCarapaceInstalled(rustA)).resolves.toBe(freshState === 'installed');
      expect(ipc.calls).toHaveLength(2);
    } finally {
      warn?.mockRestore();
    }
  });

  it('keeps a newer installed result when the older initial missing result arrives last', async () => {
    const initial = await startInitial();
    const refresh = await startRefresh();
    ipc.pending[1]!.resolve(result('installed'));
    await refresh.done;
    ipc.pending[0]!.resolve(result('missing'));
    await initial.done;
    expect(useSshStore.getState().remoteCarapaceBySession[sessionA]).toBe('installed');
  });

  it.each(['missing', 'installed'] as const)('keeps the ordinary unopposed %s result', async (state) => {
    const initial = await startInitial();
    ipc.pending[0]!.resolve(result(state));
    await initial.done;
    expect(useSshStore.getState().remoteCarapaceBySession[sessionA]).toBe(state);
    expect(ipc.calls).toHaveLength(1);
  });

  it('keeps another session initial probe independent of a refresh for session A', async () => {
    resetFixture([session(sessionA, rustA), session(sessionB, rustB)]);
    const initialA = await startInitial(sessionA);
    const initialB = await startInitial(sessionB);
    const refreshA = await startRefresh(rustA);

    ipc.pending[0]!.resolve(result('missing'));
    await initialA.done;
    expect(useSshStore.getState().remoteCarapaceBySession[sessionA]).toBe('checking');
    ipc.pending[2]!.resolve(result('installed'));
    await refreshA.done;
    ipc.pending[1]!.resolve(result('missing'));
    await initialB.done;

    expect(useSshStore.getState().remoteCarapaceBySession[sessionA]).toBe('installed');
    expect(useSshStore.getState().remoteCarapaceBySession[sessionB]).toBe('missing');
    expect(ipc.calls.map(({ args }) => args?.sessionId)).toEqual([rustA, rustB, rustA]);
    expect(ipc.calls).toHaveLength(3);
  });

  it('does not restore state after the probed session is removed', async () => {
    const initial = await startInitial();
    useSshStore.setState({ sessions: [], activeSessionId: null, remoteCarapaceBySession: {} });
    ipc.pending[0]!.resolve(result('installed'));
    await initial.done;
    expect(useSshStore.getState().remoteCarapaceBySession[sessionA]).toBeUndefined();
  });

  it('keeps the latest of two refreshes when initial and older refresh results arrive first', async () => {
    const initial = await startInitial();
    const firstRefresh = await startRefresh();
    const latestRefresh = await startRefresh();
    expect(useSshStore.getState().remoteCarapaceBySession[sessionA]).toBe('checking');

    ipc.pending[0]!.resolve(result('missing'));
    await initial.done;
    ipc.pending[1]!.resolve(result('missing'));
    await firstRefresh.done;
    expect(useSshStore.getState().remoteCarapaceBySession[sessionA]).toBe('checking');

    ipc.pending[2]!.resolve(result('installed'));
    await latestRefresh.done;
    expect(useSshStore.getState().remoteCarapaceBySession[sessionA]).toBe('installed');
    expect(ipc.calls).toHaveLength(3);
  });
});
