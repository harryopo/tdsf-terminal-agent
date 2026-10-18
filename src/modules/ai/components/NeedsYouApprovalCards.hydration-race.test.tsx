import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { invokeRpc, onNeedsYou } from "@/lib/sidecar-bridge";
import { NeedsYouApprovalCards } from "./NeedsYouApprovalCards";
import { NeedsYouApprovalFallback } from "../lib/needsYouApprovalContext";
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
  vi.mocked(onNeedsYou).mockReset().mockImplementation(async (cb: NeedsYouCb) => {
    needsYouCb = cb;
    return () => {};
  });
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

describe("NeedsYouApprovalCards subscription hydration lifecycle", () => {
  it.each([
    ["approval", "ACK already returned"],
    ["approval", "ACK still pending"],
    ["question", "ACK already returned"],
    ["question", "ACK still pending"],
  ] as const)("ignores a late created event from the old %s handler when %s", async (kind, ackState) => {
    vi.mocked(invokeRpc).mockImplementation((method: string) =>
      method === "needs_you.list" ? Promise.resolve([]) : Promise.resolve({}),
    );
    const delayedAck = deferred<() => void>();
    const registeredHandlers: NeedsYouCb[] = [];
    const oldUnlisten = vi.fn();
    const newUnlisten = vi.fn();
    let subscriptionCount = 0;
    vi.mocked(onNeedsYou).mockImplementation((cb: NeedsYouCb) => {
      registeredHandlers.push(cb);
      needsYouCb = cb;
      subscriptionCount += 1;
      if (subscriptionCount === 1 && ackState === "ACK still pending") {
        return delayedAck.promise;
      }
      return Promise.resolve(subscriptionCount === 1 ? oldUnlisten : newUnlisten);
    });

    let newView: ReturnType<typeof render> | undefined;
    try {
      const oldView = render(
        <NeedsYouApprovalCards><NeedsYouApprovalFallback /></NeedsYouApprovalCards>,
      );
      await waitFor(() => expect(registeredHandlers).toHaveLength(1));
      const oldHandler = registeredHandlers[0];
      oldView.unmount();

      newView = render(
        <NeedsYouApprovalCards><NeedsYouApprovalFallback /></NeedsYouApprovalCards>,
      );
      await waitFor(() => expect(registeredHandlers).toHaveLength(2));
      const newHandler = registeredHandlers[1];
      const oldId = `old-${kind}`;
      const newId = `new-${kind}`;
      const created = (id: string) => ({
        event_type: "needs_you",
        payload: {
          needs_type: kind,
          event: "created",
          request: {
            id,
            type: kind,
            session_id: "sess-hydration",
            status: "pending",
            title: `${id} title`,
            description: `${id} question`,
            extra: { question: `${id} question` },
          },
        },
        session_id: "sess-hydration",
      });

      act(() => newHandler(created(newId)));
      await waitFor(() =>
        expect(document.querySelector(`[data-needs-you-request-id="${newId}"]`)).not.toBeNull(),
      );
      expect(useNeedsYouWait.getState().pending.map((item) => item.reqId)).toEqual([newId]);

      act(() => oldHandler(created(oldId)));
      expect(document.querySelector(`[data-needs-you-request-id="${oldId}"]`)).toBeNull();
      expect(useNeedsYouWait.getState().pending.map((item) => item.reqId)).toEqual([newId]);

      const terminal = terminalEvent(newId, "responded");
      act(() => newHandler({
        ...terminal,
        payload: {
          ...terminal.payload,
          needs_type: kind,
          request: { ...terminal.payload.request, type: kind },
        },
      }));
      await waitFor(() => expect(useNeedsYouWait.getState().pending).toHaveLength(0));
      expect(document.querySelector(`[data-needs-you-request-id="${newId}"]`)).toBeNull();
      expect(vi.mocked(invokeRpc).mock.calls.some(([method]) => method === "needs_you.respond")).toBe(false);
    } finally {
      if (ackState === "ACK still pending") {
        await act(async () => {
          delayedAck.resolve(oldUnlisten);
          await delayedAck.promise;
        });
      }
      await waitFor(() => expect(oldUnlisten).toHaveBeenCalledTimes(1));
      newView?.unmount();
    }
  });
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
