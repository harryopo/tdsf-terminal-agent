import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePreferencesStore } from '@/modules/settings/preferences';
import { CARAPACE_CONFIGURE_CMD, CARAPACE_MKDIR_CMD } from '@/lib/param-complete-client';
import { PROBE_MARK } from '@/lib/ssh-bridge';
import { useSshStore, type SshSessionInfo } from './sshStore';
import { SshCarapaceBadge } from './SshCarapaceBadge';

const ipc = vi.hoisted(() => ({
  invoke: vi.fn(),
  uploads: new Map<number, { promise: Promise<unknown>; resolve: () => void; reject: (error: Error) => void }>(),
  calls: [] as Array<{ command: string; args?: Record<string, unknown> }>,
}));

vi.mock('@tauri-apps/api/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tauri-apps/api/core')>();
  return { ...actual, invoke: ipc.invoke };
});

function deferred() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<unknown>((done, fail) => {
    resolve = () => done(undefined);
    reject = fail;
  });
  return { promise, resolve, reject };
}

function session(id: string, rustSessionId: number, state: SshSessionInfo['state'] = 'connected'): SshSessionInfo {
  return {
    id,
    rustSessionId,
    params: { host: 'fixture.invalid', port: 22, user: 'fixture', cols: 80, rows: 24, term: 'xterm-256color' },
    state,
    connectedAt: 1,
    handle: null,
  };
}

let savedPreferences: ReturnType<typeof usePreferencesStore.getState>;
let savedSshState: ReturnType<typeof useSshStore.getState>;

function show(id = 'front-1') {
  return render(<SshCarapaceBadge sessionId={id} />);
}

function clickBadge() {
  const button = screen.getByTitle('启用远端动态补全');
  if (button.getAttribute('aria-expanded') !== 'true') fireEvent.click(button);
}

function clickInstall(label = '安装') {
  fireEvent.click(screen.getByRole('button', { name: label }));
}

async function waitForUpload(rustSessionId: number) {
  await waitFor(() => expect(ipc.uploads.has(rustSessionId)).toBe(true));
  expect(screen.getByText('上传中…')).toBeTruthy();
}

beforeEach(() => {
  savedPreferences = usePreferencesStore.getState();
  savedSshState = useSshStore.getState();
  ipc.calls.length = 0;
  ipc.uploads.clear();
  ipc.invoke.mockReset().mockImplementation((command: string, args?: Record<string, unknown>) => {
    ipc.calls.push({ command, args });
    if (command === 'ssh_command' && args?.command === CARAPACE_MKDIR_CMD) {
      return Promise.resolve({ ok: true, exitCode: 0, stderr: '', output: `${PROBE_MARK}\n/home/fixture\n` });
    }
    if (command === 'carapace_linux_path') return Promise.resolve('C:/fixture/carapace-linux-amd64');
    if (command === 'sftp_upload_file' && typeof args?.sessionId === 'number') {
      let upload = ipc.uploads.get(args.sessionId);
      if (!upload) {
        upload = deferred();
        ipc.uploads.set(args.sessionId, upload);
      }
      return upload.promise;
    }
    if (command === 'ssh_command' && args?.command === CARAPACE_CONFIGURE_CMD) {
      return Promise.resolve({ ok: true, exitCode: 0, stderr: '', output: 'carapace version fixture' });
    }
    throw new Error(`Unexpected IPC: ${command}`);
  });
  usePreferencesStore.setState({ ...savedPreferences, sshRemoteCarapacePrompt: true, zoomLevel: 1 });
  useSshStore.setState({
    ...savedSshState,
    sessions: [session('front-1', 7)],
    activeSessionId: 'front-1',
    remoteCarapaceBySession: { 'front-1': 'missing' },
  });
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    for (const upload of ipc.uploads.values()) upload.resolve();
  });
  usePreferencesStore.setState(savedPreferences, true);
  useSshStore.setState(savedSshState, true);
});

describe('SshCarapaceBadge installation ownership', () => {
  it('runs the real four-step install for its Rust session and hides after success', async () => {
    show();
    clickBadge();
    clickInstall();
    await waitForUpload(7);
    await act(async () => ipc.uploads.get(7)!.resolve());

    expect(useSshStore.getState().remoteCarapaceBySession['front-1']).toBe('installed');
    expect(screen.queryByTitle('启用远端动态补全')).toBeNull();
    expect(ipc.calls.map(({ command }) => command)).toEqual([
      'ssh_command', 'carapace_linux_path', 'sftp_upload_file', 'ssh_command',
    ]);
    expect(ipc.calls.filter((call) => call.command === 'ssh_command').map((call) => call.args?.command))
      .toEqual([CARAPACE_MKDIR_CMD, CARAPACE_CONFIGURE_CMD]);
    expect(ipc.calls.find((call) => call.command === 'sftp_upload_file')?.args).toEqual({
      sessionId: 7,
      localPath: 'C:/fixture/carapace-linux-amd64',
      remotePath: '/home/fixture/.local/bin/carapace',
    });
    expect(ipc.calls.filter((call) => call.command === 'sftp_upload_file')).toHaveLength(1);
  });

  it('shows a failed install, allows retry, and ignores a rapid duplicate click', async () => {
    show();
    clickBadge();
    const install = screen.getByRole('button', { name: '安装' });
    fireEvent.click(install);
    fireEvent.click(install);
    await waitForUpload(7);
    expect(ipc.calls.filter((call) => call.command === 'sftp_upload_file')).toHaveLength(1);

    await act(async () => ipc.uploads.get(7)!.reject(new Error('fixture upload failed')));
    expect(await screen.findByText(/上传补全组件失败：fixture upload failed/)).toBeTruthy();
    expect(screen.getByRole('button', { name: '重试安装' })).toBeTruthy();

    ipc.uploads.delete(7);
    clickInstall('重试安装');
    await waitForUpload(7);
    await act(async () => ipc.uploads.get(7)!.resolve());
    expect(useSshStore.getState().remoteCarapaceBySession['front-1']).toBe('installed');
    expect(ipc.calls.filter((call) => call.command === 'sftp_upload_file')).toHaveLength(2);
  });

  it('does not let an old Rust session success mark its replacement installed', async () => {
    show();
    clickBadge();
    clickInstall();
    await waitForUpload(7);
    act(() => useSshStore.setState({ sessions: [session('front-1', 8)] }));
    await act(async () => ipc.uploads.get(7)!.resolve());

    expect(useSshStore.getState().remoteCarapaceBySession['front-1']).toBe('missing');
    expect(screen.getByTitle('启用远端动态补全')).toBeTruthy();
    clickBadge();
    expect(screen.getByText(/远端服务器未安装 carapace/)).toBeTruthy();
  });

  it('keeps a replacement session usable while an old upload fails or finishes', async () => {
    show();
    clickBadge();
    clickInstall();
    await waitForUpload(7);
    act(() => useSshStore.setState({ sessions: [session('front-1', 8)] }));
    clickBadge();
    expect(screen.getByText(/远端服务器未安装 carapace/)).toBeTruthy();
    clickInstall();
    await waitForUpload(8);

    await act(async () => ipc.uploads.get(7)!.reject(new Error('old upload failed')));
    expect(screen.getByText('上传中…')).toBeTruthy();
    expect(screen.queryByText(/old upload failed/)).toBeNull();
    await act(async () => ipc.uploads.get(8)!.resolve());
    expect(useSshStore.getState().remoteCarapaceBySession['front-1']).toBe('installed');
  });

  it('does not recreate a removed session record when its install completes', async () => {
    show();
    clickBadge();
    clickInstall();
    await waitForUpload(7);
    act(() => useSshStore.setState({ sessions: [], activeSessionId: null, remoteCarapaceBySession: {} }));
    await act(async () => ipc.uploads.get(7)!.resolve());
    expect(useSshStore.getState().remoteCarapaceBySession['front-1']).toBeUndefined();
  });

  it('does not let an unmounted badge update a new instance with the same frontend id', async () => {
    const first = show();
    clickBadge();
    clickInstall();
    await waitForUpload(7);
    first.unmount();
    show();
    await act(async () => ipc.uploads.get(7)!.resolve());
    expect(useSshStore.getState().remoteCarapaceBySession['front-1']).toBe('missing');
    expect(screen.getByTitle('启用远端动态补全')).toBeTruthy();
    clickBadge();
    expect(screen.getByText(/远端服务器未安装 carapace/)).toBeTruthy();
  });

  it('does not carry in-progress UI or success into a different frontend session prop', async () => {
    const view = show();
    clickBadge();
    clickInstall();
    await waitForUpload(7);
    act(() => useSshStore.setState({
      sessions: [session('front-1', 7), session('front-2', 8)],
      remoteCarapaceBySession: { 'front-1': 'missing', 'front-2': 'missing' },
    }));
    view.rerender(<SshCarapaceBadge sessionId="front-2" />);
    clickBadge();
    expect(screen.getByText(/远端服务器未安装 carapace/)).toBeTruthy();
    await act(async () => ipc.uploads.get(7)!.resolve());
    expect(useSshStore.getState().remoteCarapaceBySession).toEqual({ 'front-1': 'missing', 'front-2': 'missing' });
    expect(screen.getByText(/远端服务器未安装 carapace/)).toBeTruthy();
  });

  it('does not mark a disconnected session installed after its old install succeeds', async () => {
    show();
    clickBadge();
    clickInstall();
    await waitForUpload(7);
    act(() => useSshStore.setState({ sessions: [session('front-1', 7, 'closed')] }));
    await act(async () => ipc.uploads.get(7)!.resolve());
    expect(useSshStore.getState().remoteCarapaceBySession['front-1']).toBe('missing');
    expect(screen.queryByTitle('启用远端动态补全')).toBeNull();
  });
});
