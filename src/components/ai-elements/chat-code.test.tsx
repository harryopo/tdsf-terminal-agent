/**
 * chat-code.test.tsx — 代码块流式渲染测试（2026-09-02 UI P0-4）
 * -----------------------------------------------------------------------------
 * 钉住修复：流式期间此前整体隐藏代码内容（只显示 Generating 占位），
 * 而本项目回答的主体常是 shell 命令 → 长答案看起来一片空白。
 * 现在流式期间照常渲染纯文本代码，只跳过语法高亮。
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

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
