#!/usr/bin/env node
/**
 * scripts/check-secrets.mjs — 凭据进库前的闸（#169）
 *
 * 为什么要有这把：2026-09-29 第一次全历史实测发现，仓库**根提交**里那份 AI 生成的验收清单
 * 把当时的真 API Key 与一台虚机的 root 明文口令当"证据"写进了正文，之后 421 个提交都带着它，
 * 而 `main` 与三个已发布标签全部包含那个提交。当天已有的两道"审查"都结构性看不见这件事：
 *   · L3 深度审查看的是**提交的代码改动**，不看 gitignore 里的历史文档；
 *   · 09-26 那次安全复查扫的是**当前跟踪内容**（HEAD），而那份文件 09-11 就被摘出 git 了。
 * 所以这条闸只干一件事：**只看将要进库的新增行，两族形状一起查**（token 族 + 明文口令族），
 * 命中就红，且**永不打印值本身**（只给 前2字符 / 长度 / sha256 前 8 位）。
 *
 * 假阳性怎么压：本仓口径要求测试夹具里的假凭据**拼出来或用字母表跑**（红线：不许写整串真值），
 * 那类形状正好可识别（`isSynthetic`）⇒ 闸认得"这是夹具"，不必为它们开名单。
 * 真需要豁免时走 `ALLOW` 表，每条必须写理由 —— 豁免是给人看的，不是用来吞红灯的。
 *
 * 用法：
 *   node scripts/check-secrets.mjs                 # 默认：暂存区（git diff --cached）
 *   node scripts/check-secrets.mjs --staged
 *   node scripts/check-secrets.mjs --range origin/main..HEAD
 *   node scripts/check-secrets.mjs --tracked       # 扫 HEAD 的全部跟踪文件（CI 用这条）
 *   node scripts/check-secrets.mjs --range X..Y --allow-empty
 */

import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// 判据：两族形状
// ---------------------------------------------------------------------------

/** token 族：高信号，宁可严 —— 真 key 基本都是这些前缀 */
const TOKEN_RULES = [
  { id: "deepseek-or-openai-hex", re: /\bsk-[0-9a-f]{32}\b/ },
  { id: "openai-project-key", re: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/ },
  { id: "anthropic-key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: "github-token", re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { id: "github-fine-grained", re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/ },
  { id: "aws-access-key-id", re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: "stripe-key", re: /\b[sr]k_live_[A-Za-z0-9]{20,}\b/ },
  { id: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{8,}\b/ },
  { id: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { id: "url-credentials", re: /[a-z][a-z0-9+.-]*:\/\/[^\s/:@\n]+:[^\s@\n]{6,}@/i },
];

/** 明文口令族：形状弱，必须靠"排除路径/排除夹具"才不吵 */
const PASSWORD_RULES = [
  { id: "user-colon-password", re: /\b(?:root|admin|ubuntu|postgres|mysql)[:/]([A-Za-z0-9@#%*_.!+-]{8,40})/ },
  { id: "password-assignment", re: /\b(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[=:]\s*["']?([A-Za-z0-9@#%*_.!+-]{6,40})/i },
  { id: "sshpass-arg", re: /\bsshpass\s+-p\s+["']?([A-Za-z0-9@#%*_.!+-]{6,40})/ },
];

/**
 * 夹具形状：全同字符 / 字母表跑 / 连续数字 / 惯用占位词。
 * 判"像不像真的"用的是"人能不能随手编出这一串"，不是熵 —— 熵会把 `Passw0rd!` 这类
 * 弱口令放过去，而弱口令恰恰是最常见的入库形状。
 */
const SYNTHETIC_WORDS =
  /(your[_-]|example|placeholder|changeme|change[_-]me|replace|dummy|fake|sample|todo|none|null|undefined|secret[_-]?id|access[_-]?key[_-]?id|my[_-]?password|password|passwd|12345678|1234567890)/i;
const SYNTHETIC_RUNS =
  /^(?:abcdefghijklmnopqrstuvwxyz|abcdefghijklmnopqrstuvwx|abcdefghijklmnopqrstuvwxyz[0-9]+|[a-z])$/i;
const SEQUENTIAL_DIGITS = /(0123456|1234567|2345678|3456789|4567890|9876543|8765432)/;
const SAME_CHAR = /^(.)\1{5,}$/;

/** 像文件路径/目录名（`root/` 后面挂的多半是路径，不是口令） */
function looksLikePath(token) {
  return /\.[a-z0-9]{1,6}$/i.test(token) || token.includes("/") || /^[\d_.-]+$/.test(token);
}

function isSynthetic(token) {
  const t = token.replace(/^["']|["']$/g, "");
  if (!t) return true;
  if (SYNTHETIC_WORDS.test(t)) return true;
  if (SYNTHETIC_RUNS.test(t)) return true;
  if (SAME_CHAR.test(t)) return true;
  if (SEQUENTIAL_DIGITS.test(t)) return true;
  // 拼出来的假 key：形如 abcdefghijklmnop 这种纯字母长串（真 key 必含数字）
  if (/^[A-Za-z]{12,}$/.test(t)) return true;
  return false;
}

/**
 * 整段里只要**有一段**明显是手搓的跑法（字母表 / 全同字符 / 连续数字），就当夹具。
 * 为什么不能只对整段判：`sk-proj-abcdefghijklmnopqrstuvwxyz012345` 整段带前缀，
 * 直接判会漏 —— 前缀把字母表跑遮住了。本仓口径要求假凭据"拼出来或用字母表跑"，
 * 这条就是让闸认得**那个口径的产物**，而不是给它开后门。
 */
function hasSyntheticRun(value) {
  const runs = value.split(/[^A-Za-z0-9]+/).filter((r) => r.length >= 6);
  return runs.some((run) => SYNTHETIC_RUNS.test(run) || SAME_CHAR.test(run) || SEQUENTIAL_DIGITS.test(run));
}

/** 形状本身不足以定性的口令族，再要一条"像口令"的证据：同时含字母与数字，且不是路径 */
function looksLikePassword(token) {
  const t = token.replace(/^["']|["']$/g, "");
  if (!t || looksLikePath(t)) return false;
  if (isSynthetic(t) || hasSyntheticRun(t)) return false;
  return /[A-Za-z]/.test(t) && /\d/.test(t);
}

/**
 * 已经被打过码的行不是凭据 —— 没有这条，脱敏器自己的源码（替换模板
 * `"-----BEGIN PRIVATE KEY-----[REDACTED]-----END …"`）会被自己的闸报红。
 */
const REDACTION_MARKER = /\[(?:REDACTED|MASKED)|<(?:REDACTED|MASKED)|\*{4}/;

// ---------------------------------------------------------------------------
// 夹具声明：文件头一行 `secret-scan: fixture`，只准**测试形状的路径**用
//
// 为什么不是中心豁免表：豁免理由必须贴在夹具旁边（改代码的人当场看得见），
// 而中心名单会漂 —— 半年后没人知道那条为什么在里面。
// 为什么限定路径：生产文件不许自我豁免，否则这道闸等于没有（非测试路径声明了照样报）。
// ---------------------------------------------------------------------------

const SENTINEL = /secret-scan:\s*fixture(?!-line)/;
/** 行级豁免：标记写在这一行上（比整份文件声明更准，用在"与脱敏无关、只是需要一条假 key"的测试里） */
const SENTINEL_LINE = /secret-scan:\s*fixture-line/;

/**
 * 同一个标记两种作用域，只认一种写法：
 * - 写在**这一行**上 ⇒ 只豁免这一行；
 * - 写在文件头前 12 行 ⇒ 豁免整份文件（脱敏测试那种"整份都是假凭据"的文件用这个）。
 */
const TEST_SHAPED = /(^|\/)(tests?|__tests__)\/|(^|\/)test_[^/]+\.py$|[.-]test\.[cm]?[jt]sx?$|\.test\.[cm]?[jt]sx?$/;
/** @type {Map<string, {declared: boolean, head: string}>} */
const fixtureCache = new Map();

function fixtureStatus(filePath) {
  if (fixtureCache.has(filePath)) return fixtureCache.get(filePath);
  let head = "";
  try {
    // 只读盘上的文件：单测里造的是"假想路径"，盘上没有 ⇒ 按"没声明"处理（fail-closed）。
    // 不要退回去 `git show HEAD:path` —— 那会给每个假想路径打一行 fatal 到 stderr。
    head = readFileSync(filePath, "utf8").split(/\r?\n/).slice(0, 12).join("\n");
  } catch {
    head = "";
  }
  const status = { declared: SENTINEL.test(head), head, filePath };
  fixtureCache.set(filePath, status);
  return status;
}

// ---------------------------------------------------------------------------
// 扫描
// ---------------------------------------------------------------------------

/**
 * 纯函数：给一段文本 + 文件号，返回命中（值一律脱敏）。
 * `fileDeclaresSentinel` 是给单测留的注入口 —— 不传就按 filePath 去盘上读文件头，
 * 传了就不读盘（单测里造的是"假想文件路径"，盘上并没有那个文件）。
 */
export function scanText(text, { filePath = "<stdin>", startLine = 1, fileDeclaresSentinel } = {}) {
  const findings = [];
  const lines = text.split(/\r?\n/);
  const fx = fixtureStatus(filePath);
  const declared = fileDeclaresSentinel === undefined ? fx.declared : fileDeclaresSentinel;
  const exempt = declared && TEST_SHAPED.test(filePath);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    if (REDACTION_MARKER.test(line)) continue; // 打过码的行不是凭据
    const lineno = startLine + i;

    const push = (kind, ruleId, value) => {
      const maskedValue = mask(value);
      if (exempt || SENTINEL_LINE.test(line)) {
        findings.push({
          kind: "allowed",
          filePath,
          lineno,
          rule: ruleId,
          masked: maskedValue,
          why: exempt
            ? "文件头声明 secret-scan: fixture（测试形状路径，夹具本身就是要长成凭据）"
            : "行内声明 secret-scan: fixture-line",
        });
        return;
      }
      findings.push({
        kind,
        filePath,
        lineno,
        rule: ruleId,
        masked: maskedValue,
        excerpt: line.replace(value, maskedValue).slice(0, 180),
      });
    };

    for (const rule of TOKEN_RULES) {
      const m = rule.re.exec(line);
      if (!m) continue;
      if (isSynthetic(m[0]) || hasSyntheticRun(m[0])) continue;
      push(declared && !TEST_SHAPED.test(filePath) ? "sentinel-misuse" : "token", rule.id, m[0]);
    }

    for (const rule of PASSWORD_RULES) {
      const m = rule.re.exec(line);
      if (!m) continue;
      const token = m[1] || m[0];
      if (!looksLikePassword(token)) continue;
      push(declared && !TEST_SHAPED.test(filePath) ? "sentinel-misuse" : "password", rule.id, token);
    }
  }
  return findings;
}

/** 只给指纹，绝不给值 —— 这个函数是"报告本身不再制造第二次泄漏"的那条线 */
export function mask(value) {
  const digest = crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${value.slice(0, 2)}…len=${value.length} sha=${digest}`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 });
  } catch (err) {
    const out = String(err.stdout || "") + String(err.stderr || "");
    // git grep / git diff 无输出时可能非 0 退出，不算错
    return out;
  }
}

/** 取新增行：`git diff -U0` 里只认 `+` 开头且非 `+++` 的行，并带上文件与行号 */
function addedLinesFromDiff(diffText) {
  const rows = [];
  let file = null;
  let lineno = 0;
  for (const raw of diffText.split(/\r?\n/)) {
    const fileMatch = /^\+\+\+ b\/(.*)$/.exec(raw);
    if (fileMatch) {
      file = fileMatch[1];
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      lineno = Number(hunk[1]);
      continue;
    }
    if (!file) continue;
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      rows.push({ filePath: file, lineno, text: raw.slice(1) });
      lineno += 1;
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      // 删除行不占新文件行号
    } else if (raw.startsWith(" ") || raw.startsWith("\\") || raw.length === 0) {
      lineno += 1;
    }
  }
  return rows;
}

function trackedFiles() {
  return git(["ls-files", "-z"]).split("\0").filter(Boolean);
}

function main() {
  const argv = process.argv.slice(2);
  const mode = argv.includes("--tracked")
    ? "tracked"
    : argv.includes("--range")
      ? "range"
      : "staged";

  let rows = [];
  let label = "";
  if (mode === "tracked") {
    label = "跟踪文件（盘上内容；CI 里就是检出提交的内容）";
    // 读盘上的跟踪文件（CI 里盘 == 检出的那个提交，本地则能扫到还没提交的工作区内容）；
    // 逐文件 `git show` 会 fork 几千次进程，慢一个数量级
    for (const filePath of trackedFiles()) {
      let text;
      try {
        text = readFileSync(filePath, "utf8");
      } catch {
        continue; // 已删除或未落盘：跳过，diff 模式会覆盖它
      }
      if (text.includes("\u0000")) continue;
      text.split(/\r?\n/).forEach((line, idx) => {
        rows.push({ filePath, lineno: idx + 1, text: line });
      });
    }
  } else if (mode === "range") {
    const range = argv[argv.indexOf("--range") + 1];
    label = `提交范围 ${range}`;
    rows = addedLinesFromDiff(git(["diff", "-U0", range || "HEAD~1..HEAD"]));
  } else {
    label = "暂存区";
    rows = addedLinesFromDiff(git(["diff", "--cached", "-U0"]));
  }

  let hits = [];
  let exemptions = [];
  // 逐行扫：同一个文件多次命中要按 (file, rule) 聚合，否则长文档会把输出刷屏
  for (const row of rows) {
    const found = scanText(row.text, { filePath: row.filePath, startLine: row.lineno });
    for (const f of found) (f.kind === "allowed" ? exemptions : hits).push(f);
  }

  console.log(`凭据扫描 · ${label} · 读 ${rows.length} 行`);
  for (const e of exemptions) {
    console.log(`  [豁免] ${e.filePath}:${e.lineno} ${e.rule} ${e.masked} —— ${e.why}`);
  }
  if (hits.length === 0) {
    console.log("PASS：未发现凭据形状");
    return 0;
  }
  const byRule = new Map();
  for (const h of hits) {
    const key = `${h.filePath}::${h.rule}`;
    if (!byRule.has(key)) byRule.set(key, []);
    byRule.get(key).push(h);
  }
  console.log(`FAIL：${hits.length} 处凭据形状，按 文件×规则 聚合后 ${byRule.size} 组`);
  const explain = argv.includes("--explain");
  for (const [key, list] of byRule) {
    const first = list[0];
    console.log(`  ${first.filePath}  [${first.rule}]  ${list.length} 处`);
    for (const h of list.slice(0, 3)) console.log(`      行 ${h.lineno}：${h.masked}`);
    if (list.length > 3) console.log(`      …另 ${list.length - 3} 处`);
    if (explain) {
      for (const h of list.slice(0, 2)) {
        if (h.excerpt) console.log(`        上下文：${h.excerpt}`);
      }
    }
  }
  console.log("");
  console.log("处置：真凭据一律不许进库 —— 作废它、改用环境变量/密钥库，或（仅夹具）按仓里口径拼出来。");
  console.log(
    "确实是假凭据：在测试形状的路径里写 `secret-scan: fixture`（整份文件）或 `secret-scan: fixture-line`（单行）；"
  );
  console.log("豁免会照实列出，不做静默放行；非测试路径声明整份文件时，本闸直接按缺陷报（见 sentinel-misuse）。");
  return 1;
}

// Windows 下 process.argv[1] 是 `D:\…` 反斜杠路径，与 `file://` 字面拼出来的 URL 永不相等
// ⇒ 必须用 pathToFileURL 归一（否则直接跑这个脚本时 main 根本不执行）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main());
}
