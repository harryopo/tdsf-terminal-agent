import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useFileTree } from "./useFileTree";

const { invokeMock, watchAddMock, watchRemoveMock, listenFsChangedMock, toastErrorMock } =
  vi.hoisted(() => ({
    invokeMock: vi.fn(),
    watchAddMock: vi.fn(),
    watchRemoveMock: vi.fn(),
    listenFsChangedMock: vi.fn(),
    toastErrorMock: vi.fn(),
  }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("./watch", () => ({
  listenFsChanged: listenFsChangedMock,
  watchAdd: watchAddMock,
  watchRemove: watchRemoveMock,
}));
vi.mock("sonner", () => ({ toast: { error: toastErrorMock } }));

type RawEntry = {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  mtime: number;
};

const originalEntries: RawEntry[] = [
  { name: "existing.txt", path: "/remote/existing.txt", is_dir: false, size: 12, mtime: 1 },
];

describe("useFileTree create", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    watchAddMock.mockReset();
    watchRemoveMock.mockReset();
    listenFsChangedMock.mockReset().mockResolvedValue(() => {});
    toastErrorMock.mockReset();
  });

  it("creates a remote file with exclusive create and the active SFTP scope", async () => {
    invokeMock.mockResolvedValue(originalEntries);
    const { result, unmount } = renderHook(() =>
      useFileTree("/remote", { source: { kind: "sftp", sessionId: 23, root: "/srv/project" } }),
    );
    await act(async () => {});

    act(() => result.current.beginCreate("/remote", "file"));
    await act(async () => result.current.commitCreate("new.txt"));

    expect(invokeMock).toHaveBeenCalledWith("fsb_write", {
      sessionId: 23,
      root: "/srv/project",
      path: "/remote/new.txt",
      data: [],
      createNew: true,
    });
    expect(result.current.pendingCreate).toBeNull();
    unmount();
  });

  it("reports an existing remote filename and preserves the loaded listing", async () => {
    invokeMock.mockImplementation((command: string) => {
      if (command === "fsb_list") return Promise.resolve(originalEntries);
      return Promise.reject(new Error("AlreadyExists"));
    });
    const { result, unmount } = renderHook(() =>
      useFileTree("/remote", { source: { kind: "sftp", sessionId: 23, root: "/srv/project" } }),
    );
    await act(async () => {});

    act(() => result.current.beginCreate("/remote", "file"));
    await act(async () => result.current.commitCreate("existing.txt"));

    expect(result.current.nodes["/remote"]).toEqual({
      status: "loaded",
      entries: [expect.objectContaining({ name: "existing.txt", size: 12 })],
    });
    expect(result.current.pendingCreate).toBeNull();
    expect(toastErrorMock).toHaveBeenCalledWith("新建文件失败：AlreadyExists");
    expect(invokeMock).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("creates a local file through fs_create_file", async () => {
    invokeMock.mockResolvedValue(originalEntries);
    const { result, unmount } = renderHook(() => useFileTree("/remote"));
    await act(async () => {});

    act(() => result.current.beginCreate("/remote", "file"));
    await act(async () => result.current.commitCreate("new.txt"));

    expect(invokeMock).toHaveBeenCalledWith("fs_create_file", {
      path: "/remote/new.txt",
      workspace: { kind: "local" },
    });
    expect(invokeMock).not.toHaveBeenCalledWith("fsb_write", expect.anything());
    expect(result.current.pendingCreate).toBeNull();
    unmount();
  });
});
