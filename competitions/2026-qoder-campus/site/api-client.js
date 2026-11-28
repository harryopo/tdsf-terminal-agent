import { tasks as bundledTasks } from "./lesson-tasks.js";

function normalizeTasks(tasks) {
  return tasks.map((task) => ({
    ...task,
    steps: task.steps.map((step) => ({
      ...step,
      expect: step.expect instanceof RegExp
        ? step.expect
        : new RegExp(step.expect.pattern, step.expect.flags || "")
    }))
  }));
}

async function request(path, { method = "GET", body, timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`API ${response.status}`);
    return response.status === 204 ? null : response.json();
  } finally {
    clearTimeout(timeout);
  }
}

export async function loadTaskCatalog() {
  try {
    const catalog = await request("/api/tasks");
    if (!Array.isArray(catalog.tasks) || typeof catalog.version !== "string") throw new Error("invalid catalog");
    return { version: catalog.version, tasks: normalizeTasks(catalog.tasks), source: "server" };
  } catch {
    return { version: "local-3", tasks: normalizeTasks(bundledTasks), source: "local" };
  }
}

export async function ensureSession() {
  try {
    return await request("/api/session", { method: "POST", body: {} });
  } catch {
    return null;
  }
}

export async function loadServerProgress() {
  try {
    return await request("/api/progress");
  } catch {
    return null;
  }
}

export async function reportAttempt(attempt) {
  try {
    return await request("/api/attempts", { method: "POST", body: attempt });
  } catch {
    return null;
  }
}

export async function resetServerProgress() {
  try {
    return await request("/api/progress/reset", { method: "POST", body: {} });
  } catch {
    return null;
  }
}
