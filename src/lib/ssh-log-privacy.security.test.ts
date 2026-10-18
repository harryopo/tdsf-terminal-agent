// @vitest-environment node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const sshSources = [
  readFileSync(resolve(process.cwd(), "src-tauri/src/modules/ssh/mod.rs"), "utf8"),
  readFileSync(resolve(process.cwd(), "src-tauri/src/modules/ssh/session.rs"), "utf8"),
];

function logMacro(marker: string): string | null {
  for (const source of sshSources) {
    const markerAt = source.indexOf(marker);
    if (markerAt < 0) continue;
    const start = source.lastIndexOf("log::", markerAt);
    const end = source.indexOf(");", markerAt);
    if (start >= 0 && end >= 0) return source.slice(start, end + 2);
  }
  return null;
}

function expectCommandLengthOnly(marker: string): void {
  const source = logMacro(marker);
  expect(source).not.toBeNull();
  if (source === null) throw new Error(`missing diagnostic macro: ${marker}`);
  expect(source).toMatch(/cmd_chars=\{\}/);
  expect(source).toContain("command.chars().count()");
  const argumentsOnly = source.replace(/"(?:\\.|[^"\\])*"/, "");
  expect(argumentsOnly.replaceAll("command.chars().count()", "")).not.toMatch(/\bcommand\b/);
}

// Static source guards only; these assertions do not prove runtime logger behavior.
it.each([
  "[ssh] exec command:",
  "[ssh] exec command failed:",
  "[ssh] exec_command start:",
  "[ssh] exec_command timeout after",
  "[ssh] exec_command done:",
  "[ssh] exec exit_status=",
  "[ssh] exec request Failure (REJECTED by server)",
])("keeps %s without logging the command body", (marker) => {
  expectCommandLengthOnly(marker);
});
