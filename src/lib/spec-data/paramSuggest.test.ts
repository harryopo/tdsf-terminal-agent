/**
 * paramSuggest.test.ts — 命令参数预测单元测试
 * -----------------------------------------------------------------------------
 * 直接构造 Fig spec 对象测试核心逻辑，不依赖 11MB specs.json（懒加载数据
 * 由构建脚本产出，构建正确性由 scripts/build-fig-specs.mjs 运行输出保证）。
 * 覆盖：
 *   - parseCommandLine：sudo 前缀跳过 / 子命令提取
 *   - suggestParams：-x 前缀匹配 options / 子命令匹配 / 参数值建议
 */
import { describe, expect, it } from "vitest";
import { parseCommandLine, suggestParams } from "./paramSuggest";
import type { FigSpec } from "./types";

describe("parseCommandLine", () => {
  it("parses plain command (解析纯命令)", () => {
    expect(parseCommandLine("lsblk")).toEqual({
      cmd: "lsblk",
      sub: undefined,
      current: "lsblk",
    });
  });

  it("skips sudo prefix (跳过 sudo 前缀)", () => {
    expect(parseCommandLine("sudo lsblk -").cmd).toBe("lsblk");
    expect(parseCommandLine("sudo lsblk -").current).toBe("-");
  });

  it("extracts subcommand (提取子命令)", () => {
    expect(parseCommandLine("apt install -").sub).toBe("install");
    expect(parseCommandLine("apt install -").current).toBe("-");
  });

  it("returns empty for blank line (空行无命令)", () => {
    expect(parseCommandLine("   ").cmd).toBeUndefined();
  });
});

describe("suggestParams", () => {
  // lsblk spec：-n/--noheadings、-o/--output（含静态参数值）
  const lsblkSpec: FigSpec = {
    name: "lsblk",
    description: "List block devices",
    options: [
      { name: "-n", description: "print no headings" },
      { name: "--noheadings", description: "print no headings" },
      { name: "-o", description: "output columns", args: { suggestions: ["NAME", "SIZE", "TYPE", "MOUNTPOINT"] } },
      { name: "-y", description: "assume yes" },
      { name: "--help", description: "show help" },
    ],
  };

  it("matches options by -x prefix (匹配 -x 前缀的 options)", () => {
    const items = suggestParams(lsblkSpec, "lsblk -", 8);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.kind === "arg")).toBe(true);
    // "-" 前缀 → 只展示以 "-" 开头的 options
    expect(items.map((i) => i.command)).toEqual(
      expect.arrayContaining(["-n", "-o", "-y", "--noheadings", "--help"]),
    );
    // 携带英文描述（弹窗右侧说明）
    expect(items.find((i) => i.command === "-n")?.description).toBe(
      "print no headings",
    );
  });

  it("filters options by longer prefix (按更长前缀过滤)", () => {
    const items = suggestParams(lsblkSpec, "lsblk --n", 8);
    expect(items.map((i) => i.command)).toEqual(["--noheadings"]);
  });

  it("matches subcommands (匹配子命令)", () => {
    const aptSpec: FigSpec = {
      name: "apt",
      options: [{ name: "-y", description: "assume yes" }],
      subcommands: [
        { name: "install", description: "Install packages" },
        { name: "remove", description: "Remove packages" },
      ],
    };
    const items = suggestParams(aptSpec, "apt i", 8);
    expect(items.map((i) => i.command)).toEqual(["install"]);
  });

  it("uses subcommand-level options (子命令级 options 优先)", () => {
    const aptSpec: FigSpec = {
      name: "apt",
      options: [{ name: "-h", description: "top help" }],
      subcommands: [
        {
          name: "install",
          options: [
            { name: "-y", description: "assume yes" },
            { name: "-n", description: "no install" },
          ],
        },
      ],
    };
    const items = suggestParams(aptSpec, "apt install -", 8);
    const names = items.map((i) => i.command);
    // 子命令 options 优先展示，但顶层通用选项（-h）也会合并
    expect(names).toEqual(expect.arrayContaining(["-y", "-n", "-h"]));
  });

  it("suggests static arg values (静态参数值建议)", () => {
    const items = suggestParams(lsblkSpec, "lsblk -o ", 8);
    expect(items.map((i) => i.command)).toEqual(
      expect.arrayContaining(["NAME", "SIZE", "TYPE"]),
    );
  });

  it("returns empty for unknown command line (空行/未知返回空)", () => {
    expect(suggestParams(lsblkSpec, "", 8)).toEqual([]);
  });
});
