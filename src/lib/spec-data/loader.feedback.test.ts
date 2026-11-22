import { describe, expect, it } from "vitest";
import { getCommandSpec, loadSpecs } from "./loader";

describe("spec data loader feedback", () => {
  it("loads real generated specs, finds git, and reuses one cached object", async () => {
    const specs = await loadSpecs();
    expect(Object.keys(specs).length).toBeGreaterThan(100);
    expect(specs.git).toBeDefined();

    const git = await getCommandSpec("git");
    expect(git).toBe(specs.git);
    expect(await loadSpecs()).toBe(specs);
  });
});
