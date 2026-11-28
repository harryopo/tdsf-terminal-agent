import { createServer as createHttpServer } from "node:http";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { application, BackendError } from "../functions/app.mjs";
import { MemoryStore } from "./memory-store.mjs";
import tasks from "../functions/tasks.json" with { type: "json" };

export function createApiHandler() {
  const handle = application({ store: new MemoryStore(), tasks, BackendError });
  return async (request, response) => {
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
      }
      const init = { method: request.method, headers, duplex: "half" };
      if (request.method !== "GET" && request.method !== "HEAD") init.body = Readable.toWeb(request);
      const webRequest = new Request(`http://${request.headers.host || "127.0.0.1:8000"}${request.url}`, init);
      const result = await handle({ request: webRequest, requestId: crypto.randomUUID() });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(Buffer.from(await result.arrayBuffer()));
    } catch {
      response.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify({ error: { code: "internal_error", message: "internal_error" } }));
    }
  };
}

export function createServer() {
  return createHttpServer(createApiHandler());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 8000);
  const server = createServer();
  server.listen(port, "127.0.0.1", () => console.log(`ShellLab API: http://127.0.0.1:${port}`));
}
