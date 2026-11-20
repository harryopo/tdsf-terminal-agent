import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

type Request = {
  path: string;
  response: ReturnType<typeof deferred>;
};

const pendingRequests = new Set<ReturnType<typeof deferred>>();

function deferred() {
  let resolve!: (value: Entry[]) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<Entry[]>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const request = { promise, resolve, reject };
  pendingRequests.add(request);
  void promise.then(
    () => pendingRequests.delete(request),
    () => pendingRequests.delete(request),
  );
  return request;
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

function controlledRequests() {
  const requests: Request[] = [];
  invokeMock.mockImplementation((command: string, args: { path: string }) => {
    expect(command).toBe("fs_read_dir");
    const response = deferred();
    requests.push({ path: args.path, response });
    return response.promise;
  });
  return requests;
}

async function resolveRequest(request: Request, entries: Entry[]) {
  await act(async () => {
    request.response.resolve(entries);
    await request.response.promise;
  });
}

async function rejectRequest(request: Request, error: Error) {
  await act(async () => {
    request.response.reject(error);
    await request.response.promise.catch(() => {});
  });
}

async function removeTree(
  root: string,
  child: string,
  result: { current: ReturnType<typeof useFileTree> },
  requests: Request[],
  retainedEntries: Entry[] = [file("still-here.txt")],
) {
  expect(result.current.nodes[child]).toEqual({ status: "loading" });
  act(() => result.current.refresh(root));
  const parentRefresh = requests.filter((request) => request.path === root).at(-1);
  expect(parentRefresh).toBeDefined();
  await resolveRequest(parentRefresh!, retainedEntries);
  expect(result.current.nodes[child]).toBeUndefined();
  expect(watchRemoveMock).toHaveBeenCalledWith([child], { kind: "local" });
}

describe("useFileTree removed subtree listing lifecycle", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    watchAddMock.mockReset();
    watchRemoveMock.mockReset();
    listenFsChangedMock.mockReset().mockResolvedValue(() => {});
  });

  afterEach(async () => {
    cleanup();
    await act(async () => {
      const pending = [...pendingRequests];
      pending.forEach((request) => request.resolve([]));
      await Promise.allSettled(pending.map((request) => request.promise));
    });
  });

  it("ignores a late successful child listing after the parent removes that directory", async () => {
    const requests = controlledRequests();
    const root = "/subtree-late-success";
    const child = `${root}/gone`;
    const { result, unmount } = renderHook(() => useFileTree(root));
    await resolveRequest(requests[0], [dir("gone")]);
    act(() => result.current.expand(child));
    expect(requests.map(({ path }) => path)).toEqual([root, child]);

    await removeTree(root, child, result, requests);
    await resolveRequest(requests[1], [file("resurrected.txt")]);
    expect(result.current.nodes[child]).toBeUndefined();
    unmount();
  });

  it("ignores a late child error after the parent removes that directory", async () => {
    const requests = controlledRequests();
    const root = "/subtree-late-error";
    const child = `${root}/gone`;
    const { result, unmount } = renderHook(() => useFileTree(root));
    await resolveRequest(requests[0], [dir("gone")]);
    act(() => result.current.expand(child));
    await removeTree(root, child, result, requests);
    await rejectRequest(requests[1], new Error("late child failure"));
    expect(result.current.nodes[child]).toBeUndefined();
    unmount();
  });

  it("rejects a removed remote directory's late SFTP listing", async () => {
    const root = "/subtree-remote";
    const child = `${root}/gone`;
    const requests: Request[] = [];
    invokeMock.mockImplementation((command: string, args: { path: string; sessionId: number }) => {
      expect(command).toBe("fsb_list");
      expect(args.sessionId).toBe(63);
      const response = deferred();
      requests.push({ path: args.path, response });
      return response.promise;
    });
    const { result, unmount } = renderHook(() =>
      useFileTree(root, { source: { kind: "sftp", sessionId: 63, root: "/" } }),
    );
    const remoteDirectory = { ...dir("gone"), is_dir: true, path: child };
    await resolveRequest(requests[0], [remoteDirectory]);
    act(() => result.current.expand(child));
    expect(requests.map(({ path }) => path)).toEqual([root, child]);
    expect(result.current.nodes[child]).toEqual({ status: "loading" });
    act(() => result.current.refresh(root));
    await resolveRequest(requests[2], []);
    expect(result.current.nodes[child]).toBeUndefined();
    const remoteFile = { ...file("late.txt"), is_dir: false, path: `${child}/late.txt` };
    await resolveRequest(requests[1], [remoteFile]);
    expect(result.current.nodes[child]).toBeUndefined();
    expect(watchAddMock).not.toHaveBeenCalled();
    unmount();
  });

  it("invalidates pending listings at every level beneath a removed subtree root", async () => {
    const requests = controlledRequests();
    const root = "/subtree-deep-pending";
    const parent = `${root}/parent`;
    const child = `${parent}/child`;
    const { result, unmount } = renderHook(() => useFileTree(root));
    await resolveRequest(requests[0], [dir("parent")]);
    act(() => result.current.expand(parent));
    expect(requests[1].path).toBe(parent);
    await resolveRequest(requests[1], [dir("child")]);
    act(() => {
      result.current.refresh(parent);
      result.current.expand(child);
    });
    expect(requests.map(({ path }) => path)).toEqual([root, parent, parent, child]);

    act(() => result.current.refresh(root));
    await resolveRequest(requests[4], [file("remaining.txt")]);
    expect(result.current.nodes[parent]).toBeUndefined();
    expect(result.current.nodes[child]).toBeUndefined();
    await resolveRequest(requests[2], [dir("child")]);
    await resolveRequest(requests[3], [file("late-grandchild.txt")]);
    expect(result.current.nodes[parent]).toBeUndefined();
    expect(result.current.nodes[child]).toBeUndefined();
    unmount();
  });

  it("ignores a removed child's reply before same-name rediscovery", async () => {
    const requests = controlledRequests();
    const root = "/subtree-same-name";
    const child = `${root}/same`;
    const { result, unmount } = renderHook(() => useFileTree(root));
    await resolveRequest(requests[0], [dir("same")]);
    act(() => result.current.expand(child));
    await removeTree(root, child, result, requests, [dir("kept")]);
    expect(result.current.nodes[root]).toMatchObject({
      status: "loaded",
      entries: [expect.objectContaining({ name: "kept", kind: "dir" })],
    });
    await resolveRequest(requests[1], [file("old-entry.txt")]);
    expect(result.current.nodes[child]).toBeUndefined();
    act(() => result.current.refresh(root));
    const rediscovery = requests.filter((request) => request.path === root).at(-1)!;
    await resolveRequest(rediscovery, [dir("same")]);
    act(() => result.current.expand(child));
    const fresh = requests.filter((request) => request.path === child).at(-1)!;
    expect(result.current.nodes[child]).toEqual({ status: "loading" });
    expect(result.current.nodes[child]).not.toHaveProperty("entries");
    await resolveRequest(fresh, [file("new-entry.txt")]);
    expect(result.current.nodes[child]).toMatchObject({
      status: "loaded",
      entries: [expect.objectContaining({ name: "new-entry.txt" })],
    });
    unmount();
  });

  it("keeps the new same-name listing loading when the removed listing replies late", async () => {
    const requests = controlledRequests();
    const root = "/subtree-same-name-overlap";
    const child = `${root}/same`;
    const { result, unmount } = renderHook(() => useFileTree(root));
    await resolveRequest(requests[0], [dir("same")]);
    act(() => result.current.expand(child));
    await removeTree(root, child, result, requests);
    act(() => result.current.refresh(root));
    const rediscovery = requests.filter((request) => request.path === root).at(-1)!;
    await resolveRequest(rediscovery, [dir("same")]);
    act(() => result.current.expand(child));
    const fresh = requests.filter((request) => request.path === child).at(-1)!;
    expect(result.current.nodes[child]).toEqual({ status: "loading" });

    await resolveRequest(requests[1], [file("old-entry.txt")]);
    expect(result.current.nodes[child]).toEqual({ status: "loading" });
    await resolveRequest(fresh, [file("new-entry.txt")]);
    expect(result.current.nodes[child]).toMatchObject({
      status: "loaded",
      entries: [expect.objectContaining({ name: "new-entry.txt" })],
    });
    unmount();
  });

  it("invalidates a child request dispatched in the same turn as its parent refresh", async () => {
    const root = "/subtree-same-turn";
    const child = `${root}/child`;
    const requests: Request[] = [];
    let rootReads = 0;
    invokeMock.mockImplementation((command: string, args: { path: string }) => {
      expect(command).toBe("fs_read_dir");
      const response = deferred();
      requests.push({ path: args.path, response });
      if (args.path === root && rootReads++ > 0) {
        response.resolve([]);
        return Promise.resolve([]);
      }
      return response.promise;
    });
    const { result, unmount } = renderHook(() => useFileTree(root));
    await resolveRequest(requests[0], [dir("child")]);

    await act(async () => {
      result.current.expand(child);
      result.current.refresh(root);
      await requests[2].response.promise;
    });
    expect(requests.map(({ path }) => path)).toEqual([root, child, root]);
    expect(result.current.nodes[child]).toBeUndefined();
    await resolveRequest(requests[1], [file("late-same-turn.txt")]);
    expect(result.current.nodes[child]).toBeUndefined();
    unmount();
  });

  it("allows an unrelated sibling listing to finish while removing a subtree", async () => {
    const requests = controlledRequests();
    const root = "/subtree-sibling";
    const child = `${root}/gone`;
    const sibling = `${root}/kept`;
    const { result, unmount } = renderHook(() => useFileTree(root));
    await resolveRequest(requests[0], [dir("gone"), dir("kept")]);
    act(() => {
      result.current.expand(child);
      result.current.expand(sibling);
    });
    expect(requests.map(({ path }) => path)).toEqual([root, child, sibling]);
    await removeTree(root, child, result, requests, [dir("kept")]);
    expect(result.current.nodes[root]).toMatchObject({
      status: "loaded",
      entries: [expect.objectContaining({ name: "kept", kind: "dir" })],
    });
    await resolveRequest(requests[2], [file("sibling-result.txt")]);
    expect(result.current.nodes[child]).toBeUndefined();
    expect(result.current.nodes[sibling]).toMatchObject({
      status: "loaded",
      entries: [expect.objectContaining({ name: "sibling-result.txt" })],
    });
    unmount();
  });

  it("keeps ordinary loaded-directory refreshes working", async () => {
    const requests = controlledRequests();
    const root = "/subtree-refresh-control";
    const child = `${root}/kept`;
    const { result, unmount } = renderHook(() => useFileTree(root));
    await resolveRequest(requests[0], [dir("kept")]);
    act(() => result.current.expand(child));
    await resolveRequest(requests[1], [file("before.txt")]);
    act(() => result.current.refresh(child));
    expect(requests[2].path).toBe(child);
    await resolveRequest(requests[2], [file("after.txt")]);
    expect(result.current.nodes[child]).toMatchObject({
      status: "loaded",
      entries: [expect.objectContaining({ name: "after.txt" })],
    });
    unmount();
  });

  it("keeps the filesystem root loaded and watched when refreshing '/'", async () => {
    const requests = controlledRequests();
    const root = "/";
    const { result, unmount } = renderHook(() => useFileTree(root));
    await resolveRequest(requests[0], [dir("child")]);
    expect(result.current.nodes[root]).toMatchObject({ status: "loaded" });
    expect(watchAddMock).toHaveBeenCalledWith([root], { kind: "local" });

    act(() => result.current.refresh(root));
    await resolveRequest(requests[1], []);
    expect(result.current.nodes[root]).toMatchObject({
      status: "loaded",
      entries: [],
    });
    expect(watchRemoveMock.mock.calls.flat(2)).not.toContain(root);
    unmount();
  });
});
