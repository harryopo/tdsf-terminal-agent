/**
 * terminalBlocks.ts — 终端 block 流水账状态机（方案书 v3.1 §4.7 B1，2026-08-29）
 * -----------------------------------------------------------------------------
 * 让 agent 感知"shell 里发生了什么"：每个命令生命周期建成一条 block
 * `{command, cwd, exitCode, durationMs, author, outputTail, startedAt}`
 * （atuin history schema 同款字段集，调研 §1.2.2）。
 *
 * 数据源：OSC 133 A/B/C/D + OSC 633;E(命令行原文)/633;P(Cwd)——本地终端
 * (pty/scripts 注入) 与 SSH 终端 (session.rs 方案 A 注入) 统一发同一协议，
 * 经 xterm registerOscHandler 直接解析（SSH 输出与本地一样写入 xterm，
 * 单一代码路径，无需 Rust 侧解析转发——agent_detect 只管 agent 活跃检测）。
 *
 * handler 注册顺序约定：本模块的 handler 必须先于 BlockDecorations 注册，
 * 且返回 false（不终止 OSC handler 链）——BlockDecorations 的 133 handler
 * 返回 true 会终止传递，后注册者收不到事件。
 *
 * 健壮性（kitty/iTerm2 验证过的规则）：
 *   - 孤儿 D：无 pending 时收到 D → 忽略
 *   - 孤儿 C：无 A 直接收 C → 创建 pending（脏流兜底）
 *   - 未闭合 A：新 A 到来时上一 pending 未结算 → 结算(exit=null)或丢弃
 *   - 空命令周期：有 A/B 但从未收到 C/E → 丢弃（不产生空 block）
 */
import type { IMarker, Terminal } from "@xterm/xterm";

export type TerminalBlockAuthor = "user" | "agent";

/** 一条完成的命令 block（agent 上下文 <terminal-history> 的数据源） */
export type TerminalBlock = {
  id: string;
  /** 终端 leaf id（本地/SSH 统一） */
  sessionId: number;
  command: string;
  cwd: string;
  /** null = 未知（孤儿自愈 / shell 未上报退出码） */
  exitCode: number | null;
  durationMs: number;
  /** agent 注入的命令标 author=agent（atuin Agent Hooks 思想） */
  author: TerminalBlockAuthor;
  /** 命令输出尾部（已脱敏），空 = 无输出或未捕获 */
  outputTail: string;
  /** 命令开始执行时刻（E/C 到达时刻） */
  startedAt: number;
};

export type TerminalBlockCollectorOptions = {
  sessionId: number;
  now?: () => number;
  /** 结算时判定 author（桥接层接 store 的 agent-pending 标记） */
  resolveAuthor?: (command: string) => TerminalBlockAuthor;
  /** 首次收到 E/C（命令开始执行）——桥接层打 startMarker 用于抓输出区间 */
  onExecStart?: () => void;
  /** D 结算时抓输出尾部（桥接层提供，返回文本需已脱敏） */
  onOutputCapture?: () => string;
  /** block 结算回调 */
  onBlock?: (block: TerminalBlock) => void;
};

type PendingBlock = {
  command: string;
  cwd: string;
  startedAt: number;
  /** 是否已收到 C/E（决定 D 时结算还是丢弃） */
  execStarted: boolean;
};

export class TerminalBlockCollector {
  private pending: PendingBlock | null = null;
  private cwd = "";
  private idSeq = 0;
  private readonly sessionId: number;
  private readonly now: () => number;
  private readonly resolveAuthor: (command: string) => TerminalBlockAuthor;
  private readonly onExecStart?: () => void;
  private readonly onOutputCapture?: () => string;
  private readonly onBlock?: (block: TerminalBlock) => void;

  constructor(opts: TerminalBlockCollectorOptions) {
    this.sessionId = opts.sessionId;
    this.now = opts.now ?? (() => Date.now());
    this.resolveAuthor = opts.resolveAuthor ?? (() => "user");
    this.onExecStart = opts.onExecStart;
    this.onOutputCapture = opts.onOutputCapture;
    this.onBlock = opts.onBlock;
  }

  /** cwd 变化（来自现有 OSC 7 handler 的回调，避免注册第三个 handler） */
  setCwd(cwd: string): void {
    if (cwd) this.cwd = cwd;
  }

  /** OSC 133 payload（"A" | "B" | "C;cmd" | "D;<exit>"） */
  handle133(data: string): void {
    const marker = data.charAt(0);
    const rest = data.length > 2 && data.charAt(1) === ";" ? data.slice(2) : "";
    switch (marker) {
      case "A":
        // 孤儿自愈：上一周期未收到 D 就来新 A → 先闭合/丢弃
        this.settleOrDrop(null);
        break;
      case "C":
        this.execStart(rest);
        break;
      case "D":
        this.finish(parseExitCode(rest));
        break;
      default:
        break;
    }
  }

  /** OSC 633 payload（"A"|"B"|"C"|"D;<exit>"|"E;<cmd>[;<nonce>]"|"P;Cwd=..."） */
  handle633(data: string): void {
    const kind = data.charAt(0);
    const args = data.length > 1 && data.charAt(1) === ";" ? data.slice(2) : "";
    switch (kind) {
      case "A":
        this.settleOrDrop(null);
        break;
      case "C":
        this.execStart("");
        break;
      case "D":
        this.finish(parseExitCode(args));
        break;
      case "E": {
        // E;<cmd>[;<nonce>] — nonce 防错配，本状态机按序处理，忽略之
        const raw = args.includes(";") ? args.slice(0, args.indexOf(";")) : args;
        const cmd = decodeOscText(raw);
        if (!cmd) break;
        if (!this.pending) {
          // 脏流兜底：E 先于 A/C 到达（旧 shell 未发 A）
          this.pending = {
            command: cmd,
            cwd: this.cwd,
            startedAt: this.now(),
            execStarted: true,
          };
          this.onExecStart?.();
          break;
        }
        if (!this.pending.command) this.pending.command = cmd;
        if (!this.pending.execStarted) {
          this.pending.execStarted = true;
          this.onExecStart?.();
        }
        break;
      }
      case "P": {
        // P;<Property>=<Value> — 目前只消费 Cwd（633;P;Cwd 与 OSC 7 等价）
        const eq = args.indexOf("=");
        if (eq > 0 && args.slice(0, eq) === "Cwd") {
          this.setCwd(decodeOscText(args.slice(eq + 1)));
        }
        break;
      }
      default:
        break;
    }
  }

  /** 命令开始执行（C 到达；cmdFromMarker = 本地 133;C;cmd 携带的命令文本兜底） */
  private execStart(cmdFromMarker: string): void {
    if (!this.pending) {
      this.pending = {
        command: cmdFromMarker,
        cwd: this.cwd,
        startedAt: this.now(),
        execStarted: true,
      };
      this.onExecStart?.();
      return;
    }
    if (this.pending.execStarted) return; // 重复 C（复合流）忽略
    if (!this.pending.command && cmdFromMarker) {
      this.pending.command = cmdFromMarker;
    }
    this.pending.execStarted = true;
    this.onExecStart?.();
  }

  /** D 到达：结算（有 C/E）或忽略孤儿（无 pending） */
  private finish(exitCode: number | null): void {
    this.settleOrDrop(exitCode);
  }

  /** 结算或丢弃 pending（exitCode=null 表示未知退出码的孤儿自愈） */
  private settleOrDrop(exitCode: number | null): void {
    const p = this.pending;
    if (!p) return; // 孤儿 D：忽略
    this.pending = null;
    if (!p.execStarted) return; // 空命令周期（只有 A/B 回车空跑）：丢弃
    const outputTail = this.onOutputCapture?.() ?? "";
    const block: TerminalBlock = {
      id: `tb-${this.sessionId}-${++this.idSeq}`,
      sessionId: this.sessionId,
      command: p.command,
      cwd: p.cwd || this.cwd,
      exitCode,
      durationMs: Math.max(0, this.now() - p.startedAt),
      author: this.resolveAuthor(p.command),
      outputTail,
      startedAt: p.startedAt,
    };
    this.onBlock?.(block);
  }
}

/** 注册 OSC 133/633 block 收集 handler（返回反注册函数） */
export function registerBlockOscHandlers(
  term: Terminal,
  collector: TerminalBlockCollector,
): () => void {
  const d133 = term.parser.registerOscHandler(133, (data) => {
    collector.handle133(data);
    return false; // 不拦截：BlockDecorations 等后续 133 handler 继续收
  });
  const d633 = term.parser.registerOscHandler(633, (data) => {
    collector.handle633(data);
    return false;
  });
  return () => {
    d133.dispose();
    d633.dispose();
  };
}

/**
 * 抓取 [startMarker, endMarker] 区间的输出尾部文本（block 的 outputTail）。
 * marker 在 reflow 时自动重定基（xterm registerMarker 坐标系，Taviraq 教训：
 * 不用字节偏移/逻辑行等第二坐标系）。
 */
export function captureBlockOutput(
  term: Terminal,
  startMarker: IMarker | null,
  endMarker: IMarker | null,
  maxLines = 8,
  maxCharsPerLine = 200,
): string {
  const buf = term.buffer.active;
  const cursorLine = buf.baseY + buf.cursorY;
  const start =
    startMarker && !startMarker.isDisposed && startMarker.line >= 0
      ? startMarker.line
      : Math.max(0, cursorLine - maxLines);
  const end = Math.min(
    endMarker && !endMarker.isDisposed ? endMarker.line : cursorLine,
    buf.length - 1,
  );
  if (end < start) return "";
  const lines: string[] = [];
  for (let i = Math.max(start, end - maxLines + 1); i <= end; i++) {
    const text = (buf.getLine(i)?.translateToString(true) ?? "").trimEnd();
    lines.push(text.length > maxCharsPerLine ? `${text.slice(0, maxCharsPerLine)}…` : text);
  }
  return lines.join("\n").trim();
}

function parseExitCode(s: string): number | null {
  if (!s) return null;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) && n >= 0 && n <= 255 ? n : null;
}

/**
 * OSC 633;E 文本解码（VS Code 同款：`\xHH` + `\\`）。
 * 与 command-tracker-addon.deserializeOscValue 行为一致。
 */
export function decodeOscText(value: string): string {
  if (!value) return "";
  return value
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16)),
    )
    .replace(/\\\\/g, "\\");
}
