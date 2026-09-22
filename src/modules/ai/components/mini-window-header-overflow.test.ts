/**
 * src/modules/ai/components/mini-window-header-overflow.test.ts
 * —— AI 小窗顶栏：左边那簇不许被挤，长文字那簇先让位
 *
 * 起因（2026-09-22 用户实测截图）：小窗顶栏「第 N 轮 · 工具 M」这段和右边
 * 会话标题（"切换会话"下拉）叠在了一起。
 *
 * 根因（按 CSS 布局算出来的，不是猜的）：小窗最窄 400px（miniWindowGeometry.MIN_W），
 * 旧写法把「可伸缩」的权力给了**左边**（左簇 `min-w-0`），把「绝不收缩」给了**右边**
 * （右簇 `shrink-0`）：
 *   右簇 = 会话标题（max-w-48=192px）+ 关闭按钮 20px ≈ 216px，且它不让位；
 *   左簇最小内容宽（模式徽标 + 「第 N 轮 · 工具 M」shrink-0 + 上下文圆环）≈ 190~330px；
 *   两者相加 > 400 - 24(px-3) - 8(gap)，于是浏览器把左簇按 min-w-0 继续压窄，
 *   左簇里的文字**溢出自己的盒子**（父层 overflow 可见）直接画到右簇上面 = 重叠。
 * 主窗顶栏同一类问题已经被 `min-w-max`（src/modules/header/Header.tsx:169）挡住了，
 * 小窗这一处漏了。
 *
 * 这条门禁钉住修完后的伸缩契约：左簇永远按内容宽（shrink-0，不会被压到溢出），
 * 长文字在右簇且可截断（min-w-0 + flex-1，标题先出省略号）。
 * 手法与 src/components/ui/overlay-performance.test.ts 一致：扫源码字面量，
 * 不 import 被测组件（Header 未导出，渲染它要拖一整串 store provider）。
 */
import { describe, expect, it } from "vitest";
import { MIN_W } from "../lib/miniWindowGeometry";

const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const HEADER_FILE = "/src/modules/ai/components/AiMiniWindow.tsx";

/** 取出 AiMiniWindow 源码里 `function Header(` 到下一个顶层 `function ` 之间的段。 */
function headerBlock(): string {
  const source = SOURCES[HEADER_FILE];
  expect(source, `${HEADER_FILE} 找不到了，这条门禁要同步改`).toBeTruthy();
  const start = source.indexOf("function Header(");
  expect(start, "AiMiniWindow 里的 Header 组件找不到了").toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const next = rest.search(/\nfunction /);
  return next === -1 ? rest : rest.slice(0, next);
}

/** 取出一段源码里的所有字符串字面量内容。 */
function stringLiterals(source: string): string[] {
  return [...source.matchAll(/["'`]([^"'`\n]{6,})["'`]/g)].map((m) => m[1]);
}

/** 从一段源码里挑出 className 字面量里带指定 gap 记号的那些。 */
function literalsWithGap(block: string, gap: RegExp): string[] {
  return stringLiterals(block).filter(
    (l) => l.includes("items-center") && gap.test(l),
  );
}

describe("AI 小窗顶栏的伸缩契约（400px 下不重叠）", () => {
  it("左簇按内容宽，永不被压窄（shrink-0）", () => {
    const clusters = literalsWithGap(headerBlock(), /gap-1\.5/);
    expect(clusters.length, "左簇的 className 字面量找不到了").toBe(1);
    expect(
      clusters[0],
      "左簇少了 shrink-0：它会被压窄并让里面的文字溢出盒子，画到右边会话标题上",
    ).toContain("shrink-0");
  });

  it("右簇让位：可收缩可截断，且不写 shrink-0", () => {
    const clusters = literalsWithGap(headerBlock(), /gap-1(?![.\d])/);
    expect(clusters.length, "右簇的 className 字面量找不到了").toBe(1);
    const [cluster] = clusters;
    expect(cluster, "右簇少了 min-w-0：里面的会话标题截不动").toContain(
      "min-w-0",
    );
    expect(
      cluster,
      "右簇写了 shrink-0：它绝不让位，挤压全落在左簇上 = 重叠",
    ).not.toContain("shrink-0");
  });

  it("两簇要显示的东西都还在（防止判据靠删元素通过）", () => {
    const block = headerBlock();
    expect(block).toContain("<AgentStatusPill isMiniWindow />");
    expect(block).toContain("<SessionPicker />");
    // 会话标题仍是截断渲染：右簇能收缩的前提是它自己会出省略号
    const picker = SOURCES[HEADER_FILE].slice(
      SOURCES[HEADER_FILE].indexOf("function SessionPicker("),
    );
    expect(picker.slice(0, picker.indexOf("\nfunction "))).toContain(
      'title="切换会话"',
    );
    expect(
      stringLiterals(picker).filter((l) => l === "truncate").length,
      "会话标题不再 truncate 的话，右簇就没法收缩",
    ).toBeGreaterThan(0);
  });

  it("小窗最窄宽兜得住左簇内容 + 关闭按钮（MIN_W 不许往下调）", () => {
    // 左簇最坏自然宽：模式徽标 max-w-[8rem]=128 + 圆点/图标/gap ≈ 42
    // + 「第 N 轮 · 工具 M」≈ 88 + 教学标记 ≈ 40 → ≈ 298；再加上下文圆环 ≈ 58
    // 与两个 gap ≈ 364；右簇只剩关闭按钮 20 与 px-3 两侧 24 → ≈ 408。
    // 400 这一档靠标题截断兜住，再往下调就会把左簇挤出可视区。
    expect(MIN_W, "MIN_W 低于 400 时顶栏左簇必然挤爆，要一起改判据").toBeGreaterThanOrEqual(400);
  });
});
