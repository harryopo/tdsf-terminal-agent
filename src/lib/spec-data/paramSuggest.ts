/**
 * paramSuggest.ts — 命令参数预测 (TDSF 2026-08-15)
 * -----------------------------------------------------------------------------
 * 基于 Fig spec（开源数据）解析当前命令行，预测可用的：
 *   - options：-n / --noheadings（用户场景：-y、-n 等）
 *   - subcommands：apt install / systemctl status 等
 *   - args.suggestions：静态参数值（--format json|yaml 等）
 *
 * 支持层级：`cmd [sub] [arg|option...]`（1 层子命令；sudo/command/env 等
 * 前缀命令自动跳过）。动态 generators（需执行远端 shell）不在静态预测范围。
 */
import type { FigArg, FigOption, FigSpec } from "./types";
import type { SuggestionResult } from "@/lib/suggest-engine";

/** 前置命令（真正命令在其后，如 `sudo lsblk`） */
const PREFIX_COMMANDS = new Set([
  "sudo",
  "command",
  "env",
  "exec",
  "nohup",
  "time",
  "nix",
  "xargs",
]);

/** 解析结果：命令/子命令/当前正在输入的 token */
export interface ParsedLine {
  /** 命令名（已跳过 sudo 等前缀），undefined = 空行/仅前缀 */
  cmd?: string;
  /** 子命令（可选，如 install） */
  sub?: string;
  /** 当前光标处的 token（可能为空串，即刚打完空格） */
  current: string;
}

export function parseCommandLine(line: string): ParsedLine {
  // 保留行尾空格信息：末尾是空格 = 刚打完空格、正在输入新 token（current 为空串）
  const trailingSpace = /\s+$/.test(line);
  const tokens = line.trimEnd().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return { current: "" };
  let base = 0;
  if (PREFIX_COMMANDS.has(tokens[0])) base = 1;
  const cmd = tokens[base];
  if (!cmd) return { current: "" };
  const current = trailingSpace ? "" : (tokens[tokens.length - 1] ?? "");
  const sub = tokens.length >= base + 2 ? tokens[base + 1] : undefined;
  return { cmd, sub, current };
}

function toNameList(name: string | string[] | undefined): string[] {
  if (!name) return [];
  return Array.isArray(name) ? name : [name];
}

function toArgList(args: FigArg | FigArg[] | undefined): FigArg[] {
  if (!args) return [];
  return Array.isArray(args) ? args : [args];
}

/** 静态参数值建议（字符串化） */
function argSuggestions(arg: FigArg): string[] {
  const out: string[] = [];
  for (const sug of arg.suggestions ?? []) {
    if (typeof sug === "string") out.push(sug);
    else if (sug && typeof sug.name === "string") out.push(sug.name);
  }
  return out;
}

function specNode(spec: FigSpec, sub: string | undefined): FigSpec {
  return sub && !sub.startsWith("-")
    ? (spec.subcommands ?? []).find((node) => toNameList(node.name).includes(sub)) ?? spec
    : spec;
}

/** null means this is not an option-value slot; [] means no known value matches. */
export function suggestOptionValues(spec: FigSpec, line: string, limit = 8): SuggestionResult[] | null {
  const { cmd, sub, current } = parseCommandLine(line);
  if (!cmd || current.startsWith("-")) return null;
  const node = specNode(spec, sub);
  const tokens = line.trimEnd().split(/\s+/).filter(Boolean);
  const prevToken = current === "" ? tokens[tokens.length - 1] : tokens[tokens.length - 2];
  const option = [...(node.options ?? []), ...(spec.options ?? [])]
    .find((opt) => opt.args && toNameList(opt.name).includes(prevToken ?? ""));
  if (!option) return null;
  const results: SuggestionResult[] = [];
  const seen = new Set<string>();
  for (const arg of toArgList(option.args)) {
    for (const value of argSuggestions(arg)) {
      if (!value.startsWith(current) || seen.has(value) || results.length >= limit) continue;
      seen.add(value);
      results.push({ command: value, source: "arg", kind: "arg", description: arg.description });
    }
  }
  return results;
}

/**
 * 生成参数建议（含子命令级解析）
 * @param spec 命令的 Fig spec（loadSpecs 后取）
 * @param line 当前输入整行（如 "apt install -"）
 * @param limit 最大条数
 */
export function suggestParams(
  spec: FigSpec,
  line: string,
  limit = 8,
): SuggestionResult[] {
  const { cmd, sub, current } = parseCommandLine(line);
  if (!cmd) return []; // 空行/仅前缀命令 → 无建议

  // 定位子命令节点（sub 为普通名字才查找；-o 这类 option 不是子命令）
  const node = specNode(spec, sub);
  const values = suggestOptionValues(spec, line, limit);
  if (values !== null) return values;

  const isOptionToken = current.startsWith("-");
  const results: SuggestionResult[] = [];
  const seen = new Set<string>();
  const push = (text: string, description?: string) => {
    if (!text || seen.has(text) || results.length >= limit) return;
    seen.add(text);
    results.push({
      command: text,
      source: "arg",
      kind: "arg",
      description,
    });
  };

  // options：当前层 + 顶层（--help/-v 等通用选项）
  const options: FigOption[] = [...(node.options ?? []), ...(spec.options ?? [])];
  if (!isOptionToken) {
    // 子命令（apt install / systemctl status）
    for (const sc of node.subcommands ?? []) {
      for (const nm of toNameList(sc.name)) {
        if (current === "" || nm.startsWith(current)) push(nm, sc.description);
      }
    }
    // 静态参数值（--format json）
    for (const arg of toArgList(node.args)) {
      for (const sug of argSuggestions(arg)) {
        if (current === "" || sug.startsWith(current)) push(sug, arg.description);
      }
    }
  }

  // An empty argument slot prefers subcommands/values over generic flags.
  for (const opt of options) {
    for (const nm of toNameList(opt.name)) {
      if ((isOptionToken && nm.startsWith(current)) || current === "") {
        push(nm, opt.description);
      }
    }
  }

  return results;
}
