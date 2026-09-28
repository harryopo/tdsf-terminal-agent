/**
 * update-install-steps.test.ts —— #166 ⑤（2026-09-28 用户实测）
 * -----------------------------------------------------------------------------
 * 用户原话：「点击确认更新，更新的时候注明要停下来当前的agent，停下来连接，
 * 然后重启更新什么的」。
 *
 * 界面那份清单（`updateFacts.INSTALL_STEPS`）与代码真正做的收尾序列
 * （`installUpdate.ts` 里 `bestEffort("…")` 那一串）必须**同序同数**。
 * 两边各写一份、各自演进，是"确认文案说三件事、代码做六件事"的来源 ——
 * 编译器看不见这种漂移（同 #119 那条跨语言超时常数的做法：读源码钉，不在测试里抄常量）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { INSTALL_STEPS } from "./updateFacts";

const read = (rel: string) =>
  readFileSync(join(process.cwd(), "src/modules/update", rel), "utf8")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\*[\s\S]*?\*\//g, "");

describe("安装清单与真实收尾序列对齐", () => {
  const code = read("installUpdate.ts");
  const steps = [...code.matchAll(/bestEffort\(\s*"([^"]+)"/g)].map((m) => m[1]);

  it("真的从 installUpdate.ts 里读到了收尾步骤（读不到就等于判据空转）", () => {
    expect(steps.length).toBeGreaterThanOrEqual(5);
    // 最后一步必须是 install，而且它不在 bestEffort 里（装完不会回到这里）
    expect(code).toMatch(/await deps\.install\(\)/);
  });

  it("界面列的每一步 = 代码做的那一步，顺序一致", () => {
    expect(INSTALL_STEPS.map((s) => s.step)).toEqual([...steps, "install"]);
  });

  it("每一句都说人话且点名对象（不许出现英文步骤名或空串）", () => {
    for (const s of INSTALL_STEPS) {
      expect(s.text.length).toBeGreaterThan(6);
      expect(s.text).not.toMatch(/[A-Za-z]{4,}/);
    }
    // 用户特别点名的两件：停 agent、停连接
    const all = INSTALL_STEPS.map((s) => s.text).join(" ");
    expect(all).toContain("任务");
    expect(all).toContain("SSH");
    expect(all).toContain("重启");
  });
});

describe("清单真的画在更新弹窗里", () => {
  it("UpdateChip 渲染 INSTALL_STEPS（实现了没接上等于没有）", () => {
    const chip = readFileSync(
      join(process.cwd(), "src/modules/statusbar/UpdateChip.tsx"),
      "utf8",
    );
    expect(chip).toContain("INSTALL_STEPS");
    expect(chip).toContain('data-testid="update-impact-list"');
    expect(chip).toMatch(/INSTALL_STEPS\.map\(/);
  });
});
