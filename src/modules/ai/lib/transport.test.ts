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
} from "./transport";

type LiveSnapshot = {
  cwd: string | null;
  terminalPrivate: boolean;
  workspaceRoot: string | null;
  activeFile: string | null;
  sshSessionId: number | null;
  terminalOutput: string | null;
};

const makeLive = (over: Partial<LiveSnapshot> = {}): LiveSnapshot => ({
  cwd: null,
  terminalPrivate: false,
  workspaceRoot: null,
  activeFile: null,
  sshSessionId: null,
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

  it("sshSessionId 注入 ssh_session_id（LLM 感知 SSH 会话）", () => {
    const block = formatEnvBlock(makeLive({ sshSessionId: 7 }));
    expect(block).toContain("ssh_session_id: 7");
  });

  it("sshSessionId 为 null 时不注入", () => {
    const block = formatEnvBlock(makeLive({ cwd: "/tmp", sshSessionId: null }));
    expect(block).not.toContain("ssh_session_id");
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
