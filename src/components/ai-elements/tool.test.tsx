/**
 * tool.test.tsx — 四层审批卡测试（Task 3.1，方案书 v3.1 §4.4）
 * -----------------------------------------------------------------------------
 * 覆盖：
 *   1. 四层卡面自上而下：①语义描述 ②命令原文 ③解释 ④影响预测（类别+对象+L 色带）
 *   2. 解释缺失显示「（无解释）」；影响缺失显示「影响未知——请人工审查」
 *   3. 三按钮：拒绝（可展开附言）/ ⚡批准且本会话只读免审（仅 L0-L1）/ ▶执行
 *   4. L3/L4 无会话免审选项；denied / dangerous_construct 时 ⚡ 隐藏
 *   5. Tool 组件 approval-requested + onApprovalRespond → 渲染审批卡
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { Tool, ToolApprovalCard } from "./tool";

function renderCard(
  input: Record<string, unknown>,
  onRespond = vi.fn(),
): ReturnType<typeof render> {
  return render(
    <ToolApprovalCard toolName="ssh_command" input={input} onRespond={onRespond} />,
  );
}

const FULL_IMPACT = {
  summary: "操作服务：nginx",
  max_risk_l: 3,
  denied: false,
  dangerous_construct: false,
  segments: [
    {
      command: "systemctl restart nginx",
      category: "service",
      category_label: "操作服务",
      objects: ["nginx"],
      risk_l: 3,
      denied: false,
      dangerous_construct: false,
    },
  ],
};

describe("ToolApprovalCard — 四层卡面", () => {
  it("渲染四层：语义/命令原文/解释/影响预测", () => {
    renderCard({
      semantic: "想操作服务：nginx",
      command: "systemctl restart nginx",
      explanation: "重启 nginx 使新配置生效",
      impact: FULL_IMPACT,
      risk_l: 3,
    });
    // ① 语义
    expect(screen.getByText("想操作服务：nginx")).toBeTruthy();
    // ② 命令原文（永不改写）
    expect(screen.getByText("systemctl restart nginx")).toBeTruthy();
    // ③ 解释
    expect(screen.getByText("重启 nginx 使新配置生效")).toBeTruthy();
    // ④ 影响预测：摘要 + 类别标签 + 对象 + 风险色带
    expect(screen.getByText("影响预测")).toBeTruthy();
    expect(screen.getByText("操作服务：nginx")).toBeTruthy();
    expect(screen.getByText("L3 高风险")).toBeTruthy();
    expect(screen.getByText("nginx")).toBeTruthy();
  });

  it("解释缺失显示（无解释）", () => {
    renderCard({ semantic: "想删除文件：/tmp/a", command: "rm -rf /tmp/a", risk_l: 4 });
    expect(screen.getByText("（无解释）")).toBeTruthy();
  });

  it("影响缺失显示「影响未知——请人工审查」", () => {
    renderCard({ command: "./mystery.sh", risk_l: 3 });
    expect(screen.getByText("影响未知——请人工审查")).toBeTruthy();
  });

  it("semantic 缺失回退通用文案", () => {
    renderCard({ command: "ls" });
    expect(screen.getByText("Agent 请求执行操作")).toBeTruthy();
  });
});

describe("ToolApprovalCard — 三按钮", () => {
  it("执行按钮 → onRespond({approved:true})", () => {
    const onRespond = vi.fn();
    renderCard({ command: "uptime", risk_l: 0 }, onRespond);
    fireEvent.click(screen.getByText("执行"));
    expect(onRespond).toHaveBeenCalledWith({ approved: true });
  });

  it("L0/L1 显示 ⚡会话免审按钮 → onRespond({approved:true, sessionTrust:true})", () => {
    const onRespond = vi.fn();
    renderCard({ command: "uptime", risk_l: 1 }, onRespond);
    fireEvent.click(screen.getByText("批准且本会话只读免审"));
    expect(onRespond).toHaveBeenCalledWith({ approved: true, sessionTrust: true });
  });

  it("L3/L4 无会话免审按钮（永远逐条确认）", () => {
    renderCard({ command: "systemctl restart nginx", risk_l: 3, impact: FULL_IMPACT });
    expect(screen.queryByText("批准且本会话只读免审")).toBeNull();
    renderCard({ command: "rm -rf /tmp/a", risk_l: 4 });
    expect(screen.queryByText("批准且本会话只读免审")).toBeNull();
  });

  it("denied / dangerous_construct 时 ⚡ 隐藏（永不自动放行）", () => {
    renderCard({
      command: "ls",
      risk_l: 0,
      impact: { ...FULL_IMPACT, denied: true },
    });
    expect(screen.queryByText("批准且本会话只读免审")).toBeNull();
    renderCard({
      command: "echo $(x)",
      risk_l: 0,
      impact: { ...FULL_IMPACT, dangerous_construct: true },
    });
    expect(screen.queryByText("批准且本会话只读免审")).toBeNull();
  });

  it("拒绝 → 展开附言输入 → 确认拒绝携带附言", () => {
    const onRespond = vi.fn();
    renderCard({ command: "rm -rf /tmp/a", risk_l: 4 }, onRespond);
    fireEvent.click(screen.getByText("拒绝"));
    const textarea = screen.getByPlaceholderText(
      /告诉 Agent 为什么拒绝/,
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "先备份再删" } });
    fireEvent.click(screen.getByText("确认拒绝"));
    expect(onRespond).toHaveBeenCalledWith({ approved: false, note: "先备份再删" });
  });

  it("拒绝不填附言 → note 为 undefined", () => {
    const onRespond = vi.fn();
    renderCard({ command: "rm -rf /tmp/a", risk_l: 4 }, onRespond);
    fireEvent.click(screen.getByText("拒绝"));
    fireEvent.click(screen.getByText("确认拒绝"));
    expect(onRespond).toHaveBeenCalledWith({ approved: false, note: undefined });
  });
});

describe("Tool — approval-requested 分支", () => {
  it("提供 onApprovalRespond 时渲染四层审批卡", () => {
    const onRespond = vi.fn();
    render(
      <Tool
        toolName="ssh_command"
        state="approval-requested"
        input={{ command: "uptime", semantic: "想只读查询", risk_l: 0 }}
        onApprovalRespond={onRespond}
      />,
    );
    expect(screen.getByText("需要你的确认")).toBeTruthy();
    expect(screen.getByText("uptime")).toBeTruthy();
    fireEvent.click(screen.getByText("执行"));
    expect(onRespond).toHaveBeenCalledWith({ approved: true });
  });

  it("未提供 onApprovalRespond 时保持通用折叠卡（向后兼容）", () => {
    render(
      <Tool
        toolName="ssh_command"
        state="approval-requested"
        input={{ command: "uptime" }}
      />,
    );
    expect(screen.queryByText("需要你的确认")).toBeNull();
  });
});

describe("Tool — knowledge_search 知识卡片（TDSF 2026-08-31 双库）", () => {
  const SEARCH_OUTPUT = {
    status: "success",
    query: "systemctl 服务",
    count: 2,
    results: [
      {
        id: "slim-1",
        title: "systemctl 服务管理",
        content:
          "systemctl 是 systemd 的服务管理命令，restart 停止再启动，reload 平滑重载。",
        source: "systemd-docs",
        url: "consolidated/sys-admin/系统启动、内核与 systemd（Arch Wiki）.md",
        category: "sys-admin",
      },
      {
        id: "slim-2",
        title: "firewalld 防火墙",
        content: "firewall-cmd 是 firewalld 的管理命令。",
        source: "firewalld-docs",
        url: "consolidated/security/firewalld 防火墙.md",
        category: "security",
      },
    ],
  };

  it("渲染知识卡片列表：title + source 中文标签 + 摘要 + category 徽标", () => {
    render(
      <Tool
        toolName="knowledge_search"
        state="output-available"
        input={{ query: "systemctl 服务" }}
        output={SEARCH_OUTPUT}
        defaultOpen
      />,
    );
    expect(screen.getByText("systemctl 服务管理")).toBeTruthy();
    expect(screen.getByText("systemd 手册")).toBeTruthy();
    expect(screen.getByText("系统管理")).toBeTruthy();
    expect(screen.getByText("安全加固")).toBeTruthy();
    // 摘要（content 前 150 字内原文）
    expect(
      screen.getByText(/restart 停止再启动/),
    ).toBeTruthy();
    // 裸 JSON 不再出现（title 不以 JSON 形式整体渲染）
    // 注：JSX 插值把 "2 条结果" 拆为多文本节点，用 textContent 正则匹配
    expect(
      screen.getByText((_, el) => el?.textContent === "2 条结果 · 「systemctl 服务」"),
    ).toBeTruthy();
  });

  it("empty 状态渲染空态文案", () => {
    render(
      <Tool
        toolName="knowledge_search"
        state="output-available"
        input={{ query: "x" }}
        output={{ status: "empty", query: "x", count: 0, results: [] }}
        defaultOpen
      />,
    );
    expect(screen.getByText("知识库暂无相关内容")).toBeTruthy();
  });

  it("error 状态渲染错误信息", () => {
    render(
      <Tool
        toolName="knowledge_search"
        state="output-available"
        input={{}}
        output={{ status: "error", message: "知识库检索异常: boom" }}
        defaultOpen
      />,
    );
    expect(screen.getByText(/知识库检索异常/)).toBeTruthy();
  });
});

describe("Tool — knowledge_get_doc 文档卡片（TDSF 2026-08-31 双库）", () => {
  it("渲染文档卡片：title + category 徽标 + 块数，全文默认折叠", () => {
    render(
      <Tool
        toolName="knowledge_get_doc"
        state="output-available"
        input={{ url: "consolidated/services/Web 服务器（Nginx 与 Apache）.md" }}
        output={{
          status: "success",
          url: "consolidated/services/Web 服务器（Nginx 与 Apache）.md",
          title: "Web 服务器（Nginx 与 Apache）",
          category: "services",
          content: "## Nginx\n\n反向代理配置示例…",
          chunks: 12,
          truncated: false,
        }}
        defaultOpen
      />,
    );
    expect(screen.getByText("Web 服务器（Nginx 与 Apache）")).toBeTruthy();
    expect(screen.getByText("服务部署")).toBeTruthy();
    expect(screen.getByText("12 块")).toBeTruthy();
    // 全文折叠：内容默认不可见
    expect(screen.queryByText(/反向代理配置示例/)).toBeNull();
  });

  it("not_found 状态渲染提示", () => {
    render(
      <Tool
        toolName="knowledge_get_doc"
        state="output-available"
        input={{ url: "no-such.md" }}
        output={{ status: "not_found", url: "no-such.md" }}
        defaultOpen
      />,
    );
    expect(screen.getByText(/不存在该文档/)).toBeTruthy();
  });
});
