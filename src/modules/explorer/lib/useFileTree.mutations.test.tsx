import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import { type FileTreeSource, useFileTree } from "./useFileTree";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("./watch", () => ({ watchAdd: vi.fn(), watchRemove: vi.fn(), listenFsChanged: vi.fn(async () => () => {}) }));
const original = useWorkspaceEnvStore.getState();
const a = { kind: "local" as const, workspace: { kind: "wsl" as const, distro: "A" } };
const b = { kind: "local" as const, workspace: { kind: "wsl" as const, distro: "B" } };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => { invokeMock.mockReset().mockResolvedValue([]); useWorkspaceEnvStore.setState({ env: { kind: "local" } }); });
afterEach(() => { cleanup(); useWorkspaceEnvStore.setState(original, true); });

describe("file tree mutation ownership", () => {
  it("dispatches local rename to its explicit WSL source and emits that source", async () => {
    const renamed = vi.fn();
    const { result } = renderHook(() => useFileTree("/srv", { source: a, onPathRenamed: renamed }));
    await act(async () => {});
    act(() => result.current.beginRename("/srv/file"));
    await act(async () => result.current.commitRename("new"));
    expect(invokeMock).toHaveBeenCalledWith("fs_rename", { from: "/srv/file", to: "/srv/new", workspace: a.workspace });
    expect(renamed).toHaveBeenCalledWith("/srv/file", "/srv/new", a.workspace);
  });
  it.each(["rename", "create"] as const)("does not clear new same-path %s input or refetch a new tree on late ACK", async mode => {
    const ack = deferred(), renamed = vi.fn();
    invokeMock.mockImplementation((command: string) => command === "fs_rename" || command === "fs_create_file" ? ack.promise : Promise.resolve([]));
    const { result, rerender } = renderHook(({ source }: { source: FileTreeSource }) => useFileTree("/srv", { source, onPathRenamed: renamed }), { initialProps: { source: a } });
    await act(async () => {});
    let operation!: Promise<void>;
    act(() => { if (mode === "rename") { result.current.beginRename("/srv/file"); } else { result.current.beginCreate("/srv", "file"); } });
    act(() => { operation = mode === "rename" ? result.current.commitRename("new") : result.current.commitCreate("new"); });
    rerender({ source: b });
    await act(async () => {});
    act(() => { if (mode === "rename") result.current.beginRename("/srv/file"); else result.current.beginCreate("/srv", "file"); });
    const reads = invokeMock.mock.calls.filter(([cmd]) => cmd === "fs_read_dir").length;
    await act(async () => { ack.resolve(); await operation; });
    expect(mode === "rename" ? result.current.renaming : result.current.pendingCreate?.parentPath).toBe(mode === "rename" ? "/srv/file" : "/srv");
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "fs_read_dir")).toHaveLength(reads);
    if (mode === "rename") expect(renamed).toHaveBeenCalledWith("/srv/file", "/srv/new", a.workspace);
  });
  it("emits the original remote UUID after switching sessions, without querying the new session", async () => {
    const ack = deferred(), deleted = vi.fn();
    invokeMock.mockImplementation((command: string) => command === "fsb_delete" ? ack.promise : Promise.resolve([]));
    const { result, rerender } = renderHook(({ source }: { source: FileTreeSource }) => useFileTree("/srv", { source, onPathDeleted: deleted }), {
      initialProps: { source: { kind: "sftp", sessionId: 1, root: "/", frontendSessionId: "ssh-a" } },
    });
    await act(async () => {});
    let operation!: Promise<void>;
    act(() => { operation = result.current.deletePath("/srv/file"); });
    rerender({ source: { kind: "sftp", sessionId: 2, root: "/", frontendSessionId: "ssh-b" } });
    await act(async () => {});
    const reads = invokeMock.mock.calls.filter(([cmd]) => cmd === "fsb_list").length;
    await act(async () => { ack.resolve(); await operation; });
    expect(deleted).toHaveBeenCalledWith("/srv/file", { kind: "ssh", sessionId: "ssh-a" });
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "fsb_list")).toHaveLength(reads);
  });

  it("does not settle a newer rename at the same path within the same source", async () => {
    const ack = deferred();
    invokeMock.mockImplementation((command: string) => command === "fs_rename" ? ack.promise : Promise.resolve([]));
    const { result } = renderHook(() => useFileTree("/srv", { source: a }));
    await act(async () => {});
    act(() => result.current.beginRename("/srv/file"));
    let operation!: Promise<void>;
    act(() => { operation = result.current.commitRename("new"); });
    act(() => result.current.cancelRename());
    act(() => result.current.beginRename("/srv/file"));
    await act(async () => { ack.resolve(); await operation; });
    expect(result.current.renaming).toBe("/srv/file");
  });

  it("invalidates old work even after switching A to B and back to A", async () => {
    const ack = deferred();
    invokeMock.mockImplementation((command: string) => command === "fs_rename" ? ack.promise : Promise.resolve([]));
    const { result, rerender } = renderHook(({ source }: { source: FileTreeSource }) => useFileTree("/srv", { source }), { initialProps: { source: a } });
    await act(async () => {});
    act(() => result.current.beginRename("/srv/file"));
    let operation!: Promise<void>;
    act(() => { operation = result.current.commitRename("new"); });
    rerender({ source: b });
    rerender({ source: a });
    await act(async () => {});
    act(() => result.current.beginRename("/srv/file"));
    const reads = invokeMock.mock.calls.filter(([cmd]) => cmd === "fs_read_dir").length;
    await act(async () => { ack.resolve(); await operation; });
    expect(result.current.renaming).toBe("/srv/file");
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "fs_read_dir")).toHaveLength(reads);
  });

  it("does not report a successful notification when delete fails", async () => {
    const deleted = vi.fn(), error = vi.spyOn(console, "error").mockImplementation(() => {});
    invokeMock.mockImplementation((command: string) => command === "fsb_delete" ? Promise.reject(new Error("permission denied")) : Promise.resolve([]));
    const { result } = renderHook(() => useFileTree("/srv", { source: { kind: "sftp", sessionId: 1, root: "/", frontendSessionId: "ssh-a" }, onPathDeleted: deleted }));
    await act(async () => result.current.deletePath("/srv/file"));
    expect(deleted).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("delete failed:", expect.any(Error));
    error.mockRestore();
  });
});
