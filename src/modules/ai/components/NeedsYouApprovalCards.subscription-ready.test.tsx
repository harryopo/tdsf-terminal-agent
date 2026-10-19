import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { invokeRpc, onNeedsYou } from "@/lib/sidecar-bridge";
import { NeedsYouApprovalCards } from "./NeedsYouApprovalCards";
import { useChatStore } from "../store/chatStore";
import { useNeedsYouWait } from "../store/needsYouWaitStore";

type NeedsYouCb = (payload: unknown) => void;
type PendingRequest = {
  id: string;
  type: "approval" | "question";
  session_id: string;
  status: "pending";
  title: string;
  description: string;
  extra: Record<string, unknown>;
};

let backendRows: PendingRequest[] = [];
let readyHandler: NeedsYouCb | null = null;
let registration: ReturnType<typeof deferred<() => void>>;

vi.mock("@/lib/sidecar-bridge", () => ({
  invokeRpc: vi.fn(),
  onNeedsYou: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function request(type: "approval" | "question", id: string): PendingRequest {
  return {
    id,
    type,
    session_id: "sess-subscription-ready",
    status: "pending",
    title: `${id} title`,
    description: `${id} question`,
    extra: type === "approval"
      ? {
          command: "systemctl status nginx",
          semantic: `${id} semantic`,
          tool_name: "ssh_command",
          risk_l: 1,
        }
      : { question: `${id} question` },
  };
}

function createdEvent(req: PendingRequest) {
  return {
    event_type: "needs_you",
    payload: {
      needs_type: req.type,
      event: "created",
      request: req,
    },
    session_id: req.session_id,
  };
}

function terminalEvent(req: PendingRequest) {
  return {
    event_type: "needs_you",
    payload: {
      needs_type: req.type,
      event: "responded",
      request: { ...req, status: "resolved" },
    },
    session_id: req.session_id,
  };
}

function emitWhenSubscribed(payload: unknown) {
  if (readyHandler) act(() => readyHandler?.(payload));
}

beforeEach(() => {
  backendRows = [];
  readyHandler = null;
  registration = deferred<() => void>();
  vi.mocked(onNeedsYou).mockReset().mockImplementation((cb: NeedsYouCb) =>
    registration.promise.then((unlisten) => {
      readyHandler = cb;
      return unlisten;
    }),
  );
  vi.mocked(invokeRpc).mockReset().mockImplementation((method: string) =>
    method === "needs_you.list" ? Promise.resolve(backendRows.slice()) : Promise.resolve({}),
  );
  useNeedsYouWait.getState().reset();
  useChatStore.setState({ activeSessionId: "sess-subscription-ready" });
});

afterEach(async () => {
  cleanup();
  await act(async () => {
    registration.resolve(() => {});
    await registration.promise;
  });
  useNeedsYouWait.getState().reset();
  useChatStore.setState({ activeSessionId: null, sessionReadOnlyTrust: false });
  readyHandler = null;
  vi.clearAllMocks();
});

describe("NeedsYouApprovalCards waits for subscription readiness", () => {
  it.each(["approval", "question"] as const)(
    "restores a pending %s created during the registration window from the ready snapshot",
    async (type) => {
      render(<NeedsYouApprovalCards />);
      await waitFor(() => expect(onNeedsYou).toHaveBeenCalledTimes(1));

      const req = request(type, `ny-registration-${type}`);
      // list snapshots its rows at invocation; the request arrives after that snapshot,
      // while Tauri listen() has not acknowledged registration, so no event is delivered.
      backendRows.push(req);
      emitWhenSubscribed(createdEvent(req));

      const unlisten = vi.fn();
      await act(async () => {
        registration.resolve(unlisten);
        await registration.promise;
      });

      await waitFor(() =>
        expect(document.querySelector(`[data-needs-you-request-id="${req.id}"]`)).not.toBeNull(),
      );
      await waitFor(() =>
        expect(useNeedsYouWait.getState().pending).toContainEqual({
          reqId: req.id,
          sessionId: req.session_id,
        }),
      );
      expect(vi.mocked(invokeRpc).mock.calls.filter(([method]) => method === "needs_you.list")).toHaveLength(1);
    },
  );

  it("unlistens once and does not start snapshot hydration when unmounted before the registration ACK", async () => {
    const view = render(<NeedsYouApprovalCards />);
    await waitFor(() => expect(onNeedsYou).toHaveBeenCalledTimes(1));
    const unlisten = vi.fn();

    view.unmount();
    await act(async () => {
      registration.resolve(unlisten);
      await registration.promise;
    });

    await waitFor(() => expect(unlisten).toHaveBeenCalledTimes(1));
    expect(vi.mocked(invokeRpc).mock.calls.filter(([method]) => method === "needs_you.list")).toHaveLength(0);
    expect(useNeedsYouWait.getState().pending).toEqual([]);
  });

  it("restores an existing pending request when event registration rejects", async () => {
    const req = request("approval", "ny-registration-rejected");
    backendRows.push(req);
    vi.mocked(onNeedsYou).mockRejectedValueOnce(new Error("listen registration failed"));

    render(<NeedsYouApprovalCards />);

    await waitFor(() =>
      expect(document.querySelector(`[data-needs-you-request-id="${req.id}"]`)).not.toBeNull(),
    );
    expect(useNeedsYouWait.getState().pending).toContainEqual({
      reqId: req.id,
      sessionId: req.session_id,
    });
    expect(vi.mocked(invokeRpc).mock.calls.filter(([method]) => method === "needs_you.list")).toHaveLength(1);
  });

  it("handles a live created event after readiness and settles its wait on a terminal event", async () => {
    render(<NeedsYouApprovalCards />);
    await waitFor(() => expect(onNeedsYou).toHaveBeenCalledTimes(1));
    const unlisten = vi.fn();
    await act(async () => {
      registration.resolve(unlisten);
      await registration.promise;
    });

    const req = request("question", "ny-live-after-ready");
    backendRows.push(req);
    emitWhenSubscribed(createdEvent(req));

    await waitFor(() =>
      expect(document.querySelector(`[data-needs-you-request-id="${req.id}"]`)).not.toBeNull(),
    );
    expect(useNeedsYouWait.getState().pending).toContainEqual({
      reqId: req.id,
      sessionId: req.session_id,
    });

    emitWhenSubscribed(terminalEvent(req));
    await waitFor(() =>
      expect(document.querySelector(`[data-needs-you-request-id="${req.id}"]`)).toBeNull(),
    );
    expect(useNeedsYouWait.getState().pending).toEqual([]);
  });
});
