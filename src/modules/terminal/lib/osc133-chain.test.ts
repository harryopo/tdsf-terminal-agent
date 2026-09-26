/**
 * OSC 133 的消费者链 —— 用**真 xterm 解析器**测（#130 真机撞出来的断链）。
 *
 * 为什么要真对象：三个功能各自 `registerOscHandler(133, …)`（块收集器 / prompt tracker /
 * BlockDecorations），而仓里原有的测试一律用 `new Map<number, handler>()` 假装 xterm ——
 * Map 是"一个 id 一个 handler、后写的覆盖先写的"，真解析器却是"**一个 id 一串 handler、
 * 后注册的先被调用，谁先返回 true 就到此为止**"（读 node_modules 里的 OscParser 核对过）。
 * 两种模型下"谁收得到事件"完全不同，于是本地终端一条块都产不出来这件事，
 * 全绿的单测看不见（真机读数：133 的 C/D/A/B 都进了 xterm，`blocksByLeaf` 与
 * `execStartedAtByLeaf` 仍全空）。框架裁决的环节必须用真对象测，同 #114 那条约定。
 */
import { Terminal } from "@xterm/xterm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { registerBlockOscHandlers, TerminalBlockCollector } from "./terminalBlocks";
import {
  createShellIntegrationState,
  registerPromptTracker,
} from "./osc-handlers";
import type { TerminalBlock } from "./terminalBlocks";

/** 各家 shell 的发报终结符都是 ST（ESC \），照真字节喂 */
const ST = `${String.fromCharCode(27)}\\`;

function feed(term: Terminal, seq: string): Promise<void> {
  return new Promise((resolve) => term.write(seq, resolve));
}

type Harness = {
  term: Terminal;
  blocks: TerminalBlock[];
  execStarts: number[];
  running: boolean[];
  dispose: () => void;
};

/** 生产的注册顺序：先块收集器（terminalBlocks），后 prompt tracker（useTerminalSession） */
function wire(orders: "collector-first" | "tracker-first"): Harness {
  const term = new Terminal({ cols: 80, rows: 24 });
  const blocks: TerminalBlock[] = [];
  const execStarts: number[] = [];
  const running: boolean[] = [];
  const collector = new TerminalBlockCollector({
    sessionId: 7,
    onExecStart: () => execStarts.push(1),
    onBlock: (b) => blocks.push(b),
  });
  const state = createShellIntegrationState();
  const disposers: (() => void)[] = [];
  if (orders === "collector-first") {
    disposers.push(registerBlockOscHandlers(term, collector));
    disposers.push(
      registerPromptTracker(term, state, (r) => running.push(r)).dispose,
    );
  } else {
    disposers.push(
      registerPromptTracker(term, state, (r) => running.push(r)).dispose,
    );
    disposers.push(registerBlockOscHandlers(term, collector));
  }
  return {
    term,
    blocks,
    execStarts,
    running,
    dispose: () => disposers.forEach((d) => d()),
  };
}

// 一条完整周期：命令回显 → 回车执行（C 带命令文本）→ 结束（D 带退出码）→ 新提示符
const ONE_CYCLE =
  `Get-Date\r\n` +
  `${String.fromCharCode(27)}]133;C;Get-Date${ST}` +
  `${String.fromCharCode(27)}]133;D;0${ST}` +
  `${String.fromCharCode(27)}]133;A${ST}`;

describe("OSC 133 多消费者：块收集器与 prompt tracker 必须都收得到", () => {
  it("生产的注册顺序下（块收集器先注册）仍产出块 —— #130 断的就是这条", async () => {
    const h = wire("collector-first");
    await feed(h.term, ONE_CYCLE);
    h.dispose();
    expect(h.execStarts).toHaveLength(1); // C 到达
    expect(h.blocks).toHaveLength(1); // D 结算
    expect(h.blocks[0]?.command).toBe("Get-Date");
    expect(h.blocks[0]?.exitCode).toBe(0);
    // 同一条事件流也得喂给 prompt tracker（它管"命令在跑"与 OSC 7 的信任门）
    expect(h.running).toContain(true);
    expect(h.running).toContain(false);
  });

  it("反序注册也要两边都收到（判据不许依赖注册先后）", async () => {
    const h = wire("tracker-first");
    await feed(h.term, ONE_CYCLE);
    h.dispose();
    expect(h.blocks).toHaveLength(1);
    expect(h.running).toContain(true);
  });
});

describe("OSC 133 的消费者一律放行（不拦链）", () => {
  // 真解析器是"后注册的先调用"，所以任何 handler 返回 true 都会让**先注册**的
  // 那些收不到事件 —— 顺序是隐式耦合，只有全部放行才不依赖它。
  const FILES = [
    ["src/modules/terminal/lib/terminalBlocks.ts", 1],
    ["src/modules/terminal/lib/osc-handlers.ts", 1],
    ["src/modules/terminal/block/lib/blockDecorations.ts", 1],
  ] as const;

  for (const [rel, expected] of FILES) {
    it(`${rel} 里的 133 handler 数量为 ${expected} 且全部 return false`, () => {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      const bodies = [
        ...src.matchAll(/registerOscHandler\(133,\s*\([^)]*\)\s*=>\s*\{([\s\S]*?)\n\s*\}\)/g),
      ].map((m) => m[1]);
      expect(bodies).toHaveLength(expected);
      for (const body of bodies) {
        expect(body).not.toMatch(/return\s+true/);
        expect(body).toMatch(/return\s+false/);
      }
    });
  }
});
