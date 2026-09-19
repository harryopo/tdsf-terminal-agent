import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Locks the dev / release isolation invariants.
//
// 1. Both builds used to share one app identifier, so they shared
//    %APPDATA%\<id> (workspace & session stores overwriting each other) and
//    %LOCALAPPDATA%\<id>\EBWebView. WebView2 keeps a single browser process
//    group per user-data folder, so whichever instance started second reused
//    the first one's process and its own launch args were dropped.
// 2. WebView2 start-up args only take effect when they come from
//    app.windows[].additionalBrowserArgs. The WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
//    environment variable was proven inert on the real desktop (2026-09-19):
//    neither --disable-gpu nor the debug port reached msedgewebview2.exe.
// 3. The debug port must never reach the installer — that was finding R1.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

interface WindowConf {
  label?: string;
  additionalBrowserArgs?: string;
  [key: string]: unknown;
}

function readJson(relativePath: string) {
  return JSON.parse(readFileSync(resolve(ROOT, relativePath), "utf8")) as {
    identifier?: string;
    app?: { windows?: WindowConf[] };
    scripts?: Record<string, string>;
  };
}

const RELEASE = "src-tauri/tauri.conf.json";
const DEV = "src-tauri/tauri.dev.conf.json";
const RELEASE_PATH_CONFIGS = [RELEASE, "src-tauri/tauri.windows.conf.json", "src-tauri/tauri.linux.conf.json"];

const DEBUG_ARGS = ["--remote-debugging-port=9222", "--remote-allow-origins=*"];

function mainWindow(config: ReturnType<typeof readJson>): WindowConf {
  const win = config.app?.windows?.find((w) => w.label === "main") ?? config.app?.windows?.[0];
  if (!win) throw new Error("配置里找不到 main 窗口");
  return win;
}

describe("dev / release app isolation", () => {
  it("dev uses a different identifier so stores and the WebView2 UDF are separate", () => {
    expect(readJson(RELEASE).identifier).toBe("com.tdsf.terminal-agent");
    expect(readJson(DEV).identifier).toBe("com.tdsf.terminal-agent.dev");
  });

  it("release window keeps --disable-gpu and no debug port", () => {
    const args = mainWindow(readJson(RELEASE)).additionalBrowserArgs ?? "";
    expect(args).toContain("--disable-gpu");
    expect(args).not.toMatch(/remote-debugging|remote-allow-origins/);
  });

  it("dev window = release window as merged on Windows + CDP probe port", () => {
    const base = mainWindow(readJson(RELEASE));
    const windowsPlatform = mainWindow(readJson("src-tauri/tauri.windows.conf.json"));
    const expected = { ...base, ...windowsPlatform };
    const dev = { ...mainWindow(readJson(DEV)) };

    const baseArgs = String(expected.additionalBrowserArgs ?? "");
    delete expected.additionalBrowserArgs;
    const devArgs = String(dev.additionalBrowserArgs ?? "");
    delete dev.additionalBrowserArgs;

    // `--config` 走 JSON Merge Patch，数组是整体替换而非逐项合并：dev 的窗口对象
    // 必须逐字段跟住基础配置，否则改一处忘一处会让 dev 与发布版长得不一样。
    expect(dev).toEqual(expected);
    expect(devArgs).toContain(baseArgs);
    for (const flag of DEBUG_ARGS) expect(devArgs).toContain(flag);
  });

  it("only tauri.dev.conf.json may carry a debug port — R1 regression guard", () => {
    for (const path of RELEASE_PATH_CONFIGS) {
      const raw = readFileSync(resolve(ROOT, path), "utf8");
      expect(raw, `${path} 在 dev 与 build 两条路径上都会被合并，不得含调试参数`).not.toMatch(
        /remote-debugging|remote-allow-origins/,
      );
    }
  });

  it("only the dev entry point loads the dev config", () => {
    const scripts = readJson("package.json").scripts ?? {};
    expect(scripts["tauri:dev"]).toContain("--config src-tauri/tauri.dev.conf.json");
    for (const key of ["tauri:build", "build:win"]) {
      expect(scripts[key], `${key} 必须与 dev 配置无关`).not.toContain("tauri.dev.conf.json");
    }
  });
});
