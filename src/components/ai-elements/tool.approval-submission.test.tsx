import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { ToolApprovalCard, type ToolApprovalRespond } from "./tool";

const LOW_RISK_IMPACT = {
  summary: "读取当前状态",
  max_risk_l: 1,
  denied: false,
  dangerous_construct: false,
  segments: [{ category: "read_only", risk_l: 1, denied: false }],
};

const MEDIUM_RISK_IMPACT = {
  summary: "更新应用配置",
  max_risk_l: 2,
  denied: false,
  dangerous_construct: false,
  segments: [{ category: "configuration", risk_l: 2, denied: false }],
};

function renderCard(
  input: Record<string, unknown>,
  options: { onRespond?: ToolApprovalRespond; submitting?: boolean } = {},
) {
  const props = {
    toolName: "ssh_command",
    input,
    onRespond: options.onRespond ?? vi.fn(),
    ...(options.submitting === undefined
      ? {}
      : { submitting: options.submitting }),
  };
  return render(<ToolApprovalCard {...props} />);
}

afterEach(() => {
  cleanup();
  useChatStore.setState({ sessionReadOnlyTrust: false });
});

describe("ToolApprovalCard submission state", () => {
  it("marks the card busy and prevents all approval actions while submitting", () => {
    const onRespond = vi.fn();
    const { container } = renderCard(
      {
        command: "systemctl status nginx",
        risk_l: 1,
        impact: LOW_RISK_IMPACT,
      },
      { onRespond, submitting: true },
    );

    const card = container.querySelector<HTMLElement>("[data-approval-card]");
    expect(card?.getAttribute("aria-busy")).toBe("true");
    expect(screen.getByText("正在提交确认…")).toBeTruthy();

    const execute = screen.getByRole("button", { name: "执行" });
    const trust = screen.getByRole("button", { name: "批准且本会话只读免审" });
    const reject = screen.getByRole("button", { name: "拒绝" });
    expect((execute as HTMLButtonElement).disabled).toBe(true);
    expect((trust as HTMLButtonElement).disabled).toBe(true);
    expect((reject as HTMLButtonElement).disabled).toBe(true);

    for (const button of [execute, trust, reject]) {
      fireEvent.click(button);
      fireEvent.keyDown(button, { key: "Enter", code: "Enter" });
      fireEvent.keyDown(button, { key: " ", code: "Space" });
    }
    expect(onRespond).not.toHaveBeenCalled();
    expect(useChatStore.getState().sessionReadOnlyTrust).toBe(false);
  });

  it("keeps a rejection note while disabling its controls, then restores the form", () => {
    const onRespond = vi.fn();
    const input = { command: "rm -rf /tmp/cache", risk_l: 4 };
    const first = renderCard(input, { onRespond });
    fireEvent.click(screen.getByRole("button", { name: "拒绝" }));
    const note = screen.getByRole("textbox");
    fireEvent.change(note, { target: { value: "请先确认备份" } });

    const submittingProps = {
      toolName: "ssh_command",
      input,
      onRespond,
      submitting: true,
    };
    first.rerender(<ToolApprovalCard {...submittingProps} />);

    const cancel = screen.getByRole("button", { name: "取消" });
    const confirmReject = screen.getByRole("button", { name: "确认拒绝" });
    const submittingNote = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect((cancel as HTMLButtonElement).disabled).toBe(true);
    expect((confirmReject as HTMLButtonElement).disabled).toBe(true);
    expect(submittingNote.disabled).toBe(true);
    expect(submittingNote.value).toBe("请先确认备份");

    fireEvent.click(cancel);
    fireEvent.click(confirmReject);
    fireEvent.keyDown(confirmReject, { key: "Enter", code: "Enter" });
    fireEvent.keyDown(submittingNote, { key: "x", code: "KeyX" });
    expect(onRespond).not.toHaveBeenCalled();
    expect(submittingNote.value).toBe("请先确认备份");

    first.rerender(
      <ToolApprovalCard {...{ ...submittingProps, submitting: false }} />,
    );
    const restoredNote = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(restoredNote.disabled).toBe(false);
    expect(restoredNote.value).toBe("请先确认备份");
    fireEvent.click(screen.getByRole("button", { name: "确认拒绝" }));
    expect(onRespond).toHaveBeenCalledTimes(1);
    expect(onRespond).toHaveBeenCalledWith({
      approved: false,
      note: "请先确认备份",
    });
  });

  it("keeps default command, risk gating, and execution callback unchanged", () => {
    const onRespond = vi.fn();
    const command = "printf 'a  b'\r\n  && echo done";
    renderCard(
      { command, risk_l: 2, impact: MEDIUM_RISK_IMPACT },
      { onRespond },
    );

    expect(screen.getByTestId("approval-command").textContent).toBe(command);
    expect(screen.getByText("L2 中风险")).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "批准且本会话只读免审" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "执行" }));
    expect(onRespond).toHaveBeenCalledWith({ approved: true });
  });

  it("reports read-only trust through the callback without mutating global chat trust", () => {
    const onRespond = vi.fn();
    renderCard(
      { command: "uptime", risk_l: 1, impact: LOW_RISK_IMPACT },
      { onRespond },
    );

    fireEvent.click(
      screen.getByRole("button", { name: "批准且本会话只读免审" }),
    );
    expect(onRespond).toHaveBeenCalledWith({
      approved: true,
      sessionTrust: true,
    });
    expect(useChatStore.getState().sessionReadOnlyTrust).toBe(false);
  });
});
