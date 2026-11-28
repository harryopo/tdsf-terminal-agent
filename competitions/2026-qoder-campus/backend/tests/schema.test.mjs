import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";

const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");

test("schema stays within the Qoder migration DDL subset", () => {
  assert.doesNotMatch(schema, /\bchar\s*\(/i);
  assert.doesNotMatch(schema, /\bCHECK\s*\(/i);
  assert.doesNotMatch(schema, /\b(?:varchar|numeric|date|timestamp)\b/i);
});
