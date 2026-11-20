import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { FileTreeSource } from "@/modules/explorer/lib/useFileTree";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { LOCAL_WORKSPACE, useWorkspaceEnvStore } from "@/modules/workspace";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import { CwdBreadcrumb } from "./CwdBreadcrumb";

type FsEntry = {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  mtime: number;
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function entry(name: string, path: string, is_dir = true): FsEntry {
  return { name, path, is_dir, size: 0, mtime: 0 };
}

function openCurrentMenu() {
  const button = screen.getByRole("button", { name: "浏览子目录：/workspace" });
  fireEvent.pointerDown(button, {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

const cwd = "/workspace";
const sftpA: FileTreeSource = { kind: "sftp", sessionId: 11, root: cwd };
const sftpB: FileTreeSource = { kind: "sftp", sessionId: 22, root: cwd };

let preferencesBefore: ReturnType<typeof usePreferencesStore.getState>;
let workspaceBefore: ReturnType<typeof useWorkspaceEnvStore.getState>;

beforeEach(() => {
  preferencesBefore = usePreferencesStore.getState();
  workspaceBefore = useWorkspaceEnvStore.getState();
  usePreferencesStore.setState({ showHidden: false });
  useWorkspaceEnvStore.setState({ env: LOCAL_WORKSPACE });
  invokeMock.mockReset();
  invokeMock.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  usePreferencesStore.setState(preferencesBefore);
  useWorkspaceEnvStore.setState(workspaceBefore);
});

describe("CwdBreadcrumb directory source lifecycle", () => {
  it("uses the active SFTP source and shows only visible directories", async () => {
    const remoteEntries = [
      entry("remote-dir", `${cwd}/remote-dir`),
      entry("remote-file.txt", `${cwd}/remote-file.txt`, false),
      entry(".secret", `${cwd}/.secret`),
    ] satisfies FsEntry[];
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === "fsb_list" ? remoteEntries : ["legacy-dir"]),
    );
    render(
      <CwdBreadcrumb cwd={cwd} home={null} onCd={vi.fn()} source={sftpA} />,
    );

    openCurrentMenu();

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("fsb_list", {
        sessionId: 11,
        root: cwd,
        path: cwd,
      }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "remote-dir" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("menuitem", { name: "remote-file.txt" }),
    ).toBeNull();
    expect(screen.queryByRole("menuitem", { name: ".secret" })).toBeNull();
  });

  it("reloads SFTP entries when showHidden changes", async () => {
    const remoteEntries = [
      entry("visible", `${cwd}/visible`),
      entry(".hidden", `${cwd}/.hidden`),
    ] satisfies FsEntry[];
    invokeMock.mockImplementation((command: string) =>
      Promise.resolve(command === "fsb_list" ? remoteEntries : ["visible"]),
    );
    render(
      <CwdBreadcrumb cwd={cwd} home={null} onCd={vi.fn()} source={sftpA} />,
    );
    openCurrentMenu();
    expect(
      await screen.findByRole("menuitem", { name: "visible" }),
    ).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: ".hidden" })).toBeNull();

    act(() => usePreferencesStore.setState({ showHidden: true }));

    expect(
      await screen.findByRole("menuitem", { name: ".hidden" }),
    ).toBeTruthy();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
  });

  it("does not request a local listing when the source is unavailable", async () => {
    render(
      <CwdBreadcrumb cwd={cwd} home={null} onCd={vi.fn()} source={null} />,
    );

    openCurrentMenu();
    await act(async () => Promise.resolve());

    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("shows an SFTP listing error without falling back to list_subdirs", async () => {
    invokeMock.mockRejectedValue(new Error("SFTP listing failed"));
    render(
      <CwdBreadcrumb cwd={cwd} home={null} onCd={vi.fn()} source={sftpA} />,
    );

    openCurrentMenu();

    expect(await screen.findByText("Error: SFTP listing failed")).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledWith("fsb_list", {
      sessionId: sftpA.sessionId,
      root: sftpA.root,
      path: cwd,
    });
    expect(invokeMock).not.toHaveBeenCalledWith(
      "list_subdirs",
      expect.anything(),
    );
  });

  it("clears loaded SFTP rows when the source becomes unavailable without another request", async () => {
    invokeMock.mockResolvedValue([
      entry("previously-loaded", `${cwd}/previously-loaded`),
    ]);
    const view = render(
      <CwdBreadcrumb cwd={cwd} home={null} onCd={vi.fn()} source={sftpA} />,
    );
    openCurrentMenu();
    expect(
      await screen.findByRole("menuitem", { name: "previously-loaded" }),
    ).toBeTruthy();
    invokeMock.mockClear();

    view.rerender(
      <CwdBreadcrumb cwd={cwd} home={null} onCd={vi.fn()} source={null} />,
    );

    expect(
      await screen.findByText("SSH 未连接，请先重新连接当前终端"),
    ).toBeTruthy();
    expect(
      screen.queryByRole("menuitem", { name: "previously-loaded" }),
    ).toBeNull();
    expect(invokeMock).not.toHaveBeenCalled();
  });

  it("does not let a late response from the previous SFTP session replace the active session", async () => {
    const responseA = deferred<FsEntry[]>();
    const responseB = deferred<FsEntry[]>();
    const legacyA = deferred<string[]>();
    let remoteCalls = 0;
    let legacyCalls = 0;
    invokeMock.mockImplementation((command: string) =>
      command === "fsb_list"
        ? [responseA, responseB][remoteCalls++]?.promise
        : [legacyA][legacyCalls++]?.promise,
    );
    const view = render(
      <CwdBreadcrumb cwd={cwd} home={null} onCd={vi.fn()} source={sftpA} />,
    );
    openCurrentMenu();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));

    view.rerender(
      <CwdBreadcrumb cwd={cwd} home={null} onCd={vi.fn()} source={sftpB} />,
    );
    await act(async () => Promise.resolve());
    const firstRequestIsSftp = invokeMock.mock.calls[0]?.[0] === "fsb_list";
    if (invokeMock.mock.calls.length > 1) {
      await act(async () => {
        responseB.resolve([entry("session-B", `${cwd}/session-B`)]);
        await responseB.promise;
      });
    }
    await act(async () => {
      if (firstRequestIsSftp) {
        responseA.resolve([entry("session-A", `${cwd}/session-A`)]);
        await responseA.promise;
      } else {
        legacyA.resolve(["session-A"]);
        await legacyA.promise;
      }
    });

    expect(screen.queryByRole("menuitem", { name: "session-A" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "session-B" })).toBeTruthy();
    expect(invokeMock).toHaveBeenCalledTimes(2);
  });

  it("does not let a late request for the previous path replace rows for the new path", async () => {
    const responseOld = deferred<FsEntry[]>();
    const responseNew = deferred<FsEntry[]>();
    invokeMock
      .mockReturnValueOnce(responseOld.promise)
      .mockReturnValueOnce(responseNew.promise);
    const otherSource: FileTreeSource = {
      kind: "sftp",
      sessionId: sftpB.sessionId,
      root: "/other",
    };
    const view = render(
      <CwdBreadcrumb cwd={cwd} home={null} onCd={vi.fn()} source={sftpA} />,
    );
    openCurrentMenu();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));

    view.rerender(
      <CwdBreadcrumb
        cwd="/other"
        home={null}
        onCd={vi.fn()}
        source={otherSource}
      />,
    );
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
    expect(invokeMock).toHaveBeenLastCalledWith("fsb_list", {
      sessionId: sftpB.sessionId,
      root: "/other",
      path: "/other",
    });
    await act(async () => {
      responseNew.resolve([entry("new-path-row", "/other/new-path-row")]);
      await responseNew.promise;
    });
    expect(
      await screen.findByRole("menuitem", { name: "new-path-row" }),
    ).toBeTruthy();
    await act(async () => {
      responseOld.resolve([entry("old-path-row", `${cwd}/old-path-row`)]);
      await responseOld.promise;
    });

    expect(screen.queryByRole("menuitem", { name: "old-path-row" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "new-path-row" })).toBeTruthy();
  });

  it("reloads a same-path local listing after the WSL distro changes and ignores the old result", async () => {
    const responseA = deferred<string[]>();
    const responseB = deferred<string[]>();
    let localCalls = 0;
    invokeMock.mockImplementation(
      () => [responseA, responseB][localCalls++]?.promise,
    );
    act(() =>
      useWorkspaceEnvStore.setState({
        env: { kind: "wsl", distro: "Distro-A" },
      }),
    );
    const view = render(<CwdBreadcrumb cwd={cwd} home={null} onCd={vi.fn()} />);
    openCurrentMenu();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));

    act(() =>
      useWorkspaceEnvStore.setState({
        env: { kind: "wsl", distro: "Distro-B" },
      }),
    );
    view.rerender(<CwdBreadcrumb cwd={cwd} home={null} onCd={vi.fn()} />);
    await act(async () => Promise.resolve());

    if (invokeMock.mock.calls.length > 1) {
      await act(async () => {
        responseB.resolve(["from-B"]);
        await responseB.promise;
      });
    }
    await act(async () => {
      responseA.resolve(["from-A"]);
      await responseA.promise;
    });

    expect(screen.queryByRole("menuitem", { name: "from-A" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "from-B" })).toBeTruthy();
    expect(invokeMock).toHaveBeenLastCalledWith("list_subdirs", {
      path: cwd,
      showHidden: false,
      workspace: { kind: "wsl", distro: "Distro-B" },
    });
  });

  it("does not apply a response from a closed menu after it is reopened", async () => {
    const firstResponse = deferred<FsEntry[]>();
    const secondResponse = deferred<FsEntry[]>();
    const firstLegacyResponse = deferred<string[]>();
    const secondLegacyResponse = deferred<string[]>();
    let remoteCalls = 0;
    let legacyCalls = 0;
    invokeMock.mockImplementation((command: string) =>
      command === "fsb_list"
        ? [firstResponse, secondResponse][remoteCalls++]?.promise
        : [firstLegacyResponse, secondLegacyResponse][legacyCalls++]?.promise,
    );
    render(
      <CwdBreadcrumb cwd={cwd} home={null} onCd={vi.fn()} source={sftpA} />,
    );
    const trigger = screen.getByRole("button", {
      name: "浏览子目录：/workspace",
    });
    openCurrentMenu();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(trigger, { key: "Escape" });
    await waitFor(() =>
      expect(trigger.getAttribute("aria-expanded")).toBe("false"),
    );
    openCurrentMenu();
    await waitFor(() => expect(invokeMock).toHaveBeenCalledTimes(2));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    await act(async () => {
      secondResponse.resolve([entry("fresh", `${cwd}/fresh`)]);
      secondLegacyResponse.resolve(["fresh"]);
      await Promise.resolve();
    });
    expect(await screen.findByRole("menuitem", { name: "fresh" })).toBeTruthy();
    await act(async () => {
      firstResponse.resolve([entry("stale", `${cwd}/stale`)]);
      firstLegacyResponse.resolve(["stale"]);
      await Promise.resolve();
    });

    expect(screen.queryByRole("menuitem", { name: "stale" })).toBeNull();
    expect(screen.getByRole("menuitem", { name: "fresh" })).toBeTruthy();
  });

  it("does not allow file-path breadcrumbs to navigate into a terminal", async () => {
    const onCd = vi.fn();
    render(
      <CwdBreadcrumb
        cwd={cwd}
        filePath="/root/parent/child/file.txt"
        home={null}
        onCd={onCd}
        canNavigate={false}
      />,
    );

    const root = screen.getByRole("button", { name: "根目录 /" });
    const hidden = screen.getByRole("button", { name: "显示隐藏目录" });
    expect(root.hasAttribute("disabled")).toBe(true);
    expect(hidden.hasAttribute("disabled")).toBe(true);
    fireEvent.click(root);
    fireEvent.click(hidden);

    expect(onCd).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
