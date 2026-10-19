import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sshCommand } = vi.hoisted(() => ({ sshCommand: vi.fn() }));

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));
vi.mock('@tauri-apps/api/event', () => ({ emit: vi.fn() }));
vi.mock('@/lib/ssh-bridge', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/lib/ssh-bridge')>(),
  sshCommand,
}));

import { CARAPACE_CHECK_CMD, CARAPACE_YES_MARK, invalidateRemoteCarapaceCache, remoteCarapaceInstalled } from '@/lib/param-complete-client';
import { probeCarapaceTarget } from './remoteCarapaceAdmin';

function response(options: {
  output?: string;
  ok?: boolean;
  exitCode?: number;
  stderr?: string;
}) {
  return {
    ok: options.ok ?? true,
    output: options.output ?? '',
    stderr: options.stderr ?? '',
    exitCode: options.exitCode,
    duration: 0.125,
  };
}

beforeEach(() => {
  sshCommand.mockReset();
});

describe('probeCarapaceTarget exit evidence', () => {
  it('separates the marker from a login banner without a trailing newline', () => {
    expect(CARAPACE_CHECK_CMD).toContain(String.raw`printf '\n%s\n'`);
    expect(CARAPACE_CHECK_CMD).toContain(`'${CARAPACE_YES_MARK}'`);
  });

  it('requires an independent exact marker, transport success, and exit code zero', async () => {
    sshCommand.mockResolvedValue(response({ output: 'prefix\n__TDSF_CARAPACE_YES__\n', exitCode: 0 }));
    expect(await probeCarapaceTarget(7)).toEqual({ state: 'installed' });
    expect(sshCommand).toHaveBeenCalledWith(7, CARAPACE_CHECK_CMD, 5);
  });

  it.each([
    ['exit -1', response({ output: '__TDSF_CARAPACE_YES__', exitCode: -1 })],
    ['missing exit status', response({ output: '__TDSF_CARAPACE_YES__' })],
    ['transport error', response({ output: '__TDSF_CARAPACE_YES__', ok: false, exitCode: 0, stderr: 'link failed' })],
  ])('classifies marker with %s as error', async (_label, result) => {
    sshCommand.mockResolvedValue(result);
    expect((await probeCarapaceTarget(7)).state).toBe('error');
  });

  it('classifies exit zero without the marker as error', async () => {
    sshCommand.mockResolvedValue(response({ exitCode: 0 }));
    expect((await probeCarapaceTarget(7)).state).toBe('error');
  });

  it('classifies exit one without the marker as missing', async () => {
    sshCommand.mockResolvedValue(response({ exitCode: 1 }));
    expect(await probeCarapaceTarget(7)).toEqual({ state: 'missing' });
  });

  it('does not accept a marker substring as proof of installation', async () => {
    sshCommand.mockResolvedValue(response({ output: 'prefix__TDSF_CARAPACE_YES__suffix', exitCode: 0 }));
    expect((await probeCarapaceTarget(7)).state).toBe('error');
  });

  it.each([2, 127])('treats exit %i without marker as error', async (exitCode) => {
    sshCommand.mockResolvedValue(response({ exitCode, stderr: 'command failed' }));
    expect((await probeCarapaceTarget(7)).state).toBe('error');
  });

  it('preserves the concrete diagnostic for an invalid result', async () => {
    sshCommand.mockResolvedValue(response({ ok: false, exitCode: 2, stderr: 'permission denied' }));
    expect(await probeCarapaceTarget(7)).toEqual({ state: 'error', detail: 'permission denied' });
  });

  it.each([
    ['unknown exit status', response({ output: '', exitCode: -1 })],
    ['transport failure', response({ output: '', ok: false, exitCode: 0 })],
  ])('does not cache %s as missing', async (_label, unknownResult) => {
    const sessionId = 701;
    invalidateRemoteCarapaceCache(sessionId);
    sshCommand
      .mockResolvedValueOnce(unknownResult)
      .mockResolvedValueOnce(response({ output: `${CARAPACE_YES_MARK}\n`, exitCode: 0 }));

    expect(await remoteCarapaceInstalled(sessionId)).toBe(false);
    expect(await remoteCarapaceInstalled(sessionId)).toBe(true);
    expect(sshCommand).toHaveBeenCalledTimes(2);
  });

  it('caches a confirmed missing result from exit one', async () => {
    const sessionId = 702;
    invalidateRemoteCarapaceCache(sessionId);
    sshCommand
      .mockResolvedValueOnce(response({ exitCode: 1 }))
      .mockResolvedValueOnce(response({ output: `${CARAPACE_YES_MARK}\n`, exitCode: 0 }));

    expect(await remoteCarapaceInstalled(sessionId)).toBe(false);
    expect(await remoteCarapaceInstalled(sessionId)).toBe(false);
    expect(sshCommand).toHaveBeenCalledTimes(1);
  });

  it('caches a confirmed installed result', async () => {
    const sessionId = 703;
    invalidateRemoteCarapaceCache(sessionId);
    sshCommand
      .mockResolvedValueOnce(response({ output: `${CARAPACE_YES_MARK}\n`, exitCode: 0 }))
      .mockResolvedValueOnce(response({ exitCode: 1 }));

    expect(await remoteCarapaceInstalled(sessionId)).toBe(true);
    expect(await remoteCarapaceInstalled(sessionId)).toBe(true);
    expect(sshCommand).toHaveBeenCalledTimes(1);
    expect(sshCommand).toHaveBeenCalledWith(sessionId, CARAPACE_CHECK_CMD, 2);
  });
});
