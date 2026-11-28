import test from "node:test";
import assert from "node:assert/strict";
import { loadTaskCatalog } from "../api-client.js";
import catalog from "../../backend/functions/tasks.json" with { type: "json" };

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

test("catalog uses the complete static catalog when the API is unavailable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (path) => {
    if (path === "/api/tasks") throw new Error("offline");
    if (path === "./catalog.json") return Response.json(catalog);
    throw new Error(`unexpected path: ${path}`);
  };
  try {
    const local = await loadTaskCatalog();
    assert.equal(local.source, "local");
    assert.equal(local.version, catalog.version);
    assert.equal(local.tasks.length, 6);
    assert.equal(local.tasks.reduce((total, task) => total + task.steps.length, 0), 18);
    assert.equal(local.tasks[0].steps[0].expect instanceof RegExp, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("catalog keeps a minimal bundled fallback when all catalog sources fail", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("offline"); };
  try {
    const local = await loadTaskCatalog();
    assert.equal(local.source, "local");
    assert.equal(local.tasks.length, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
