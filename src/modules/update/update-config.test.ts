import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { traceEager } from "../../../scripts/eager-graph.mjs";

const repo = process.cwd();
const read = (rel: string) => readFileSync(join(repo, rel), "utf8");

const conf = JSON.parse(read("src-tauri/tauri.conf.json"));
const releaseConf = JSON.parse(read("src-tauri/tauri.release.conf.json"));

describe("更新配置的三件事必须同时成立：验签公钥、https 端点、发布产物开关的位置", () => {
  it("公钥非空且是 minisign 公钥格式（base64 'untrusted comment:'）", () => {
    const pubkey: string = conf.plugins.updater.pubkey;
    expect(pubkey.length).toBeGreaterThan(40);
    expect(pubkey.startsWith("dW50")).toBe(true);
  });

  it("端点必须 https，并指向本仓库**已发布**的 latest 资产", () => {
    const endpoints: string[] = conf.plugins.updater.endpoints;
    expect(endpoints).toHaveLength(1);
    const url = new URL(endpoints[0]);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("github.com");
    expect(url.pathname).toBe(
      "/harryopo/tdsf-terminal-agent/releases/latest/download/latest.json",
    );
  });

  it("草稿不会被客户端看到：/releases/latest/ 只解析已发布版本（这条是发布流程的安全垫）", () => {
    expect(conf.plugins.updater.endpoints[0]).toContain("/releases/latest/");
    expect(conf.plugins.updater.endpoints[0]).not.toContain("/tag/");
  });

  it("Windows 安装器要有可见进度（passive/basicUi/quiet 之外都是配错）", () => {
    expect(["passive", "basicUi", "quiet"]).toContain(
      conf.plugins.updater.windows.installMode,
    );
  });

  it("基础配置的 createUpdaterArtifacts 必须是 false", () => {
    // 否则本地 pnpm build:win 会因为没有签名私钥直接构建失败（私钥只在 CI）
    expect(conf.bundle.createUpdaterArtifacts).toBe(false);
  });

  it("发布叠加配置只改这一处，别的什么都不碰", () => {
    expect(Object.keys(releaseConf)).toEqual(["$schema", "bundle"]);
    expect(Object.keys(releaseConf.bundle)).toEqual(["createUpdaterArtifacts"]);
    expect(releaseConf.bundle.createUpdaterArtifacts).toBe(true);
  });
});

describe("更新权限只给主窗", () => {
  const cap = JSON.parse(read("src-tauri/capabilities/updater.json"));

  it("updater.json 授予主窗（含第二扇主窗），且带 updater:default", () => {
    expect(cap.windows).toEqual(["main", "main-*"]);
    expect(cap.permissions).toContain("updater:default");
  });

  it("其余 capability 一律不得把更新权限发给设置窗", () => {
    for (const f of ["default.json", "desktop.json", "clipboard.json"]) {
      const c = JSON.parse(read(`src-tauri/capabilities/${f}`));
      const grants = (c.permissions ?? []).filter((p: string) =>
        p.startsWith("updater:"),
      );
      expect(grants, f).toEqual([]);
    }
  });
});

describe("接线：实现了还得真接上（#125 那一类缺口只能靠这类断言挡住）", () => {
  const lib = read("src-tauri/src/lib.rs");

  it("Rust 侧注册了 updater 插件", () => {
    const registered = /\.plugin\(\s*tauri_plugin_updater::Builder::new\(\)\.build\(\)\s*\)/;
    expect(registered.test(lib)).toBe(true);
  });

  it("lsp_kill_all 进了 generate_handler! 名单（漏注册 = 运行时 Command not found）", () => {
    const start = lib.indexOf("generate_handler![");
    expect(start).toBeGreaterThan(-1);
    let depth = 0;
    let end = -1;
    for (let i = lib.indexOf("[", start); i < lib.length; i += 1) {
      if (lib[i] === "[") depth += 1;
      else if (lib[i] === "]") {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    expect(end).toBeGreaterThan(start);
    expect(lib.slice(start, end)).toContain("lsp::lsp_kill_all");
  });

  it("主窗入口挂了启动检查", () => {
    const main = read("src/main.tsx");
    expect(main).toContain('import("./modules/update/checkUpdate")');
    expect(main).toContain("initUpdateCheckOnBoot()");
  });

  it("状态栏真的渲染了那个小尾巴（不是只写了组件）", () => {
    const bar = read("src/modules/statusbar/StatusBar.tsx");
    expect(bar).toContain('import { UpdateChip } from "./UpdateChip"');
    expect(bar).toContain("<UpdateChip />");
  });

  it("更新插件不得进主窗的 eager 启动包 —— 同时证明那条懒边界真通向更新模块", () => {
    // 只看"不在 eager 图里"会假绿（删掉整个模块也能过），所以配一条正向：
    // 懒边界必须解析得到 checkUpdate.ts（#94 §6-B 立的那条规矩）。
    const { hits, lazyFiles } = traceEager("src/main.tsx", [
      "@tauri-apps/plugin-updater",
    ]);
    expect([...hits.keys()]).toEqual([]);
    expect(
      [...lazyFiles].some((f) => f.endsWith("modules/update/checkUpdate.ts")),
    ).toBe(true);
  });
});
