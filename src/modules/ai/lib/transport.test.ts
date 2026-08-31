/**
 * transport.test.ts — 上下文感知 transport 核心逻辑测试
 * -----------------------------------------------------------------------------
 * 覆盖（P0-5 补测试）:
 *   1. formatEnvBlock: env 块生成（cwd/activeFile/workspaceRoot/private/ssh）
 *   2. stripContextBlock: terminal-context 块剥离
 *   3. formatEnvBlock 空 live 返回 null
 *   4. T4 (2026-08-31, spec add-agent-loop-closure): 每轮记忆主动召回——
 *      <recalled-memory> 格式化 / 与首轮 <session-memory> 去重 / 3s 超时跳过
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// T4 记忆召回测试需要 mock Tauri invoke（检索走 knowledge.search_full）。
// mock 必须在 import 之前（vitest 自动 hoist）；纯函数用例不受影响
// （formatEnvBlock 等不触达 invoke）。
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
import {
  CONTEXT_BLOCK_RE,
  formatEnvBlock,
  formatTerminalContextBlock,
  stripContextBlock,
  // TDSF B1 (2026-08-29): <environment> / <terminal-history> 分区
  formatEnvironmentBlock,
  formatTerminalHistoryBlock,
  TERMINAL_HISTORY_MAX_BLOCKS,
  // TDSF 2026-08-31 (问题1修复): connection_mode 三态判定
  resolveConnectionMode,
  // T4 (2026-08-31): 每轮记忆主动召回
  fetchRecalledMemory,
  formatMemoryHintBlock,
  type KnowledgeSearchResult,
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
  terminalSession?: "ssh" | "local" | "none" | null;
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
        terminalSession: "local",
      }),
    );
    expect(block).toContain("<env>");
    expect(block).toContain("workspace_root: /home/user");
    expect(block).toContain("active_terminal_cwd: /etc/nginx");
    expect(block).toContain("active_file: /etc/nginx/nginx.conf");
    expect(block).toContain("</env>");
  });

  it("无终端会话（none）时不注入 active_terminal_cwd（默认工作区路径非终端 cwd）", () => {
    // TDSF 2026-08-31 (问题1修复): 用户没开终端时 findCwd() 回退到
    // explorerRoot/launchCwd/home（如 C:/Users/Administrator）——把它标注成
    // "active_terminal_cwd" 正是 agent 误称"本地终端已打开"的误导源
    const block = formatEnvBlock(
      makeLive({
        cwd: "C:/Users/Administrator",
        workspaceRoot: "C:/Users/Administrator",
        terminalSession: "none",
      }),
    );
    expect(block).toContain("workspace_root: C:/Users/Administrator");
    expect(block).not.toContain("active_terminal_cwd");
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
      makeLive({ cwd: "/tmp", sshConnection: null, terminalSession: "local" }),
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

  it("无 SSH 连接但本地终端已打开 → connection_mode: local，无 ssh_target", () => {
    const block = formatEnvironmentBlock(
      makeProbe(),
      makeLive({ cwd: "C:\\proj", sshConnection: null, terminalSession: "local" }),
    );
    expect(block).toContain("connection_mode: local");
    expect(block).toContain("cwd: C:\\proj");
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
    // （agent 至少知道本地/SSH/无终端口径）；其余字段省略
    const block = formatEnvironmentBlock(
      makeProbe({ os_pretty_name: "", kernel: "", shell: "" }),
      makeLive({ terminalSession: "local" }),
    );
    expect(block).toContain("<environment>");
    expect(block).toContain("connection_mode: local");
    expect(block).not.toContain("os_pretty_name");
  });

  it("无活动终端会话 → connection_mode: none + 说明行，cwd 标注为 workspace_path", () => {
    // TDSF 2026-08-31 (问题1修复): 用户没选工作区/没开终端时，此前误报
    // "local"（把默认 workspace cwd 当成"本地终端已打开"），agent 遂断言
    // "当前环境是 Windows 本地终端"。现显式标 none 并说明。
    const block = formatEnvironmentBlock(
      makeProbe(),
      makeLive({
        cwd: "C:/Users/Administrator",
        workspaceRoot: "C:/Users/Administrator",
        terminalSession: "none",
      }),
    );
    expect(block).toContain("connection_mode: none");
    expect(block).toContain(
      "note: 当前未打开任何终端会话（workspace 仅为默认工作区路径，不代表终端已打开）",
    );
    // 默认工作区路径不再伪装成终端 cwd
    expect(block).toContain(
      "workspace_path: C:/Users/Administrator",
    );
    expect(block).not.toContain("cwd: C:/Users/Administrator");
    expect(block).not.toContain("ssh_target");
  });

  it("terminalSession=ssh 但 sshConnection 未取到时仍判为 ssh", () => {
    const block = formatEnvironmentBlock(
      makeProbe(),
      makeLive({ terminalSession: "ssh", sshConnection: null }),
    );
    expect(block).toContain("connection_mode: ssh");
    expect(block).not.toContain("ssh_target");
  });
});

describe("resolveConnectionMode — 连接模式三态判定（问题1）", () => {
  it("sshConnection 存在 → ssh", () => {
    expect(
      resolveConnectionMode(
        makeLive({ sshConnection: "root@1.2.3.4", terminalSession: null }),
      ),
    ).toBe("ssh");
  });

  it("terminalSession=ssh（sshConnection 未取到）→ ssh", () => {
    expect(
      resolveConnectionMode(makeLive({ terminalSession: "ssh" })),
    ).toBe("ssh");
  });

  it("terminalSession=local → local", () => {
    expect(
      resolveConnectionMode(
        makeLive({ terminalSession: "local", cwd: "C:/x" }),
      ),
    ).toBe("local");
  });

  it("terminalSession=none（即使有默认 workspace cwd）→ none", () => {
    expect(
      resolveConnectionMode(
        makeLive({
          terminalSession: "none",
          cwd: "C:/Users/Administrator",
          workspaceRoot: "C:/Users/Administrator",
        }),
      ),
    ).toBe("none");
  });

  it("terminalSession 未注入（旧调用方）回退：有终端输出 → local", () => {
    expect(
      resolveConnectionMode(
        makeLive({ terminalOutput: "$ ls", terminalSession: undefined }),
      ),
    ).toBe("local");
  });

  it("terminalSession 未注入且无终端输出 → none（不再把 workspace cwd 当本地终端）", () => {
    expect(
      resolveConnectionMode(
        makeLive({
          terminalSession: undefined,
          cwd: "C:/Users/Administrator",
        }),
      ),
    ).toBe("none");
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

// ============================================================================
// T4 (2026-08-31, spec add-agent-loop-closure Task 4): 每轮记忆主动召回
// ============================================================================

const makeEntry = (
  over: Partial<KnowledgeSearchResult> = {},
): KnowledgeSearchResult => ({
  id: "case-1",
  source: "session-case",
  title: "案例：nginx 502 排障",
  content: "## 现象\n502 Bad Gateway\n## 结论\nupstream 超时",
  ...over,
});

describe("formatMemoryHintBlock — T4 召回块格式化", () => {
  it("recalled kind 输出 <recalled-memory> 块（标题 + 内容 + ids）", () => {
    const r = formatMemoryHintBlock([makeEntry()], {
      kind: "recalled",
      topK: 3,
    });
    expect(r).not.toBeNull();
    expect(r!.block).toContain("<recalled-memory>");
    // 标注"自动召回"——与首轮 <session-memory>（会话级摘要）明确区分
    expect(r!.block).toContain("相关历史案例（自动召回）");
    expect(r!.block).toContain("《案例：nginx 502 排障》");
    expect(r!.block).toContain("502 Bad Gateway");
    expect(r!.block).toContain("</recalled-memory>");
    expect(r!.ids).toEqual(["case-1"]);
  });

  it("与首轮 <session-memory> 职责区分：session kind 保持 T14 标签与文案", () => {
    const r = formatMemoryHintBlock([makeEntry()], {
      kind: "session",
      topK: 3,
    });
    expect(r!.block).toContain("<session-memory>");
    expect(r!.block).not.toContain("<recalled-memory>");
    expect(r!.block).toContain("过往会话沉淀的相关记忆");
    expect(r!.block).toContain("</session-memory>");
  });

  it("空结果不注入 → null（分区整体省略）", () => {
    expect(
      formatMemoryHintBlock([], { kind: "recalled", topK: 3 }),
    ).toBeNull();
  });

  it("与首轮去重：excludeIds 命中即跳过；全命中 → null", () => {
    // 部分命中：只注入未命中的条目
    const r = formatMemoryHintBlock(
      [makeEntry({ id: "a" }), makeEntry({ id: "b" })],
      { kind: "recalled", topK: 3, excludeIds: new Set(["a"]) },
    );
    expect(r).not.toBeNull();
    expect(r!.ids).toEqual(["b"]);
    // 全部命中去重 → 不注入（不输出空块）
    expect(
      formatMemoryHintBlock([makeEntry({ id: "a" })], {
        kind: "recalled",
        topK: 3,
        excludeIds: new Set(["a"]),
      }),
    ).toBeNull();
  });

  it("topK 截断：超过上限只注入前 topK 条", () => {
    const entries = ["a", "b", "c", "d"].map((id) => makeEntry({ id }));
    const r = formatMemoryHintBlock(entries, { kind: "recalled", topK: 3 });
    expect(r!.ids).toEqual(["a", "b", "c"]);
  });

  it("单条内容超 220 字符截断加省略号", () => {
    const r = formatMemoryHintBlock(
      [makeEntry({ content: "x".repeat(300) })],
      { kind: "recalled", topK: 3 },
    );
    expect(r!.block).toContain(`${"x".repeat(220)}…`);
    expect(r!.block).not.toContain(`${"x".repeat(221)}`);
  });
});

describe("fetchRecalledMemory — 检索/超时/去重（mock invoke）", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("检索命中会话沉淀条目 → 返回 <recalled-memory> 块与 ids", async () => {
    vi.mocked(invoke).mockResolvedValue({
      results: [
        makeEntry({ id: "c1", source: "session-memory" }),
        // 非会话沉淀条目（教学语料）不注入
        makeEntry({ id: "c2", source: "linux-ops-doc" }),
      ],
    });
    const r = await fetchRecalledMemory("nginx 502 怎么排查", new Set());
    expect(r).not.toBeNull();
    expect(r!.ids).toEqual(["c1"]);
    expect(r!.block).toContain("<recalled-memory>");
    // 检索参数：query=当前消息 + limit=top3*2（source 过滤前的池子）
    expect(invoke).toHaveBeenCalledWith("ipc_invoke", {
      method: "knowledge.search_full",
      params: { query: "nginx 502 怎么排查", limit: 6 },
    });
  });

  it("3s 超时静默跳过 → null（不阻塞对话）", async () => {
    vi.useFakeTimers();
    // invoke 永不 resolve（模拟 sidecar 检索卡死）
    vi.mocked(invoke).mockImplementation(
      () => new Promise(() => {}) as never,
    );
    const pending = fetchRecalledMemory("查询", new Set());
    // 推进 3s 触发 Promise.race 超时分支
    await vi.advanceTimersByTimeAsync(3000);
    const r = await pending;
    expect(r).toBeNull();
  });

  it("检索失败（invoke reject）→ null（静默降级）", async () => {
    vi.mocked(invoke).mockRejectedValue(new Error("sidecar not ready"));
    expect(await fetchRecalledMemory("x", new Set())).toBeNull();
  });

  it("空文本（trim 后为空）不发起检索 → null", async () => {
    expect(await fetchRecalledMemory("   ", new Set())).toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("命中条目与 excludeIds（首轮已注入）全部重复 → null（去重生效）", async () => {
    vi.mocked(invoke).mockResolvedValue({
      results: [makeEntry({ id: "dup-1" })],
    });
    expect(
      await fetchRecalledMemory("nginx 502", new Set(["dup-1"])),
    ).toBeNull();
  });
});
