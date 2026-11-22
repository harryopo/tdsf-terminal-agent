import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useSshStore } from "@/modules/ssh-explorer/sshStore";
import { useDocument } from "./useDocument";

const { invokeMock, sftpReadMock, sftpStatMock, sftpWriteMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  sftpReadMock: vi.fn(),
  sftpStatMock: vi.fn(),
  sftpWriteMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/lib/sftp-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sftp-bridge")>();
  return { ...actual, sftpRead: sftpReadMock, sftpStat: sftpStatMock, sftpWrite: sftpWriteMock };
});
vi.mock("@/modules/lsp", () => ({ notifyDocumentSaved: vi.fn() }));
vi.mock("sonner", () => ({ toast: { warning: vi.fn(), error: vi.fn(), success: vi.fn(), dismiss: vi.fn() } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function text(content: string, mtime = 10) {
  return { kind: "text" as const, content, size: content.length, mtime };
}

const workspaceA = { kind: "wsl", distro: "A" } as const;
const workspaceB = { kind: "wsl", distro: "B" } as const;
const originalPreferences = usePreferencesStore.getState();
const originalSsh = useSshStore.getState();
const remote = { sessionId: "remote-a" };

beforeEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
  usePreferencesStore.setState({ editorAutoSave: false, editorAutoSaveDelay: 1000 });
  useSshStore.setState({
    sessions: [{
      id: "remote-a",
      rustSessionId: 101,
      params: { host: "server.test", port: 22, user: "fixture", cols: 80, rows: 24, term: "xterm-256color" },
      state: "connected",
      connectedAt: 1,
      handle: null,
    }],
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  usePreferencesStore.setState(originalPreferences, true);
  useSshStore.setState(originalSsh, true);
});

describe("useDocument acknowledged relocation", () => {
  it("keeps the dirty buffer, CRLF convention, and saved mtime baseline, then saves to the new path", async () => {
    invokeMock.mockImplementation((command: string) => Promise.resolve(
      command === "fs_read_file"
        ? text("first\r\nline", 10)
        : command === "fs_stat"
          ? { kind: "file", size: 10, mtime: 10 }
          : 11,
    ));
    const { result, rerender } = renderHook(
      ({ path, relocation }) => useDocument({ path, workspace: workspaceA, relocation }),
      { initialProps: { path: "/old.txt", relocation: undefined as { from: string; to: string } | undefined } },
    );
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "first\nline" }));
    act(() => result.current.onChange("draft\nline"));

    rerender({ path: "/new.txt", relocation: { from: "/old.txt", to: "/new.txt" } });
    await waitFor(() => expect(result.current.doc.status).toBe("ready"));
    expect(result.current.doc).toMatchObject({ status: "ready", content: "draft\nline" });
    expect(result.current.dirty).toBe(true);
    await act(async () => expect(await result.current.save()).toBe(true));

    expect(invokeMock).toHaveBeenCalledWith("fs_stat", expect.objectContaining({ path: "/new.txt" }));
    expect(invokeMock.mock.calls.filter(([command]) => command === "fs_read_file")).toHaveLength(1);
    expect(invokeMock).toHaveBeenCalledWith("fs_write_file", expect.objectContaining({
      path: "/new.txt",
      content: "draft\r\nline",
      workspace: workspaceA,
    }));
    expect(result.current.dirty).toBe(false);
  });

  it("does not let a pending old-path reload replace the relocated draft", async () => {
    const oldReload = deferred<ReturnType<typeof text>>();
    invokeMock.mockResolvedValueOnce(text("original"));
    const { result, rerender } = renderHook(
      ({ path, relocation }) => useDocument({ path, relocation }),
      { initialProps: { path: "/old.txt", relocation: undefined as { from: string; to: string } | undefined } },
    );
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "original" }));
    invokeMock.mockReturnValueOnce(oldReload.promise);
    invokeMock.mockResolvedValue(text("new path contents"));
    act(() => expect(result.current.reload()).toBe(true));
    act(() => result.current.onChange("draft"));

    rerender({ path: "/new.txt", relocation: { from: "/old.txt", to: "/new.txt" } });
    await act(async () => oldReload.resolve(text("stale disk content")));
    expect(result.current.doc).toMatchObject({ status: "ready", content: "draft" });
    expect(result.current.dirty).toBe(true);
  });

  it("cancels the old autosave timer and schedules the draft against the new path", async () => {
    vi.useFakeTimers();
    usePreferencesStore.setState({ editorAutoSave: true, editorAutoSaveDelay: 100 });
    invokeMock.mockImplementation((command: string) => Promise.resolve(
      command === "fs_read_file" ? text("original") : command === "fs_stat" ? { mtime: 10 } : 11,
    ));
    const { result, rerender } = renderHook(
      ({ path, relocation }) => useDocument({ path, relocation }),
      { initialProps: { path: "/old.txt", relocation: undefined as { from: string; to: string } | undefined } },
    );
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.doc).toMatchObject({ status: "ready", content: "original" });
    act(() => result.current.onChange("draft"));
    rerender({ path: "/new.txt", relocation: { from: "/old.txt", to: "/new.txt" } });

    await act(async () => { await vi.advanceTimersByTimeAsync(99); });
    expect(invokeMock).not.toHaveBeenCalledWith("fs_write_file", expect.anything());
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(invokeMock).toHaveBeenCalledWith("fs_write_file", expect.objectContaining({
      path: "/new.txt",
      content: "draft",
    }));
    expect(invokeMock).not.toHaveBeenCalledWith("fs_write_file", expect.objectContaining({ path: "/old.txt" }));
  });

  it("reloads a normal path change without relocation", async () => {
    invokeMock.mockResolvedValueOnce(text("old document")).mockResolvedValueOnce(text("new document"));
    const { result, rerender } = renderHook(
      ({ path }) => useDocument({ path }),
      { initialProps: { path: "/old.txt" } },
    );
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "old document" }));
    rerender({ path: "/new.txt" });
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "new document" }));
    expect(invokeMock).toHaveBeenLastCalledWith("fs_read_file", expect.objectContaining({ path: "/new.txt" }));
  });

  it("does not reuse a draft when the workspace source changes", async () => {
    invokeMock.mockResolvedValueOnce(text("workspace A")).mockResolvedValueOnce(text("workspace B"));
    const { result, rerender } = renderHook(
      ({ path, workspace, relocation }) => useDocument({ path, workspace, relocation }),
      { initialProps: {
        path: "/old.txt",
        workspace: workspaceA as typeof workspaceA | typeof workspaceB,
        relocation: undefined as { from: string; to: string } | undefined,
      } },
    );
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "workspace A" }));
    act(() => result.current.onChange("private draft"));

    rerender({ path: "/new.txt", workspace: workspaceB, relocation: { from: "/old.txt", to: "/new.txt" } });
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "workspace B" }));
    expect(result.current.dirty).toBe(false);
    expect(invokeMock).toHaveBeenLastCalledWith("fs_read_file", expect.objectContaining({
      path: "/new.txt",
      workspace: workspaceB,
    }));
  });

  it("preserves a dirty remote draft when the same remote session renames the path", async () => {
    sftpReadMock.mockResolvedValue(new TextEncoder().encode("original"));
    sftpStatMock.mockResolvedValue({
      size: 8, uid: 1, gid: 1, permissions: 0o644, modified: 10, accessed: 10,
    });
    sftpWriteMock.mockResolvedValue(undefined);
    const { result, rerender } = renderHook(
      ({ path, relocation }) => useDocument({ path, remote, relocation }),
      { initialProps: { path: "/srv/old.txt", relocation: undefined as { from: string; to: string } | undefined } },
    );
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "original" }));
    act(() => result.current.onChange("remote draft"));

    rerender({ path: "/srv/new.txt", relocation: { from: "/srv/old.txt", to: "/srv/new.txt" } });
    await waitFor(() => expect(result.current.doc.status).toBe("ready"));
    expect(result.current.doc).toMatchObject({ status: "ready", content: "remote draft" });
    expect(result.current.dirty).toBe(true);
    await act(async () => expect(await result.current.save()).toBe(true));
    expect(sftpWriteMock).toHaveBeenCalledWith(101, "/srv/new.txt", expect.any(Uint8Array));
    expect(sftpReadMock).toHaveBeenCalledTimes(1);
  });
});
