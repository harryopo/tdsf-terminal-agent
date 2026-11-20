// @vitest-environment node
import { describe, expect, it } from "vitest";
import { knowledgeDisplayTitle, splitReadingSections } from "./knowledge-reader";

describe("knowledge document titles", () => {
  it("prefers an existing Chinese title then the real page title", () => {
    expect(knowledgeDisplayTitle({ title_zh: "服务管理", title0: "index.html", url: "https://docs.example.org/index.html" })).toBe("服务管理");
    expect(knowledgeDisplayTitle({ title0: "Bash Reference Manual", url: "bash.1.en.html" })).toBe("Bash Reference Manual");
    expect(knowledgeDisplayTitle({ title0: "Control_groups", url: "Control_groups" })).toBe("Control groups");
  });

  it("does not present index files or raw URLs as curated document names", () => {
    expect(knowledgeDisplayTitle({ title0: "https://docs.example.org/index.html", url: "https://docs.example.org/index.html" })).toBe("待整理资料");
    expect(knowledgeDisplayTitle({ url: "bash.1.en.html" })).toBe("bash · 手册 1");
  });
});

describe("knowledge reading sections", () => {
  it("splits headings but preserves every byte of fenced commands, tables and warnings", () => {
    const body = "导读\r\n\r\n# 第一章\r\n\r\n````sh\r\n# not a heading\r\n```\r\necho safe\r\n````\r\n\r\n| 参数 | 说明 |\r\n| --- | --- |\r\n| -n | 只读 |\r\n\r\n> 注意：先备份。\r\n\r\n## 第二章\r\n第二部分\r\n";
    const sections = splitReadingSections(body);
    expect(sections.map((section) => section.title)).toEqual(["导读", "第一章", "第二章"]);
    expect(sections.map((section) => section.content).join("")).toBe(body);
    expect(sections[1].content).toContain("# not a heading\r\n```\r\necho safe");
    expect(sections[1].content).toContain("> 注意：先备份。");
  });

  it("keeps unclosed fences intact rather than inventing sections inside them", () => {
    const text = "# 文档\n~~~bash\n## 注释\necho done\n";
    expect(splitReadingSections(text)).toHaveLength(1);
    expect(splitReadingSections(text)[0].content).toBe(text);
  });

  it("assigns unique chapter identities even to repeated headings", () => {
    const sections = splitReadingSections("# 标题\n一\n# 标题\n二");
    expect(new Set(sections.map((section) => section.id)).size).toBe(2);
    expect(sections.map((section) => section.content).join("")).toBe("# 标题\n一\n# 标题\n二");
  });
});
