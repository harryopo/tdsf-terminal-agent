// One-way seed of the dev app data dir from the installed release app's data dir.
//
// The dev build runs under `com.tdsf.terminal-agent.dev` (see
// src-tauri/tauri.dev.conf.json) so it has its own stores — otherwise dev and
// release overwrite each other's `tdsf-spaces.json` etc. on every autosave.
// An empty dev profile has no LLM provider configured, so this copies the
// release JSON stores across once to make dev usable.
//
// Invariants: release -> dev only, never the reverse; existing dev files are
// skipped (no overwrite, no delete); the release dir is only ever read.
import { copyFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const RELEASE_ID = "com.tdsf.terminal-agent";
const DEV_ID = "com.tdsf.terminal-agent.dev";
const MARKER = ".tdsf-dev-seed.json";

function appDataDir(identifier) {
  switch (platform()) {
    case "win32":
      return join(process.env.APPDATA ?? "", identifier);
    case "darwin":
      return join(homedir(), "Library", "Application Support", identifier);
    default:
      return join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share"), identifier);
  }
}

export function planSeed(releaseDir, devDir) {
  if (!existsSync(releaseDir)) return [];
  return readdirSync(releaseDir)
    .filter((name) => name.endsWith(".json"))
    .filter((name) => !existsSync(join(devDir, name)))
    .sort();
}

export function seed(releaseDir, devDir, log = console.log) {
  if (!existsSync(releaseDir)) {
    log(`[dev-seed] 未找到发布版数据目录 ${releaseDir}，跳过（dev 用空白配置启动）`);
    return [];
  }
  mkdirSync(devDir, { recursive: true });

  const markerPath = join(devDir, MARKER);
  if (existsSync(markerPath)) {
    log(`[dev-seed] 已引导过（${markerPath}），不再复制；如需重来请先删除该标记文件`);
    return [];
  }

  const copied = planSeed(releaseDir, devDir);
  for (const name of copied) {
    copyFileSync(join(releaseDir, name), join(devDir, name));
  }
  writeFileSync(
    markerPath,
    JSON.stringify({ seededAt: new Date().toISOString(), from: releaseDir, copied }, null, 2),
  );
  log(`[dev-seed] 从发布版复制 ${copied.length} 个配置到 dev 目录（单向、不覆盖）：${copied.join(", ") || "无"}`);
  log(`[dev-seed] dev 数据目录：${devDir}`);
  return copied;
}

const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  seed(appDataDir(RELEASE_ID), appDataDir(DEV_ID));
}
