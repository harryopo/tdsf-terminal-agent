import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useSshStore, type SshSessionInfo } from "@/modules/ssh-explorer/sshStore";
import { useDocument } from "./useDocument";

const { invokeMock, sftpReadMock, sftpStatMock, sftpWriteMock, toastWarning } =
  vi.hoisted(() => ({
    invokeMock: vi.fn(),
    sftpReadMock: vi.fn(),
    sftpStatMock: vi.fn(),
    sftpWriteMock: vi.fn(),
    toastWarning: vi.fn(),
  }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/lib/sftp-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sftp-bridge")>();
  return {
    ...actual,
    sftpRead: sftpReadMock,
    sftpStat: sftpStatMock,
    sftpWrite: sftpWriteMock,
  };
});
vi.mock("@/modules/lsp", () => ({ notifyDocumentSaved: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { warning: toastWarning, error: vi.fn(), success: vi.fn() },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function text(content: string, mtime = 1) {
  return { kind: "text" as const, content, size: content.length, mtime };
}

const originalPreferences = usePreferencesStore.getState();
const originalSsh = useSshStore.getState();
const sshSessions: SshSessionInfo[] = [101, 202].map((rustSessionId, index) => ({
  id: index === 0 ? "remote-a" : "remote-b",
  rustSessionId,
  params: { host: "server.test", port: 22, user: "fixture", cols: 80, rows: 24, term: "xterm-256color" },
  state: "connected",
  connectedAt: 1,
  handle: null,
}));
const remoteA = { sessionId: "remote-a" };
const remoteB = { sessionId: "remote-b" };

beforeEach(() => {
  vi.resetAllMocks();
  usePreferencesStore.setState({ editorAutoSave: false, editorAutoSaveDelay: 1000 });
  useSshStore.setState({ sessions: sshSessions });
});

afterEach(() => {
  usePreferencesStore.setState(originalPreferences, true);
  useSshStore.setState(originalSsh, true);
});

describe("useDocument read lifecycle", () => {
  it("ignores a reload for the old path when it resolves after the new path", async () => {
    const initial = deferred<ReturnType<typeof text>>();
    const oldReload = deferred<ReturnType<typeof text>>();
    const newPath = deferred<ReturnType<typeof text>>();
    invokeMock.mockImplementationOnce(() => initial.promise);

    const { result, rerender } = renderHook(
      ({ path }) => useDocument({ path }),
      { initialProps: { path: "/a.txt" } },
    );
    await act(async () => initial.resolve(text("initial A")));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "initial A" }));
    invokeMock.mockImplementationOnce(() => oldReload.promise);
    act(() => expect(result.current.reload()).toBe(true));
    invokeMock.mockImplementationOnce(() => newPath.promise);
    rerender({ path: "/b.txt" });
    await act(async () => newPath.resolve(text("current B")));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "current B" }));

    await act(async () => oldReload.resolve(text("stale A")));
    expect(result.current.doc).toMatchObject({ status: "ready", content: "current B" });
  });

  it("ignores a remote reload from a replaced SSH session at the same path", async () => {
    const oldRead = deferred<Uint8Array>();
    const newRead = deferred<Uint8Array>();
    sftpReadMock.mockImplementation((sid: number) =>
      sid === 101 ? oldRead.promise : newRead.promise,
    );
    sftpStatMock.mockResolvedValue({
      size: 1, uid: 1, gid: 1, permissions: 0o644, modified: 2, accessed: 2,
    });
    const { result, rerender } = renderHook(
      ({ remote }) => useDocument({ path: "/srv/a.txt", remote }),
      { initialProps: { remote: remoteA } },
    );
    await act(async () => {
      oldRead.resolve(new TextEncoder().encode("initial"));
    });
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "initial" }));
    const staleReload = deferred<Uint8Array>();
    sftpReadMock.mockImplementationOnce(() => staleReload.promise);
    act(() => expect(result.current.reload()).toBe(true));
    sftpReadMock.mockImplementationOnce(() => newRead.promise);
    rerender({ remote: remoteB });
    await act(async () => newRead.resolve(new TextEncoder().encode("current B")));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "current B" }));
    await act(async () => staleReload.resolve(new TextEncoder().encode("stale A")));
    expect(result.current.doc).toMatchObject({ status: "ready", content: "current B" });
  });

  it("ignores openAnyway success after its document is replaced", async () => {
    const initial = deferred<ReturnType<typeof text>>();
    const replacement = deferred<ReturnType<typeof text>>();
    const staleSuccess = deferred<ReturnType<typeof text>>();
    invokeMock.mockImplementationOnce(() => initial.promise);
    const { result, rerender } = renderHook(
      ({ path }) => useDocument({ path }),
      { initialProps: { path: "/a.txt" } },
    );
    await act(async () => initial.resolve(text("initial A")));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "initial A" }));
    invokeMock.mockImplementationOnce(() => staleSuccess.promise);
    act(() => result.current.openAnyway());
    invokeMock.mockImplementationOnce(() => replacement.promise);
    rerender({ path: "/b.txt" });
    await act(async () => replacement.resolve(text("current B")));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "current B" }));
    await act(async () => staleSuccess.resolve(text("stale A")));
    expect(result.current.doc).toMatchObject({ status: "ready", content: "current B" });
  });

  it("ignores openAnyway errors after its document is replaced", async () => {
    const initial = deferred<ReturnType<typeof text>>();
    const replacement = deferred<ReturnType<typeof text>>();
    const staleFailure = deferred<ReturnType<typeof text>>();
    invokeMock.mockImplementationOnce(() => initial.promise);
    const { result, rerender } = renderHook(
      ({ path }) => useDocument({ path }),
      { initialProps: { path: "/a.txt" } },
    );
    await act(async () => initial.resolve(text("initial A")));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "initial A" }));
    invokeMock.mockImplementationOnce(() => staleFailure.promise);
    act(() => result.current.openAnyway());
    invokeMock.mockImplementationOnce(() => replacement.promise);
    rerender({ path: "/b.txt" });
    await act(async () => replacement.resolve(text("current B")));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "current B" }));
    await act(async () => staleFailure.reject(new Error("stale read failure")));
    expect(result.current.doc).toMatchObject({ status: "ready", content: "current B" });
  });

  it("adopts a current openAnyway result and forces the read", async () => {
    const initial = deferred<ReturnType<typeof text>>();
    const forcedRead = deferred<ReturnType<typeof text>>();
    invokeMock.mockImplementationOnce(() => initial.promise);
    const { result } = renderHook(() => useDocument({ path: "/a.txt" }));
    await act(async () => initial.resolve(text("initial")));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "initial" }));

    invokeMock.mockImplementationOnce(() => forcedRead.promise);
    act(() => result.current.openAnyway());
    expect(invokeMock).toHaveBeenLastCalledWith(
      "fs_read_file",
      expect.objectContaining({ path: "/a.txt", force: true }),
    );
    await act(async () => forcedRead.resolve(text("forced current")));
    expect(result.current.doc).toMatchObject({ status: "ready", content: "forced current" });
  });

  it("shows an error from the current openAnyway request", async () => {
    const initial = deferred<ReturnType<typeof text>>();
    const forcedRead = deferred<ReturnType<typeof text>>();
    invokeMock.mockImplementationOnce(() => initial.promise);
    const { result } = renderHook(() => useDocument({ path: "/a.txt" }));
    await act(async () => initial.resolve(text("initial")));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "initial" }));

    invokeMock.mockImplementationOnce(() => forcedRead.promise);
    act(() => result.current.openAnyway());
    await act(async () => forcedRead.reject(new Error("current read failed")));
    expect(result.current.doc).toMatchObject({
      status: "error",
      message: "Error: current read failed",
    });
  });

  it("adopts a current reload and refuses to replace a buffer that became dirty", async () => {
    const initial = deferred<ReturnType<typeof text>>();
    const currentReload = deferred<ReturnType<typeof text>>();
    invokeMock.mockImplementationOnce(() => initial.promise);
    const { result } = renderHook(() => useDocument({ path: "/a.txt" }));
    await act(async () => initial.resolve(text("original")));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "original" }));
    invokeMock.mockImplementationOnce(() => currentReload.promise);
    act(() => expect(result.current.reload()).toBe(true));
    await act(async () => currentReload.resolve(text("refreshed")));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "refreshed" }));

    const dirtyReload = deferred<ReturnType<typeof text>>();
    invokeMock.mockImplementationOnce(() => dirtyReload.promise);
    act(() => expect(result.current.reload()).toBe(true));
    act(() => result.current.onChange("unsaved edit"));
    await act(async () => dirtyReload.resolve(text("external update")));
    expect(result.current.dirty).toBe(true);
    expect(result.current.doc).toMatchObject({ status: "ready", content: "refreshed" });
  });

  it("uses the newest same-path reload when the older response resolves last", async () => {
    const initial = deferred<ReturnType<typeof text>>();
    const oldReload = deferred<ReturnType<typeof text>>();
    const newestReload = deferred<ReturnType<typeof text>>();
    invokeMock.mockImplementationOnce(() => initial.promise);
    const { result } = renderHook(() => useDocument({ path: "/a.txt" }));
    await act(async () => initial.resolve(text("initial")));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "initial" }));
    invokeMock.mockImplementationOnce(() => oldReload.promise);
    act(() => expect(result.current.reload()).toBe(true));
    invokeMock.mockImplementationOnce(() => newestReload.promise);
    act(() => expect(result.current.reload()).toBe(true));
    await act(async () => newestReload.resolve(text("latest")));
    expect(result.current.doc).toMatchObject({ status: "ready", content: "latest" });
    await act(async () => oldReload.resolve(text("older")));
    expect(result.current.doc).toMatchObject({ status: "ready", content: "latest" });
  });

  it("does not start reload after a same-event edit makes the buffer dirty", async () => {
    invokeMock.mockResolvedValueOnce(text("original")).mockResolvedValue(text("unexpected reload"));
    const { result } = renderHook(() => useDocument({ path: "/a.txt" }));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "original" }));
    await act(async () => {
      result.current.onChange("unsaved");
      expect(result.current.reload()).toBe(false);
    });
    expect(invokeMock).toHaveBeenCalledTimes(1);
    expect(result.current.dirty).toBe(true);
  });

  it("reports save conflicts in Chinese and writes only after explicit overwrite", async () => {
    invokeMock
      .mockResolvedValueOnce(text("saved", 10))
      .mockResolvedValueOnce({ size: 5, mtime: 11, kind: "file" });
    const { result } = renderHook(() => useDocument({ path: "/tmp/文档.txt" }));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "saved" }));
    act(() => result.current.onChange("草稿"));

    await act(async () => expect(await result.current.save()).toBe(false));
    expect(toastWarning).toHaveBeenCalledWith(
      "文件已被外部修改",
      expect.objectContaining({
        description: expect.stringContaining("文档.txt"),
        action: expect.objectContaining({ label: "覆盖保存", onClick: expect.any(Function) }),
      }),
    );
    expect(invokeMock).not.toHaveBeenCalledWith("fs_write_file", expect.anything());
    await act(async () => {
      const options = toastWarning.mock.calls[0][1] as {
        action: { onClick: () => void };
      };
      invokeMock.mockResolvedValueOnce(123);
      options.action.onClick();
      await Promise.resolve();
    });
    expect(invokeMock).toHaveBeenCalledWith(
      "fs_write_file",
      expect.objectContaining({ path: "/tmp/文档.txt", content: "草稿" }),
    );
  });
});
