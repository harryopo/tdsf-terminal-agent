import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const seam = vi.hoisted(() => ({
  context: null as null | { connectionId: string; bashHooksPath: string | null },
  listeners: new Set<() => void>(),
  refresh: vi.fn(),
  restore: vi.fn(),
}));
vi.mock("@/modules/terminal/lib/useTerminalSession", () => ({
  getSshIntegrationContext: () => seam.context,
  subscribeSshIntegrationContext: (_leafId: number, listener: () => void) => {
    seam.listeners.add(listener);
    return () => seam.listeners.delete(listener);
  },
  refreshSshIntegrationContext: seam.refresh,
  restoreSshIntegration: seam.restore,
}));

import { useSshStore } from "./sshStore";
import { SshIntegrationBadge } from "./SshIntegrationBadge";

const contextA = { connectionId: "a".repeat(32), bashHooksPath: "/tmp/a.hooks" };
const contextB = { connectionId: "b".repeat(32), bashHooksPath: "/tmp/b.hooks" };
const receiptA = { connectionId: contextA.connectionId, shell: "123-1-2", user: "alice", cwd: "/home/alice" };
const connected = {
  id: "session-a", rustSessionId: 31,
  params: { host: "example.invalid", port: 22, user: "alice", cols: 80, rows: 24, term: "xterm" },
  state: "connected" as const, connectedAt: 1,
  handle: { id: 31, write: vi.fn(), resize: vi.fn(), close: vi.fn() },
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function openBadge() {
  render(<SshIntegrationBadge leafId={4} sessionId="session-a" active />);
  fireEvent.click(screen.getByRole("button", { name: "恢复目录跟随" }));
}
function publish(context: typeof seam.context) {
  seam.context = context;
  act(() => { for (const listener of seam.listeners) listener(); });
}

beforeEach(() => {
  seam.context = null;
  seam.listeners.clear();
  seam.refresh.mockReset().mockResolvedValue(null);
  seam.restore.mockReset();
  useSshStore.setState({ sessions: [connected], activeSessionId: "session-a" });
});
afterEach(() => { vi.useRealTimers(); });

describe("SshIntegrationBadge manual metadata recheck", () => {
  it("shows late metadata in the open DOM without prop rerender and rechecks without restore acknowledgement", async () => {
    let finishRefresh!: (context: typeof contextA | null) => void;
    seam.refresh.mockReturnValue(new Promise((resolve) => { finishRefresh = resolve; }));
    openBadge();
    expect(screen.getByText("尚未获取有效连接信息")).toBeTruthy();
    const refresh = screen.getByRole("button", { name: "重新检测连接信息" });
    fireEvent.click(refresh);
    expect(seam.refresh).toHaveBeenCalledWith(4);
    expect(seam.restore).not.toHaveBeenCalled();
    publish(contextA);
    await act(async () => { finishRefresh(contextA); });
    expect(screen.queryByText(contextA.bashHooksPath!)).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    const restore = screen.getByRole("button", { name: "已登录，恢复目录跟随" }) as HTMLButtonElement;
    expect(restore.disabled).toBe(false);
    expect(seam.restore).not.toHaveBeenCalled();
  });

  it("allows one check at a time and permits another after the four-second wait expires", async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    seam.refresh.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    openBadge();
    const button = screen.getByRole("button", { name: "重新检测连接信息" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(seam.refresh).toHaveBeenCalledTimes(1);
    expect((button as HTMLButtonElement).disabled).toBe(true);

    await act(async () => { vi.advanceTimersByTime(4000); });
    expect(screen.getByText("检测未确认，可重试")).toBeTruthy();
    expect((screen.getByRole("button", { name: "重新检测连接信息" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "重新检测连接信息" }));
    expect(seam.refresh).toHaveBeenCalledTimes(2);
    finish(null);
  });

  it("keeps the second check busy when the timed-out first RPC later succeeds", async () => {
    vi.useFakeTimers();
    const first = deferred<typeof contextA | null>();
    const second = deferred<typeof contextA | null>();
    seam.refresh.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    openBadge();
    fireEvent.click(screen.getByRole("button", { name: "重新检测连接信息" }));
    await act(async () => { vi.advanceTimersByTime(4000); });
    expect(screen.getByText("检测未确认，可重试")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "重新检测连接信息" }));
    const button = screen.getByRole("button", { name: "重新检测连接信息" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    await act(async () => { first.resolve(contextA); await first.promise; await Promise.resolve(); });
    expect(screen.getByText("正在检测连接信息…")).toBeTruthy();
    expect(button.disabled).toBe(true);
  });

  it("does not show an old check success after closing and reopening the popover", async () => {
    const oldCheck = deferred<typeof contextA | null>();
    seam.refresh.mockReturnValueOnce(oldCheck.promise);
    openBadge();
    fireEvent.click(screen.getByRole("button", { name: "重新检测连接信息" }));
    fireEvent.keyDown(document, { key: "Escape" });
    await act(async () => { await Promise.resolve(); });
    fireEvent.click(screen.getByRole("button", { name: "恢复目录跟随" }));
    await act(async () => { oldCheck.resolve(contextA); await oldCheck.promise; await Promise.resolve(); });

    expect(screen.getByText("尚未获取有效连接信息")).toBeTruthy();
    expect((screen.getByRole("button", { name: "重新检测连接信息" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("keeps a new leaf check busy when the previous leaf check resolves", async () => {
    const first = deferred<typeof contextA | null>();
    const second = deferred<typeof contextA | null>();
    seam.refresh.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const otherSession = {
      ...connected,
      id: "session-b",
      rustSessionId: 32,
      handle: { ...connected.handle, id: 32 },
    };
    useSshStore.setState({ sessions: [connected, otherSession], activeSessionId: "session-a" });
    const view = render(<SshIntegrationBadge leafId={4} sessionId="session-a" active />);
    fireEvent.click(screen.getByRole("button", { name: "恢复目录跟随" }));
    fireEvent.click(screen.getByRole("button", { name: "重新检测连接信息" }));

    view.rerender(<SshIntegrationBadge leafId={5} sessionId="session-b" active />);
    fireEvent.click(screen.getByRole("button", { name: "恢复目录跟随" }));
    fireEvent.click(screen.getByRole("button", { name: "重新检测连接信息" }));
    expect(seam.refresh).toHaveBeenNthCalledWith(1, 4);
    expect(seam.refresh).toHaveBeenNthCalledWith(2, 5);

    await act(async () => { first.resolve(contextA); await first.promise; await Promise.resolve(); });
    expect(screen.getByText("正在检测连接信息…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "重新检测连接信息" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("reports a connection without Bash hooks and keeps restore disabled", () => {
    publish({ connectionId: "e".repeat(32), bashHooksPath: null });
    openBadge();
    expect(screen.getByText("当前连接不提供 Bash 集成文件")).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect((screen.getByRole("button", { name: "已登录，恢复目录跟随" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("does not display the raw error detail when a metadata check is rejected", async () => {
    const rawError = "C:/private/server/path rejected";
    seam.refresh.mockRejectedValueOnce(new Error(rawError));
    openBadge();
    fireEvent.click(screen.getByRole("button", { name: "重新检测连接信息" }));
    expect(await screen.findByText("检测未确认，可重试")).toBeTruthy();
    expect(screen.queryByText(rawError)).toBeNull();
  });

  it("clears acknowledgement and ignores an old restore receipt after context changes", async () => {
    publish(contextA);
    let finish!: (value: typeof receiptA) => void;
    seam.restore.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    openBadge();
    fireEvent.click(screen.getByRole("button", { name: "已登录，恢复目录跟随" }));
    publish(contextB);

    expect(screen.queryByRole("checkbox")).toBeNull();
    await act(async () => { finish(receiptA); await Promise.resolve(); });
    expect(screen.queryByText(/最近确认的 shell 用户/)).toBeNull();
    expect(seam.restore).toHaveBeenCalledWith(4, contextA.connectionId, expect.any(AbortSignal));
  });
});
