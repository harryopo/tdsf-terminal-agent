import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import { useDocument } from "./useDocument";

const { invokeMock, toastWarning } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  toastWarning: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/modules/lsp", () => ({ notifyDocumentSaved: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { warning: toastWarning, error: vi.fn(), success: vi.fn() },
}));

const workspaceA = { kind: "wsl", distro: "A" } as const;
const workspaceB = { kind: "wsl", distro: "B" } as const;
const originalWorkspace = useWorkspaceEnvStore.getState();
const originalPreferences = usePreferencesStore.getState();

function text(content: string, mtime = 1) {
  return { kind: "text", content, size: content.length, mtime };
}

beforeEach(() => {
  vi.resetAllMocks();
  usePreferencesStore.setState({ editorAutoSave: false, editorAutoSaveDelay: 1000 });
  useWorkspaceEnvStore.setState({ env: workspaceA });
});

afterEach(() => {
  cleanup();
  usePreferencesStore.setState(originalPreferences, true);
  useWorkspaceEnvStore.setState(originalWorkspace, true);
});

describe("useDocument workspace ownership", () => {
  it("keeps initial load, reload, forced read, stat and write on explicit workspace A", async () => {
    invokeMock
      .mockResolvedValueOnce(text("loaded"))
      .mockResolvedValueOnce(text("reloaded"))
      .mockResolvedValueOnce(text("forced"))
      .mockResolvedValueOnce({ kind: "file", size: 5, mtime: 1 })
      .mockResolvedValueOnce(2);
    const { result } = renderHook(() => useDocument({ path: "/doc.txt", workspace: workspaceA }));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "loaded" }));
    act(() => useWorkspaceEnvStore.setState({ env: workspaceB }));

    act(() => expect(result.current.reload()).toBe(true));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "reloaded" }));
    act(() => result.current.openAnyway());
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "forced" }));
    act(() => result.current.onChange("draft"));
    await act(async () => expect(await result.current.save()).toBe(true));

    const fsCalls = invokeMock.mock.calls.filter(([command]) => String(command).startsWith("fs_"));
    expect(fsCalls.map(([, args]) => (args as { workspace: unknown }).workspace)).toEqual([
      workspaceA, workspaceA, workspaceA, workspaceA, workspaceA,
    ]);
  });

  it("captures the mount workspace for legacy callers", async () => {
    invokeMock.mockResolvedValueOnce(text("loaded")).mockResolvedValueOnce(text("reloaded"));
    const { result } = renderHook(() => useDocument({ path: "/legacy.txt" }));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "loaded" }));
    act(() => useWorkspaceEnvStore.setState({ env: workspaceB }));
    act(() => expect(result.current.reload()).toBe(true));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "reloaded" }));
    expect(invokeMock.mock.calls.map(([, args]) => (args as { workspace: unknown }).workspace)).toEqual([
      workspaceA, workspaceA,
    ]);
  });

  it("treats explicit null as unknown and preserves the draft without local IO", async () => {
    invokeMock.mockResolvedValue(text("unexpected local read"));
    const { result } = renderHook(() => useDocument({ path: "/unknown.txt", workspace: null }));
    await waitFor(() => expect(result.current.doc).toMatchObject({
      status: "error",
      message: expect.stringMatching(/无法确认文件所属环境/),
    }));
    act(() => result.current.onChange("draft"));
    expect(result.current.dirty).toBe(true);
    await act(async () => {
      await expect(result.current.save()).rejects.toThrow(/无法确认文件所属环境/);
    });
    expect(result.current.dirty).toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("keeps conflict detection and the overwrite toast action on explicit A", async () => {
    invokeMock
      .mockResolvedValueOnce(text("original", 10))
      .mockResolvedValueOnce({ kind: "file", size: 4, mtime: 11 })
      .mockResolvedValueOnce(12);
    const { result } = renderHook(() => useDocument({ path: "/conflict.txt", workspace: workspaceA }));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "original" }));
    act(() => useWorkspaceEnvStore.setState({ env: workspaceB }));
    act(() => result.current.onChange("draft"));
    await act(async () => expect(await result.current.save()).toBe(false));
    const action = toastWarning.mock.calls[0][1].action as { onClick: () => void };
    await act(async () => action.onClick());
    expect(invokeMock.mock.calls.map(([, args]) => (args as { workspace: unknown }).workspace)).toEqual([
      workspaceA, workspaceA, workspaceA,
    ]);
  });

  it("keeps autosave on the mount workspace after the global workspace changes", async () => {
    invokeMock.mockImplementation((command: string) => Promise.resolve(
      command === "fs_read_file" ? text("original") : command === "fs_stat" ? { mtime: 1 } : 2,
    ));
    usePreferencesStore.setState({ editorAutoSave: true, editorAutoSaveDelay: 1 });
    const { result } = renderHook(() => useDocument({ path: "/auto.txt" }));
    await waitFor(() => expect(result.current.doc).toMatchObject({ content: "original" }));
    act(() => useWorkspaceEnvStore.setState({ env: workspaceB }));
    act(() => result.current.onChange("draft"));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    expect(invokeMock).toHaveBeenCalledWith("fs_write_file", expect.anything());
    const [, writeArgs] = invokeMock.mock.calls.find(([command]) => command === "fs_write_file") ?? [];
    expect(writeArgs).toMatchObject({ workspace: workspaceA, content: "draft" });
  });
});
