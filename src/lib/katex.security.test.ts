// @vitest-environment node
import { createRequire } from "node:module";
import { expect, it } from "vitest";

// Resolve the renderer actually used by Mermaid, not an unrelated hoisted copy.
const require = createRequire(import.meta.url);
const katex = createRequire(require.resolve("mermaid"))("katex");

it("does not inherit trusted rendering from an options prototype", () => {
  const options = Object.assign(Object.create({ trust: true }), {
    output: "mathml",
    throwOnError: true,
  });
  const html = katex.renderToString(String.raw`\href{https://example.invalid/}{x}`, options);
  expect(html).not.toContain('href="https://example.invalid/"');
});

it("renders ordinary Mermaid-style MathML without enabling trusted commands", () => {
  const html = katex.renderToString(String.raw`\frac{x^2}{2}+\sqrt{y}`, {
    output: "mathml",
    displayMode: true,
    throwOnError: true,
  });
  expect(html).toContain("<math");
  expect(html).toContain("<mfrac>");
  expect(html).toContain("<msqrt>");
  expect(html).not.toContain("<script");
});

it("preserves explicit trusted rendering for callers that opt in", () => {
  const html = katex.renderToString(String.raw`\href{https://example.invalid/}{x}`, {
    trust: true,
    output: "mathml",
  });
  expect(html).toContain('href="https://example.invalid/"');
});
