/**
 * TeachCard.test.tsx — Teach 教学卡片测试（P2-1）
 * -----------------------------------------------------------------------------
 * 覆盖:
 *   1. parseTeachSections: 6 大板块解析（概念/示例+命令/易错/练习）
 *   2. isTeachMessage: 教学格式检测（emoji 板块 / ## N. 标题）
 *   3. TeachCard 渲染: 分节卡片 + 命令行 + 追问按钮
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TeachCard } from "./TeachCard";
import { isTeachMessage, parseTeachSections } from "./teachParser";

const TEACH_MD = `## 1. 概念与原理
grep 是文本搜索工具，哲学：组合小工具。

## 2. 操作示例
\`\`\`bash
grep -i error /var/log/nginx/error.log
\`\`\`

## 3. 易错点与考点
- 正则特殊字符要转义

## 4. 练习
用 grep 找出日志中的 502。`;

describe("parseTeachSections — 教学结构解析", () => {
  it("解析 6 大板块标题", () => {
    const sections = parseTeachSections(TEACH_MD);
    expect(sections.length).toBe(4);
    expect(sections[0].type).toBe("concept");
    expect(sections[1].type).toBe("example");
    expect(sections[2].type).toBe("pitfall");
    expect(sections[3].type).toBe("exercise");
  });

  it("提取示例节命令", () => {
    const sections = parseTeachSections(TEACH_MD);
    const example = sections.find((s) => s.type === "example");
    expect(example?.commands).toContain(
      "grep -i error /var/log/nginx/error.log",
    );
  });

  it("emoji 板块识别", () => {
    const md = "💡 为什么\n概念内容\n\n🏛️ 设计哲学\n哲学内容";
    const sections = parseTeachSections(md);
    expect(sections[0].type).toBe("concept");
    expect(sections[1].type).toBe("philosophy");
  });

  it("无结构文本归入 other 前置段（TeachCard 渲染由 isTeachMessage 拦截）", () => {
    // TDSF 2026-08-31 (问题4修复): 前置段徽标从「概念与原理」回退「讲解」
    const sections = parseTeachSections("普通文本内容");
    expect(sections.length).toBe(1);
    expect(sections[0].type).toBe("other");
    expect(sections[0].title).toBe("讲解");
  });

  it("标题前导语归入讲解段，不误标「概念与原理」（问题4回归）", () => {
    const md = `你好！我是 Teach Agent，很高兴为你讲解 Linux 知识。

## 1. 概念与原理
grep 是文本搜索工具。

## 2. 操作示例
\`\`\`bash
grep -i error app.log
\`\`\``;
    const sections = parseTeachSections(md);
    expect(sections.length).toBe(3);
    // 导语段：通用「讲解」徽标，内容是自我介绍
    expect(sections[0].type).toBe("other");
    expect(sections[0].title).toBe("讲解");
    expect(sections[0].content).toContain("Teach Agent");
    // 正式教学板块不受影响
    expect(sections[1].type).toBe("concept");
    expect(sections[2].type).toBe("example");
  });
});

describe("isTeachMessage — 教学格式检测", () => {
  it("识别 ## N. 教学标题", () => {
    expect(isTeachMessage("## 1. 概念与原理\n内容")).toBe(true);
  });

  it("识别 emoji 板块（需足够内容量）", () => {
    expect(
      isTeachMessage("🏛️ Linux 设计哲学\n一切皆文件是核心哲学，组合小工具完成复杂任务。"),
    ).toBe(true);
    // 过短文本不判 emoji（避免普通消息误判）
    expect(isTeachMessage("🏛️ 哲学")).toBe(false);
  });

  it("普通消息不误判", () => {
    expect(isTeachMessage("你好，这是普通回答")).toBe(false);
    expect(isTeachMessage("短")).toBe(false);
  });
});

describe("TeachCard — 渲染", () => {
  it("渲染头部 + 分区 + 追问按钮", () => {
    render(<TeachCard content={TEACH_MD} />);
    expect(screen.getByTestId("teach-card")).toBeTruthy();
    expect(screen.getByText("Teach Agent")).toBeTruthy();
    expect(screen.getByTestId("teach-section-concept")).toBeTruthy();
    expect(screen.getByTestId("teach-section-example")).toBeTruthy();
    expect(screen.getByTestId("teach-section-pitfall")).toBeTruthy();
    expect(screen.getByTestId("teach-section-exercise")).toBeTruthy();
  });

  it("命令行渲染 + 插入/复制按钮", () => {
    render(<TeachCard content={TEACH_MD} />);
    expect(screen.getByText("插入终端")).toBeTruthy();
    expect(screen.getByText("复制")).toBeTruthy();
  });
});
