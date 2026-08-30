"use client";

import { isValidElement, type ReactNode } from "react";

import { ChatCodeBlock } from "./chat-code";
import { MermaidBlock } from "./mermaid-block";

export function markdownCodeText(children?: ReactNode): string {
  if (children == null || typeof children === "boolean") return "";
  if (typeof children === "string" || typeof children === "number") {
    return String(children);
  }
  if (Array.isArray(children)) {
    return children.map((child) => markdownCodeText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(children)) {
    return markdownCodeText(children.props.children);
  }
  return "";
}

/**
 * Streamdown `components.code` override. Handles both inline (`code`) and
 * fenced blocks (className "language-X"). Fenced blocks delegate to the
 * Lezer-based renderer; inline stays a plain pill.
 */
export function MarkdownCode({
  className,
  children,
  ...rest
}: {
  className?: string;
  children?: ReactNode;
}) {
  const match = className?.match(/language-(\w+)/);
  if (!match) {
    return (
      <code
        className="rounded bg-muted/70 px-1.5 py-0.5 font-mono text-[11px] text-foreground"
        {...rest}
      >
        {children}
      </code>
    );
  }

  const code = markdownCodeText(children).replace(/\n$/, "");
  // TDSF 魔改 2026-08-30: mermaid 围栏渲染为 SVG 图表（Arch Wiki 等官方文档含
  // ```mermaid 块，纯文字墙不可读）；其余语言走原代码块渲染
  if (match[1] === "mermaid") {
    return <MermaidBlock code={code} />;
  }
  return <ChatCodeBlock code={code} lang={match[1] ?? null} />;
}
