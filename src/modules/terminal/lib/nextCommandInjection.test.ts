import { beforeEach, describe, expect, it } from "vitest";
import { recordTerminalBlock } from "@/modules/prediction/sessionBridge";
import {
  acceptNextCommand,
  cancelAutoCorrection,
  closeNextCommand,
  getNextCommandState,
  initNextCommandInjection,
  nextCommandKeyHandler,
  nextCommandShortcutInterceptor,
  openCorrection,
  openCorrectionForCommand,
  openNextCommand,
  scheduleAutoCorrection,
} from "./nextCommandInjection";

let line = "";
let written: string[] = [];
let available = new Set(["pwd", "ls"]);
let riskLevel: "L0" | "L1" | "L2" | "unknown" = "L0";
let riskSource: "rpc" | "local" = "rpc";
let env: "windows" | "linux" = "linux";
let activeLeaf: number | null = null;
let seq = 0;

function seed(leafId: number) {
  seq += 1;
  for (const command of ["pwd", "ls", "pwd", "ls", "pwd", "ls"]) {
    recordTerminalBlock({
      sessionId: leafId,
      command,
      cwd: "",
      exitCode: 0,
      durationMs: 10,
      author: "user",
      startedAt: seq * 1000 + command.length,
    });
  }
}

beforeEach(() => {
  cancelAutoCorrection();
  closeNextCommand();
  line = "";
  written = [];
  available = new Set(["pwd", "ls"]);
  riskLevel = "L0";
  riskSource = "rpc";
  env = "linux";
  activeLeaf = null;
  initNextCommandInjection({
    getLine: () => line,
    writeLine: (_leafId, nextLine) => {
      written.push(nextLine);
      line = nextLine;
      return true;
    },
    getEnvironment: () => env,
    getRustSessionId: () => 1,
    getAvailableCommands: () => available,
    getActiveLeafId: () => activeLeaf,
    evaluateRisk: async () => ({ level: riskLevel, source: riskSource }),
  });
});

describe("下一步建议显式入口", () => {
  it("空行请求 → 候选 → 接受只填入当前行，不追加换行", async () => {
    const leaf = 910;
    seed(leaf);
    await openNextCommand(leaf);
    const state = getNextCommandState();
    expect(state.visible).toBe(true);
    expect(state.candidates.length).toBeGreaterThan(0);
    expect(state.candidates[0].displayText).toBe("pwd");
    expect(state.messageZh).toBe("");

    expect(acceptNextCommand(0)).toBe(true);
    expect(written).toEqual(["pwd"]);
    expect(written[0]).not.toMatch(/[\r\n]/);
    expect(line).toBe("pwd");
    expect(getNextCommandState().visible).toBe(false);
  });

  it("输入行不为空 / Windows / 缺少可用命令时不产生候选", async () => {
    const leaf = 911;
    seed(leaf);

    line = "ls";
    await openNextCommand(leaf);
    expect(getNextCommandState().candidates).toEqual([]);
    expect(getNextCommandState().messageZh).toContain("当前输入行不为空");

    line = "";
    env = "windows";
    await openNextCommand(leaf);
    expect(getNextCommandState().candidates).toEqual([]);
    expect(getNextCommandState().messageZh).toContain("不是 Bash/SSH");

    env = "linux";
    available = new Set();
    await openNextCommand(leaf);
    expect(getNextCommandState().candidates).toEqual([]);
    expect(getNextCommandState().messageZh).toContain("缺少可用命令信息");
  });

  it("风险来源不是 rpc（本地 fallback）时按 unknown 隐藏", async () => {
    const leaf = 912;
    seed(leaf);
    riskSource = "local";
    await openNextCommand(leaf);
    expect(getNextCommandState().candidates).toEqual([]);
    expect(getNextCommandState().messageZh).toContain("未知");
  });

  it("键盘：Ctrl+Shift+Space 触发，Esc 关闭，Enter 接受", async () => {
    const leaf = 913;
    seed(leaf);
    const trigger = new KeyboardEvent("keydown", {
      key: " ",
      code: "Space",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(nextCommandKeyHandler(leaf, trigger)).toBe(false);
    await openNextCommand(leaf);

    const escape = new KeyboardEvent("keydown", { key: "Escape" });
    expect(nextCommandKeyHandler(leaf, escape)).toBe(false);
    expect(getNextCommandState().visible).toBe(false);

    await openNextCommand(leaf);
    const enter = new KeyboardEvent("keydown", { key: "Enter" });
    expect(nextCommandKeyHandler(leaf, enter)).toBe(false);
    expect(written).toEqual(["pwd"]);
  });

  it("纠错：只改一个 token、保留参数、不追加换行；半行改动后拒绝", async () => {
    const leaf = 914;
    seed(leaf);
    // 会话里已有 systemctl 才能进入纠错词表。
    recordTerminalBlock({
      sessionId: leaf,
      command: "systemctl status httpd",
      cwd: "",
      exitCode: 0,
      durationMs: 10,
      author: "user",
      startedAt: seq * 1000 + 900,
    });
    available = new Set(["pwd", "ls", "systemctl"]);
    line = "sytemctl status httpd";

    await openCorrection(leaf);
    const state = getNextCommandState();
    expect(state.task).toBe("correct");
    expect(state.candidates.length).toBe(1);
    expect(state.candidates[0].insertText).toBe("systemctl status httpd");

    // 用户改了半行 → 旧纠错不可接受。
    line = "sytemctl status httpd ";
    expect(acceptNextCommand(0)).toBe(false);
    expect(written).toEqual([]);

    line = "sytemctl status httpd";
    await openCorrection(leaf);
    expect(acceptNextCommand(0)).toBe(true);
    expect(written).toEqual(["systemctl status httpd"]);
    expect(written[0]).not.toMatch(/\r|\n/);
    expect(written[0].split(" ").slice(1)).toEqual(["status", "httpd"]);
    expect(written[0]).not.toMatch(/\bsudo\b/);
  });

  it("纠错：复杂语法与空行不产生候选", async () => {
    const leaf = 915;
    seed(leaf);
    line = "sytemctl status httpd | grep run";
    await openCorrection(leaf);
    expect(getNextCommandState().candidates).toEqual([]);
    expect(getNextCommandState().messageZh).toContain("复杂语法");

    line = "";
    await openCorrection(leaf);
    expect(getNextCommandState().candidates).toEqual([]);
    expect(getNextCommandState().messageZh).toContain("为空");
  });

  it("下一步建议：多词命令按命令名判定可用性（不整行匹配）", async () => {
    const leaf = 917;
    for (const command of ["systemctl status httpd", "systemctl status httpd"]) {
      seq += 1;
      recordTerminalBlock({
        sessionId: leaf,
        command,
        cwd: "",
        exitCode: 0,
        durationMs: 10,
        author: "user",
        startedAt: seq * 1000,
      });
    }
    available = new Set(["systemctl"]);
    await openNextCommand(leaf);
    const state = getNextCommandState();
    expect(state.candidates.map((item) => item.displayText)).toContain(
      "systemctl status httpd",
    );
  });

  it("自动纠错：输入停顿后自动弹出；正确命令与命令前缀不打扰", async () => {
    const leaf = 918;
    seed(leaf);
    seq += 1;
    recordTerminalBlock({
      sessionId: leaf,
      command: "systemctl status httpd",
      cwd: "",
      exitCode: 0,
      durationMs: 10,
      author: "user",
      startedAt: seq * 1000,
    });
    available = new Set(["pwd", "ls", "systemctl"]);
    activeLeaf = leaf;

    // 正确命令：不弹。
    line = "ls";
    scheduleAutoCorrection(leaf, 10);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(getNextCommandState().visible).toBe(false);

    // 仍在前缀输入中（syst → systemctl）：不打扰。
    line = "syst";
    scheduleAutoCorrection(leaf, 10);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(getNextCommandState().visible).toBe(false);

    // 拼错：停顿后自动弹出纠错。
    line = "sytemctl status httpd";
    scheduleAutoCorrection(leaf, 10);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(getNextCommandState().visible).toBe(true);
    expect(getNextCommandState().task).toBe("correct");
    expect(getNextCommandState().candidates[0].insertText).toBe(
      "systemctl status httpd",
    );

    // 自动弹窗同样可以 Enter 接受，只填行不执行。
    const enter = new KeyboardEvent("keydown", { key: "Enter" });
    expect(nextCommandKeyHandler(leaf, enter)).toBe(false);
    expect(written).toEqual(["systemctl status httpd"]);
    expect(written[0]).not.toMatch(/[\r\n]/);
  });

  it("失败命令纠错：命令已执行后弹窗，接受只填回修正行", async () => {
    const leaf = 919;
    seed(leaf);
    available = new Set(["pwd", "ls", "systemctl"]);
    line = "";

    await openCorrectionForCommand(leaf, "sytemctl status httpd");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const state = getNextCommandState();
    expect(state.visible).toBe(true);
    expect(state.source).toBe("block");
    expect(state.auto).toBe(true);
    expect(state.task).toBe("correct");
    expect(state.candidates[0].insertText).toBe("systemctl status httpd");

    expect(acceptNextCommand(0)).toBe(true);
    expect(written).toEqual(["systemctl status httpd"]);
    expect(line).toBe("systemctl status httpd");

    // 用户已经开始敲下一条命令：不再弹失败命令纠错。
    line = "ls ";
    await openCorrectionForCommand(leaf, "sytemctl status httpd");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(getNextCommandState().visible).toBe(false);
  });

  it("全局拦截器：不依赖 xterm 焦点，且按物理键识别 Shift+. 的字符漂移", async () => {
    const leaf = 916;
    seed(leaf);
    activeLeaf = leaf;

    // 备用组合 Ctrl+Alt+Space：IME 占用 Ctrl+Shift+Space 时的入口。
    const next = new KeyboardEvent("keydown", {
      key: " ",
      code: "Space",
      ctrlKey: true,
      altKey: true,
      bubbles: true,
      cancelable: true,
    });
    expect(nextCommandShortcutInterceptor(next)).toBe(true);
    expect(next.defaultPrevented).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getNextCommandState().visible).toBe(true);
    expect(getNextCommandState().task).toBe("next");

    // 中文键盘下 Ctrl+Shift+. 的 e.key 是 ">"；只能按物理键 code 识别。
    line = "pwd";
    const correct = new KeyboardEvent("keydown", {
      key: ">",
      code: "Period",
      ctrlKey: true,
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    expect(nextCommandShortcutInterceptor(correct)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getNextCommandState().visible).toBe(true);
    expect(getNextCommandState().task).toBe("correct");
  });
});
