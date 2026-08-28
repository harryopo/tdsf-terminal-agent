/**
 * completionInjection.test.ts — 命令预测注入的定位纯函数测试
 * -----------------------------------------------------------------------------
 * 覆盖（P2 #13 弹窗跟随终端光标）:
 *   1. measureCursorPx: 无 getTerm / 无 term / 无 DOM → null；正常 → 按
 *      .xterm-screen 尺寸 ÷ cols/rows 换算光标像素坐标（不依赖私有 API）
 *   2. computePopupPosition: 光标下方定位 / 右边界收拢 / 下边界翻转上方 /
 *      上方不越视口顶
 */
import { describe, expect, it } from "vitest";
import type { Terminal as XTerm } from "@xterm/xterm";
import { getSuggestEngine } from "@/lib/suggest-engine";
import {
  completionKeyHandler,
  computePopupPosition,
  getCompletionState,
  initCompletionInjection,
  measureCursorPx,
  POPUP_WIDTH,
  setLeafEnvironment,
} from "./completionInjection";

// === measureCursorPx =========================================================

/** 构造最小可测 xterm 假对象（只暴露本函数用到的公开属性） */
function fakeTerm(over: {
  cols?: number;
  rows?: number;
  cursorX?: number;
  cursorY?: number;
  screenRect?: { left: number; top: number; width: number; height: number };
  hasScreen?: boolean;
  hasRows?: boolean;
}): XTerm {
  const el = document.createElement("div");
  if (over.hasScreen !== false) {
    const screen = document.createElement("div");
    screen.className = "xterm-screen";
    el.appendChild(screen);
  }
  if (over.hasRows !== false) {
    const rows = document.createElement("div");
    rows.className = "xterm-rows";
    el.appendChild(rows);
  }
  const rect = over.screenRect ?? { left: 10, top: 20, width: 800, height: 480 };
  el.querySelectorAll("div").forEach((d) => {
    d.getBoundingClientRect = () => ({
      x: rect.left,
      y: rect.top,
      left: rect.left,
      top: rect.top,
      right: rect.left + rect.width,
      bottom: rect.top + rect.height,
      width: rect.width,
      height: rect.height,
      toJSON: () => ({}),
    });
  });
  return {
    element: el,
    cols: over.cols ?? 80,
    rows: over.rows ?? 24,
    buffer: {
      active: {
        cursorX: over.cursorX ?? 10,
        cursorY: over.cursorY ?? 3,
      },
    },
  } as unknown as XTerm;
}

describe("measureCursorPx", () => {
  it("getTerm 为 null → null", () => {
    expect(measureCursorPx(null, 1)).toBeNull();
  });

  it("找不到 leaf 对应 xterm → null", () => {
    expect(measureCursorPx(() => null, 1)).toBeNull();
  });

  it("term 无 element → null", () => {
    const term = fakeTerm({});
    (term as unknown as { element: HTMLElement | null }).element = null;
    expect(measureCursorPx(() => term, 1)).toBeNull();
  });

  it("无 .xterm-screen 也无 .xterm-rows → null", () => {
    const term = fakeTerm({ hasScreen: false, hasRows: false });
    expect(measureCursorPx(() => term, 1)).toBeNull();
  });

  it("按 .xterm-screen 尺寸 ÷ cols/rows 换算光标像素坐标", () => {
    const term = fakeTerm({
      cols: 80,
      rows: 24,
      cursorX: 20,
      cursorY: 3,
      screenRect: { left: 10, top: 20, width: 800, height: 480 },
    });
    // 单格 = 800/80=10 宽, 480/24=20 高
    // left = 10 + 20*10 = 210; top = 20 + 3*20 = 80
    expect(measureCursorPx(() => term, 1)).toEqual({ left: 210, top: 80 });
  });

  it("无 .xterm-screen 时回退 .xterm-rows", () => {
    const term = fakeTerm({
      hasScreen: false,
      cursorX: 40,
      cursorY: 0,
      screenRect: { left: 0, top: 0, width: 400, height: 120 },
    });
    // 单格 = 400/80=5 宽, 120/24=5 高
    expect(measureCursorPx(() => term, 1)).toEqual({ left: 200, top: 0 });
  });

  it("cols/rows 为 0 时防除零", () => {
    const term = fakeTerm({
      cols: 0,
      rows: 0,
      screenRect: { left: 0, top: 0, width: 0, height: 0 },
    });
    expect(measureCursorPx(() => term, 1)).toEqual({ left: 0, top: 0 });
  });
});

// === computePopupPosition =====================================================

const VP = { width: 1920, height: 1080 };

describe("computePopupPosition", () => {
  it("光标居中 → 弹窗出现在光标下方", () => {
    const pos = computePopupPosition({ left: 500, top: 300 }, VP, 5);
    expect(pos).toEqual({ left: 500, top: 312 });
  });

  it("光标贴近右边缘 → 弹窗左移收拢到视口内", () => {
    const pos = computePopupPosition({ left: 1900, top: 300 }, VP, 5);
    // 384 宽 + 8 边距 → 最大 left = 1920 - 384 - 8 = 1528
    expect(pos.left).toBe(VP.width - POPUP_WIDTH - 8);
  });

  it("光标左边缘 → 弹窗不低于 8px", () => {
    const pos = computePopupPosition({ left: 0, top: 300 }, VP, 5);
    expect(pos.left).toBe(8);
  });

  it("下方放不下 → 翻转到光标上方", () => {
    const pos = computePopupPosition({ left: 500, top: 1050 }, VP, 5);
    // estHeight = 24 + 5*30 + 8 = 182; top = 1050 - 182 - 12 = 856
    expect(pos).toEqual({ left: 500, top: 856 });
  });

  it("上方也放不下 → 不低于视口顶 8px", () => {
    // estHeight = 24 + 20*30 + 8 = 632; cursor.top=500 满足翻转条件
    // (500+12+632 > 1080)，翻转后 500-632-12 < 8 → clamp 8
    const pos = computePopupPosition({ left: 500, top: 500 }, VP, 20);
    expect(pos.top).toBe(8);
  });

  it("视口比弹窗窄 → left 保持 8", () => {
    const pos = computePopupPosition(
      { left: 0, top: 100 },
      { width: 200, height: 600 },
      5,
    );
    expect(pos.left).toBe(8);
  });
});

// === acceptPrediction（2026-08-15 ipp bug 回归） =============================
// 用户场景：输入 "ip" → fuzzy 预测 "pip"，按右箭头接受。
// 旧实现：remaining = "pip".slice(2) = "p" 直接追加到已回显的 "ip" → "ipp"。
// 修复：先发等量退格清掉屏幕上已回显的 prefix，再写入完整命令。

/** 构造最小可测键盘事件（completionKeyHandler 用到的字段） */
function key(k: string): KeyboardEvent {
  return {
    type: "keydown",
    key: k,
    keyCode: k.length === 1 ? k.charCodeAt(0) : 0,
    isComposing: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    preventDefault: () => {},
  } as unknown as KeyboardEvent;
}

/** 等待 setTimeout(0) 微任务（updatePredictions 在定时器里跑） */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe("acceptPrediction", () => {
  it("输入 ll 弹出词典别名 ll 且不弹 ollama（用户 2026-08-28 反馈场景）", async () => {
    // ll 是 shell 别名，不在 Fig specs——已并入手编词典预测集；
    // ollama 是首字符不一致的弱子序列，被 fuzzy 首字符约束过滤。
    setLeafEnvironment(1, "linux");
    getSuggestEngine().clearHistory();
    const written: string[] = [];
    initCompletionInjection(
      () => null,
      (_leafId, data) => {
        written.push(data);
      },
    );

    // 输入 "ll"
    expect(completionKeyHandler(1, key("l"))).toBe(true);
    expect(completionKeyHandler(1, key("l"))).toBe(true);
    await tick();

    const state = getCompletionState();
    expect(state.visible).toBe(true);
    // 第一条 = ll（dictionary 命中，非 fuzzy）
    expect(state.items[0]?.command).toBe("ll");
    expect(state.items[0]?.source).toBe("dictionary");
    // 全列表无 ollama（首字符不一致的 fuzzy 噪音）
    expect(state.items.some((it) => it.command === "ollama")).toBe(false);

    // 右箭头接受 → 先退格清 prefix 再写完整命令
    expect(completionKeyHandler(1, key("ArrowRight"))).toBe(false);
    expect(written).toEqual(["\b\b" + "ll"]);
  });

  it("别名独有命令（gs/gaa）可预测且解释含展开命令", async () => {
    // gs/gaa 只在 shell-aliases 数据集（oh-my-zsh git 插件），
    // 不在 Fig specs 也不在手编词典。
    setLeafEnvironment(3, "linux");
    getSuggestEngine().clearHistory();
    initCompletionInjection(
      () => null,
      () => {},
    );

    expect(completionKeyHandler(3, key("g"))).toBe(true);
    expect(completionKeyHandler(3, key("s"))).toBe(true);
    await tick();

    const state = getCompletionState();
    expect(state.visible).toBe(true);
    const gs = state.items.find((it) => it.command === "gs");
    expect(gs).toBeDefined();
    expect(gs?.zh).toContain("git status");
  });

  it("接受 history 预测时同样先退格再写完整命令", async () => {
    // 用独立 leafId 隔离输入缓冲区（leafId 1 已在上一个测试使用）。
    // 2026-08-28 环境分流后：未注册环境默认 windows，显式注册为 linux
    // 以匹配 ipp（Linux 命令）的历史。
    setLeafEnvironment(2, "linux");
    getSuggestEngine().clearHistory();
    getSuggestEngine().loadHistory(["ipp"], "linux");
    const written: string[] = [];
    initCompletionInjection(
      () => null,
      (_leafId, data) => {
        written.push(data);
      },
    );

    expect(completionKeyHandler(2, key("i"))).toBe(true);
    expect(completionKeyHandler(2, key("p"))).toBe(true);
    await tick();

    const state = getCompletionState();
    expect(state.visible).toBe(true);
    expect(state.items[0]?.command).toBe("ipp");

    expect(completionKeyHandler(2, key("ArrowRight"))).toBe(false);
    expect(written).toEqual(["\b\b" + "ipp"]);
  });

  it("Enter 永远透传：弹窗可见时也不接受预测，仅 → 接受（用户 2026-08-28 钦定）", async () => {
    // 终端操作终端优先：Enter 只执行用户已敲入的内容，绝不写入预测文本
    setLeafEnvironment(4, "linux");
    getSuggestEngine().clearHistory();
    const written: string[] = [];
    initCompletionInjection(
      () => null,
      (_leafId, data) => {
        written.push(data);
      },
    );

    // 输入 "ll" → 弹窗可见且有候选
    expect(completionKeyHandler(4, key("l"))).toBe(true);
    expect(completionKeyHandler(4, key("l"))).toBe(true);
    await tick();

    const state = getCompletionState();
    expect(state.visible).toBe(true);
    expect(state.items.length).toBeGreaterThan(0);

    // Enter → 透传（true），且不向 PTY 写入任何预测文本
    expect(completionKeyHandler(4, key("Enter"))).toBe(true);
    expect(written).toEqual([]);
  });
});

// === 二轮改进纯函数（2026-08-28：远端过滤 / 尾部触发合并 / 缩写追加）=========

import type { SuggestionResult } from "@/lib/suggest-engine";
import {
  appendAbbrevItems,
  filterCommandItems,
  mergeCommandWithParamItems,
  shouldTriggerTailParams,
} from "./completionInjection";

/** 构造命令模式候选 */
function cmdItem(command: string, source: SuggestionResult["source"]): SuggestionResult {
  return { command, source, kind: "cmd" };
}

/** 构造参数模式候选 */
function argItem(command: string, description?: string): SuggestionResult {
  return { command, source: "arg", kind: "arg", description };
}

describe("filterCommandItems（远端命令全集过滤）", () => {
  it("cmds 有值 → 只保留远端存在的命令，截 5", () => {
    const items = [
      cmdItem("ls", "dictionary"),
      cmdItem("git", "fuzzy"),
      cmdItem("nope", "dictionary"), // 远端没有
      cmdItem("ipt", "fuzzy"), // 远端没有
    ];
    const cmds = new Set(["ls", "git"]);
    const out = filterCommandItems(items, cmds);
    expect(out.map((it) => it.command)).toEqual(["ls", "git"]);
  });

  it("history 来源豁免过滤（历史是真实执行过的）", () => {
    const items = [
      cmdItem("my-custom-tool", "history"), // 远端命令全集里没有
      cmdItem("nope", "dictionary"),
    ];
    const out = filterCommandItems(items, new Set(["ls"]));
    expect(out.map((it) => it.command)).toEqual(["my-custom-tool"]);
  });

  it("cmds 为 null（未拉到远端全集）→ 降级不过滤，仅截 5（无损）", () => {
    const items = Array.from({ length: 8 }, (_, i) => cmdItem(`c${i}`, "fuzzy"));
    const out = filterCommandItems(items, null);
    expect(out).toHaveLength(5);
    expect(out.map((it) => it.command)).toEqual(["c0", "c1", "c2", "c3", "c4"]);
  });

  it("过滤后超过 5 → 截 5", () => {
    const items = Array.from({ length: 10 }, (_, i) => cmdItem(`c${i}`, "fuzzy"));
    const cmds = new Set(items.map((it) => it.command));
    expect(filterCommandItems(items, cmds)).toHaveLength(5);
  });
});

describe("shouldTriggerTailParams（尾部触发的存在性门禁）", () => {
  const remoteCmds = new Set(["ls", "ip", "git"]);

  it("linux + 远端有该命令 + 有数据源 → 触发（ls 场景）", () => {
    expect(shouldTriggerTailParams("linux", "ls", true, remoteCmds, true)).toBe(true);
  });

  it("linux + 远端没有该命令 → 不触发（ag 场景：tldr 有参数数据但远端没装）", () => {
    expect(shouldTriggerTailParams("linux", "ag", true, remoteCmds, true)).toBe(false);
  });

  it("linux + 远端命令集未拉到（null）→ 不触发（保守，宁可少弹不误弹）", () => {
    expect(shouldTriggerTailParams("linux", "ls", true, null, true)).toBe(false);
  });

  it("linux + ip 不在词典但缩写表有 → 只看远端，触发（用户要的场景）", () => {
    expect(shouldTriggerTailParams("linux", "ip", true, remoteCmds, false)).toBe(true);
  });

  it("windows + 词典命中 → 触发", () => {
    expect(shouldTriggerTailParams("windows", "git", true, null, true)).toBe(true);
  });

  it("windows + 词典未命中 → 不触发（挡住词典外命令的假参数）", () => {
    expect(shouldTriggerTailParams("windows", "ag", true, null, false)).toBe(false);
  });

  it("无数据源（tldr/缩写表都没有）→ 一律不触发", () => {
    expect(shouldTriggerTailParams("linux", "ls", false, remoteCmds, true)).toBe(false);
    expect(shouldTriggerTailParams("windows", "git", false, null, true)).toBe(false);
  });
});

describe("mergeCommandWithParamItems（尾部触发合并）", () => {
  it("命令候选在前，参数候选去重追加", () => {
    const cmdItems = [cmdItem("lsblk", "fuzzy"), cmdItem("ls", "dictionary")];
    const paramItems = [
      argItem("-l", "列出文件信息"),
      argItem("-a", "列出隐藏文件"),
      argItem("ls", "重复的命令名"), // 与命令候选重名 → 去重
    ];
    const out = mergeCommandWithParamItems(cmdItems, paramItems);
    expect(out.map((it) => it.command)).toEqual(["lsblk", "ls", "-l", "-a"]);
    expect(out[2]?.kind).toBe("arg");
  });

  it("参数候选最多追加 3 条（限 5+3）", () => {
    const cmdItems = [cmdItem("ls", "dictionary")];
    const paramItems = ["-1", "-a", "-F", "-la", "-l"].map((c) => argItem(c));
    const out = mergeCommandWithParamItems(cmdItems, paramItems);
    expect(out).toHaveLength(4); // 1 命令 + 3 参数
  });
});

describe("appendAbbrevItems（参数模式追加子命令缩写）", () => {
  it("ip + prefix 'ip a'（远端/tldr/specs 全无数据）→ 缩写补上 address", () => {
    // 用户实测痛点：carapace 无 ip completer、Fig specs/tldr 无 ip → 三源空。
    // current='a' → 只命中 a/addr 同指的 address（去重为一条）；
    // link/route 等是 `ip l`/`ip r` 的候选，不应混入。
    const out = appendAbbrevItems([], "ip", "ip a");
    expect(out).toHaveLength(1);
    expect(out[0]?.command).toBe("address");
    // 缩写候选是参数类（acceptPrediction 替换当前 token 'a' → 'address'）
    expect(out[0]?.kind).toBe("arg");
    expect(out[0]?.description).toContain("（= a 缩写）");
  });

  it("ip + prefix 'ip'（尾部触发，current 空）→ 全量缩写候选", () => {
    const out = appendAbbrevItems([], "ip", "ip ");
    const commands = out.map((it) => it.command);
    expect(commands).toEqual(["address", "link", "route", "neighbour", "stats"]);
  });

  it("systemctl + prefix 'systemctl s' → tldr 选项在前，缩写 status/start/stop 追加", () => {
    // tldr systemctl 先占 4 条（--failed/-t/--type/--state），缩写补足剩余空位
    const tldrItems = [
      argItem("--failed"),
      argItem("-t"),
      argItem("--type"),
      argItem("--state"),
    ];
    const out = appendAbbrevItems(tldrItems, "systemctl", "systemctl s");
    expect(out).toHaveLength(7); // 4 tldr + 3 缩写（s→status/start/stop）
    const commands = out.map((it) => it.command);
    expect(commands.slice(0, 4)).toEqual(["--failed", "-t", "--type", "--state"]);
    expect(commands.slice(4)).toEqual(["status", "start", "stop"]);
    // 缩写条目（'s' 缩写的 status）描述带"= 缩写"教学后缀
    const status = out.find((it) => it.command === "status");
    expect(status?.description).toContain("（= s 缩写）");
  });

  it("已有 8 条满 → 原样截 8 不追加", () => {
    const full = Array.from({ length: 8 }, (_, i) => argItem(`-opt${i}`));
    expect(appendAbbrevItems(full, "ip", "ip a")).toHaveLength(8);
    expect(appendAbbrevItems(full, "ip", "ip a")[0]?.command).toBe("-opt0");
  });
});
