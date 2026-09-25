import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { traceEager } from "../../scripts/eager-graph.mjs";

// Locks the startup-bundle invariant: the heavy editor / AI / markdown stacks
// must stay out of the eager graph of both window entries so they load only
// when the user opens those surfaces. A static import that re-introduces any of
// these (e.g. a barrel re-export of chat runtime, or a `cn`-style util getting
// absorbed into a feature chunk) will fail here. xterm and motion are
// intentionally eager (terminal-first shell) and are not asserted against.
const HEAVY = ["@ai-sdk", "ai", "streamdown", "@codemirror", "@uiw"];

function heavyEagerHits(entry: string): string[] {
  const { hits } = traceEager(entry, HEAVY);
  return [...hits.entries()].map(([pkg, info]) => `${pkg} <- ${info.file}`);
}

describe("startup bundle budget", () => {
  it("main window does not eagerly pull editor/AI/markdown stacks", () => {
    expect(heavyEagerHits("src/main.tsx")).toEqual([]);
  });

  it("settings window does not eagerly pull editor/AI/markdown stacks", () => {
    expect(heavyEagerHits("src/settings/main.tsx")).toEqual([]);
  });
});

// #94 §6-B：三个侧栏面板今天**静态**躺在首屏里（梳理量出来是 21 个模块 / 114 KB 源料），
// 而本仓早就有正确做法（`ai/components/lazy.tsx` + `KnowledgePanelLazy`）——
// 这条判据只是"把自己已有的做法做完"，不是新发明。
// 用户 2026-09-25 拍板"前端梳理清楚再做优化"，梳理与启动耗时数（§9）都已交付，故开工这一条。
//
// 两条必须配对存在（缺正向就是给"整片删掉"留后门 —— #96/#89 那两条教训）：
//  ① 负向：面板文件不在 `src/main.tsx` 的 eager 图里；
//  ② 正向：懒边界那一侧仍然通向**真面板**（包装文件动态引入 barrel，barrel 再导出面板）。
const WRAPPER = "src/app/panelsLazy.tsx";
const SIDEBAR_PANELS = [
  {
    barrel: "src/modules/skills/index.ts",
    panel: "src/modules/skills/SkillsPanel.tsx",
  },
  {
    barrel: "src/modules/snippets/index.ts",
    panel: "src/modules/snippets/SnippetsPanel.tsx",
  },
  {
    barrel: "src/modules/tunnels/index.ts",
    panel: "src/modules/tunnels/TunnelPanel.tsx",
  },
];

describe("#94 §6-B 侧栏面板的懒边界", () => {
  it("主窗 eager 图里没有这三个侧栏面板", () => {
    const { files } = traceEager("src/main.tsx");
    for (const { panel } of SIDEBAR_PANELS) {
      expect(files.has(panel), `${panel} 不该静态进首屏`).toBe(false);
    }
  });

  it("懒边界那一侧仍然通向真面板（负向配正向）", () => {
    const { lazyFiles } = traceEager(WRAPPER);
    for (const { barrel, panel } of SIDEBAR_PANELS) {
      // ① 包装文件确实动态引入这个模块入口
      expect(lazyFiles.has(barrel), `${WRAPPER} 应动态引入 ${barrel}`).toBe(true);
      // ② 那个入口确实还把面板导出来 —— 少了这一条，"把面板整片删掉"也能让上面那条绿
      expect(
        traceEager(barrel).files.has(panel),
        `${barrel} 应仍再导出 ${panel}`,
      ).toBe(true);
    }
  });

  it("lazy 只有一个主人：App.tsx 从包装文件拿它们", () => {
    const app = readFileSync(join(process.cwd(), "src/app/App.tsx"), "utf8");
    expect(app).toContain('from "@/app/panelsLazy"');
  });
});
