import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const catalog = JSON.parse(readFileSync(new URL("../functions/tasks.json", import.meta.url), "utf8"));
const supportedCommands = new Set([
  "pwd", "ls -la", "cat /etc/os-release", "id", "ls -l /etc/passwd", "grep '^root:' /etc/passwd",
  "df -h", "du -sh /root", "find /root -maxdepth 1 -type f | sort",
  "ps", "top -b -n 1", "free -m",
  "ifconfig -a", "route -n", "ping -c 1 127.0.0.1",
  "uname -a", "dmesg | tail -n 5", "uptime"
]);

test("catalog contains six task packs and eighteen verified steps", () => {
  assert.equal(catalog.version, "2026-11-27.2");
  assert.equal(catalog.tasks.length, 6);
  assert.equal(catalog.tasks.reduce((total, task) => total + task.steps.length, 0), 18);
  for (const task of catalog.tasks) assert.equal(task.steps.length, 3);
});

test("task and step identifiers are unique and commands stay within the guest image", () => {
  const taskIds = new Set();
  const stepIds = new Set();
  for (const task of catalog.tasks) {
    assert.equal(taskIds.has(task.id), false);
    taskIds.add(task.id);
    for (const step of task.steps) {
      assert.equal(stepIds.has(step.id), false);
      stepIds.add(step.id);
      assert.equal(supportedCommands.has(step.command), true, `unsupported command: ${step.command}`);
    }
  }
});

test("every evidence rule is a serializable compilable pattern", () => {
  for (const task of catalog.tasks) {
    for (const step of task.steps) {
      assert.equal(typeof step.expect.pattern, "string");
      assert.equal(typeof step.expect.flags, "string");
      assert.doesNotThrow(() => new RegExp(step.expect.pattern, step.expect.flags));
      for (const field of ["heading", "body", "meaning", "next", "hint"]) {
        assert.equal(typeof step[field], "string");
        assert.ok(step[field].length > 0);
      }
    }
  }
});
