/**
 * tool.test.tsx — 工具行组件测试（P0-6: agent 委派卡片）
 * -----------------------------------------------------------------------------
 * 覆盖:
 *   1. agent:<name> 前缀 → 显示 "<Name> Agent" 标签（main 委派子 agent 可视化）
 *   2. 委派输入摘要展示（input 文本截断）
 *   3. 常规工具不受影响
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Tool } from "./tool";

describe("Tool — agent 委派卡片（P0-6）", () => {
  it("agent:teach 显示 Teach Agent 标签", () => {
    render(
      <Tool
        toolName="agent:teach"
        state="input-available"
        input={{ input: "讲一下 nginx" }}
      />,
    );
    expect(screen.getByText("Teach Agent")).toBeTruthy();
  });

  it("agent:explore 显示 Explore Agent 标签", () => {
    render(
      <Tool
        toolName="agent:explore"
        state="output-available"
        input={{ input: "查一下日志" }}
        output="发现：nginx error log 有 502"
      />,
    );
    expect(screen.getByText("Explore Agent")).toBeTruthy();
  });

  it("委派输入在摘要中展示（input 字段）", () => {
    render(
      <Tool
        toolName="agent:coding"
        state="input-available"
        input={{ input: "修复 nginx.conf 的 server 块配置" }}
      />,
    );
    expect(screen.getByText(/修复 nginx\.conf/)).toBeTruthy();
  });

  it("长委派输入截断展示", () => {
    const long = "这是一段非常长的委派输入".repeat(20);
    render(
      <Tool
        toolName="agent:teach"
        state="input-available"
        input={{ input: long }}
      />,
    );
    // 截断显示（60 字符 + …）
    expect(screen.getByText(/…$/)).toBeTruthy();
  });

  it("常规工具仍显示原名（不受 agent 前缀影响）", () => {
    render(
      <Tool
        toolName="bash_run"
        state="output-available"
        input={{ command: "ls -la" }}
        output="total 8"
      />,
    );
    expect(screen.getByText("Run")).toBeTruthy();
  });
});
