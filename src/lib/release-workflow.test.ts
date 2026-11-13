import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  join(process.cwd(), ".github", "workflows", "release-windows.yml"),
  "utf-8",
).split(/\r?\n/);

function getRunBlock(stepName: string): string[] {
  const stepIndex = workflow.findIndex(
    (line) => line.trim() === `- name: ${stepName}`,
  );
  expect(
    stepIndex,
    `release step not found: ${stepName}`,
  ).toBeGreaterThanOrEqual(0);
  if (stepIndex < 0) return [];

  const nextStepIndex = workflow.findIndex(
    (line, index) => index > stepIndex && /^\s*- name:/.test(line),
  );
  const endIndex = nextStepIndex < 0 ? workflow.length : nextStepIndex;
  const runIndex = workflow.findIndex(
    (line, index) =>
      index > stepIndex && index < endIndex && line.trim() === "run: |",
  );
  expect(
    runIndex,
    `run block not found for release step: ${stepName}`,
  ).toBeGreaterThanOrEqual(0);
  return runIndex < 0
    ? []
    : workflow.slice(runIndex + 1, endIndex).map((line) => line.trim());
}

function expectEveryCommandGuarded(block: string[], commands: RegExp[]): void {
  for (const command of commands) {
    const indexes = block.flatMap((line, index) =>
      command.test(line) ? [index] : [],
    );
    expect(indexes.length, `expected actual command matching ${command}`).toBe(
      1,
    );
    for (const index of indexes) {
      expect(
        block[index + 1],
        `command ${block[index]} must be followed immediately by an exit-code guard`,
      ).toMatch(/^if \(\$LASTEXITCODE -ne 0\) \{ throw .+ \}$/);
    }
  }
}

describe("Windows release workflow command failure propagation", () => {
  it("guards every sidecar dependency install command", () => {
    expectEveryCommandGuarded(
      getRunBlock("Install sidecar build dependencies"),
      [
        /^python -m venv src-tauri\/sidecar\/\.venv$/,
        /^src-tauri\/sidecar\/\.venv\/Scripts\/python\.exe -m pip install --upgrade pip$/,
        /^src-tauri\/sidecar\/\.venv\/Scripts\/python\.exe -m pip install -r src-tauri\/sidecar\/requirements-build\.txt$/,
      ],
    );
  });

  it("guards the sidecar build and bundled executable smoke test", () => {
    expectEveryCommandGuarded(
      getRunBlock("Build and smoke-test bundled sidecar"),
      [/^pnpm build:sidecar:win$/, /^pnpm test:sidecar:exe$/],
    );
  });
});
