/**
 * llmRetries.test.ts — #82：浏览器侧不许有第二个重试主人
 *
 * AI SDK 的 `generateText` / `streamText` 不写 `maxRetries` 时默认重试 2 次
 * （已核对 node_modules/ai 的 `prepareRetries`：只看调用点参数，provider 设置不参与），
 * 于是页面上"一次点击"在 429 时会静默连打 3 个 POST。这条扫描把
 * "每个调用点都必须显式引 `BROWSER_LLM_MAX_RETRIES`" 钉成门禁：
 * 新增调用点漏写、或就地写个魔法数字，都会当场报红。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
const CALL =
  /\b(generateText|streamText|generateObject|streamObject|embed|embedMany|generateImage)\s*\(\s*\{/g;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(full));
    } else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** 取 `fn({…})` 的实参文本（按括号配平，跳过字符串里的括号）。 */
function argsAt(text: string, openBraceIndex: number): string {
  let depth = 0;
  let quote = "";
  for (let i = openBraceIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") quote = ch;
    else if (ch === "{" || ch === "(" || ch === "[") depth += 1;
    else if (ch === "}" || ch === ")" || ch === "]") {
      depth -= 1;
      if (depth === 0) return text.slice(openBraceIndex, i + 1);
    }
  }
  return text.slice(openBraceIndex);
}

function callSites() {
  const found: { file: string; fn: string; args: string }[] = [];
  for (const file of sourceFiles(SRC)) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(CALL)) {
      const brace = (match.index ?? 0) + match[0].length - 1;
      found.push({
        file: relative(SRC, file).replace(/\\/g, "/"),
        fn: match[1],
        args: argsAt(text, brace),
      });
    }
  }
  return found;
}

describe("#82 浏览器侧 LLM 重试只有一个主人", () => {
  const sites = callSites();

  it("扫描真的抓到了调用点（扫描器自己坏掉时必须报红）", () => {
    expect(sites.length).toBeGreaterThanOrEqual(6);
  });

  it("每个调用点都显式引 BROWSER_LLM_MAX_RETRIES", () => {
    const offenders = sites
      .filter(
        (site) => !/maxRetries:\s*BROWSER_LLM_MAX_RETRIES\b/.test(site.args),
      )
      .map((site) => `${site.file} → ${site.fn}()`);
    expect(
      offenders,
      `这些 AI SDK 调用点没写 maxRetries，会吃 SDK 默认的 2 次重试（429 时一次点击打 3 个 POST）。` +
        `补上 maxRetries: BROWSER_LLM_MAX_RETRIES；确实需要别的数值就在 llmRetries.ts 里加一个具名常量。`,
    ).toEqual([]);
  });

  it("不许就地写魔法数字绕过常量", () => {
    const offenders = sites
      .filter((site) => /maxRetries:\s*\d/.test(site.args))
      .map((site) => `${site.file} → ${site.fn}()`);
    expect(offenders).toEqual([]);
  });
});
