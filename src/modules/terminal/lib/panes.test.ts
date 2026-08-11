import {
  effectiveLeafSsh,
  firstLeafSlotId,
  leafIds,
  type PaneNode,
  setLeafSshSession,
  splitLeaf,
  swapLeafInDirection,
} from "@/modules/terminal/lib/panes";
import { describe, expect, it } from "vitest";

function row(...ids: number[]): PaneNode {
  return {
    kind: "split",
    id: 100,
    dir: "row",
    children: ids.map((id) => ({ kind: "leaf", id })),
  };
}

function col(...ids: number[]): PaneNode {
  return {
    kind: "split",
    id: 200,
    dir: "col",
    children: ids.map((id) => ({ kind: "leaf", id })),
  };
}

describe("swapLeafInDirection", () => {
  it("swaps the active pane with its neighbor to the left", () => {
    expect(leafIds(swapLeafInDirection(row(1, 2, 3), 2, "left"))).toEqual([
      2, 1, 3,
    ]);
  });

  it("wraps right from the rightmost pane to the leftmost pane", () => {
    expect(leafIds(swapLeafInDirection(row(1, 2, 3), 3, "right"))).toEqual([
      3, 2, 1,
    ]);
  });

  it("swaps vertically and wraps upward", () => {
    expect(leafIds(swapLeafInDirection(col(1, 2, 3), 2, "down"))).toEqual([
      1, 3, 2,
    ]);
    expect(leafIds(swapLeafInDirection(col(1, 2, 3), 1, "up"))).toEqual([
      3, 2, 1,
    ]);
  });

  it("chooses the overlapping directional neighbor in a nested layout", () => {
    const tree: PaneNode = {
      kind: "split",
      id: 10,
      dir: "row",
      children: [
        { kind: "leaf", id: 1 },
        {
          kind: "split",
          id: 11,
          dir: "col",
          children: [
            { kind: "leaf", id: 2 },
            { kind: "leaf", id: 3 },
          ],
        },
      ],
    };

    expect(leafIds(swapLeafInDirection(tree, 2, "down"))).toEqual([1, 3, 2]);
    expect(leafIds(swapLeafInDirection(tree, 3, "left"))).toEqual([3, 2, 1]);
  });

  it("uses live pane bounds after splitters are resized", () => {
    const bounds = [
      { id: 1, left: 0, right: 100, top: 0, bottom: 100 },
      { id: 2, left: 200, right: 300, top: 100, bottom: 200 },
      { id: 3, left: 100, right: 200, top: 0, bottom: 100 },
    ];

    expect(
      leafIds(swapLeafInDirection(row(1, 2, 3), 1, "right", bounds)),
    ).toEqual([3, 2, 1]);
  });

  it("falls back to tree geometry when live bounds are incomplete", () => {
    const tree = row(1, 2, 3);
    const incompleteBounds = [
      { id: 1, left: 0, right: 100, top: 0, bottom: 100 },
    ];

    expect(
      leafIds(swapLeafInDirection(tree, 1, "right", incompleteBounds)),
    ).toEqual([2, 1, 3]);
  });

  it("moves pane metadata with the terminal session", () => {
    const tree: PaneNode = {
      kind: "split",
      id: 100,
      dir: "row",
      children: [
        { kind: "leaf", id: 1, cwd: "/one" },
        { kind: "leaf", id: 2, cwd: "/two" },
      ],
    };
    const swapped = swapLeafInDirection(tree, 2, "left");
    expect(swapped.kind).toBe("split");
    if (swapped.kind === "split") {
      expect(swapped.children[0]).toEqual({
        kind: "leaf",
        id: 2,
        slotId: 1,
        cwd: "/two",
      });
      expect(swapped.children[1]).toEqual({
        kind: "leaf",
        id: 1,
        slotId: 2,
        cwd: "/one",
      });
    }
  });

  it("keeps resizable layout slots fixed while sessions move", () => {
    const tree = row(1, 2, 3);
    const swapped = swapLeafInDirection(tree, 2, "left");

    expect(swapped.kind).toBe("split");
    if (swapped.kind === "split") {
      expect(swapped.children.map(firstLeafSlotId)).toEqual([1, 2, 3]);
      expect(leafIds(swapped)).toEqual([2, 1, 3]);
    }

    const restored = swapLeafInDirection(swapped, 2, "right");
    expect(restored.kind).toBe("split");
    if (restored.kind === "split") {
      expect(restored.children.map(firstLeafSlotId)).toEqual([1, 2, 3]);
      expect(leafIds(restored)).toEqual([1, 2, 3]);
    }
  });

  it("does nothing when the tree contains only one pane", () => {
    const tree: PaneNode = { kind: "leaf", id: 1 };
    expect(swapLeafInDirection(tree, 1, "left")).toBe(tree);
  });
});

// TDSF 魔改 (2026-08-11 #21): 本地 + SSH 混合分屏数据模型测试
describe("splitLeaf SSH binding", () => {
  it("writes the SSH session id onto the new leaf when provided", () => {
    const tree: PaneNode = { kind: "leaf", id: 1 };
    const next = splitLeaf(tree, 1, 10, 2, "row", "/cwd", "sess-1");
    expect(next).toEqual({
      kind: "split",
      id: 10,
      dir: "row",
      children: [
        { kind: "leaf", id: 1 },
        { kind: "leaf", id: 2, cwd: "/cwd", sshSessionId: "sess-1" },
      ],
    });
  });

  it("writes an explicit null to force a local shell when requested", () => {
    const tree: PaneNode = { kind: "leaf", id: 1 };
    const next = splitLeaf(tree, 1, 10, 2, "col", undefined, null);
    expect(next).toEqual({
      kind: "split",
      id: 10,
      dir: "col",
      children: [
        { kind: "leaf", id: 1 },
        { kind: "leaf", id: 2, sshSessionId: null },
      ],
    });
  });

  it("omits the sshSessionId field when undefined (inherit tab binding)", () => {
    const tree: PaneNode = { kind: "leaf", id: 1 };
    const next = splitLeaf(tree, 1, 10, 2, "row", "/cwd");
    const children = (next as Extract<PaneNode, { kind: "split" }>).children;
    expect(children[1]).toEqual({ kind: "leaf", id: 2, cwd: "/cwd" });
  });
});

describe("setLeafSshSession", () => {
  it("binds, forces local and restores inheritance on a nested leaf", () => {
    const tree: PaneNode = {
      kind: "split",
      id: 10,
      dir: "row",
      children: [
        { kind: "leaf", id: 1 },
        { kind: "leaf", id: 2 },
      ],
    };
    const bound = setLeafSshSession(tree, 2, "sess-2");
    expect((bound as Extract<PaneNode, { kind: "split" }>).children[1]).toEqual(
      { kind: "leaf", id: 2, sshSessionId: "sess-2" },
    );
    const forced = setLeafSshSession(bound, 2, null);
    expect(
      (forced as Extract<PaneNode, { kind: "split" }>).children[1],
    ).toEqual({ kind: "leaf", id: 2, sshSessionId: null });
  });

  it("returns the same reference when the leaf does not exist", () => {
    const tree: PaneNode = { kind: "leaf", id: 1 };
    expect(setLeafSshSession(tree, 999, "sess")).toBe(tree);
  });
});

describe("effectiveLeafSsh", () => {
  const ssh = "sess-ssh";
  const leaf1 = (): PaneNode => ({ kind: "leaf", id: 1 });

  it("inherits the tab binding when the leaf has no explicit binding", () => {
    expect(effectiveLeafSsh(leaf1(), 1, ssh)).toBe(ssh);
    expect(effectiveLeafSsh(leaf1(), 1, undefined)).toBeNull();
  });

  it("prefers the explicit leaf binding over the tab binding", () => {
    const tree: PaneNode = { kind: "leaf", id: 1, sshSessionId: "leaf-only" };
    expect(effectiveLeafSsh(tree, 1, ssh)).toBe("leaf-only");
  });

  it("explicit null forces a local shell even inside an SSH tab", () => {
    const tree: PaneNode = { kind: "leaf", id: 1, sshSessionId: null };
    expect(effectiveLeafSsh(tree, 1, ssh)).toBeNull();
  });

  it("resolves each leaf independently inside a split", () => {
    const tree: PaneNode = {
      kind: "split",
      id: 10,
      dir: "row",
      children: [
        { kind: "leaf", id: 1, sshSessionId: "sess-1" },
        { kind: "leaf", id: 2, sshSessionId: null },
        { kind: "leaf", id: 3 },
      ],
    };
    expect(effectiveLeafSsh(tree, 1, ssh)).toBe("sess-1");
    expect(effectiveLeafSsh(tree, 2, ssh)).toBeNull();
    expect(effectiveLeafSsh(tree, 3, ssh)).toBe(ssh);
  });

  it("returns null for a leaf id outside the tree", () => {
    expect(effectiveLeafSsh(leaf1(), 999, ssh)).toBeNull();
  });
});
