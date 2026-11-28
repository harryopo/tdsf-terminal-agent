import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "../dev/server.mjs";

test("local HTTP server runs the real session, attempt and progress flow", async () => {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.equal((await health.json()).ok, true);

    const tasks = await fetch(`${base}/api/tasks`);
    assert.equal(tasks.status, 200);
    assert.equal((await tasks.json()).tasks.length, 6);

    const session = await fetch(`${base}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(session.status, 200);
    const cookie = session.headers.get("set-cookie").split(";")[0];

    const attempt = await fetch(`${base}/api/attempts`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ attemptId: "33333333-3333-4333-8333-333333333333", taskId: "files", stepId: "files-pwd", command: "pwd", output: "/root\n/root% ", durationMs: 10 })
    });
    assert.equal(attempt.status, 201);
    assert.equal((await attempt.json()).status, "success");

    const progress = await fetch(`${base}/api/progress`, { headers: { cookie } });
    assert.equal(progress.status, 200);
    const body = await progress.json();
    assert.deepEqual(body.completed.map((item) => item.stepId), ["files-pwd"]);
    assert.equal(body.attempts[0].count, 1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
