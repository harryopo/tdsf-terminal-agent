export class BackendError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const idPattern = /^[a-z0-9-]{1,64}$/;
const sessionCookieName = "shelllab_session";

function normalizeCommand(value) {
  const cleaned = value.replace(/[\p{Cc}\p{Cf}\uFFFD]/gu, (char) => /\s/.test(char) ? " " : "");
  return cleaned.trim().replace(/\s+/g, " ");
}

function normalizeOutput(value) {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "\n");
}

function outputEvidence(value, command) {
  const prompt = String.raw`(?:\/(?:[\w./-]+)?|[A-Za-z0-9_.-]+\/[\w./-]+)[%#]`;
  const promptLine = new RegExp(`^${prompt} $`);
  const promptPrefix = new RegExp(`^${prompt}\\s+`);
  const lines = normalizeOutput(value).replace(/^\n+/, "").split("\n");
  const firstLine = (lines[0] || "").replace(promptPrefix, "").trim();
  if (firstLine === command) lines.shift();
  return lines.filter((line) => !promptLine.test(line)).join("\n").trim();
}

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function readCookie(request) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === sessionCookieName) return rest.join("=");
  }
  return null;
}

function sessionCookie(request, token) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${sessionCookieName}=${token}; Path=/; Max-Age=15552000; HttpOnly; SameSite=Lax${secure}`;
}

function routePath(request) {
  const pathname = new URL(request.url).pathname;
  const match = pathname.match(/^\/(?:functions\/v1\/)?(?:app|app-d[0-9a-f]{32})(\/.*)?$/);
  if (match) return match[1] || "/";
  return pathname.startsWith("/api/") || pathname === "/api" ? pathname : null;
}

export function application({ store, tasks, BackendError: ErrorType, now = () => new Date().toISOString(), random = randomToken, hash = sha256 }) {
  const fail = (code, status = 400) => { throw new ErrorType(code, status); };
  const taskById = new Map(tasks.tasks.map((task) => [task.id, task]));

  async function input(request, maxBytes = 32768) {
    if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) fail("invalid_content_type", 400);
    const reader = request.body?.getReader();
    if (!reader) fail("invalid_json", 400);
    let size = 0;
    const chunks = [];
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          await reader.cancel();
          fail("payload_too_large", 413);
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      fail("invalid_json", 400);
    }
  }

  function sameOrigin(request) {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(request.url).origin) fail("cross_origin", 403);
  }

  async function learner(request, required = true) {
    const token = readCookie(request);
    if (!token) {
      if (required) fail("session_required", 401);
      return null;
    }
    const tokenHash = await hash(token);
    const found = await store.findLearnerByTokenHash(tokenHash);
    if (!found) {
      if (required) fail("session_required", 401);
      return null;
    }
    const touched = await store.touchLearner(found.id, now());
    return touched || found;
  }

  async function progress(learnerId) {
    const [rows, attemptRows] = await Promise.all([
      store.listProgress(learnerId, tasks.version),
      store.listAttempts(learnerId)
    ]);
    const counts = new Map();
    for (const attempt of attemptRows) {
      const key = `${attempt.taskId}:${attempt.stepId}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return {
      catalogVersion: tasks.version,
      completed: rows.map((row) => ({ taskId: row.taskId, stepId: row.stepId, completedAt: row.firstCompletedAt })),
      attempts: [...counts].map(([key, count]) => {
        const [taskId, stepId] = key.split(":");
        return { taskId, stepId, count };
      }).sort((left, right) => `${left.taskId}:${left.stepId}`.localeCompare(`${right.taskId}:${right.stepId}`))
    };
  }

  return async (context) => {
    const request = context.request;
    const requestId = context.requestId || crypto.randomUUID();
    try {
      const path = routePath(request);
      if (!path) fail("not_found", 404);
      const method = request.method.toUpperCase();

      if (path === "/api/health" && method === "GET") {
        return Response.json({ ok: true, service: "shelllab-api", catalogVersion: tasks.version });
      }
      if (path === "/api/tasks" && method === "GET") {
        return Response.json(tasks, { headers: { "cache-control": "public, max-age=60" } });
      }
      const taskMatch = path.match(/^\/api\/tasks\/([a-z0-9-]+)$/);
      if (taskMatch && method === "GET") {
        const task = taskById.get(taskMatch[1]);
        if (!task) fail("not_found", 404);
        return Response.json({ version: tasks.version, task }, { headers: { "cache-control": "public, max-age=60" } });
      }
      if (path === "/api/session" && method === "POST") {
        sameOrigin(request);
        await input(request);
        const existing = await learner(request, false);
        if (existing) return Response.json({ ok: true, reused: true }, { headers: { "cache-control": "no-store" } });
        const token = random();
        const tokenHash = await hash(token);
        const createdAt = now();
        await store.createLearner({ id: crypto.randomUUID(), tokenHash, createdAt, lastSeenAt: createdAt });
        return Response.json({ ok: true, reused: false }, { status: 200, headers: { "set-cookie": sessionCookie(request, token), "cache-control": "no-store" } });
      }
      if (path === "/api/progress" && method === "GET") {
        const current = await learner(request);
        return Response.json(await progress(current.id), { headers: { "cache-control": "no-store" } });
      }
      if (path === "/api/progress/reset" && method === "POST") {
        sameOrigin(request);
        await input(request);
        const current = await learner(request);
        await store.resetProgress(current.id);
        const createdAt = now();
        await store.createLearner({ id: crypto.randomUUID(), tokenHash: current.tokenHash, createdAt, lastSeenAt: createdAt });
        return Response.json({ ok: true }, { headers: { "cache-control": "no-store" } });
      }
      if (path === "/api/attempts" && method === "POST") {
        sameOrigin(request);
        const body = await input(request);
        const current = await learner(request);
        if (!uuidPattern.test(body?.attemptId || "") || !idPattern.test(body?.taskId || "") || !idPattern.test(body?.stepId || "")) fail("invalid_input", 400);
        if (typeof body.command !== "string" || body.command.length > 1000 || typeof body.output !== "string" || body.output.length > 32000) fail("invalid_input", 400);
        if (!Number.isInteger(body.durationMs) || body.durationMs < 0 || body.durationMs > 600000) fail("invalid_input", 400);
        const task = taskById.get(body.taskId);
        const step = task?.steps.find((item) => item.id === body.stepId);
        if (!step) fail("not_found", 404);
        const command = normalizeCommand(body.command);
        const output = outputEvidence(body.output, command);
        const commandMatches = command === step.command;
        let evidenceMatched = false;
        if (commandMatches) {
          const expect = new RegExp(step.expect.pattern, step.expect.flags);
          evidenceMatched = expect.test(output);
        }
        const status = !commandMatches ? "mismatch" : evidenceMatched ? "success" : "output-mismatch";
        const attempt = {
          id: body.attemptId,
          learnerId: current.id,
          taskId: task.id,
          stepId: step.id,
          taskVersion: tasks.version,
          commandSha256: await sha256(command),
          outputSha256: await sha256(output),
          status,
          evidenceMatched,
          durationMs: body.durationMs,
          createdAt: now()
        };
        const stored = await store.insertAttemptIfAbsent(attempt);
        const comparable = ["taskId", "stepId", "taskVersion", "commandSha256", "outputSha256", "status", "evidenceMatched", "durationMs"];
        if (!stored.inserted && comparable.some((key) => stored.attempt[key] !== attempt[key])) fail("idempotency_conflict", 409);
        if (status === "success") {
          await store.markStepComplete({ learnerId: current.id, taskId: task.id, stepId: step.id, taskVersion: tasks.version, completedAt: attempt.createdAt });
        }
        return Response.json({ attemptId: attempt.id, status, evidenceMatched }, { status: stored.inserted ? 201 : 200, headers: { "cache-control": "no-store" } });
      }

      const known = ["/api/health", "/api/tasks", "/api/session", "/api/progress", "/api/progress/reset", "/api/attempts"];
      if (known.includes(path) || taskMatch) fail("method_not_allowed", 405);
      fail("not_found", 404);
    } catch (error) {
      if (error instanceof ErrorType) {
        return Response.json({ error: { code: error.code, message: error.code, requestId } }, { status: error.status, headers: { "cache-control": "no-store" } });
      }
      throw error;
    }
  };
}
