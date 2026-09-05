/**
 * tool.test.tsx — 紧凑审批卡测试
 * -----------------------------------------------------------------------------
 * 覆盖：
 *   1. 卡面只突出：①真实命令原文 ②一句中文用途 ③一句 metadata 影响摘要
 *   2. 不重复 semantic / explanation / segment objects，不伪造精确输出
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

describe("ToolApprovalCard — 紧凑卡面", () => {
  it("只渲染真实命令、一句用途和一句影响，不重复对象面板", () => {
    renderCard({
      semantic: "想操作服务：nginx",
      command: "systemctl restart nginx",
      explanation: "重启 nginx 使新配置生效",
      impact: FULL_IMPACT,
      risk_l: 3,
    });
    // ① 命令原文（永不改写）
    expect(screen.getByText("systemctl restart nginx")).toBeTruthy();
    // ② 有 explanation 时只展示它，不再重复 semantic
    expect(screen.getByText("重启 nginx 使新配置生效")).toBeTruthy();
    expect(screen.queryByText("想操作服务：nginx")).toBeNull();
    // ③ 影响只保留 summary + 风险等级，不渲染 segment 对象/分组
    expect(screen.getByText("操作服务：nginx")).toBeTruthy();
    expect(screen.getByText("L3 高风险")).toBeTruthy();
    expect(screen.queryByText("nginx")).toBeNull();
    expect(screen.queryByText("高影响变更")).toBeNull();
    expect(screen.queryByText("需注意")).toBeNull();
    expect(screen.queryByText(/安全操作/)).toBeNull();
  });

  it("命令原文保留空格和换行，仅通过样式换行", () => {
    const command = "printf 'a  b'\n  && echo done";
    renderCard({
      command,
      explanation: "打印两段文本",
      impact: { summary: "只向当前终端写入文本", max_risk_l: 0 },
      risk_l: 0,
    });

    expect(screen.getByTestId("approval-command").textContent).toBe(command);
  });

  it("用途解释缺失时回退到 semantic，不用影响摘要伪装说明", () => {
    renderCard({
      semantic: "想删除文件：/tmp/a",
      command: "rm -rf /tmp/a",
      risk_l: 4,
      impact: { summary: "删除：/tmp/a" },
    });
    expect(screen.getByText("想删除文件：/tmp/a")).toBeTruthy();
    expect(screen.getByText("删除：/tmp/a")).toBeTruthy();
    expect(screen.queryByText(/系统预测/)).toBeNull();
    expect(screen.queryByText("（无解释）")).toBeNull();
  });

  it("影响缺失显示简短的 fail-closed 文案", () => {
    renderCard({ command: "./mystery.sh", risk_l: 3 });
    expect(screen.getByText("影响信息不完整，需要逐条确认。")).toBeTruthy();
  });

  it("用途字段都缺失时如实显示未提供，不编造命令结果", () => {
    renderCard({ command: "ls" });
    expect(screen.getByText("未提供用途说明。")).toBeTruthy();
    expect(screen.queryByText(/将会输出|输出结果/)).toBeNull();
  });

  it("未知命令只显示一条保守影响，不生成风险分段", () => {
    renderCard({
      command: "./mystery.sh",
      risk_l: 3,
      impact: {
        summary: "暂无法判断影响，请人工确认",
        max_risk_l: 3,
        segments: [
          {
            category: "unknown",
            category_label: "未识别命令（保守待确认）",
            risk_l: 3,
          },
        ],
      },
    });
    expect(screen.getByText("暂无法判断影响，请人工确认")).toBeTruthy();
    expect(screen.queryByText("未识别命令（保守待确认）")).toBeNull();
    expect(screen.queryByText("待人工确认")).toBeNull();
    expect(screen.queryByText("高影响变更")).toBeNull();
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
    renderCard(
      {
        command: "uptime",
        risk_l: 1,
        impact: {
          summary: "只读取系统运行时间",
          max_risk_l: 1,
          denied: false,
          dangerous_construct: false,
          segments: [{ category: "read_only", risk_l: 1, denied: false }],
        },
      },
      onRespond,
    );
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
    expect(
      screen.getByText("影响元数据标记此操作已被安全规则拦截。"),
    ).toBeTruthy();
    renderCard({
      command: "echo $(x)",
      risk_l: 0,
      impact: { ...FULL_IMPACT, dangerous_construct: true },
    });
    expect(screen.queryByText("批准且本会话只读免审")).toBeNull();
    expect(
      screen.getByText("影响元数据检测到危险命令构造，需要逐条确认。"),
    ).toBeTruthy();
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
        input={{ command: "uptime", semantic: "想只读查看", risk_l: 0 }}
        onApprovalRespond={onRespond}
      />,
    );
    expect(screen.getByText("等待你的确认")).toBeTruthy();
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

  it("success 但正文为空时仍显示事实状态，而不是空白卡片", () => {
    render(
      <Tool
        toolName="knowledge_get_doc"
        state="output-available"
        input={{ url: "empty.md" }}
        output={{ status: "success", title: "empty.md", content: "" }}
        defaultOpen
      />,
    );
    expect(screen.getByText(/没有可显示的正文/)).toBeTruthy();
  });
});

// ============================================================================
// 工具失败态渲染（2026-09-02 UI P0-3 / P1）
// ============================================================================
// 此前失败结果（command_blocked / rejected / 内层 ok:false）一路落到
// JSON.stringify 分支 → 用户看到裸 JSON；且后端仍发 completed 事件时
// 行状态停在 output-available，状态点谎报 done。

describe("Tool — 失败输出不再吐裸 JSON", () => {
  it("内层 ok:false → 状态徽标 + 中文说明，不出现 JSON 花括号", () => {
    render(
      <Tool
        toolName="edit"
        state="output-available"
        input={{ path: "/etc/nginx/nginx.conf" }}
        output={{ ok: false, error: "未找到匹配的字符串" }}
        defaultOpen
      />,
    );
    // 行头 failed 徽标 + 内容区状态标签（status 缺省时回退为 failed）
    expect(screen.getAllByText("failed").length).toBe(2);
    expect(screen.getByText(/未找到匹配的字符串/)).toBeTruthy();
    expect(screen.queryByText(/"ok"/)).toBeNull();
  });

  it("command_blocked → 状态标签独立成行 + 剥掉 LLM 契约前缀后的说明", () => {
    render(
      <Tool
        toolName="ssh_command"
        state="output-available"
        input={{ command: "rm -rf /" }}
        output={{
          status: "command_blocked",
          message: "command_blocked! 只读模式或安全规则禁止执行：命中硬底线黑名单。",
          risk: "L4",
        }}
        defaultOpen
      />,
    );
    expect(screen.getByText("command_blocked")).toBeTruthy();
    expect(
      screen.getByText("只读模式或安全规则禁止执行：命中硬底线黑名单。"),
    ).toBeTruthy();
    expect(screen.queryByText(/command_blocked!/)).toBeNull();
  });

  it("内层失败把状态点降级为 failed（不再显示 done）", () => {
    const { container } = render(
      <Tool
        toolName="analyze_logs"
        state="output-available"
        input={{ log_path: "/var/log/x" }}
        output={{ success: false, reason: "日志路径不在白名单" }}
        defaultOpen
      />,
    );
    expect(screen.getByLabelText("failed")).toBeTruthy();
    expect(container.querySelector('[aria-label="done"]')).toBeNull();
  });

  it("成功输出不受失败兜底影响（仍显示 done，无 failed 徽标）", () => {
    render(
      <Tool
        toolName="analyze_logs"
        state="output-available"
        input={{ log_path: "/var/log/x" }}
        output={{ status: "success", total_lines: 12 }}
        defaultOpen
      />,
    );
    expect(screen.getByLabelText("done")).toBeTruthy();
    expect(screen.queryByText("failed")).toBeNull();
  });
});

describe("Tool — SSH 结果卡", () => {
  it("将 SSH 结构化结果渲染为状态、说明与终端输出，而非裸 JSON", () => {
    render(
      <Tool
        toolName="ssh_command"
        state="output-available"
        input={{ command: "hostnamectl" }}
        output={{
          status: "success",
          command: "hostnamectl",
          explanation: "查看主机名与系统信息（只读）",
          output: "Static hostname: demo-host",
          exit_code: 0,
          duration: 0.382,
        }}
        defaultOpen
      />,
    );
    expect(screen.getByText("命令已返回")).toBeTruthy();
    expect(screen.getByText("退出码 0")).toBeTruthy();
    expect(screen.getByText("查看主机名与系统信息（只读）")).toBeTruthy();
    expect(screen.getByText("Static hostname: demo-host")).toBeTruthy();
    expect(screen.queryByText(/"duration"/)).toBeNull();
  });
});

// ============================================================================
// B1 工具类别配色与标签补全（2026-09-03 用户钦定：工具调用 UI 更清晰）
// ============================================================================
// 此前 skill_invoke/ssh_command/python_run 等 16 个工具不在 TOOL_META，
// fallback 到裸工具名 + 灰色 ToolsIcon；现按 6 类（file/exec/knowledge/
// skill/diagnose/plan）配色，图标一眼可辨。
describe("Tool — B1 工具类别配色与标签补全", () => {
  it("skill_invoke → 'Skill' 标签 + 技能名 summary + 紫色（skill 类）", () => {
    const { container } = render(
      <Tool
        toolName="skill_invoke"
        state="input-available"
        input={{ skill: "ssh-diagnose" }}
      />,
    );
    expect(screen.getByText("Skill")).toBeTruthy();
    expect(screen.getByText("ssh-diagnose")).toBeTruthy();
    expect(container.innerHTML).toContain("text-violet-600");
  });

  it("ssh_command → 'SSH' 标签 + 红色（exec 类）", () => {
    const { container } = render(
      <Tool
        toolName="ssh_command"
        state="input-available"
        input={{ command: "df -h" }}
      />,
    );
    expect(screen.getByText("SSH")).toBeTruthy();
    expect(container.innerHTML).toContain("text-red-600");
  });

  it("knowledge_search 图标绿色（knowledge 类）", () => {
    const { container } = render(
      <Tool
        toolName="knowledge_search"
        state="input-available"
        input={{ query: "x" }}
      />,
    );
    expect(container.innerHTML).toContain("text-emerald-600");
  });

  it("edit → 琥珀色（file 类）", () => {
    const { container } = render(
      <Tool
        toolName="edit"
        state="input-available"
        input={{ path: "/etc/hosts" }}
      />,
    );
    expect(container.innerHTML).toContain("text-amber-600");
  });

  it("补全工具不再 fallback 裸名：python_run → 'Python'", () => {
    render(
      <Tool
        toolName="python_run"
        state="input-available"
        input={{ code: "print(1)" }}
      />,
    );
    expect(screen.getByText("Python")).toBeTruthy();
    expect(screen.queryByText("python_run")).toBeNull();
  });
});
