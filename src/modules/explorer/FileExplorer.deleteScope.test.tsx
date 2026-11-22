import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileExplorer } from "./FileExplorer";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
const oldRect = HTMLElement.prototype.getBoundingClientRect;
const oldObserver = globalThis.ResizeObserver;
const source = (id: number) => ({ kind: "sftp" as const, sessionId: id, frontendSessionId: `ssh-${id}`, root: "/" });
const rows = [{ name: "file.txt", path: "/srv/file.txt", is_dir: false, size: 1, mtime: 1 }];
beforeEach(() => {
  invokeMock.mockReset().mockResolvedValue(rows);
  HTMLElement.prototype.getBoundingClientRect = function () {
    return this.hasAttribute("data-explorer-drop") ? new DOMRect(0, 0, 320, 240) : oldRect.call(this);
  };
  globalThis.ResizeObserver = class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) { this.callback([{ target, contentRect: new DOMRect(0, 0, 320, 240), borderBoxSize: [{ inlineSize: 320, blockSize: 240 }], contentBoxSize: [{ inlineSize: 320, blockSize: 240 }], devicePixelContentBoxSize: [{ inlineSize: 320, blockSize: 240 }] }], this); }
    disconnect() {}
    unobserve() {}
  };
});
afterEach(() => { cleanup(); HTMLElement.prototype.getBoundingClientRect = oldRect; globalThis.ResizeObserver = oldObserver; });
async function openDelete() {
  const row = await screen.findByRole("button", { name: "file.txt" });
  fireEvent.contextMenu(row, { clientX: 30, clientY: 60 });
  fireEvent.click(await screen.findByRole("menuitem", { name: "Delete" }));
  expect(screen.getByTestId("confirm-delete-dialog")).toBeTruthy();
}
describe("file delete confirmation source ownership", () => {
  it("dismisses an old confirmation after switching servers and cannot delete the new source", async () => {
    const { rerender } = render(<FileExplorer rootPath="/srv" fsSource={source(1)} onOpenFile={vi.fn()} />);
    await openDelete();
    rerender(<FileExplorer rootPath="/srv" fsSource={source(2)} onOpenFile={vi.fn()} />);
    await act(async () => {});
    expect(screen.queryByTestId("confirm-delete-dialog")).toBeNull();
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "fsb_delete")).toHaveLength(0);
  });
  it("does not close a new confirmation when an old delete ACK arrives", async () => {
    let resolve!: () => void;
    const ack = new Promise<void>(r => { resolve = r; });
    invokeMock.mockImplementation((command: string) => command === "fsb_delete" ? ack : Promise.resolve(rows));
    const { rerender } = render(<FileExplorer rootPath="/srv" fsSource={source(1)} onOpenFile={vi.fn()} />);
    await openDelete();
    fireEvent.click(screen.getByTestId("confirm-delete-action"));
    expect(invokeMock).toHaveBeenCalledWith("fsb_delete", { sessionId: 1, root: "/", path: "/srv/file.txt" });
    rerender(<FileExplorer rootPath="/srv" fsSource={source(2)} onOpenFile={vi.fn()} />);
    await act(async () => {});
    await openDelete();
    await act(async () => resolve());
    expect(screen.getByTestId("confirm-delete-dialog")).toBeTruthy();
    expect(screen.getByTestId("confirm-delete-action").hasAttribute("disabled")).toBe(false);
    expect(invokeMock.mock.calls.filter(([cmd]) => cmd === "fsb_delete")).toHaveLength(1);
  });
});
