import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const outputPath = fileURLToPath(new URL("../../06-验收与演示/01-测试记录/source-fingerprint.json", import.meta.url));

function listFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

const files = ["site", "backend"].flatMap((directory) => listFiles(join(root, directory)))
  .map((path) => relative(root, path).replaceAll("\\", "/"))
  .filter((path) => !path.includes("node_modules/") && path !== ".DS_Store")
  .sort();
const entries = files.map((path) => ({
  path,
  sha256: createHash("sha256").update(readFileSync(join(root, path))).digest("hex")
}));
const aggregate = createHash("sha256");
for (const entry of entries) aggregate.update(`${entry.path}\0${entry.sha256}\n`);
const report = {
  generatedAt: new Date().toISOString(),
  algorithm: "sha256",
  root: "site/ + backend/",
  fileCount: entries.length,
  aggregateSha256: aggregate.digest("hex"),
  files: entries
};
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(`source fingerprint: ${report.aggregateSha256} (${report.fileCount} files)`);
