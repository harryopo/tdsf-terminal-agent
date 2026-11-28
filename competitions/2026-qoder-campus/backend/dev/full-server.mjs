import { createServer as createHttpServer } from "node:http";
import { readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createApiHandler } from "./server.mjs";

const siteRoot = resolve(fileURLToPath(new URL("../../site/", import.meta.url)));
const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ttf": "font/ttf",
  ".woff2": "font/woff2",
  ".wasm": "application/wasm",
  ".iso": "application/octet-stream",
  ".bin": "application/octet-stream",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

function staticFile(pathname) {
  const requested = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
  const filePath = resolve(siteRoot, `.${requested}`);
  if (!filePath.startsWith(`${siteRoot}${sep}`) || !statSync(filePath, { throwIfNoEntry: false })?.isFile()) return null;
  return filePath;
}

export function createFullServer() {
  const api = createApiHandler();
  return createHttpServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      if (pathname.startsWith("/api/") || pathname.startsWith("/functions/v1/app")) {
        await api(request, response);
        return;
      }
      const filePath = staticFile(pathname);
      if (!filePath) {
        response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        response.end("not found");
        return;
      }
      const body = readFileSync(filePath);
      response.writeHead(200, {
        "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
        "cache-control": [".html", ".js", ".css"].includes(extname(filePath)) ? "no-cache" : "public, max-age=3600"
      });
      response.end(request.method === "HEAD" ? undefined : body);
    } catch {
      response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      response.end("internal error");
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.FULL_PORT || process.env.PORT || 8080);
  createFullServer().listen(port, "127.0.0.1", () => console.log(`ShellLab full preview: http://127.0.0.1:${port}`));
}
