import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: (selector: (state: Record<string, boolean>) => unknown) =>
    selector({ showHidden: false, explorerGitDecorations: false }),
}));
vi.mock("@/modules/workspace", () => ({ ipcWorkspaceEnv: () => ({ kind: "local" }) }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

type RawEntry = {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  mtime: number;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const dir = (name: string, path: string): RawEntry => ({
  name,
  path,
  is_dir: true,
  size: 0,
  mtime: 0,
});
const file = (name: string, path: string): RawEntry => ({
  name,
  path,
  is_dir: false,
  size: 1,
  mtime: 0,
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("useFileTree request lifecycle", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    watchAddMock.mockReset();
    watchRemoveMock.mockReset();
    listenFsChangedMock.mockReset().mockResolvedValue(() => {});
  });

  it.each(["success", "error"] as const)(
    "ignores a stale same-path %s after an SFTP session switch and preserves the new subtree",
    async (staleOutcome) => {
      const oldRequest = deferred<RawEntry[]>();
      const newRootRequest = deferred<RawEntry[]>();
      const newChildRequest = deferred<RawEntry[]>();
      invokeMock.mockImplementation(
        (_command: string, args: { sessionId: number; path: string }) => {
          if (args.sessionId === 1) return oldRequest.promise;
          return args.path === "/" ? newRootRequest.promise : newChildRequest.promise;
        },
      );
      const { result, rerender, unmount } = renderHook(
        ({ sessionId }) =>
          useFileTree("/", { source: { kind: "sftp", sessionId, root: "/" } }),
        { initialProps: { sessionId: 1 } },
      );
      rerender({ sessionId: 2 });
      await act(async () => {
        newRootRequest.resolve([dir("fresh", "/fresh")]);
        await newRootRequest.promise;
      });
      act(() => result.current.expand("/fresh"));
      await act(async () => {
        newChildRequest.resolve([file("child.txt", "/fresh/child.txt")]);
        await newChildRequest.promise;
      });
      await act(async () => {
        if (staleOutcome === "success") oldRequest.resolve([dir("stale", "/stale")]);
        else oldRequest.reject(new Error("old session failed"));
        await oldRequest.promise.catch(() => {});
      });
      expect(result.current.nodes["/"]).toMatchObject({
        status: "loaded",
        entries: [expect.objectContaining({ name: "fresh" })],
      });
      expect(result.current.nodes["/fresh"]).toMatchObject({
        status: "loaded",
        entries: [expect.objectContaining({ name: "child.txt" })],
      });
      expect(result.current.expanded.has("/fresh")).toBe(true);
      act(() => result.current.toggle("/fresh"));
      unmount();
    },
  );

  it("rejects an old A response after root changes A to B and back to A", async () => {
    const firstA = deferred<RawEntry[]>();
    const b = deferred<RawEntry[]>();
    const latestA = deferred<RawEntry[]>();
    let aCount = 0;
    invokeMock.mockImplementation((_command: string, args: { path: string }) => {
      if (args.path === "/A") return (++aCount === 1 ? firstA : latestA).promise;
      return b.promise;
    });
    const { result, rerender, unmount } = renderHook(
      ({ root }) => useFileTree(root, { source: { kind: "sftp", sessionId: 4, root: "/" } }),
      { initialProps: { root: "/A" } },
    );
    rerender({ root: "/B" });
    rerender({ root: "/A" });
    await act(async () => {
      latestA.resolve([file("current.txt", "/A/current.txt")]);
      await latestA.promise;
    });
    await act(async () => {
      firstA.resolve([file("old.txt", "/A/old.txt")]);
      await firstA.promise;
    });
    expect(result.current.nodes["/A"]).toMatchObject({
      status: "loaded",
      entries: [expect.objectContaining({ name: "current.txt" })],
    });
    unmount();
  });

  it.each(["success", "error"] as const)(
    "keeps the latest same-path refresh when the older request finishes with %s",
    async (staleOutcome) => {
      const requests: Array<ReturnType<typeof deferred<RawEntry[]>>> = [];
      invokeMock.mockImplementation(() => {
        const request = deferred<RawEntry[]>();
        requests.push(request);
        return request.promise;
      });
      const { result, unmount } = renderHook(() =>
        useFileTree("/refresh", { source: { kind: "sftp", sessionId: 8, root: "/" } }),
      );
      await act(async () => {
        requests[0].resolve([file("initial", "/refresh/initial")]);
        await requests[0].promise;
      });
      act(() => result.current.refresh("/refresh"));
      act(() => result.current.refresh("/refresh"));
      const older = requests[1];
      const latest = requests[2];
      await act(async () => {
        latest.resolve([file("latest", "/refresh/latest")]);
        await latest.promise;
      });
      await act(async () => {
        if (staleOutcome === "success") older.resolve([file("older", "/refresh/older")]);
        else older.reject(new Error("stale refresh failed"));
        await older.promise.catch(() => {});
      });
      expect(result.current.nodes["/refresh"]).toMatchObject({
        status: "loaded",
        entries: [expect.objectContaining({ name: "latest" })],
      });
      unmount();
    },
  );

  it("loads a real child directory alongside the root and displays its current error", async () => {
    const requests = new Map<string, Array<ReturnType<typeof deferred<RawEntry[]>>>>();
    invokeMock.mockImplementation((_command: string, args: { path: string }) => {
      const request = deferred<RawEntry[]>();
      requests.set(args.path, [...(requests.get(args.path) ?? []), request]);
      return request.promise;
    });
    const { result, unmount } = renderHook(() =>
      useFileTree("/parallel", { source: { kind: "sftp", sessionId: 9, root: "/" } }),
    );
    await act(async () => {
      requests.get("/parallel")?.[0].resolve([dir("child", "/parallel/child")]);
      await requests.get("/parallel")?.[0].promise;
    });
    act(() => result.current.expand("/parallel/child"));
    act(() => result.current.refresh("/parallel"));
    await act(async () => {
      requests.get("/parallel")?.[1].resolve([dir("child", "/parallel/child")]);
      requests.get("/parallel/child")?.[0].reject(new Error("current directory failed"));
      await flush();
    });
    expect(result.current.nodes["/parallel"]).toMatchObject({ status: "loaded" });
    expect(result.current.nodes["/parallel/child"]).toEqual({
      status: "error",
      message: "Error: current directory failed",
    });
    unmount();
  });

  it("does not restore nodes when a request finishes after the root becomes null", async () => {
    const request = deferred<RawEntry[]>();
    invokeMock.mockReturnValue(request.promise);
    const { result, rerender, unmount } = renderHook(
      ({ root }) => useFileTree(root, { source: { kind: "sftp", sessionId: 10, root: "/" } }),
      { initialProps: { root: "/gone" as string | null } },
    );
    rerender({ root: null });
    await act(async () => {
      request.resolve([dir("late", "/late")]);
      await request.promise;
    });
    expect(result.current.nodes).toEqual({});
    unmount();
  });
});
