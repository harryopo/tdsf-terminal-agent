import { act, cleanup, renderHook } from "@testing-library/react";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorTab, Tab } from "@/modules/tabs";
import { useTabs } from "@/modules/tabs/lib/useTabs";
import * as editorSource from "@/modules/tabs/lib/editorWorkspace";
import { useTabCloseGuards } from "./useTabCloseGuards";

vi.mock("@/modules/terminal", () => ({ leafHasForegroundProcess: vi.fn(), leafIds: vi.fn() }));
afterEach(cleanup);
const a = { kind: "wsl" as const, distro: "A" };
const b = { kind: "wsl" as const, distro: "B" };
function editor(id: number, path: string, source = a, dirty = false): EditorTab {
  return { id, kind: "editor", spaceId: `space-${id}`, path, title: "file", preview: false, dirty, workspace: source };
}
const tabs: Tab[] = [editor(1, "/srv/file"), editor(2, "/srv/sub/draft", a, true),
  editor(3, "/srv/file", b), { ...editor(4, "/srv/file"), remote: { sessionId: "ssh-one" } },
  editor(5, "/srv-other/file")];

// Execute the actual app callback without loading the entire native app.
function appRenameCallback(current: Tab[], updateTab: (id: number, patch: unknown) => void) {
  const path = "src/app/App.tsx", source = readFileSync(path, "utf8");
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const matches: ts.Node[] = [];
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "handlePathRenamed" &&
      node.initializer && ts.isCallExpression(node.initializer)) matches.push(node.initializer.arguments[0]!);
    ts.forEachChild(node, visit);
  }
  visit(file);
  expect(matches).toHaveLength(1);
  const code = ts.transpile(`const callback = (${matches[0]!.getText(file)});`, { target: ts.ScriptTarget.ES2022 });
  return new Function("tabs", "tabsRef", "updateTab", "editorMatchesSource", `${code}; return callback;`)(
    current, { current }, updateTab, Reflect.get(editorSource, "editorMatchesSource"),
  ) as (from: string, to: string, source: unknown) => void;
}

describe("source-owned file mutation notifications", () => {
  it("carries the relocation signal through the real tab update action", () => {
    const { result } = renderHook(() => useTabs());
    act(() => result.current.replaceTabs([editor(9, "/srv/file", a, true)], 9));
    act(() => result.current.updateTab(9, { path: "/srv/new", relocation: { from: "/srv/file", to: "/srv/new" } }));
    expect(result.current.tabs[0]).toMatchObject({ path: "/srv/new", dirty: true, relocation: { from: "/srv/file", to: "/srv/new" } });
  });
  it("renames only the same WSL source across spaces, preserves directory boundaries and emits relocation", () => {
    const update = vi.fn();
    appRenameCallback(tabs, update)("/srv", "/renamed", a);
    expect(update.mock.calls.map(([id]) => id)).toEqual([1, 2]);
    expect(update).toHaveBeenCalledWith(2, expect.objectContaining({ path: "/renamed/sub/draft", relocation: { from: "/srv/sub/draft", to: "/renamed/sub/draft" } }));
  });
  it("matches SSH UUID rather than path or host and ignores an unknown source", () => {
    const remote = [...tabs, { ...editor(6, "/srv/file"), remote: { sessionId: "ssh-two" } }];
    const update = vi.fn(), rename = appRenameCallback(remote, update);
    rename("/srv/file", "/srv/new", { kind: "ssh", sessionId: "ssh-one" });
    expect(update.mock.calls.map(([id]) => id)).toEqual([4]);
    update.mockClear();
    rename("/srv/file", "/srv/new", null);
    expect(update).not.toHaveBeenCalled();
  });
  it("closes only same-source clean pages and confirms only same-source dirty pages", () => {
    const disposeTab = vi.fn();
    const { result } = renderHook(() => useTabCloseGuards({ tabs, disposeTab }));
    act(() => result.current.handlePathDeleted("/srv", a));
    expect(disposeTab.mock.calls.map(([id]) => id)).toEqual([1]);
    expect(result.current.pendingDeleteTabs).toEqual([2]);
    act(() => result.current.cancelDeleteClose());
    expect(disposeTab).toHaveBeenCalledTimes(1);
  });
  it("uses current pages when an old operation callback completes late", () => {
    const disposeTab = vi.fn();
    const { result, rerender } = renderHook(({ current }) => useTabCloseGuards({ tabs: current, disposeTab }), { initialProps: { current: [tabs[0]!] } });
    const oldHandler = result.current.handlePathDeleted;
    rerender({ current: [editor(9, "/srv/file", a, true), editor(10, "/srv/file", b)] });
    act(() => oldHandler("/srv/file", a));
    expect(disposeTab).not.toHaveBeenCalled();
    expect(result.current.pendingDeleteTabs).toEqual([9]);
  });
});
