// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { traceEager } from "../../scripts/eager-graph.mjs";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    statSync: vi.fn(actual.statSync),
  };
});

const existsSyncSpy = vi.mocked(existsSync);
const statSyncSpy = vi.mocked(statSync);
const slash = (path: string) => path.replaceAll("\\", "/");

describe("traceEager resolution cache", () => {
  let fixtureRoot: string;

  beforeEach(() => {
    vi.clearAllMocks();
    fixtureRoot = mkdtempSync(join(tmpdir(), "tdsf-eager-graph-"));
  });

  afterEach(() => {
    if (
      dirname(fixtureRoot) !== resolve(tmpdir()) ||
      !basename(fixtureRoot).startsWith("tdsf-eager-graph-")
    ) {
      throw new Error(
        `Refusing to remove unexpected fixture path: ${fixtureRoot}`,
      );
    }
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function write(path: string, source: string) {
    const target = join(fixtureRoot, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source, "utf8");
    return target;
  }

  function trace(path: string, watch: string[] = []) {
    return traceEager(resolve(fixtureRoot, path), watch);
  }

  function expectCandidateCheckedOnce(path: string) {
    expect(
      existsSyncSpy.mock.calls.filter(([candidate]) => candidate === path),
    ).toHaveLength(1);
  }

  function expectFileStatCheckedOnce(path: string) {
    expect(
      statSyncSpy.mock.calls.filter(([candidate]) => candidate === path),
    ).toHaveLength(1);
  }

  it("resolves a shared static target once across multiple importers", () => {
    const shared = write("shared.ts", 'import "@xterm/xterm";');
    write("entry.ts", 'import "./a";\nimport "./b";');
    write("a.ts", 'import "./shared";');
    write("b.ts", 'import "./shared";');

    const result = trace("entry.ts", ["@xterm"]);

    expect(result.moduleCount).toBe(4);
    expect(result.files.has(slash(shared))).toBe(true);
    expect([...result.hits.keys()]).toEqual(["@xterm"]);
    expectCandidateCheckedOnce(shared);
    expectFileStatCheckedOnce(shared);
  });

  it("resolves a repeated missing target once without adding a graph node", () => {
    const entry = write("entry.ts", 'import "./a";\nimport "./b";');
    write("a.ts", 'import "./missing";');
    write("b.ts", 'import "./missing";');
    const missingCandidate = join(fixtureRoot, "missing.ts");

    const result = trace("entry.ts");

    expect(result.moduleCount).toBe(3);
    expect(result.files.has(slash(missingCandidate))).toBe(false);
    expect(result.files.has(slash(entry))).toBe(true);
    expectCandidateCheckedOnce(missingCandidate);
  });

  it("shares resolution between static and dynamic references while retaining the lazy edge", () => {
    const shared = write("shared.ts", "export const value = 1;");
    write("entry.ts", 'import "./shared";\nvoid import("./shared");');

    const result = trace("entry.ts");

    expect(result.moduleCount).toBe(2);
    expect(result.files.has(slash(shared))).toBe(true);
    expect(result.lazyFiles.has(slash(shared))).toBe(true);
    expectCandidateCheckedOnce(shared);
    expectFileStatCheckedOnce(shared);
  });

  it("resolves the same relative specifier separately from different parent directories", () => {
    const firstShared = write("one/shared.ts", 'import "@xterm/xterm";');
    const secondShared = write("two/shared.ts", 'import "@xterm/xterm";');
    write("entry.ts", 'import "./one/leaf";\nimport "./two/leaf";');
    write("one/leaf.ts", 'import "./shared";');
    write("two/leaf.ts", 'import "./shared";');

    const result = trace("entry.ts", ["@xterm"]);

    expect(result.moduleCount).toBe(5);
    expect(result.files.has(slash(firstShared))).toBe(true);
    expect(result.files.has(slash(secondShared))).toBe(true);
    expect([...result.hits.keys()]).toEqual(["@xterm"]);
    expectCandidateCheckedOnce(firstShared);
    expectCandidateCheckedOnce(secondShared);
    expectFileStatCheckedOnce(firstShared);
    expectFileStatCheckedOnce(secondShared);
  });

  it("refreshes extension resolution on each trace call", () => {
    const entry = write("entry.ts", 'import "./view";');
    const tsFile = write("view.ts", "export const view = 'ts';");

    const first = trace("entry.ts");
    rmSync(tsFile);
    const tsxFile = write("view.tsx", "export const view = 'tsx';");
    const second = trace("entry.ts");

    expect(first.files.has(slash(tsFile))).toBe(true);
    expect(second.files.has(slash(tsFile))).toBe(false);
    expect(second.files.has(slash(tsxFile))).toBe(true);
    expect(second.files.has(slash(entry))).toBe(true);
  });

  it("sees a target created after a previous trace missed it", () => {
    const entry = write("entry.ts", 'import "./later";');
    const missingCandidate = join(fixtureRoot, "later.ts");

    const before = trace("entry.ts");
    const later = write("later.ts", "export const ready = true;");
    const after = trace("entry.ts");

    expect(before.moduleCount).toBe(1);
    expect(after.moduleCount).toBe(2);
    expect(after.files.has(slash(entry))).toBe(true);
    expect(after.files.has(slash(later))).toBe(true);
    expect(
      existsSyncSpy.mock.calls.filter(
        ([candidate]) => candidate === missingCandidate,
      ),
    ).toHaveLength(2);
  });

  it("keeps watch results isolated between trace calls", () => {
    write("entry.ts", 'import "@xterm/xterm";');

    const xterm = trace("entry.ts", ["@xterm"]);
    const aiSdk = trace("entry.ts", ["@ai-sdk"]);

    expect([...xterm.hits.keys()]).toEqual(["@xterm"]);
    expect(aiSdk.hits.size).toBe(0);
  });

  it("records a pure dynamic target without traversing it or its package imports", () => {
    const lazy = write("lazy.ts", 'import "@xterm/xterm";');
    const entry = write("entry.ts", 'void import("./lazy");');

    const result = trace("entry.ts", ["@xterm"]);

    expect(result.moduleCount).toBe(1);
    expect(result.files.has(slash(entry))).toBe(true);
    expect(result.files.has(slash(lazy))).toBe(false);
    expect(result.lazyFiles.has(slash(lazy))).toBe(true);
    expect(result.hits.size).toBe(0);
  });
});
