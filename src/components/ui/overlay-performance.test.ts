/**
 * src/components/ui/overlay-performance.test.ts —— 全屏遮罩不许带 backdrop-blur / 缩放动画
 *
 * 起因（2026-09-21 用户实测）：点「新建工作区」弹窗"卡卡的、帧率挺低"。
 * 真机 CDP 量出来的因果（每格都是当场实测，1000ms 开窗期 rAF 帧数 / 单帧最长间隔）：
 *   原样（整屏模糊 + zoom-in-95）  76 帧 / 最长 178ms
 *   只去模糊                      160 帧 / 最长 170ms
 *   只去缩放动画                  182 帧 / 最长 143ms
 *   两个都去                      238 帧 / 最长  15ms   ← 与静置同速
 * 根因是发布配置带 `--disable-gpu`（2026-08-30 的黑屏缓解，实测确实进了
 * `msedgewebview2.exe` 命令行）→ WebView2 走软件合成：整屏 `backdrop-filter` 在任何
 * 一次重绘时都要重新光栅，缩放动画则让 `shadow-xl + rounded-4xl + ring` 整层逐帧重画。
 * 145~180ms 的单帧就是用户嘴里那一下"卡"。
 *
 * 这条测试关掉整类问题：任何一处 `fixed inset-0` + `backdrop-blur` 的组合都当场红。
 */
import { describe, expect, it } from "vitest";

// 与 `src/lib/tauri-command-registry.test.ts` 同一手法：扫源码文本，不 import 被测模块。
const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

/** 取出源码里所有字符串字面量的内容（className 都写在引号/反引号里）。 */
function stringLiterals(source: string): string[] {
  return [...source.matchAll(/["'`]([^"'`\n]{6,})["'`]/g)].map((m) => m[1]);
}

/** 命中"整屏 + 模糊"的 className 字面量。 */
function fullScreenBlurLiterals(): { file: string; literal: string }[] {
  const hits: { file: string; literal: string }[] = [];
  for (const [file, source] of Object.entries(SOURCES)) {
    for (const literal of stringLiterals(source)) {
      if (literal.includes("fixed inset-0") && literal.includes("backdrop-blur")) {
        hits.push({ file, literal });
      }
    }
  }
  return hits;
}

describe("整屏遮罩的合成代价（--disable-gpu 下软件光栅）", () => {
  it("全仓没有任何元素同时写 fixed inset-0 与 backdrop-blur", () => {
    const hits = fullScreenBlurLiterals();
    expect(
      hits.map((h) => `${h.file}: ${h.literal.slice(0, 80)}`),
      "整屏 backdrop-filter 在软件合成下每次重绘都要重新光栅，实测让弹窗掉到 76 帧/秒",
    ).toEqual([]);
  });

  it("三个共享遮罩原语都还在（防止有人把判据整条删掉）", () => {
    const overlays = [
      "/src/components/ui/dialog.tsx",
      "/src/components/ui/alert-dialog.tsx",
      "/src/components/ui/sheet.tsx",
    ];
    for (const p of overlays) {
      const source = SOURCES[p];
      expect(source, `${p} 找不到了，这条门禁要同步改`).toBeTruthy();
      expect(source).toContain("fixed inset-0");
    }
  });

  it("dialog 内容层只做淡入，不做缩放（zoom-in-95 会让阴影层逐帧重光栅）", () => {
    const source = SOURCES["/src/components/ui/dialog.tsx"];
    const content = stringLiterals(source).filter((l) => l.includes("data-open:animate-in"));
    expect(content.length, "dialog 内容层的动画类名字面量找不到了").toBeGreaterThan(0);
    for (const literal of content) {
      expect(literal).not.toContain("zoom-in-");
      expect(literal).not.toContain("zoom-out-");
    }
  });
});
