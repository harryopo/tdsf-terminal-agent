import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { planSeed, seed } from "../../scripts/dev-seed-store.mjs";

// The dev build now owns a separate app data dir. This script is the only
// thing allowed to move data between the two profiles, and it must stay
// one-way (release -> dev), non-destructive and idempotent: a bug here could
// wipe or corrupt the user's real workspace registry.
let releaseDir: string;
let devDir: string;

function writeJson(dir: string, name: string, value: unknown) {
  writeFileSync(join(dir, name), JSON.stringify(value), "utf8");
}
function readJson(dir: string, name: string) {
  return readFileSync(join(dir, name), "utf8");
}

beforeEach(() => {
  releaseDir = mkdtempSync(join(tmpdir(), "tdsf-rel-"));
  devDir = mkdtempSync(join(tmpdir(), "tdsf-dev-"));
});
afterEach(() => {
  rmSync(releaseDir, { recursive: true, force: true });
  rmSync(devDir, { recursive: true, force: true });
});

describe("dev data seeding", () => {
  it("copies release stores into the empty dev profile on first run", () => {
    writeJson(releaseDir, "tdsf-spaces.json", { spaces: [1] });
    writeJson(releaseDir, "tdsf-settings.json", { theme: "dark" });
    writeFileSync(join(releaseDir, "tdsf-spaces.json.bak-20260918"), "stale", "utf8");

    const copied = seed(releaseDir, devDir, vi.fn());

    expect(copied).toEqual(["tdsf-settings.json", "tdsf-spaces.json"]);
    expect(JSON.parse(readJson(devDir, "tdsf-spaces.json"))).toEqual({ spaces: [1] });
    expect(existsSync(join(devDir, "tdsf-spaces.json.bak-20260918"))).toBe(false);
  });

  it("never overwrites a file that already exists in the dev profile", () => {
    writeJson(releaseDir, "tdsf-spaces.json", { spaces: ["from-release"] });
    writeJson(devDir, "tdsf-spaces.json", { spaces: ["from-dev"] });

    expect(planSeed(releaseDir, devDir)).toEqual([]);
    seed(releaseDir, devDir, vi.fn());

    expect(JSON.parse(readJson(devDir, "tdsf-spaces.json"))).toEqual({ spaces: ["from-dev"] });
  });

  it("is a no-op on the second run and never writes back to the release profile", () => {
    writeJson(releaseDir, "tdsf-spaces.json", { spaces: [1] });
    const before = readJson(releaseDir, "tdsf-spaces.json");

    seed(releaseDir, devDir, vi.fn());
    const second = seed(releaseDir, devDir, vi.fn());

    expect(second).toEqual([]);
    expect(readJson(releaseDir, "tdsf-spaces.json")).toBe(before);
  });

  it("does nothing when no release profile is installed", () => {
    const logs: string[] = [];
    expect(seed(join(releaseDir, "missing"), devDir, (m) => logs.push(m))).toEqual([]);
    expect(logs.join("\n")).toContain("跳过");
  });
});
