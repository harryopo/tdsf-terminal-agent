import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TeachCard } from "./TeachCard";
import {
  isTeachMessage,
  parseTeachSections,
  shouldRenderTeachCard,
  stripTeachOutputMarker,
} from "./teachParser";

const TEACH_MD = [
  "<!-- tdsf:teach -->",
  "## 1. 概念与原理",
  "grep 通过文本匹配帮助定位日志中的证据。",
  "",
  "## 2. 操作示例",
  "```bash",
  "grep -i error /var/log/nginx/error.log",
  "```",
  "",
  "## 3. 易错与检查",
  "- 正则字符需要按 shell 规则引用。",
  "",
  "## 4. 练习",
  "请找出日志中的 502。",
].join("\n");

describe("parseTeachSections — 教学结构解析", () => {
  it("解析标题与板块类型", () => {
    const sections = parseTeachSections(TEACH_MD);
    expect(sections).toHaveLength(4);
    expect(sections.map((s) => s.type)).toEqual([
      "concept",
      "example",
      "pitfall",
      "exercise",
    ]);
  });

  it("提取单行 shell 命令且不在正文重复渲染", () => {
    const example = parseTeachSections(TEACH_MD).find(
      (s) => s.type === "example",
    );
    expect(example?.commands).toEqual([
      "grep -i error /var/log/nginx/error.log",
    ]);
    expect(example?.content).not.toContain("```bash");
  });

  it("删除空 shell fence，不创建空命令卡", () => {
    const sections = parseTeachSections(
      ["<!-- tdsf:teach -->", "## 操作示例", "```bash", "", "```"].join(
        "\n",
      ),
    );
    expect(sections).toHaveLength(0);
  });

  it("保留多行 shell 说明，但不伪装成可执行单行命令", () => {
    const sections = parseTeachSections(
      [
        "<!-- tdsf:teach -->",
        "## 操作示例",
        "```bash",
        "set -e",
        "grep error app.log",
        "```",
      ].join("\n"),
    );
    expect(sections).toHaveLength(1);
    expect(sections[0].commands).toEqual([]);
    expect(sections[0].content).toContain("set -e");
  });

  it("支持显式标记前的说明段", () => {
    const sections = parseTeachSections(
      [
        "<!-- tdsf:teach -->",
        "先说明证据来源。",
        "",
        "## 1. 概念与原理",
        "说明。",
      ].join("\n"),
    );
    expect(sections[0].type).toBe("other");
    expect(sections[0].title).toBe("说明");
    expect(sections[1].type).toBe("concept");
  });
});

describe("isTeachMessage — 教学输出契约", () => {
  it("只接受 sidecar 的显式标记", () => {
    expect(
      isTeachMessage("<!-- tdsf:teach -->\n## 1. 概念与原理\n内容"),
    ).toBe(true);
    expect(isTeachMessage("## 1. 概念与原理\n内容")).toBe(false);
    expect(
      isTeachMessage(
        "知识库检索结果：\n## 1. 概念与原理\n这是来源摘要，不是教学。",
      ),
    ).toBe(false);
  });

  it("普通短文本不误判", () => {
    expect(isTeachMessage("你好，这是普通回答")).toBe(false);
    expect(isTeachMessage("🏛️ Linux 设计哲学\n一切皆文件")).toBe(false);
  });

  it("普通 Markdown 路径会移除仅供传输的教学标记", () => {
    expect(stripTeachOutputMarker("<!-- tdsf:teach -->\n说明")).toBe("说明");
  });
});

describe("shouldRenderTeachCard — 流式边界", () => {
  it("在流式或 token 续跑期间保持 Markdown，完成后再解析卡片", () => {
    expect(shouldRenderTeachCard(TEACH_MD, true, true)).toBe(false);
    expect(shouldRenderTeachCard(TEACH_MD, true, false)).toBe(true);
    expect(shouldRenderTeachCard(TEACH_MD, false, false)).toBe(false);
  });
});

describe("TeachCard — 渲染", () => {
  it("渲染头部、板块和命令操作", () => {
    render(<TeachCard content={TEACH_MD} />);
    expect(screen.getByTestId("teach-card")).toBeTruthy();
    expect(screen.getByText("Teach Agent")).toBeTruthy();
    expect(screen.getByTestId("teach-section-concept")).toBeTruthy();
    expect(screen.getByTestId("teach-section-example")).toBeTruthy();
    expect(screen.getByTestId("teach-section-pitfall")).toBeTruthy();
    expect(screen.getByTestId("teach-section-exercise")).toBeTruthy();
    expect(screen.getByText("插入终端")).toBeTruthy();
    expect(screen.getByText("复制")).toBeTruthy();
  });
});
