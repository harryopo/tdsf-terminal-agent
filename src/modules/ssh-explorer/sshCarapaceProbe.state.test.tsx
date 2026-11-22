import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CARAPACE_CHECK_CMD,
  CARAPACE_YES_MARK,
  invalidateRemoteCarapaceCache,
  remoteCarapaceInstalled,
} from '@/lib/param-complete-client';
import { usePreferencesStore } from '@/modules/settings/preferences';
import { applyCarapaceChanged } from './lib/sshCarapaceSync';
import { useSshStore, type SshSessionInfo } from './sshStore';
import { SshCarapaceBadge } from './SshCarapaceBadge';

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  calls: [] as Array<{ command: string; args?: Record<string, unknown> }>,
}));

vi.mock('@tauri-apps/api/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tauri-apps/api/core')>();
  return { ...actual, invoke: ipc.invoke };
});

const rustSessionId = 7;
const frontendSessionId = 'probe-state-front';

function session(): SshSessionInfo {
  return {
    id: frontendSessionId,
    rustSessionId,
    params: { host: 'fixture.invalid', port: 22, user: 'fixture', cols: 80, rows: 24, term: 'xterm-256color' },
    state: 'connected',
    connectedAt: 1,
    handle: null,
  };
}

let savedPreferences: ReturnType<typeof usePreferencesStore.getState>;
let savedSshState: ReturnType<typeof useSshStore.getState>;

function setProbeResult(result: unknown | Error) {
  ipc.calls.length = 0;
  ipc.invoke.mockReset().mockImplementation((command: string, args?: Record<string, unknown>) => {
    ipc.calls.push({ command, args });
    if (command !== 'ssh_command' || args?.command !== CARAPACE_CHECK_CMD) {
      throw new Error(`Unexpected RPC: ${command}`);
    }
    if (result instanceof Error) return Promise.reject(result);
    return Promise.resolve(result);
  });
}

function resetFixture() {
  invalidateRemoteCarapaceCache(rustSessionId);
  useSshStore.setState({
    sessions: [session()],
    activeSessionId: frontendSessionId,
    remoteCarapaceBySession: {},
  });
}

async function runEntry(entry: 'detect' | 'sync') {
  if (entry === 'detect') {
    await useSshStore.getState().detectRemoteCarapace(frontendSessionId);
    return;
  }
  await applyCarapaceChanged({ sessionId: rustSessionId });
}

const uncertainResults = [
  ['transport rejection', new Error('fixture transport failure')],
  ['failed command', { ok: false, exitCode: -1, stderr: 'timeout', output: '', duration: 2 }],
  ['unknown exit status', { ok: true, exitCode: -1, stderr: '', output: '', duration: 2 }],
  ['missing exit status', { ok: true, stderr: '', output: '', duration: 0.1 }],
  ['successful command without marker', { ok: true, exitCode: 0, stderr: '', output: '/usr/bin/carapace', duration: 0.1 }],
] as const;

beforeEach(() => {
  savedPreferences = usePreferencesStore.getState();
  savedSshState = useSshStore.getState();
  usePreferencesStore.setState({ ...savedPreferences, sshRemoteCarapacePrompt: true, zoomLevel: 1 });
  resetFixture();
});

afterEach(() => {
  cleanup();
  invalidateRemoteCarapaceCache(rustSessionId);
  usePreferencesStore.setState(savedPreferences, true);
  useSshStore.setState(savedSshState, true);
});

describe('remote carapace probe state through existing actions', () => {
  it.each(uncertainResults)('keeps %s out of the missing state for detect', async (_name, result) => {
    setProbeResult(result);
    await runEntry('detect');

    expect(useSshStore.getState().remoteCarapaceBySession[frontendSessionId] as string).toBe('error');
    render(<SshCarapaceBadge sessionId={frontendSessionId} />);
    expect(screen.queryByTitle('启用远端动态补全')).toBeNull();
    expect(ipc.calls).toHaveLength(1);
    expect(ipc.calls[0]).toEqual({
      command: 'ssh_command',
      args: { sessionId: rustSessionId, command: CARAPACE_CHECK_CMD, timeout: 2 },
    });
  });

  it.each(uncertainResults)('keeps %s out of the missing state for sync', async (_name, result) => {
    setProbeResult(result);
    await runEntry('sync');

    expect(useSshStore.getState().remoteCarapaceBySession[frontendSessionId] as string).toBe('error');
    render(<SshCarapaceBadge sessionId={frontendSessionId} />);
    expect(screen.queryByTitle('启用远端动态补全')).toBeNull();
    expect(ipc.calls).toHaveLength(1);
    expect(ipc.calls[0]?.args).toEqual({ sessionId: rustSessionId, command: CARAPACE_CHECK_CMD, timeout: 2 });
    expect(ipc.calls.some(({ command }) => command === 'sftp_upload_file')).toBe(false);
  });

  it.each([
    ['missing', { ok: true, exitCode: 1, stderr: '', output: '', duration: 0.1 }, 'missing'],
    ['installed', { ok: true, exitCode: 0, stderr: '', output: `${CARAPACE_YES_MARK}\n`, duration: 0.1 }, 'installed'],
  ] as const)('preserves an explicit %s result for both entries', async (_name, result, expected) => {
    for (const entry of ['detect', 'sync'] as const) {
      resetFixture();
      setProbeResult(result);
      await runEntry(entry);

      expect(useSshStore.getState().remoteCarapaceBySession[frontendSessionId]).toBe(expected);
      const view = render(<SshCarapaceBadge sessionId={frontendSessionId} />);
      if (expected === 'missing') {
        expect(screen.getByTitle('启用远端动态补全')).toBeTruthy();
      } else {
        expect(screen.queryByTitle('启用远端动态补全')).toBeNull();
      }
      expect(ipc.calls).toHaveLength(1);
      view.unmount();
      cleanup();
    }
  });

  it('keeps the prediction boolean contract and lets an error be checked again', async () => {
    setProbeResult(new Error('fixture transport failure'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(remoteCarapaceInstalled(rustSessionId)).resolves.toBe(false);
      setProbeResult({ ok: true, exitCode: 0, stderr: '', output: `${CARAPACE_YES_MARK}\n`, duration: 0.1 });
      await expect(remoteCarapaceInstalled(rustSessionId)).resolves.toBe(true);
      expect(ipc.calls).toHaveLength(1);
      expect(ipc.calls[0]?.args).toEqual({ sessionId: rustSessionId, command: CARAPACE_CHECK_CMD, timeout: 2 });
    } finally {
      warn.mockRestore();
    }
  });
});
