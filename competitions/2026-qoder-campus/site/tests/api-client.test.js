import test from "node:test";
import assert from "node:assert/strict";
import { loadTaskCatalog } from "../api-client.js";

test("server task rules become regular expressions without losing metadata", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    version: "2026-11-27.1",
    tasks: [{ id: "disk", number: "03", name: "磁盘容量", steps: [{ id: "disk-df", command: "df -h", expect: { pattern: "Filesystem", flags: "" } }] }]
  });
  try {
    const catalog = await loadTaskCatalog();
    assert.equal(catalog.source, "server");
    assert.equal(catalog.version, "2026-11-27.1");
    assert.equal(catalog.tasks[0].steps[0].expect instanceof RegExp, true);
    assert.equal(catalog.tasks[0].steps[0].expect.test("Filesystem Size Used"), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("catalog falls back to the bundled tasks when the API is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("offline"); };
  try {
    const catalog = await loadTaskCatalog();
    assert.equal(catalog.source, "local");
    assert.equal(catalog.tasks.length, 3);
    assert.equal(catalog.tasks[0].steps[0].expect instanceof RegExp, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
