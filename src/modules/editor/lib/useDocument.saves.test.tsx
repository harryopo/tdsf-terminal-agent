import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useSshStore, type SshSessionInfo } from "@/modules/ssh-explorer/sshStore";
import { useDocument } from "./useDocument";

const { invokeMock, sftpReadMock, sftpStatMock, sftpWriteMock, notifySaved, toastWarning, toastError, toastDismiss } =
  vi.hoisted(() => ({
    invokeMock: vi.fn(),
    sftpReadMock: vi.fn(),
    sftpStatMock: vi.fn(),
    sftpWriteMock: vi.fn(),
    notifySaved: vi.fn(),
    toastWarning: vi.fn(),
    toastError: vi.fn(),
    toastDismiss: vi.fn(),
  }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/lib/sftp-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sftp-bridge")>();
  return { ...actual, sftpRead: sftpReadMock, sftpStat: sftpStatMock, sftpWrite: sftpWriteMock };
});
vi.mock("@/modules/lsp", () => ({ notifyDocumentSaved: notifySaved }));
vi.mock("sonner", () => ({
  toast: { warning: toastWarning, error: toastError, success: vi.fn(), dismiss: toastDismiss },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function text(content: string, mtime = 10) {
  return { kind: "text" as const, content, size: content.length, mtime };
}

function stat(mtime: number) {
  return { kind: "file", size: 4, mtime };
}

function overwriteAction(index = 0) {
  return (toastWarning.mock.calls[index]?.[1] as { action: { onClick: () => void } }).action.onClick;
}

const workspaceA = { kind: "wsl", distro: "A" } as const;
const workspaceB = { kind: "wsl", distro: "B" } as const;
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

beforeEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
  usePreferencesStore.setState({ editorAutoSave: false, editorAutoSaveDelay: 1000 });
  useSshStore.setState({ sessions: sshSessions });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  usePreferencesStore.setState(originalPreferences, true);
  useSshStore.setState(originalSsh, true);
});

describe("useDocument save lifecycle", () => {
  it("does not save the previous buffer while the replacement document is still loading", async () => {
    const readB = deferred<ReturnType<typeof text>>();
    invokeMock.mockImplementation((command: string, args: { path: string }) => {
      if (command === "fs_read_file") return args.path === "/a.txt" ? Promise.resolve(text("original A")) : readB.promise;
      if (command === "fs_stat") return Promise.resolve(stat(10));
      return Promise.resolve(11);
    });
    const { result, rerender } = renderHook(({ path }) => useDocument({ path }), { initialProps: { path: "/a.txt" } });
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "original A" }));
    act(() => result.current.onChange("draft A"));
    rerender({ path: "/b.txt" });
    expect(result.current.doc.status).toBe("loading");
    await act(async () => expect(await result.current.save()).toBe(false));
    expect(invokeMock).not.toHaveBeenCalledWith("fs_write_file", expect.anything());
    await act(async () => readB.resolve(text("original B")));
    act(() => result.current.onChange("draft B"));
    await act(async () => expect(await result.current.save()).toBe(true));
    expect(invokeMock).toHaveBeenCalledWith("fs_write_file", expect.objectContaining({ path: "/b.txt", content: "draft B" }));
  });

  it("withholds saving during openAnyway even before the loading state renders", async () => {
    const forcedRead = deferred<ReturnType<typeof text>>();
    let reads = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "fs_read_file") return reads++ === 0 ? Promise.resolve(text("original")) : forcedRead.promise;
      if (command === "fs_stat") return Promise.resolve(stat(10));
      return Promise.resolve(11);
    });
    const { result } = renderHook(() => useDocument({ path: "/a.txt" }));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "original" }));
    act(() => result.current.onChange("draft"));
    await act(async () => {
      result.current.openAnyway();
      expect(await result.current.save()).toBe(false);
    });
    expect(invokeMock).not.toHaveBeenCalledWith("fs_write_file", expect.anything());
    await act(async () => forcedRead.resolve(text("reopened")));
    expect(result.current.doc).toMatchObject({ content: "reopened" });
  });

  it("withholds a local save whose stat resolves after the path is replaced", async () => {
    const oldStat = deferred<ReturnType<typeof stat>>();
    invokeMock.mockImplementation((command: string, args: { path: string }) => {
      if (command === "fs_read_file") return Promise.resolve(text(args.path === "/a.txt" ? "A" : "B"));
      if (command === "fs_stat" && args.path === "/a.txt") return oldStat.promise;
      if (command === "fs_stat") return Promise.resolve(stat(10));
      return Promise.resolve(11);
    });
    const { result, rerender } = renderHook(({ path }) => useDocument({ path }), {
      initialProps: { path: "/a.txt" },
    });
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "A" }));
    act(() => result.current.onChange("draft A"));
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.save(); });
    rerender({ path: "/b.txt" });
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "B" }));
    act(() => result.current.onChange("draft B"));
    await act(async () => { oldStat.resolve(stat(10)); await expect(pending).resolves.toBe(false); });
    expect(invokeMock).not.toHaveBeenCalledWith("fs_write_file", expect.objectContaining({ path: "/a.txt" }));
    expect(invokeMock).not.toHaveBeenCalledWith("fs_write_file", expect.objectContaining({ content: "draft B" }));
  });

  it("rejects an in-flight same-path save when WSL workspace ownership changes", async () => {
    const oldStat = deferred<ReturnType<typeof stat>>();
    invokeMock.mockImplementation((command: string, args: { workspace?: unknown }) => {
      if (command === "fs_read_file") return Promise.resolve(text(args.workspace === workspaceA ? "A" : "B"));
      if (command === "fs_stat" && args.workspace === workspaceA) return oldStat.promise;
      if (command === "fs_stat") return Promise.resolve(stat(10));
      return Promise.resolve(11);
    });
    const { result, rerender } = renderHook(({ workspace }) => useDocument({ path: "/same.txt", workspace }), {
      initialProps: { workspace: workspaceA as typeof workspaceA | typeof workspaceB },
    });
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "A" }));
    act(() => result.current.onChange("draft A"));
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.save(); });
    rerender({ workspace: workspaceB });
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "B" }));
    await act(async () => { oldStat.resolve(stat(10)); await expect(pending).resolves.toBe(false); });
    expect(invokeMock).not.toHaveBeenCalledWith("fs_write_file", expect.anything());
  });

  it("rejects an in-flight same-path save when SSH UUID ownership changes", async () => {
    let oldStats = 0;
    const oldStat = deferred<{ size: number; uid: number; gid: number; permissions: number; modified: number; accessed: number }>();
    sftpReadMock.mockImplementation((sid: number) => Promise.resolve(new TextEncoder().encode(sid === 101 ? "A" : "B")));
    sftpStatMock.mockImplementation((sid: number) => {
      if (sid === 101 && ++oldStats === 2) return oldStat.promise;
      return Promise.resolve({ size: 1, uid: 1, gid: 1, permissions: 0o644, modified: 10, accessed: 10 });
    });
    sftpWriteMock.mockResolvedValue(undefined);
    const { result, rerender } = renderHook(({ remote }) => useDocument({ path: "/same.txt", remote }), {
      initialProps: { remote: { sessionId: "remote-a" } },
    });
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "A" }));
    act(() => result.current.onChange("draft A"));
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.save(); });
    rerender({ remote: { sessionId: "remote-b" } });
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "B" }));
    await act(async () => { oldStat.resolve({ size: 1, uid: 1, gid: 1, permissions: 0o644, modified: 10, accessed: 10 }); await expect(pending).resolves.toBe(false); });
    expect(sftpWriteMock).not.toHaveBeenCalled();
  });

  it("does not let an A to B to A path cycle restore an earlier save epoch", async () => {
    const oldStat = deferred<ReturnType<typeof stat>>();
    invokeMock.mockImplementation((command: string, args: { path: string }) => {
      if (command === "fs_read_file") return Promise.resolve(text(args.path));
      if (command === "fs_stat") return oldStat.promise;
      return Promise.resolve(11);
    });
    const { result, rerender } = renderHook(({ path }) => useDocument({ path }), {
      initialProps: { path: "/a.txt" },
    });
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "/a.txt" }));
    act(() => result.current.onChange("draft A"));
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.save(); });
    rerender({ path: "/b.txt" });
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "/b.txt" }));
    rerender({ path: "/a.txt" });
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "/a.txt" }));
    await act(async () => { oldStat.resolve(stat(10)); await expect(pending).resolves.toBe(false); });
    expect(invokeMock).not.toHaveBeenCalledWith("fs_write_file", expect.anything());
  });

  it("ignores a write acknowledgement after replacement without changing the new dirty buffer", async () => {
    const oldWrite = deferred<number>();
    invokeMock.mockImplementation((command: string, args: { path: string }) => {
      if (command === "fs_read_file") return Promise.resolve(text(args.path === "/a.txt" ? "A" : "B"));
      if (command === "fs_stat") return Promise.resolve(stat(10));
      if (args.path === "/a.txt") return oldWrite.promise;
      return Promise.resolve(11);
    });
    const { result, rerender } = renderHook(({ path }) => useDocument({ path }), {
      initialProps: { path: "/a.txt" },
    });
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "A" }));
    act(() => result.current.onChange("draft A"));
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.save(); });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("fs_write_file", expect.objectContaining({ path: "/a.txt" })));
    rerender({ path: "/b.txt" });
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "B" }));
    act(() => result.current.onChange("draft B"));
    await act(async () => { oldWrite.resolve(11); await expect(pending).resolves.toBe(false); });
    expect(result.current.dirty).toBe(true);
    expect(notifySaved).not.toHaveBeenCalled();
  });

  it("does not run a captured conflict action after the document is replaced", async () => {
    invokeMock.mockImplementation((command: string, args: { path: string }) => {
      if (command === "fs_read_file") return Promise.resolve(text(args.path === "/a.txt" ? "A" : "B"));
      if (command === "fs_stat") return Promise.resolve(stat(11));
      return Promise.resolve(12);
    });
    const { result, rerender } = renderHook(({ path }) => useDocument({ path }), {
      initialProps: { path: "/a.txt" },
    });
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "A" }));
    act(() => result.current.onChange("draft A"));
    await act(async () => expect(await result.current.save()).toBe(false));
    const action = overwriteAction();
    rerender({ path: "/b.txt" });
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "B" }));
    await act(async () => { action(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(invokeMock).not.toHaveBeenCalledWith("fs_write_file", expect.anything());
  });

  it("does not run a captured conflict action after unmount", async () => {
    invokeMock.mockImplementation((command: string) => command === "fs_read_file" ? Promise.resolve(text("original"))
      : command === "fs_stat" ? Promise.resolve(stat(11)) : Promise.resolve(12));
    const { result, unmount } = renderHook(() => useDocument({ path: "/a.txt" }));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "original" }));
    act(() => result.current.onChange("draft"));
    await act(async () => expect(await result.current.save()).toBe(false));
    const action = overwriteAction();
    unmount();
    await act(async () => { action(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(invokeMock).not.toHaveBeenCalledWith("fs_write_file", expect.anything());
  });

  it("assigns distinct conflict toast ids to same-path hook instances", async () => {
    invokeMock.mockImplementation((command: string) => command === "fs_read_file" ? Promise.resolve(text("original"))
      : command === "fs_stat" ? Promise.resolve(stat(11)) : Promise.resolve(12));
    const first = renderHook(() => useDocument({ path: "/same.txt", workspace: workspaceA }));
    const second = renderHook(() => useDocument({ path: "/same.txt", workspace: workspaceA }));
    await waitFor(() => {
      expect(first.result.current.doc).toMatchObject({ content: "original" });
      expect(second.result.current.doc).toMatchObject({ content: "original" });
    });
    act(() => { first.result.current.onChange("first draft"); second.result.current.onChange("second draft"); });
    await act(async () => {
      await first.result.current.save();
      await second.result.current.save();
    });
    expect(toastWarning).toHaveBeenCalledTimes(2);
    const firstId = (toastWarning.mock.calls[0]?.[1] as { id: string }).id;
    const secondId = (toastWarning.mock.calls[1]?.[1] as { id: string }).id;
    expect(firstId).not.toBe(secondId);
  });

  it("revokes the earlier conflict action when a newer conflict is shown", async () => {
    invokeMock.mockImplementation((command: string) => command === "fs_read_file" ? Promise.resolve(text("original"))
      : command === "fs_stat" ? Promise.resolve(stat(11)) : Promise.resolve(12));
    const { result } = renderHook(() => useDocument({ path: "/a.txt" }));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "original" }));
    act(() => result.current.onChange("draft"));
    await act(async () => expect(await result.current.save()).toBe(false));
    const earlierAction = overwriteAction(0);
    await act(async () => expect(await result.current.save()).toBe(false));
    const latestAction = overwriteAction(1);
    await act(async () => { earlierAction(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(invokeMock).not.toHaveBeenCalledWith("fs_write_file", expect.anything());
    invokeMock.mockResolvedValue(12);
    act(() => latestAction());
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("fs_write_file", expect.objectContaining({ content: "draft" })));
  });

  it("allows the current conflict action to overwrite, notify, and clear dirty after acknowledgement", async () => {
    invokeMock.mockImplementation((command: string) => command === "fs_read_file" ? Promise.resolve(text("original\r\nline", 10))
      : command === "fs_stat" ? Promise.resolve(stat(11)) : Promise.resolve(12));
    const { result } = renderHook(() => useDocument({ path: "/文档.txt" }));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "original\nline" }));
    act(() => result.current.onChange("草稿\n内容"));
    await act(async () => expect(await result.current.save()).toBe(false));
    expect(toastWarning).toHaveBeenCalledWith("文件已被外部修改", expect.objectContaining({
      description: expect.stringContaining("文档.txt"),
      action: expect.objectContaining({ label: "覆盖保存", onClick: expect.any(Function) }),
    }));
    invokeMock.mockResolvedValue(12);
    act(() => overwriteAction()());
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("fs_write_file", expect.objectContaining({
      path: "/文档.txt", content: "草稿\r\n内容",
    })));
    await waitFor(() => expect(result.current.dirty).toBe(false));
    expect(notifySaved).toHaveBeenCalledWith("/文档.txt");
  });

  it("shows a Chinese error and stays dirty when the current overwrite fails", async () => {
    const write = deferred<number>();
    invokeMock.mockImplementation((command: string) => command === "fs_read_file" ? Promise.resolve(text("original"))
      : command === "fs_stat" ? Promise.resolve(stat(11)) : write.promise);
    const { result } = renderHook(() => useDocument({ path: "/a.txt" }));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "original" }));
    act(() => result.current.onChange("draft"));
    await act(async () => expect(await result.current.save()).toBe(false));
    act(() => overwriteAction()());
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("fs_write_file", expect.anything()));
    await act(async () => { write.reject(new Error("disk full")); await Promise.resolve(); });
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls[0]?.[0])).toMatch(/[\u4e00-\u9fff]/);
    expect(result.current.dirty).toBe(true);
    expect(notifySaved).not.toHaveBeenCalled();
  });

  it("serializes saves and captures each buffer and EOL when enqueued", async () => {
    const firstStat = deferred<ReturnType<typeof stat>>();
    const firstWrite = deferred<number>();
    let statCalls = 0;
    let writeCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "fs_read_file") return Promise.resolve(text("base\r\nline", 10));
      if (command === "fs_stat") return ++statCalls === 1 ? firstStat.promise : Promise.resolve(stat(11));
      return ++writeCalls === 1 ? firstWrite.promise : Promise.resolve(12);
    });
    const { result } = renderHook(() => useDocument({ path: "/a.txt" }));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "base\nline" }));
    act(() => result.current.onChange("first\nline"));
    let first!: Promise<boolean>;
    act(() => { first = result.current.save(); });
    act(() => {
      result.current.adoptDiskText("formatted\nbase", 10);
      result.current.onChange("second\nline");
    });
    let second!: Promise<boolean>;
    act(() => { second = result.current.save(); });
    expect(statCalls).toBe(1);
    expect(writeCalls).toBe(0);
    await act(async () => { firstStat.resolve(stat(10)); await Promise.resolve(); });
    await waitFor(() => expect(writeCalls).toBe(1));
    expect(invokeMock).toHaveBeenCalledWith("fs_write_file", expect.objectContaining({ content: "first\r\nline" }));
    expect(statCalls).toBe(1);
    await act(async () => { firstWrite.resolve(11); await expect(first).resolves.toBe(true); });
    await waitFor(() => expect(statCalls).toBe(2));
    await act(async () => {
      await expect(second).resolves.toBe(true);
    });
    expect(invokeMock).toHaveBeenLastCalledWith("fs_write_file", expect.objectContaining({ content: "second\nline" }));
    expect(result.current.dirty).toBe(false);
  });

  it("queues a save of the original baseline instead of treating it as a no-op", async () => {
    const firstWrite = deferred<number>();
    let statCalls = 0;
    let writeCalls = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "fs_read_file") return Promise.resolve(text("original", 10));
      if (command === "fs_stat") return Promise.resolve(stat(statCalls++ === 0 ? 10 : 11));
      return ++writeCalls === 1 ? firstWrite.promise : Promise.resolve(12);
    });
    const { result } = renderHook(() => useDocument({ path: "/a.txt" }));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "original" }));
    act(() => result.current.onChange("first draft"));
    let first!: Promise<boolean>;
    act(() => { first = result.current.save(); });
    await waitFor(() => expect(writeCalls).toBe(1));
    act(() => result.current.onChange("original"));
    expect(result.current.dirty).toBe(false);
    let second!: Promise<boolean>;
    act(() => { second = result.current.save(); });
    expect(writeCalls).toBe(1);
    await act(async () => { firstWrite.resolve(11); await expect(first).resolves.toBe(true); });
    await waitFor(() => expect(writeCalls).toBe(2));
    expect(invokeMock).toHaveBeenLastCalledWith("fs_write_file", expect.objectContaining({ content: "original" }));
    await act(async () => { await expect(second).resolves.toBe(true); });
    expect(result.current.dirty).toBe(false);
  });

  it("ignores a remote write acknowledgement after switching to a different UUID with the same text", async () => {
    const oldWrite = deferred<void>();
    sftpReadMock.mockResolvedValue(new TextEncoder().encode("original"));
    sftpStatMock.mockResolvedValue({ size: 8, uid: 1, gid: 1, permissions: 0o644, modified: 10, accessed: 10 });
    sftpWriteMock.mockReturnValue(oldWrite.promise);
    const { result, rerender } = renderHook(({ remote }) => useDocument({ path: "/srv/a.txt", remote }), {
      initialProps: { remote: { sessionId: "remote-a" } },
    });
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "original" }));
    act(() => result.current.onChange("draft A"));
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.save(); });
    await waitFor(() => expect(sftpWriteMock).toHaveBeenCalled());
    rerender({ remote: { sessionId: "remote-b" } });
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "original" }));
    act(() => result.current.onChange("draft B"));
    await act(async () => { oldWrite.resolve(); await expect(pending).resolves.toBe(false); });
    expect(result.current.dirty).toBe(true);
    expect(notifySaved).not.toHaveBeenCalled();
  });

  it("revokes a conflict action when a later reload adopts the current disk text", async () => {
    let reads = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "fs_read_file") return Promise.resolve(text(reads++ === 0 ? "original" : "reloaded", 12));
      if (command === "fs_stat") return Promise.resolve(stat(11));
      return Promise.resolve(13);
    });
    const { result } = renderHook(() => useDocument({ path: "/a.txt" }));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "original" }));
    act(() => result.current.onChange("draft"));
    await act(async () => expect(await result.current.save()).toBe(false));
    const oldAction = overwriteAction();
    act(() => result.current.onChange("original"));
    await waitFor(() => expect(result.current.dirty).toBe(false));
    act(() => expect(result.current.reload()).toBe(true));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "reloaded" }));
    await act(async () => { oldAction(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(invokeMock).not.toHaveBeenCalledWith("fs_write_file", expect.anything());
    expect(result.current.dirty).toBe(false);
  });

  it("propagates one write failure and still runs the next queued save", async () => {
    const failedWrite = deferred<number>();
    let writes = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "fs_read_file") return Promise.resolve(text("base"));
      if (command === "fs_stat") return Promise.resolve(stat(10));
      return ++writes === 1 ? failedWrite.promise : Promise.resolve(12);
    });
    const { result } = renderHook(() => useDocument({ path: "/a.txt" }));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "base" }));
    act(() => result.current.onChange("first"));
    let first!: Promise<boolean>;
    act(() => { first = result.current.save(); });
    await waitFor(() => expect(writes).toBe(1));
    act(() => result.current.onChange("second"));
    let second!: Promise<boolean>;
    act(() => { second = result.current.save(); });
    await act(async () => { failedWrite.reject(new Error("write failed")); await expect(first).rejects.toThrow("write failed"); });
    await act(async () => await expect(second).resolves.toBe(true));
    expect(writes).toBe(2);
    expect(invokeMock).toHaveBeenLastCalledWith("fs_write_file", expect.objectContaining({ content: "second" }));
  });

  it("remains dirty when the buffer changes during a write", async () => {
    const write = deferred<number>();
    invokeMock.mockImplementation((command: string) => command === "fs_read_file" ? Promise.resolve(text("base"))
      : command === "fs_stat" ? Promise.resolve(stat(10)) : write.promise);
    const { result } = renderHook(() => useDocument({ path: "/a.txt" }));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "base" }));
    act(() => result.current.onChange("first"));
    let pending!: Promise<boolean>;
    act(() => { pending = result.current.save(); });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("fs_write_file", expect.anything()));
    act(() => result.current.onChange("typed during write"));
    await act(async () => { write.resolve(11); await expect(pending).resolves.toBe(true); });
    expect(result.current.dirty).toBe(true);
  });
});
