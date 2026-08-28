/**
 * build-tldr-zh.mjs — 从 tldr-pages 拉取中文命令描述生成静态数据
 * -----------------------------------------------------------------------------
 * 数据源: tldr-pages/tldr (CC BY 4.0 内容 + MIT 代码), pages.zh/ 目录
 *   https://github.com/tldr-pages/tldr
 * 每页格式:
 *   # ls
 *
 *   > 列出目录中的内容。
 *   > 更多信息：<...>
 *
 * 提取第一条连续 `> ` 行为中文描述（去尾句号可选，保留原文）。
 *
 * 用法: node scripts/build-tldr-zh.mjs
 * 输出: src/lib/spec-data/generated/tldr-zh.ts (Record<命令名, 中文描述>)
 *
 * 说明: 只拉 SPEC_INDEX 中存在的命令（与 Fig specs 数据源对齐），
 * 覆盖 common/linux/osx 三个平台目录；404 的命令（Fig 独有）跳过。
 * -----------------------------------------------------------------------------
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW_BASE = "https://raw.githubusercontent.com/tldr-pages/tldr/main";
const PLATFORMS = ["common", "linux", "osx"];
const CONCURRENCY = 24;

// 从 spec-index 提取命令名（index 是单行 JSON 数组格式："name":"xxx"）
const indexSrc = readFileSync(
  join(ROOT, "src/lib/spec-data/generated/spec-index.ts"),
  "utf8",
);
const names = [...indexSrc.matchAll(/"name":"([^"]+)"/g)].map((m) => m[1]);
console.log(`[tldr-zh] spec commands: ${names.length}`);

/** 拉取单页并提取第一条 `> ` 描述 */
async function fetchZh(name) {
  for (const plat of PLATFORMS) {
    const url = `${RAW_BASE}/pages.zh/${plat}/${encodeURIComponent(name)}.md`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      const text = await res.text();
      // 描述 = 第一段连续的 `> ` 行（跳过"更多信息"行）
      const lines = text.split("\n");
      const descLines = [];
      let inQuote = false;
      for (const line of lines) {
        if (line.startsWith("> ")) {
          inQuote = true;
          const content = line.slice(2).trim();
          if (content.startsWith("更多信息")) break; // 尾部链接行不并入
          descLines.push(content);
        } else if (inQuote) {
          break; // 引用块结束
        }
      }
      if (descLines.length > 0) return descLines.join(" ");
    } catch {
      // 网络错误: 尝试下一个平台目录
    }
  }
  return null;
}

async function main() {
  const result = {};
  let done = 0;
  let miss = 0;
  const queue = [...names];
  async function worker() {
    for (;;) {
      const name = queue.shift();
      if (name === undefined) return;
      const zh = await fetchZh(name);
      if (zh) result[name] = zh;
      else miss += 1;
      done += 1;
      if (done % 100 === 0) console.log(`[tldr-zh] ${done}/${names.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const out = `/**
 * tldr-zh.ts — 命令中文名描述（自动生成，勿手改）
 * -----------------------------------------------------------------------------
 * 数据源: tldr-pages/tldr pages.zh/ (CC BY 4.0)
 * 生成器: scripts/build-tldr-zh.mjs (${new Date().toISOString().slice(0, 10)})
 * 覆盖: ${Object.keys(result).length}/${names.length} 个 Fig spec 命令
 * -----------------------------------------------------------------------------
 */
export const TLDR_ZH: Record<string, string> = ${JSON.stringify(result, null, 2)};
`;
  const outPath = join(ROOT, "src/lib/spec-data/generated/tldr-zh.ts");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, out, "utf8");
  console.log(
    `[tldr-zh] done: ${Object.keys(result).length} translated, ${miss} missing -> ${outPath}`,
  );
}

main();
