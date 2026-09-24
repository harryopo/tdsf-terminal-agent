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

/**
 * 探针端口只有一个主人：dev 配置本身。
 *
 * 2026-09-24 现场：本机另一个 Electron 应用（D:\ai\zhixing-reader）也在 9222 上
 * 开了调试口 ⇒ 我们的 dev 窗绑不上，而探针拿**别人的窗口**量我们的界面还报
 * "0 违规"。端口写死在两处早晚漂移，所以这里从配置里读，并另有一条用例
 * 拦住 cdp.py 里再出现字面量端口。
 */
const DEV_ARGS = String(mainWindow(readJson(DEV)).additionalBrowserArgs ?? "");
const DEBUG_PORT = /--remote-debugging-port=(\d+)/.exec(DEV_ARGS)?.[1] ?? "";
const DEBUG_ARGS = [`--remote-debugging-port=${DEBUG_PORT}`, "--remote-allow-origins=*"];

function mainWindow(config: ReturnType<typeof readJson>): WindowConf {
  const win = config.app?.windows?.find((w) => w.label === "main") ?? config.app?.windows?.[0];
  if (!win) throw new Error("配置里找不到 main 窗口");
  return win;
}

// `titleBarStyle` / `hiddenTitle` 只在 macOS 生效（tauri-runtime-wry 的 `with_config`
// 把这两个键整段包在 `#[cfg(target_os = "macos")]` 里），所以不参与 Windows 侧的
// dev/发布一致性判断 —— 否则就得为了过测试往 Windows 配置里塞两个不起作用的键。
const MAC_ONLY = new Set(["titleBarStyle", "hiddenTitle"]);
function stripMacOnly(o: WindowConf): WindowConf {
  return Object.fromEntries(Object.entries(o).filter(([k]) => !MAC_ONLY.has(k)));
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

    // 合并语义是 RFC 7386（json_patch::merge），**数组整体替换**：发布版 Windows 的
    // 主窗配置就是平台文件里那一个对象本身，base 的字段只有被重抄进来才生效。
    // 这一条以前写成 `{ ...base, ...windowsPlatform }`（浅合并），于是"平台文件只抄了
    // label + decorations"没人看得见 —— 而实际后果是发布版把尺寸、标题和
    // --disable-gpu 全丢了（2026-09-24 实测：target/release/*.exe 里搜不到 disable-gpu，
    // target/debug 里有）。
    const dropped = Object.keys(stripMacOnly(base)).filter(
      (k) => !(k in windowsPlatform),
    );
    // 唯一的合法例外：开 transparent 的窗口必须同时不刷 backgroundColor
    // （tao 的 WM_ERASEBKGND 与 draw_surface 都只取 RGB、忽略 alpha，留着它 = 四个角
    // 被刷成不透明色 = 用户说的"假圆角"）。
    expect(
      dropped.filter((k) => !(k === "backgroundColor" && windowsPlatform.transparent === true)),
      `平台文件丢掉了 base 的字段：${dropped.join(", ")}`,
    ).toEqual([]);

    const expected = stripMacOnly({ ...windowsPlatform });
    const dev = stripMacOnly({ ...mainWindow(readJson(DEV)) });

    const baseArgs = String(expected.additionalBrowserArgs ?? "");
    delete expected.additionalBrowserArgs;
    const devArgs = String(dev.additionalBrowserArgs ?? "");
    delete dev.additionalBrowserArgs;

    // dev 的窗口对象必须逐字段跟住发布版，否则改一处忘一处会让两边长得不一样。
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

  it("探针端口与界面出处都不许在 cdp.py 里再存一份字面量", () => {
    // 上一口判据只保证 dev 配置里有端口；这一口保证**探针跟着它**。
    // 两处各写一个数字早晚漂移：2026-09-24 那次 9222 被本机另一个应用占了，
    // 探针于是量了别人的窗口还报"0 违规"。
    expect(DEBUG_PORT, "dev 配置里必须带 --remote-debugging-port=<数字>").toMatch(
      /^\d+$/,
    );
    const cdp = readFileSync(resolve(ROOT, "scripts/probe/cdp.py"), "utf8");
    // 端口/出处一律从配置读：既不许 `XXX_PORT = <数字>`，也不许 `host:<数字>`
    expect(cdp).not.toMatch(/\b\w*PORT\w*\s*=\s*\d/);
    expect(cdp).not.toMatch(/:\d{4,}/);
    expect(cdp).toMatch(/_port_from_dev_conf/);
    expect(cdp).toMatch(/_dev_origin/);
  });
});
