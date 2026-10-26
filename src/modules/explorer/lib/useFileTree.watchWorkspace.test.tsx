import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { isTauriRuntimeMock, getCurrentWebviewWindowMock, listenMock, invokeMock } =
  vi.hoisted(() => ({
    isTauriRuntimeMock: vi.fn(),
    getCurrentWebviewWindowMock: vi.fn(),
    listenMock: vi.fn(),
    invokeMock: vi.fn(),
  }));

vi.mock("@/lib/tauriRuntime", () => ({ isTauriRuntime: isTauriRuntimeMock }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: getCurrentWebviewWindowMock,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { usePreferencesStore } from "@/modules/settings/preferences";
import { useWorkspaceEnvStore, type LocalWorkspaceEnv, type WorkspaceEnv } from "@/modules/workspace";
import { useFileTree, type DirEntry } from "./useFileTree";
import { listenFsChanged, watchAdd, watchRemove } from "./watch";

type InvokeArgs = Record<string, unknown>;

const dir = (name: string): DirEntry => ({
  name,
  kind: "dir",
  size: 0,
  mtime: 0,
  gitignored: false,
});

function setEnv(env: WorkspaceEnv): void {
  useWorkspaceEnvStore.setState({ env });
}

function configureListings(listings: Record<string, DirEntry[][]> = {}): void {
  const remaining = new Map(
    Object.entries(listings).map(([path, responses]) => [path, [...responses]]),
  );
  invokeMock.mockImplementation((command: string, args: InvokeArgs = {}) => {
    if (command === "fs_read_dir") {
      const path = args.path as string;
      return Promise.resolve(remaining.get(path)?.shift() ?? []);
    }
    if (command === "fsb_list") return Promise.resolve([]);
    return Promise.resolve(undefined);
  });
}

function callsFor(command: string): InvokeArgs[] {
  return invokeMock.mock.calls
    .filter(([name]) => name === command)
    .map(([, args]) => args as InvokeArgs);
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

const explicitWorkspaceCases: Array<{
  label: string;
  workspace: LocalWorkspaceEnv;
  globalEnv: WorkspaceEnv;
}> = [
  {
    label: "explicit WSL source while the global environment is local",
    workspace: { kind: "wsl", distro: "Ubuntu-24.04" },
    globalEnv: { kind: "local" },
  },
  {
    label: "explicit local source while the global environment is WSL",
    workspace: { kind: "local" },
    globalEnv: { kind: "wsl", distro: "Debian" },
  },
];

describe("useFileTree watch workspace ownership", () => {
  let originalEnv: WorkspaceEnv;
  let originalPreferences = { showHidden: false, explorerGitDecorations: false };

  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset().mockResolvedValue(() => {});
    getCurrentWebviewWindowMock.mockReset().mockReturnValue({ listen: listenMock });
    isTauriRuntimeMock.mockReset().mockReturnValue(true);
    originalEnv = useWorkspaceEnvStore.getState().env;
    const preferences = usePreferencesStore.getState();
    originalPreferences = {
      showHidden: preferences.showHidden,
      explorerGitDecorations: preferences.explorerGitDecorations,
    };
    usePreferencesStore.setState({ showHidden: false, explorerGitDecorations: false });
  });

  afterEach(() => {
    cleanup();
    setEnv(originalEnv);
    usePreferencesStore.setState(originalPreferences);
  });

  it.each(explicitWorkspaceCases)("uses $label for directory reads and the root watch", async ({ workspace, globalEnv }) => {
    setEnv(globalEnv);
    configureListings();
    const root = "/workspace-watch-owner";
    const { unmount } = renderHook(() =>
      useFileTree(root, { source: { kind: "local", workspace } }),
    );
    await flushEffects();

    expect(callsFor("fs_read_dir")[0]).toMatchObject({ path: root, workspace });
    expect(callsFor("fs_watch_add")).toEqual([{ paths: [root], workspace }]);
    unmount();
    expect(callsFor("fs_watch_remove")).toEqual([{ paths: [root], workspace }]);
  });

  it("removes the old same-path WSL watch from its original distro when the source changes", async () => {
    const workspaceA: LocalWorkspaceEnv = { kind: "wsl", distro: "Ubuntu-A" };
    const workspaceB: LocalWorkspaceEnv = { kind: "wsl", distro: "Ubuntu-B" };
    setEnv({ kind: "local" });
    configureListings();
    const root = "/same-path-watch-owner";
    const { rerender, unmount } = renderHook(
      ({ workspace }: { workspace: LocalWorkspaceEnv }) =>
        useFileTree(root, { source: { kind: "local", workspace } }),
      { initialProps: { workspace: workspaceA } },
    );
    await flushEffects();

    rerender({ workspace: workspaceB });
    await flushEffects();
    expect(callsFor("fs_watch_remove")).toEqual([{ paths: [root], workspace: workspaceA }]);
    expect(callsFor("fs_watch_add")).toEqual([
      { paths: [root], workspace: workspaceA },
      { paths: [root], workspace: workspaceB },
    ]);
    unmount();
  });

  it("keeps the original workspace for expand, collapse, and subtree pruning after global changes", async () => {
    const owner: LocalWorkspaceEnv = { kind: "wsl", distro: "Ubuntu-Owner" };
    setEnv(owner);
    const root = "/watch-owner-prune";
    const child = `${root}/child`;
    configureListings({ [root]: [[dir("child")], []], [child]: [[], []] });
    const { result, unmount } = renderHook(() =>
      useFileTree(root, { source: { kind: "local", workspace: owner } }),
    );
    await flushEffects();
    setEnv({ kind: "wsl", distro: "Ubuntu-Other" });

    act(() => result.current.expand(child));
    await flushEffects();
    expect(callsFor("fs_watch_add")).toContainEqual({ paths: [child], workspace: owner });
    act(() => result.current.toggle(child));
    await flushEffects();
    expect(callsFor("fs_watch_remove")).toContainEqual({ paths: [child], workspace: owner });

    act(() => result.current.expand(child));
    await flushEffects();
    act(() => result.current.refresh(root));
    await flushEffects();
    expect(callsFor("fs_watch_remove").filter((args) => (args.paths as string[]).includes(child)))
      .toEqual([
        { paths: [child], workspace: owner },
        { paths: [child], workspace: owner },
      ]);
    unmount();
  });

  it.each(["root-null", "unmount"] as const)("cleans the root watch with its owner on %s", async (mode) => {
    const owner: LocalWorkspaceEnv = { kind: "wsl", distro: "Ubuntu-Cleanup" };
    setEnv({ kind: "local" });
    configureListings();
    const root = "/watch-owner-cleanup";
    const { rerender, unmount } = renderHook(
      ({ path }: { path: string | null }) =>
        useFileTree(path, { source: { kind: "local", workspace: owner } }),
      { initialProps: { path: root as string | null } },
    );
    await flushEffects();
    setEnv({ kind: "wsl", distro: "Ubuntu-Changed" });

    if (mode === "root-null") {
      rerender({ path: null });
      await flushEffects();
    } else {
      unmount();
    }
    expect(callsFor("fs_watch_remove")).toContainEqual({ paths: [root], workspace: owner });
    if (mode === "root-null") unmount();
  });

  it("does not register local watches for an SFTP source", async () => {
    setEnv({ kind: "wsl", distro: "Global-Workspace" });
    configureListings();
    const root = "/srv/sftp-root";
    const { unmount } = renderHook(() =>
      useFileTree(root, { source: { kind: "sftp", sessionId: 71, root: "/srv" } }),
    );
    await flushEffects();
    expect(callsFor("fsb_list")).toContainEqual({ sessionId: 71, root: "/srv", path: root });
    expect(callsFor("fs_watch_add")).toEqual([]);
    expect(callsFor("fs_watch_remove")).toEqual([]);
    unmount();
  });

  it("preserves the one-argument watch bridge behavior for direct callers", () => {
    const workspace: LocalWorkspaceEnv = { kind: "wsl", distro: "Default-Bridge" };
    setEnv(workspace);
    configureListings();
    watchAdd(["/direct-watch"]);
    watchRemove(["/direct-watch"]);
    expect(callsFor("fs_watch_add")).toContainEqual({ paths: ["/direct-watch"], workspace });
    expect(callsFor("fs_watch_remove")).toContainEqual({ paths: ["/direct-watch"], workspace });
  });

  it("keeps the watch bridge a no-op outside the Tauri runtime", async () => {
    isTauriRuntimeMock.mockReturnValue(false);
    invokeMock.mockReset();
    watchAdd(["/browser-watch"]);
    watchRemove(["/browser-watch"]);
    const unlisten = await listenFsChanged(() => {});
    expect(invokeMock).not.toHaveBeenCalled();
    expect(listenMock).not.toHaveBeenCalled();
    expect(unlisten).toBeTypeOf("function");
  });
});
