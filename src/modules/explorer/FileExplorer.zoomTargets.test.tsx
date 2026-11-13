import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { EntryRow, PendingRow, StatusRow, type RowActions } from "./TreeRow";
import { FileExplorer } from "./FileExplorer";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const rootPath = "/workspace";
const rootEntries = [
  { name: "src", path: "/workspace/src", is_dir: true, size: 0, mtime: 1 },
  {
    name: "readme.md",
    path: "/workspace/readme.md",
    is_dir: false,
    size: 20,
    mtime: 2,
  },
];
const sourceEntries = [
  {
    name: "main.ts",
    path: "/workspace/src/main.ts",
    is_dir: false,
    size: 30,
    mtime: 3,
  },
];
const localEntries = [
  { name: "src", kind: "dir" as const, size: 0, mtime: 1, gitignored: false },
  {
    name: "readme.md",
    kind: "file" as const,
    size: 20,
    mtime: 2,
    gitignored: false,
  },
];

const defaultActions: RowActions = {
  toggle: vi.fn(),
  beginRename: vi.fn(),
  commitRename: vi.fn(),
  cancelRename: vi.fn(),
};

let originalResizeObserver: typeof ResizeObserver;
let originalGetBoundingClientRect: typeof HTMLElement.prototype.getBoundingClientRect;
let originalZoomLevel: number;

beforeEach(() => {
  invokeMock
    .mockReset()
    .mockImplementation(async (command: string, args: { path: string }) => {
      if (command === "fsb_list") {
        return args.path === rootPath ? rootEntries : sourceEntries;
      }
      if (command === "fs_read_dir") return localEntries;
      throw new Error(`Unexpected filesystem operation: ${command}`);
    });
  originalResizeObserver = globalThis.ResizeObserver;
  originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  originalZoomLevel = usePreferencesStore.getState().zoomLevel;

  // JSDOM has no layout. Model only the scroll viewport boundary consumed by
  // the real TanStack Virtual instance; row and total sizes remain production output.
  HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.hasAttribute("data-explorer-drop")) {
      return new DOMRect(0, 0, 320, 240);
    }
    return originalGetBoundingClientRect.call(this);
  };
  globalThis.ResizeObserver = class implements ResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback(
        [
          {
            target,
            contentRect: new DOMRect(0, 0, 320, 240),
            borderBoxSize: [{ inlineSize: 320, blockSize: 240 }],
            contentBoxSize: [{ inlineSize: 320, blockSize: 240 }],
            devicePixelContentBoxSize: [{ inlineSize: 320, blockSize: 240 }],
          },
        ],
        this,
      );
    }
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  usePreferencesStore.setState({ zoomLevel: originalZoomLevel });
  globalThis.ResizeObserver = originalResizeObserver;
  HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
});

function renderExplorer(zoomLevel: number, remote = false) {
  act(() => usePreferencesStore.setState({ zoomLevel }));
  return render(
    <FileExplorer
      rootPath={rootPath}
      onOpenFile={vi.fn()}
      fsSource={
        remote ? { kind: "sftp", sessionId: 17, root: "/" } : { kind: "local" }
      }
    />,
  );
}

async function loadedExplorer(container: HTMLElement) {
  await screen.findByText("readme.md");
  return container.firstElementChild as HTMLElement;
}

function virtualRows(container: HTMLElement) {
  return [
    ...container.querySelectorAll<HTMLElement>("[data-virtual-row-index]"),
  ];
}

describe("FileExplorer zoom-aware row targets", () => {
  it.each([
    [1, 24],
    [0.9, 27],
    [0.5, 48],
  ])(
    "keeps virtual extent and rendered rows at zoom %s",
    async (zoom, rowHeight) => {
      const { container } = renderExplorer(zoom, true);
      const explorer = await loadedExplorer(container);
      const content = explorer.querySelector<HTMLElement>(
        "[data-virtual-row-index]",
      )?.parentElement;
      expect(content).not.toBeNull();
      const rows = virtualRows(container);
      expect(rows.length).toBeGreaterThan(0);
      expect(
        rows.every((row) => Number.parseFloat(row.style.height) === rowHeight),
      ).toBe(true);
      expect(Number.parseFloat(content?.style.height ?? "0")).toBe(
        rootEntries.length * rowHeight,
      );
    },
  );

  it("recomputes real virtual rows and total extent after a live zoom change", async () => {
    const { container } = renderExplorer(1, true);
    const explorer = await loadedExplorer(container);
    const content = explorer.querySelector<HTMLElement>(
      "[data-virtual-row-index]",
    )?.parentElement;
    expect(Number.parseFloat(content?.style.height ?? "0")).toBe(
      rootEntries.length * 24,
    );

    act(() => usePreferencesStore.setState({ zoomLevel: 0.5 }));

    await waitFor(() => {
      expect(
        virtualRows(container).every(
          (row) => Number.parseFloat(row.style.height) === 48,
        ),
      ).toBe(true);
      expect(Number.parseFloat(content?.style.height ?? "0")).toBe(
        rootEntries.length * 48,
      );
    });
  });

  it("sizes all four toolbar controls and preserves a header gap above the rows", async () => {
    const { container } = renderExplorer(0.9);
    const explorer = await loadedExplorer(container);
    const controls = [
      screen.getByTitle("Search files"),
      screen.getByTitle("New file"),
      screen.getByTitle("New folder"),
      screen.getByTitle("Refresh"),
    ];
    const cssSize = "var(--explorer-control-size)";
    expect(explorer.style.getPropertyValue("--explorer-control-size")).toBe(
      "27px",
    );
    for (const control of controls) {
      expect(control.className).toContain(cssSize);
    }
    const header = controls[0].parentElement;
    expect(
      Number.parseFloat(header?.style.minHeight ?? "0"),
    ).toBeGreaterThanOrEqual(35);
    expect(container.querySelector("[data-virtual-row-index]")).not.toBeNull();
  });

  it("keeps real entry selection, directory toggle, and file open available at compact zoom", async () => {
    const onOpenFile = vi.fn();
    const { container } = render(
      <FileExplorer
        rootPath={rootPath}
        onOpenFile={onOpenFile}
        fsSource={{ kind: "sftp", sessionId: 17, root: "/" }}
      />,
    );
    act(() => usePreferencesStore.setState({ zoomLevel: 0.5 }));
    const file = await screen.findByRole("button", { name: "readme.md" });
    fireEvent.click(file);
    expect(onOpenFile).toHaveBeenCalledWith("/workspace/readme.md");
    expect(file.className).toContain("bg-accent");

    fireEvent.click(screen.getByRole("button", { name: "src" }));
    expect(await screen.findByRole("button", { name: "main.ts" })).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith("fsb_list", {
      sessionId: 17,
      root: "/",
      path: "/workspace/src",
    });
    expect(
      virtualRows(container).every(
        (row) => Number.parseFloat(row.style.height) === 48,
      ),
    ).toBe(true);
  });
});

describe("Explorer TreeRow zoom fill and cancellation", () => {
  it("fills the virtual row while cancelling rename without committing", () => {
    const cancelRename = vi.fn();
    const commitRename = vi.fn();
    const { container } = render(
      <div style={{ height: 48 }}>
        <EntryRow
          path="/workspace/readme.md"
          name="readme.md"
          isDir={false}
          isExpanded={false}
          depth={0}
          actions={{ ...defaultActions, cancelRename, commitRename }}
          renameInProgress
          isSelected={false}
          isRenaming
          onOpenFile={vi.fn()}
          onSelectPath={vi.fn()}
        />
      </div>,
    );
    const row = container.querySelector<HTMLElement>("[style*='height: 48px']")
      ?.firstElementChild as HTMLElement;
    expect(row.className).toContain("h-full");
    const input = screen.getByDisplayValue("readme.md");
    expect(input.className).toContain("h-full");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(cancelRename).toHaveBeenCalledOnce();
    expect(commitRename).not.toHaveBeenCalled();
  });

  it("fills a pending row and cancels it without submitting", () => {
    const onCancel = vi.fn();
    const onCommit = vi.fn();
    const { container } = render(
      <div style={{ height: 48 }}>
        <PendingRow
          depth={0}
          kind="file"
          onCommit={onCommit}
          onCancel={onCancel}
        />
      </div>,
    );
    const row = container.querySelector<HTMLElement>("[style*='height: 48px']")
      ?.firstElementChild as HTMLElement;
    expect(row.className).toContain("h-full");
    const input = screen.getByPlaceholderText("New file");
    expect(input.className).toContain("h-full");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it("fills status rows to the virtual row height", () => {
    const { container } = render(
      <div style={{ height: 48 }}>
        <StatusRow depth={0} message="Loading…" tone="muted" />
      </div>,
    );
    const row = container.querySelector<HTMLElement>("[style*='height: 48px']")
      ?.firstElementChild as HTMLElement;
    expect(row.className).toContain("h-full");
  });
});
