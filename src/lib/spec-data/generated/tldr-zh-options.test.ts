/**
 * tldr-zh-options.test.ts — 选项级中文数据完整性测试
 * -----------------------------------------------------------------------------
 * 数据由 scripts/build-tldr-zh.mjs 生成（tldr-pages pages.zh，本地 clone 优先），
 * 本测试守护生成质量：已知命令的选项说明非空 + Record 结构完整。
 * 断言选样基于 SPEC_INDEX ∩ pages.zh 实际覆盖（git-checkout 等子命令不在
 * Fig specs 顶层命令集，git 系以顶层 `git` 的裸选项 -C 为代表）。
 * -----------------------------------------------------------------------------
 */
import { describe, expect, it } from "vitest";
import { TLDR_ZH_OPTIONS } from "./tldr-zh-options";

describe("TLDR_ZH_OPTIONS 选项级中文数据", () => {
  it("已知常用命令的选项有非空中文说明（含中文）", () => {
    const cases: Array<[string, string]> = [
      ["ls", "-a"],
      ["ls", "-l"],
      ["ls", "--all"],
      ["docker", "-a"],
      ["docker", "-f"],
      ["chmod", "-R"],
      ["chown", "-h"],
      ["git", "-C"],
    ];
    for (const [cmd, opt] of cases) {
      const zh = TLDR_ZH_OPTIONS[cmd]?.[opt];
      expect(zh, `${cmd} ${opt} 应有选项级中文说明`).toBeTruthy();
      expect(zh!.length).toBeGreaterThan(0);
      expect(zh, `${cmd} ${opt} 说明应为中文`).toMatch(/[\u4e00-\u9fff]/);
    }
  });

  it("同一选项的短形式与长形式指向同一说明", () => {
    expect(TLDR_ZH_OPTIONS["ls"]?.["-a"]).toBe(TLDR_ZH_OPTIONS["ls"]?.["--all"]);
    expect(TLDR_ZH_OPTIONS["chmod"]?.["-R"]).toBe(
      TLDR_ZH_OPTIONS["chmod"]?.["--recursive"],
    );
  });

  it("组合短选项拆出单字母条目（docker -it → -i/-t）", () => {
    const itDesc = TLDR_ZH_OPTIONS["docker"]?.["-i"];
    expect(itDesc).toBeTruthy();
    expect(itDesc).toBe(TLDR_ZH_OPTIONS["docker"]?.["-t"]);
    expect(itDesc).toBe(TLDR_ZH_OPTIONS["docker"]?.["-it"]);
  });

  it("结构完整：外层命令映射到非空选项->说明 Record", () => {
    const cmds = Object.keys(TLDR_ZH_OPTIONS);
    expect(cmds.length).toBeGreaterThan(100);
    for (const [cmd, opts] of Object.entries(TLDR_ZH_OPTIONS)) {
      expect(cmd.length, "命令名非空").toBeGreaterThan(0);
      expect(Object.keys(opts).length, `${cmd} 至少 1 条选项`).toBeGreaterThan(0);
      for (const [opt, zh] of Object.entries(opts)) {
        expect(opt, "选项名含 - 前缀").toMatch(/^-{1,2}[A-Za-z0-9]/);
        expect(typeof zh).toBe("string");
        expect(zh.length, `${cmd} ${opt} 说明非空`).toBeGreaterThan(0);
      }
    }
  });

  it("无空值/占位文本污染", () => {
    for (const opts of Object.values(TLDR_ZH_OPTIONS)) {
      for (const zh of Object.values(opts)) {
        expect(zh.trim()).toBe(zh);
        expect(zh).not.toBe("undefined");
        expect(zh).not.toBe("null");
      }
    }
  });
});
