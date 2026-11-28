import test from "node:test";
import assert from "node:assert/strict";
import { createFullServer } from "../dev/full-server.mjs";

test("full-stack preview serves the site and task API on one origin", async () => {
  const server = createFullServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /ShellLab/);

    const tasks = await fetch(`${base}/api/tasks`);
    assert.equal(tasks.status, 200);
    assert.equal((await tasks.json()).tasks.length, 6);

    const script = await fetch(`${base}/app.js?v=20261127l`);
    assert.equal(script.status, 200);
    assert.match(await script.text(), /loadTaskCatalog/);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
