/**
 * chat-code.test.tsx — 代码块流式渲染测试（2026-09-02 UI P0-4）
 * -----------------------------------------------------------------------------
 * 钉住修复：流式期间此前整体隐藏代码内容（只显示 Generating 占位），
 * 而本项目回答的主体常是 shell 命令 → 长答案看起来一片空白。
 * 现在流式期间照常渲染纯文本代码，只跳过语法高亮。
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

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
  const originalAutoExec = useChatStore.getState().autoExecuteInTerminal;
  const originalAgentMode = useChatStore.getState().agentMode;
  const originalTeach = useChatStore.getState().teach;

  afterEach(() => {
    useChatStore.setState({
      live: originalLive,
      autoExecuteInTerminal: originalAutoExec,
      agentMode: originalAgentMode,
      teach: originalTeach,
    });
    vi.restoreAllMocks();
  });

  it("autoExecuteInTerminal 开启 + auto 模式 → shell 命令卡渲染后自动注入 code+\\n（自动执行）", () => {
    const inject = vi.fn(() => true);
    useChatStore.setState({ autoExecuteInTerminal: true, agentMode: "auto" });
    useChatStore.setState((s) => ({
      live: { ...s.live, injectIntoActivePty: inject },
    }));
    renderBlock("uptime", "bash", false);
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject).toHaveBeenCalledWith("uptime\n");
  });

  it("问题2：autoExecuteInTerminal 开启但确认模式 → 不自动注入（须用户点 Run/审批）", () => {
    const inject = vi.fn(() => true);
    useChatStore.setState({ autoExecuteInTerminal: true, agentMode: "confirm" });
    useChatStore.setState((s) => ({
      live: { ...s.live, injectIntoActivePty: inject },
    }));
    renderBlock("uptime", "bash", false);
    // 确认模式不自动执行（绕过 HITL 审批是安全 bug）
    expect(inject).not.toHaveBeenCalled();
    // 手动 Run 按钮仍在
    expect(
      screen.getByRole("button", { name: "Run in active terminal" }),
    ).toBeTruthy();
  });

  it("autoExecuteInTerminal 关闭 → 不自动注入（保留手动 Run）", () => {
    const inject = vi.fn(() => true);
    useChatStore.setState({ autoExecuteInTerminal: false });
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
    useChatStore.setState({ autoExecuteInTerminal: true });
    useChatStore.setState((s) => ({
      live: { ...s.live, injectIntoActivePty: inject },
    }));
    renderBlock("uptime", "bash", true);
    expect(inject).not.toHaveBeenCalled();
  });

  it("教学模式（teach=true）→ 自动注入失效（偏好视为 false），学生手动逐条执行", () => {
    const inject = vi.fn(() => true);
    useChatStore.setState({
      autoExecuteInTerminal: true,
      agentMode: "auto",
      teach: true,
    });
    useChatStore.setState((s) => ({
      live: { ...s.live, injectIntoActivePty: inject },
    }));
    renderBlock("uptime", "bash", false);
    // 教学模式禁止自动插入终端
    expect(inject).not.toHaveBeenCalled();
    // 手动 Run 仍在：点击后只粘贴命令本身（不带 \n，不自动执行）
    fireEvent.click(
      screen.getByRole("button", { name: "Run in active terminal" }),
    );
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject).toHaveBeenCalledWith("uptime");
  });

  it("非教学模式行为不变：autoExecuteInTerminal 开启 + auto 模式下手动 Run 仍自动执行（code+\\n）", () => {
    const inject = vi.fn(() => true);
    useChatStore.setState({
      autoExecuteInTerminal: true,
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
});
