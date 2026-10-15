// @vitest-environment node
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { RISK_RULES } from "./rules";

const rootPatterns = RISK_RULES.find((rule) => rule.name === "rm_root_wildcard")!
  .patterns.slice(0, 2);

async function matchesInWorker(pattern: RegExp, input: string): Promise<boolean> {
  const worker = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
     parentPort.postMessage(new RegExp(workerData.source, workerData.flags).test(workerData.input));`,
    { eval: true, workerData: { source: pattern.source, flags: pattern.flags, input } },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      worker.once("online", resolve);
      worker.once("error", reject);
    });
    return await new Promise<boolean>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Regex worker timed out after 1500ms")), 1500);
      worker.once("message", resolve);
      worker.once("error", reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
    await worker.terminate();
  }
}

describe("risk-engine root wildcard regexes", () => {
  it.each(rootPatterns.flatMap((pattern, index) => [
    [index, pattern, "rm -" + "RR -".repeat(40) + "x"],
    [index, pattern, "rm -" + "r".repeat(20000) + " x"],
  ] as const))(
    "pattern %i returns false for adversarial near-matches within the worker deadline",
    async (_index, pattern, input) => {
      await expect(matchesInWorker(pattern, input)).resolves.toBe(false);
    },
  );

  it.each([
    [0, "rm -rf /", true],
    [0, "rm -r -f /", true],
    [0, "sudo rm -R -F /*", true],
    [0, "rm -rv -fv /", true],
    [0, "rm -f /", true],
    [0, "rm -rf /tmp", false],
    [0, "rm --recursive --force /", false],
    [0, "rm -r /", false],
    [1, "rm -rf /*", true],
    [1, "rm -R -F /*", true],
    [1, "rm -rf /tmp", false],
    [1, "rm -rf /", false],
  ])("pattern %i preserves matching behavior for %s", async (index, input, expected) => {
    await expect(matchesInWorker(rootPatterns[index], input)).resolves.toBe(expected);
  });
});
