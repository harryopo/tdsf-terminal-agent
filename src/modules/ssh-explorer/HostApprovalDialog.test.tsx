import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { HostApprovalRequest } from "@/lib/ssh-bridge";
import { HostApprovalDialog } from "./HostApprovalDialog";

const base: HostApprovalRequest = {
  approvalId: "approval-1",
  host: "192.168.45.128",
  port: 22,
  fingerprint: "SHA256:test",
  isMismatch: false,
  keyType: "ssh-ed25519",
};

function renderDialog(overrides: Partial<HostApprovalRequest> = {}) {
  const onApprove = vi.fn().mockResolvedValue(undefined);
  const onReject = vi.fn().mockResolvedValue(undefined);
  render(
    <HostApprovalDialog
      request={{ ...base, ...overrides }}
      onApprove={onApprove}
      onReject={onReject}
    />,
  );
  return { onApprove, onReject };
}

describe("HostApprovalDialog — 两种情形各自的按钮", () => {
  it("首次连接：主按钮信任并连接、次按钮是「取消」（不是在拒绝一个变更）", async () => {
    const { onApprove, onReject } = renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "信任并连接" }));
    await waitFor(() => expect(onApprove).toHaveBeenCalledOnce());
    expect(onReject).not.toHaveBeenCalled();

    const second = renderDialog({ approvalId: "approval-2" });
    fireEvent.click(screen.getByRole("button", { name: "取消" }));
    await waitFor(() => expect(second.onReject).toHaveBeenCalledOnce());
    expect(second.onApprove).not.toHaveBeenCalled();
  });

  it("密钥已变更：次按钮才是「拒绝」，主按钮要求用户先确认核对过", async () => {
    const { onApprove, onReject } = renderDialog({ isMismatch: true });
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    await waitFor(() => expect(onReject).toHaveBeenCalledOnce());
    expect(onApprove).not.toHaveBeenCalled();

    const second = renderDialog({ isMismatch: true, approvalId: "approval-2" });
    fireEvent.click(
      screen.getByRole("button", { name: "我已核对，信任并连接" }),
    );
    await waitFor(() => expect(second.onApprove).toHaveBeenCalledOnce());
    expect(second.onReject).not.toHaveBeenCalled();
  });
});

describe("HostApprovalDialog — 用户 2026-09-23 要的两件事", () => {
  it("把可能原因列出来，且最常见的那条（重装/回快照）排在中间人前面", () => {
    renderDialog({ isMismatch: true });
    const causes = screen.getByText("可能原因（按常见程度排）");
    const list = causes.parentElement?.querySelector("ol");
    const items = [...(list?.querySelectorAll("li") ?? [])].map((li) =>
      li.textContent ?? "",
    );
    expect(items.length).toBeGreaterThanOrEqual(3);
    expect(items[0]).toContain("重装");
    expect(items[items.length - 1]).toContain("中间人");
  });

  it("核对命令按算法给具体文件名，且一键复制复制的就是屏幕上那条", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });

    renderDialog({ keyType: "ssh-rsa" });
    const code = screen.getByTestId("ssh-host-verify-command");
    expect(code.textContent).toBe(
      "ssh-keygen -lf /etc/ssh/ssh_host_rsa_key.pub",
    );

    fireEvent.click(screen.getByRole("button", { name: /复制/ }));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "ssh-keygen -lf /etc/ssh/ssh_host_rsa_key.pub",
      ),
    );
  });
});
