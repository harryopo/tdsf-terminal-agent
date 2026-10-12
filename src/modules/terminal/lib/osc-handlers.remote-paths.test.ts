import { Terminal } from "@xterm/xterm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { registerCwdHandler } from "./osc-handlers";

vi.mock("@/lib/platform", () => ({ IS_WINDOWS: true }));

function feed(term: Terminal, sequence: string): Promise<void> {
  return new Promise((resolve) => term.write(sequence, resolve));
}

async function parseCwd(path: string, pathStyle?: "native" | "posix") {
  const term = new Terminal({ cols: 80, rows: 24 });
  const onCwd = vi.fn();
  const dispose = registerCwdHandler(term, onCwd, undefined, pathStyle);
  try {
    await feed(term, `\x1b]7;file://localhost${path}\x07`);
    return onCwd.mock.calls.map(([cwd]) => cwd);
  } finally {
    dispose();
    term.dispose();
  }
}

describe("OSC 7 path style on a real xterm parser", () => {
  it.each([
    ["/c", "/c"],
    ["/c/projects", "/c/projects"],
    ["/C:/data", "/C:/data"],
    ["/c:/data", "/c:/data"],
    ["/home/%E4%B8%AD%E6%96%87", "/home/中文"],
    ["/home/a%25b", "/home/a%b"],
    ["/home/me", "/home/me"],
  ])("preserves POSIX path %s", async (encoded, expected) => {
    await expect(parseCwd(encoded, "posix")).resolves.toEqual([expected]);
  });

  it.each([
    ["/c/projects", "C:/projects"],
    ["/C:/data", "C:/data"],
    ["/home/me", "/home/me"],
  ])("keeps default native Windows mapping for %s", async (path, expected) => {
    await expect(parseCwd(path)).resolves.toEqual([expected]);
  });
});

function callsWithin(node: ts.Node): ts.CallExpression[] {
  const calls: ts.CallExpression[] = [];
  const visit = (current: ts.Node) => {
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === "registerCwdHandler"
    ) {
      calls.push(current);
    }
    ts.forEachChild(current, visit);
  };
  visit(node);
  return calls;
}

describe("terminal session cwd path-style wiring", () => {
  it("passes POSIX mode only in the remote branch and preserves local shell state", () => {
    const path = join(
      process.cwd(),
      "src/modules/terminal/lib/useTerminalSession.ts",
    );
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
    const [branch] = remoteBranches;
    const localCalls = callsWithin(branch.thenStatement);
    const remoteCalls = branch.elseStatement
      ? callsWithin(branch.elseStatement)
      : [];

    expect(localCalls).toHaveLength(1);
    expect(localCalls[0].arguments).toHaveLength(3);
    expect(localCalls[0].arguments[2].getText(source)).toBe("shellState");

    expect(remoteCalls).toHaveLength(1);
    expect(remoteCalls[0].arguments).toHaveLength(4);
    expect(remoteCalls[0].arguments[2].kind).toBe(ts.SyntaxKind.Identifier);
    expect(remoteCalls[0].arguments[2].getText(source)).toBe("shellState");
    expect(remoteCalls[0].arguments[3].kind).toBe(
      ts.SyntaxKind.StringLiteral,
    );
    expect(remoteCalls[0].arguments[3].getText(source)).toBe('"posix"');
  });
});
