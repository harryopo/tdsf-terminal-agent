import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteDesktopDialog } from "./RemoteDesktopDialog";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class<T> {
    onmessage: ((message: T) => void) | null = null;
  },
}));

beforeEach(() => {
  invoke.mockReset();
  invoke.mockImplementation((command: string) => {
    if (command === "desktop_connect") return Promise.resolve(7);
    if (command === "desktop_status") {
      return Promise.resolve({ status: "failed", error: "certificate rejected" });
    }
    if (command === "desktop_close") return Promise.resolve(undefined);
    return Promise.reject(new Error(`unexpected command: ${command}`));
  });
});

afterEach(cleanup);

describe("RemoteDesktopDialog", () => {
  it("保留连接失败原因并清理失败会话", async () => {
    render(<RemoteDesktopDialog open onOpenChange={vi.fn()} />);

    fireEvent.click(screen.getByRole("button", { name: "连接" }));

    await waitFor(() => expect(screen.getByText("certificate rejected")).toBeTruthy());
    expect(invoke).toHaveBeenCalledWith("desktop_close", {
      sessionId: 7,
      owner: "desktop-dialog",
      generation: 2,
    });
  });
});