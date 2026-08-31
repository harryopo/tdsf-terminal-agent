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

  it("supports Chinese variable names (教学场景)", () => {
    expect(collectPlaceholders("ps aux | grep -i {{关键词}}")).toEqual([
      "关键词",
    ]);
    expect(
      interpolate("grep -i {{关键词}} /var/log/secure", { 关键词: "ssh" }),
    ).toBe("grep -i ssh /var/log/secure");
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
  function sn(id: string, createdAt = 0, pinnedAt?: number): Snippet {
    return {
      id,
      name: id,
      command: "cmd",
      tags: [],
      variables: [],
      createdAt,
      updatedAt: createdAt,
      pinnedAt,
    };
  }

  it("puts pinned snippets before unpinned ones (置顶优先)", () => {
    const sorted = sortSnippets([sn("a", 100), sn("b", 200, 1)]);
    expect(sorted.map((s) => s.id)).toEqual(["b", "a"]);
  });

  it("orders pinned snippets by pin time descending (最后置顶最靠上)", () => {
    const sorted = sortSnippets([
      sn("first-pin", 0, 100),
      sn("third-pin", 0, 300),
      sn("second-pin", 0, 200),
    ]);
    expect(sorted.map((s) => s.id)).toEqual(["third-pin", "second-pin", "first-pin"]);
  });

  it("sorts unpinned snippets by createdAt descending (新建在前)", () => {
    const sorted = sortSnippets([sn("old", 100), sn("new", 300), sn("mid", 200)]);
    expect(sorted.map((s) => s.id)).toEqual(["new", "mid", "old"]);
  });

  it("does not mutate the input list", () => {
    const list = [sn("a", 1), sn("b", 5)];
    const sorted = sortSnippets(list);
    expect(sorted).not.toBe(list);
    expect(list.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("keeps positions stable regardless of insertion usage (插入不跳动)", () => {
    const list = [sn("pinned", 0, 100), sn("a", 200), sn("b", 100)];
    const before = sortSnippets(list).map((s) => s.id);
    // 模拟"使用了 a"——数据本身没有任何可变标记，顺序只由置顶/创建时间决定
    const after = sortSnippets(list).map((s) => s.id);
    expect(after).toEqual(before);
  });
});
