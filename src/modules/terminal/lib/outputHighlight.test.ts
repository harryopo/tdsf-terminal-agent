import { Terminal, type IDecorationOptions } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readTerminalTokens } from "@/styles/tokens";
import { outputHighlightSpans } from "./outputSyntaxHighlight";
import { registerOutputHighlight } from "./outputHighlight";

let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
const terminals: Terminal[] = [];

function createTerminal(
  rows = 10,
  theme?: { cyan: string; magenta: string },
): Terminal {
  const term = new Terminal({ cols: 100, rows, scrollback: 12, allowProposedApi: true, theme });
  terminals.push(term);
  return term;
}

async function flushFrame(): Promise<void> {
  await vi.dynamicImportSettled();
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach((callback) => callback(0));
}

function write(term: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => term.write(data, resolve));
}

function cellColors(term: Terminal, row: number): number[][] {
  const line = term.buffer.active.getLine(row)!;
  return Array.from({ length: term.cols }, (_, x) => {
    const cell = line.getCell(x)!;
    return [cell.getFgColorMode(), cell.getFgColor(), cell.getBgColorMode(), cell.getBgColor()];
  });
}

function activeMarkers(term: Terminal) {
  return term.markers.filter((marker) => !marker.isDisposed);
}

function spanFor(text: string, token: string, kind: string) {
  return expect(outputHighlightSpans(text)).toContainEqual(expect.objectContaining({
    start: text.indexOf(token),
    length: token.length,
    kind,
  }));
}

beforeEach(() => {
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});

afterEach(() => {
  terminals.splice(0).forEach((term) => term.dispose());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("outputHighlightSpans", () => {
  it("classifies structured values, code, config, logs, paths, and addresses", () => {
    const json = '{"state":"connected","count":200,"path":"/tmp/demo","enabled":true}';
    spanFor(json, '"state"', "key");
    spanFor(json, '"connected"', "string");
    spanFor(json, "200", "number");
    spanFor(json, '"/tmp/demo"', "string");

    const code = 'const result = await fetch("http://127.0.0.1:8080/api"); // note';
    spanFor(code, "const", "keyword");
    spanFor(code, '"http://127.0.0.1:8080/api"', "string");
    spanFor(code, "// note", "comment");
    spanFor('const data = {"count": 2};', "const", "keyword");
    const shellJson = "echo '{\"count\":2}'";
    spanFor(shellJson, "'{\"count\":2}'", "string");
    const shell = "sudo systemctl --timestamp=iso status sshd";
    spanFor(shell, "sudo", "keyword");
    spanFor(shell, "--timestamp", "option");
    const python = 'message = "ready"';
    spanFor(python, '"ready"', "string");

    const config = "PermitRootLogin no";
    spanFor(config, "PermitRootLogin", "key");
    spanFor(config, "no", "value");

    const log = "[ERROR] Failed to load /etc/ssh/sshd_config";
    spanFor(log, "ERROR", "error");
    spanFor("[WARN] disk space low", "WARN", "warning");
    spanFor("/var/log/syslog", "/var/log/syslog", "path");
    spanFor("[INFO] listening on 127.0.0.1:8080", "127.0.0.1:8080", "address");
  });

  it("leaves ordinary prose without recognizable tokens unclassified", () => {
    spanFor("  -h, --help <FILE>  显示帮助", "--help", "option");
    for (const text of ["A normal sentence with no technical values.", "the service is ready"]) {
      expect(outputHighlightSpans(text)).toEqual([]);
    }
    expect(outputHighlightSpans("ordinary output mentions --help")).toEqual([]);
    expect(outputHighlightSpans("A normal sentence mentions /tmp/example."))
      .toContainEqual(expect.objectContaining({ kind: "path" }));
  });
});

describe("registerOutputHighlight with real xterm", () => {
  it("decorates output without changing ANSI cells, selection, or copied terminal text", async () => {
    const term = createTerminal();
    const host = document.createElement("div");
    document.body.append(host);
    term.open(host);
    const decorate = vi.spyOn(term, "registerDecoration");
    const dispose = registerOutputHighlight(term);
    const payload = [
      '\u001b[31m{"state":"connected","count":200,"path":"/tmp/demo"}\u001b[0m',
      '{"state":"connected","count":201,"path":"/tmp/demo"}',
      "const value = 1; // comment",
      "ordinary output",
      "user@host:~$ sudo systemctl status sshd",
    ].join("\r\n");
    await write(term, payload);

    const textBefore = Array.from({ length: 5 }, (_, row) =>
      term.buffer.active.getLine(row)!.translateToString(true),
    );
    const colorsBefore = [cellColors(term, 0), cellColors(term, 1), cellColors(term, 2)];
    term.select(2, 0, 8);
    const selectionBefore = term.getSelection();
    expect(textBefore[0]).toContain('"state":"connected"');
    expect(selectionBefore).toBe('state":"');

    await flushFrame();
    expect(decorate).toHaveBeenCalled();
    expect(Array.from({ length: 5 }, (_, row) =>
      term.buffer.active.getLine(row)!.translateToString(true),
    )).toEqual(textBefore);
    expect([cellColors(term, 0), cellColors(term, 1), cellColors(term, 2)]).toEqual(colorsBefore);
    expect(term.getSelection()).toBe(selectionBefore);
    const decoratedRows = decorate.mock.calls.map(([value]) =>
      (value as IDecorationOptions).marker.line,
    );
    expect(decoratedRows).not.toContain(0);
    expect(decoratedRows).toContain(1);
    expect(decoratedRows).not.toContain(4);

    dispose();
    expect(Array.from({ length: 5 }, (_, row) =>
      term.buffer.active.getLine(row)!.translateToString(true),
    )).toEqual(textBefore);
    expect([cellColors(term, 0), cellColors(term, 1), cellColors(term, 2)]).toEqual(colorsBefore);
    expect(term.getSelection()).toBe(selectionBefore);
  });

  it("uses the current RGB theme colors for help options and values", async () => {
    const rootStyle = document.documentElement.style;
    const cyanBefore = rootStyle.getPropertyValue("--terminal-ansi-cyan");
    const cyanPriority = rootStyle.getPropertyPriority("--terminal-ansi-cyan");
    const magentaBefore = rootStyle.getPropertyValue("--terminal-ansi-magenta");
    const magentaPriority = rootStyle.getPropertyPriority("--terminal-ansi-magenta");
    let dispose: (() => void) | undefined;
    try {
      rootStyle.setProperty("--terminal-ansi-cyan", "rgb(86, 182, 194)");
      rootStyle.setProperty("--terminal-ansi-magenta", "rgb(198, 120, 221)");
      const tokens = readTerminalTokens();
      expect(tokens.ansiCyan).toBe("rgb(86, 182, 194)");
      expect(tokens.ansiMagenta).toBe("rgb(198, 120, 221)");

      const term = createTerminal(10, {
        cyan: tokens.ansiCyan,
        magenta: tokens.ansiMagenta,
      });
      const decorate = vi.spyOn(term, "registerDecoration");
      dispose = registerOutputHighlight(term);
      await write(term, "  -h, --help <FILE>  显示帮助\r\n");
      await flushFrame();

      const colors = decorate.mock.calls.map(([options]) =>
        (options as IDecorationOptions).foregroundColor,
      );
      expect(colors).toEqual([
        tokens.ansiCyan,
        tokens.ansiCyan,
        tokens.ansiMagenta,
      ]);
      expect(decorate.mock.results.every(({ value }) => value !== undefined)).toBe(true);
    } finally {
      dispose?.();
      if (cyanBefore) rootStyle.setProperty("--terminal-ansi-cyan", cyanBefore, cyanPriority);
      else rootStyle.removeProperty("--terminal-ansi-cyan");
      if (magentaBefore) rootStyle.setProperty("--terminal-ansi-magenta", magentaBefore, magentaPriority);
      else rootStyle.removeProperty("--terminal-ansi-magenta");
    }
  });

  it("maps wide Unicode prefixes to xterm cell columns", async () => {
    const term = createTerminal();
    const decorate = vi.spyOn(term, "registerDecoration");
    const dispose = registerOutputHighlight(term);
    await write(term, '中文🙂 {"state":"connected"}\r\n');
    await flushFrame();

    const state = decorate.mock.calls
      .map(([value]) => value as IDecorationOptions)
      .find((value) => value.marker.line === 0 && term.buffer.active.getLine(0)!
        .translateToString(true)
        .slice(value.x ?? 0, (value.x ?? 0) + (value.width ?? 1))
        .includes("state"));
    expect(state).toBeDefined();
    expect(state?.x).toBe(7);
    dispose();
  });

  it("coalesces writes into a stable animation frame without duplicate decorations", async () => {
    const term = createTerminal();
    const decorate = vi.spyOn(term, "registerDecoration");
    const dispose = registerOutputHighlight(term);
    await write(term, '{"state":"connected"}\r\n');
    await write(term, '{"state":"connected"}\r\n');
    expect(frames.size).toBe(1);
    await flushFrame();
    const initialCalls = decorate.mock.calls.length;
    expect(initialCalls).toBeGreaterThan(0);

    term.refresh(0, 1);
    await flushFrame();
    expect(decorate.mock.calls.length).toBe(initialCalls);
    dispose();
  });

  it("tracks scrollback trimming and resize without retaining off-viewport markers", async () => {
    const term = createTerminal(5);
    const decorate = vi.spyOn(term, "registerDecoration");
    const dispose = registerOutputHighlight(term);
    await write(
      term,
      Array.from({ length: 40 }, (_, i) => `{"state":"connected","count":${i}}`).join("\r\n"),
    );
    await flushFrame();
    expect(term.buffer.active.baseY).toBeGreaterThan(0);
    expect(activeMarkers(term).length).toBeLessThanOrEqual(term.rows);

    term.scrollToLine(Math.max(0, term.buffer.active.baseY - 2));
    await flushFrame();
    term.resize(80, 7);
    await flushFrame();
    const buffer = term.buffer.active;
    expect(activeMarkers(term).length).toBeLessThanOrEqual(term.rows);
    for (const marker of activeMarkers(term)) {
      expect(marker.line).toBeGreaterThanOrEqual(buffer.viewportY);
      expect(marker.line).toBeLessThan(buffer.viewportY + term.rows);
      expect(buffer.getLine(marker.line)!.translateToString(true)).toContain("state");
    }
    expect(decorate.mock.calls.length).toBeGreaterThan(0);
    dispose();
  });

  it("releases decorations in the alternate buffer and rebuilds on return", async () => {
    const term = createTerminal();
    const decorate = vi.spyOn(term, "registerDecoration");
    const dispose = registerOutputHighlight(term);
    await write(term, '{"state":"connected"}\r\n');
    await flushFrame();
    expect(decorate).toHaveBeenCalled();
    const callsBeforeAlt = decorate.mock.calls.length;

    await write(term, "\u001b[?1049h{\"state\":\"alternate\"}\r\n");
    await flushFrame();
    expect(term.buffer.active.type).toBe("alternate");
    expect(activeMarkers(term)).toHaveLength(0);
    const callsInAlt = decorate.mock.calls.length;
    expect(callsInAlt).toBeLessThanOrEqual(callsBeforeAlt);

    await write(term, "\u001b[?1049l\r\n");
    await flushFrame();
    expect(term.buffer.active.type).toBe("normal");
    expect(decorate.mock.calls.length).toBeGreaterThan(callsInAlt);

    dispose();
    expect(frames.size).toBe(0);
    const callsAtDispose = decorate.mock.calls.length;
    await write(term, "\r\n{\"state\":\"after dispose\"}\r\n");
    await flushFrame();
    expect(frames.size).toBe(0);
    expect(decorate.mock.calls.length).toBe(callsAtDispose);
  });
});
