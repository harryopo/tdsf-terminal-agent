import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { HostApprovalRequest } from "@/lib/ssh-bridge";
import { HostApprovalDialog } from "./SshExplorer";

const request: HostApprovalRequest = {
  approvalId: "approval-1",
  host: "192.168.45.128",
  port: 22,
  fingerprint: "SHA256:test",
  isMismatch: false,
  keyType: "ssh-ed25519",
};

describe("HostApprovalDialog", () => {
  it("submits trust approval when the primary action is clicked", async () => {
    const onApprove = vi.fn().mockResolvedValue(undefined);

    render(
      <HostApprovalDialog
        request={request}
        onApprove={onApprove}
        onReject={vi.fn().mockResolvedValue(undefined)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "信任并连接" }));

    await waitFor(() => expect(onApprove).toHaveBeenCalledOnce());
  });

  it("submits rejection when the cancel action is clicked", async () => {
    const onReject = vi.fn().mockResolvedValue(undefined);

    render(
      <HostApprovalDialog
        request={request}
        onApprove={vi.fn().mockResolvedValue(undefined)}
        onReject={onReject}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));

    await waitFor(() => expect(onReject).toHaveBeenCalledOnce());
  });
});
