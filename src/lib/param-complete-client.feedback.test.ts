import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: class {} }));

import { invoke } from '@tauri-apps/api/core';
import { installRemoteCarapace } from './param-complete-client';
import { PROBE_MARK } from './ssh-bridge';

const mockInvoke = vi.mocked(invoke);
const sshResult = (output: string, exitCode = 0) => ({
  ok: true, output, stderr: '', exitCode, duration: 0.01,
});

function mockInstall(homeOutput: string, uploadError?: Error, resourceError?: Error) {
  const calls: string[] = [];
  mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
    calls.push(cmd);
    if (cmd === 'ssh_command') {
      const command = (args as { command: string }).command;
      return command.includes('mkdir -p')
        ? sshResult(homeOutput)
        : sshResult('carapace version 0.7.0');
    }
    if (cmd === 'carapace_linux_path') {
      if (resourceError) throw resourceError;
      return 'C:/pkg/carapace-linux-amd64';
    }
    if (cmd === 'sftp_upload_file') {
      if (uploadError) throw uploadError;
      return undefined;
    }
    throw new Error(`unexpected invoke: ${String(cmd)} args=${JSON.stringify(args)}`);
  });
  return calls;
}

beforeEach(() => {
  mockInvoke.mockReset();
});

describe('installRemoteCarapace — validate probed HOME before SFTP', () => {
  it('uploads only when the sentinel is followed by an absolute Linux HOME', async () => {
    const calls = mockInstall(`${PROBE_MARK}\n/home/ops\n`);
    await expect(installRemoteCarapace(42)).resolves.toBe(true);
    expect(calls).toEqual(['ssh_command', 'carapace_linux_path', 'sftp_upload_file', 'ssh_command']);
    expect(mockInvoke).toHaveBeenCalledWith('sftp_upload_file', {
      sessionId: 42,
      localPath: 'C:/pkg/carapace-linux-amd64',
      remotePath: '/home/ops/.local/bin/carapace',
    });
  });

  it('rejects exit-zero mkdir output without the HOME probe marker before resource lookup', async () => {
    const calls = mockInstall('/home/ops\n');
    const onError = vi.fn();
    await expect(installRemoteCarapace(42, undefined, onError)).resolves.toBe(false);
    expect(calls).toEqual(['ssh_command']);
    expect(onError.mock.calls[0]?.[0]).toMatch(/远端.*(目录|HOME|路径)/);
  });

  it.each(['relative/home', '~', '/home/ops\0Injected', '/home/ops\tInjected'])(
    'rejects unsafe probed HOME %j without loading or uploading the bundle',
    async (home) => {
      const calls = mockInstall(`${PROBE_MARK}\n${home}\n`);
      const onError = vi.fn();
      await expect(installRemoteCarapace(42, undefined, onError)).resolves.toBe(false);
      expect(calls).toEqual(['ssh_command']);
      expect(onError.mock.calls[0]?.[0]).toMatch(/远端.*(目录|HOME|路径)/);
    },
  );

  it('reports bundle lookup separately from an SFTP upload failure', async () => {
    const onError = vi.fn();
    mockInstall(`${PROBE_MARK}\n/home/ops\n`, undefined, new Error('resource missing'));
    await expect(installRemoteCarapace(42, undefined, onError)).resolves.toBe(false);
    expect(onError.mock.calls[0]?.[0]).toMatch(/获取.*(随包|组件)/);
    expect(onError.mock.calls[0]?.[0]).not.toMatch(/上传/);

    onError.mockClear();
    mockInstall(`${PROBE_MARK}\n/home/ops\n`, new Error('SFTP failed'));
    await expect(installRemoteCarapace(42, undefined, onError)).resolves.toBe(false);
    expect(onError.mock.calls[0]?.[0]).toMatch(/上传.*失败/);
  });
});
