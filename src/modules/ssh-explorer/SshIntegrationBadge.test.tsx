import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSshStore } from "./sshStore";
import type { SshSessionInfo } from "./sshStore";
import { SshIntegrationBadge } from "./SshIntegrationBadge";
import { SshFileIdentity } from "./SshFileIdentity";

const seam = vi.hoisted(() => ({
  getContext: vi.fn(),
  restore: vi.fn(),
}));

vi.mock("@/modules/terminal/lib/useTerminalSession", () => ({
  getSshIntegrationContext: seam.getContext,
  subscribeSshIntegrationContext: () => () => {},
  restoreSshIntegration: seam.restore,
}));

const connectionId = "0123456789abcdef0123456789abcdef";
const context = {
  connectionId,
  bashHooksPath: `/tmp/tdsf-osc7-${connectionId}.hooks.bash`,
};
const receipt = {
  connectionId,
  shell: "123-11-22",
  user: "lisi",
  cwd: "/home/lisi",
};
const rootSession: SshSessionInfo = {
  id: "root-session",
  rustSessionId: 200,
  params: { host: "server-a", port: 22, user: "root", cols: 80, rows: 24, term: "xterm-256color" },
  state: "connected",
  connectedAt: 1,
  handle: { id: 200, write: vi.fn().mockResolvedValue(undefined), resize: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) },
};
const lisiSession: SshSessionInfo = {
  id: "lisi-session",
  rustSessionId: 300,
  params: { host: "server-b", port: 22, user: "lisi", cols: 80, rows: 24, term: "xterm-256color" },
  state: "connected",
  connectedAt: 2,
  handle: { id: 300, write: vi.fn().mockResolvedValue(undefined), resize: vi.fn().mockResolvedValue(undefined), close: vi.fn().mockResolvedValue(undefined) },
};

function openBadge() {
  render(<SshIntegrationBadge leafId={4} sessionId="root-session" active />);
  fireEvent.click(screen.getByRole("button", { name: "终端集成" }));
}

beforeEach(() => {
  seam.getContext.mockReset().mockReturnValue(context);
  seam.restore.mockReset();
  useSshStore.setState({ sessions: [rootSession, lisiSession], activeSessionId: "root-session" });
});

describe("SshIntegrationBadge", () => {
  it("only renders for an active terminal with a connected SSH session", () => {
    const { rerender } = render(<SshIntegrationBadge leafId={4} sessionId="root-session" active={false} />);
    expect(screen.queryByRole("button", { name: "终端集成" })).toBeNull();
    rerender(<SshIntegrationBadge leafId={4} sessionId="missing" active />);
    expect(screen.queryByRole("button", { name: "终端集成" })).toBeNull();
    rerender(<SshIntegrationBadge leafId={4} sessionId="root-session" active />);
    expect(screen.getByRole("button", { name: "终端集成" })).toBeTruthy();
  });

  it("opens as a read-only explanation and does not start a restore", () => {
    openBadge();
    expect(screen.getAllByText(/root/).length).toBeGreaterThan(0);
    expect(seam.getContext).toHaveBeenCalledWith(4);
    expect(seam.restore).not.toHaveBeenCalled();
  });

  it("requires the explicit idle-Bash acknowledgement before restoring", () => {
    openBadge();
    const restoreButton = screen.getByRole("button", { name: "恢复当前终端集成" }) as HTMLButtonElement;
    expect(restoreButton.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "我已完成登录，当前是同一服务器的空闲 Bash 提示符，且没有未提交输入" }));
    expect(restoreButton.disabled).toBe(false);
    expect(seam.restore).not.toHaveBeenCalled();
  });

  it("waits for the receipt and keeps the file connection identity as root", async () => {
    let finish!: (value: typeof receipt) => void;
    seam.restore.mockReturnValue(new Promise<typeof receipt>((resolve) => { finish = resolve; }));
    openBadge();
    fireEvent.click(screen.getByRole("checkbox", { name: "我已完成登录，当前是同一服务器的空闲 Bash 提示符，且没有未提交输入" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复当前终端集成" }));
    expect(screen.getByText("等待终端回执…")).toBeTruthy();
    expect(seam.restore).toHaveBeenCalledWith(4, connectionId, expect.any(AbortSignal));
    await waitFor(() => expect((screen.getByRole("button", { name: "恢复当前终端集成" }) as HTMLButtonElement).disabled).toBe(true));
    finish(receipt);
    await waitFor(() => expect(screen.getByText(/终端集成已恢复/)).toBeTruthy());
    expect(screen.getByText(/root@server-a/)).toBeTruthy();
    expect(screen.queryByText(/lisi@server-a/)).toBeNull();
  });

  it("shows a retryable Chinese error when the restore is rejected", async () => {
    seam.restore.mockRejectedValue(new Error("拒绝：未收到匹配的终端回执"));
    openBadge();
    fireEvent.click(screen.getByRole("checkbox", { name: "我已完成登录，当前是同一服务器的空闲 Bash 提示符，且没有未提交输入" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复当前终端集成" }));
    expect(await screen.findByText(/未收到匹配的终端回执/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "恢复当前终端集成" }));
    await waitFor(() => expect(seam.restore).toHaveBeenCalledTimes(2));
  });

  it("disables repeated requests while a receipt is pending", () => {
    seam.restore.mockReturnValue(new Promise(() => {}));
    openBadge();
    fireEvent.click(screen.getByRole("checkbox", { name: "我已完成登录，当前是同一服务器的空闲 Bash 提示符，且没有未提交输入" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复当前终端集成" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复当前终端集成" }));
    expect(seam.restore).toHaveBeenCalledTimes(1);
  });

  it("aborts when the terminal becomes inactive and ignores a late success", async () => {
    let finish!: (value: typeof receipt) => void;
    seam.restore.mockReturnValue(new Promise<typeof receipt>((resolve) => { finish = resolve; }));
    const { rerender } = render(<SshIntegrationBadge leafId={4} sessionId="root-session" active />);
    fireEvent.click(screen.getByRole("button", { name: "终端集成" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "我已完成登录，当前是同一服务器的空闲 Bash 提示符，且没有未提交输入" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复当前终端集成" }));
    const signal = seam.restore.mock.calls[0][2] as AbortSignal;
    rerender(<SshIntegrationBadge leafId={4} sessionId="root-session" active={false} />);
    expect(signal.aborted).toBe(true);
    finish(receipt);
    await waitFor(() => expect(screen.queryByText("等待终端回执…")).toBeNull());
    expect(screen.queryByText(/终端集成已恢复/)).toBeNull();
    rerender(<SshIntegrationBadge leafId={4} sessionId="root-session" active />);
    expect(screen.queryByText(/终端集成已恢复/)).toBeNull();
  });

  it("aborts on Popover close and ignores a late success", async () => {
    let finish!: (value: typeof receipt) => void;
    seam.restore.mockReturnValue(new Promise<typeof receipt>((resolve) => { finish = resolve; }));
    openBadge();
    fireEvent.click(screen.getByRole("checkbox", { name: "我已完成登录，当前是同一服务器的空闲 Bash 提示符，且没有未提交输入" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复当前终端集成" }));
    const signal = seam.restore.mock.calls[0][2] as AbortSignal;
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(signal.aborted).toBe(true));
    finish(receipt);
    expect(screen.queryByText(/终端集成已恢复/)).toBeNull();
  });

  it("aborts the pending restore on unmount", () => {
    seam.restore.mockReturnValue(new Promise(() => {}));
    const { unmount } = render(<SshIntegrationBadge leafId={4} sessionId="root-session" active />);
    fireEvent.click(screen.getByRole("button", { name: "终端集成" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "我已完成登录，当前是同一服务器的空闲 Bash 提示符，且没有未提交输入" }));
    fireEvent.click(screen.getByRole("button", { name: "恢复当前终端集成" }));
    const signal = seam.restore.mock.calls[0][2] as AbortSignal;
    unmount();
    expect(signal.aborted).toBe(true);
  });
});

describe("SshFileIdentity", () => {
  it("matches the file connection by Rust session and preserves its SSH authentication identity", () => {
    render(<><SshFileIdentity sessionId={200} /><SshFileIdentity sessionId={300} /></>);
    expect(screen.getByText(/root@server-a/)).toBeTruthy();
    expect(screen.getByText(/lisi@server-b/)).toBeTruthy();
    expect(screen.queryByText(/lisi@server-a/)).toBeNull();
  });

  it("shows the original SSH authentication identity without inventing a user when the Rust session is missing", () => {
    render(<SshFileIdentity sessionId={999} />);
    expect(screen.getByText(/SSH\s*认证身份/)).toBeTruthy();
    expect(screen.queryByText(/root|lisi/)).toBeNull();
  });
});
