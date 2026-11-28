import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "../functions/store.mjs";
import { BackendError } from "../functions/app.mjs";

class FakeDb {
  constructor() {
    this.tables = new Map();
  }

  from(table) {
    if (!this.tables.has(table)) this.tables.set(table, []);
    return new Query(this, table);
  }
}

class Query {
  constructor(db, table) {
    this.db = db;
    this.table = table;
    this.filters = [];
    this.operation = "select";
    this.payload = null;
    this.conflict = null;
    this.max = Infinity;
  }

  select() { return this; }
  eq(column, value) { this.filters.push([column, value]); return this; }
  order() { return this; }
  limit(value) { this.max = value; return this; }
  insert(payload) { this.operation = "insert"; this.payload = payload; return this; }
  insertIfAbsent(payload, { onConflict }) { this.operation = "insertIfAbsent"; this.payload = payload; this.conflict = onConflict.split(","); return this; }
  update(payload) { this.operation = "update"; this.payload = payload; return this; }
  delete() { this.operation = "delete"; return this; }

  matches(row) {
    return this.filters.every(([column, value]) => row[column] === value);
  }

  async execute() {
    const rows = this.db.tables.get(this.table);
    if (this.operation === "insert") {
      rows.push({ ...this.payload });
      return { data: [{ ...this.payload }], error: null };
    }
    if (this.operation === "insertIfAbsent") {
      const exists = rows.some((row) => this.conflict.every((column) => row[column] === this.payload[column]));
      if (exists) return { data: [], error: null };
      rows.push({ ...this.payload });
      return { data: [{ ...this.payload }], error: null };
    }
    if (this.operation === "update") {
      const updated = rows.filter((row) => this.matches(row)).map((row) => Object.assign(row, this.payload));
      return { data: updated.slice(0, this.max), error: null };
    }
    if (this.operation === "delete") {
      const removed = rows.filter((row) => this.matches(row));
      this.db.tables.set(this.table, rows.filter((row) => !this.matches(row)));
      return { data: removed, error: null };
    }
    return { data: rows.filter((row) => this.matches(row)).slice(0, this.max), error: null };
  }

  then(resolve, reject) {
    return this.execute().then(resolve, reject);
  }
}

test("database store persists anonymous learners, idempotent attempts and progress", async () => {
  const store = createStore(new FakeDb(), BackendError);
  const learner = { id: "44444444-4444-4444-8444-444444444444", tokenHash: "hash", createdAt: "2026-11-27T00:00:00.000Z", lastSeenAt: "2026-11-27T00:00:00.000Z" };
  await store.createLearner(learner);
  assert.equal((await store.findLearnerByTokenHash("hash")).id, learner.id);

  const attempt = { id: "55555555-5555-4555-8555-555555555555", learnerId: learner.id, taskId: "files", stepId: "files-pwd", taskVersion: "2026-11-27.2", commandSha256: "command", outputSha256: "output", status: "success", evidenceMatched: true, durationMs: 10, createdAt: "2026-11-27T00:00:01.000Z" };
  assert.equal((await store.insertAttemptIfAbsent(attempt)).inserted, true);
  assert.equal((await store.insertAttemptIfAbsent(attempt)).inserted, false);
  assert.equal((await store.listAttempts(learner.id)).length, 1);

  await store.markStepComplete({ learnerId: learner.id, taskId: "files", stepId: "files-pwd", taskVersion: "2026-11-27.2", completedAt: attempt.createdAt });
  const progress = await store.listProgress(learner.id, "2026-11-27.2");
  assert.equal(progress.length, 1);
  assert.equal(progress[0].taskId, "files");
  assert.equal(progress[0].stepId, "files-pwd");
  assert.equal(progress[0].status, "completed");
});
