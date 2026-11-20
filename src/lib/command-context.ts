type Word = { value: string; from: number; to: number };

export type CommandContext = {
  cmd: string;
  tokens: string[];
  current: string;
  commandFrom: number;
  commandTo: number;
  currentFrom: number;
  quote: string;
};

/** Current simple-command segment only; never evaluates shell syntax. */
export function commandContext(line: string): CommandContext {
  let words: Word[] = [];
  let quote = "";
  let start = -1;
  let value = "";
  let unsupported = false;
  const finish = (to: number) => {
    if (start >= 0) words.push({ value, from: start, to });
    start = -1;
    value = "";
  };
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === "\\" && quote !== "'") {
      if (start < 0) start = index;
      if (/^[A-Za-z]:/.test(value) || line.slice(start, start + 2) === "\\\\") { value += char; continue; }
      if (index + 1 < line.length) value += line[++index];
      continue;
    }
    if (quote) {
      if (quote === '"' && (char === "`" || (char === "$" && line[index + 1] === "("))) unsupported = true;
      if (char === quote) quote = "";
      else value += char;
      continue;
    }
    if (char === "'" || char === '"') {
      if (start < 0) start = index;
      quote = char;
    } else if (/\s/.test(char)) {
      finish(index);
    } else if (char === "|" || char === ";" || (char === "&" && line[index + 1] === "&")) {
      finish(index);
      words = [];
      unsupported = false;
      if (line[index + 1] === char) index++;
    } else if (/[<>()`&]/.test(char) || (char === "$" && line[index + 1] === "(")) {
      unsupported = true;
    } else if (char === "#" && start < 0) {
      unsupported = true;
      break;
    } else {
      if (start < 0) start = index;
      value += char;
    }
  }
  const editing = start >= 0;
  finish(line.length);
  let base = 0;
  while (base < words.length) {
    const wrapper = words[base].value;
    if (/^[A-Za-z_][\w]*=/.test(wrapper)) { base++; continue; }
    if (!["sudo", "doas", "command", "env", "exec", "nohup", "time"].includes(wrapper)) break;
    base++;
    while (base < words.length && words[base].value.startsWith("-")) {
      const option = words[base++].value;
      if (option === "--") break;
      if ((wrapper === "sudo" && ["-u", "-g", "-h", "-p", "-C", "-T", "-r", "-t", "--user", "--group", "--host", "--prompt", "--close-from", "--command-timeout", "--role", "--type"].includes(option)) ||
          (wrapper === "doas" && option === "-u") ||
          (wrapper === "env" && ["-u", "--unset", "-C", "--chdir"].includes(option))) base++;
    }
  }
  const command = !unsupported ? words[base] : undefined;
  const last = words[words.length - 1];
  const currentFrom = editing && last ? last.from : line.length;
  return {
    cmd: command?.value ?? "",
    tokens: command ? words.slice(base).map((word) => word.value) : [],
    current: command && editing ? last.value : "",
    commandFrom: command?.from ?? line.length,
    commandTo: command?.to ?? line.length,
    currentFrom,
    quote,
  };
}

/** Preserve quotes and an attached option name when accepting a value. */
export function completionReplacement(line: string, value: string, argument: boolean, windows = false): { from: number; text: string } {
  const context = commandContext(line);
  if (!argument) return { from: context.commandFrom, text: value };
  const raw = line.slice(context.currentFrom);
  const equals = /^--?[\w-]+=/.exec(raw)?.[0] ?? "";
  const quoted = raw.slice(equals.length).startsWith("'") ? "'" : raw.slice(equals.length).startsWith('"') ? '"' : "";
  const singleQuoted = value.replace(/'/g, windows ? "''" : "'\\''");
  const escaped = quoted === "'" ? singleQuoted
    : quoted === '"' ? value.replace(windows ? /["$`]/g : /["\\$`]/g, (char) => (windows ? "`" : "\\") + char)
    : /[^A-Za-z0-9_./:=@%+,-]/.test(value) ? `'${singleQuoted}'` : value;
  if (context.tokens.length === 1 && context.current !== "") return { from: line.length, text: ` ${escaped} ` };
  const text = escaped + (quoted && !context.quote ? quoted : "");
  return { from: context.currentFrom + equals.length + quoted.length, text: raw === "" ? escaped + " " : text };
}
