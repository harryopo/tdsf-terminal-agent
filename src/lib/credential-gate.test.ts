// secret-scan: fixture —— 本文件的样本必须长成凭据形状（都是拼出来的假串），
// 这行是给 scripts/check-secrets.mjs 的豁免声明，不是"这里可以放真凭据"的许可。
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mask, scanText } from "../../scripts/check-secrets.mjs";

/**
 * #169 凭据闸的判据。
 *
 * 起点是 2026-09-29 的一次全历史实测：仓库**根提交**里那份 AI 生成的验收清单
 * 把当时的真 API Key 和一台虚机的 root 明文口令当"证据"写进了正文，
 * 之后 421 个提交都带着它，`main` 与三个已发布标签全含那个提交。
 * 而当时的两道审查都结构性看不见这件事 —— L3 深度审查看的是"提交的代码改动"，
 * 09-26 那次安全复查扫的是"HEAD 跟踪内容"（那文件 09-11 就摘出 git 了）。
 * 所以这条闸只干一件事：**扫将要进库的内容本身**，token 族与明文口令族一起查。
 *
 * 假凭据一律**拼出来**（口径红线：不许写整串真值），本文件也不例外。
 */

// 运行期拼出来的"真形状"：`sk-` + 32 位十六进制（DeepSeek/OpenAI 兼容 key 的格式）。
// 分成四段是为了**这个文件里不出现连续字面量** ⇒ 既不会被 GitHub 密钥扫描报，
// 也不会被这条闸自己拦下（它扫的是行内连续形状）。
const REAL_SHAPE = ["sk-", "0d3a7f5b", "9c2e8a41", "f6b5d0c3", "e7a9b1f2"].join("");

/** 假形状：按仓里口径用字母表跑出来（脱敏夹具就是这么写的） */
const FAKE_RUN = "sk-proj-abcdefghijklmnopqrstuvwxyz012345";

describe("正向标定：报红之前先证明真凭据报得出来", () => {
  it("真形状的 api key 赋值必须报（非测试路径、无豁免）", () => {
    const found = scanText(`OPENAI_API_KEY="${REAL_SHAPE}"`, {
      filePath: "src/lib/someClient.ts",
    });
    // 同一行可能被两族规则各命中一次；承重断言是"至少报一条且带规则名"，
    // 不是"恰好报几条" —— 后者会把"多加一条规则"变成假红
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((f) => f.kind === "token" || f.kind === "password")).toBe(true);
  });

  it("口令族独立于 token 族：小写赋值 + 弱口令也要报（这里没有 sk- 前缀可认）", () => {
    const found = scanText(`api_key = "Zx9!kQ2vLp7mTz4w"`, { filePath: "src/lib/someClient.ts" });
    expect(found.map((f) => f.rule)).toContain("password-assignment");
  });

  it("裸的 token 形状（没有赋值语法）也要报", () => {
    const found = scanText(`key = ${REAL_SHAPE} # 从别处抄来的`, {
      filePath: "src/lib/someClient.ts",
    });
    expect(found.some((f) => f.rule === "deepseek-or-openai-hex")).toBe(true);
  });

  it("URL 内嵌凭据与私钥块都要报", () => {
    const url = scanText(`cloneUrl = "https://user:${REAL_SHAPE}@git.example.com/x.git"`, {
      filePath: "src/lib/someClient.ts",
    });
    expect(url.some((f) => f.rule === "url-credentials")).toBe(true);
    const pem = scanText("  -----BEGIN RSA PRIVATE KEY-----", {
      filePath: "src/lib/someClient.ts",
    });
    expect(pem.some((f) => f.rule === "private-key-block")).toBe(true);
  });
});

describe("形状之外不吵：四类必须放过去", () => {
  it("按口径拼出来的假 key 不报", () => {
    expect(scanText(`secret = "${FAKE_RUN}"`, { filePath: "src/lib/x.ts" })).toEqual([]);
  });

  it("已经打过码的行不报（否则脱敏器自己的模板会被自己的闸拦下）", () => {
    const line = '        "-----BEGIN PRIVATE KEY-----[REDACTED]-----END PRIVATE KEY-----",';
    expect(scanText(line, { filePath: "src-tauri/sidecar/strands_backend/tools/x.py" })).toEqual([]);
  });

  it("`/root/` 后面挂的是路径而不是口令", () => {
    expect(scanText("ps aux > /root/proc_log.txt", { filePath: "docs/a.md" })).toEqual([]);
  });

  it("正常散文与代码不报", () => {
    expect(scanText("const password = useMemo(() => form.pw, [form.pw]);", { filePath: "src/l.ts" })).toEqual([]);
  });
});

describe("豁免只有两种写法，而且都不静默", () => {
  it("测试形状路径声明整份文件 ⇒ 记为豁免（不是消失）", () => {
    const found = scanText(`api_key="${REAL_SHAPE}"`, {
      filePath: "src/foo/bar.test.ts",
      fileDeclaresSentinel: true,
    });
    // 同一行既中 token 族又中赋值族是两条记录 —— 判据要的是"一条都没丢、且都标着豁免"
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((f) => f.kind === "allowed")).toBe(true);
  });

  it("生产路径声明豁免 ⇒ 反而报成缺陷（闸不许被自我解除）", () => {
    const found = scanText(`api_key="${REAL_SHAPE}"`, {
      filePath: "src/lib/realCode.ts",
      fileDeclaresSentinel: true,
    });
    expect(found.every((f) => f.kind === "sentinel-misuse")).toBe(true);
  });

  it("行级标记只豁免那一行，同段下一行照样报", () => {
    const text = [
      `api_key="${REAL_SHAPE}", // secret-scan: fixture-line`,
      `other_key="${REAL_SHAPE}",`,
    ].join("\n");
    const found = scanText(text, { filePath: "src/lib/x.ts" });
    const 仍报 = found.filter((f) => f.kind !== "allowed").map((f) => f.lineno);
    expect(仍报).toEqual([2]);
    expect(found.filter((f) => f.kind === "allowed").map((f) => f.lineno)).toContain(1);
  });

  it("任何豁免都带理由文字，且输出里查不到凭据本体", () => {
    const found = scanText(`api_key="${REAL_SHAPE}"`, {
      filePath: "src/foo/bar.test.ts",
      fileDeclaresSentinel: true,
    });
    expect(found[0].why).toMatch(/fixture/);
    // 这条是"报告本身不再制造第二次泄漏"的那条线
    expect(JSON.stringify(found)).not.toContain(REAL_SHAPE);
  });

  it("mask 只给前 2 字符 / 长度 / sha 前 8 位", () => {
    const shown = mask(REAL_SHAPE);
    // 形状写死，不拿 mask 自己去验 mask（那样等于什么都没断）
    expect(shown).toMatch(/^sk…len=35 sha=[0-9a-f]{8}$/);
    expect(shown).not.toContain(REAL_SHAPE.slice(2));
  });
});

describe("接线：这条闸必须真的挂在门禁与 CI 上（实现了但没接上 = 没有）", () => {
  const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

  it("package.json 里声明了 check:secrets，并且扫的是跟踪内容", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(pkg.scripts["check:secrets"]).toContain("check-secrets.mjs");
    expect(pkg.scripts["check:secrets"]).toContain("--tracked");
  });

  it("CI 的 frontend 任务里跑它，位置在 typecheck 之前", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toContain("pnpm check:secrets");
    expect(ci.indexOf("pnpm check:secrets")).toBeLessThan(ci.indexOf("pnpm typecheck"));
  });

  it("脚本本体被 .gitignore 反向放行（否则 CI 检出时压根没这个文件）", () => {
    const ignore = read(".gitignore");
    expect(ignore).toContain("!scripts/check-secrets.mjs");
    expect(ignore).toContain("!scripts/check-secrets.d.mts");
  });

  it("真跑一遍：本仓跟踪内容现在必须是干净的", () => {
    // 60 秒预算：等的是**这条闸自己扫 3000 多个跟踪文件**，不是用户在等任何东西
    const out = execFileSync("node", ["scripts/check-secrets.mjs", "--tracked"], {
      encoding: "utf8",
      timeout: 60_000,
    });
    expect(out).toContain("PASS：未发现凭据形状");
    // 这条断言是 2026-09-29 那次假绿换来的：当时我先跑 --tracked 拿到 PASS，
    // 再 git add 本文件 —— 而 --tracked 读的是 `git ls-files`，**那一刻它还不跟踪**，
    // 于是"干净"干净在了一把没扫到自己的尺子上（提交后 CI 当场红）。
    // ⇒ "PASS" 必须同时证明**带着凭据形状的判据文件自己也在扫描范围里**。
    expect(out).toContain("[豁免] src/lib/credential-gate.test.ts");
  }, 60_000);
});

describe("豁免声明的用法边界（横扫：不许有人拿它给生产代码开后门）", () => {
  const DECLARERS = [
    "src-tauri/sidecar/strands_backend/tests/test_redact.py",
    "src-tauri/sidecar/strands_backend/tests/test_redact_single_owner.py",
    "src-tauri/sidecar/strands_backend/tests/test_tools.py",
    "src/modules/ai/lib/redact.test.ts",
    "src/lib/credential-gate.test.ts",
  ];

  it.each(DECLARERS)("%s 的声明必须在文件头前 12 行，且写的是整份文件作用域", (rel) => {
    const head = readFileSync(join(process.cwd(), rel), "utf8").split(/\r?\n/).slice(0, 12).join("\n");
    expect(head).toMatch(/secret-scan:\s*fixture(?!-line)/);
    // 并且理由要说清"这不是许可"
    expect(head).toMatch(/不是|许可/);
  });
});
