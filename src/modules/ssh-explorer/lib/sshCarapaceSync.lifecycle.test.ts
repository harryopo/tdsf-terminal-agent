import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  invoke: vi.fn(),
  sessions: [] as Array<{ id: string; rustSessionId: number | null }>,
  states: {} as Record<string, string>,
}));

vi.mock('@tauri-apps/api/core', () => ({ invoke: m.invoke, Channel: class {} }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(() => Promise.resolve(() => undefined)) }));
vi.mock('../sshStore', () => ({
  useSshStore: {
    getState: () => ({
      sessions: m.sessions,
      remoteCarapaceBySession: m.states,
      setRemoteCarapaceState: (id: string, state: string) => { m.states[id] = state; },
    }),
  },
}));

import { applyCarapaceChanged } from './sshCarapaceSync';
import { invalidateRemoteCarapaceCache } from '@/lib/param-complete-client';
import { CARAPACE_CHECK_CMD, CARAPACE_YES_MARK } from '@/lib/param-complete-client';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function result(installed: boolean) {
  return {
    ok: true,
    output: installed ? `${CARAPACE_YES_MARK}\n` : '',
    stderr: '',
    exitCode: installed ? 0 : 1,
    duration: 0.01,
  };
}

beforeEach(() => {
  m.invoke.mockReset();
  m.sessions = [{ id: 'front-1', rustSessionId: 7 }];
  m.states = {};
  [7, 8].forEach(invalidateRemoteCarapaceCache);
});

describe('applyCarapaceChanged lifecycle ownership', () => {
  it.each([
    ['same Rust session', 7],
    ['Rust session changes from 7 to 8', 8],
  ])(
    'an old missing reply cannot overwrite a newer installed result when %s',
    async (_label, newerRustSessionId) => {
      const old = deferred<ReturnType<typeof result>>();
      const fresh = deferred<ReturnType<typeof result>>();
      m.invoke.mockImplementation((_cmd: string, args?: { command?: string }) =>
        args?.command === CARAPACE_CHECK_CMD
          ? (m.invoke.mock.calls.length === 1 ? old.promise : fresh.promise)
          : Promise.reject(new Error('unexpected invoke')),
      );

      const oldRequest = applyCarapaceChanged({ sessionId: 7 });
      await Promise.resolve();
      if (newerRustSessionId !== 7) m.sessions = [{ id: 'front-1', rustSessionId: newerRustSessionId }];
      const newRequest = applyCarapaceChanged({ sessionId: newerRustSessionId });
      await Promise.resolve();
      fresh.resolve(result(true));
      await expect(newRequest).resolves.toBe(true);
      old.resolve(result(false));
      await expect(oldRequest).resolves.toBe(true);

      expect(m.states['front-1']).toBe('installed');
    },
  );

  it('keeps the latest probe checking when an older missing reply arrives first', async () => {
    const old = deferred<ReturnType<typeof result>>();
    const fresh = deferred<ReturnType<typeof result>>();
    m.invoke.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const oldRequest = applyCarapaceChanged({ sessionId: 7 });
    const newRequest = applyCarapaceChanged({ sessionId: 7 });
    expect(m.invoke).toHaveBeenCalledTimes(2);
    expect(m.states['front-1']).toBe('checking');

    old.resolve(result(false));
    await oldRequest;
    expect(m.states['front-1']).toBe('checking');
    fresh.resolve(result(true));
    await newRequest;
    expect(m.states['front-1']).toBe('installed');
  });

  it('does not restore state after its frontend session disappears during the probe', async () => {
    const pending = deferred<ReturnType<typeof result>>();
    m.invoke.mockReturnValue(pending.promise);
    const request = applyCarapaceChanged({ sessionId: 7 });
    await Promise.resolve();
    m.sessions = [];
    delete m.states['front-1'];
    pending.resolve(result(true));
    await expect(request).resolves.toBe(true);
    expect(m.states['front-1']).toBeUndefined();
  });

  it('keeps a badge-installed state when its older missing probe returns', async () => {
    const pending = deferred<ReturnType<typeof result>>();
    m.invoke.mockReturnValue(pending.promise);
    const request = applyCarapaceChanged({ sessionId: 7 });
    await vi.waitFor(() => expect(m.invoke).toHaveBeenCalledTimes(1));
    expect(m.states['front-1']).toBe('checking');

    m.states['front-1'] = 'installed';
    pending.resolve(result(false));
    await expect(request).resolves.toBe(true);

    expect(m.states['front-1']).toBe('installed');
  });

  it('still writes missing for a normal confirmed missing result', async () => {
    m.invoke.mockResolvedValue(result(false));
    await expect(applyCarapaceChanged({ sessionId: 7 })).resolves.toBe(true);
    expect(m.states['front-1']).toBe('missing');
  });
});
