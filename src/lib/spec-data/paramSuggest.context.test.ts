import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildParamRequest } from "../param-complete-client";
import { parseCommandLine, suggestOptionValues, suggestParams } from "./paramSuggest";
import type { FigSpec } from "./types";

const specs = JSON.parse(
  readFileSync("src/lib/spec-data/generated/specs.json", "utf8"),
) as Record<string, FigSpec>;

describe("command context parsing and real Fig data", () => {
  it("keeps the actual command after sudo options and env assignments", () => {
    expect(parseCommandLine("sudo -u root env X=1 ls -l")).toEqual({
      cmd: "ls",
      sub: undefined,
      current: "-l",
    });
    expect(buildParamRequest("sudo -u root env X=1 ls -l")).toEqual({
      cmd: "ls",
      tokens: ["ls", "-l"],
      current: "-l",
    });
  });

  it("uses the current shell segment and preserves quoted arguments", () => {
    expect(parseCommandLine("printf '%s' 'a b' | grep 'a b' && ls -l")).toEqual({
      cmd: "ls",
      sub: undefined,
      current: "-l",
    });
    expect(buildParamRequest("printf '%s' 'a b' | grep 'a b' && ls -l")).toEqual({
      cmd: "ls",
      tokens: ["ls", "-l"],
      current: "-l",
    });
  });

  it("resolves nested git remote add options from the packaged Fig spec", () => {
    const suggestions = suggestParams(specs.git, "git remote add --m");
    expect(suggestions.map((item) => item.command)).toContain("--mirror");
  });

  it("parses an attached option value in the packaged tar spec", () => {
    const values = suggestOptionValues(specs.tar, "tar --hole-detection=ra");
    expect(values?.map((item) => item.command)).toContain("raw");
  });

  it("supports array option names and real curl request values", () => {
    const values = suggestOptionValues(specs.curl, "curl -X ");
    expect(values?.map((item) => item.command)).toEqual([
      "GET", "HEAD", "POST", "PUT", "DELETE", "CONNECT", "OPTIONS", "TRACE",
    ]);
    expect(values?.find((item) => item.command === "POST")?.description?.trim()).toBeTruthy();
  });

  it("describes real tar static values with their parent option", () => {
    const values = suggestOptionValues(specs.tar, "tar --hole-detection ");
    const raw = values?.find((item) => item.command === "raw");
    expect(raw?.description?.trim()).toBeTruthy();
    expect(raw?.description).toContain("--hole-detection");
  });

  it("retains a description attached to an individual static suggestion", () => {
    const spec: FigSpec = {
      name: "demo",
      options: [{
        name: ["-f", "--format"],
        args: { suggestions: [{ name: "json", description: "机器可读格式" }] },
      }],
    };
    expect(suggestOptionValues(spec, "demo --format ")).toEqual([
      expect.objectContaining({ command: "json", description: "机器可读格式" }),
    ]);
  });

  it("uses the git status node after a preceding -c option value", () => {
    const line = "git -c user.name=Lin status -";
    expect(parseCommandLine(line)).toEqual({
      cmd: "git",
      sub: undefined,
      current: "-",
    });
    expect(suggestParams(specs.git, line).map((item) => item.command)).toContain("--short");
  });

  it("suggests the second nested positional argument after the first is supplied", () => {
    const spec: FigSpec = {
      name: "demo",
      subcommands: [{
        name: "remote",
        subcommands: [{
          name: "add",
          args: [
            { name: "remote", suggestions: ["origin", "upstream"] },
            { name: "url", suggestions: ["https://example.invalid/repo"] },
          ],
        }],
      }],
    };
    expect(suggestParams(spec, "demo remote add origin ").map((item) => item.command)).toEqual([
      "https://example.invalid/repo",
    ]);
  });

  it("preserves array option aliases and descriptions on each named suggestion", () => {
    const spec: FigSpec = {
      name: "demo",
      options: [{
        name: ["-f", "--format"],
        args: {
          suggestions: [
            { name: ["json", "jsonc"], description: "机器可读格式" },
            { name: "yaml", description: "可读配置格式" },
          ],
        },
      }],
    };
    expect(suggestOptionValues(spec, "demo -f ")).toEqual([
      expect.objectContaining({ command: "json", description: "机器可读格式" }),
      expect.objectContaining({ command: "jsonc", description: "机器可读格式" }),
      expect.objectContaining({ command: "yaml", description: "可读配置格式" }),
    ]);
    expect(suggestOptionValues(spec, "demo --format ")).toEqual([
      expect.objectContaining({ command: "json", description: "机器可读格式" }),
      expect.objectContaining({ command: "jsonc", description: "机器可读格式" }),
      expect.objectContaining({ command: "yaml", description: "可读配置格式" }),
    ]);
  });
});
