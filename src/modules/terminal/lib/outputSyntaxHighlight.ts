import { jsonLanguage } from "@codemirror/lang-json";
import { javascriptLanguage } from "@codemirror/lang-javascript";
import { pythonLanguage } from "@codemirror/lang-python";
import { StreamLanguage } from "@codemirror/language";
import { shell } from "@codemirror/legacy-modes/mode/shell";
import { highlightTree, tagHighlighter, tags } from "@lezer/highlight";

export type Kind = "option" | "value" | "keyword" | "string" | "number" | "key" | "comment" | "error" | "warning" | "success" | "path" | "address";
export type OutputSpan = { start: number; length: number; kind: Kind };
const shellLanguage = StreamLanguage.define(shell);
const highlighter = tagHighlighter([
  { tag: [tags.keyword, tags.standard(tags.variableName)], class: "keyword" },
  { tag: tags.string, class: "string" },
  { tag: [tags.number, tags.bool, tags.null], class: "number" },
  { tag: [tags.propertyName, tags.variableName, tags.definition(tags.variableName)], class: "key" },
  { tag: tags.comment, class: "comment" },
]);

/** Recognizable output formats, not an attempt to parse arbitrary prose as code. */
export function outputHighlightSpans(text: string): OutputSpan[] {
  if (/^\s*(?:\[[^\]]+@[^\]]+\]|\S+@\S+.*[#$]|PS [^>]+>|[A-Za-z]:\\.*>|[$#] )/.test(text)) return [];
  const spans: OutputSpan[] = [];
  const add = (start: number, length: number, kind: Kind) => {
    if (length > 0 && !spans.some((span) => start < span.start + span.length && start + length > span.start)) spans.push({ start, length, kind });
  };
  const help = /^( *)(-{1,2}[A-Za-z0-9][ -~]*?) {2,}\S/.exec(text);
  if (help && !/[;|&]/.test(help[2])) {
    for (const match of help[2].matchAll(/--?[A-Za-z0-9][A-Za-z0-9-]*|<[^<> ]+>|\b[A-Z][A-Z0-9_-]*\b/g)) {
      add(help[1].length + match.index, match[0].length, match[0].startsWith("-") ? "option" : "value");
    }
    return spans;
  }
  const trimmed = text.trimStart();
  const jsonStart = /[{[](?:\s|"|\d|[{[]|\])/.exec(text)?.index;
  const offset = jsonStart ?? 0;
  const parser = /^(?:const|let|var|function|async function|import .* from|export (?:const|function))\b/.test(trimmed) ? javascriptLanguage.parser
    : /^(?:def|class|from \w+ import|import \w+)\b|^[A-Za-z_]\w*\s+=\s+/.test(trimmed) ? pythonLanguage.parser
    : /^(?:#!.*(?:sh|bash)|(?:if|elif|for|while|case|export|local|readonly|sudo|systemctl|dnf|apt|git|ls|cat|grep|curl|echo)\s|[A-Za-z_]\w*=)/.test(trimmed) ? shellLanguage.parser
    : jsonStart !== undefined || /^"(?:[^"\\]|\\.)+"\s*:/.test(trimmed) ? jsonLanguage.parser
    : null;
  if (parser) {
    const from = parser === jsonLanguage.parser ? offset : 0;
    highlightTree(parser.parse(text.slice(from)), highlighter, (start, to, style) => {
      const kind = parser === shellLanguage.parser && text.slice(start, to).startsWith("-") ? "option" : style.split(" ")[0] as Kind;
      add(from + start, to - start, kind);
    });
  }
  const config = /^\s*([\w.-]+)\s*[:=]\s*(.*)$/.exec(text);
  if (config && !parser) {
    add(text.indexOf(config[1]), config[1].length, "key");
    const from = text.length - config[2].length;
    if (/^["']/.test(config[2])) add(from, config[2].length, "string");
    else if (/^(?:true|false|null|\d+(?:\.\d+)?)$/i.test(config[2])) add(from, config[2].length, "number");
  }
  const directive = /^\s*([A-Z][a-z]+(?:[A-Z][a-z]+)+)\s+(\S.*)$/.exec(text);
  if (directive && !parser) {
    add(text.indexOf(directive[1]), directive[1].length, "key");
    add(text.length - directive[2].length, directive[2].length, "value");
  }
  if (parser === shellLanguage.parser) {
    for (const match of text.matchAll(/(?:^|\s)(--?[A-Za-z][\w-]*)/g)) {
      add(match.index + match[0].length - match[1].length, match[1].length, "option");
    }
  }
  for (const match of text.matchAll(/\b(?:ERROR|FATAL|FAILED|WARN(?:ING)?|SUCCESS|OK|active|inactive|running|enabled|disabled)\b/gi)) {
    const word = match[0].toLowerCase();
    add(match.index, match[0].length, /error|fatal|failed/.test(word) ? "error" : /warn|inactive|disabled/.test(word) ? "warning" : "success");
  }
  for (const match of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?\b/g)) {
    if (match[0].split(":")[0].split(".").every((part) => Number(part) <= 255)) add(match.index, match[0].length, "address");
  }
  for (const match of text.matchAll(/(?:https?:\/\/|\/(?:[\w.-]+\/)*|[A-Za-z]:\\)[^\s"'<>]+/g)) {
    add(match.index, match[0].length, "path");
  }
  return spans.sort((left, right) => left.start - right.start);
}
