#!/usr/bin/env node
// 校验 README 里的内部锚点（#xxx）能不能对上本文件的标题。
// GitHub 的锚点规则：小写、去标点（含全角括号/顿号）、空格转连字符。
// 中英分两页之后，跨页链接（README.md / README.en.md）也要能落到真实文件。
import { readFileSync, existsSync } from "node:fs";

const slug = (text) =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "") // 去标点，保留字母/数字/空白/连字符
    .replace(/\s+/g, "-");

let bad = 0;
for (const file of ["README.md", "README.en.md"]) {
  const src = readFileSync(file, "utf8");
  const anchors = new Set(
    [...src.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => slug(m[1])),
  );
  for (const m of src.matchAll(/\]\(([^)\s]+)\)/g)) {
    const href = m[1];
    if (/^https?:/.test(href)) continue;
    const [path, frag] = href.split("#");
    if (path && !existsSync(path)) {
      console.log(`✗ ${file}: 文件不存在 → ${href}`);
      bad++;
      continue;
    }
    if (!frag) continue;
    const target = path ? readFileSync(path, "utf8") : src;
    const pool = path
      ? new Set([...target.matchAll(/^#{1,6}\s+(.+)$/gm)].map((x) => slug(x[1])))
      : anchors;
    if (!pool.has(frag)) {
      console.log(`✗ ${file}: 锚点落空 → ${href}（要找 "${frag}"）`);
      bad++;
    }
  }
}
console.log(bad === 0 ? "OK  两页 README 的内部链接与锚点全部落到位" : `FAIL  ${bad} 处`);
process.exit(bad === 0 ? 0 : 1);
