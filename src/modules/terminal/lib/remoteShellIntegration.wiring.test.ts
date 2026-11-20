import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

describe("remote shell source is consumed by the real terminal session", () => {
  it("shares one source gate between block, prompt and cwd consumers", () => {
    const path = resolve("src/modules/terminal/lib/useTerminalSession.ts");
    const text = readFileSync(path, "utf8");
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const calls: ts.CallExpression[] = [];
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node)) calls.push(node);
      ts.forEachChild(node, visit);
    }
    visit(source);
    const args = (name: string, arity: number) => calls.filter(
      (call) => call.expression.getText(source) === name && call.arguments.length === arity,
    ).map((call) => call.arguments[arity - 1].getText(source));
    expect(args("registerBlockOscHandlers", 3)).toEqual(["acceptFrame"]);
    expect(args("registerPromptTracker", 4)).toEqual(["acceptFrame"]);
    expect(args("registerCwdHandler", 5)).toEqual(["acceptFrame"]);
    expect(text).toContain("s.remoteIntegration?.setConnection(context)");
    expect(text).toContain("collector.switchContext()");
  });
});
