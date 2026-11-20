/**
 * terminalBlocks.test.ts — 终端 block 流水账状态机测试
 * （方案书 v3.1 §4.7 B1，2026-08-29）
 *
 * 覆盖：A→B→C→D 生命周期、exit/duration 提取、633;E 命令行文本（含
 * nonce 与 \x 转义解码）、孤儿 D / 孤儿 C / 空命令周期 / 未闭合 A 自愈、
 * cwd 提取（633;P + setCwd）、author=agent 标记回调、handler 注册放行。
 */
import { describe, expect, it, vi } from "vitest";
import {
  TerminalBlockCollector,
  decodeOscText,
  registerBlockOscHandlers,
  type TerminalBlock,
} from "./terminalBlocks";
import { shouldOfferBlockCorrection } from "./nextCommandInjection";

type CollectorHarness = {
  collector: TerminalBlockCollector;
  blocks: TerminalBlock[];
};

function makeCollector(over: {
  now?: () => number;
  resolveAuthor?: (command: string) => "user" | "agent";
  outputTail?: string | { text: string; truncated: boolean };
} = {}): CollectorHarness {
  const blocks: TerminalBlock[] = [];
  const collector = new TerminalBlockCollector({
    sessionId: 7,
    now: over.now ?? (() => 1000),
    resolveAuthor: over.resolveAuthor,
    onOutputCapture: over.outputTail !== undefined ? () => over.outputTail! : undefined,
    onBlock: (b) => blocks.push(b),
  });
  return { collector, blocks };
}

describe("TerminalBlockCollector — 完整生命周期", () => {
  it("SSH 路径: A → 633;E → C → D;3 结算 block（command/exit/duration/cwd）", () => {
    let t = 1000;
    const { collector, blocks } = makeCollector({
      now: () => t,
      outputTail: "Active: failed",
    });
    collector.setCwd("/etc/nginx");
    collector.handle133("A");
    collector.handle133("B");
    t = 1200;
    collector.handle633("E;systemctl status nginx;42");
    collector.handle633("C");
    t = 13000;
    collector.handle133("D;3");
    expect(blocks).toHaveLength(1);
    const b = blocks[0];
    expect(b.command).toBe("systemctl status nginx");
    expect(b.exitCode).toBe(3);
    expect(b.durationMs).toBe(13000 - 1200);
    expect(b.cwd).toBe("/etc/nginx");
    expect(b.outputTail).toBe("Active: failed");
    expect(b.author).toBe("user");
    expect(b.sessionId).toBe(7);
    expect(b.startedAt).toBe(1200);
  });

  it("本地路径: 133;C;<cmd> 携带命令文本（无 633;E）", () => {
    const { collector, blocks } = makeCollector();
    collector.handle133("A");
    collector.handle133("C;yum install httpd -y");
    collector.handle133("D;0");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].command).toBe("yum install httpd -y");
    expect(blocks[0].exitCode).toBe(0);
  });

  it("D 无 exit code → exitCode=null", () => {
    const { collector, blocks } = makeCollector();
    collector.handle133("A");
    collector.handle133("C");
    collector.handle133("D");
    expect(blocks[0].exitCode).toBeNull();
  });
});

describe("TerminalBlockCollector — 健壮性（孤儿/自愈）", () => {
  it("孤儿 D：无 pending 时忽略", () => {
    const { collector, blocks } = makeCollector();
    collector.handle133("D;0");
    collector.handle133("D;1");
    expect(blocks).toHaveLength(0);
  });

  it("空命令周期：A→B→D（从未收到 C/E）丢弃，不产生空 block", () => {
    const { collector, blocks } = makeCollector();
    collector.handle133("A");
    collector.handle133("B");
    collector.handle133("D;0");
    expect(blocks).toHaveLength(0);
  });

  it("未闭合 C 时来新 A → 自愈结算（exit=null）", () => {
    const { collector, blocks } = makeCollector();
    collector.handle133("A");
    collector.handle133("C;vim notes.md");
    // 用户进了 TUI，D 丢失，shell 重启发新 A
    collector.handle133("A");
    collector.handle133("C;ls");
    collector.handle133("D;0");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].command).toBe("vim notes.md");
    expect(blocks[0].exitCode).toBeNull();
    expect(blocks[1].command).toBe("ls");
    expect(blocks[1].exitCode).toBe(0);
  });

  it("孤儿 C：无 A 直接收 C（脏流兜底）", () => {
    const { collector, blocks } = makeCollector();
    collector.handle133("C;uptime");
    collector.handle133("D;0");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].command).toBe("uptime");
  });

  it("孤儿 633;E 先于 A/C 到达（旧 shell 未发 A）", () => {
    const { collector, blocks } = makeCollector();
    collector.handle633("E;top");
    collector.handle133("D;0");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].command).toBe("top");
  });

  it("重复 C（复合流）忽略，不重复打 onExecStart", () => {
    const onExecStart = vi.fn();
    const collector = new TerminalBlockCollector({
      sessionId: 1,
      onExecStart,
    });
    collector.handle133("A");
    collector.handle133("C;echo hi");
    collector.handle133("C;echo hi");
    expect(onExecStart).toHaveBeenCalledTimes(1);
  });
});

describe("TerminalBlockCollector — 633 协议细节", () => {
  it("633;E 中经 \x3b 转义的分号不会被误当作 nonce 分隔符", () => {
    const { collector, blocks } = makeCollector();
    collector.handle133("A");
    collector.handle633("E;printf a\\x3bb;42");
    collector.handle633("C");
    collector.handle133("D;0");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].command).toBe("printf a;b");
  });

  it("633;P;Cwd 更新 cwd（下条 block 继承）", () => {
    const { collector, blocks } = makeCollector();
    collector.handle133("A");
    collector.handle133("C");
    collector.handle133("D;0");
    collector.handle633("P;Cwd=/var/log");
    collector.handle133("A");
    collector.handle133("C");
    collector.handle133("D;0");
    expect(blocks[1].cwd).toBe("/var/log");
  });

  it("633;E \\x 转义解码（VS Code 同款）", () => {
    const { collector, blocks } = makeCollector();
    collector.handle133("A");
    collector.handle633(`E;echo \\x1b[31mred`);
    collector.handle133("D;0");
    expect(blocks[0].command).toBe("echo \x1b[31mred");
  });

  it("633;E 空 command 忽略（不覆盖 C rest）", () => {
    const { collector, blocks } = makeCollector();
    collector.handle133("A");
    collector.handle133("C;pwd");
    collector.handle633("E;;99");
    collector.handle133("D;0");
    expect(blocks[0].command).toBe("pwd");
  });
});

describe("TerminalBlockCollector — author 标记", () => {
  it("resolveAuthor 命中 → author=agent", () => {
    const { collector, blocks } = makeCollector({
      resolveAuthor: (cmd) => (cmd === "yum install httpd -y" ? "agent" : "user"),
    });
    collector.handle133("A");
    collector.handle133("C;yum install httpd -y");
    collector.handle133("D;0");
    collector.handle133("A");
    collector.handle133("C;ls");
    collector.handle133("D;0");
    expect(blocks[0].author).toBe("agent");
    expect(blocks[1].author).toBe("user");
  });

  it("无 resolveAuthor 默认 user", () => {
    const { collector, blocks } = makeCollector();
    collector.handle133("A");
    collector.handle133("C;ls");
    collector.handle133("D;0");
    expect(blocks[0].author).toBe("user");
  });
});

describe("TerminalBlockCollector output metadata", () => {
  it("preserves explicit output truncation metadata", () => {
    const { collector, blocks } = makeCollector({
      outputTail: { text: "last lines", truncated: true },
    });
    collector.handle133("C;ss -tlnp");
    collector.handle133("D;0");
    expect(blocks[0].outputTail).toBe("last lines");
    expect(blocks[0].outputTruncated).toBe(true);
  });
});

// CORR-02 C3：命令文本完整性与退出码归属。F 标记由 shell 在 133;D 之前上报：
// segments=1 且 valid=1 才是完整单一简单命令；其它都是片段/复合/未知。
describe("CORR-02 C3 命令行完整性", () => {
  it("完整单一简单命令 → commandComplete=true", () => {
    const { collector, blocks } = makeCollector();
    collector.handle133("A");
    collector.handle633("E;grpe -n error app.log;4242");
    collector.handle633("C");
    collector.handle633("F;1;1;4242");
    collector.handle133("D;127");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].command).toBe("grpe -n error app.log");
    expect(blocks[0].exitCode).toBe(127);
    expect(blocks[0].commandComplete).toBe(true);
  });

  it("复合/管道（多段）→ commandComplete=false，退出码不再归属首段", () => {
    const { collector, blocks } = makeCollector();
    collector.handle133("A");
    collector.handle633("E;printf ROOT_OK;11");
    collector.handle633("C");
    collector.handle633("F;2;0;11");
    collector.handle133("D;127");
    expect(blocks[0].command).toBe("printf ROOT_OK");
    expect(blocks[0].exitCode).toBe(127);
    expect(blocks[0].commandComplete).toBe(false);
  });

  it("单一命令但历史校验失败（前导空格/历史过滤）→ false", () => {
    const { collector, blocks } = makeCollector();
    collector.handle133("A");
    collector.handle633("E;grpe x;7");
    collector.handle633("C");
    collector.handle633("F;1;0;7");
    collector.handle133("D;127");
    expect(blocks[0].commandComplete).toBe(false);
  });

  it("nonce 不一致的 F 不得污染本行（其它 shell 的迟到标记）", () => {
    const { collector, blocks } = makeCollector();
    collector.handle133("A");
    collector.handle633("E;grpe x;1");
    collector.handle633("C");
    collector.handle633("F;1;1;999");
    collector.handle133("D;127");
    // CORR-03 P0（ROOT v1.2）：本轮已经收到 F 但 nonce 不匹配 = 无效新证据，
    // 必须显式拒绝（false），不能退回“旧 shell 无 F”的 undefined 学习路径。
    expect(blocks[0].commandComplete).toBe(false);
  });

  it("第一份 F 为准：迟到/嵌套标记不能把不完整改判为完整", () => {
    const { collector, blocks } = makeCollector();
    collector.handle133("A");
    collector.handle633("E;printf x | cat;2");
    collector.handle633("C");
    collector.handle633("F;2;0;2");
    collector.handle633("F;1;1;2");
    collector.handle133("D;0");
    expect(blocks[0].commandComplete).toBe(false);
  });

  it("旧 shell／非 Bash 集成没有 F → undefined（保守，不冒充完整）", () => {
    const { collector, blocks } = makeCollector();
    collector.handle133("A");
    collector.handle633("E;grpe x;1");
    collector.handle633("C");
    collector.handle133("D;127");
    expect(blocks[0].commandComplete).toBeUndefined();

    const local = makeCollector();
    local.collector.handle133("C;grpe x");
    local.collector.handle133("D;127");
    expect(local.blocks[0].commandComplete).toBeUndefined();
  });

  it("F 在 E/C 之后、D 之前到达才生效；缺失 D 的孤儿结算保留标记但退出码未知", () => {
    const { collector, blocks } = makeCollector();
    collector.handle133("A");
    collector.handle633("E;ls;5");
    collector.handle633("C");
    collector.handle633("F;1;1;5");
    // D 丢失，下一条 A 触发孤儿结算（exit=null）
    collector.handle133("A");
    expect(blocks[0].commandComplete).toBe(true);
    expect(blocks[0].exitCode).toBeNull();
  });

  it("ROOT C3 原始事件流：片段绑定 127 时不得触发失败纠错", () => {
    const { collector, blocks } = makeCollector();
    collector.handle133("A");
    collector.handle633("E;printf ROOT_OK;7654");
    collector.handle633("C");
    collector.handle633("F;2;0;7654");
    collector.handle133("D;127");
    expect(blocks).toHaveLength(1);
    expect(blocks[0].command).toBe("printf ROOT_OK");
    expect(blocks[0].exitCode).toBe(127);
    expect(blocks[0].commandComplete).toBe(false);
    expect(shouldOfferBlockCorrection(blocks[0])).toBe(false);
  });

  it("完整单命令事件流：grpe → 127 才允许失败纠错", () => {
    const { collector, blocks } = makeCollector();
    collector.handle133("A");
    collector.handle633("E;grpe -n error app.log;81");
    collector.handle633("C");
    collector.handle633("F;1;1;81");
    collector.handle133("D;127");
    expect(shouldOfferBlockCorrection(blocks[0])).toBe(true);
  });
});

describe("decodeOscText", () => {
  it("解码 \\xHH 与 \\\\；\\t 等非 \\x 序列不解码（VS Code 同款）", () => {
    expect(decodeOscText("a\\x41b")).toBe("aAb");
    expect(decodeOscText("a\\tb")).toBe("a\\tb"); // \t 不在解码范围
    expect(decodeOscText("a\\\\b")).toBe("a\\b");
    expect(decodeOscText("plain")).toBe("plain");
    expect(decodeOscText("")).toBe("");
  });
});

describe("registerBlockOscHandlers", () => {
  it("注册 133/633 handler 且返回 false（放行后续 handler）", () => {
    const handlers = new Map<number, (data: string) => boolean | void>();
    const fakeTerm = {
      parser: {
        registerOscHandler: (code: number, h: (data: string) => boolean) => {
          handlers.set(code, h);
          return { dispose: () => handlers.delete(code) };
        },
      },
    } as unknown as Parameters<typeof registerBlockOscHandlers>[0];
    const collector = new TerminalBlockCollector({ sessionId: 1 });
    const dispose = registerBlockOscHandlers(fakeTerm, collector);
    expect(handlers.get(133)).toBeTypeOf("function");
    expect(handlers.get(633)).toBeTypeOf("function");
    // handler 返回 false（不拦截 BlockDecorations 的 133 消费）
    expect(handlers.get(133)?.("A")).toBe(false);
    expect(handlers.get(633)?.("P;Cwd=/tmp")).toBe(false);
    dispose();
    expect(handlers.size).toBe(0);
  });
});
