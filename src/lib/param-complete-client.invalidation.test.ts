import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/event', async () => {
  const { invoke } = await import('@tauri-apps/api/core');
  return { emit: (event: string, payload: unknown) => invoke('plugin:event|emit', { event, payload }) };
});

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));

import { invoke } from '@tauri-apps/api/core';
import {
  CARAPACE_CHECK_CMD,
  CARAPACE_CONFIGURE_CMD,
  CARAPACE_MKDIR_CMD,
  CARAPACE_YES_MARK,
  installRemoteCarapace,
  invalidateRemoteCarapaceCache,
  remoteCarapaceInstalled,
} from './param-complete-client';
import { PROBE_MARK } from './ssh-bridge';

const mockInvoke = vi.mocked(invoke);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function sshResult(output: string, exitCode = 0) {
  return { ok: true, output, stderr: '', exitCode, duration: 0.01 };
}

beforeEach(() => {
  mockInvoke.mockReset();
  [731, 732, 733].forEach(invalidateRemoteCarapaceCache);
});

describe('remoteCarapaceInstalled invalidation lifecycle', () => {
  it('keeps the successful install probe cached when an older missing probe returns late', async () => {
    const oldProbe = deferred<ReturnType<typeof sshResult>>();
    let checks = 0;
    mockInvoke.mockImplementation((async (command: string, args?: { command?: string }) => {
      if (command === 'carapace_linux_path') return 'pkg/carapace';
      if (command === 'sftp_upload_file') return undefined;
      if (command === 'plugin:event|emit') return undefined;
      if (command !== 'ssh_command') throw new Error(`unexpected invoke: ${command}`);
      if (args?.command === CARAPACE_CHECK_CMD && checks++ === 0) return oldProbe.promise;
      if (args?.command === CARAPACE_MKDIR_CMD) return sshResult(`${PROBE_MARK}\n/home/tester\n`);
      if (args?.command === CARAPACE_CONFIGURE_CMD) return sshResult('carapace version 1');
      if (args?.command === CARAPACE_CHECK_CMD) return sshResult(`${CARAPACE_YES_MARK}\n`);
      throw new Error(`unexpected ssh command: ${args?.command}`);
    }) as typeof invoke);

    const old = remoteCarapaceInstalled(731);
    await Promise.resolve();
    expect(await installRemoteCarapace(731)).toBe(true);
    await expect(remoteCarapaceInstalled(731)).resolves.toBe(true);
    oldProbe.resolve(sshResult('', 1));
    await expect(old).resolves.toBe(false);

    await expect(remoteCarapaceInstalled(731)).resolves.toBe(true);
    expect(mockInvoke.mock.calls.filter(([cmd, args]) =>
      cmd === 'ssh_command' && (args as { command?: string })?.command === CARAPACE_CHECK_CMD,
    )).toHaveLength(2);
  });

  it('does not repopulate an invalidated cache from an old reply when no newer probe exists', async () => {
    const oldProbe = deferred<ReturnType<typeof sshResult>>();
    mockInvoke.mockImplementationOnce(() => oldProbe.promise)
      .mockResolvedValueOnce(sshResult(`${CARAPACE_YES_MARK}\n`));

    const old = remoteCarapaceInstalled(732);
    await Promise.resolve();
    invalidateRemoteCarapaceCache(732);
    oldProbe.resolve(sshResult('', 1));
    await expect(old).resolves.toBe(false);

    await expect(remoteCarapaceInstalled(732)).resolves.toBe(true);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it('invalidating one session leaves another session cache intact', async () => {
    mockInvoke.mockResolvedValue(sshResult(`${CARAPACE_YES_MARK}\n`));
    await remoteCarapaceInstalled(731);
    await remoteCarapaceInstalled(732);
    invalidateRemoteCarapaceCache(731);
    await remoteCarapaceInstalled(732);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it('caches confirmed installed and missing results, but retries after a probe error', async () => {
    mockInvoke.mockResolvedValueOnce(sshResult(`${CARAPACE_YES_MARK}\n`));
    mockInvoke.mockResolvedValueOnce(sshResult('', 1));
    mockInvoke.mockRejectedValueOnce(new Error('offline'));
    mockInvoke.mockResolvedValueOnce(sshResult(`${CARAPACE_YES_MARK}\n`));

    await expect(remoteCarapaceInstalled(731)).resolves.toBe(true);
    await remoteCarapaceInstalled(731);
    await expect(remoteCarapaceInstalled(732)).resolves.toBe(false);
    await remoteCarapaceInstalled(732);
    await expect(remoteCarapaceInstalled(733)).resolves.toBe(false);
    await expect(remoteCarapaceInstalled(733)).resolves.toBe(true);
    expect(mockInvoke).toHaveBeenCalledTimes(4);
  });
});
