"use client";

import { cn } from "@/lib/utils";
import { useEffect, useRef, useState } from "react";

/**
 * MermaidBlock — ```mermaid 代码块的 SVG 渲染（TDSF 2026-08-30 知识库改造）
 * -----------------------------------------------------------------------------
 * streamdown 的 mermaid 支持需可选插件包 @streamdown/mermaid（未安装），且项目
 * 已全局覆盖 components.code（markdown-code.tsx），故在 code 分支自渲染：
 * mermaid 动态 import 懒加载（~大体积仅首个图表时加载），initialize 按当前
 * 主题（html.dark class）选 dark/default，render 出 SVG 注入。
 * 渲染失败回退显示源码 pre（不白屏）；securityLevel=strict 禁 SVG 内交互/注入。
 */

let uid = 0;

export function MermaidBlock({ code, className }: { code: string; className?: string }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const idRef = useRef("");

  useEffect(() => {
    let cancelled = false;
    if (!idRef.current) idRef.current = `tdsf-mermaid-${++uid}`;
    const dark = document.documentElement.classList.contains("dark");
    import("mermaid")
      .then(({ default: mermaid }) => {
        mermaid.initialize({
          startOnLoad: false,
          theme: dark ? "dark" : "default",
          securityLevel: "strict",
        });
        return mermaid.render(idRef.current, code);
      })
      .then((res) => {
        if (cancelled) return;
        setSvg(res.svg);
        setError(false);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  if (error) {
    return (
      <div className="not-prose my-2 overflow-hidden rounded-lg border border-border/50 bg-muted/30">
        <div className="border-b border-border/40 bg-muted/20 px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-muted-foreground">
          mermaid（图表渲染失败，显示源码）
        </div>
        <pre className="m-0 overflow-x-auto px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-foreground">
          {code}
        </pre>
      </div>
    );
  }

  if (svg === null) {
    return (
      <div
        className={cn(
          "not-prose my-2 flex h-24 animate-pulse items-center justify-center rounded-lg border border-border/50 bg-muted/30 text-[11px] text-muted-foreground",
          className,
        )}
      >
        图表渲染中…
      </div>
    );
  }

  return (
    <div
      className={cn(
        "not-prose my-2 overflow-x-auto rounded-lg border border-border/50 bg-muted/20 p-3",
        className,
      )}
      // mermaid securityLevel=strict 输出已消毒 SVG（无脚本/外部引用）
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
