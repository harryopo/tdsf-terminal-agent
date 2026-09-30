import { describe, expect, it } from "vitest";
import { SuggestEngine } from "./suggest-engine";

describe("SuggestEngine prediction regressions", () => {
  it("accumulates incremental environment commands, deduplicates, and keeps environments separate", () => {
    const engine = new SuggestEngine();

    for (const env of ["linux", "windows"] as const) {
      engine.setEnvironmentCommands(["alpha"], env);
      engine.setEnvironmentCommands(["alpha", "beta"], env);
      engine.setEnvironmentCommands(["alpha", "beta", "beta"], env);

      expect(engine.getSuggestions("alpha", 5, env).map((item) => item.command)).toContain("alpha");
      expect(engine.getSuggestions("beta", 5, env).map((item) => item.command)).toContain("beta");
      expect(engine.getSuggestions("beta", 5, env).filter((item) => item.command === "beta")).toHaveLength(1);
    }

    expect(engine.isKnownCommand("alpha", "linux")).toBe(true);
    expect(engine.isKnownCommand("beta", "windows")).toBe(true);

    const isolated = new SuggestEngine();
    isolated.setEnvironmentCommands(["alpha"], "linux");
    expect(isolated.isKnownCommand("alpha", "windows")).toBe(false);
  });

  it("reuses a known first command's short Chinese label", () => {
    const engine = new SuggestEngine();
    engine.loadHistory(["git status", "mystery-deploy-command"], "linux");

    const gitLabel = engine.getSuggestions("git", 10, "linux")
      .find((item) => item.command === "git")?.zh;
    const knownHistory = engine.getSuggestions("git", 10, "linux")
      .find((item) => item.command === "git status" && item.source === "history");
    expect(gitLabel).toBeTruthy();
    expect(knownHistory?.zh).toBe(gitLabel);

  });

  it("gives unknown history only a generic label", () => {
    const engine = new SuggestEngine();
    engine.loadHistory(["mystery-deploy-command"], "linux");
    const unknownHistory = engine.getSuggestions("mystery", 10, "linux")
      .find((item) => item.command === "mystery-deploy-command" && item.source === "history");
    expect(unknownHistory?.zh).toMatch(/^(历史命令|当前环境命令)$/);
  });
});
