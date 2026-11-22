import { isValidElement, useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { Streamdown } from "streamdown";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { highlight, isHighlightable, type HighlightedNode } from "@/components/ai-elements/chat-code-lezer";
import type { KnowledgeDoc } from "@/modules/ai/lib/knowledge-cache";
import { sourceGroupLabel } from "@/modules/ai/lib/knowledge-labels";
import { readingReferenceDefinitions, splitReadingSections } from "@/modules/ai/lib/knowledge-reader";

function codeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(codeText).join("");
  return isValidElement<{ children?: ReactNode }>(node) ? codeText(node.props.children) : "";
}

/** No chat contexts, terminal target, Run button or automatic-input effect. */
function ReadingCode({ code, lang }: { code: string; lang: string }) {
  const [highlighted, setHighlighted] = useState<{ code: string; lang: string; nodes: HighlightedNode[] } | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (isHighlightable(lang)) void highlight(code, lang).then((nodes) => {
      if (!cancelled && nodes) setHighlighted({ code, lang, nodes });
    }).catch(() => { /* Plain text remains fully readable. */ });
    return () => { cancelled = true; };
  }, [code, lang]);
  const nodes = highlighted?.code === code && highlighted.lang === lang ? highlighted.nodes : null;
  async function copyCode() {
    try { await navigator.clipboard.writeText(code); setCopied(true); }
    catch { toast.error("复制失败，请手动选择代码"); }
  }
  return <div className="not-prose my-4 overflow-hidden rounded-xl border border-border bg-muted/20">
    <div className="flex items-center justify-between border-b border-border px-3 py-1.5">
      <span className="font-mono text-[11px] text-muted-foreground">{lang}</span>
      <Button variant="ghost" size="sm" className="h-6 text-[11px]" onClick={() => void copyCode()}>{copied ? "已复制" : "复制代码"}</Button>
    </div>
    <pre className="m-0 max-h-[50vh] overflow-auto whitespace-pre px-4 py-3 font-mono text-[12px] leading-6"><code>{nodes ? nodes.map((node, index) => node.kind === "break" ? "\n" : <span key={index} className={node.cls}>{node.value}</span>) : code}</code></pre>
  </div>;
}

function ReadingPre({ children }: ComponentProps<"pre">) {
  const block = isValidElement<{ className?: string; children?: ReactNode }>(children) ? children : null;
  const lang = block?.props.className?.match(/\blanguage-([^\s]+)/)?.[1] ?? "text";
  return <ReadingCode code={codeText(block?.props.children ?? children)} lang={lang} />;
}

const readingComponents = {
  pre: ReadingPre,
  img: ({ alt }: ComponentProps<"img">) => <span className="text-muted-foreground">[图片：{alt || "未提供说明"}]</span>,
};

const readingTranslations = {
  close: "关闭", copied: "已复制", copyCode: "复制代码", copyLink: "复制链接",
  copyTable: "复制表格", copyTableAsCsv: "复制为 CSV", copyTableAsMarkdown: "复制为 Markdown", copyTableAsTsv: "复制为 TSV",
  downloadFile: "下载文件", downloadImage: "下载图片", downloadTable: "下载表格",
  downloadTableAsCsv: "下载为 CSV", downloadTableAsMarkdown: "下载为 Markdown",
  exitFullscreen: "退出全屏", externalLinkWarning: "此链接将打开外部网站，请确认来源。",
  imageNotAvailable: "图片不可用", openExternalLink: "打开外部链接", openLink: "打开链接", viewFullscreen: "全屏查看",
};

function ChapterReader({ content }: { content: string }) {
  const sections = useMemo(() => splitReadingSections(content), [content]);
  const references = useMemo(() => readingReferenceDefinitions(content), [content]);
  const [chapter, setChapter] = useState(0);
  const [tocOpen, setTocOpen] = useState(false);
  const section = sections[chapter];
  return <>
    {sections.length > 1 && <div className="border-b border-border/60 bg-muted/20 px-5 py-3">
      <div className="flex items-center justify-between gap-3">
        <Button size="sm" variant="ghost" className="h-7 px-0 text-xs" aria-expanded={tocOpen} onClick={() => setTocOpen(!tocOpen)}>章节目录</Button>
        <span className="text-xs tabular-nums text-muted-foreground">{chapter + 1} / {sections.length}</span>
      </div>
      {tocOpen && <nav aria-label="文档章节" className="mt-2 max-h-40 space-y-0.5 overflow-auto">
        {sections.map((item, index) => <button key={item.id} type="button" aria-current={chapter === index ? "true" : undefined} onClick={() => { setChapter(index); setTocOpen(false); }} className="block w-full rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:bg-muted aria-[current=true]:bg-muted aria-[current=true]:text-foreground">{item.title}</button>)}
      </nav>}
      <Select value={String(chapter)} onValueChange={(value) => setChapter(Number(value))}>
        <SelectTrigger aria-label="当前章节" size="sm" className="mt-1 w-full min-w-0 text-xs"><SelectValue /></SelectTrigger>
        <SelectContent position="popper">{sections.map((item, index) => <SelectItem key={item.id} value={String(index)}>{item.title}</SelectItem>)}</SelectContent>
      </Select>
    </div>}
    <div key={section?.id} className="min-h-0 flex-1 overflow-auto px-5 py-5 sm:px-8">
      <Streamdown mode="static" components={readingComponents} translations={readingTranslations} className="ai-md mx-auto max-w-[76ch] text-[14px] leading-[1.85] text-foreground [&_h1]:mb-5 [&_h1]:text-xl [&_h1]:font-semibold [&_h2]:mt-7 [&_h2]:text-lg [&_h2]:font-semibold [&_h3]:mt-5 [&_h3]:text-base [&_p]:my-3 [&_table]:text-xs [&_th]:whitespace-nowrap [&_blockquote]:border-l-2 [&_blockquote]:border-foreground/30 [&_blockquote]:pl-4 [&_blockquote]:text-muted-foreground [&_pre]:text-[12px]">
        {`${references}\n\n${section?.content || "该文档暂无正文。"}`}
      </Streamdown>
    </div>
    {sections.length > 1 && <div className="flex items-center justify-between border-t border-border/60 px-5 py-3">
      <Button variant="outline" size="sm" disabled={chapter === 0} onClick={() => setChapter(chapter - 1)}>上一章</Button>
      <span className="px-3 text-xs text-muted-foreground">按章节阅读，原文内容不删减</span>
      <Button variant="outline" size="sm" disabled={chapter + 1 >= sections.length} onClick={() => setChapter(chapter + 1)}>下一章</Button>
    </div>}
  </>;
}

export function KnowledgeReader({ doc }: { doc: KnowledgeDoc }) {
  const [language, setLanguage] = useState<"zh" | "original">(doc.content_zh?.trim() ? "zh" : "original");
  const content = language === "zh" ? doc.content_zh ?? "" : doc.content ?? "";
  return <div className="flex min-h-0 flex-1 flex-col">
    <div className="space-y-2 border-b border-border/60 px-5 py-3 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>{sourceGroupLabel(doc.source ?? "")}</span>
        <span>{doc.chunks ?? 0} 个检索片段 · {doc.total_chars?.toLocaleString() ?? 0} 字符</span>
        {doc.content_zh?.trim() && <div className="ml-auto flex rounded-md border border-border p-0.5">
          <Button size="sm" variant={language === "zh" ? "secondary" : "ghost"} className="h-6 text-xs" onClick={() => setLanguage("zh")}>中文译文</Button>
          <Button size="sm" variant={language === "original" ? "secondary" : "ghost"} className="h-6 text-xs" onClick={() => setLanguage("original")}>原文</Button>
        </div>}
      </div>
      {doc.library === "builtin" && <p>随应用提供的教学资料与整理版，来源标签不代表每个章节都已单独核验。</p>}
      {doc.processing === "recovered" && <p>已恢复的旧整理资料，保留原有内容；章节来源仍需核对。</p>}
      {doc.library === "reference" && <p>本机原始参考缓存，尚未整理，不等于官方中文版。</p>}
      {language === "zh" && doc.translation_complete === false && <p role="status">仅部分片段有既有译文；需查看完整内容时请切换原文。</p>}
      {!doc.content_zh?.trim() && !/[\u4e00-\u9fff]/.test(doc.content ?? "") && <p>当前为原文，未提供中文译文；不会自动调用模型翻译。</p>}
      {doc.possibly_truncated && <p role="status">此旧缓存可能曾被截断，不能视为完整原文。</p>}
      {doc.url && <p className="break-all text-[11px] text-muted-foreground/80">来源标识：{doc.url}</p>}
    </div>
    <ChapterReader key={language} content={content} />
  </div>;
}
