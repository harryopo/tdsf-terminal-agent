// 运行日志级别筛选：标签中文，而传给 sidecar 的值一个字都不许改。
//
// 缺陷现场（#166 看图轮续，2026-09-29 横扫设置窗十格）：控制栏最左那只下拉画着 `ALL`，
// 点开是 ALL/DEBUG/INFO/WARNING+/ERROR/CRITICAL —— 设置窗里唯一一处纯英文**控件标签**
// （⑦ 那一族：技能/片段/隧道都中文化过，这格漏了）。
// 反面也要钉住：这些串是 sidecar `log.tail` 的 `level_filter` 参数值，
// **把值一起翻成中文会当场筛不出日志** ⇒ 两头都测。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LEVEL_FILTER_LABEL, LEVEL_FILTERS } from "./runtimeLogLevels";

const CJK = /[一-鿿]/;

describe("运行日志级别筛选", () => {
  it("每个档位都有中文标签（不许直接拿协议串当界面词）", () => {
    for (const v of LEVEL_FILTERS) {
      const label = LEVEL_FILTER_LABEL[v];
      expect(label, `档位 ${v} 没有标签`).toBeTruthy();
      expect(CJK.test(label), `档位 ${v} 的标签「${label}」没有中文`).toBe(true);
      expect(label).not.toBe(v);
    }
  });

  it("协议值一字不改：仍是 sidecar 认的那六个串（不许被顺手翻译）", () => {
    expect([...LEVEL_FILTERS]).toEqual([
      "ALL",
      "DEBUG",
      "INFO",
      "WARNING+",
      "ERROR",
      "CRITICAL",
    ]);
  });

  it("接线：面板渲染的是标签而不是裸值（只验名字出现过不算接上）", () => {
    const src = readFileSync(
      join(process.cwd(), "src/settings/sections/RuntimeLogsSection.tsx"),
      "utf8",
    );
    expect(src).toMatch(
      /import \{ LEVEL_FILTER_LABEL, LEVEL_FILTERS \} from "\.\.\/lib\/runtimeLogLevels"/,
    );
    expect(src).toMatch(
      /<SelectItem key=\{lv\} value=\{lv\}>\s*\{LEVEL_FILTER_LABEL\[lv\]/,
    );
  });
});
