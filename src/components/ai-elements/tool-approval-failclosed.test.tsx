import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ToolApprovalCard } from "./tool";

describe("ToolApprovalCard fail-closed impact handling", () => {
  it("不完整 impact metadata 不显示会话免审，也不渲染成安全分组", () => {
    render(
      <ToolApprovalCard
        toolName="ssh_command"
        input={{
          command: "./incomplete-impact.sh",
          risk_l: 0,
          impact: {
            summary: "impact metadata is incomplete",
            max_risk_l: 0,
            segments: [{ risk_l: 0 }],
          },
        }}
        onRespond={vi.fn()}
      />,
    );

    expect(screen.getByText("impact metadata is incomplete")).toBeTruthy();
    expect(screen.queryByText("批准且本会话只读免审")).toBeNull();
    expect(screen.queryByText(/\u5b89\u5168\u64cd\u4f5c/)).toBeNull();
  });

  it("取所有 risk metadata 的最高值，低估的顶层 risk_l 不能开启会话免审", () => {
    render(
      <ToolApprovalCard
        toolName="ssh_command"
        input={{
          command: "systemctl restart nginx",
          explanation: "重启 nginx 服务",
          risk_l: 0,
          impact: {
            summary: "服务会短暂中断",
            max_risk_l: 3,
            segments: [{ category: "service", risk_l: 3 }],
          },
        }}
        onRespond={vi.fn()}
      />,
    );

    expect(screen.getByText("L3 高风险")).toBeTruthy();
    expect(screen.queryByText("批准且本会话只读免审")).toBeNull();
  });
});
