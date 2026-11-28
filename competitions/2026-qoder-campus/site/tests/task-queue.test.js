import test from "node:test";
import assert from "node:assert/strict";
import { createTaskQueue } from "../task-queue.js";

test("progress writes run in submission order", async () => {
  const queue = createTaskQueue();
  const events = [];
  let release;
  const first = queue.run(async () => {
    events.push("first-start");
    await new Promise((resolve) => { release = resolve; });
    events.push("first-end");
  });
  const second = queue.run(async () => {
    events.push("second");
  });
  await Promise.resolve();
  assert.deepEqual(events, ["first-start"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "first-end", "second"]);
});

test("a failed write does not block the next operation", async () => {
  const queue = createTaskQueue();
  await assert.rejects(queue.run(async () => { throw new Error("failed"); }), /failed/);
  assert.equal(await queue.run(async () => "ok"), "ok");
});
