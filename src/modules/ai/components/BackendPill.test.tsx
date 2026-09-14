import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { BackendPill } from "./BackendPill";
import { invokeRpc, subscribe } from "@/lib/sidecar-bridge";

vi.mock("@/lib/sidecar-bridge", () => ({
  invokeRpc: vi.fn(),
  subscribe: vi.fn(),
}));

const status = (overrides: Record<string, unknown> = {}) => ({
  backend_type: "strands",
  backend_activated: false,
  strands_available: false,
  rust_bridge_active: false,
  llm_configured: false,
  fallback_reason: null,
  activate_time: 0,
  ...overrides,
});

describe("BackendPill", () => {
  beforeEach(() => {
    vi.mocked(subscribe).mockResolvedValue(() => {});
  });
  afterEach(() => vi.clearAllMocks());

  it("shows Unavailable when health reports fallback", async () => {
    vi.mocked(invokeRpc).mockResolvedValue(
      status({ backend_type: "unknown", fallback_reason: "boom" }),
    );
    render(
      <TooltipProvider>
        <BackendPill />
      </TooltipProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("backend-pill").textContent).toContain(
        "Unavailable",
      ),
    );
    expect(screen.queryByText("LangGraph")).toBeNull();
  });

  it("defaults partial backend status to strands without a previous value", async () => {
    let backendCallback: ((payload: unknown) => void) | undefined;
    vi.mocked(invokeRpc).mockRejectedValue(new Error("offline"));
    vi.mocked(subscribe).mockImplementation(async (event, callback) => {
      if (event === "backend_status")
        backendCallback = callback as (payload: unknown) => void;
      return () => {};
    });
    render(
      <TooltipProvider>
        <BackendPill />
      </TooltipProvider>,
    );
    await act(async () => backendCallback?.({ backend_activated: true }));
    await waitFor(() =>
      expect(screen.getByTestId("backend-pill").textContent).toContain(
        "Strands",
      ),
    );
  });

  it("recovers from health failure when a successful status clears fallback", async () => {
    let backendCallback: ((payload: unknown) => void) | undefined;
    vi.mocked(invokeRpc).mockResolvedValue(status({ fallback_reason: "boom" }));
    vi.mocked(subscribe).mockImplementation(async (event, callback) => {
      if (event === "backend_status")
        backendCallback = callback as (payload: unknown) => void;
      return () => {};
    });
    render(
      <TooltipProvider>
        <BackendPill />
      </TooltipProvider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("backend-pill").textContent).toContain(
        "Unavailable",
      ),
    );
    await act(async () =>
      backendCallback?.({
        backend_type: "strands",
        backend_activated: true,
        fallback_reason: null,
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("backend-pill").textContent).toContain(
        "Strands",
      ),
    );
  });
});
