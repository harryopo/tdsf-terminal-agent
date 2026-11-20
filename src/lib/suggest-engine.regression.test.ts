import { describe, expect, it } from "vitest";
import { SuggestEngine } from "./suggest-engine";

describe("SuggestEngine prediction regressions", () => {
  it("applies the current host's command filter before limiting and keeps history labels", () => {
    const engine = new SuggestEngine();
    engine.setEnvironmentCommands(["gzz-other-host", "gzz-current-host"], "linux");
    engine.loadHistory(["git status"], "linux");
    const allowed = new Set(["git", "grep", "gzz-current-host"]);
    const results = engine.getSuggestions("g", 5, "linux", (command) => allowed.has(command));

    expect(results.map((item) => item.command)).toEqual(["git", "grep", "gzz-current-host", "git status"]);
    expect(results.find((item) => item.source === "history")?.zh).toBeTruthy();
    expect(engine.getSuggestions("g", 5, "linux", () => false).map((item) => item.command)).toEqual(["git status"]);
  });

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
