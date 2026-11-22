/** Static Fig candidates share the same command context as dynamic completion. */
import type { FigArg, FigOption, FigSpec } from "./types";
import type { SuggestionResult } from "@/lib/suggest-engine";
import { commandContext } from "@/lib/command-context";
import { tldrOptionZh } from "./tldr-params";

export interface ParsedLine {
  cmd?: string;
  sub?: string;
  current: string;
}

export function parseCommandLine(line: string): ParsedLine {
  const { cmd, tokens, current } = commandContext(line);
  if (!cmd) return { current: "" };
  return { cmd, sub: tokens[1]?.startsWith("-") ? undefined : tokens[1], current };
}

function names(name: string | string[] | undefined): string[] {
  return name === undefined ? [] : Array.isArray(name) ? name : [name];
}

function args(value: FigArg | FigArg[] | undefined): FigArg[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function values(arg: FigArg, prefix: string, limit: number, description?: string): SuggestionResult[] {
  const result: SuggestionResult[] = [];
  for (const entry of arg.suggestions ?? []) {
    for (const name of names(typeof entry === "string" ? entry : entry.name)) {
      if (!name.startsWith(prefix) || result.some((item) => item.command === name) || result.length >= limit) continue;
      result.push({ command: name, kind: "arg", source: "arg", description: (typeof entry === "string" ? undefined : entry.description) ?? arg.description ?? description });
    }
  }
  return result;
}

function specContext(spec: FigSpec, line: string) {
  const context = commandContext(line);
  const completed = context.tokens.slice(1, context.currentFrom < line.length ? -1 : undefined);
  const ancestors = [spec];
  let node = spec;
  let positional = 0;
  let literal = false;
  let pending: FigArg | undefined;
  let pendingOption: FigOption | undefined;
  const options = () => [...node.options ?? [], ...ancestors.slice(0, -1).reverse().flatMap((parent) => parent.options ?? [])];
  for (let index = 0; index < completed.length; index++) {
    const token = completed[index];
    if (!literal && token === "--") { literal = true; continue; }
    const option = !literal ? options().find((opt) => names(opt.name).includes(token.split("=")[0])) : undefined;
    if (option) {
      const optionArgs = args(option.args);
      for (let argIndex = token.includes("=") ? 1 : 0; argIndex < optionArgs.length; argIndex++) {
        if (index + 1 >= completed.length) { pending = optionArgs[argIndex]; pendingOption = option; break; }
        if (optionArgs[argIndex].isOptional && completed[index + 1].startsWith("-")) break;
        index++;
      }
      continue;
    }
    if (!literal && token.startsWith("-")) continue;
    const sub = !literal && positional === 0 ? node.subcommands?.find((item) => names(item.name).includes(token)) : undefined;
    if (sub) { node = sub; ancestors.push(sub); positional = 0; }
    else positional++;
  }
  const attached = !literal ? /^(-[^=]+)=(.*)$/.exec(context.current) : null;
  if (attached) {
    pendingOption = options().find((opt) => names(opt.name).includes(attached[1]));
    pending = args(pendingOption?.args)[0];
  }
  const valueDescription = pendingOption ? names(pendingOption.name).map((name) => tldrOptionZh(context.cmd, name)).find(Boolean)
    ?? `参数值（${names(pendingOption.name)[0]}）${pendingOption.description ? `：${pendingOption.description}` : ""}` : undefined;
  return { context, node, options: options(), positional, literal, pending, valueDescription, valuePrefix: attached?.[2] ?? context.current };
}

/** null is not a value slot; [] is a known value slot without matching data. */
export function suggestOptionValues(spec: FigSpec, line: string, limit = 8): SuggestionResult[] | null {
  const { context, pending, valuePrefix, valueDescription } = specContext(spec, line);
  return context.cmd && pending ? values(pending, valuePrefix, limit, valueDescription) : null;
}

export function suggestParams(spec: FigSpec, line: string, limit = 8): SuggestionResult[] {
  const { context, node, options, positional, literal, pending, valuePrefix, valueDescription } = specContext(spec, line);
  if (!context.cmd) return [];
  if (pending) return values(pending, valuePrefix, limit, valueDescription);
  const result: SuggestionResult[] = [];
  const add = (name: string, description?: string) => {
    if (result.length < limit && !result.some((item) => item.command === name)) result.push({ command: name, description, kind: "arg", source: "arg" });
  };
  if (!context.current.startsWith("-") || literal) {
    if (!literal && positional === 0) {
      for (const sub of node.subcommands ?? []) {
        for (const name of names(sub.name)) if (name.startsWith(context.current)) add(name, sub.description);
      }
    }
    const positionalArgs = args(node.args);
    const arg = positionalArgs[positional] ?? (positionalArgs.at(-1)?.isVariadic ? positionalArgs.at(-1) : undefined);
    if (arg) for (const item of values(arg, context.current, limit)) add(item.command, item.description);
  }
  if (!literal && (context.current === "" || context.current.startsWith("-"))) {
    for (const option of options) {
      for (const name of names(option.name)) if (name.startsWith(context.current)) add(name, option.description);
    }
  }
  return result;
}
