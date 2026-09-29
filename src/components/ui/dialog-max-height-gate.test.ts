// 弹窗限高的数字必须和真机门禁的阈值排好先后。
//
// 现场（#166 真机看图轮，2026-09-29）：`pnpm probe:dialog` 报
// 「弹窗高 499px = 视口 587px 的 85%（>72%，顶满窗口）」——
// 而 CSS 写的正是 `max-h-[85vh]`。**门禁说 72% 以上就是缺陷，样式却允许到 85%**，
// 两边各说各话：窗口高时内容够不到上限、门禁看起来是绿的；窗口一矮就当场报红。
// 这不是"这次窗口太小"的偶发，是两个人各存了一份阈值。
//
// 现在：四处弹窗统一收到 70vh（矮窗口里改成滚动，而不是把窗口顶满），
// 并且由这条测试钉住"CSS 的 vh 必须严格小于门禁的百分比"，
// 编译器看不见这种跨文件漂移（同 #119 那条三语言超时预算的做法）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIALOGS = [
  "src/components/ConfirmDeleteDialog.tsx",
  "src/modules/spaces/components/SpaceCreateDialog.tsx",
  "src/modules/ssh-explorer/HostApprovalDialog.tsx",
  "src/modules/ssh-explorer/SshFailureDiagnoseDialog.tsx",
];

const GATE = "scripts/probe/probe_dialog_buttons.py";

/** 门禁里那条"不许顶满"的百分比阈值（从真值文件读，不在这儿抄一份数字）。 */
function gateRatioPercent(): number {
  const src = readFileSync(join(process.cwd(), GATE), "utf8");
  const m = src.match(/ratio\s*>\s*0\.(\d{2})/);
  if (!m) throw new Error(`${GATE} 里找不到 ratio > 0.xx 这条阈值 —— 判据改名了，本测试要跟着改`);
  return Number(m[1]);
}

describe("弹窗限高与真机门禁阈值不许各说各话", () => {
  const limit = gateRatioPercent();

  for (const rel of DIALOGS) {
    it(`${rel}：限高严格低于门禁的 ${limit}%`, () => {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      const caps = [...src.matchAll(/max-h-\[(\d+)vh\]/g)].map((m) => Number(m[1]));
      expect(caps.length, "这个弹窗没有 max-h-[NNvh] —— 没限高就会顶满窗口").toBeGreaterThan(0);
      for (const vh of caps) {
        expect(vh, `max-h-[${vh}vh] 高于门禁阈值 ${limit}%`).toBeLessThan(limit);
      }
    });
  }

  it("正向配对：门禁确实在量这条（阈值读得出来，且是个合理区间的数）", () => {
    expect(limit).toBeGreaterThanOrEqual(50);
    expect(limit).toBeLessThanOrEqual(90);
  });
});
