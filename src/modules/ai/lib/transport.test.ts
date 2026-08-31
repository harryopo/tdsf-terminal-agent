/**
 * transport.test.ts — 上下文感知 transport 核心逻辑测试
 * -----------------------------------------------------------------------------
 * 覆盖（P0-5 补测试）:
 *   1. formatEnvBlock: env 块生成（cwd/activeFile/workspaceRoot/private/ssh）
 *   2. stripContextBlock: terminal-context 块剥离
 *   3. formatEnvBlock 空 live 返回 null
 */
import { describe, expect, it } from "vitest";
import {
  CONTEXT_BLOCK_RE,
  formatEnvBlock,
  formatTerminalContextBlock,
  stripContextBlock,
  // TDSF B1 (2026-08-29): <environment> / <terminal-history> 分区
  formatEnvironmentBlock,
  formatTerminalHistoryBlock,
  TERMINAL_HISTORY_MAX_BLOCKS,
} from "./transport";
import type { TerminalBlock } from "@/modules/terminal/lib/terminalBlocks";
import type { EnvironmentProbe } from "../store/chatStore";

type LiveSnapshot = {
  cwd: string | null;
  terminalPrivate: boolean;
  workspaceRoot: string | null;
  activeFile: string | null;
  sshSessionId: number | null;
  sshConnection: string | null;
  terminalOutput: string | null;
};

const makeLive = (over: Partial<LiveSnapshot> = {}): LiveSnapshot => ({
  cwd: null,
  terminalPrivate: false,
  workspaceRoot: null,
  activeFile: null,
  sshSessionId: null,
  sshConnection: null,
  terminalOutput: null,
  ...over,
});

describe("formatEnvBlock — env 上下文块生成", () => {
  it("空 live 返回 null（无上下文可注入）", () => {
    expect(formatEnvBlock(makeLive())).toBeNull();
  });

  it("注入 cwd + workspaceRoot + activeFile", () => {
    const block = formatEnvBlock(
      makeLive({
        cwd: "/etc/nginx",
        workspaceRoot: "/home/user",
        activeFile: "/etc/nginx/nginx.conf",
      }),
    );
    expect(block).toContain("<env>");
    expect(block).toContain("workspace_root: /home/user");
    expect(block).toContain("active_terminal_cwd: /etc/nginx");
    expect(block).toContain("active_file: /etc/nginx/nginx.conf");
    expect(block).toContain("</env>");
  });

  it("terminalPrivate 注入 private 标记", () => {
    const block = formatEnvBlock(makeLive({ terminalPrivate: true }));
    expect(block).toContain("active_terminal_mode: private");
  });

  it("sshConnection 注入 connected_to（友好格式 user@host）", () => {
    const block = formatEnvBlock(
      makeLive({ sshConnection: "root@192.168.45.130" }),
    );
    expect(block).toContain("connected_to: root@192.168.45.130");
    // 不应再泄露内部 session id 数字
    expect(block).not.toContain("ssh_session_id");
  });

  it("sshConnection 为 null 时不注入 connected_to", () => {
    const block = formatEnvBlock(
      makeLive({ cwd: "/tmp", sshConnection: null }),
    );
    expect(block).not.toContain("connected_to");
  });
});

describe("formatTerminalContextBlock — 终端尾部输出注入", () => {
  it("空 terminalOutput 返回 null", () => {
    expect(formatTerminalContextBlock(makeLive())).toBeNull();
  });

  it("短输出原样注入 <terminal-context> 块", () => {
    const block = formatTerminalContextBlock(
      makeLive({ terminalOutput: "$ ls\nfile1 file2" }),
    );
    expect(block).toContain("<terminal-context>");
    expect(block).toContain("$ ls");
    expect(block).toContain("file1 file2");
    expect(block).toContain("</terminal-context>");
  });

  it("超过 30 行截取尾部", () => {
    const long = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
    const block = formatTerminalContextBlock(
      makeLive({ terminalOutput: long }),
    );
    expect(block).toContain("line 49");
    expect(block).toContain("line 20");
    expect(block).not.toContain("line 19");
    expect(block).not.toContain("line 0");
  });
});

describe("stripContextBlock — terminal-context 块剥离", () => {
  it("剥离前缀 terminal-context 块", () => {
    const input =
      "<terminal-context>cwd: /a\n</terminal-context>\nuser question";
    expect(stripContextBlock(input)).toBe("user question");
  });

  it("无块时原样返回", () => {
    expect(stripContextBlock("hello")).toBe("hello");
  });
});

describe("CONTEXT_BLOCK_RE — 正则匹配", () => {
  it("匹配标准 terminal-context 块", () => {
    expect(CONTEXT_BLOCK_RE.test("<terminal-context>abc</terminal-context>")).toBe(
      true,
    );
  });

  it("匹配带属性的 terminal-context 块", () => {
    expect(
      CONTEXT_BLOCK_RE.test('<terminal-context kind="ssh">abc</terminal-context>'),
    ).toBe(true);
  });

  it("不匹配普通文本", () => {
    expect(CONTEXT_BLOCK_RE.test("plain text")).toBe(false);
  });
});

// ============================================================================
// TDSF B1 (2026-08-29): <environment> / <terminal-history> 分区
// ============================================================================

const makeProbe = (over: Partial<EnvironmentProbe> = {}): EnvironmentProbe => ({
  ok: true,
  os_pretty_name: "CentOS Linux 7 (Core)",
  kernel: "3.10.0-1160.el7.x86_64",
  shell: "/bin/bash",
  source: "ssh",
  ...over,
});

const makeBlock = (over: Partial<TerminalBlock> = {}): TerminalBlock => ({
  id: "tb-1-1",
  sessionId: 1,
  command: "systemctl status nginx",
  cwd: "/etc/nginx",
  exitCode: 3,
  durationMs: 12000,
  author: "user",
  outputTail: "Active: failed (Result: exit-code)",
  startedAt: 1000,
  ...over,
});

describe("formatEnvironmentBlock — <environment> 分区", () => {
  it("输出连接模式（置顶）+ 发行版/内核/cwd/shell", () => {
    const block = formatEnvironmentBlock(
      makeProbe(),
      makeLive({ cwd: "/etc/nginx", sshConnection: "root@192.168.45.130" }),
    );
    expect(block).toContain("<environment>");
    // TDSF 2026-08-31 (任务C 环境感知): connection_mode 置顶 + ssh_target
    expect(block).toContain("connection_mode: ssh");
    expect(block).toContain("ssh_target: root@192.168.45.130");
    expect(block).toContain("os_pretty_name: CentOS Linux 7 (Core)");
    expect(block).toContain("kernel: 3.10.0-1160.el7.x86_64");
    expect(block).toContain("cwd: /etc/nginx");
    expect(block).toContain("shell: /bin/bash");
    expect(block).toContain("</environment>");
    // 连接模式是首行（agent 优先读到环境口径）
    expect(block?.indexOf("connection_mode")).toBeLessThan(
      block?.indexOf("os_pretty_name") ?? Infinity,
    );
  });

  it("无 SSH 连接 → connection_mode: local，无 ssh_target", () => {
    const block = formatEnvironmentBlock(
      makeProbe(),
      makeLive({ cwd: "C:\\proj", sshConnection: null }),
    );
    expect(block).toContain("connection_mode: local");
    expect(block).not.toContain("ssh_target");
  });

  it("probe=null（探测失败降级）返回 null", () => {
    expect(formatEnvironmentBlock(null, makeLive())).toBeNull();
  });

  it("probe.ok=false 返回 null", () => {
    expect(
      formatEnvironmentBlock(makeProbe({ ok: false }), makeLive()),
    ).toBeNull();
  });

  it("字段全空的 probe 仍输出 connection_mode（环境口径兜底）", () => {
    // TDSF 2026-08-31: probe ok 但字段全空时，connection_mode 仍有价值
    // （agent 至少知道本地/SSH 口径）；其余字段省略
    const block = formatEnvironmentBlock(
      makeProbe({ os_pretty_name: "", kernel: "", shell: "" }),
      makeLive(),
    );
    expect(block).toContain("<environment>");
    expect(block).toContain("connection_mode: local");
    expect(block).not.toContain("os_pretty_name");
  });
});

describe("formatTerminalHistoryBlock — <terminal-history> 分区", () => {
  it("空 block 列表返回 null", () => {
    expect(formatTerminalHistoryBlock([])).toBeNull();
  });

  it("格式化 user/agent 标记 + exit/duration/cwd + 输出尾部", () => {
    const block = formatTerminalHistoryBlock([
      makeBlock(),
      makeBlock({
        id: "tb-1-2",
        command: "yum install httpd -y",
        author: "agent",
        exitCode: 0,
        durationMs: 45000,
        cwd: "/root",
        outputTail: "Complete!\nInstalled:\n  httpd",
      }),
    ]);
    expect(block).toContain("<terminal-history>");
    expect(block).toContain(
      "- [user] $ systemctl status nginx (exit 3, 12s, cwd=/etc/nginx)",
    );
    expect(block).toContain(
      "- [agent] $ yum install httpd -y (exit 0, 45s, cwd=/root)",
    );
    // 输出尾部只取最后 2 行
    expect(block).toContain("Installed: / httpd");
    expect(block).not.toContain("Complete!");
    expect(block).toContain("</terminal-history>");
  });

  it("exitCode=null 显示 exit ?", () => {
    const block = formatTerminalHistoryBlock([makeBlock({ exitCode: null })]);
    expect(block).toContain("(exit ?,");
  });

  it("超过 10 条只注入最近 10 条", () => {
    const blocks = Array.from({ length: 15 }, (_, i) =>
      makeBlock({ id: `tb-1-${i}`, command: `cmd${i}` }),
    );
    const block = formatTerminalHistoryBlock(blocks);
    expect(block).toContain("cmd14");
    expect(block).toContain("cmd5");
    expect(block).not.toContain("cmd4\n");
    expect(block).not.toContain("$ cmd4 ");
    expect(block).not.toContain("cmd0");
    expect(TERMINAL_HISTORY_MAX_BLOCKS).toBe(10);
  });

  it("超 token 预算从最旧开始丢（保留最近）", () => {
    const blocks = Array.from({ length: 12 }, (_, i) =>
      makeBlock({
        id: `tb-1-${i}`,
        command: `run-${i}-${"x".repeat(600)}`,
        outputTail: "",
      }),
    );
    const block = formatTerminalHistoryBlock(blocks)!;
    const body = block.slice("<terminal-history>\n".length, -"\n</terminal-history>".length);
    expect(body.length).toBeLessThanOrEqual(6000);
    expect(block).toContain("run-11-");
    // 最旧的被丢掉
    expect(block).not.toContain("run-0-");
  });

  it("单行超长输出截断到 160 字符", () => {
    const longTail = "y".repeat(400);
    const block = formatTerminalHistoryBlock([makeBlock({ outputTail: longTail })]);
    expect(block).toContain(`${"y".repeat(160)}…`);
    expect(block).not.toContain("y".repeat(200));
  });
});
