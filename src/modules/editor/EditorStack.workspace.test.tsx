import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useSpaces } from "@/modules/spaces/lib/useSpaces";
import { EditorStack } from "./EditorStack";

vi.mock("./EditorPane", async () => {
  const { createElement, forwardRef } = await import("react");
  return { EditorPane: forwardRef((props: { path: string; workspace: unknown }, _ref) =>
    createElement("div", { "data-testid": props.path }, JSON.stringify(props.workspace))) };
});

const original = useSpaces.getState();
afterEach(() => { cleanup(); useSpaces.setState(original, true); });

describe("EditorStack workspace wiring", () => {
  it("passes immutable sources to visible and background panes and fails closed for an unknown old tab", () => {
    useSpaces.setState({ spaces: [{ id: "A", name: "A", root: "/", env: { kind: "wsl", distro: "A" }, createdAt: 1, updatedAt: 1 }], activeId: "A" });
    render(<EditorStack tabs={[
      { id: 1, kind: "editor", spaceId: "moved", path: "/one.txt", title: "one", dirty: false, preview: false, workspace: { kind: "wsl", distro: "original" } },
      { id: 2, kind: "editor", spaceId: "A", path: "/two.txt", title: "two", dirty: true, preview: false },
      { id: 3, kind: "editor", spaceId: "missing", path: "/three.txt", title: "three", dirty: true, preview: false },
    ]} activeId={1} onDirtyChange={vi.fn()} registerHandle={vi.fn()} onCloseTab={vi.fn()} onSetMarkdownView={vi.fn()} />);
    expect(screen.getByTestId("/one.txt").textContent).toBe('{"kind":"wsl","distro":"original"}');
    expect(screen.getByTestId("/two.txt").textContent).toBe('{"kind":"wsl","distro":"A"}');
    expect(screen.getByTestId("/three.txt").textContent).toBe("null");
  });
});
