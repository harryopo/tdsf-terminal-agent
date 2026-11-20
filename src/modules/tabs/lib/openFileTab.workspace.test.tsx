import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSpaces } from "@/modules/spaces/lib/useSpaces";
import { useWorkspaceEnvStore } from "@/modules/workspace";
import { useTabs } from "./useTabs";

const originalSpaces = useSpaces.getState();
const originalWorkspace = useWorkspaceEnvStore.getState();
const a = { kind: "wsl" as const, distro: "A" };
const b = { kind: "wsl" as const, distro: "B" };

beforeEach(() => {
  useSpaces.setState({ spaces: [a, b].map((env) => ({ id: env.distro, name: env.distro,
    root: "/srv", env, createdAt: 1, updatedAt: 1 })), activeId: "A" });
  useWorkspaceEnvStore.setState({ env: a });
});
afterEach(() => {
  cleanup();
  useSpaces.setState(originalSpaces, true);
  useWorkspaceEnvStore.setState(originalWorkspace, true);
});

describe("file tab workspace ownership", () => {
  it("keeps same-path WSL files in distinct spaces and reuses only their own tab", () => {
    const { result } = renderHook(() => useTabs());
    act(() => result.current.setActiveSpaceForNewTabs("A"));
    act(() => { result.current.openFileTab("/srv/config"); });
    const first = result.current.tabs.find(t => t.kind === "editor");
    act(() => result.current.setActiveSpaceForNewTabs("B"));
    useWorkspaceEnvStore.setState({ env: b });
    act(() => { result.current.openFileTab("/srv/config"); });
    const editors = result.current.tabs.filter(t => t.kind === "editor");
    expect(editors).toHaveLength(2);
    expect(editors).toEqual(expect.arrayContaining([
      expect.objectContaining({ spaceId: "A", workspace: a }),
      expect.objectContaining({ spaceId: "B", workspace: b }),
    ]));
    act(() => result.current.setActiveSpaceForNewTabs("A"));
    useWorkspaceEnvStore.setState({ env: a });
    act(() => { result.current.openFileTab("/srv/config"); });
    expect(result.current.tabs.filter(t => t.kind === "editor")).toHaveLength(2);
    expect(result.current.activeId).toBe(first?.id);
  });

  it("does not replace another space's preview or its unsaved draft", () => {
    const { result } = renderHook(() => useTabs());
    act(() => result.current.setActiveSpaceForNewTabs("A"));
    act(() => { result.current.openFileTab("/srv/a", false); });
    act(() => result.current.setActiveSpaceForNewTabs("B"));
    useWorkspaceEnvStore.setState({ env: b });
    act(() => { result.current.openFileTab("/srv/b", false); });
    expect(result.current.tabs.filter(t => t.kind === "editor")).toHaveLength(2);
    act(() => { result.current.openFileTab("/srv/c", false); });
    expect(result.current.tabs.filter(t => t.kind === "editor").map(t => t.path)).toEqual(["/srv/a", "/srv/c"]);
  });

  it("retains the original source when an editor tab is moved to another space", () => {
    const { result } = renderHook(() => useTabs());
    act(() => result.current.setActiveSpaceForNewTabs("A"));
    act(() => { result.current.openFileTab("/srv/config"); });
    const editor = result.current.tabs.find(t => t.kind === "editor")!;
    act(() => { result.current.moveTabToSpace(editor.id, "B"); });
    expect(result.current.tabs.find(t => t.id === editor.id)).toMatchObject({ spaceId: "B", workspace: a });
  });

  it("binds an old tab to its own space before moving it", () => {
    const { result } = renderHook(() => useTabs());
    act(() => result.current.replaceTabs([{ id: 9, kind: "editor", spaceId: "A",
      path: "/srv/config", title: "config", dirty: true, preview: false }], 9));
    useWorkspaceEnvStore.setState({ env: b });
    act(() => { result.current.moveTabToSpace(9, "B"); });
    expect(result.current.tabs[0]).toMatchObject({ spaceId: "B", dirty: true, workspace: a });
  });

  it("still deduplicates the same SSH UUID but separates two remote sources", () => {
    const { result } = renderHook(() => useTabs());
    act(() => result.current.setActiveSpaceForNewTabs("A"));
    act(() => { result.current.openFileTab("/srv/config", true, { sessionId: "ssh-one" }); });
    act(() => { result.current.openFileTab("/srv/config", true, { sessionId: "ssh-one" }); });
    expect(result.current.tabs.filter(t => t.kind === "editor")).toHaveLength(1);
    act(() => { result.current.openFileTab("/srv/config", true, { sessionId: "ssh-two" }); });
    expect(result.current.tabs.filter(t => t.kind === "editor")).toHaveLength(2);
  });
});
