import { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { RemoteShellIntegration } from "./remoteShellIntegration";
import {
  createShellIntegrationState,
  registerCwdHandler,
  registerPromptTracker,
} from "./osc-handlers";
import {
  registerBlockOscHandlers,
  TerminalBlockCollector,
  type TerminalBlock,
} from "./terminalBlocks";

const ST = `${String.fromCharCode(27)}\\`;
const connA = "0123456789abcdef0123456789abcdef";
const connB = "fedcba9876543210fedcba9876543210";
const osc = (code: number, data: string) => `${String.fromCharCode(27)}]${code};${data}${ST}`;
const feed = (term: Terminal, data: string) =>
  new Promise<void>((resolve) => term.write(data, resolve));

function harness(order: "collector-first" | "tracker-first" = "collector-first") {
  const term = new Terminal({ cols: 80, rows: 24 });
  const blocks: TerminalBlock[] = [];
  const cwdChanges: string[] = [];
  const capture = vi.fn(() => "captured");
  const collector = new TerminalBlockCollector({
    sessionId: 7,
    onOutputCapture: capture,
    onBlock: (block) => blocks.push(block),
  });
  const state = createShellIntegrationState();
  const observeCwd = (cwd: string) => {
    cwdChanges.push(cwd);
    collector.setCwd(cwd);
  };
  const integration = new RemoteShellIntegration({
    onCwd: observeCwd,
    onContextChange: () => collector.switchContext(),
  });
  integration.setConnection({ connectionId: connA, bashHooksPath: "/hooks" });
  const accept = integration.acceptFrame.bind(integration);
  const disposers =
    order === "collector-first"
      ? [
          registerBlockOscHandlers(term, collector, accept),
          registerPromptTracker(term, state, undefined, accept).dispose,
          registerCwdHandler(term, observeCwd, state, "posix", accept),
        ]
      : [
          registerCwdHandler(term, observeCwd, state, "posix", accept),
          registerPromptTracker(term, state, undefined, accept).dispose,
          registerBlockOscHandlers(term, collector, accept),
        ];
  const context = (
    id = connA,
    cwd = "/srv/alpha",
    shell = "1234-11-22",
  ) => osc(633, `P;TdsfContext=${id};${shell};alice;${encodeURIComponent(cwd)}`);
  return {
    term,
    blocks,
    cwdChanges,
    capture,
    collector,
    integration,
    context,
    dispose: () => {
      disposers.forEach((dispose) => dispose());
      term.dispose();
    },
  };
}

describe("RemoteShellIntegration over the real xterm OSC handler chain", () => {
  it.each(["collector-first", "tracker-first"] as const)(
    "accepts only the matching shell context in %s registration order",
    async (order) => {
      const h = harness(order);
      h.integration.setConnection({ connectionId: connA, bashHooksPath: "/hooks" });
      await feed(
        h.term,
        h.context() +
          osc(133, "A") +
          osc(133, "C;pwd") +
          h.context() +
          osc(133, "D;7") +
          osc(133, "A"),
      );
      expect(h.cwdChanges).toEqual(["/srv/alpha"]);
      expect(h.blocks).toHaveLength(1);
      expect(h.blocks[0]).toMatchObject({ command: "pwd", cwd: "/srv/alpha", exitCode: 7 });
      h.dispose();
    },
  );

  it("does not apply another connection's context or command markers", async () => {
    const h = harness();
    await feed(
      h.term,
      h.context(connB, "/wrong") + osc(133, "C;uname") + osc(133, "D;0"),
    );
    expect(h.cwdChanges).toEqual([]);
    expect(h.blocks).toEqual([]);
    h.dispose();
  });

  it("applies cached context and prompt facts when connection metadata arrives late", async () => {
    const h = harness();
    h.integration.setConnection(null);
    await feed(h.term, h.context(connA, "/late/path") + osc(133, "A"));
    expect(h.blocks).toEqual([]);
    h.integration.setConnection({ connectionId: connA, bashHooksPath: "/hooks" });
    expect(h.cwdChanges).toEqual(["/late/path"]);
    expect(h.blocks).toEqual([]);
    h.dispose();
  });

  it("preserves a running block's starting cwd and applies same-shell cwd after D", async () => {
    const h = harness();
    await feed(
      h.term,
      h.context(connA, "/start") +
        osc(133, "C;pwd") +
        h.context(connA, "/during") +
        osc(133, "D;0"),
    );
    expect(h.blocks[0]).toMatchObject({ cwd: "/start", exitCode: 0 });
    expect(h.cwdChanges).toEqual(["/start", "/during"]);
    h.dispose();
  });

  it("decodes Unicode, percent, backslash, and an encoded trailing LF", async () => {
    const h = harness();
    const cwd = "/资料/百分%/C:\\work\n";
    await feed(h.term, h.context(connA, cwd));
    expect(h.cwdChanges).toEqual([cwd]);
    h.dispose();
  });

  it("ignores scoped OSC 7 and 633 Cwd values in favor of encoded context cwd", async () => {
    const h = harness();
    await feed(
      h.term,
      h.context(connA, "/encoded/path") +
        osc(7, "file://host/other/path") +
        osc(633, "P;Cwd=/also/wrong") +
        osc(133, "C;pwd") +
        h.context(connA, "/encoded/path") +
        osc(133, "D;0"),
    );
    expect(h.cwdChanges).toEqual(["/encoded/path"]);
    expect(h.blocks[0]?.cwd).toBe("/encoded/path");
    h.dispose();
  });

  it("switches parent and child shells on one connection without cross-settling blocks", async () => {
    const h = harness();
    await feed(h.term, h.context(connA, "/parent") + osc(133, "C;parent-command"));
    await feed(
      h.term,
      h.context(connA, "/child", "5678-33-44") +
        osc(133, "C;child-command") +
        h.context(connA, "/child", "5678-33-44") +
        osc(133, "D;0") +
        h.context(connA, "/parent", "1234-11-22") +
        osc(133, "D;0"),
    );
    expect(h.blocks.map(({ command, exitCode, cwd }) => ({ command, exitCode, cwd }))).toEqual([
      { command: "parent-command", exitCode: null, cwd: "/parent" },
      { command: "child-command", exitCode: 0, cwd: "/child" },
    ]);
    expect(h.capture).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  it("does not duplicate a block when Context frames repeat", async () => {
    const h = harness();
    await feed(
      h.term,
      h.context() +
        h.context() +
        osc(133, "C;id") +
        h.context() +
        osc(133, "D;0") +
        osc(133, "D;0"),
    );
    expect(h.blocks).toHaveLength(1);
    expect(h.capture).toHaveBeenCalledTimes(1);
    h.dispose();
  });

  it.each(["collector-first", "tracker-first"] as const)(
    "does not report child exit as successful when returning to the parent in %s order",
    async (order) => {
      const h = harness(order);
      await feed(h.term, h.context(connA, "/root") + osc(633, "E;su - lisi") +
        h.context(connA, "/home/lisi", "5678-33-44") + osc(133, "D;0") +
        osc(633, "E;exit") + h.context(connA, "/root") + osc(133, "D;0"));
      expect(h.blocks.map((block) => [block.command, block.exitCode, block.outputTail])).toEqual([
        ["su - lisi", null, ""], ["exit", null, ""],
      ]);
      expect(h.capture).not.toHaveBeenCalled();
      expect(h.cwdChanges).toEqual(["/root", "/home/lisi", "/root"]);
      h.dispose();
    },
  );

  it("keeps cwd when a different shell starts in the same directory", async () => {
    const h = harness();
    await feed(h.term, h.context(connA, "/shared") + osc(133, "C;parent"));
    await feed(h.term, h.context(connA, "/shared", "5678-33-44") +
      osc(633, "E;child") + h.context(connA, "/shared", "5678-33-44") + osc(633, "D;7"));
    expect(h.blocks.map((block) => [block.command, block.cwd, block.exitCode])).toEqual([
      ["parent", "/shared", null], ["child", "/shared", 7],
    ]);
    h.dispose();
  });

  it("does not settle a scoped command from an unaccompanied prompt marker", async () => {
    const h = harness();
    await feed(h.term, h.context(connA, "/root") + osc(133, "C;ssh nested"));
    await feed(h.term, osc(633, "D;0") + osc(133, "A") +
      osc(7, "file://localhost/another-server"));
    expect(h.blocks).toEqual([]);
    expect(h.cwdChanges).toEqual(["/root"]);
    await feed(h.term, h.context(connA, "/root") + osc(133, "D;7"));
    expect(h.blocks[0]).toMatchObject({ command: "ssh nested", exitCode: 7, cwd: "/root" });
    h.dispose();
  });

  it("resets immediately on disconnect and rejects receipts from the old connection", async () => {
    const h = harness();
    await feed(h.term, h.context() + osc(133, "C;unfinished"));
    h.integration.setConnection(null);
    await feed(h.term, h.context(connA, "/stale") + osc(133, "D;0"));
    expect(h.blocks).toHaveLength(1);
    expect(h.blocks[0]).toMatchObject({ command: "unfinished", exitCode: null });
    expect(h.capture).not.toHaveBeenCalled();
    expect(h.cwdChanges).toEqual(["/srv/alpha"]);
    h.dispose();
  });

  it("retains legacy markers and cwd when the connection explicitly has no hooks", async () => {
    const h = harness();
    h.integration.setConnection({ connectionId: connA, bashHooksPath: null });
    await feed(
      h.term,
      osc(7, "file://host/legacy/path") +
        osc(133, "C;legacy") +
        osc(133, "D;0"),
    );
    expect(h.cwdChanges).toEqual(["/legacy/path"]);
    expect(h.blocks).toHaveLength(1);
    expect(h.blocks[0]).toMatchObject({ command: "legacy", cwd: "/legacy/path", exitCode: 0 });
    h.dispose();
  });

  it("leaves malformed or unknown frames untrusted instead of falling back to legacy cwd", async () => {
    const h = harness();
    await feed(
      h.term,
      osc(633, "P;TdsfContext=bad;1234-a1-b2;alice;%2Fwrong") +
        osc(7, "file://host/fallback") +
        osc(133, "C;untrusted") +
        osc(133, "D;0"),
    );
    expect(h.cwdChanges).toEqual([]);
    expect(h.blocks).toEqual([]);
    h.dispose();
  });
});
