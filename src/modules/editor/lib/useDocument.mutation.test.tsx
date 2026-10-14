import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useSshStore } from "@/modules/ssh-explorer/sshStore";
import { useDocument } from "./useDocument";
import { pendingFileSaves } from "./pendingFileSaves";
import { fileSourceKey } from "@/modules/workspace/fileSource";

const { invokeMock, sftpReadMock, sftpStatMock, sftpWriteMock, dismissMock, warningMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  sftpReadMock: vi.fn(),
  sftpStatMock: vi.fn(),
  sftpWriteMock: vi.fn(),
  dismissMock: vi.fn(),
  warningMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/lib/sftp-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sftp-bridge")>();
  return { ...actual, sftpRead: sftpReadMock, sftpStat: sftpStatMock, sftpWrite: sftpWriteMock };
});
vi.mock("@/modules/lsp", () => ({ notifyDocumentSaved: vi.fn() }));
vi.mock("sonner", () => ({ toast: {
  warning: warningMock,
  error: vi.fn(),
  success: vi.fn(),
  dismiss: dismissMock,
} }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const text = (content: string, mtime = 10) => ({ kind: "text" as const, content, size: content.length, mtime });
const workspaceA = { kind: "wsl", distro: "A" } as const;
const workspaceB = { kind: "wsl", distro: "B" } as const;
const originalPreferences = usePreferencesStore.getState();
const originalSsh = useSshStore.getState();

beforeEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
  usePreferencesStore.setState({ editorAutoSave: false, editorAutoSaveDelay: 1000 });
  useSshStore.setState({ sessions: [] });
  invokeMock.mockImplementation((command: string) => Promise.resolve(
    command === "fs_read_file" ? text("original") : command === "fs_stat" ? { kind: "file", size: 8, mtime: 10 } : 11,
  ));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  usePreferencesStore.setState(originalPreferences, true);
  useSshStore.setState(originalSsh, true);
});

describe("useDocument relocation mutation gate", () => {
  it("keeps a dispatched write discoverable after its editor unmounts", async () => {
    const write = deferred<number>();
    invokeMock.mockImplementation((command: string) => command === "fs_write_file" ? write.promise : Promise.resolve(
      command === "fs_read_file" ? text("original") : { kind: "file", size: 8, mtime: 10 },
    ));
    const { result, unmount } = renderHook(() => useDocument({ path: "/unmounted.txt", workspace: workspaceA }));
    await waitFor(() => expect(result.current.doc).toMatchObject({ status: "ready" }));
    act(() => result.current.onChange("draft"));
    let saving!: Promise<boolean>;
    act(() => { saving = result.current.save(); });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("fs_write_file", expect.objectContaining({ path: "/unmounted.txt" })));
    unmount();
    const key = fileSourceKey(workspaceA)!;
    expect(pendingFileSaves(key, "/unmounted.txt")).toHaveLength(1);
    await act(async () => { write.resolve(11); await saving; });
    expect(pendingFileSaves(key, "/unmounted.txt")).toHaveLength(0);
  });

  it("waits for an already dispatched write before relocation is ready", async () => {
    const write = deferred<number>();
    invokeMock.mockImplementation((command: string) => command === "fs_write_file" ? write.promise : Promise.resolve(
      command === "fs_read_file" ? text("original") : { kind: "file", size: 8, mtime: 10 },
    ));
    const { result } = renderHook(() => useDocument({ path: "/old.txt", workspace: workspaceA }));
    await waitFor(() => expect(result.current.doc).toMatchObject({ status: "ready" }));
    act(() => result.current.onChange("draft"));
    let save!: Promise<boolean>;
    act(() => { save = result.current.save(); });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("fs_write_file", expect.objectContaining({ path: "/old.txt" })));

    let ready!: Promise<void>;
    act(() => { ready = result.current.beginRelocation("/new.txt").ready; });
    let readySettled = false;
    void ready.then(() => { readySettled = true; });
    await act(async () => { await Promise.resolve(); });
    expect(readySettled).toBe(false);

    await act(async () => { write.resolve(11); await save; await ready; });
    expect(readySettled).toBe(true);
    expect(result.current.isRelocating()).toBe(true);
  });

  it("withholds new saves and dismisses an old conflict while relocation is held", async () => {
    const conflictAction = vi.fn();
    invokeMock.mockImplementation((command: string) => Promise.resolve(
      command === "fs_read_file" ? text("original") : command === "fs_stat" ? { kind: "file", size: 8, mtime: 12 } : 13,
    ));
    warningMock.mockImplementation((_message: string, options: { id: string; action: { onClick: () => void } }) => {
      conflictAction.mockImplementation(options.action.onClick);
    });
    const { result } = renderHook(() => useDocument({ path: "/old.txt", workspace: workspaceA }));
    await waitFor(() => expect(result.current.doc).toMatchObject({ status: "ready" }));
    act(() => result.current.onChange("draft"));
    await act(async () => { expect(await result.current.save()).toBe(false); });
    expect(warningMock).toHaveBeenCalled();
    const conflictId = warningMock.mock.calls[0][1].id;

    act(() => { result.current.beginRelocation("/new.txt"); });
    expect(dismissMock).toHaveBeenCalledWith(conflictId);
    await act(async () => { expect(await result.current.save()).toBe(false); });
    act(() => conflictAction());
    expect(invokeMock).not.toHaveBeenCalledWith("fs_write_file", expect.anything());
    expect(result.current.isRelocating()).toBe(true);
  });

  it("keeps edits made during the hold and autosaves them only after the new path is acknowledged", async () => {
    vi.useFakeTimers();
    usePreferencesStore.setState({ editorAutoSave: true, editorAutoSaveDelay: 50 });
    const { result, rerender } = renderHook(
      ({ path, relocation }: { path: string; relocation?: { from: string; to: string } }) => useDocument({ path, workspace: workspaceA, relocation }),
      { initialProps: { path: "/old.txt", relocation: undefined as { from: string; to: string } | undefined } },
    );
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.doc).toMatchObject({ status: "ready" });
    act(() => { result.current.beginRelocation("/new.txt"); result.current.onChange("new draft"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    expect(invokeMock).not.toHaveBeenCalledWith("fs_write_file", expect.anything());

    rerender({ path: "/new.txt", relocation: { from: "/old.txt", to: "/new.txt" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(invokeMock).toHaveBeenCalledWith("fs_write_file", expect.objectContaining({ path: "/new.txt", content: "new draft" }));
    expect(invokeMock).not.toHaveBeenCalledWith("fs_write_file", expect.objectContaining({ path: "/old.txt" }));
    expect(result.current.isRelocating()).toBe(false);
    expect(result.current.dirty).toBe(false);
  });

  it("cancel resumes autosave at the old path", async () => {
    vi.useFakeTimers();
    usePreferencesStore.setState({ editorAutoSave: true, editorAutoSaveDelay: 50 });
    const { result } = renderHook(() => useDocument({ path: "/old.txt", workspace: workspaceA }));
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    act(() => { result.current.beginRelocation("/new.txt").cancel(); result.current.onChange("draft"); });
    await act(async () => { await vi.advanceTimersByTimeAsync(50); });
    expect(invokeMock).toHaveBeenCalledWith("fs_write_file", expect.objectContaining({ path: "/old.txt", content: "draft" }));
    expect(invokeMock).not.toHaveBeenCalledWith("fs_write_file", expect.objectContaining({ path: "/new.txt" }));
    expect(result.current.isRelocating()).toBe(false);
  });

  it("does not let a cancelled old-source hold release a newer source hold", async () => {
    const { result, rerender } = renderHook(
      ({ workspace }: { workspace: typeof workspaceA | typeof workspaceB }) => useDocument({ path: "/old.txt", workspace }),
      { initialProps: { workspace: workspaceA as typeof workspaceA | typeof workspaceB } },
    );
    await waitFor(() => expect(result.current.doc).toMatchObject({ status: "ready" }));
    let oldCancel!: () => void;
    act(() => { oldCancel = result.current.beginRelocation("/old-new.txt").cancel; });
    rerender({ workspace: workspaceB });
    await waitFor(() => expect(invokeMock).toHaveBeenLastCalledWith("fs_read_file", expect.objectContaining({ workspace: workspaceB })));
    act(() => { result.current.beginRelocation("/new-source-target.txt"); oldCancel(); });
    expect(result.current.isRelocating()).toBe(true);
    await act(async () => { expect(await result.current.save()).toBe(false); });
  });

  it("rejects a duplicate hold with a visible Chinese error", async () => {
    const { result } = renderHook(() => useDocument({ path: "/old.txt", workspace: workspaceA }));
    await waitFor(() => expect(result.current.doc).toMatchObject({ status: "ready" }));
    act(() => { result.current.beginRelocation("/new.txt"); });
    expect(() => result.current.beginRelocation("/other.txt")).toThrow(/迁移|重命名|移动/);
  });

  it("waits for an already dispatched external-stat check before reporting ready", async () => {
    const stat = deferred<{ kind: string; size: number; mtime: number }>();
    invokeMock.mockImplementation((command: string) => command === "fs_stat" ? stat.promise : Promise.resolve(
      command === "fs_read_file" ? text("original") : 11,
    ));
    const { result } = renderHook(() => useDocument({ path: "/old.txt", workspace: workspaceA }));
    await waitFor(() => expect(result.current.doc).toMatchObject({ status: "ready" }));
    act(() => result.current.onChange("draft"));
    let save!: Promise<boolean>;
    act(() => { save = result.current.save(); });
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("fs_stat", expect.objectContaining({ path: "/old.txt" })));
    let ready!: Promise<void>;
    act(() => { ready = result.current.beginRelocation("/new.txt").ready; });
    let settled = false;
    void ready.then(() => { settled = true; });
    await act(async () => { await Promise.resolve(); });
    expect(settled).toBe(false);
    await act(async () => { stat.resolve({ kind: "file", size: 8, mtime: 10 }); await save; await ready; });
    expect(settled).toBe(true);
    expect(invokeMock).toHaveBeenCalledWith("fs_write_file", expect.objectContaining({ path: "/old.txt", content: "draft" }));
  });

  it("does not let a cancelled queued hold overwrite the active hold", async () => {
    const { result } = renderHook(() => useDocument({ path: "/old.txt", workspace: workspaceA }));
    await waitFor(() => expect(result.current.doc).toMatchObject({ status: "ready" }));
    let firstCancel!: () => void;
    act(() => { firstCancel = result.current.beginRelocation("/first-target.txt").cancel; });
    expect(() => result.current.beginRelocation("/second-target.txt")).toThrow(/迁移|重命名|移动/);
    act(() => firstCancel());
    expect(result.current.isRelocating()).toBe(false);
    act(() => { result.current.beginRelocation("/second-target.txt"); });
    expect(result.current.isRelocating()).toBe(true);
  });
});
