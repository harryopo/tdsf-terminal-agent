import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import { type FileTreeSource, useFileTree } from "./useFileTree";

const { invokeMock, toastErrorMock } = vi.hoisted(() => ({ invokeMock: vi.fn(), toastErrorMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("./watch", () => ({ watchAdd: vi.fn(), watchRemove: vi.fn(), listenFsChanged: vi.fn(async () => () => {}) }));
vi.mock("sonner", () => ({ toast: { error: toastErrorMock } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const a = { kind: "local" as const, workspace: { kind: "wsl" as const, distro: "A" } };
const b = { kind: "local" as const, workspace: { kind: "wsl" as const, distro: "B" } };
const original = useWorkspaceEnvStore.getState();

beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue([]);
  toastErrorMock.mockReset();
  useWorkspaceEnvStore.setState({ env: { kind: "local" } });
});

afterEach(() => {
  cleanup();
  useWorkspaceEnvStore.setState(original, true);
});

describe("useFileTree relocation preflight", () => {
  it("waits for rename preflight before touching the filesystem", async () => {
    const gate = deferred<(committed: boolean) => void>();
    const before = vi.fn(() => gate.promise);
    const { result } = renderHook(() => useFileTree("/srv", { source: a, onBeforePathRenamed: before }));
    await act(async () => {});
    act(() => result.current.beginRename("/srv/old.txt"));
    let operation!: Promise<void>;
    act(() => { operation = result.current.commitRename("new.txt"); });
    await waitFor(() => expect(before).toHaveBeenCalledWith("/srv/old.txt", "/srv/new.txt", a.workspace));
    expect(invokeMock).not.toHaveBeenCalledWith("fs_rename", expect.anything());
    const finish = vi.fn();
    await act(async () => { gate.resolve(finish); await operation; });
    expect(invokeMock).toHaveBeenCalledWith("fs_rename", { from: "/srv/old.txt", to: "/srv/new.txt", workspace: a.workspace });
    expect(finish).toHaveBeenCalledWith(true);
  });

  it("runs successful move completion after the path-renamed notification", async () => {
    const acknowledgement = deferred<void>();
    invokeMock.mockImplementation((command: string) => command === "fs_rename" ? acknowledgement.promise : Promise.resolve([]));
    const finish = vi.fn();
    const renamed = vi.fn(() => { expect(finish).not.toHaveBeenCalled(); });
    const before = vi.fn(async () => finish);
    const { result } = renderHook(() => useFileTree("/srv", { source: a, onBeforePathRenamed: before, onPathRenamed: renamed }));
    await act(async () => {});
    let operation!: Promise<void>;
    act(() => { operation = result.current.movePath("/srv/file.txt", "/archive"); });
    await waitFor(() => expect(before).toHaveBeenCalledWith("/srv/file.txt", "/archive/file.txt", a.workspace));
    expect(finish).not.toHaveBeenCalled();
    expect(renamed).not.toHaveBeenCalled();
    await act(async () => { await Promise.resolve(); acknowledgement.resolve(); await operation; });
    expect(renamed).toHaveBeenCalledWith("/srv/file.txt", "/archive/file.txt", a.workspace);
    expect(finish).toHaveBeenCalledOnce();
    expect(finish).toHaveBeenCalledWith(true);
  });

  it("tells the relocation owner that a failed rename did not commit", async () => {
    const failure = new Error("permission denied");
    invokeMock.mockImplementation((command: string) => command === "fs_rename" ? Promise.reject(failure) : Promise.resolve([]));
    const finish = vi.fn();
    const before = vi.fn(async () => finish);
    const { result } = renderHook(() => useFileTree("/srv", { source: a, onBeforePathRenamed: before }));
    await act(async () => {});
    act(() => result.current.beginRename("/srv/old.txt"));
    await act(async () => { await result.current.commitRename("new.txt"); });
    expect(finish).toHaveBeenCalledWith(false);
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringMatching(/重命名失败.*permission denied/));
  });

  it("does not start a filesystem rename when relocation preflight fails", async () => {
    const before = vi.fn(async () => { throw new Error("文档迁移未就绪"); });
    const { result } = renderHook(() => useFileTree("/srv", { source: a, onBeforePathRenamed: before }));
    await act(async () => {});
    act(() => result.current.beginRename("/srv/old.txt"));
    await act(async () => { await result.current.commitRename("new.txt"); });
    expect(invokeMock).not.toHaveBeenCalledWith("fs_rename", expect.anything());
    expect(toastErrorMock).toHaveBeenCalledWith(expect.stringMatching(/重命名失败.*文档迁移未就绪/));
  });

  it("preserves the original source when rename acknowledges after a source switch", async () => {
    const acknowledgement = deferred<void>();
    invokeMock.mockImplementation((command: string) => command === "fs_rename" ? acknowledgement.promise : Promise.resolve([]));
    const finish = vi.fn();
    const before = vi.fn(async () => finish);
    const renamed = vi.fn();
    const { result, rerender } = renderHook(
      ({ source }: { source: FileTreeSource }) => useFileTree("/srv", { source, onBeforePathRenamed: before, onPathRenamed: renamed }),
      { initialProps: { source: a as FileTreeSource } },
    );
    await act(async () => {});
    act(() => result.current.beginRename("/srv/old.txt"));
    let operation!: Promise<void>;
    act(() => { operation = result.current.commitRename("new.txt"); });
    await waitFor(() => expect(before).toHaveBeenCalledWith("/srv/old.txt", "/srv/new.txt", a.workspace));
    rerender({ source: b });
    await act(async () => {});
    const oldSourceReads = invokeMock.mock.calls.filter(([cmd, args]) => cmd === "fs_read_dir" && args.workspace === a.workspace).length;
    await act(async () => { acknowledgement.resolve(); await operation; });
    expect(renamed).toHaveBeenCalledWith("/srv/old.txt", "/srv/new.txt", a.workspace);
    expect(finish).toHaveBeenCalledWith(true);
    expect(invokeMock.mock.calls.filter(([cmd, args]) => cmd === "fs_read_dir" && args.workspace === a.workspace)).toHaveLength(oldSourceReads);
  });

  it("uses the same preflight and completion contract for a move", async () => {
    const finish = vi.fn();
    const before = vi.fn(async () => finish);
    const renamed = vi.fn();
    const { result } = renderHook(() => useFileTree("/srv", { source: a, onBeforePathRenamed: before, onPathRenamed: renamed }));
    await act(async () => {});
    await act(async () => { await result.current.movePath("/srv/file.txt", "/archive"); });
    expect(before).toHaveBeenCalledWith("/srv/file.txt", "/archive/file.txt", a.workspace);
    expect(renamed).toHaveBeenCalledWith("/srv/file.txt", "/archive/file.txt", a.workspace);
    expect(finish).toHaveBeenCalledWith(true);
  });
});
