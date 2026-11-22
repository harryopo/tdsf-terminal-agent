// @vitest-environment node
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { loadConfigFromFile, type ServerOptions } from "vite";

describe("Vite watcher scope", () => {
  let server: ServerOptions;

  beforeAll(async () => {
    const loaded = await loadConfigFromFile(
      { command: "serve", mode: "development" },
      join(process.cwd(), "vite.config.ts"),
    );
    if (!loaded?.config.server) throw new Error("Missing development server configuration");
    server = loaded.config.server;
  });

  it("excludes archived artifacts from development watching", () => {
    expect(server.watch?.ignored).toContain("**/outputs/**");
  });

  it("keeps file watching enabled and the Rust build exclusion", () => {
    expect(server.watch).toBeDefined();
    expect(server.watch).not.toBeNull();
    expect(server.watch?.ignored).toContain("**/src-tauri/**");
  });

  it("keeps source and public files watchable on the existing loopback port", () => {
    const ignored = server.watch?.ignored;
    for (const pattern of ["**/src/**", "**/public/**", "**/*", "**"]) {
      expect(ignored).not.toContain(pattern);
    }
    expect(server.host).toBe("127.0.0.1");
    expect(server.port).toBe(9300);
    expect(server.strictPort).toBe(true);
  });
});
