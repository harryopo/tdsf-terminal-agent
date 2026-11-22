import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CARAPACE_CHECK_CMD,
  CARAPACE_CONFIGURE_CMD,
  CARAPACE_MKDIR_CMD,
  CARAPACE_YES_MARK,
  invalidateRemoteCarapaceCache,
  remoteCarapaceInstalled,
} from '@/lib/param-complete-client';
import { PROBE_MARK, type SshCommandResult } from '@/lib/ssh-bridge';
import { CARAPACE_CHANGED_EVENT } from '@/lib/sshCarapaceEvents';
import { usePreferencesStore } from '@/modules/settings/preferences';
import { installCarapaceTarget } from '@/settings/lib/remoteCarapaceAdmin';
import { applyCarapaceChanged, initCarapaceSyncListener } from './lib/sshCarapaceSync';
import { useSshStore, type SshRemoteCarapaceState, type SshSessionInfo } from './sshStore';
import { SshCarapaceBadge } from './SshCarapaceBadge';

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  emit: vi.fn(),
  calls: [] as Array<{ command: string; args?: Record<string, unknown> }>,
  pendingProbes: [] as Array<{ sessionId: number; request: Deferred<SshCommandResult> }>,
  allProbes: [] as Array<Deferred<SshCommandResult>>,
  running: [] as Promise<unknown>[],
  probeAnswers: new Map<number, SshCommandResult | Error>(),
  listeners: [] as Array<(event: { payload: { sessionId: number } }) => unknown>,
  receipts: [] as Promise<unknown>[],
}));

vi.mock('@tauri-apps/api/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tauri-apps/api/core')>();
  return { ...actual, invoke: ipc.invoke };
});

vi.mock('@tauri-apps/api/event', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tauri-apps/api/event')>();
  return {
    ...actual,
    emit: ipc.emit,
    listen: vi.fn((_event: string, listener: (event: { payload: { sessionId: number } }) => unknown) => {
      ipc.listeners.push(listener);
      return Promise.resolve(() => undefined);
    }),
  };
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const sourceId = 'install-source';
const peerId = 'install-peer';
const sourceRustId = 71;
const peerRustId = 72;
const trackedRustIds = [71, 72, 73, 74, 75, 76, 77, 78, 79, 80];

function session(
  id: string,
  rustSessionId: number,
  overrides: Partial<SshSessionInfo> = {},
): SshSessionInfo {
  const { params, ...sessionOverrides } = overrides;
  return {
    id,
    rustSessionId,
    params: {
      host: 'fixture.invalid',
      port: 22,
      user: 'fixture',
      cols: 80,
      rows: 24,
      term: 'xterm-256color',
      ...params,
    },
    state: 'connected',
    connectedAt: 1,
    handle: null,
    ...sessionOverrides,
  };
}

function result(state: 'installed' | 'missing'): SshCommandResult {
  return state === 'installed'
    ? { ok: true, exitCode: 0, stderr: '', output: `${CARAPACE_YES_MARK}\n`, duration: 0.1 }
    : { ok: true, exitCode: 1, stderr: '', output: '', duration: 0.1 };
}

function probeCalls() {
  return ipc.calls.filter(({ command, args }) =>
    command === 'ssh_command' && args?.command === CARAPACE_CHECK_CMD,
  );
}

async function waitForProbeCount(count: number) {
  await waitFor(() => expect(probeCalls().length).toBeGreaterThanOrEqual(count));
}

function startSync(rustSessionId = sourceRustId) {
  const done = applyCarapaceChanged({ sessionId: rustSessionId });
  ipc.running.push(done);
  return { done };
}

function installSetup(sessions: SshSessionInfo[], states: Record<string, SshRemoteCarapaceState>) {
  useSshStore.setState({
    sessions,
    activeSessionId: sessions[0]?.id ?? null,
    remoteCarapaceBySession: states,
  });
}

let savedPreferences: ReturnType<typeof usePreferencesStore.getState>;
let savedSshState: ReturnType<typeof useSshStore.getState>;

beforeEach(() => {
  savedPreferences = usePreferencesStore.getState();
  savedSshState = useSshStore.getState();
  ipc.calls.length = 0;
  ipc.pendingProbes.length = 0;
  ipc.allProbes.length = 0;
  ipc.running.length = 0;
  ipc.probeAnswers.clear();
  ipc.listeners.length = 0;
  ipc.receipts.length = 0;
  ipc.emit.mockReset().mockImplementation((_event: string, payload: { sessionId: number }) => {
    for (const listener of ipc.listeners) ipc.receipts.push(Promise.resolve(listener({ payload })));
    return Promise.resolve(undefined);
  });
  ipc.invoke.mockReset().mockImplementation((command: string, args?: Record<string, unknown>) => {
    ipc.calls.push({ command, args });
    if (command === 'ssh_command' && args?.command === CARAPACE_MKDIR_CMD) {
      return Promise.resolve({ ok: true, exitCode: 0, stderr: '', output: `${PROBE_MARK}\n/home/fixture\n` });
    }
    if (command === 'carapace_linux_path') return Promise.resolve('C:/fixture/carapace-linux-amd64');
    if (command === 'sftp_upload_file') return Promise.resolve(81_000_000);
    if (command === 'ssh_command' && args?.command === CARAPACE_CONFIGURE_CMD) {
      return Promise.resolve({ ok: true, exitCode: 0, stderr: '', output: 'carapace version fixture' });
    }
    if (command === 'ssh_command' && args?.command === CARAPACE_CHECK_CMD) {
      const rustSessionId = Number(args.sessionId);
      const pendingIndex = ipc.pendingProbes.findIndex((item) => item.sessionId === rustSessionId);
      if (pendingIndex >= 0) return ipc.pendingProbes.splice(pendingIndex, 1)[0]!.request.promise;
      const answer = ipc.probeAnswers.get(rustSessionId) ?? result('installed');
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    }
    throw new Error(`Unexpected IPC: ${command}`);
  });
  usePreferencesStore.setState({ ...savedPreferences, sshRemoteCarapacePrompt: true, zoomLevel: 1 });
  installSetup([session(sourceId, sourceRustId)], { [sourceId]: 'missing' });
});

afterEach(async () => {
  cleanup();
  for (const request of ipc.allProbes) request.resolve(result('missing'));
  await Promise.allSettled([...ipc.running, ...ipc.receipts]);
  for (const rustSessionId of trackedRustIds) invalidateRemoteCarapaceCache(rustSessionId);
  usePreferencesStore.setState(savedPreferences, true);
  useSshStore.setState(savedSshState, true);
  ipc.calls.length = 0;
  ipc.pendingProbes.length = 0;
  ipc.allProbes.length = 0;
  ipc.running.length = 0;
  ipc.receipts.length = 0;
  ipc.listeners.length = 0;
});

describe('carapace install notification and same-identity session refresh', () => {
  it('settings install emits once and refreshes source and connected same-identity peer with real probes', async () => {
    installSetup([
      session(sourceId, sourceRustId),
      session(peerId, peerRustId),
      session('closed-peer', 73, { state: 'closed' }),
    ], { [sourceId]: 'missing', [peerId]: 'missing', 'closed-peer': 'missing' });
    ipc.probeAnswers.set(sourceRustId, result('missing'));
    ipc.probeAnswers.set(peerRustId, result('missing'));
    ipc.probeAnswers.set(73, result('missing'));
    await expect(remoteCarapaceInstalled(sourceRustId)).resolves.toBe(false);
    await expect(remoteCarapaceInstalled(peerRustId)).resolves.toBe(false);
    await expect(remoteCarapaceInstalled(73)).resolves.toBe(false);
    ipc.calls.length = 0;
    ipc.probeAnswers.set(sourceRustId, result('installed'));
    ipc.probeAnswers.set(peerRustId, result('installed'));

    initCarapaceSyncListener();
    const installed = await installCarapaceTarget(sourceRustId);
    expect(installed.ok).toBe(true);
    expect(ipc.emit).toHaveBeenCalledTimes(1);
    expect(ipc.emit).toHaveBeenCalledWith(CARAPACE_CHANGED_EVENT, { sessionId: sourceRustId });

    await Promise.all(ipc.receipts);
    expect(useSshStore.getState().remoteCarapaceBySession).toMatchObject({
      [sourceId]: 'installed',
      [peerId]: 'installed',
      'closed-peer': 'missing',
    });
    expect(probeCalls().map(({ args }) => args?.sessionId)).toEqual([sourceRustId, peerRustId]);
    const uploads = ipc.calls.filter(({ command }) => command === 'sftp_upload_file');
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.args?.sessionId).toBe(sourceRustId);
    const callsBeforeCachedReads = probeCalls().length;
    await expect(remoteCarapaceInstalled(sourceRustId)).resolves.toBe(true);
    await expect(remoteCarapaceInstalled(peerRustId)).resolves.toBe(true);
    expect(probeCalls()).toHaveLength(callsBeforeCachedReads);
  });

  it('a real Badge DOM install emits the same one-time change notification', async () => {
    installSetup([session(sourceId, sourceRustId), session(peerId, peerRustId)], {
      [sourceId]: 'missing',
      [peerId]: 'missing',
    });
    initCarapaceSyncListener();
    render(<SshCarapaceBadge sessionId={sourceId} />);
    fireEvent.click(screen.getByTitle('启用远端动态补全'));
    fireEvent.click(screen.getByRole('button', { name: '安装' }));

    await waitFor(() => expect(useSshStore.getState().remoteCarapaceBySession[sourceId]).toBe('installed'));
    await Promise.all(ipc.receipts);
    expect(useSshStore.getState().remoteCarapaceBySession[peerId]).toBe('installed');
    expect(ipc.emit).toHaveBeenCalledTimes(1);
    expect(ipc.emit).toHaveBeenCalledWith(CARAPACE_CHANGED_EVENT, { sessionId: sourceRustId });
    expect(ipc.calls).toHaveLength(6);
    expect(probeCalls().map(({ args }) => args?.sessionId)).toEqual([sourceRustId, peerRustId]);
    const uploads = ipc.calls.filter(({ command }) => command === 'sftp_upload_file');
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.args?.sessionId).toBe(sourceRustId);
  });

  it('does not refresh another host, user, port, or a disconnected same-identity session', async () => {
    installSetup([
      session(sourceId, sourceRustId),
      session('wrong-user', 74, { params: { host: 'fixture.invalid', port: 22, user: 'other', cols: 80, rows: 24, term: 'xterm-256color' } }),
      session('wrong-port', 75, { params: { host: 'fixture.invalid', port: 2200, user: 'fixture', cols: 80, rows: 24, term: 'xterm-256color' } }),
      session('wrong-host', 76, { params: { host: 'other.invalid', port: 22, user: 'fixture', cols: 80, rows: 24, term: 'xterm-256color' } }),
      session('disconnected-peer', 77, { state: 'closed' }),
    ], {
      [sourceId]: 'missing',
      'wrong-user': 'missing',
      'wrong-port': 'missing',
      'wrong-host': 'missing',
      'disconnected-peer': 'missing',
    });
    ipc.probeAnswers.set(sourceRustId, result('installed'));

    await expect(applyCarapaceChanged({ sessionId: sourceRustId })).resolves.toBe(true);

    expect(useSshStore.getState().remoteCarapaceBySession).toEqual({
      [sourceId]: 'installed',
      'wrong-user': 'missing',
      'wrong-port': 'missing',
      'wrong-host': 'missing',
      'disconnected-peer': 'missing',
    });
    expect(probeCalls().map(({ args }) => args?.sessionId)).toEqual([sourceRustId]);
  });

  it('ignores an unknown source session without probing a matching-looking connection', async () => {
    installSetup([session(peerId, peerRustId)], { [peerId]: 'missing' });

    await expect(applyCarapaceChanged({ sessionId: sourceRustId })).resolves.toBe(false);

    expect(useSshStore.getState().remoteCarapaceBySession[peerId]).toBe('missing');
    expect(probeCalls()).toHaveLength(0);
  });

  it.each([
    ['missing', result('missing'), 'missing'],
    ['error', new Error('fixture probe failed'), 'error'],
  ] as const)('preserves each same-identity session probe result when peer is %s', async (_name, peerResult, peerState) => {
    installSetup([session(sourceId, sourceRustId), session(peerId, peerRustId)], {
      [sourceId]: 'missing',
      [peerId]: 'missing',
    });
    ipc.probeAnswers.set(sourceRustId, result('installed'));
    ipc.probeAnswers.set(peerRustId, peerResult);
    const warn = peerResult instanceof Error
      ? vi.spyOn(console, 'warn').mockImplementation(() => undefined)
      : undefined;
    try {
      await expect(applyCarapaceChanged({ sessionId: sourceRustId })).resolves.toBe(true);
      expect(useSshStore.getState().remoteCarapaceBySession).toMatchObject({
        [sourceId]: 'installed',
        [peerId]: peerState,
      });
      expect(probeCalls().map(({ args }) => args?.sessionId)).toEqual([sourceRustId, peerRustId]);
    } finally {
      warn?.mockRestore();
    }
  });

  it('does not restore a removed peer state when its in-flight probe completes', async () => {
    installSetup([session(sourceId, sourceRustId), session(peerId, peerRustId)], {
      [sourceId]: 'missing',
      [peerId]: 'missing',
    });
    const sourceProbe = deferred<SshCommandResult>();
    const peerProbe = deferred<SshCommandResult>();
    ipc.pendingProbes.push(
      { sessionId: sourceRustId, request: sourceProbe },
      { sessionId: peerRustId, request: peerProbe },
    );
    ipc.allProbes.push(sourceProbe, peerProbe);
    const request = startSync();
    await waitForProbeCount(1);
    sourceProbe.resolve(result('installed'));
    await waitForProbeCount(2);

    useSshStore.setState({
      sessions: [session(sourceId, sourceRustId)],
      remoteCarapaceBySession: { [sourceId]: useSshStore.getState().remoteCarapaceBySession[sourceId]! },
    });
    peerProbe.resolve(result('installed'));
    await request.done;

    expect(useSshStore.getState().remoteCarapaceBySession).toEqual({ [sourceId]: 'installed' });
    expect(probeCalls().map(({ args }) => args?.sessionId)).toEqual([sourceRustId, peerRustId]);
  });

  it('does not apply a delayed peer result after that frontend session is rebound', async () => {
    installSetup([session(sourceId, sourceRustId), session(peerId, peerRustId)], {
      [sourceId]: 'missing',
      [peerId]: 'missing',
    });
    const sourceProbe = deferred<SshCommandResult>();
    const peerProbe = deferred<SshCommandResult>();
    ipc.pendingProbes.push(
      { sessionId: sourceRustId, request: sourceProbe },
      { sessionId: peerRustId, request: peerProbe },
    );
    ipc.allProbes.push(sourceProbe, peerProbe);
    const request = startSync();
    await waitForProbeCount(1);
    sourceProbe.resolve(result('installed'));
    await waitForProbeCount(2);

    useSshStore.setState({
      sessions: [
        session(sourceId, sourceRustId),
        session(peerId, 78, { params: { host: 'other.invalid', port: 22, user: 'fixture', cols: 80, rows: 24, term: 'xterm-256color' } }),
      ],
      remoteCarapaceBySession: {
        [sourceId]: useSshStore.getState().remoteCarapaceBySession[sourceId]!,
        [peerId]: 'missing',
      },
    });
    peerProbe.resolve(result('installed'));
    await request.done;

    expect(useSshStore.getState().remoteCarapaceBySession).toEqual({
      [sourceId]: 'installed',
      [peerId]: 'missing',
    });
    expect(probeCalls().map(({ args }) => args?.sessionId)).toEqual([sourceRustId, peerRustId]);
  });

  it('keeps the newest result when two source notifications overlap across matching sessions', async () => {
    installSetup([session(sourceId, sourceRustId), session(peerId, peerRustId)], {
      [sourceId]: 'missing',
      [peerId]: 'missing',
    });
    const oldSource = deferred<SshCommandResult>();
    const oldPeer = deferred<SshCommandResult>();
    const newSource = deferred<SshCommandResult>();
    const newPeer = deferred<SshCommandResult>();
    ipc.pendingProbes.push(
      { sessionId: sourceRustId, request: oldSource },
      { sessionId: peerRustId, request: oldPeer },
      { sessionId: sourceRustId, request: newSource },
      { sessionId: peerRustId, request: newPeer },
    );
    ipc.allProbes.push(oldSource, oldPeer, newSource, newPeer);
    const oldRequest = startSync();
    await waitForProbeCount(1);
    const newRequest = startSync();
    await waitForProbeCount(2);

    newSource.resolve(result('installed'));
    await waitForProbeCount(3);
    newPeer.resolve(result('installed'));
    await waitForProbeCount(3);
    await newRequest.done;
    oldSource.resolve(result('missing'));
    await waitForProbeCount(4);
    oldPeer.resolve(result('missing'));
    await oldRequest.done;

    expect(useSshStore.getState().remoteCarapaceBySession).toEqual({
      [sourceId]: 'installed',
      [peerId]: 'installed',
    });
    expect(probeCalls().map(({ args }) => args?.sessionId)).toEqual([
      sourceRustId, peerRustId, sourceRustId, peerRustId,
    ]);
  });
});
