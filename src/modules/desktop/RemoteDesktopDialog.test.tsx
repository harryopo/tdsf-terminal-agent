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

  it("支持缩放切换和全屏放大", async () => {
    invoke.mockImplementation((command: string) => {
      if (command === "desktop_connect") return Promise.resolve(7);
      if (command === "desktop_status") return Promise.resolve({ status: "connected", error: null });
      if (command === "desktop_close") return Promise.resolve(undefined);
      return Promise.reject(new Error(`unexpected command: ${command}`));
    });
    const requestFullscreen = vi.fn().mockResolvedValue(undefined);
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "requestFullscreen");
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });

    try {
      render(<RemoteDesktopDialog open onOpenChange={vi.fn()} />);
      fireEvent.click(screen.getByRole("button", { name: "连接" }));

      const fullscreen = await screen.findByRole("button", { name: "全屏" });
      const fit = screen.getByRole("button", { name: "适应窗口" });
      const actual = screen.getByRole("button", { name: "原始尺寸" });
      expect(fit.getAttribute("aria-pressed")).toBe("true");
      fireEvent.click(actual);
      expect(actual.getAttribute("aria-pressed")).toBe("true");
      expect(fit.getAttribute("aria-pressed")).toBe("false");

      fireEvent.click(fullscreen);
      await waitFor(() => expect(requestFullscreen).toHaveBeenCalledTimes(1));
      expect(screen.getByTestId("remote-desktop-dialog").className).toContain("h-[100dvh]");
      fireEvent.click(screen.getByRole("button", { name: "退出全屏" }));
      await screen.findByRole("button", { name: "全屏" });
    } finally {
      if (original) Object.defineProperty(HTMLElement.prototype, "requestFullscreen", original);
      else delete (HTMLElement.prototype as { requestFullscreen?: unknown }).requestFullscreen;
    }
  });
});