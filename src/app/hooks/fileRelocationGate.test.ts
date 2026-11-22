import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { editorMatchesSource } from "@/modules/tabs/lib/editorWorkspace";
import { fileSourceKey } from "@/modules/workspace/fileSource";
import type { EditorTab } from "@/modules/tabs";
import type { LocalWorkspaceEnv } from "@/modules/workspace";

function callback(name: string, environment: Record<string, unknown>) {
  const source = readFileSync("src/app/App.tsx", "utf8");
  const file = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const matches: ts.Node[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name &&
      node.initializer && ts.isCallExpression(node.initializer)) matches.push(node.initializer.arguments[0]!);
    ts.forEachChild(node, visit);
  };
  visit(file);
  expect(matches).toHaveLength(1);
  const code = ts.transpile(`const callback=(${matches[0]!.getText(file)});`, { target: ts.ScriptTarget.ES2022 });
  return new Function(...Object.keys(environment), `${code};return callback;`)(...Object.values(environment));
}
const a = { kind: "wsl", distro: "A" } as const;
const b = { kind: "wsl", distro: "B" } as const;
function editor(id: number, path: string, workspace: LocalWorkspaceEnv = a): EditorTab {
  return { id, path, workspace, kind: "editor", spaceId: String(id), title: "file", dirty: true, preview: false };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}
function setup() {
  const first = deferred(), second = deferred();
  const cancel1 = vi.fn(), cancel2 = vi.fn();
  const handles = [
    { beginRelocation: vi.fn(() => ({ ready: first.promise, cancel: cancel1 })) },
    { beginRelocation: vi.fn(() => ({ ready: second.promise, cancel: cancel2 })) },
    { beginRelocation: vi.fn(() => ({ ready: Promise.resolve(), cancel: vi.fn() })) },
  ];
  const environment = {
    tabsRef: { current: [editor(1, "/srv/file"), editor(2, "/srv/sub/file"), editor(3, "/srv/file", b), editor(4, "/srv-other/file")] },
    editorRefs: { current: new Map(handles.map((h, i) => [i + 1, h])) },
    fileRelocationsRef: { current: [] }, editorMatchesSource, fileSourceKey,
    pendingFileSaves: () => [] as Promise<unknown>[],
  };
  const before = callback("handleBeforePathRenamed", environment) as (from: string, to: string, source: unknown) => Promise<(committed: boolean) => void>;
  const isMoving = callback("isFileRelocating", environment) as (path: string, source: unknown) => boolean;
  return { first, second, cancel1, cancel2, handles, before, isMoving, environment };
}

describe("App source-owned relocation preflight", () => {
  it("waits for an already closed editor's pending file write", async () => {
    const s = setup(), writing = deferred();
    s.environment.tabsRef.current = [];
    s.environment.pendingFileSaves = () => [writing.promise];
    const before = callback("handleBeforePathRenamed", s.environment) as typeof s.before;
    let settled = false;
    const pending = before("/srv", "/moved", a).then(finish => { settled = true; return finish; });
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);
    writing.resolve(); (await pending)(true);
    expect(settled).toBe(true);
  });

  it("pauses only same-source descendants and waits for every editor", async () => {
    const s = setup();
    let settled = false;
    const pending = s.before("/srv", "/moved", a).then(finish => { settled = true; return finish; });
    expect(s.handles[0]!.beginRelocation).toHaveBeenCalledWith("/moved/file");
    expect(s.handles[1]!.beginRelocation).toHaveBeenCalledWith("/moved/sub/file");
    expect(s.handles[2]!.beginRelocation).not.toHaveBeenCalled();
    s.first.resolve();
    await Promise.resolve();
    expect(settled).toBe(false);
    s.second.resolve();
    const finish = await pending;
    finish(true);
    expect(s.cancel1).not.toHaveBeenCalled();
    expect(s.cancel2).not.toHaveBeenCalled();
  });

  it("keeps old and new paths closed to re-open until completion, without blocking another source", async () => {
    const s = setup(), pending = s.before("/srv", "/moved", a);
    expect(s.isMoving("/srv/file", a)).toBe(true);
    expect(s.isMoving("/moved/file", a)).toBe(true);
    expect(s.isMoving("/srv-other/file", a)).toBe(false);
    expect(s.isMoving("/srv/file", b)).toBe(false);
    const open = vi.fn();
    const openFile = callback("handleOpenFile", {
      isFileRelocating: s.isMoving, ipcWorkspaceEnv: () => a,
      toast: { info: vi.fn() }, isMarkdownPath: () => false, openFileTab: open, newMarkdownTab: vi.fn(),
    });
    openFile("/srv/file");
    expect(open).not.toHaveBeenCalled();
    s.first.resolve(); s.second.resolve();
    (await pending)(false);
    expect(s.cancel1).toHaveBeenCalledOnce();
    expect(s.cancel2).toHaveBeenCalledOnce();
    openFile("/srv/file");
    expect(open).toHaveBeenCalledWith("/srv/file", false);
  });

  it("rejects overlapping operations and rolls back partial preparation when one editor fails", async () => {
    const s = setup();
    s.first.resolve();
    s.handles[1]!.beginRelocation.mockImplementation(() => { throw new Error("migration busy"); });
    await expect(s.before("/srv", "/moved", a)).rejects.toThrow("migration busy");
    expect(s.cancel1).toHaveBeenCalledOnce();
    expect(s.isMoving("/srv/file", a)).toBe(false);
    s.handles[1]!.beginRelocation.mockImplementation(() => ({ ready: s.second.promise, cancel: s.cancel2 }));
    const first = s.before("/srv", "/moved", a);
    await expect(s.before("/srv/sub", "/another", a)).rejects.toThrow();
    s.first.resolve(); s.second.resolve(); (await first)(false);
  });

  it("drains already prepared editors even when a later editor rejects preparation", async () => {
    const s = setup();
    s.handles[1]!.beginRelocation.mockImplementation(() => { throw new Error("second editor busy"); });
    let settled = false;
    const failure = s.before("/srv", "/moved", a).catch(e => { settled = true; return e; });
    await Promise.resolve(); await Promise.resolve();
    expect(settled).toBe(false);
    s.first.resolve();
    expect((await failure).message).toBe("second editor busy");
    expect(s.cancel1).toHaveBeenCalledOnce();
    expect(s.isMoving("/srv/file", a)).toBe(false);
  });

  it("actually wires the FileExplorer before-mutation callback", () => {
    const source = readFileSync("src/app/App.tsx", "utf8");
    expect(source).toMatch(/onBeforePathRenamed=\{handleBeforePathRenamed\}/);
    const explorer = readFileSync("src/modules/explorer/FileExplorer.tsx", "utf8");
    expect(explorer).toMatch(/useFileTree\(rootPath,\s*\{\s*onBeforePathRenamed,/);
  });
});
