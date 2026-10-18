// @vitest-environment node
import { createRequire } from "node:module";
import { expect, it } from "vitest";

const { SourceMapConsumer } = createRequire(import.meta.url)("source-map-js");
const innerMap = {
  version: 3,
  sources: ["fixture.js"],
  names: [],
  mappings: "AAAA",
};

it("rejects an indexed map section beyond the generated-line limit", () => {
  const map = {
    version: 3,
    sections: [{ offset: { line: 10_000_001, column: 0 }, map: innerMap }],
  };

  expect(() => new SourceMapConsumer(map)).toThrow(/must not exceed/);
});

it("resolves ordinary indexed maps", () => {
  const map = {
    version: 3,
    sections: [{ offset: { line: 0, column: 0 }, map: innerMap }],
  };

  expect(new SourceMapConsumer(map).originalPositionFor({ line: 1, column: 1 }).source).toBe(
    "fixture.js",
  );
});

it("rejects nested section offsets whose sum exceeds the generated-line limit", () => {
  const nestedMap = {
    version: 3,
    sections: [{ offset: { line: 5_000_001, column: 0 }, map: innerMap }],
  };
  const map = {
    version: 3,
    sections: [{ offset: { line: 5_000_000, column: 0 }, map: nestedMap }],
  };

  expect(() => new SourceMapConsumer(map)).toThrow(/must not exceed/);
});
