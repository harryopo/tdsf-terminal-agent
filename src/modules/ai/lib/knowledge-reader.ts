import { markdownLanguage } from "@codemirror/lang-markdown";

export type ReadingSection = { id: string; title: string; content: string };

/** Reuse the existing parser; fenced examples are not real link definitions. */
export function readingReferenceDefinitions(markdown: string): string {
  const definitions: string[] = [];
  markdownLanguage.parser.parse(markdown).iterate({
    enter(node) {
      if (node.name === "LinkReference") definitions.push(markdown.slice(node.from, node.to));
    },
  });
  return definitions.join("\n\n");
}

export function knowledgeDisplayTitle(doc: {
  title_zh?: string; title0?: string; title?: string; url?: string; filename?: string;
}): string {
  if (doc.title_zh?.trim()) return doc.title_zh.trim();
  let filename = doc.filename ?? doc.url?.replace(/\\/g, "/").split("/").pop() ?? "";
  try { filename = decodeURIComponent(filename); } catch { /* Keep malformed source names. */ }
  for (const raw of [doc.title0, doc.title, filename]) {
    const title = raw?.trim();
    if (!title || /^\w+:\/\//.test(title) || /^index(?:\.[a-z0-9]+)*$/i.test(title)) continue;
    const manual = title.match(/^(.+?)\.(\d)(?:\.[a-z_]+)?(?:\.html?)?$/i);
    if (manual) return `${manual[1]} · 手册 ${manual[2]}`;
    const cleaned = title.replace(/\.(?:en\.)?html?$/i, "").replace(/\.(?:md|markdown)$/i, "").replace(/_/g, " ");
    if (cleaned) return cleaned;
  }
  return "待整理资料";
}

/** Partition the original string; never split inside fences or rewrite prose. */
export function splitReadingSections(markdown: string): ReadingSection[] {
  const sections: ReadingSection[] = [];
  let start = 0;
  let title = "导读";
  let fence = "";
  let fenceLength = 0;
  for (const match of markdown.matchAll(/[^\n]*\n|[^\n]+$/g)) {
    const line = match[0].replace(/\r?\n$/, "");
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      if (marker && marker[1][0] === fence && marker[1].length >= fenceLength && !marker[2].trim()) fence = "";
      continue;
    }
    if (marker) {
      fence = marker[1][0];
      fenceLength = marker[1].length;
      continue;
    }
    const heading = line.match(/^ {0,3}#{1,3}\s+(.+?)\s*#*\s*$/);
    if (!heading) continue;
    const offset = match.index;
    if (offset > start) sections.push({ id: `section-${sections.length}`, title, content: markdown.slice(start, offset) });
    start = offset;
    title = heading[1];
  }
  if (start < markdown.length) sections.push({ id: `section-${sections.length}`, title, content: markdown.slice(start) });
  return sections;
}
