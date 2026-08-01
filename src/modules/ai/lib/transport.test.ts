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
  stripContextBlock,
} from "./transport";

type LiveSnapshot = {
  cwd: string | null;
  terminalPrivate: boolean;
  workspaceRoot: string | null;
  activeFile: string | null;
  sshSessionId: number | null;
};

const makeLive = (over: Partial<LiveSnapshot> = {}): LiveSnapshot => ({
  cwd: null,
  terminalPrivate: false,
  workspaceRoot: null,
  activeFile: null,
  sshSessionId: null,
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
