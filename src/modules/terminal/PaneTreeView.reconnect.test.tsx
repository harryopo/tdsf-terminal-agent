import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { SshSession } from "@/lib/ssh-bridge";
import type { TerminalTransport, TerminalTransportHandlers } from "./lib/pty-bridge";
import {
  getLeafRemoteCwd,
  getLeafSshSession,
  setLeafSshSession,
} from "@/lib/param-complete-client";
import {
  useSshStore,
  type SshSessionInfo,
} from "@/modules/ssh-explorer/sshStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import type { PaneNode } from "./lib/panes";
import type { TerminalPaneHandle } from "./TerminalPane";
import { PaneTreeView } from "./PaneTreeView";

type TerminalPaneProps = ComponentProps<typeof import("./TerminalPane").TerminalPane>;

const mockTerminal = vi.hoisted(() => ({
  invoke: vi.fn(async (command: string) => {
    throw new Error(`Unexpected RPC in PaneTreeView reconnect test: ${command}`);
  }),
  localLeaves: new Set<number>(),
  panes: new Map<number, TerminalPaneProps>(),
  transports: new Map<number, TerminalTransport>(),
}));

vi.mock("@tauri-apps/api/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tauri-apps/api/core")>();
  return { ...actual, invoke: mockTerminal.invoke };
});

// Keep PaneTreeView, the SSH store, transport hook and leaf registry real. This
// adapter replaces only the physical xterm view while still opening and closing
// the actual transport supplied by PaneTreeView.
vi.mock("./TerminalPane", async () => {
  const React = await import("react");
  return {
    TerminalPane: function TerminalPaneAdapter(props: TerminalPaneProps) {
      mockTerminal.panes.set(props.leafId, props);
      const { leafId, openTransport, transportKey } = props;
      React.useEffect(() => {
        if (!openTransport) {
          mockTerminal.localLeaves.add(leafId);
          return () => {
            mockTerminal.localLeaves.delete(leafId);
          };
        }

        mockTerminal.localLeaves.delete(leafId);
        let active = true;
        let transport: TerminalTransport | null = null;
        const onData = vi.fn();
        const handlers: TerminalTransportHandlers = { onData, onExit: vi.fn() };
        void openTransport(handlers).then((opened) => {
          if (!active) {
            opened.close();
            return;
          }
          transport = opened;
          mockTerminal.transports.set(leafId, opened);
        });
        return () => {
          active = false;
          if (transport) {
            transport.close();
            if (mockTerminal.transports.get(leafId) === transport) {
              mockTerminal.transports.delete(leafId);
            }
          }
        };
      }, [leafId, openTransport, transportKey]);
      return null;
    },
  };
});

const LEAF_A = 73101;
const LEAF_B = 73102;
const SESSION_A = "pane-reconnect-session-a";
const SESSION_B = "pane-reconnect-session-b";
const TRANSITIONAL_STATES = [
  "reconnecting",
  "connecting",
  "handshaking",
  "host_verifying",
  "authenticating",
  "authenticated",
] as const;

let savedStoreState: ReturnType<typeof useSshStore.getState>;
let savedPreferencesState: ReturnType<typeof usePreferencesStore.getState>;

function makeHandle(id: number) {
  return {
    id,
    write: vi.fn(async (_data: string) => {}),
    resize: vi.fn(async (_cols: number, _rows: number) => {}),
    close: vi.fn(async () => {}),
  } satisfies SshSession;
}

function makeSession(
  id: string,
  rustSessionId: number | null,
  state: SshSessionInfo["state"],
  handle: SshSession | null,
): SshSessionInfo {
  return {
    id,
    rustSessionId,
    params: {
      host: `${id}.example.test`,
      port: 22,
      user: "tester",
      cols: 80,
      rows: 24,
      term: "xterm-256color",
    },
    state,
    connectedAt: 1,
    handle,
    origin: "tab",
  };
}

function tree(id: number): PaneNode {
  return { kind: "leaf", id };
}

function bundle() {
  return {
    setRef: (_handle: TerminalPaneHandle | null) => {},
    onSearchReady: () => {},
    onCwd: () => {},
    onExit: () => {},
  };
}

function pane(node: PaneNode, tabSshSessionId: string | null = SESSION_A) {
  return (
    <PaneTreeView
      node={node}
      tabVisible
      activeLeafId={LEAF_A}
      blocks
      tabSshSessionId={tabSshSessionId}
      onFocusLeaf={() => {}}
      getBundle={() => bundle()}
    />
  );
}

function installSessions(...sessions: SshSessionInfo[]) {
  useSshStore.setState({ sessions, currentPathBySession: {} });
}

function transition(id: string, state: SshSessionInfo["state"]) {
  act(() => {
    useSshStore.getState().updateSessionStatus(id, {
      state,
      host: `${id}.example.test`,
      port: 22,
      timestamp: Date.now(),
    });
  });
}

async function waitForTransport(leafId: number) {
  await waitFor(() => expect(mockTerminal.transports.has(leafId)).toBe(true));
  return mockTerminal.transports.get(leafId)!;
}

beforeEach(() => {
  savedStoreState = useSshStore.getState();
  savedPreferencesState = usePreferencesStore.getState();
  usePreferencesStore.setState({ zoomLevel: 1, sshRemoteCarapacePrompt: false });
  mockTerminal.localLeaves.clear();
  mockTerminal.panes.clear();
  mockTerminal.transports.clear();
  mockTerminal.invoke.mockClear();
});

afterEach(() => {
  cleanup();
  setLeafSshSession(LEAF_A, null);
  setLeafSshSession(LEAF_B, null);
  useSshStore.setState(savedStoreState, true);
  usePreferencesStore.setState(savedPreferencesState, true);
  expect(mockTerminal.invoke).not.toHaveBeenCalled();
});

describe("PaneTreeView SSH leaf residency during reconnect", () => {
  it.each(TRANSITIONAL_STATES)(
    "keeps the existing SSH leaf and transport in %s",
    async (state) => {
      const handle = makeHandle(41);
      installSessions(makeSession(SESSION_A, 41, "connected", handle));
      const view = render(pane(tree(LEAF_A)));
      const transport = await waitForTransport(LEAF_A);
      const close = vi.spyOn(transport, "close");

      transition(SESSION_A, state);

      await waitFor(() => expect(getLeafSshSession(LEAF_A)).toBe(41));
      expect(mockTerminal.transports.get(LEAF_A)).toBe(transport);
      expect(mockTerminal.localLeaves.has(LEAF_A)).toBe(false);
      expect(close).not.toHaveBeenCalled();
      transport.write("echo reconnect-safe\n");
      expect(handle.write).toHaveBeenCalledWith("echo reconnect-safe\n");
      view.unmount();
    },
  );

  it("keeps one transport through a full reconnect and returns to connected", async () => {
    const handle = makeHandle(42);
    installSessions(makeSession(SESSION_A, 42, "connected", handle));
    const view = render(pane(tree(LEAF_A)));
    const transport = await waitForTransport(LEAF_A);
    const close = vi.spyOn(transport, "close");

    for (const state of TRANSITIONAL_STATES) {
      transition(SESSION_A, state);
      await waitFor(() => expect(getLeafSshSession(LEAF_A)).toBe(42));
      expect(mockTerminal.transports.get(LEAF_A)).toBe(transport);
    }
    transition(SESSION_A, "connected");

    expect(mockTerminal.transports.get(LEAF_A)).toBe(transport);
    expect(close).not.toHaveBeenCalled();
    expect(getLeafRemoteCwd(LEAF_A)).toBeNull();
    mockTerminal.panes.get(LEAF_A)!.onCwd!(LEAF_A, "/srv/project");
    expect(useSshStore.getState().currentPathBySession[SESSION_A]).toBe(
      "/srv/project",
    );
    expect(getLeafRemoteCwd(LEAF_A)).toBe("/srv/project");
    view.unmount();
  });

  it.each(["failed", "closed"] as const)(
    "clears the leaf binding and returns to local on %s",
    async (state) => {
      installSessions(makeSession(SESSION_A, 43, "connected", makeHandle(43)));
      const view = render(pane(tree(LEAF_A)));
      const transport = await waitForTransport(LEAF_A);
      const close = vi.spyOn(transport, "close");

      transition(SESSION_A, state);

      await waitFor(() => expect(mockTerminal.localLeaves.has(LEAF_A)).toBe(true));
      expect(getLeafSshSession(LEAF_A)).toBeNull();
      expect(close).toHaveBeenCalledOnce();
      view.unmount();
    },
  );

  it("uses the explicit local leaf override inside an SSH tab", async () => {
    installSessions(makeSession(SESSION_A, 44, "connected", makeHandle(44)));

    render(pane({ kind: "leaf", id: LEAF_A, sshSessionId: null }));

    await waitFor(() => expect(mockTerminal.localLeaves.has(LEAF_A)).toBe(true));
    expect(getLeafSshSession(LEAF_A)).toBeNull();
    expect(mockTerminal.transports.has(LEAF_A)).toBe(false);
  });

  it("keeps a first connection local until a matching SSH handle is ready", async () => {
    installSessions(makeSession(SESSION_A, null, "connecting", null));

    const view = render(pane(tree(LEAF_A)));

    await waitFor(() => expect(mockTerminal.localLeaves.has(LEAF_A)).toBe(true));
    expect(getLeafSshSession(LEAF_A)).toBeNull();
    expect(mockTerminal.transports.has(LEAF_A)).toBe(false);

    act(() => {
      installSessions(
        makeSession(SESSION_A, 44, "connected", makeHandle(44)),
      );
    });

    await waitFor(() => expect(getLeafSshSession(LEAF_A)).toBe(44));
    await waitForTransport(LEAF_A);
    expect(mockTerminal.localLeaves.has(LEAF_A)).toBe(false);
    view.unmount();
  });

  it.each([
    ["missing handle", 45, null],
    ["handle for another Rust session", 46, makeHandle(460)],
  ] as const)(
    "does not treat a transitional session with %s as usable SSH",
    async (_label, rustSessionId, handle) => {
      installSessions(
        makeSession(SESSION_A, rustSessionId, "reconnecting", handle),
      );

      render(pane(tree(LEAF_A)));

      await waitFor(() => expect(mockTerminal.localLeaves.has(LEAF_A)).toBe(true));
      expect(getLeafSshSession(LEAF_A)).toBeNull();
      expect(mockTerminal.transports.has(LEAF_A)).toBe(false);
    },
  );

  it("returns to local and clears the binding when the session disappears", async () => {
    installSessions(makeSession(SESSION_A, 47, "connected", makeHandle(47)));
    const view = render(pane(tree(LEAF_A)));
    const transport = await waitForTransport(LEAF_A);
    const close = vi.spyOn(transport, "close");

    act(() => installSessions());

    await waitFor(() => expect(mockTerminal.localLeaves.has(LEAF_A)).toBe(true));
    expect(getLeafSshSession(LEAF_A)).toBeNull();
    expect(close).toHaveBeenCalledOnce();
    view.unmount();
  });

  it("keeps another leaf bound and connected while this leaf reconnects", async () => {
    const handleA = makeHandle(48);
    const handleB = makeHandle(49);
    installSessions(
      makeSession(SESSION_A, 48, "connected", handleA),
      makeSession(SESSION_B, 49, "connected", handleB),
    );
    const view = render(
      <>
        {pane(tree(LEAF_A), SESSION_A)}
        {pane(tree(LEAF_B), SESSION_B)}
      </>,
    );
    const transportA = await waitForTransport(LEAF_A);
    const transportB = await waitForTransport(LEAF_B);
    const closeB = vi.spyOn(transportB, "close");

    transition(SESSION_A, "reconnecting");

    await waitFor(() => expect(getLeafSshSession(LEAF_A)).toBe(48));
    expect(mockTerminal.transports.get(LEAF_A)).toBe(transportA);
    expect(mockTerminal.transports.get(LEAF_B)).toBe(transportB);
    expect(getLeafSshSession(LEAF_B)).toBe(49);
    expect(closeB).not.toHaveBeenCalled();
    transportB.write("echo still-on-b\n");
    expect(handleB.write).toHaveBeenCalledWith("echo still-on-b\n");
    expect(handleA.write).not.toHaveBeenCalled();
    view.unmount();
  });

  it("replaces the transport when the leaf binds to a different session", async () => {
    const handleA = makeHandle(50);
    const handleB = makeHandle(51);
    installSessions(
      makeSession(SESSION_A, 50, "connected", handleA),
      makeSession(SESSION_B, 51, "connected", handleB),
    );
    const view = render(pane(tree(LEAF_A), SESSION_A));
    const transportA = await waitForTransport(LEAF_A);
    const closeA = vi.spyOn(transportA, "close");

    view.rerender(pane(tree(LEAF_A), SESSION_B));

    await waitFor(() => expect(getLeafSshSession(LEAF_A)).toBe(51));
    await waitFor(() =>
      expect(mockTerminal.transports.get(LEAF_A)).not.toBe(transportA),
    );
    expect(closeA).toHaveBeenCalledOnce();
    const transportB = mockTerminal.transports.get(LEAF_A)!;
    transportB.write("echo bound-to-b\n");
    expect(handleB.write).toHaveBeenCalledWith("echo bound-to-b\n");
    expect(handleA.write).not.toHaveBeenCalled();
    view.unmount();
  });
});
