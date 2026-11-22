import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Tab } from "./lib/useTabs";
import { TabBar } from "./TabBar";

const tabs = [
  {
    id: 11,
    kind: "terminal",
    spaceId: "workspace-1",
    title: "terminal",
    customTitle: "Build",
    paneTree: { kind: "leaf", id: 21 },
    activeLeafId: 21,
  },
  {
    id: 12,
    kind: "editor",
    spaceId: "workspace-1",
    title: "README.md",
    path: "/repo/README.md",
    dirty: false,
    preview: false,
  },
  {
    id: 13,
    kind: "editor",
    spaceId: "workspace-1",
    title: "package.json",
    path: "/repo/package.json",
    dirty: true,
    preview: false,
  },
] satisfies Tab[];

type ObservedResize = {
  observer: ResizeObserver;
  callback: ResizeObserverCallback;
  targets: Set<Element>;
  disconnected: boolean;
};

let observers: ObservedResize[];
let originalResizeObserver: typeof ResizeObserver;

function viewportOf(container: HTMLElement): HTMLElement {
  const marked = container.querySelector<HTMLElement>(
    '[data-testid="tab-scroll-viewport"]',
  );
  if (marked) return marked;

  // Before the viewport gets its own test id, find the existing scroll parent
  // through the actual Radix Tabs root: tablist -> Tabs root -> flex row -> scroller.
  const tablist = container.querySelector<HTMLElement>('[role="tablist"]');
  const viewport = tablist?.parentElement?.parentElement?.parentElement;
  if (!viewport) throw new Error("Could not locate the rendered tab viewport");
  return viewport;
}

function barOf(container: HTMLElement): HTMLElement {
  const bar = container.querySelector<HTMLElement>('[data-testid="tab-bar"]');
  if (!bar) throw new Error("Could not locate the rendered tab bar");
  return bar;
}

function setDimensions(
  element: HTMLElement,
  clientWidth: number,
  scrollWidth: number,
) {
  Object.defineProperties(element, {
    clientWidth: { configurable: true, value: clientWidth },
    scrollWidth: { configurable: true, value: scrollWidth },
  });
}

function setTabPosition(element: HTMLElement, left: number, width: number) {
  Object.defineProperties(element, {
    offsetLeft: { configurable: true, value: left },
    offsetWidth: { configurable: true, value: width },
  });
}

function notifyResize(element: HTMLElement) {
  act(() => {
    for (const record of observers) {
      if (record.targets.has(element)) {
        record.callback(
          [
            {
              target: element,
              contentRect: element.getBoundingClientRect(),
              borderBoxSize: [],
              contentBoxSize: [],
              devicePixelContentBoxSize: [],
            },
          ],
          record.observer,
        );
      }
    }
  });
}

function renderBar({
  activeId = tabs[0].id,
  hasWorkspace = true,
  onSelect = vi.fn(),
}: {
  activeId?: number;
  hasWorkspace?: boolean;
  onSelect?: (id: number) => void;
} = {}) {
  const noop = () => {};
  const props = {
    tabs,
    activeId,
    onSelect,
    onNew: noop,
    onNewEditor: noop,
    onClose: noop,
    onPin: noop,
    onRename: noop,
    onReorder: noop,
    hasWorkspace,
  };
  const result = render(<TabBar {...props} />);
  return {
    ...result,
    props,
    bar: barOf(result.container),
    viewport: viewportOf(result.container),
    onSelect,
  };
}

beforeEach(() => {
  observers = [];
  originalResizeObserver = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class implements ResizeObserver {
    readonly record: ObservedResize;

    constructor(callback: ResizeObserverCallback) {
      this.record = {
        observer: this,
        callback,
        targets: new Set(),
        disconnected: false,
      };
      observers.push(this.record);
    }

    observe(target: Element) {
      this.record.targets.add(target);
    }

    unobserve(target: Element) {
      this.record.targets.delete(target);
    }

    disconnect() {
      this.record.disconnected = true;
      this.record.targets.clear();
    }
  };
});

afterEach(() => {
  cleanup();
  globalThis.ResizeObserver = originalResizeObserver;
});

describe("TabBar overflow menu", () => {
  it("does not show the more button when all tabs fit", () => {
    const { viewport } = renderBar();
    setDimensions(viewport, 640, 640);
    notifyResize(viewport);

    expect(screen.queryByRole("button", { name: "更多标签页" })).toBeNull();
    expect(screen.getByRole("tab", { name: /Build/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /README\.md/ })).toBeTruthy();
  });

  it("shows a real menu containing each tab and selects the requested tab id", async () => {
    const onSelect = vi.fn();
    const { viewport } = renderBar({ onSelect });
    setDimensions(viewport, 180, 640);
    notifyResize(viewport);

    fireEvent.pointerDown(screen.getByRole("button", { name: "更多标签页" }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    expect(await screen.findByRole("menuitem", { name: /Build/ })).toBeTruthy();
    expect(
      screen
        .getByRole("menuitem", { name: /Build/ })
        .getAttribute("aria-current"),
    ).toBe("page");
    expect(screen.getByRole("menuitem", { name: /README\.md/ })).toBeTruthy();
    expect(
      screen.getByRole("menuitem", { name: /package\.json/ }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: /package\.json/ }));

    expect(onSelect).toHaveBeenCalledWith(13);
  });

  it("updates the more button when the viewport shrinks and grows", async () => {
    const { viewport } = renderBar();
    setDimensions(viewport, 640, 640);
    notifyResize(viewport);
    expect(screen.queryByRole("button", { name: "更多标签页" })).toBeNull();

    setDimensions(viewport, 180, 640);
    notifyResize(viewport);
    expect(
      await screen.findByRole("button", { name: "更多标签页" }),
    ).toBeTruthy();

    setDimensions(viewport, 640, 640);
    notifyResize(viewport);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "更多标签页" })).toBeNull(),
    );
  });

  it("keeps the new-tab control outside the scrolling viewport", () => {
    const { viewport, container } = renderBar({ hasWorkspace: true });
    const newTab = screen.getByTitle("New tab");

    expect(container.contains(newTab)).toBe(true);
    expect(viewport.contains(newTab)).toBe(false);
  });

  it("continues to hide the new-tab control when there is no workspace", () => {
    renderBar({ hasWorkspace: false });
    expect(screen.queryByTitle("New tab")).toBeNull();
  });

  it("disconnects its resize observers when unmounted", () => {
    const { unmount } = renderBar();
    const activeObservers = observers.filter((record) => !record.disconnected);
    expect(activeObservers.length).toBeGreaterThan(0);

    unmount();

    expect(observers.every((record) => record.disconnected)).toBe(true);
  });

  it("scrolls the viewport to fully reveal a newly active tab and rechecks after resize", async () => {
    const { viewport, container, rerender, props } = renderBar({
      activeId: 11,
    });
    const activeTab =
      container.querySelector<HTMLElement>('[data-tab-id="13"]');
    expect(activeTab).not.toBeNull();

    setDimensions(viewport, 180, 800);
    setTabPosition(activeTab!, 640, 120);
    viewport.scrollLeft = 0;

    rerender(<TabBar {...props} activeId={13} />);

    await waitFor(() => expect(viewport.scrollLeft).toBe(580));

    setDimensions(viewport, 100, 800);
    notifyResize(viewport);

    await waitFor(() => expect(viewport.scrollLeft).toBe(660));
  });

  it("keeps the current scroll position when the active tab is already visible", async () => {
    const { viewport, container } = renderBar({ activeId: 11 });
    const activeTab =
      container.querySelector<HTMLElement>('[data-tab-id="11"]');
    expect(activeTab).not.toBeNull();

    setDimensions(viewport, 180, 800);
    setTabPosition(activeTab!, 70, 90);
    viewport.scrollLeft = 50;
    notifyResize(viewport);

    await waitFor(() => expect(viewport.scrollLeft).toBe(50));
  });

  it("collapses the tab strip at narrow widths while keeping the menu and new-tab control usable", async () => {
    const onSelect = vi.fn();
    const { bar, viewport } = renderBar({ onSelect });
    setDimensions(bar, 100, 100);
    setDimensions(viewport, 20, 640);
    notifyResize(viewport);
    notifyResize(bar);

    await waitFor(() =>
      expect(viewport.classList.contains("hidden")).toBe(true),
    );
    expect(screen.getByTitle("New tab").parentElement).not.toBeNull();
    expect(viewport.contains(screen.getByTitle("New tab"))).toBe(false);

    const moreButton = screen.getByRole("button", { name: "更多标签页" });
    fireEvent.pointerDown(moreButton, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    expect(await screen.findByRole("menuitem", { name: /Build/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /README\.md/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: /package\.json/ }));
    expect(onSelect).toHaveBeenCalledWith(13);

    setDimensions(bar, 800, 800);
    setDimensions(viewport, 640, 640);
    notifyResize(bar);
    notifyResize(viewport);

    await waitFor(() => {
      expect(viewport.classList.contains("hidden")).toBe(false);
      expect(screen.queryByRole("button", { name: "更多标签页" })).toBeNull();
    });
  });
});
