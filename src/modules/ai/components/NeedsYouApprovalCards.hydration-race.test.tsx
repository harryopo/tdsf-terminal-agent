import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { invokeRpc, onNeedsYou } from "@/lib/sidecar-bridge";
import { NeedsYouApprovalCards } from "./NeedsYouApprovalCards";
import { useChatStore } from "../store/chatStore";
import { useNeedsYouWait } from "../store/needsYouWaitStore";

type NeedsYouCb = (payload: unknown) => void;
let needsYouCb: NeedsYouCb | null = null;

vi.mock("@/lib/sidecar-bridge", () => ({
  invokeRpc: vi.fn(),
  onNeedsYou: vi.fn(async (cb: NeedsYouCb) => {
    needsYouCb = cb;
    return () => {};
  }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function pendingApproval(id: string, title: string) {
  return {
    id,
    type: "approval",
    title,
    description: title,
    session_id: "sess-hydration",
    status: "pending",
    extra: {
      command: "systemctl status nginx",
      semantic: title,
      tool_name: "ssh_command",
      risk_l: 1,
      impact: { summary: title, max_risk_l: 1 },
    },
  };
}

function terminalEvent(
  id: string,
  event: "cancelled" | "responded" | "timeout",
) {
  return {
    event_type: "needs_you",
    payload: {
      needs_type: "approval",
      event,
      request: {
        id,
        type: "approval",
        session_id: "sess-hydration",
        status: event === "responded" ? "approved" : event,
      },
    },
    session_id: "sess-hydration",
  };
}

beforeEach(() => {
  vi.mocked(invokeRpc).mockReset();
  vi.mocked(onNeedsYou).mockClear();
  needsYouCb = null;
  useNeedsYouWait.getState().reset();
  useChatStore.setState({ activeSessionId: "sess-hydration" });
});

afterEach(() => {
  cleanup();
  useNeedsYouWait.getState().reset();
  useChatStore.setState({ activeSessionId: null, sessionReadOnlyTrust: false });
  needsYouCb = null;
  vi.clearAllMocks();
});

describe("NeedsYouApprovalCards delayed list hydration", () => {
  it.each(["cancelled", "responded", "timeout"] as const)(
    "does not restore a %s request from an older pending snapshot",
    async (terminalState) => {
      const list = deferred<unknown[]>();
      vi.mocked(invokeRpc).mockImplementation((method: string) =>
        method === "needs_you.list" ? list.promise : Promise.resolve({}),
      );

      render(<NeedsYouApprovalCards />);
      await waitFor(() => expect(onNeedsYou).toHaveBeenCalled());
      expect(needsYouCb).toBeTruthy();

      const stale = pendingApproval("ny-stale", "Stale request");
      const fresh = pendingApproval("ny-fresh", "Fresh request");
      emitTerminal(terminalEvent(stale.id, terminalState));

      await act(async () => {
        list.resolve([stale, fresh]);
        await list.promise;
      });

      expect(
        useNeedsYouWait
          .getState()
          .pending.some((item) => item.reqId === fresh.id),
      ).toBe(true);
      expect(screen.queryAllByText("Stale request")).toHaveLength(0);
      expect(
        useNeedsYouWait
          .getState()
          .pending.some((item) => item.reqId === stale.id),
      ).toBe(false);
      expect(screen.queryAllByText("Fresh request").length).toBeGreaterThan(0);
    },
  );
});

function emitTerminal(payload: unknown) {
  act(() => {
    needsYouCb?.(payload);
  });
}
