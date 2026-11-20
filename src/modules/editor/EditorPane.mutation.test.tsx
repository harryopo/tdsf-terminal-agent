import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { createRef, type ReactNode, type RefObject } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { onKeysChanged } from "@/modules/settings/store";
import { useSshStore } from "@/modules/ssh-explorer/sshStore";
import { ThemeProvider } from "@/modules/theme/ThemeProvider";
import { listCustomThemes, onCustomThemesChange } from "@/modules/theme/customThemes";
import { EditorPane, type EditorPaneHandle } from "./EditorPane";
import { pendingFileSaves } from "./lib/pendingFileSaves";
import { fileSourceKey } from "@/modules/workspace/fileSource";

const {
  invokeMock,
  sftpReadMock,
  sftpStatMock,
  sftpWriteMock,
  lspFormatMock,
  runExternalFormatterMock,
  dismissMock,
} = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  sftpReadMock: vi.fn(),
  sftpStatMock: vi.fn(),
  sftpWriteMock: vi.fn(),
  lspFormatMock: vi.fn(),
  runExternalFormatterMock: vi.fn(),
  dismissMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock, convertFileSrc: (path: string) => path }));
vi.mock("@/lib/sftp-bridge", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/sftp-bridge")>();
  return { ...actual, sftpRead: sftpReadMock, sftpStat: sftpStatMock, sftpWrite: sftpWriteMock };
});
vi.mock("@/modules/lsp", () => ({
  lspFormatDocument: lspFormatMock,
  useLspExtension: () => [],
  notifyDocumentSaved: vi.fn(),
}));
vi.mock("@/modules/ai/config", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/modules/ai/config")>(),
  endpointIdFromCompatModel: () => null,
}));
vi.mock("@/modules/ai/lib/keyring", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/modules/ai/lib/keyring")>(),
  getCustomEndpointKey: vi.fn(),
  getKey: vi.fn(),
}));
vi.mock("@/modules/settings/store", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/modules/settings/store")>(),
  onKeysChanged: vi.fn(async () => () => {}),
}));
vi.mock("@/modules/theme/customThemes", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/modules/theme/customThemes")>(),
  listCustomThemes: vi.fn(async () => []),
  onCustomThemesChange: vi.fn(async () => () => {}),
}));
vi.mock("./lib/externalFormat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/externalFormat")>();
  return { ...actual, runExternalFormatter: runExternalFormatterMock };
});
vi.mock("sonner", () => ({ toast: {
  warning: vi.fn(), error: vi.fn(), success: vi.fn(), dismiss: dismissMock,
} }));

type RelocationHandle = EditorPaneHandle & {
  beginRelocation: (to: string) => { ready: Promise<void>; cancel: () => void };
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const workspaceA = { kind: "wsl", distro: "Ubuntu-A" } as const;
const workspaceB = { kind: "wsl", distro: "Ubuntu-B" } as const;
const originalPreferences = usePreferencesStore.getState();
const originalSsh = useSshStore.getState();

function getView(container: HTMLElement): EditorView {
  const content = container.querySelector<HTMLElement>(".cm-content");
  if (!content) throw new Error("CodeMirror content is not mounted");
  const view = EditorView.findFromDOM(content);
  if (!view) throw new Error("CodeMirror EditorView is not mounted");
  return view;
}

function edit(view: EditorView, content: string) {
  act(() => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } }));
}

function saveWithCtrlS(view: EditorView) {
  act(() => { fireEvent.keyDown(view.contentDOM, { key: "s", code: "KeyS", ctrlKey: true }); });
}

function beginRelocation(ref: RefObject<RelocationHandle | null>, to: string) {
  expect(ref.current).toBeTruthy();
  expect(typeof ref.current?.beginRelocation).toBe("function");
  return ref.current!.beginRelocation(to);
}

function ThemeWrapper({ children }: { children: ReactNode }) {
  return <ThemeProvider>{children}</ThemeProvider>;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(onKeysChanged).mockResolvedValue(() => {});
  vi.mocked(listCustomThemes).mockResolvedValue([]);
  vi.mocked(onCustomThemesChange).mockResolvedValue(() => {});
  usePreferencesStore.setState({
    editorAutoSave: false,
    editorAutoSaveDelay: 1000,
    editorFormatOnSave: false,
    editorFormatter: "lsp",
    editorFormatterByLang: {},
  });
  useSshStore.setState({ sessions: [] });
  invokeMock.mockImplementation((command: string) => Promise.resolve(
    command === "fs_read_file"
      ? { kind: "text", content: "original\n", size: 9, mtime: 10 }
      : command === "fs_stat"
        ? { kind: "file", size: 9, mtime: 10 }
        : 11,
  ));
  sftpReadMock.mockResolvedValue(new TextEncoder().encode("original\n"));
  sftpStatMock.mockResolvedValue({ size: 9, modified: 10, accessed: 10, uid: 0, gid: 0, permissions: 0o644 });
  sftpWriteMock.mockResolvedValue(undefined);
  lspFormatMock.mockResolvedValue("done");
  runExternalFormatterMock.mockResolvedValue(null);
});

afterEach(() => {
  cleanup();
  usePreferencesStore.setState(originalPreferences, true);
  useSshStore.setState(originalSsh, true);
});

describe("EditorPane relocation save transaction", () => {
  it("retains a dispatched formatter after the editor closes", async () => {
    const formatter = deferred<string | null>();
    runExternalFormatterMock.mockReturnValue(formatter.promise);
    usePreferencesStore.setState({ editorFormatOnSave: true, editorFormatter: "prettier" });
    const { container, unmount } = render(<EditorPane path="/closed/file.tsx" workspace={workspaceA} />, { wrapper: ThemeWrapper });
    await waitFor(() => expect(getView(container).state.doc.toString()).toBe("original\n"));
    const view = getView(container);
    edit(view, "draft\n"); saveWithCtrlS(view);
    await waitFor(() => expect(runExternalFormatterMock).toHaveBeenCalled());
    unmount();
    const key = fileSourceKey(workspaceA)!;
    const jobs = pendingFileSaves(key, "/closed");
    expect(jobs.length).toBeGreaterThan(0);
    await act(async () => { formatter.resolve(null); await Promise.all(jobs); });
    expect(pendingFileSaves(key, "/closed")).toHaveLength(0);
  });

  it("waits for a dispatched external formatter and its disk read-back before relocation is ready", async () => {
    const formatter = deferred<string | null>();
    const readback = deferred<{ kind: string; content: string; size: number; mtime: number }>();
    runExternalFormatterMock.mockReturnValue(formatter.promise);
    let reads = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "fs_read_file" && ++reads === 2) return readback.promise;
      if (command === "fs_read_file") return Promise.resolve({ kind: "text", content: "original\n", size: 9, mtime: 10 });
      return Promise.resolve(command === "fs_stat" ? { kind: "file", size: 9, mtime: 10 } : 11);
    });
    usePreferencesStore.setState({ editorFormatOnSave: true, editorFormatter: "prettier" });
    const ref = createRef<RelocationHandle>();
    const { container } = render(<EditorPane ref={ref} path="/workspace/file.tsx" workspace={workspaceA} />, { wrapper: ThemeWrapper });
    await waitFor(() => expect(getView(container).state.doc.toString()).toBe("original\n"));
    const view = getView(container);
    edit(view, "draft\n");
    saveWithCtrlS(view);
    await waitFor(() => expect(runExternalFormatterMock).toHaveBeenCalledWith("prettier", "/workspace/file.tsx", expect.any(String), workspaceA));

    let settled = false;
    let ready!: Promise<void>;
    act(() => { ready = beginRelocation(ref, "/workspace/renamed.tsx").ready; });
    void ready.then(() => { settled = true; });
    await act(async () => { await Promise.resolve(); });
    expect(settled).toBe(false);

    await act(async () => { formatter.resolve(null); await Promise.resolve(); });
    expect(settled).toBe(false);
    await act(async () => {
      readback.resolve({ kind: "text", content: "formatted\n", size: 10, mtime: 12 });
      await ready;
    });
    expect(view.state.doc.toString()).toBe("formatted\n");
    expect(settled).toBe(true);
  });

  it("does not start a formatter or write when Ctrl+S is pressed during relocation hold", async () => {
    usePreferencesStore.setState({ editorFormatOnSave: true, editorFormatter: "prettier" });
    const ref = createRef<RelocationHandle>();
    const { container } = render(<EditorPane ref={ref} path="/workspace/file.tsx" workspace={workspaceA} />, { wrapper: ThemeWrapper });
    await waitFor(() => expect(getView(container).state.doc.toString()).toBe("original\n"));
    const view = getView(container);
    edit(view, "draft\n");
    act(() => { beginRelocation(ref, "/workspace/renamed.tsx"); });

    saveWithCtrlS(view);
    await act(async () => { await Promise.resolve(); });
    expect(runExternalFormatterMock).not.toHaveBeenCalled();
    expect(invokeMock).not.toHaveBeenCalledWith("fs_write_file", expect.anything());
  });

  it("does not write after pending LSP formatting resolves into a relocation hold", async () => {
    const formatting = deferred<"done" | "unsupported">();
    lspFormatMock.mockReturnValue(formatting.promise);
    usePreferencesStore.setState({ editorFormatOnSave: true, editorFormatter: "lsp" });
    const ref = createRef<RelocationHandle>();
    const { container } = render(<EditorPane ref={ref} path="/workspace/file.tsx" workspace={workspaceA} />, { wrapper: ThemeWrapper });
    await waitFor(() => expect(getView(container).state.doc.toString()).toBe("original\n"));
    const view = getView(container);
    edit(view, "draft\n");
    saveWithCtrlS(view);
    await waitFor(() => expect(lspFormatMock).toHaveBeenCalled());

    let ready!: Promise<void>;
    act(() => { ready = beginRelocation(ref, "/workspace/renamed.tsx").ready; });
    await act(async () => { formatting.resolve("done"); await Promise.resolve(); });
    await act(async () => { await ready; });
    expect(invokeMock).not.toHaveBeenCalledWith("fs_write_file", expect.anything());
    expect(runExternalFormatterMock).not.toHaveBeenCalled();
  });

  it("does not write a pending LSP save to a replacement owner at the same path", async () => {
    const formatting = deferred<"done" | "unsupported">();
    lspFormatMock.mockReturnValue(formatting.promise);
    usePreferencesStore.setState({ editorFormatOnSave: true, editorFormatter: "lsp" });
    const ref = createRef<RelocationHandle>();
    const { container, rerender } = render(<EditorPane ref={ref} path="/workspace/file.tsx" workspace={workspaceA} />, { wrapper: ThemeWrapper });
    await waitFor(() => expect(getView(container).state.doc.toString()).toBe("original\n"));
    const view = getView(container);
    edit(view, "draft\n");
    saveWithCtrlS(view);
    await waitFor(() => expect(lspFormatMock).toHaveBeenCalled());
    let ready!: Promise<void>;
    act(() => { ready = beginRelocation(ref, "/workspace/renamed.tsx").ready; });
    rerender(<EditorPane ref={ref} path="/workspace/file.tsx" workspace={workspaceB} />);
    await waitFor(() => expect(invokeMock).toHaveBeenCalledWith("fs_read_file", expect.objectContaining({ workspace: workspaceB })));

    await act(async () => { formatting.resolve("done"); await ready; });
    expect(invokeMock).not.toHaveBeenCalledWith("fs_write_file", expect.objectContaining({ path: "/workspace/file.tsx", workspace: workspaceB }));
    expect(sftpWriteMock).not.toHaveBeenCalled();
  });

  it("preserves newer edits while an external formatter read-back is pending", async () => {
    const formatter = deferred<string | null>();
    const readback = deferred<{ kind: string; content: string; size: number; mtime: number }>();
    runExternalFormatterMock.mockReturnValue(formatter.promise);
    let reads = 0;
    invokeMock.mockImplementation((command: string) => {
      if (command === "fs_read_file" && ++reads === 2) return readback.promise;
      if (command === "fs_read_file") return Promise.resolve({ kind: "text", content: "original\n", size: 9, mtime: 10 });
      return Promise.resolve(command === "fs_stat" ? { kind: "file", size: 9, mtime: 10 } : 11);
    });
    usePreferencesStore.setState({ editorFormatOnSave: true, editorFormatter: "prettier" });
    const ref = createRef<RelocationHandle>();
    const { container } = render(<EditorPane ref={ref} path="/workspace/file.tsx" workspace={workspaceA} />, { wrapper: ThemeWrapper });
    await waitFor(() => expect(getView(container).state.doc.toString()).toBe("original\n"));
    const view = getView(container);
    edit(view, "first draft\n");
    saveWithCtrlS(view);
    await waitFor(() => expect(runExternalFormatterMock).toHaveBeenCalled());
    formatter.resolve(null);
    await waitFor(() => expect(reads).toBe(2));
    edit(view, "newer edit\n");
    readback.resolve({ kind: "text", content: "stale formatted\n", size: 16, mtime: 12 });
    await act(async () => { await Promise.resolve(); });
    expect(view.state.doc.toString()).toBe("newer edit\n");
  });
});
