import test from "node:test";
import assert from "node:assert/strict";
import { application, BackendError } from "../functions/app.mjs";
import { MemoryStore } from "../dev/memory-store.mjs";
import catalog from "../functions/tasks.json" with { type: "json" };

const base = "http://127.0.0.1:8000";
const attemptId = "11111111-1111-4111-8111-111111111111";

function setup() {
  const store = new MemoryStore();
  const handle = application({ store, tasks: catalog, BackendError });
  return { store, handle };
}

async function call(handle, path, { method = "GET", body, headers = {}, cookie } = {}) {
  const requestHeaders = new Headers(headers);
  if (body !== undefined) requestHeaders.set("content-type", "application/json");
  if (cookie) requestHeaders.set("cookie", cookie);
  return handle({ request: new Request(`${base}${path}`, { method, headers: requestHeaders, body: body === undefined ? undefined : JSON.stringify(body) }), requestId: "test-request" });
}

async function createSession(handle) {
  const response = await call(handle, "/api/session", { method: "POST", body: {} });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";")[0];
}

test("task catalog and task detail are public and versioned", async () => {
  const { handle } = setup();
  const list = await call(handle, "/api/tasks");
  assert.equal(list.status, 200);
  const listBody = await list.json();
  assert.equal(listBody.version, catalog.version);
  assert.equal(listBody.tasks.length, 6);

  const detail = await call(handle, "/api/tasks/disk");
  assert.equal(detail.status, 200);
  const detailBody = await detail.json();
  assert.equal(detailBody.task.id, "disk");
  assert.equal(detailBody.task.steps.length, 3);

  const missing = await call(handle, "/api/tasks/missing");
  assert.equal(missing.status, 404);
});

test("anonymous session uses an opaque HttpOnly cookie", async () => {
  const { handle } = setup();
  const response = await call(handle, "/api/session", { method: "POST", body: {} });
  assert.equal(response.status, 200);
  const setCookie = response.headers.get("set-cookie");
  assert.match(setCookie, /^shelllab_session=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.doesNotMatch(JSON.stringify(await response.json()), /token|sessionId|learnerId/i);
});

test("progress requires a session and starts empty", async () => {
  const { handle } = setup();
  const denied = await call(handle, "/api/progress");
  assert.equal(denied.status, 401);

  const cookie = await createSession(handle);
  const response = await call(handle, "/api/progress", { cookie });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { catalogVersion: catalog.version, completed: [], attempts: [] });
});

test("server validates command and output before marking a step complete", async () => {
  const { handle } = setup();
  const cookie = await createSession(handle);
  const wrong = await call(handle, "/api/attempts", {
    method: "POST",
    cookie,
    body: { attemptId, taskId: "files", stepId: "files-pwd", command: "whoami", output: "root\n/root% ", durationMs: 20 }
  });
  assert.equal(wrong.status, 201);
  assert.equal((await wrong.json()).status, "mismatch");

  const correct = await call(handle, "/api/attempts", {
    method: "POST",
    cookie,
    body: { attemptId: "22222222-2222-4222-8222-222222222222", taskId: "files", stepId: "files-pwd", command: "pwd", output: "/root\n/root% ", durationMs: 21 }
  });
  assert.equal(correct.status, 201);
  const correctBody = await correct.json();
  assert.equal(correctBody.status, "success");
  assert.equal(correctBody.evidenceMatched, true);
  assert.equal("output" in correctBody, false);

  const progress = await (await call(handle, "/api/progress", { cookie })).json();
  assert.deepEqual(progress.completed.map((item) => item.stepId), ["files-pwd"]);
  assert.deepEqual(progress.attempts.map((item) => [item.stepId, item.count]), [["files-pwd", 2]]);
});

test("command echo and shell prompt are not output evidence", async () => {
  const { handle } = setup();
  const cookie = await createSession(handle);
  const response = await call(handle, "/api/attempts", {
    method: "POST",
    cookie,
    body: {
      attemptId: "66666666-6666-4666-8666-666666666666",
      taskId: "disk",
      stepId: "disk-du",
      command: "du -sh /root",
      output: "/root% du -sh /root\r\n/root% ",
      durationMs: 10
    }
  });
  assert.equal(response.status, 201);
  assert.equal((await response.json()).status, "output-mismatch");
});

test("root directory prompt is recognized and removed from evidence", async () => {
  const { handle } = setup();
  const cookie = await createSession(handle);
  const response = await call(handle, "/api/attempts", {
    method: "POST",
    cookie,
    body: {
      attemptId: "77777777-7777-4777-8777-777777777777",
      taskId: "disk",
      stepId: "disk-du",
      command: "du -sh /root",
      output: "/% du -sh /root\r\n/% ",
      durationMs: 10
    }
  });
  assert.equal((await response.json()).status, "output-mismatch");
});

test("attempt retries are idempotent and conflicting reuse is rejected", async () => {
  const { handle } = setup();
  const cookie = await createSession(handle);
  const body = { attemptId, taskId: "files", stepId: "files-pwd", command: "pwd", output: "/root\n/root% ", durationMs: 20 };
  const first = await call(handle, "/api/attempts", { method: "POST", cookie, body });
  assert.equal(first.status, 201);
  const retry = await call(handle, "/api/attempts", { method: "POST", cookie, body });
  assert.equal(retry.status, 200);
  const conflict = await call(handle, "/api/attempts", { method: "POST", cookie, body: { ...body, command: "whoami" } });
  assert.equal(conflict.status, 409);

  const progress = await (await call(handle, "/api/progress", { cookie })).json();
  assert.equal(progress.attempts[0].count, 1);
});

test("writes reject cross-origin requests and invalid payloads", async () => {
  const { handle } = setup();
  const crossOrigin = await call(handle, "/api/session", { method: "POST", headers: { origin: "https://evil.example" }, body: {} });
  assert.equal(crossOrigin.status, 403);

  const cookie = await createSession(handle);
  const invalidType = await handle({
    request: new Request(`${base}/api/attempts`, { method: "POST", headers: { cookie, "content-type": "text/plain" }, body: "{}" }),
    requestId: "test-request"
  });
  assert.equal(invalidType.status, 400);

  const oversized = await handle({
    request: new Request(`${base}/api/attempts`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ value: "x".repeat(40000) }) }),
    requestId: "test-request"
  });
  assert.equal(oversized.status, 413);
});

test("reset clears learning progress and attempts but keeps the session", async () => {
  const { handle } = setup();
  const cookie = await createSession(handle);
  await call(handle, "/api/attempts", {
    method: "POST",
    cookie,
    body: { attemptId, taskId: "files", stepId: "files-pwd", command: "pwd", output: "/root\n/root% ", durationMs: 20 }
  });
  const reset = await call(handle, "/api/progress/reset", { method: "POST", cookie, body: {} });
  assert.equal(reset.status, 200);
  const progress = await (await call(handle, "/api/progress", { cookie })).json();
  assert.deepEqual(progress.completed, []);
  assert.deepEqual(progress.attempts, []);
});

test("reset invalidates in-flight writes from the previous learner", async () => {
  const { store, handle } = setup();
  const cookie = await createSession(handle);
  const oldLearner = [...store.learners.values()][0];
  let releaseInsert;
  let signalInsert;
  const insertGate = new Promise((resolve) => { releaseInsert = resolve; });
  const insertStarted = new Promise((resolve) => { signalInsert = resolve; });
  const insertAttempt = store.insertAttemptIfAbsent.bind(store);
  store.insertAttemptIfAbsent = async (attempt) => {
    signalInsert();
    await insertGate;
    return insertAttempt(attempt);
  };

  const pendingAttempt = call(handle, "/api/attempts", {
    method: "POST",
    cookie,
    body: { attemptId, taskId: "files", stepId: "files-pwd", command: "pwd", output: "/root\n/root% ", durationMs: 20 }
  });
  await insertStarted;
  const reset = await call(handle, "/api/progress/reset", { method: "POST", cookie, body: {} });
  assert.equal(reset.status, 200);
  releaseInsert();
  await assert.rejects(pendingAttempt);

  const progress = await (await call(handle, "/api/progress", { cookie })).json();
  assert.deepEqual(progress.completed, []);
  assert.deepEqual(progress.attempts, []);
  assert.notEqual([...store.learners.values()][0].id, oldLearner.id);
});

test("unknown routes and unsupported methods return stable errors", async () => {
  const { handle } = setup();
  const missing = await call(handle, "/api/missing");
  assert.equal(missing.status, 404);
  const method = await call(handle, "/api/tasks", { method: "POST", body: {} });
  assert.equal(method.status, 405);
  const body = await method.json();
  assert.equal(body.error.code, "method_not_allowed");
  assert.equal(body.error.requestId, "test-request");
});
