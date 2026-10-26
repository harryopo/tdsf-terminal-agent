import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useFileTree } from "./useFileTree";

const { invokeMock, watchAddMock, watchRemoveMock, listenFsChangedMock } =
  vi.hoisted(() => ({
    invokeMock: vi.fn(),
    watchAddMock: vi.fn(),
    watchRemoveMock: vi.fn(),
    listenFsChangedMock: vi.fn(),
  }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("./watch", () => ({
  listenFsChanged: listenFsChangedMock,
  watchAdd: watchAddMock,
  watchRemove: watchRemoveMock,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

type Entry = {
  name: string;
  kind: "file" | "dir" | "symlink";
  size: number;
  mtime: number;
  gitignored: boolean;
};

const pendingRequests = new Set<{
  release: () => void;
  promise: Promise<unknown>;
}>();

function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const pending = { release: () => resolve(fallback), promise };
  pendingRequests.add(pending);
  void promise.then(
    () => pendingRequests.delete(pending),
    () => pendingRequests.delete(pending),
  );
  return { promise, resolve, reject };
}

const file = (name: string): Entry => ({
  name,
  kind: "file",
  size: 1,
  mtime: 0,
  gitignored: false,
});
const dir = (name: string): Entry => ({
  name,
  kind: "dir",
  size: 0,
  mtime: 0,
  gitignored: false,
});

function localRequests() {
  const requests: Array<{
    path: string;
    showHidden: boolean;
    gitDecorations: boolean;
    response: ReturnType<typeof deferred<Entry[]>>;
  }> = [];
  invokeMock.mockImplementation(
    (
      command: string,
      args: { path: string; showHidden: boolean; gitDecorations: boolean },
    ) => {
      expect(command).toBe("fs_read_dir");
      const response = deferred<Entry[]>([]);
      requests.push({ ...args, response });
      return response.promise;
    },
  );
  return requests;
}

async function settle<T>(request: ReturnType<typeof deferred<T>>, value: T) {
  await act(async () => {
    request.resolve(value);
    await request.promise;
  });
}

function setPreferences(patch: { showHidden?: boolean; explorerGitDecorations?: boolean }) {
  act(() => usePreferencesStore.setState(patch));
}

describe("useFileTree display preference request lifecycle", () => {
  let originalPreferences = { showHidden: false, explorerGitDecorations: false };

  beforeEach(() => {
    invokeMock.mockReset();
    watchAddMock.mockReset();
    watchRemoveMock.mockReset();
    listenFsChangedMock.mockReset().mockResolvedValue(() => {});
    const state = usePreferencesStore.getState();
    originalPreferences = {
      showHidden: state.showHidden,
      explorerGitDecorations: state.explorerGitDecorations,
    };
    usePreferencesStore.setState({ showHidden: false, explorerGitDecorations: false });
  });

  afterEach(async () => {
    cleanup();
    await act(async () => {
      const pending = [...pendingRequests];
      pending.forEach(({ release }) => release());
      await Promise.allSettled(pending.map(({ promise }) => promise));
    });
    act(() => usePreferencesStore.setState(originalPreferences));
  });

  it.each(["showHidden", "explorerGitDecorations"] as const)(
    "replaces a loading root request when %s changes and ignores its stale success",
    async (preference) => {
      const requests = localRequests();
      const root = `/loading-root-${preference}`;
      const { result, unmount } = renderHook(() => useFileTree(root));
      expect(result.current.nodes[root]).toEqual({ status: "loading" });
      expect(requests).toHaveLength(1);

      setPreferences({ [preference]: true });
      expect(requests).toHaveLength(2);
      expect(requests[1].path).toBe(root);
      expect(
        preference === "showHidden"
          ? requests[1].showHidden
          : requests[1].gitDecorations,
      ).toBe(true);

      await settle(requests[1].response, [file("new-result")]);
      await settle(requests[0].response, [file("stale-result")]);
      expect(result.current.nodes[root]).toMatchObject({
        status: "loaded",
        entries: [expect.objectContaining({ name: "new-result" })],
      });
      unmount();
    },
  );

  it("ignores an old loading-root error after the latest preference request succeeds", async () => {
    const requests = localRequests();
    const { result, unmount } = renderHook(() => useFileTree("/loading-root-error"));
    setPreferences({ showHidden: true });
    expect(requests).toHaveLength(2);
    await settle(requests[1].response, [file("current")]);
    await act(async () => {
      requests[0].response.reject(new Error("stale failure"));
      await requests[0].response.promise.catch(() => {});
    });
    expect(result.current.nodes["/loading-root-error"]).toMatchObject({
      status: "loaded",
      entries: [expect.objectContaining({ name: "current" })],
    });
    unmount();
  });

  it("refreshes both a loading child and its loaded parent, retaining the current child error", async () => {
    const requests = localRequests();
    const { result, unmount } = renderHook(() => useFileTree("/tree-child-error"));
    await settle(requests[0].response, [dir("child")]);
    act(() => result.current.expand("/tree-child-error/child"));
    expect(result.current.nodes["/tree-child-error/child"]).toEqual({ status: "loading" });
    expect(requests.map(({ path }) => path)).toEqual([
      "/tree-child-error",
      "/tree-child-error/child",
    ]);

    setPreferences({ showHidden: true });
    expect(requests.map(({ path }) => path)).toEqual([
      "/tree-child-error",
      "/tree-child-error/child",
      "/tree-child-error",
      "/tree-child-error/child",
    ]);
    expect(requests.slice(2).every((request) => request.showHidden)).toBe(true);
    await settle(requests[2].response, [dir("child")]);
    await act(async () => {
      requests[3].response.reject(new Error("current child failure"));
      await requests[3].response.promise.catch(() => {});
    });
    expect(result.current.nodes["/tree-child-error"]).toMatchObject({ status: "loaded" });
    expect(result.current.nodes["/tree-child-error/child"]).toEqual({
      status: "error",
      message: "Error: current child failure",
    });
    await settle(requests[1].response, [file("stale-child-success")]);
    expect(result.current.nodes["/tree-child-error/child"]).toEqual({
      status: "error",
      message: "Error: current child failure",
    });
    unmount();
  });

  it("does not loop on ordinary tree changes and preserves refresh of loaded directories", async () => {
    const requests = localRequests();
    const { result, unmount } = renderHook(() => useFileTree("/tree-control"));
    await settle(requests[0].response, [dir("child")]);
    expect(requests).toHaveLength(1);
    act(() => result.current.expand("/tree-control/child"));
    await settle(requests[1].response, [file("leaf")]);
    expect(requests.map(({ path }) => path)).toEqual([
      "/tree-control",
      "/tree-control/child",
    ]);

    setPreferences({ showHidden: true });
    expect(requests.map(({ path }) => path)).toEqual([
      "/tree-control",
      "/tree-control/child",
      "/tree-control",
      "/tree-control/child",
    ]);
    expect(requests.slice(2).every((request) => request.showHidden)).toBe(true);
    await settle(requests[2].response, [dir("child")]);
    await settle(requests[3].response, [file("leaf")]);
    expect(requests).toHaveLength(4);
    unmount();
  });

  it("does not automatically retry an errored local directory when a display preference changes", async () => {
    const requests = localRequests();
    const root = "/errored-directory-preference-control";
    const { result, unmount } = renderHook(() => useFileTree(root));
    await act(async () => {
      requests[0].response.reject(new Error("initial listing failed"));
      await requests[0].response.promise.catch(() => {});
    });
    expect(result.current.nodes[root]).toEqual({
      status: "error",
      message: "Error: initial listing failed",
    });
    setPreferences({ showHidden: true });
    expect(requests).toHaveLength(1);
    unmount();
  });

  it("does not query old-root paths or duplicate the new root after switching roots", async () => {
    const requests = localRequests();
    const { result, rerender, unmount } = renderHook(
      ({ root }) => useFileTree(root),
      { initialProps: { root: "/root-a-preference-switch" } },
    );
    await settle(requests[0].response, [dir("child")]);
    act(() => result.current.expand("/root-a-preference-switch/child"));
    await settle(requests[1].response, [file("old-child")]);

    rerender({ root: "/root-b-preference-switch" });
    expect(requests.map(({ path }) => path)).toEqual([
      "/root-a-preference-switch",
      "/root-a-preference-switch/child",
      "/root-b-preference-switch",
    ]);
    expect(result.current.nodes).toEqual({ "/root-b-preference-switch": { status: "loading" } });
    await settle(requests[2].response, [file("new-root")]);
    expect(result.current.nodes["/root-b-preference-switch"]).toMatchObject({
      status: "loaded",
      entries: [expect.objectContaining({ name: "new-root" })],
    });
    expect(result.current.nodes["/root-a-preference-switch"]).toBeUndefined();
    unmount();
  });

  it("does not query old-source child paths or duplicate the root after a same-path source switch", async () => {
    const requests = localRequests();
    const root = "/same-path-source-switch";
    const { result, rerender, unmount } = renderHook(
      ({ workspace }: { workspace: { kind: "local" } | { kind: "wsl"; distro: string } }) =>
        useFileTree(root, { source: { kind: "local", workspace } }),
      { initialProps: { workspace: { kind: "local" } as { kind: "local" } | { kind: "wsl"; distro: string } } },
    );
    await settle(requests[0].response, [dir("child")]);
    act(() => result.current.expand(`${root}/child`));
    await settle(requests[1].response, [file("old-source-child")]);

    rerender({ workspace: { kind: "wsl", distro: "Ubuntu" } });
    expect(requests.map(({ path }) => path)).toEqual([root, `${root}/child`, root]);
    expect(result.current.nodes).toEqual({ [root]: { status: "loading" } });
    expect(requests[2]).toHaveProperty("workspace", { kind: "wsl", distro: "Ubuntu" });
    await settle(requests[2].response, [file("new-source-root")]);
    expect(result.current.nodes[root]).toMatchObject({
      status: "loaded",
      entries: [expect.objectContaining({ name: "new-source-root" })],
    });
    unmount();
  });

  it("keeps SFTP listing independent of display preferences and does not retry errors", async () => {
    const root = "/sftp-preference-control";
    const requests: Array<{ command: string; args: Record<string, unknown>; response: ReturnType<typeof deferred<unknown>> }> = [];
    invokeMock.mockImplementation((command: string, args: Record<string, unknown>) => {
      const response = deferred<unknown>([]);
      requests.push({ command, args, response });
      return response.promise;
    });
    const { result, unmount } = renderHook(() =>
      useFileTree(root, { source: { kind: "sftp", sessionId: 41, root: "/srv" } }),
    );
    expect(result.current.nodes[root]).toEqual({ status: "loading" });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      command: "fsb_list",
      args: { sessionId: 41, root: "/srv", path: root },
    });
    await act(async () => {
      requests[0].response.resolve([
        { name: "file.txt", path: `${root}/file.txt`, is_dir: false, size: 2, mtime: 0 },
      ]);
      await requests[0].response.promise;
    });
    expect(result.current.nodes[root]).toMatchObject({
      status: "loaded",
      entries: [expect.objectContaining({ name: "file.txt" })],
    });
    setPreferences({ showHidden: true, explorerGitDecorations: true });
    expect(requests).toHaveLength(1);
    act(() => result.current.refresh(root));
    expect(requests).toHaveLength(2);
    await act(async () => {
      requests[1].response.reject(new Error("visible SFTP failure"));
      await requests[1].response.promise.catch(() => {});
    });
    expect(result.current.nodes[root]).toEqual({
      status: "error",
      message: "Error: visible SFTP failure",
    });
    setPreferences({ showHidden: false, explorerGitDecorations: false });
    expect(requests).toHaveLength(2);
    unmount();
  });
});
