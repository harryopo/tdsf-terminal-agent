import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { LogRecord } from "./LogRecord";

afterEach(cleanup);

describe("diagnostic log records", () => {
  it("keeps a short actual record readable without an invented status", () => {
    render(
      <LogRecord
        time="10:00:01"
        label="工具结果"
        source="ssh_command"
        text="exit code 7"
      />,
    );
    expect(screen.getByText("10:00:01")).toBeTruthy();
    expect(screen.getByText("exit code 7")).toBeTruthy();
    expect(screen.getByText("ssh_command")).toBeTruthy();
    expect(screen.queryByText("成功")).toBeNull();
  });

  it("folds a long body and known metadata until opened", async () => {
    const text = "真实输出 ".repeat(50);
    const { container } = render(
      <LogRecord
        time="10:00:01"
        label="工具调用"
        text={text}
        detail='{"tool_call_id":"call-1"}'
      />,
    );
    expect(container.querySelector("pre")).toBeNull();
    const details = container.querySelector("details")!;
    await act(async () => {
      details.open = true;
      fireEvent(details, new Event("toggle"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(container.querySelector("pre")?.textContent).toBe(text);
    expect(screen.getByText(/tool_call_id/)).toBeTruthy();
  });
});
