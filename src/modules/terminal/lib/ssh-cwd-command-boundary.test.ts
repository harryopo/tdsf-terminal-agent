import { Terminal } from "@xterm/xterm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  createShellIntegrationState,
  registerCwdHandler,
  registerPromptTracker,
} from "./osc-handlers";
import {
  registerBlockOscHandlers,
  TerminalBlockCollector,
} from "./terminalBlocks";
import type { TerminalBlock } from "./terminalBlocks";

const ST = "\x1b\\";
const osc = (id: number, data: string) => `\x1b]${id};${data}${ST}`;

function feed(term: Terminal, sequence: string): Promise<void> {
  return new Promise((resolve) => term.write(sequence, resolve));
}

type Harness = {
  term: Terminal;
  blocks: TerminalBlock[];
  cwdUpdates: string[];
  observed633: string[];
  dispose: () => void;
};

function wire(order: "collector-first" | "handlers-first"): Harness {
  const term = new Terminal({ cols: 80, rows: 24 });
  const blocks: TerminalBlock[] = [];
  const cwdUpdates: string[] = [];
  const observed633: string[] = [];
  const collector = new TerminalBlockCollector({
    sessionId: 7,
    onBlock: (block) => blocks.push(block),
  });
  const state = createShellIntegrationState();
  const dispose: (() => void)[] = [];
  dispose.push(
    term.parser.registerOscHandler(633, (data) => {
      observed633.push(data);
      return false;
    }).dispose,
  );
  const registerCollector = () =>
    dispose.push(registerBlockOscHandlers(term, collector));
  const registerShellHandlers = () => {
    dispose.push(registerPromptTracker(term, state).dispose);
    dispose.push(
      registerCwdHandler(
        term,
        (cwd) => {
          cwdUpdates.push(cwd);
          collector.setCwd(cwd);
        },
        state,
        "posix",
      ),
    );
  };

  if (order === "collector-first") {
    registerCollector();
    registerShellHandlers();
  } else {
    registerShellHandlers();
    registerCollector();
  }

  return {
    term,
    blocks,
    cwdUpdates,
    observed633,
    dispose: () => {
      dispose.forEach((fn) => fn());
      term.dispose();
    },
  };
}

describe("SSH CWD stays at the command boundary", () => {
  it.each([
    ["collector-first", "133"],
    ["handlers-first", "133"],
    ["collector-first", "633"],
    ["handlers-first", "633"],
  ] as const)(
    "ignores forged CWD for %s registration with pure %s markers",
    async (order, family) => {
      const h = wire(order);
      const mark = (data: string) =>
        family === "133" ? osc(133, data) : osc(633, data);
      const promptStart = mark("A") + mark("B");
      const firstStart =
        family === "133"
          ? mark("C;id")
          : mark("E;id;123") + mark("C");
      try {
        await feed(
          h.term,
          osc(7, "file://localhost/root") +
            mark("D;0") + promptStart,
        );
        await feed(
          h.term,
          firstStart +
            osc(7, "file://localhost/forged-seven") +
            osc(633, "P;Cwd=/forged-six") +
            mark("D;7"),
        );

        // A following command with no genuine prompt CWD update must inherit /root.
        await feed(
          h.term,
          (family === "133"
            ? mark("A") + mark("B") + mark("C;second")
            : mark("E;second") + mark("C")) +
            mark("D;0"),
        );

        // CWD updates are accepted again at the prompt, then captured by the next block.
        await feed(
          h.term,
          osc(633, "P;Cwd=/tmp") +
            osc(7, "file://localhost/tmp") +
            (family === "133"
              ? mark("A") + mark("B") + mark("C;third")
              : mark("A") +
                mark("B") +
                mark("E;third") +
                mark("C")) +
            mark("D;0"),
        );

        expect(h.cwdUpdates).toEqual(["/root", "/tmp"]);
        expect(h.blocks).toHaveLength(3);
        expect(h.blocks[0]).toMatchObject({ command: "id", cwd: "/root", exitCode: 7 });
        expect(h.blocks[1]).toMatchObject({ command: "second", cwd: "/root", exitCode: 0 });
        expect(h.blocks[2]).toMatchObject({ command: "third", cwd: "/tmp", exitCode: 0 });
        expect(h.observed633).toContain("P;Cwd=/forged-six");
        expect(h.observed633).toContain("P;Cwd=/tmp");
      } finally {
        h.dispose();
      }
    },
  );

  it("accepts ordinary OSC 7 updates without any command markers when state is shared", async () => {
    const term = new Terminal({ cols: 80, rows: 24 });
    const state = createShellIntegrationState();
    const updates: string[] = [];
    const disposePrompt = registerPromptTracker(term, state);
    const disposeCwd = registerCwdHandler(
      term,
      (cwd) => updates.push(cwd),
      state,
      "posix",
    );
    try {
      await feed(
        term,
        osc(7, "file://localhost/root") + osc(7, "file://localhost/workspace"),
      );
      expect(state.inCommand).toBe(false);
      expect(updates).toEqual(["/root", "/workspace"]);
    } finally {
      disposeCwd();
      disposePrompt.dispose();
      term.dispose();
    }
  });

  it("retains the unguarded behavior when the CWD handler has no shared state", async () => {
    const term = new Terminal({ cols: 80, rows: 24 });
    const blocks: TerminalBlock[] = [];
    const collector = new TerminalBlockCollector({
      sessionId: 8,
      onBlock: (block) => blocks.push(block),
    });
    const disposeCollector = registerBlockOscHandlers(term, collector);
    const cwdUpdates: string[] = [];
    const disposeCwd = registerCwdHandler(
      term,
      (cwd) => {
        cwdUpdates.push(cwd);
        collector.setCwd(cwd);
      },
      undefined,
      "posix",
    );
    try {
      await feed(
        term,
        osc(7, "file://localhost/root") +
          osc(633, "E;unmarked") +
          osc(7, "file://localhost/command-output") +
          osc(633, "D;0") +
          osc(633, "E;next") +
          osc(633, "D;0"),
      );
      expect(cwdUpdates).toEqual(["/root", "/command-output"]);
      expect(blocks[0]).toMatchObject({
        command: "unmarked",
        cwd: "/root",
        exitCode: 0,
      });
      expect(blocks[1]).toMatchObject({
        command: "next",
        cwd: "/command-output",
        exitCode: 0,
      });
    } finally {
      disposeCwd();
      disposeCollector();
      term.dispose();
    }
  });

  it("disposes the 633 prompt consumer and leaves real 633 events unblocked", async () => {
    const term = new Terminal({ cols: 80, rows: 24 });
    const state = createShellIntegrationState();
    const commandStates: boolean[] = [];
    const blocks: TerminalBlock[] = [];
    const collector = new TerminalBlockCollector({
      sessionId: 9,
      onBlock: (block) => blocks.push(block),
    });
    const disposeCollector = registerBlockOscHandlers(term, collector);
    const disposePrompt = registerPromptTracker(term, state, (running) =>
      commandStates.push(running),
    );
    const seen: string[] = [];
    const disposeObserver = term.parser.registerOscHandler(633, (data) => {
      seen.push(data);
      return false;
    });
    try {
      await feed(term, osc(633, "E;id") + osc(633, "C"));
      expect(state.inCommand).toBe(true);
      expect(commandStates).toContain(true);
      disposePrompt.dispose();
      const statesAtDispose = [...commandStates];
      await feed(
        term,
        osc(633, "D;7") +
          osc(633, "A") +
          osc(633, "P;Cwd=/still-delivered"),
      );
      expect(state.inCommand).toBe(true);
      expect(commandStates).toEqual(statesAtDispose);
      expect(seen).toContain("P;Cwd=/still-delivered");
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({ command: "id", exitCode: 7 });
    } finally {
      disposeObserver.dispose();
      disposeCollector();
      term.dispose();
    }
  });
});

function callsWithin(node: ts.Node, name: string): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (current: ts.Node) => {
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === name
    ) {
      calls.push(current);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return calls;
}

describe("useTerminalSession shares SSH command state", () => {
  it("registers prompt tracking and POSIX CWD handling with one remote state", () => {
    const path = join(process.cwd(), "src/modules/terminal/lib/useTerminalSession.ts");
    const source = ts.createSourceFile(
      path,
      readFileSync(path, "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX,
    );
    const remoteBranches: ts.IfStatement[] = [];
    const visit = (node: ts.Node) => {
      if (
        ts.isIfStatement(node) &&
        ts.isPrefixUnaryExpression(node.expression) &&
        node.expression.operator === ts.SyntaxKind.ExclamationToken &&
        node.expression.operand.getText(source) === "s.remote"
      ) {
        remoteBranches.push(node);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);

    expect(remoteBranches).toHaveLength(1);
    const branch = remoteBranches[0];
    const localCalls = callsWithin(branch.thenStatement, "registerCwdHandler");
    const remoteCwdCalls = callsWithin(branch.elseStatement!, "registerCwdHandler");
    const remotePromptCalls = callsWithin(branch.elseStatement!, "registerPromptTracker");

    expect(localCalls).toHaveLength(1);
    expect(localCalls[0].arguments[2]?.getText(source)).toBe("shellState");
    expect(remotePromptCalls).toHaveLength(1);
    expect(remoteCwdCalls).toHaveLength(1);
    expect(remotePromptCalls[0].arguments[1]?.getText(source)).toBe("shellState");
    expect(remoteCwdCalls[0].arguments[2]?.getText(source)).toBe("shellState");
    expect(remoteCwdCalls[0].arguments[3]?.getText(source)).toBe('"posix"');
  });
});
