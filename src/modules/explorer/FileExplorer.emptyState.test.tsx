import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock, setShowHiddenMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  setShowHiddenMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@/modules/settings/store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/modules/settings/store")>()),
  setShowHidden: setShowHiddenMock,
}));

import { usePreferencesStore } from "@/modules/settings/preferences";
import { FileExplorer } from "./FileExplorer";

const rootPath = "/home/fixture";
const workspace = { kind: "wsl" as const, distro: "Ubuntu-24.04" };
const visibleHiddenEntry = {
  name: ".bashrc",
  kind: "file" as const,
  size: 10,
  mtime: 1,
  gitignored: false,
};

type ReadArgs = {
  path: string;
  showHidden: boolean;
  gitDecorations: boolean;
  workspace: typeof workspace | { kind: "wsl"; distro: string };
};

let listDirectory: (args: ReadArgs) => Promise<typeof visibleHiddenEntry[]>;
let originalResizeObserver: typeof ResizeObserver;
let originalGetBoundingClientRect: typeof HTMLElement.prototype.getBoundingClientRect;
let savedPreferences: ReturnType<typeof usePreferencesStore.getState>;

beforeEach(() => {
  savedPreferences = usePreferencesStore.getState();
  usePreferencesStore.setState({
    showHidden: false,
    explorerGitDecorations: false,
    zoomLevel: 1,
  });
  listDirectory = async () => [];
  invokeMock.mockReset().mockImplementation((command: string, args: ReadArgs) => {
    if (command !== "fs_read_dir") throw new Error(`Unexpected command: ${command}`);
    return listDirectory(args);
  });
  setShowHiddenMock.mockReset().mockImplementation(async (value: boolean) => {
    usePreferencesStore.setState({ showHidden: value });
  });

  originalResizeObserver = globalThis.ResizeObserver;
  originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
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
        [{
          target,
          contentRect: new DOMRect(0, 0, 320, 240),
          borderBoxSize: [{ inlineSize: 320, blockSize: 240 }],
          contentBoxSize: [{ inlineSize: 320, blockSize: 240 }],
          devicePixelContentBoxSize: [{ inlineSize: 320, blockSize: 240 }],
        }],
        this,
      );
    }
    unobserve() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  usePreferencesStore.setState({
    showHidden: savedPreferences.showHidden,
    explorerGitDecorations: savedPreferences.explorerGitDecorations,
    zoomLevel: savedPreferences.zoomLevel,
  });
  globalThis.ResizeObserver = originalResizeObserver;
  HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
});

function renderExplorer(path = rootPath, distro = workspace.distro) {
  return render(
    <FileExplorer
      rootPath={path}
      onOpenFile={vi.fn()}
      fsSource={{ kind: "local", workspace: { kind: "wsl", distro } }}
    />,
  );
}

describe("FileExplorer empty WSL directory states", () => {
  it("explains that hidden files may be filtered and reloads the same WSL source when enabled", async () => {
    listDirectory = async ({ showHidden }) => showHidden ? [visibleHiddenEntry] : [];
    renderExplorer();

    expect(await screen.findByText("当前目录没有可见文件")).toBeTruthy();
    expect(screen.getByText(/隐藏文件可能被过滤/)).toBeTruthy();
    expect(screen.queryByText("此目录为空")).toBeNull();
    const showHidden = screen.getByRole("button", { name: "显示隐藏文件" });
    fireEvent.click(showHidden);

    await waitFor(() => expect(setShowHiddenMock).toHaveBeenCalledWith(true));
    expect(await screen.findByRole("button", { name: ".bashrc" })).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith("fs_read_dir", {
      path: rootPath,
      showHidden: true,
      gitDecorations: false,
      workspace,
    });
    expect(invokeMock.mock.calls.every(([command]) => command === "fs_read_dir")).toBe(true);
  });

  it("reports a failed hidden-file preference save and permits retry", async () => {
    listDirectory = async ({ showHidden }) => showHidden ? [visibleHiddenEntry] : [];
    setShowHiddenMock.mockRejectedValueOnce(new Error("fixture save failed"));
    renderExplorer();

    await screen.findByText("当前目录没有可见文件");
    const showHidden = screen.getByRole("button", { name: "显示隐藏文件" });
    fireEvent.click(showHidden);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "无法保存隐藏文件设置，请重试。",
    );
    expect(usePreferencesStore.getState().showHidden).toBe(false);
    expect(invokeMock.mock.calls.every(([command]) => command === "fs_read_dir")).toBe(true);

    fireEvent.click(showHidden);
    await screen.findByRole("button", { name: ".bashrc" });
    expect(setShowHiddenMock).toHaveBeenCalledTimes(2);
    expect(setShowHiddenMock).toHaveBeenLastCalledWith(true);
  });

  it("calls the loaded empty directory empty when hidden files are enabled", async () => {
    usePreferencesStore.setState({ showHidden: true });
    renderExplorer();

    expect(await screen.findByText("此目录为空")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "显示隐藏文件" })).toBeNull();
  });

  it("shows loading and the actual read error without presenting either as an empty directory", async () => {
    let reject!: (error: Error) => void;
    listDirectory = () => new Promise<typeof visibleHiddenEntry[]>((_, fail) => { reject = fail; });
    renderExplorer();

    expect(await screen.findByText("正在加载目录…")).toBeTruthy();
    expect(screen.queryByText("此目录为空")).toBeNull();
    expect(screen.queryByText("当前目录没有可见文件")).toBeNull();

    await act(async () => { reject(new Error("permission denied")); });
    expect(await screen.findByText(/permission denied/)).toBeTruthy();
    expect(screen.queryByText("此目录为空")).toBeNull();
    expect(screen.queryByText("当前目录没有可见文件")).toBeNull();
  });

  it("automatically rereads when the root or WSL distribution changes", async () => {
    usePreferencesStore.setState({ showHidden: true });
    const view = renderExplorer();
    await screen.findByText("此目录为空");

    view.rerender(
      <FileExplorer
        rootPath="/mnt/c/project"
        onOpenFile={vi.fn()}
        fsSource={{ kind: "local", workspace }}
      />,
    );
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("fs_read_dir", {
      path: "/mnt/c/project",
      showHidden: true,
      gitDecorations: false,
      workspace,
    }));

    view.rerender(
      <FileExplorer
        rootPath="/mnt/c/project"
        onOpenFile={vi.fn()}
        fsSource={{ kind: "local", workspace: { kind: "wsl", distro: "Debian" } }}
      />,
    );
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("fs_read_dir", {
      path: "/mnt/c/project",
      showHidden: true,
      gitDecorations: false,
      workspace: { kind: "wsl", distro: "Debian" },
    }));
    expect(invokeMock.mock.calls.every(([command]) => command === "fs_read_dir")).toBe(true);
  });
});
