import { beforeEach, describe, expect, it } from "vitest";
import {
  recordTerminalBlock,
  rotateLeafPrediction,
} from "@/modules/prediction/sessionBridge";
import {
  acceptNextCommand,
  cancelAutoCorrection,
  closeNextCommand,
  getNextCommandState,
  handleAutoCorrectionInput,
  handleLeafInvalidated,
  initNextCommandInjection,
  nextCommandKeyHandler,
  nextCommandShortcutInterceptor,
  openCorrection,
  openCorrectionForCommand,
  openNextCommand,
  requestMoreCorrection,
  scheduleAutoCorrection,
  shouldOfferBlockCorrection,
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
    getAvailableCommands: (_leafId, _rustSessionId) => available,
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

  it("首包样例：grpe -n error app.log → grep，参数与顺序不变", async () => {
    const leaf = 920;
    seed(leaf);
    available = new Set(["pwd", "ls", "grep"]);
    line = "grpe -n error app.log";

    await openCorrection(leaf);
    const state = getNextCommandState();
    expect(state.task).toBe("correct");
    expect(state.candidates[0].insertText).toBe("grep -n error app.log");
    expect(acceptNextCommand(0)).toBe(true);
    expect(written).toEqual(["grep -n error app.log"]);
    expect(written[0]).not.toMatch(/[\r\n]/);
  });

  it("已经可用的自定义命令不改写", async () => {
    const leaf = 921;
    seed(leaf);
    available = new Set(["pwd", "ls", "mycmd"]);
    line = "mycmd --flag";

    await openCorrection(leaf);
    expect(getNextCommandState().candidates).toEqual([]);
    expect(written).toEqual([]);
  });

  it("纠错候选允许 L2（仅回填，不执行），L0/L1 之外不再全隐藏", async () => {
    const leaf = 928;
    seed(leaf);
    available = new Set(["pwd", "ls", "systemctl"]);
    line = "sytemctl status httpd";
    riskLevel = "L2";

    await openCorrection(leaf);
    const state = getNextCommandState();
    expect(state.visible).toBe(true);
    expect(state.candidates.length).toBe(1);
    expect(state.candidates[0].insertText).toBe("systemctl status httpd");
    expect(state.candidates[0].risk).toBe("L2");
  });

  it("多解候选列出，不自动挑选", async () => {
    const leaf = 922;
    seed(leaf);
    available = new Set(["pwd", "ls", "cat", "cut"]);
    line = "cot data.csv";

    await openCorrection(leaf);
    const texts = getNextCommandState().candidates.map((item) => item.insertText);
    expect(texts).toContain("cat data.csv");
    expect(texts).toContain("cut data.csv");
    expect(written).toEqual([]);
  });

  it("切到另一个终端 leaf 后，旧候选不能由新 leaf 接受", async () => {
    const leaf = 923;
    seed(leaf);
    available = new Set(["pwd", "ls", "systemctl"]);
    line = "sytemctl status httpd";

    await openCorrection(leaf);
    expect(getNextCommandState().visible).toBe(true);

    const otherLeaf = 924;
    const enter = new KeyboardEvent("keydown", { key: "Enter" });
    expect(nextCommandKeyHandler(otherLeaf, enter)).toBe(true);
    expect(written).toEqual([]);
    // CORR-02 C1：面板属于旧 leaf，用户切到新终端后按键路径必须让它失效。
    expect(getNextCommandState().visible).toBe(false);
  });

  it("取消后旧候选不能接受", async () => {
    const leaf = 925;
    seed(leaf);
    available = new Set(["pwd", "ls", "systemctl"]);
    line = "sytemctl status httpd";

    await openCorrection(leaf);
    expect(getNextCommandState().visible).toBe(true);
    closeNextCommand();
    expect(acceptNextCommand(0)).toBe(false);
    expect(written).toEqual([]);
  });

  it("重连（rotateLeafPrediction）后旧候选不能接受", async () => {
    const leaf = 927;
    seed(leaf);
    available = new Set(["pwd", "ls", "systemctl"]);
    line = "sytemctl status httpd";

    await openCorrection(leaf);
    expect(getNextCommandState().visible).toBe(true);

    rotateLeafPrediction(leaf);
    expect(acceptNextCommand(0)).toBe(false);
    expect(written).toEqual([]);
  });

  it("回车等控制键取消尚未触发的自动纠错", async () => {
    const leaf = 926;
    seed(leaf);
    available = new Set(["pwd", "ls", "systemctl"]);
    activeLeaf = leaf;
    line = "sytemctl status httpd";

    scheduleAutoCorrection(leaf, 10);
    handleAutoCorrectionInput(leaf, "\r");
    await new Promise((resolve) => setTimeout(resolve, 50));
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

// CORR-02 C1：关闭/取消/上下文变化必须让在飞请求失效；任何 await 之后写状态
// 前都要复核请求代次与真实 owner（ROOT 反例：词表返回后 popup 再次 visible）。
describe("CORR-02 C1 在飞请求失效", () => {
  type Deps = Parameters<typeof initNextCommandInjection>[0];

  function baseDeps(): Deps {
    return {
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
    };
  }

  it("词表在飞时关闭 → 迟到返回不得重开面板", async () => {
    const leaf = 9401;
    seed(leaf);
    available = new Set(["pwd", "ls", "systemctl"]);
    line = "sytemctl status httpd";
    let resolveVocab: (value: Set<string>) => void = () => {};
    initNextCommandInjection({
      ...baseDeps(),
      getAvailableCommands: () => null,
      ensureAvailableCommands: () =>
        new Promise<Set<string>>((resolve) => {
          resolveVocab = resolve;
        }),
    });

    const pending = openCorrection(leaf);
    closeNextCommand();
    resolveVocab(new Set(["pwd", "ls", "systemctl"]));
    await pending;

    expect(getNextCommandState().visible).toBe(false);
    expect(written).toEqual([]);
  });

  it("分屏焦点已经改变时，点击旧候选不会写入原分屏", async () => {
    const leaf = 9411;
    seed(leaf);
    activeLeaf = leaf;
    available = new Set(["pwd", "ls", "grep"]);
    await openCorrectionForCommand(leaf, "grpe sample");
    expect(getNextCommandState().candidates).toHaveLength(1);

    activeLeaf = leaf + 1;
    expect(acceptNextCommand(0)).toBe(false);
    expect(written).toEqual([]);
  });

  it("查词期间输入并清空下一行后，不补弹旧命令反馈", async () => {
    const leaf = 9413;
    seed(leaf);
    activeLeaf = leaf;
    let lineVersion = 1;
    let resolveVocab: (value: Set<string>) => void = () => {};
    initNextCommandInjection({
      ...baseDeps(),
      getLineState: () => "known-empty",
      getLineVersion: () => lineVersion,
      getAvailableCommands: () => null,
      ensureAvailableCommands: () =>
        new Promise<Set<string>>((resolve) => { resolveVocab = resolve; }),
    });

    const pending = openCorrectionForCommand(leaf, "llll");
    lineVersion += 2;
    resolveVocab(new Set());
    await pending;

    expect(getNextCommandState().visible).toBe(false);
  });

  it("风险计算在飞时关闭 → 迟到结果不得重开面板", async () => {
    const leaf = 9402;
    seed(leaf);
    available = new Set(["pwd", "ls", "systemctl"]);
    line = "sytemctl status httpd";
    let resolveRisk: (value: { level: "L0"; source: "rpc" }) => void = () => {};
    initNextCommandInjection({
      ...baseDeps(),
      evaluateRisk: () =>
        new Promise((resolve) => {
          resolveRisk = resolve;
        }),
    });

    const pending = openCorrection(leaf);
    closeNextCommand();
    resolveRisk({ level: "L0", source: "rpc" });
    await pending;

    expect(getNextCommandState().visible).toBe(false);
    expect(written).toEqual([]);
  });

  it("连接代次变化（重连）→ 迟到结果作废", async () => {
    const leaf = 9403;
    seed(leaf);
    available = new Set(["pwd", "ls", "systemctl"]);
    line = "sytemctl status httpd";
    let sessionId = 1;
    let resolveVocab: (value: Set<string>) => void = () => {};
    initNextCommandInjection({
      ...baseDeps(),
      getRustSessionId: () => sessionId,
      getAvailableCommands: () => null,
      ensureAvailableCommands: () =>
        new Promise<Set<string>>((resolve) => {
          resolveVocab = resolve;
        }),
    });

    const pending = openCorrection(leaf);
    sessionId = 2;
    resolveVocab(new Set(["pwd", "ls", "systemctl"]));
    await pending;

    expect(getNextCommandState().visible).toBe(false);
  });

  it("上下文切换（env 变化）→ 迟到结果作废", async () => {
    const leaf = 9404;
    seed(leaf);
    available = new Set(["pwd", "ls", "systemctl"]);
    line = "sytemctl status httpd";
    let resolveRisk: (value: { level: "L0"; source: "rpc" }) => void = () => {};
    initNextCommandInjection({
      ...baseDeps(),
      evaluateRisk: () =>
        new Promise((resolve) => {
          resolveRisk = resolve;
        }),
    });

    const pending = openCorrection(leaf);
    env = "windows";
    resolveRisk({ level: "L0", source: "rpc" });
    await pending;

    expect(getNextCommandState().visible).toBe(false);
  });

  it("L2 纠错候选允许回填（只回填，不执行）", async () => {
    const leaf = 9405;
    seed(leaf);
    available = new Set(["pwd", "ls", "systemctl"]);
    riskLevel = "L2";
    line = "sytemctl status httpd";

    await openCorrection(leaf);
    expect(getNextCommandState().candidates[0]?.risk).toBe("L2");
    expect(acceptNextCommand(0)).toBe(true);
    expect(written).toEqual(["systemctl status httpd"]);
    expect(written[0]).not.toMatch(/[\r\n]/);
  });

  it("leaf 销毁/重建使在飞请求与面板同时失效", async () => {
    const leaf = 9406;
    seed(leaf);
    available = new Set(["pwd", "ls", "systemctl"]);
    line = "sytemctl status httpd";
    let resolveRisk: (value: { level: "L0"; source: "rpc" }) => void = () => {};
    initNextCommandInjection({
      ...baseDeps(),
      evaluateRisk: () =>
        new Promise((resolve) => {
          resolveRisk = resolve;
        }),
    });

    const pending = openCorrection(leaf);
    expect(getNextCommandState().visible).toBe(true);
    handleLeafInvalidated(leaf);
    expect(getNextCommandState().visible).toBe(false);
    resolveRisk({ level: "L0", source: "rpc" });
    await pending;
    expect(getNextCommandState().visible).toBe(false);
    expect(written).toEqual([]);
  });
});

// CORR-02 C3：失败命令纠错只对“完整单一简单命令”成立；片段/复合行不弹窗。
describe("CORR-02 C3 失败纠错门禁", () => {
  const base = {
    author: "user" as const,
    exitCode: 127,
    command: "grpe -n error app.log",
    commandComplete: true,
  };

  it("只有 user + 127 + 非空 + 完整标记才允许弹窗", () => {
    expect(shouldOfferBlockCorrection(base)).toBe(true);
    expect(
      shouldOfferBlockCorrection({ ...base, author: "agent" }),
    ).toBe(false);
    expect(shouldOfferBlockCorrection({ ...base, exitCode: 1 })).toBe(false);
    expect(shouldOfferBlockCorrection({ ...base, command: "   " })).toBe(false);
    expect(
      shouldOfferBlockCorrection({ ...base, commandComplete: false }),
    ).toBe(false);
    // 旧 shell 没有完整性证据 → 保守不弹（可在新 tab 装载新 rcfile 后恢复）。
    expect(
      shouldOfferBlockCorrection({ ...base, commandComplete: undefined }),
    ).toBe(false);
  });

  it("未知/已有内容的输入行不弹失败命令纠错；已知空行才弹", async () => {
    const leaf = 9501;
    seed(leaf);
    available = new Set(["pwd", "ls", "systemctl"]);
    let lineState: "known-empty" | "known-text" | "unknown" = "unknown";
    line = "";
    initNextCommandInjection({
      getLine: () => line,
      writeLine: (_leafId, nextLine) => {
        written.push(nextLine);
        line = nextLine;
        return true;
      },
      getEnvironment: () => "linux",
      getRustSessionId: () => 1,
      getAvailableCommands: () => available,
      getActiveLeafId: () => leaf,
      evaluateRisk: async () => ({ level: "L0", source: "rpc" }),
      getLineState: () => lineState,
      getLineVersion: () => 0,
      getScopeToken: () => "linux|1|1",
    });

    await openCorrectionForCommand(leaf, "sytemctl status httpd");
    expect(getNextCommandState().visible).toBe(false);

    lineState = "known-text";
    line = "ls";
    await openCorrectionForCommand(leaf, "sytemctl status httpd");
    expect(getNextCommandState().visible).toBe(false);
    line = "";

    lineState = "known-empty";
    await openCorrectionForCommand(leaf, "sytemctl status httpd");
    expect(getNextCommandState().visible).toBe(true);
    expect(getNextCommandState().source).toBe("block");
    expect(acceptNextCommand(0)).toBe(true);
    expect(written).toEqual(["systemctl status httpd"]);
  });

  it("已切到别的终端 leaf 时不弹旧终端的失败纠错", async () => {
    const leaf = 9502;
    seed(leaf);
    available = new Set(["pwd", "ls", "systemctl"]);
    line = "";
    initNextCommandInjection({
      getLine: () => line,
      writeLine: (_leafId, nextLine) => {
        written.push(nextLine);
        line = nextLine;
        return true;
      },
      getEnvironment: () => "linux",
      getRustSessionId: () => 1,
      getAvailableCommands: () => available,
      getActiveLeafId: () => 9503,
      evaluateRisk: async () => ({ level: "L0", source: "rpc" }),
      getLineState: () => "known-empty",
      getLineVersion: () => 0,
      getScopeToken: () => "linux|1|1",
    });

    await openCorrectionForCommand(leaf, "sytemctl status httpd");
    expect(getNextCommandState().visible).toBe(false);
    expect(written).toEqual([]);
  });
});

// CORR-03 P1（ROOT v1.2 第二步）：127 失败命令在“可信但零候选”时必须给一次
// 简短准确的反馈，而不是完全静默；同时不得吞键、不得回填、不得打扰新输入。
describe("CORR-03 P1 失败命令零候选反馈", () => {
  it("可信失败但无词形 → 空候选说明面板，且不可回填", async () => {
    const leaf = 9601;
    seed(leaf);
    available = new Set(["pwd", "ls"]);
    line = "";

    await openCorrectionForCommand(leaf, "llll", { blockId: "blk-1" });
    const state = getNextCommandState();
    expect(state.visible).toBe(true);
    expect(state.source).toBe("block");
    expect(state.task).toBe("correct");
    expect(state.candidates).toEqual([]);
    expect(state.messageZh).toContain("未找到");
    expect(acceptNextCommand(0)).toBe(false);
    expect(written).toEqual([]);
  });

  it("同一 block 只提示一次；关闭后不晚弹，新 block 可再次提示", async () => {
    const leaf = 9602;
    seed(leaf);
    available = new Set(["pwd", "ls"]);
    line = "";

    await openCorrectionForCommand(leaf, "llll", { blockId: "blk-2" });
    expect(getNextCommandState().visible).toBe(true);
    closeNextCommand();
    expect(getNextCommandState().visible).toBe(false);

    await openCorrectionForCommand(leaf, "llll", { blockId: "blk-2" });
    expect(getNextCommandState().visible).toBe(false);

    await openCorrectionForCommand(leaf, "llll", { blockId: "blk-3" });
    expect(getNextCommandState().visible).toBe(true);
  });

  it("行内停顿自动检测零候选仍保持静默", async () => {
    const leaf = 9603;
    seed(leaf);
    available = new Set(["pwd", "ls"]);
    activeLeaf = leaf;
    line = "llll";

    scheduleAutoCorrection(leaf, 10);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(getNextCommandState().visible).toBe(false);
  });

  it("词表不可用与风险未确认给不同原因，不说成“命令不存在”", async () => {
    const leaf = 9604;
    seed(leaf);
    line = "";

    available = new Set();
    await openCorrectionForCommand(leaf, "llll", { blockId: "blk-vocab" });
    expect(getNextCommandState().visible).toBe(true);
    expect(getNextCommandState().messageZh).toContain("命令表");

    closeNextCommand();
    available = new Set(["pwd", "ls", "grep"]);
    riskSource = "local";
    await openCorrectionForCommand(leaf, "grpe x", { blockId: "blk-risk" });
    expect(getNextCommandState().visible).toBe(true);
    expect(getNextCommandState().messageZh).toContain("风险");
    expect(getNextCommandState().candidates).toEqual([]);
  });

  it("用户已开始输入下一行时不提示空面板", async () => {
    const leaf = 9605;
    seed(leaf);
    available = new Set(["pwd", "ls"]);
    line = "ls ";

    await openCorrectionForCommand(leaf, "llll", { blockId: "blk-4" });
    expect(getNextCommandState().visible).toBe(false);
  });

  it("输入行状态未知（光标移动/粘贴）时不提示空面板", async () => {
    const leaf = 9606;
    seed(leaf);
    available = new Set(["pwd", "ls"]);
    line = "";
    initNextCommandInjection({
      getLine: () => line,
      writeLine: (_leafId, nextLine) => {
        written.push(nextLine);
        line = nextLine;
        return true;
      },
      getEnvironment: () => "linux",
      getRustSessionId: () => 1,
      getAvailableCommands: () => available,
      getActiveLeafId: () => leaf,
      evaluateRisk: async () => ({ level: "L0", source: "rpc" }),
      getLineState: () => "unknown",
      getLineVersion: () => 0,
      getScopeToken: () => "linux|1|1",
    });

    await openCorrectionForCommand(leaf, "llll", { blockId: "blk-5" });
    expect(getNextCommandState().visible).toBe(false);
  });
});

// CORR-03 P2（ROOT v1.2 第三步）：二次编辑只在用户显式请求后发生；
// 自动层输出保持不变，接受仍只回填。
describe("CORR-03 P2 更多词形候选入口", () => {
  it("自动层零候选后，用户显式请求才给二次编辑候选", async () => {
    const leaf = 9701;
    seed(leaf);
    available = new Set(["pwd", "ls", "less", "lsns"]);
    line = "llsss";

    await openCorrection(leaf, { auto: false });
    expect(getNextCommandState().candidates).toEqual([]);

    await requestMoreCorrection();
    const state = getNextCommandState();
    expect(state.visible).toBe(true);
    expect(state.candidates.map((item) => item.insertText)).toContain("less");

    expect(acceptNextCommand(0)).toBe(true);
    expect(written).toEqual(["less"]);
  });

  it("短命令名（2–4 字符）的次级请求明确说明不扩展", async () => {
    const leaf = 9702;
    seed(leaf);
    available = new Set(["pwd", "ls", "grep"]);
    line = "grpe";

    await openCorrection(leaf, { auto: false });
    await requestMoreCorrection();
    const state = getNextCommandState();
    expect(state.candidates).toEqual([]);
    expect(state.messageZh).toContain("短命令名");
  });
});
