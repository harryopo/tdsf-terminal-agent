/**
 * build-tldr-zh.mjs — 从 tldr-pages 中文页生成静态数据（命令级 + 选项级）
 * -----------------------------------------------------------------------------
 * 数据源: tldr-pages/tldr (CC BY 4.0 内容 + MIT 代码), pages.zh/ 目录
 *   本地 clone 优先: ../opensource-reference/tldr-pages（可用环境变量 TLDR_REPO 覆盖）
 *   本地缺失的页回退 GitHub raw: https://github.com/tldr-pages/tldr
 * 页面格式（tldr 新版）:
 *   # ls
 *
 *   > 列出目录中的内容。
 *   > 更多信息：<...>
 *
 *   - 列出包含隐藏文件的所有文件：
 *
 *   `ls {{[-a|--all]}}`
 *
 * 命令级: 提取第一条连续 `> ` 行为中文描述 → TLDR_ZH: Record<命令名, 中文描述>
 * 选项级: 每个示例 = `- 说明：` 行 + 代码行；从代码行提取
 *   1) {{[...]}} 选项组（| 分隔变体，空白分隔 token，如 {{[-la|-l --all]}}）
 *   2) 占位符之外的裸选项 token（如 `git checkout -b {{分支名}}` 的 -b）
 *   短/长形式各记一条指向同一说明；组合短选项（如 -la）额外拆出单字母各一条
 *   （同例说明对组合中每个字母选项语义均成立的子集，覆盖收益大于噪声风险）。
 *   同命令同选项首例优先（首例通常是最典型用法）。
 *
 * 用法: node scripts/build-tldr-zh.mjs
 * 输出: src/lib/spec-data/generated/tldr-zh.ts          (命令级)
 *       src/lib/spec-data/generated/tldr-zh-options.ts  (选项级)
 *
 * 说明: 只覆盖 SPEC_INDEX 中存在的命令（与 Fig specs 数据源对齐），
 * 扫描 common/linux/osx 三个平台目录（windows/android 不在补全范围）；
 * 无 zh 页的命令（Fig 独有）跳过。
 * -----------------------------------------------------------------------------
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW_BASE = "https://raw.githubusercontent.com/tldr-pages/tldr/main";
const PLATFORMS = ["common", "linux", "osx"];
const CONCURRENCY = 24;
// 本地 tldr-pages clone：优先读本地（快 + 离线可用），缺失页回退网络
const TLDR_REPO =
  process.env.TLDR_REPO ?? join(ROOT, "..", "opensource-reference", "tldr-pages");
const HAS_LOCAL_REPO = existsSync(join(TLDR_REPO, "pages.zh"));

// 从 spec-index 提取命令名（index 是单行 JSON 数组格式："name":"xxx"）
const indexSrc = readFileSync(
  join(ROOT, "src/lib/spec-data/generated/spec-index.ts"),
  "utf8",
);
const names = [...indexSrc.matchAll(/"name":"([^"]+)"/g)].map((m) => m[1]);
console.log(`[tldr-zh] spec commands: ${names.length}`);
console.log(
  `[tldr-zh] local repo: ${HAS_LOCAL_REPO ? TLDR_REPO : "absent (network fallback)"}`,
);

/** 本地读取单页（按 common → linux → osx 顺序探测），无则 null */
function readLocal(name) {
  if (!HAS_LOCAL_REPO) return null;
  for (const plat of PLATFORMS) {
    try {
      return readFileSync(
        join(TLDR_REPO, "pages.zh", plat, `${name}.md`),
        "utf8",
      );
    } catch {
      // 该平台目录无此页: 尝试下一个
    }
  }
  return null;
}

/** 网络拉取单页（本地缺失时的回退路径） */
async function fetchZh(name) {
  for (const plat of PLATFORMS) {
    const url = `${RAW_BASE}/pages.zh/${plat}/${encodeURIComponent(name)}.md`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (!res.ok) continue;
      return await res.text();
    } catch {
      // 网络错误: 尝试下一个平台目录
    }
  }
  return null;
}

/** 优先本地、回退网络 */
async function loadPage(name) {
  const local = readLocal(name);
  return local !== null ? local : fetchZh(name);
}

/** 命令级: 提取第一条 `> ` 描述（跳过"更多信息"行） */
function extractDesc(text) {
  const descLines = [];
  let inQuote = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("> ")) {
      inQuote = true;
      const content = line.slice(2).trim();
      if (content.startsWith("更多信息")) break; // 尾部链接行不并入
      descLines.push(content);
    } else if (inQuote) {
      break; // 引用块结束
    }
  }
  return descLines.length > 0 ? descLines.join(" ") : null;
}

// ---- 选项级解析 ------------------------------------------------------------

/** {{[-a|--all]}} 选项组（组内容不含 ]） */
const OPT_GROUP_RE = /\{\{\[([^\]]*)\]\}\}/g;
/** 所有 {{...}} 占位符（裸 token 提取前先抹掉，含子命令组 {{[ps|container ls]}}） */
const PLACEHOLDER_RE = /\{\{[^}]*\}\}/g;
/** 合法选项 token: -x / --xxx / -xyz（组合）/ --opt=value；排除单独 `-`（如 git checkout -） */
const TOKEN_RE = /^-{1,2}[A-Za-z0-9][A-Za-z0-9+=-]*$/;
/** 多字母短组合: -la / -it → 额外拆出单字母 */
const COMBO_RE = /^-[A-Za-z0-9]{2,}$/;

/** 把一个选项 token（含组合拆分）登记进 slot（首例优先） */
function registerToken(slot, tok, desc) {
  if (!slot.has(tok)) slot.set(tok, desc);
  if (COMBO_RE.test(tok)) {
    for (const ch of tok.slice(1)) {
      const single = `-${ch}`;
      if (!slot.has(single)) slot.set(single, desc);
    }
  }
}

/** 选项级: 遍历示例，`- 说明：` 行 + 紧随代码行 → 选项映射 */
function extractOptions(text, slot) {
  let pending = null; // 最近一条 `- 说明：` 行
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("- ")) {
      // 说明行: 去掉尾部冒号（全角/半角）
      pending = line.slice(2).replace(/[：:]\s*$/, "").trim();
      continue;
    }
    if (line.length === 0 || pending === null) continue;
    if (line.startsWith("`") && line.endsWith("`")) {
      // 代码行: `cmd {{[-a|--all]}}`
      const code = line.slice(1, -1);
      // 1) {{[...]}} 选项组: | 拆变体，空白拆 token
      for (const m of code.matchAll(OPT_GROUP_RE)) {
        for (const variant of m[1].split("|")) {
          for (const tok of variant.trim().split(/\s+/)) {
            if (TOKEN_RE.test(tok)) registerToken(slot, tok, pending);
          }
        }
      }
      // 2) 占位符之外的裸选项 token
      const bare = code.replace(PLACEHOLDER_RE, " ");
      for (const tok of bare.split(/\s+/)) {
        if (TOKEN_RE.test(tok)) registerToken(slot, tok, pending);
      }
      pending = null; // 一个示例只消费一条说明
      continue;
    }
    pending = null; // 说明行后未紧跟代码块 → 丢弃，防错配
  }
}

async function main() {
  const cmdZh = {}; // 命令级
  const optZh = new Map(); // 命令名 -> Map(选项名 -> 说明)
  let done = 0;
  let miss = 0;
  const queue = [...names];
  async function worker() {
    for (;;) {
      const name = queue.shift();
      if (name === undefined) return;
      const text = await loadPage(name);
      if (text) {
        const zh = extractDesc(text);
        if (zh) cmdZh[name] = zh;
        const slot = new Map();
        extractOptions(text, slot);
        if (slot.size > 0) optZh.set(name, slot);
      } else {
        miss += 1;
      }
      done += 1;
      if (done % 100 === 0) console.log(`[tldr-zh] ${done}/${names.length}`);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  const date = new Date().toISOString().slice(0, 10);
  const outDir = join(ROOT, "src/lib/spec-data/generated");
  mkdirSync(outDir, { recursive: true });

  // 命令级输出（格式与既有 tldr-zh.ts 一致；键按命令名排序，重跑 diff 确定化）
  const sortedCmdZh = Object.fromEntries(
    Object.entries(cmdZh).sort((a, b) => a[0].localeCompare(b[0])),
  );
  const cmdCount = Object.keys(sortedCmdZh).length;
  const outCmd = `/**
 * tldr-zh.ts — 命令中文名描述（自动生成，勿手改）
 * -----------------------------------------------------------------------------
 * 数据源: tldr-pages/tldr pages.zh/ (CC BY 4.0)
 * 生成器: scripts/build-tldr-zh.mjs (${date})
 * 覆盖: ${cmdCount}/${names.length} 个 Fig spec 命令
 * -----------------------------------------------------------------------------
 */
export const TLDR_ZH: Record<string, string> = ${JSON.stringify(sortedCmdZh, null, 2)};
`;
  const cmdPath = join(outDir, "tldr-zh.ts");
  writeFileSync(cmdPath, outCmd, "utf8");

  // 选项级输出: Map → Record（外层按命令名排序便于 diff，内层保持页面出现顺序）
  const optObj = {};
  let optTotal = 0;
  for (const [cmd, slot] of [...optZh.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    optObj[cmd] = Object.fromEntries(slot);
    optTotal += slot.size;
  }
  const outOpt = `/**
 * tldr-zh-options.ts — 命令选项级中文说明（自动生成，勿手改）
 * -----------------------------------------------------------------------------
 * 数据源: tldr-pages/tldr pages.zh/ (CC BY 4.0)，本地 clone 优先、GitHub raw 回退
 * 生成器: scripts/build-tldr-zh.mjs (${date})
 * 覆盖: ${optZh.size}/${names.length} 个命令、${optTotal} 条选项说明
 * 解析: 示例行 \`- 说明：\` + 代码行 \`cmd {{[-a|--all]}}\`；{{[...]}} 选项组与
 *       裸选项 token 均提取，短/长形式各记一条（指向同一说明）；组合短选项
 *       （如 -la）额外拆出单字母各一条；同命令同选项首例优先。
 * -----------------------------------------------------------------------------
 */
export const TLDR_ZH_OPTIONS: Record<string, Record<string, string>> = ${JSON.stringify(optObj, null, 2)};
`;
  const optPath = join(outDir, "tldr-zh-options.ts");
  writeFileSync(optPath, outOpt, "utf8");

  console.log(
    `[tldr-zh] cmd: ${cmdCount} translated, ${miss} missing -> ${cmdPath}`,
  );
  console.log(
    `[tldr-zh] opt: ${optZh.size} commands, ${optTotal} options -> ${optPath}`,
  );
}

main();
