/**
 * AiToolApproval.test.tsx — 审批卡片组件测试
 * -----------------------------------------------------------------------------
 * 覆盖（P0-5 补测试，安全关键路径）:
 *   1. bash_run 渲染命令预览 + cwd
 *   2. write_file 渲染路径 + 行数提示（不预览内容）
 *   3. 未知工具回退 JSON 预览
 *   4. Deny / Approve 回调
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { AiToolApproval } from "./AiToolApproval";

function makePart(input: Record<string, unknown>) {
  return {
    type: "tool" as const,
    state: "approval-requested" as const,
    toolCallId: "call-1",
    toolName: "bash_run",
    approval: { id: "approval-1" },
    input,
  };
}

describe("AiToolApproval — 审批卡片", () => {
  it("bash_run 渲染命令与 cwd", () => {
    render(
      <AiToolApproval
        part={makePart({ command: "rm -rf /tmp/x", cwd: "/home/user" })}
        toolName="bash_run"
        onRespond={() => {}}
      />,
    );
    expect(screen.getByText("Run shell command")).toBeTruthy();
    expect(screen.getByText("rm -rf /tmp/x")).toBeTruthy();
    expect(screen.getByText("/home/user")).toBeTruthy();
  });

  it("write_file 渲染路径 + 行数提示，不泄漏内容", () => {
    render(
      <AiToolApproval
        part={makePart({
          path: "/etc/nginx/nginx.conf",
          content: "line1\nline2\nline3",
        })}
        toolName="write_file"
        onRespond={() => {}}
      />,
    );
    expect(screen.getByText("Write file")).toBeTruthy();
    expect(screen.getByText("/etc/nginx/nginx.conf")).toBeTruthy();
    expect(screen.getByText(/3 line/)).toBeTruthy();
    // 内容不应出现在预览中（diff tab 是权威审查位置）
    expect(screen.queryByText("line1")).toBeNull();
  });

  it("未知工具回退 JSON 预览", () => {
    render(
      <AiToolApproval
        part={makePart({ foo: "bar" })}
        toolName="custom_tool"
        onRespond={() => {}}
      />,
    );
    // 未知工具显示工具名 + JSON 预览
    expect(screen.getByText("custom_tool")).toBeTruthy();
    expect(screen.getByText(/"foo"/)).toBeTruthy();
  });

  it("Deny 触发 onRespond(false)", () => {
    const onRespond = vi.fn();
    render(
      <AiToolApproval
        part={makePart({ command: "ls" })}
        toolName="bash_run"
        onRespond={onRespond}
      />,
    );
    fireEvent.click(screen.getByText("Deny"));
    expect(onRespond).toHaveBeenCalledWith(false);
  });

  it("Approve 触发 onRespond(true)", () => {
    const onRespond = vi.fn();
    render(
      <AiToolApproval
        part={makePart({ command: "ls" })}
        toolName="bash_run"
        onRespond={onRespond}
      />,
    );
    fireEvent.click(screen.getByText("Approve"));
    expect(onRespond).toHaveBeenCalledWith(true);
  });
});
