/**
 * writeToSession 的返回值不许被整个丢掉 —— #166 ⑨（2026-09-28 用户实测）
 * -----------------------------------------------------------------------------
 * 用户原话：「系统检查一下交互逻辑，有 bug 的地方都修一下」。
 *
 * 为什么盯这个返回值：`writeToSession` 是唯一会说"这条路没人接"的出口
 * （`sessions.get(leafId)` 取不到、或壳已退出 ⇒ false）。开始页那一格 cold 标签页
 * 就是这种状态：它是 terminal 类型的标签页，但底下没有会话。
 * 于是 `if (isTerminalTab) { writeToSession(...); return true; }` 这种写法
 * 在开始页会**报成功、什么都不写** —— 用户看到的就是"点了没反应，也没说为什么"。
 *
 * 这条判据只钉"结果被整个丢掉"这一类（语句位置裸调一次）。
 * 两处 `setTimeout(() => writeToSession(leafId, "\r"))` 不在射程内是有意的：
 * 那是紧跟一次**已判过返回值**的写入之后的提交键，写没进去由那一轮的超时结算说话。
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (!/\.(ts|tsx)$/.test(name)) continue;
    if (/\.test\.(ts|tsx)$/.test(name)) continue;
    out.push(full);
  }
  return out;
}

describe("writeToSession 的结果必须被听见", () => {
  it("源码里没有一处把它当无返回值的写入语句用", () => {
    const root = join(process.cwd(), "src");
    const offenders: string[] = [];
    for (const file of listSourceFiles(root)) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        // 语句位置裸调用：行首（允许缩进）就是 writeToSession( 且整行以分号收尾
        if (/^\s*writeToSession\([^;]*\);\s*$/.test(line)) {
          offenders.push(`${relative(process.cwd(), file)}:${i + 1}: ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  /** 正向配对：判据要抓得到东西 —— 造一条违规行给它，必须报出来 */
  it("判据抓得住真实形状（否则上一条会因为正则写错而永远绿）", () => {
    const sample = [
      "      writeToSession(activeLeafId, cmd);",
      "        writeToSession(lid, seq);",
      "      if (!writeToSession(activeLeafId, cmd)) {",
      "      const ok = writeToSession(activeLeafId, cmd);",
      "      setTimeout(() => writeToSession(leafId, \"\\r\"), 120);",
    ];
    const hits = sample
      .map((line, i) => ({ line, i }))
      .filter(({ line }) => /^\s*writeToSession\([^;]*\);\s*$/.test(line));
    expect(hits.map((h) => h.i)).toEqual([0, 1]);
  });
});
