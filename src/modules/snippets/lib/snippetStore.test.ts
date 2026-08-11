import { describe, expect, it } from "vitest";
import {
  collectPlaceholders,
  interpolate,
  sortSnippets,
} from "./snippetStore";
import type { Snippet } from "../types";

describe("collectPlaceholders", () => {
  it("extracts {{name}} placeholders in order", () => {
    expect(collectPlaceholders("echo {{hostname}} && ping {{ip}}")).toEqual([
      "hostname",
      "ip",
    ]);
  });

  it("deduplicates repeated placeholders", () => {
    expect(collectPlaceholders("{{a}} {{b}} {{a}}")).toEqual(["a", "b"]);
  });

  it("tolerates whitespace inside braces", () => {
    expect(collectPlaceholders("{{ host }}")).toEqual(["host"]);
  });

  it("ignores non-word keys and returns empty for plain commands", () => {
    expect(collectPlaceholders("ls -la")).toEqual([]);
    expect(collectPlaceholders("{{a-b}}")).toEqual([]);
  });
});

describe("interpolate", () => {
  it("replaces all occurrences with provided values", () => {
    expect(
      interpolate("ping {{host}} -c {{count}}", { host: "8.8.8.8", count: "3" }),
    ).toBe("ping 8.8.8.8 -c 3");
  });

  it("keeps the placeholder when the value is missing", () => {
    expect(interpolate("echo {{name}}", {})).toBe("echo {{name}}");
  });

  it("keeps the placeholder when the value is empty", () => {
    expect(interpolate("echo {{name}}", { name: "" })).toBe("echo {{name}}");
  });
});

describe("sortSnippets", () => {
  function sn(id: string, usageCount: number, lastUsedAt?: number, createdAt = 0): Snippet {
    return {
      id,
      name: id,
      command: "cmd",
      tags: [],
      variables: [],
      createdAt,
      updatedAt: createdAt,
      usageCount,
      lastUsedAt,
    };
  }

  it("sorts by usageCount descending", () => {
    const sorted = sortSnippets([sn("a", 1), sn("b", 5), sn("c", 2)]);
    expect(sorted.map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  it("breaks ties by lastUsedAt descending", () => {
    const sorted = sortSnippets([
      sn("a", 1, 100),
      sn("b", 1, 300),
      sn("c", 1, 200),
    ]);
    expect(sorted.map((s) => s.id)).toEqual(["b", "c", "a"]);
  });

  it("breaks remaining ties by createdAt descending", () => {
    const sorted = sortSnippets([
      sn("a", 0, undefined, 100),
      sn("b", 0, undefined, 300),
    ]);
    expect(sorted.map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("does not mutate the input list", () => {
    const list = [sn("a", 1), sn("b", 5)];
    const sorted = sortSnippets(list);
    expect(sorted).not.toBe(list);
    expect(list.map((s) => s.id)).toEqual(["a", "b"]);
  });
});
