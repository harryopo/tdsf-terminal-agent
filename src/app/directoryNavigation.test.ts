import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { quoteShellArg } from "@/lib/shellQuote";
import type { SshConnectParams } from "@/lib/ssh-bridge";
import { explorerSessionIdForTab } from "@/modules/explorer/lib/explorerSession";
import { isSessionConnected, type SshSessionInfo } from "@/modules/ssh-explorer";
import { effectiveLeafSsh } from "@/modules/terminal/lib/panes";
import type { Tab } from "@/modules/tabs/lib/useTabs";

type Options = {
  tabKind?: "terminal" | "file";
  activeTabId?: number;
  currentTabId?: number;
  activeLeafId?: number | null;
  currentLeafId?: number;
  ssh?: boolean;
  connected?: boolean;
  sessionRustId?: number | null;
  leafRustId?: number | null;
  slot?: boolean;
  busy?: boolean;
  dirty?: boolean;
  draft?: string;
  pendingRisk?: unknown;
  alternateScreen?: boolean;
  cold?: boolean;
};

function sendCdCallback(
  bindings: Record<string, unknown>,
): (path: string) => void {
  const source = readFileSync(
    resolve(process.cwd(), "src/app/App.tsx"),
    "utf8",
  );
  const file = ts.createSourceFile(
    "App.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const found: ts.ArrowFunction[] = [];

  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(file) === "sendCd" &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      node.initializer.expression.getText(file) === "useCallback"
    ) {
      const callback = node.initializer.arguments[0];
      if (callback && ts.isArrowFunction(callback)) found.push(callback);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  expect(
    found,
    "App.tsx should have one sendCd useCallback arrow",
  ).toHaveLength(1);

  const javascript = ts
    .transpileModule(found[0].getText(file), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.None,
      },
    })
    .outputText.trim()
    .replace(/;$/, "");
  const scope = new Proxy(bindings, {
    has: () => true,
    get(target, key) {
      if (key === Symbol.unscopables) return undefined;
      if (Reflect.has(target, key)) return Reflect.get(target, key);
      return Reflect.get(globalThis, key);
    },
  });
  return new Function("scope", `with (scope) { return (${javascript}); }`)(
    scope,
  );
}

function appDirectorySource(bindings: Record<string, unknown>) {
  const source = readFileSync(
    resolve(process.cwd(), "src/app/App.tsx"),
    "utf8",
  );
  const file = ts.createSourceFile(
    "App.tsx",
    source,
    ts.ScriptTarget.Latest,
    true,
  );
  const initializers: ts.Expression[] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(file) === "directorySource" &&
      node.initializer
    ) {
      initializers.push(node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  expect(
    initializers,
    "App.tsx should have one directorySource initializer",
  ).toHaveLength(1);

  const javascript = ts
    .transpileModule(initializers[0].getText(file), {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.None,
      },
    })
    .outputText.trim()
    .replace(/;$/, "");
  const scope = new Proxy(bindings, {
    has: () => true,
    get(target, key) {
      if (key === Symbol.unscopables) return undefined;
      if (Reflect.has(target, key)) return Reflect.get(target, key);
      return Reflect.get(globalThis, key);
    },
  });
  return new Function("scope", `with (scope) { return (${javascript}); }`)(
    scope,
  );
}

type DirectoryOptions = {
  tab: Tab | null;
  sshSpace?: boolean;
  spaceSessionId?: string | null;
  sessions?: SshSessionInfo[];
};

function directorySource(options: DirectoryOptions) {
  const activeTab = options.tab;
  const activeTerminalTab = activeTab?.kind === "terminal" ? activeTab : null;
  const activeLeafId = activeTerminalTab?.activeLeafId ?? null;
  const spaceSshSessionId = options.spaceSessionId ?? null;
  const activeTabSshSessionId =
    activeTerminalTab && activeLeafId !== null
      ? effectiveLeafSsh(
          activeTerminalTab.paneTree,
          activeLeafId,
          activeTerminalTab.sshSessionId,
        )
      : null;
  const explorerSshSessionId = explorerSessionIdForTab(
    activeTab,
    activeTabSshSessionId,
    spaceSshSessionId,
  );
  const explorerSshSession =
    options.sessions?.find((session) => session.id === explorerSshSessionId) ??
    null;
  const explorerSshConnected =
    !!explorerSshSession && isSessionConnected(explorerSshSession);

  return appDirectorySource({
    activeSpace: options.sshSpace ? { env: { kind: "ssh" } } : null,
    activeTab,
    activeTerminalTab,
    activeLeafId,
    explorerSshSessionId,
    explorerSshSession,
    explorerSshConnected,
    effectiveLeafSsh,
  });
}

const connected = (id: string, rustSessionId: number | null): SshSessionInfo => ({
  id,
  state: "connected",
  rustSessionId,
  params: {
    host: "fixture.invalid",
    user: "fixture",
  } satisfies Omit<SshConnectParams, "auth">,
  connectedAt: 1,
  handle: null,
});

const closed = (id: string, rustSessionId: number | null): SshSessionInfo => ({
  ...connected(id, rustSessionId),
  state: "closed",
});

const terminalTab = (
  sshSessionId: string | null | undefined,
  leafSshSessionId: string | null | undefined = undefined,
  cold = false,
): Tab => ({
  spaceId: "space-fixture",
  id: 51,
  kind: "terminal",
  title: "terminal",
  activeLeafId: 41,
  paneTree: { kind: "leaf", id: 41, sshSessionId: leafSshSessionId },
  sshSessionId,
  cold,
});

function fixture(options: Options = {}) {
  const leafId = options.activeLeafId === undefined ? 41 : options.activeLeafId;
  const tabId = options.activeTabId ?? 7;
  const tab = {
    id: tabId,
    kind: options.tabKind ?? "terminal",
    activeLeafId: options.currentLeafId ?? leafId,
    sshSessionId: options.ssh ? "ssh-current" : null,
    cold: Boolean(options.cold),
  };
  const terminal = { write: vi.fn(), focus: vi.fn() };
  const toast = {
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
    message: vi.fn(),
  };
  const bindings = {
    activeId: options.currentTabId ?? tabId,
    activeIdRef: { current: options.currentTabId ?? tabId },
    activeLeafId: leafId,
    activeTabSshSessionId: options.ssh ? "ssh-current" : null,
    activeTerminalTab: tab,
    tabsRef: { current: [tab] },
    explorerSshConnected: Boolean(options.ssh),
    terminalRefs: {
      current: new Map([
        [41, terminal],
        [99, terminal],
      ]),
    },
    quoteShellArg,
    toast,
    useSshStore: {
      getState: () => ({
        sessions: [
          {
            id: "ssh-current",
            state: options.connected === false ? "disconnected" : "connected",
            rustSessionId:
              options.sessionRustId === undefined ? 42 : options.sessionRustId,
          },
        ],
      }),
    },
    getLeafSshSession: (id: number) =>
      id === 41
        ? options.leafRustId === undefined
          ? options.ssh
            ? 42
            : null
          : options.leafRustId
        : null,
    getSlotTerm: () => (options.slot === false ? null : terminal),
    isLeafBusy: () => Boolean(options.busy),
    isUserLineDirty: () => Boolean(options.dirty),
    getLeafDraft: () => options.draft ?? "",
    getPendingRiskCommand: () => options.pendingRisk ?? null,
    isLeafAltScreen: () => Boolean(options.alternateScreen),
    isSessionConnected: (session: {
      state: string;
      rustSessionId: number | null;
    }) => session.state === "connected" && session.rustSessionId !== null,
  };
  const toasts = () =>
    Object.values(toast).flatMap((method) => method.mock.calls);
  return { terminal, toast, toasts, sendCd: sendCdCallback(bindings) };
}

describe("App sendCd directory navigation", () => {
  it("writes a quoted path to the active connected SSH leaf", () => {
    const { terminal, sendCd } = fixture({ ssh: true });
    const path = "/srv/O'Brien; echo unsafe";

    sendCd(path);

    expect(terminal.write).toHaveBeenCalledWith(
      `cd ${quoteShellArg(path, false)}\r`,
    );
    expect(terminal.focus).toHaveBeenCalledOnce();
  });

  it("keeps the existing local terminal quoting behavior", () => {
    const { terminal, sendCd } = fixture();
    const path = "C:\\Users\\A B";

    sendCd(path);

    expect(terminal.write).toHaveBeenCalledWith(`cd ${quoteShellArg(path)}\r`);
    expect(terminal.focus).toHaveBeenCalledOnce();
  });

  it.each([
    ["SSH transport disconnected", { ssh: true, connected: false }],
    ["SSH session has no Rust session", { ssh: true, sessionRustId: null }],
    ["SSH leaf belongs to another Rust session", { ssh: true, leafRustId: 99 }],
    ["a local captured target has since become SSH", { leafRustId: 42 }],
    ["active tab changed", { currentTabId: 8 }],
    ["active leaf changed", { currentLeafId: 99 }],
    ["terminal is cold", { cold: true }],
    ["active leaf has no renderer slot", { slot: false }],
    ["user input line is dirty", { dirty: true }],
    ["leaf is running a command", { busy: true }],
    ["leaf has a draft", { draft: "unfinished" }],
    ["leaf has pending risk approval", { pendingRisk: { text: "rm -rf" } }],
    ["leaf is in alternate screen", { alternateScreen: true }],
  ] as const)("refuses to navigate when %s", (_label, options) => {
    const { terminal, toasts, sendCd } = fixture(options);

    sendCd("/tmp");

    expect(terminal.write).not.toHaveBeenCalled();
    expect(terminal.focus).not.toHaveBeenCalled();
    expect(
      toasts()
        .flat()
        .some((arg) => typeof arg === "string" && /[\u4e00-\u9fff]/.test(arg)),
    ).toBe(true);
  });

  it("does not write in the background when a file page has no active terminal leaf", () => {
    const { terminal, sendCd } = fixture({
      tabKind: "file",
      activeLeafId: null,
    });

    sendCd("/tmp");

    expect(terminal.write).not.toHaveBeenCalled();
    expect(terminal.focus).not.toHaveBeenCalled();
  });
});

describe("App directorySource ownership", () => {
  it("uses the active SSH leaf's connected Rust session at the remote root", () => {
    expect(
      directorySource({
        tab: terminalTab("ssh-default", "ssh-current"),
        sshSpace: true,
        spaceSessionId: "ssh-space",
        sessions: [connected("ssh-current", 42), connected("ssh-space", 81)],
      }),
    ).toEqual({ kind: "sftp", sessionId: 42, root: "/" });
  });

  it.each([
    [
      "closed session",
      closed("ssh-current", 42),
    ],
    ["missing Rust session", connected("ssh-current", null)],
  ])("fails closed for an SSH source with a %s", (_label, session) => {
    expect(
      directorySource({
        tab: terminalTab("ssh-current"),
        sshSpace: true,
        spaceSessionId: "ssh-current",
        sessions: [session],
      }),
    ).toBeNull();
  });

  it("keeps an explicit local leaf local inside an SSH workspace", () => {
    expect(
      directorySource({
        tab: terminalTab("ssh-default", null),
        sshSpace: true,
        spaceSessionId: "ssh-default",
        sessions: [connected("ssh-default", 42)],
      }),
    ).toEqual({ kind: "local" });
  });

  it("does not turn a cold terminal with an unknown SSH id into a local tree", () => {
    expect(
      directorySource({
        tab: terminalTab("ssh-missing", undefined, true),
        sshSpace: true,
        spaceSessionId: "ssh-space",
        sessions: [connected("ssh-space", 81)],
      }),
    ).toBeNull();
  });

  it("uses a remote editor's own SSH session rather than the workspace session", () => {
    expect(
      directorySource({
      tab: {
        spaceId: "space-fixture",
        id: 52,
        kind: "editor",
        title: "remote file",
        path: "/remote/file",
        dirty: false,
        preview: false,
        remote: { sessionId: "editor-session" },
      },
        sshSpace: true,
        spaceSessionId: "ssh-space",
        sessions: [connected("editor-session", 73), connected("ssh-space", 81)],
      }),
    ).toEqual({ kind: "sftp", sessionId: 73, root: "/" });
  });

  it("does not borrow the SSH workspace session for a local editor", () => {
    expect(
      directorySource({
        tab: {
          spaceId: "space-fixture",
          id: 53,
          kind: "editor",
          title: "local file",
          path: "/local/file",
          dirty: false,
          preview: false,
        },
        sshSpace: true,
        spaceSessionId: "ssh-space",
        sessions: [connected("ssh-space", 81)],
      }),
    ).toEqual({ kind: "local" });
  });
});
