import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invokeRpc, onNeedsYou } from "@/lib/sidecar-bridge";
import { NeedsYouApprovalCards } from "./NeedsYouApprovalCards";
import { NeedsYouApprovalFallback } from "../lib/needsYouApprovalContext";
import { useChatStore } from "../store/chatStore";
import { isAwaitingUser, useNeedsYouWait } from "../store/needsYouWaitStore";

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

function createdEvent(id: string, kind: "approval" | "question", sessionId: string) {
  return {
    event_type: "needs_you",
    payload: {
      needs_type: kind,
      event: "created",
      request: {
        id,
        type: kind,
        session_id: sessionId,
        status: "pending",
        title: `${id} title`,
        description: `${id} question`,
        extra: { question: `${id} question`, command: "systemctl status nginx" },
      },
    },
    session_id: sessionId,
  };
}

describe("NeedsYouApprovalCards pending snapshot reconciliation", () => {
  it.each(["approval", "question"] as const)(
    "clears an old %s wait when the new owner snapshot is empty",
    async (kind) => {
      const secondList = deferred<unknown>();
      let listCalls = 0;
      vi.mocked(invokeRpc).mockImplementation((method: string) => {
        if (method !== "needs_you.list") return Promise.resolve({});
        listCalls += 1;
        return listCalls === 1 ? Promise.resolve([]) : secondList.promise;
      });

      const oldOwner = render(<NeedsYouApprovalCards />);
      await waitFor(() => expect(onNeedsYou).toHaveBeenCalledTimes(1));
      act(() => needsYouCb?.(createdEvent(`gap-${kind}`, kind, "sess-hydration")));
      expect(isAwaitingUser(useNeedsYouWait.getState(), "sess-hydration")).toBe(true);

      oldOwner.unmount();
      expect(isAwaitingUser(useNeedsYouWait.getState(), "sess-hydration")).toBe(true);

      render(<NeedsYouApprovalCards />);
      await waitFor(() => expect(onNeedsYou).toHaveBeenCalledTimes(2));
      await act(async () => {
        secondList.resolve([]);
        await secondList.promise;
      });

      expect(useNeedsYouWait.getState().pending.map((item) => item.reqId)).not.toContain(`gap-${kind}`);
      expect(isAwaitingUser(useNeedsYouWait.getState(), "sess-hydration")).toBe(false);
    },
  );

  it("restores a still-pending request from the snapshot and shows its card", async () => {
    const row = pendingApproval("snapshot-b", "Snapshot B");
    row.session_id = "sess-b";
    vi.mocked(invokeRpc).mockImplementation((method: string) =>
      method === "needs_you.list" ? Promise.resolve([row]) : Promise.resolve({}),
    );
    useChatStore.setState({ activeSessionId: "sess-b" });
    render(<NeedsYouApprovalCards />);

    await waitFor(() =>
      expect(document.querySelector('[data-needs-you-request-id="snapshot-b"]')).not.toBeNull(),
    );
    expect(useNeedsYouWait.getState().pending).toContainEqual({ reqId: "snapshot-b", sessionId: "sess-b" });
  });

  it("keeps a live created request that arrives while the snapshot is pending", async () => {
    const list = deferred<unknown>();
    vi.mocked(invokeRpc).mockImplementation((method: string) =>
      method === "needs_you.list" ? list.promise : Promise.resolve({}),
    );
    render(<NeedsYouApprovalCards />);
    await waitFor(() => expect(onNeedsYou).toHaveBeenCalled());
    act(() => needsYouCb?.(createdEvent("live-during-snapshot", "question", "sess-hydration")));

    await act(async () => {
      list.resolve([pendingApproval("snapshot-row", "Snapshot row")]);
      await list.promise;
    });

    expect(useNeedsYouWait.getState().pending.map((item) => item.reqId)).toEqual(
      expect.arrayContaining(["live-during-snapshot", "snapshot-row"]),
    );
    expect(screen.getByText("live-during-snapshot question")).toBeTruthy();
  });

  it("reconciles a mixed snapshot without dropping a newer live request", async () => {
    const list = deferred<unknown>();
    useNeedsYouWait.getState().markPending("stale-a", "sess-a");
    useNeedsYouWait.getState().markPending("keep-b", "sess-b");
    useChatStore.setState({ activeSessionId: "sess-b" });
    vi.mocked(invokeRpc).mockImplementation((method: string) =>
      method === "needs_you.list" ? list.promise : Promise.resolve({}),
    );
    render(<NeedsYouApprovalCards />);
    await waitFor(() => expect(onNeedsYou).toHaveBeenCalled());
    act(() => needsYouCb?.(createdEvent("fresh-a", "question", "sess-a")));

    const stillPendingOnB = pendingApproval("keep-b", "Keep B");
    stillPendingOnB.session_id = "sess-b";
    await act(async () => {
      list.resolve([stillPendingOnB]);
      await list.promise;
    });

    expect(useNeedsYouWait.getState().pending.map((item) => item.reqId).sort()).toEqual([
      "fresh-a",
      "keep-b",
    ]);
    expect(document.querySelector('[data-needs-you-request-id="keep-b"]')).not.toBeNull();
    act(() => useChatStore.setState({ activeSessionId: "sess-a" }));
    await waitFor(() =>
      expect(document.querySelector('[data-needs-you-request-id="fresh-a"]')).not.toBeNull(),
    );
  });

  it.each([
    ["rejects", () => Promise.reject(new Error("sidecar unavailable"))],
    ["is not an array", () => Promise.resolve({ pending: [] })],
  ] as const)("preserves an existing wait when needs_you.list %s", async (_case, response) => {
    useNeedsYouWait.getState().markPending("must-stay", "sess-hydration");
    vi.mocked(invokeRpc).mockImplementation((method: string) =>
      method === "needs_you.list" ? response() : Promise.resolve({}),
    );
    render(<NeedsYouApprovalCards />);

    await waitFor(() => expect(onNeedsYou).toHaveBeenCalled());
    await waitFor(() => expect(vi.mocked(invokeRpc)).toHaveBeenCalledWith("needs_you.list", {}));
    await act(async () => Promise.resolve());
    expect(isAwaitingUser(useNeedsYouWait.getState(), "sess-hydration")).toBe(true);
    expect(useNeedsYouWait.getState().pending.map((item) => item.reqId)).toContain("must-stay");
  });

  it.each([
    ["valid ACK arrives before the snapshot", "ack"],
    ["valid ACK is still pending", "pending"],
    ["respond returns no ACK", "null"],
  ] as const)("reconciles the request correctly when %s", async (_label, responseMode) => {
    const response = deferred<unknown>();
    const snapshot = deferred<unknown>();
    const reqId = `respond-gap-${responseMode}`;
    let listCalls = 0;
    vi.mocked(invokeRpc).mockImplementation((method: string) => {
      if (method === "needs_you.respond") return response.promise;
      if (method === "needs_you.list") {
        listCalls += 1;
        return listCalls === 1 ? Promise.resolve([]) : snapshot.promise;
      }
      return Promise.resolve({});
    });

    const oldOwner = render(<NeedsYouApprovalCards />);
    await waitFor(() => expect(onNeedsYou).toHaveBeenCalledTimes(1));
    act(() => needsYouCb?.(createdEvent(reqId, "approval", "sess-hydration")));
    fireEvent.click(await screen.findByRole("button", { name: "执行" }));
    await waitFor(() => expect(invokeRpc).toHaveBeenCalledWith("needs_you.respond", {
      req_id: reqId,
      response: { approved: true },
    }));
    expect(isAwaitingUser(useNeedsYouWait.getState(), "sess-hydration")).toBe(true);

    oldOwner.unmount();
    render(<NeedsYouApprovalCards />);
    await waitFor(() => expect(onNeedsYou).toHaveBeenCalledTimes(2));

    if (responseMode === "ack") {
      await act(async () => {
        response.resolve({
          id: reqId,
          type: "approval",
          session_id: "sess-hydration",
          status: "approved",
        });
        await response.promise;
      });
      await waitFor(() =>
        expect(isAwaitingUser(useNeedsYouWait.getState(), "sess-hydration")).toBe(false),
      );
    } else if (responseMode === "null") {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await act(async () => {
          response.resolve(null);
          await response.promise;
        });
      } finally {
        errorSpy.mockRestore();
      }
    }

    const staleRow = pendingApproval(reqId, "Already approved request");
    await act(async () => {
      snapshot.resolve([staleRow]);
      await snapshot.promise;
    });

    if (responseMode === "ack") {
      expect(document.querySelector(`[data-needs-you-request-id="${reqId}"]`)).toBeNull();
      expect(useNeedsYouWait.getState().pending.map((item) => item.reqId)).not.toContain(reqId);
      expect(isAwaitingUser(useNeedsYouWait.getState(), "sess-hydration")).toBe(false);
    } else {
      expect(document.querySelector(`[data-needs-you-request-id="${reqId}"]`)).not.toBeNull();
      expect(useNeedsYouWait.getState().pending.map((item) => item.reqId)).toContain(reqId);
      expect(isAwaitingUser(useNeedsYouWait.getState(), "sess-hydration")).toBe(true);
    }
  });
});
