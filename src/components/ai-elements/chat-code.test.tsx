/**
 * chat-code.test.tsx — 代码块流式渲染测试（2026-09-02 UI P0-4）
 * -----------------------------------------------------------------------------
 * 钉住修复：流式期间此前整体隐藏代码内容（只显示 Generating 占位），
 * 而本项目回答的主体常是 shell 命令 → 长答案看起来一片空白。
 * 现在流式期间照常渲染纯文本代码，只跳过语法高亮。
 */
import { beforeEach, describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { __resetAutoTypeLedger } from "@/modules/ai/lib/autoTypeLedger";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useChatStore } from "@/modules/ai/store/chatStore";
import { ChatCodeBlock, ChatStreamingProvider } from "./chat-code";

function renderBlock(
  code: string,
  lang: string | null,
  streaming: boolean,
) {
  return render(
    <ChatStreamingProvider value={streaming}>
      <ChatCodeBlock code={code} lang={lang} />
    </ChatStreamingProvider>,
  );
}

describe("ChatCodeBlock — 流式期间", () => {
  it("已有代码内容 → 直接可见（不再被占位挡住）", () => {
    const { container } = renderBlock(
      "systemctl status nginx",
      "bash",
      true,
    );
    expect(container.textContent).toContain("systemctl status nginx");
    expect(container.textContent).not.toContain("Generating");
  });

  it("尚未收到任何字符 → 显示生成中占位", () => {
    const { container } = renderBlock("", "bash", true);
    expect(container.textContent).toContain("Generating");
  });

  it("多行代码逐行保留（pre 不做高亮但保留换行）", () => {
    const { container } = renderBlock("ps aux\nss -tlnp", "bash", true);
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toBe("ps aux\nss -tlnp");
  });
});

describe("ChatCodeBlock — 流式结束后", () => {
  it("shell 语言 → 渲染命令卡（带 Run in terminal）", () => {
    renderBlock("uptime", "bash", false);
    expect(
      screen.getByRole("button", { name: "Run in active terminal" }),
    ).toBeTruthy();
  });

  it("非 shell 语言 → 渲染带语言标签的代码块", () => {
    const { container } = renderBlock("location / { proxy_pass 127.0.0.1; }", "nginx", false);
    expect(container.textContent).toContain("nginx");
    expect(container.textContent).toContain("proxy_pass");
  });
});

// ============================================================================
// 命令卡自动注入（打字机“自动打字+自动执行”，2026-09-02 用户钦定）
// ============================================================================
describe("ChatCodeBlock — 命令卡自动注入终端", () => {
  const originalLive = useChatStore.getState().live;
  const originalAutoType = usePreferencesStore.getState().agentAutoTypeCommands;
  const originalAgentMode = useChatStore.getState().agentMode;
  const originalTeach = useChatStore.getState().teach;

  beforeEach(() => {
    // ledger 是模块级的（防重挂重放/同批互踩），逐例重置避免相互污染。
    __resetAutoTypeLedger();
    usePreferencesStore.setState({ agentAutoTypeCommands: true });
    // 闸门默认放行：本组用例测的是命令卡决策逻辑，闸门自身另有用例。
    useChatStore.setState((s) => ({
      live: {
        ...s.live,
        isActiveTerminalPrivate: () => false,
        canAutoTypeToActiveTerminal: () => true,
      },
    }));
  });

  afterEach(() => {
    useChatStore.setState({
      live: originalLive,
      agentMode: originalAgentMode,
      teach: originalTeach,
    });
    usePreferencesStore.setState({ agentAutoTypeCommands: originalAutoType });
    vi.restoreAllMocks();
  });

  it("自动打字开启 + auto 模式 → shell 命令卡渲染后自动注入 code+\\n（自动执行）", () => {
    const inject = vi.fn(() => true);
    useChatStore.setState({ agentMode: "auto" });
    useChatStore.setState((s) => ({
      live: { ...s.live, injectIntoActivePty: inject },
    }));
    renderBlock("uptime", "bash", false);
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject).toHaveBeenCalledWith("uptime\n");
  });

  it("确认模式 → 自动打字但不追加 \\n（执行权留给用户，不绕过审批）", () => {
    const inject = vi.fn(() => true);
    useChatStore.setState({ agentMode: "confirm" });
    useChatStore.setState((s) => ({
      live: { ...s.live, injectIntoActivePty: inject },
    }));
    renderBlock("uptime", "bash", false);
    // 2026-09-18 用户钦定：命令自动输出到终端，无需点 Run；
    // 但只有 auto 模式追加 \n，确认模式打字后由用户自己回车。
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject).toHaveBeenCalledWith("uptime");
    // 手动 Run 按钮仍在（重跑/换终端用）
    expect(
      screen.getByRole("button", { name: "Run in active terminal" }),
    ).toBeTruthy();
  });

  it("观察模式 → 同样自动打字不追加 \\n", () => {
    const inject = vi.fn(() => true);
    useChatStore.setState({ agentMode: "observe" });
    useChatStore.setState((s) => ({
      live: { ...s.live, injectIntoActivePty: inject },
    }));
    renderBlock("uptime", "bash", false);
    expect(inject).toHaveBeenCalledWith("uptime");
  });

  it("自动打字偏好关闭 → 不自动注入（保留手动 Run）", () => {
    const inject = vi.fn(() => true);
    usePreferencesStore.setState({ agentAutoTypeCommands: false });
    useChatStore.setState((s) => ({
      live: { ...s.live, injectIntoActivePty: inject },
    }));
    renderBlock("uptime", "bash", false);
    expect(inject).not.toHaveBeenCalled();
    // 手动 Run 按钮仍在
    expect(
      screen.getByRole("button", { name: "Run in active terminal" }),
    ).toBeTruthy();
  });

  it("流式期间 → 不渲染命令卡也不自动注入", () => {
    const inject = vi.fn(() => true);
    useChatStore.setState((s) => ({
      live: { ...s.live, injectIntoActivePty: inject },
    }));
    renderBlock("uptime", "bash", true);
    expect(inject).not.toHaveBeenCalled();
  });

  it("教学模式（teach=true）→ 自动打字但绝不追加 \\n，执行仍由学生自己回车", () => {
    const inject = vi.fn(() => true);
    useChatStore.setState({
      agentMode: "auto",
      teach: true,
    });
    useChatStore.setState((s) => ({
      live: { ...s.live, injectIntoActivePty: inject },
    }));
    renderBlock("uptime", "bash", false);
    // 2026-09-18 用户钦定：教学模式同样自动输出命令到终端。
    expect(inject).toHaveBeenCalledTimes(1);
    // 但 teach 下永不追加 \n —— 即便 agentMode==="auto"，执行权归学生。
    expect(inject).toHaveBeenCalledWith("uptime");
    // 手动 Run 在 teach 下也只粘贴，不自动执行。
    fireEvent.click(
      screen.getByRole("button", { name: "Run in active terminal" }),
    );
    expect(inject).toHaveBeenCalledTimes(2);
    expect(inject).toHaveBeenLastCalledWith("uptime");
  });

  it("非教学模式行为不变：autoExecuteInTerminal 开启 + auto 模式下手动 Run 仍自动执行（code+\\n）", () => {
    const inject = vi.fn(() => true);
    useChatStore.setState({
      agentMode: "auto",
      teach: false,
    });
    useChatStore.setState((s) => ({
      live: { ...s.live, injectIntoActivePty: inject },
    }));
    renderBlock("uptime", "bash", false);
    fireEvent.click(
      screen.getByRole("button", { name: "Run in active terminal" }),
    );
    expect(inject).toHaveBeenCalledWith("uptime\n");
  });

  // ==========================================================================
  // 代码审查加固（2026-09-18）：Private 终端 / 同批多卡互踩 / 重挂重放
  // ==========================================================================

  it("自动打字闸门拒绝（Private/脏行/非提示符）→ 不自动打字，手动 Run 仍可用", () => {
    const inject = vi.fn(() => true);
    useChatStore.setState({ agentMode: "auto" });
    useChatStore.setState((s) => ({
      live: {
        ...s.live,
        canAutoTypeToActiveTerminal: () => false,
        injectIntoActivePty: inject,
      },
    }));
    renderBlock("uptime", "bash", false);
    expect(inject).not.toHaveBeenCalled();
    // 手动 Run 是用户明示动作，不受闸门限制
    fireEvent.click(
      screen.getByRole("button", { name: "Run in active terminal" }),
    );
    expect(inject).toHaveBeenCalledTimes(1);
  });

  it("一条回复含多个代码块 → 同一 commit 内只有第一张卡自动打字（不拼接/不互清）", () => {
    const inject = vi.fn(() => true);
    useChatStore.setState({ agentMode: "confirm" });
    useChatStore.setState((s) => ({
      live: { ...s.live, isActiveTerminalPrivate: () => false, injectIntoActivePty: inject },
    }));
    render(
      <>
        <ChatStreamingProvider value={false}>
          <ChatCodeBlock code="ls -la" lang="bash" />
        </ChatStreamingProvider>
        <ChatStreamingProvider value={false}>
          <ChatCodeBlock code="cd /tmp" lang="bash" />
        </ChatStreamingProvider>
      </>,
    );
    // 若两张都注入，整段路径会拼成 "ls -lacd /tmp"、逐字路径会互相 \x03 清行
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject).toHaveBeenCalledWith("ls -la");
  });

  it("重挂同一命令卡（重开小窗重放历史）→ 不再自动打字", () => {
    const inject = vi.fn(() => true);
    useChatStore.setState({ agentMode: "auto" });
    useChatStore.setState((s) => ({
      live: { ...s.live, isActiveTerminalPrivate: () => false, injectIntoActivePty: inject },
    }));
    const first = renderBlock("systemctl restart nginx", "bash", false);
    expect(inject).toHaveBeenCalledTimes(1);
    // auto 模式下重挂会**重新执行**旧命令，这是必须堵住的路径
    first.unmount();
    renderBlock("systemctl restart nginx", "bash", false);
    expect(inject).toHaveBeenCalledTimes(1);
  });
});

// ============================================================================
// 深度体检 S-01（2026-09-18，P0）：多行块在"只打字不回车"的模式下不能整段写进 PTY
// ----------------------------------------------------------------------------
// PTY 把每一个 \n 都当回车，所以 `execute=false` 时整段多行命令一旦写入，
// 除最后一行外的每一行都会**立即真实执行** —— 既不经审批卡也不经风险闸门，
// 等于把"非 auto 模式永不执行"这条产品承诺从结构上打破。
// ============================================================================
describe("ChatCodeBlock — 多行命令块不得在非 auto 模式下自动打字（S-01）", () => {
  const originalLive = useChatStore.getState().live;
  const originalAutoType = usePreferencesStore.getState().agentAutoTypeCommands;
  const originalAgentMode = useChatStore.getState().agentMode;
  const originalTeach = useChatStore.getState().teach;

  beforeEach(() => {
    __resetAutoTypeLedger();
    usePreferencesStore.setState({ agentAutoTypeCommands: true });
    useChatStore.setState((s) => ({
      live: {
        ...s.live,
        isActiveTerminalPrivate: () => false,
        canAutoTypeToActiveTerminal: () => true,
      },
    }));
  });

  afterEach(() => {
    useChatStore.setState({
      live: originalLive,
      agentMode: originalAgentMode,
      teach: originalTeach,
    });
    usePreferencesStore.setState({ agentAutoTypeCommands: originalAutoType });
    vi.restoreAllMocks();
  });

  const MULTI = "for f in *.log; do\n  gzip \"$f\"\ndone";

  it.each(["confirm", "observe"] as const)(
    "%s 模式：多行 bash 块零注入（换行会被 shell 逐行执行）",
    (mode) => {
      const inject = vi.fn(() => true);
      useChatStore.setState({ agentMode: mode, teach: false });
      useChatStore.setState((s) => ({
        live: { ...s.live, injectIntoActivePty: inject },
      }));
      renderBlock(MULTI, "bash", false);
      expect(inject).not.toHaveBeenCalled();
    },
  );

  it("教学档：多行块同样不注入（学生自己粘贴、自己回车）", () => {
    const inject = vi.fn(() => true);
    useChatStore.setState({ agentMode: "observe", teach: true });
    useChatStore.setState((s) => ({ live: { ...s.live, injectIntoActivePty: inject } }));
    renderBlock(MULTI, "bash", false);
    expect(inject).not.toHaveBeenCalled();
  });

  it("单行命令在 confirm 档仍然自动打字（不回归本功能的初衷）", () => {
    const inject = vi.fn((_text: string) => true);
    useChatStore.setState({ agentMode: "confirm", teach: false });
    useChatStore.setState((s) => ({ live: { ...s.live, injectIntoActivePty: inject } }));
    renderBlock("systemctl status nginx", "bash", false);
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject.mock.calls[0][0]).toBe("systemctl status nginx");
    expect(inject.mock.calls[0][0]).not.toContain("\n");
  });
});
