import { useRef } from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSpaces, type SpaceMeta } from "@/modules/spaces";
import { useWorkspaceEnvStore, type LocalWorkspaceEnv, type WorkspaceEnv } from "@/modules/workspace";
import type { EditorPaneHandle } from "./EditorPane";
import { useEditorFileSync } from "./useEditorFileSync";

const { isTauriRuntimeMock, invokeMock, getCurrentWebviewWindowMock, listenMock } =
  vi.hoisted(() => ({
    isTauriRuntimeMock: vi.fn(),
    invokeMock: vi.fn(),
    getCurrentWebviewWindowMock: vi.fn(),
    listenMock: vi.fn(),
  }));

vi.mock("@/lib/tauriRuntime", () => ({ isTauriRuntime: isTauriRuntimeMock }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: getCurrentWebviewWindowMock,
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));

import type { EditorTab, Tab } from "@/modules/tabs";

type WatchArgs = { paths: string[]; workspace: LocalWorkspaceEnv };

const local: LocalWorkspaceEnv = { kind: "local" };
const wslA: LocalWorkspaceEnv = { kind: "wsl", distro: "Ubuntu-A" };
const wslB: LocalWorkspaceEnv = { kind: "wsl", distro: "Ubuntu-B" };

function editorTab(
  options: Pick<EditorTab, "id" | "spaceId" | "path"> &
    Partial<Pick<EditorTab, "title" | "dirty" | "preview" | "workspace" | "remote">>,
): EditorTab {
  return {
    kind: "editor",
    title: `tab-${options.id}`,
    dirty: false,
    preview: false,
    ...options,
  };
}

function space(id: string, env: WorkspaceEnv): SpaceMeta {
  return { id, name: id, root: "/", env, createdAt: 1, updatedAt: 1 };
}

function useSync(tabs: Tab[]): void {
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const editorRefs = useRef(new Map<number, EditorPaneHandle>());
  useEditorFileSync({ tabs, tabsRef, editorRefs });
}

function watchCalls(command: "fs_watch_add" | "fs_watch_remove"): WatchArgs[] {
  return invokeMock.mock.calls
    .filter(([name]) => name === command)
    .map(([, args]) => args as WatchArgs);
}

function tauriCalls(
  command: "fs_watch_add" | "fs_watch_remove",
  paths: string[],
  workspace: LocalWorkspaceEnv,
): number {
  return watchCalls(command).filter(
    (call) => call.paths.join("\0") === paths.join("\0") &&
      call.workspace.kind === workspace.kind &&
      (call.workspace.kind !== "wsl" ||
        (workspace.kind === "wsl" && call.workspace.distro === workspace.distro)),
  ).length;
}

const explicitSourceCases: Array<{
  label: string;
  source: LocalWorkspaceEnv;
  global: WorkspaceEnv;
}> = [
  { label: "explicit local source", source: local, global: wslA },
  { label: "explicit WSL source", source: wslA, global: local },
];

describe("useEditorFileSync watch workspace ownership", () => {
  const originalSpaces = useSpaces.getState();
  const originalWorkspace = useWorkspaceEnvStore.getState();

  beforeEach(() => {
    invokeMock.mockReset().mockResolvedValue(undefined);
    listenMock.mockReset().mockResolvedValue(() => {});
    getCurrentWebviewWindowMock.mockReset().mockReturnValue({ listen: listenMock });
    isTauriRuntimeMock.mockReset().mockReturnValue(true);
    useSpaces.setState({ spaces: [], activeId: null });
    useWorkspaceEnvStore.setState({ env: local });
  });

  afterEach(() => {
    cleanup();
    useSpaces.setState(originalSpaces, true);
    useWorkspaceEnvStore.setState(originalWorkspace, true);
  });

  it.each(explicitSourceCases)("uses $label instead of the global workspace", ({ source, global }) => {
    useWorkspaceEnvStore.setState({ env: global });
    const tab = editorTab({ id: 1, spaceId: "default", path: "/owned/file.ts", workspace: source });
    const { unmount } = renderHook(() => useSync([tab]));

    expect(watchCalls("fs_watch_add")).toEqual([
      { paths: ["/owned"], workspace: source },
    ]);
    unmount();
    expect(watchCalls("fs_watch_remove")).toEqual([
      { paths: ["/owned"], workspace: source },
    ]);
  });

  it("acquires a shared parent once and releases it only after its last same-owner tab closes", () => {
    const first = editorTab({ id: 1, spaceId: "default", path: "/shared/one.ts", workspace: local });
    const second = editorTab({ id: 2, spaceId: "default", path: "/shared/two.ts", workspace: local });
    const { rerender, unmount } = renderHook(({ tabs }: { tabs: Tab[] }) => useSync(tabs), {
      initialProps: { tabs: [first, second] },
    });

    expect(watchCalls("fs_watch_add")).toEqual([{ paths: ["/shared"], workspace: local }]);
    rerender({ tabs: [second] });
    expect(watchCalls("fs_watch_remove")).toEqual([]);
    rerender({ tabs: [] });
    expect(watchCalls("fs_watch_remove")).toEqual([{ paths: ["/shared"], workspace: local }]);
    unmount();
  });

  it("keeps same-path WSL watches independent when the global workspace changes", () => {
    useWorkspaceEnvStore.setState({ env: local });
    const a = editorTab({ id: 1, spaceId: "A", path: "/same/file.ts", workspace: wslA });
    const b = editorTab({ id: 2, spaceId: "B", path: "/same/file.ts", workspace: wslB });
    const { rerender, unmount } = renderHook(({ tabs }: { tabs: Tab[] }) => useSync(tabs), {
      initialProps: { tabs: [a, b] },
    });

    expect(watchCalls("fs_watch_add")).toEqual([
      { paths: ["/same"], workspace: wslA },
      { paths: ["/same"], workspace: wslB },
    ]);
    act(() => useWorkspaceEnvStore.setState({ env: { kind: "wsl", distro: "Global-C" } }));
    rerender({ tabs: [b] });
    expect(watchCalls("fs_watch_remove")).toEqual([{ paths: ["/same"], workspace: wslA }]);
    rerender({ tabs: [] });
    expect(watchCalls("fs_watch_remove")).toEqual([
      { paths: ["/same"], workspace: wslA },
      { paths: ["/same"], workspace: wslB },
    ]);
    unmount();
  });

  it("releases the previous path and source when acquiring the changed path and source", () => {
    const oldTab = editorTab({ id: 1, spaceId: "A", path: "/old/file.ts", workspace: wslA });
    const { rerender, unmount } = renderHook(({ tab }: { tab: EditorTab }) => useSync([tab]), {
      initialProps: { tab: oldTab },
    });
    const movedPath = editorTab({ ...oldTab, path: "/new/file.ts" });
    rerender({ tab: movedPath });
    const movedSource = editorTab({ ...movedPath, workspace: wslB });
    rerender({ tab: movedSource });

    expect(watchCalls("fs_watch_add")).toEqual([
      { paths: ["/old"], workspace: wslA },
      { paths: ["/new"], workspace: wslA },
      { paths: ["/new"], workspace: wslB },
    ]);
    expect(watchCalls("fs_watch_remove")).toEqual([
      { paths: ["/old"], workspace: wslA },
      { paths: ["/new"], workspace: wslA },
    ]);
    unmount();
  });

  it("does not reacquire a watch for title- or dirty-only tab changes", () => {
    const original = editorTab({ id: 1, spaceId: "default", path: "/stable/file.ts", workspace: wslA });
    const { rerender, unmount } = renderHook(({ tab }: { tab: EditorTab }) => useSync([tab]), {
      initialProps: { tab: original },
    });
    const renamed = editorTab({ ...original, title: "renamed" });
    rerender({ tab: renamed });
    rerender({ tab: editorTab({ ...renamed, dirty: true }) });

    expect(watchCalls("fs_watch_add")).toEqual([{ paths: ["/stable"], workspace: wslA }]);
    expect(watchCalls("fs_watch_remove")).toEqual([]);
    unmount();
  });

  it("unmounts each latest workspace group once after global and tab changes", () => {
    const first = editorTab({ id: 1, spaceId: "A", path: "/before/file.ts", workspace: wslA });
    const { rerender, unmount } = renderHook(({ tabs }: { tabs: Tab[] }) => useSync(tabs), {
      initialProps: { tabs: [first] },
    });
    const latest = editorTab({ ...first, path: "/after/file.ts", workspace: wslB });
    const localTab = editorTab({ id: 2, spaceId: "default", path: "/local/file.ts", workspace: local });
    rerender({ tabs: [latest, localTab] });
    act(() => useWorkspaceEnvStore.setState({ env: { kind: "wsl", distro: "Global-C" } }));
    unmount();

    expect(watchCalls("fs_watch_remove")).toEqual([
      { paths: ["/before"], workspace: wslA },
      { paths: ["/after"], workspace: wslB },
      { paths: ["/local"], workspace: local },
    ]);
    expect(tauriCalls("fs_watch_remove", ["/after"], wslB)).toBe(1);
  });

  it("balances repeated mount and unmount cycles for the same owner", () => {
    const tab = editorTab({ id: 1, spaceId: "default", path: "/repeat/file.ts", workspace: local });
    const first = renderHook(() => useSync([tab]));
    first.unmount();
    const second = renderHook(() => useSync([tab]));
    second.unmount();

    expect(tauriCalls("fs_watch_add", ["/repeat"], local)).toBe(2);
    expect(tauriCalls("fs_watch_remove", ["/repeat"], local)).toBe(2);
  });

  it("balances watch acquire and release under StrictMode effect replay", () => {
    const tab = editorTab({ id: 1, spaceId: "default", path: "/strict/file.ts", workspace: wslA });
    const { unmount } = renderHook(() => useSync([tab]), { reactStrictMode: true });
    unmount();

    expect(tauriCalls("fs_watch_add", ["/strict"], wslA)).toBe(2);
    expect(tauriCalls("fs_watch_remove", ["/strict"], wslA)).toBe(2);
  });

  it("uses a known legacy tab's own Space and skips unknown, null, and remote sources", () => {
    useSpaces.setState({ spaces: [space("legacy-A", wslA)], activeId: "legacy-A" });
    useWorkspaceEnvStore.setState({ env: wslB });
    const knownLegacy = editorTab({ id: 1, spaceId: "legacy-A", path: "/legacy/file.ts" });
    const unknownLegacy = editorTab({ id: 2, spaceId: "missing", path: "/unknown/file.ts" });
    const explicitNull = editorTab({ id: 3, spaceId: "legacy-A", path: "/null/file.ts", workspace: null });
    const remote = editorTab({ id: 4, spaceId: "legacy-A", path: "/remote/file.ts", remote: { sessionId: "ssh-tab" } });
    const { rerender, unmount } = renderHook(({ tabs }: { tabs: Tab[] }) => useSync(tabs), {
      initialProps: { tabs: [knownLegacy, unknownLegacy, explicitNull, remote] },
    });

    expect(watchCalls("fs_watch_add")).toEqual([{ paths: ["/legacy"], workspace: wslA }]);
    rerender({ tabs: [] });
    expect(watchCalls("fs_watch_remove")).toEqual([{ paths: ["/legacy"], workspace: wslA }]);
    unmount();
  });
});
