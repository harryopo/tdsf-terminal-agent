import { Terminal, type IDecorationOptions, type ITheme } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFERENCES } from "@/modules/settings/store";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { readTerminalTokens } from "@/styles/tokens";
import { helpOutputSpans, registerHelpOutputHighlight } from "./helpOutputHighlight";

let frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
const terminals: Terminal[] = [];

function createTerminal(
  rows = 10,
  theme: ITheme = { cyan: "#112233", magenta: "#445566" },
): Terminal {
  const term = new Terminal({
    cols: 100,
    rows,
    scrollback: 12,
    allowProposedApi: true,
    theme,
  });
  terminals.push(term);
  return term;
}

function flushFrame(): void {
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

beforeEach(() => {
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    const id = ++nextFrame;
    frames.set(id, callback);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  usePreferencesStore.setState({
    ...DEFAULT_PREFERENCES,
    terminalHelpHighlight: true,
  });
  document.documentElement.style.removeProperty("--terminal-ansi-cyan");
  document.documentElement.style.removeProperty("--terminal-ansi-magenta");
});

afterEach(() => {
  terminals.splice(0).forEach((term) => term.dispose());
  usePreferencesStore.setState({ terminalHelpHighlight: true });
  document.documentElement.style.removeProperty("--terminal-ansi-cyan");
  document.documentElement.style.removeProperty("--terminal-ansi-magenta");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("helpOutputSpans", () => {
  it("finds help option aliases and argument placeholders before Chinese descriptions", () => {
    expect(helpOutputSpans("  -h, --help <FILE>  显示帮助")).toEqual([
      { start: 2, length: 2, kind: "option" },
      { start: 6, length: 6, kind: "option" },
      { start: 13, length: 6, kind: "value" },
    ]);
    expect(helpOutputSpans("  -o FILE    输出路径")).toEqual([
      { start: 2, length: 2, kind: "option" },
      { start: 5, length: 4, kind: "value" },
    ]);
  });

  it("ignores prose, prompts, command rows, and unaligned output", () => {
    for (const text of [
      "ordinary output mentions --help",
      "user@host:~$ -h, --help      show help",
      "  -h, --help show help",
      "  -x; command      description",
      "  -x | command      description",
    ]) {
      expect(helpOutputSpans(text)).toEqual([]);
    }
  });
});

describe("registerHelpOutputHighlight with real xterm", () => {
  it("decorates visible default-color help cells only and preserves terminal text/colors", async () => {
    const term = createTerminal();
    const host = document.createElement("div");
    document.body.append(host);
    term.open(host);
    const decorate = vi.spyOn(term, "registerDecoration");
    const dispose = registerHelpOutputHighlight(term);
    const payload = [
      "  -h, --help <FILE>  显示帮助",
      "\u001b[31m  -v, --version\u001b[0m      输出版本",
      "  -o \u001b[44mFILE\u001b[0m    输出路径",
      "ordinary output",
      "user@host:~$ --help",
      "  -q, --quiet      partial current row",
    ].join("\r\n");
    await write(term, payload);

    const textBefore = Array.from({ length: 6 }, (_, row) =>
      term.buffer.active.getLine(row)!.translateToString(true),
    );
    const colorsBefore = [cellColors(term, 0), cellColors(term, 1), cellColors(term, 2)];
    term.select(2, 0, 8);
    const selectionBefore = term.getSelection();
    const expectedText = payload.replace(/\u001b\[[0-9;]*m/g, "").split("\r\n");
    expect(textBefore).toEqual(expectedText);
    expect(selectionBefore).toBe("-h, --he");

    flushFrame();
    expect(Array.from({ length: 6 }, (_, row) =>
      term.buffer.active.getLine(row)!.translateToString(true),
    )).toEqual(textBefore);
    expect([cellColors(term, 0), cellColors(term, 1), cellColors(term, 2)]).toEqual(colorsBefore);
    expect(term.getSelection()).toBe(selectionBefore);

    const options = decorate.mock.calls.map(([value]) => value as IDecorationOptions);
    expect(options.map(({ marker, x, width, foregroundColor }) => [
      marker.line, x, width, foregroundColor,
    ])).toEqual([
      [0, 2, 2, "#112233"],
      [0, 6, 6, "#112233"],
      [0, 13, 6, "#445566"],
      [2, 2, 2, "#112233"],
    ]);
    expect(options.some(({ marker }) => marker.line === 1)).toBe(false);
    expect(options.some(({ marker }) => marker.line === 5)).toBe(false);

    dispose();
    expect(Array.from({ length: 6 }, (_, row) =>
      term.buffer.active.getLine(row)!.translateToString(true),
    )).toEqual(textBefore);
    expect([cellColors(term, 0), cellColors(term, 1), cellColors(term, 2)]).toEqual(colorsBefore);
    expect(term.getSelection()).toBe(selectionBefore);
    expect(term.buffer.active.getLine(0)!.translateToString(true)).toContain("显示帮助");
  });

  it("passes actual readTerminalTokens rgb colors into xterm decorations", async () => {
    document.documentElement.style.setProperty(
      "--terminal-ansi-cyan",
      "rgb(86, 182, 194)",
    );
    document.documentElement.style.setProperty(
      "--terminal-ansi-magenta",
      "rgb(198, 120, 221)",
    );
    const tokens = readTerminalTokens();
    expect(tokens.ansiCyan).toBe("rgb(86, 182, 194)");
    expect(tokens.ansiMagenta).toBe("rgb(198, 120, 221)");

    const term = createTerminal(10, {
      cyan: tokens.ansiCyan,
      magenta: tokens.ansiMagenta,
    });
    const decorate = vi.spyOn(term, "registerDecoration");
    const dispose = registerHelpOutputHighlight(term);
    await write(term, "  -h, --help <FILE>  显示帮助\r\n");
    flushFrame();

    const colors = decorate.mock.calls.map(([options]) =>
      (options as IDecorationOptions).foregroundColor,
    );
    expect(colors).toEqual([
      tokens.ansiCyan,
      tokens.ansiCyan,
      tokens.ansiMagenta,
    ]);
    expect(decorate.mock.results.every(({ value }) => value !== undefined)).toBe(true);
    dispose();
  });

  it("tracks scrollback trimming and resize without retaining off-viewport markers", async () => {
    const term = createTerminal(5);
    const decorate = vi.spyOn(term, "registerDecoration");
    const dispose = registerHelpOutputHighlight(term);
    await write(
      term,
      Array.from({ length: 40 }, (_, i) => `  -h, --help      帮助 ${i}`).join("\r\n"),
    );
    flushFrame();
    expect(term.buffer.active.baseY).toBeGreaterThan(0);
    expect(activeMarkers(term).length).toBeLessThanOrEqual(term.rows);

    term.scrollToLine(Math.max(0, term.buffer.active.baseY - 2));
    flushFrame();
    term.resize(80, 7);
    flushFrame();
    const buffer = term.buffer.active;
    expect(activeMarkers(term).length).toBeLessThanOrEqual(term.rows);
    for (const marker of activeMarkers(term)) {
      expect(marker.line).toBeGreaterThanOrEqual(buffer.viewportY);
      expect(marker.line).toBeLessThan(buffer.viewportY + term.rows);
      expect(buffer.getLine(marker.line)!.translateToString(true)).toContain("--help");
    }
    for (const [decoration] of decorate.mock.calls) {
      const { marker } = decoration as IDecorationOptions;
      const x = decoration.x ?? 0;
      const width = decoration.width ?? 1;
      if (!marker.isDisposed) {
        const text = buffer.getLine(marker.line)!.translateToString(true);
        expect(text.slice(x, x + width)).toMatch(/^-h|^--help/);
      }
    }
    expect(decorate.mock.calls.length).toBeGreaterThan(0);
    dispose();
  });

  it("reacts to preference toggles, ignores the alternate buffer, and disposes listeners", async () => {
    const term = createTerminal();
    const decorate = vi.spyOn(term, "registerDecoration");
    const dispose = registerHelpOutputHighlight(term);
    flushFrame();
    await write(term, "  -h, --help      show help\r\n");
    flushFrame();
    expect(decorate).toHaveBeenCalled();
    const initialCalls = decorate.mock.calls.length;
    const marker = activeMarkers(term)[0];

    usePreferencesStore.setState({ terminalHelpHighlight: false });
    flushFrame();
    expect(marker.isDisposed).toBe(true);
    expect(activeMarkers(term)).toHaveLength(0);
    usePreferencesStore.setState({ terminalHelpHighlight: true });
    flushFrame();
    expect(decorate.mock.calls.length).toBeGreaterThan(initialCalls);
    const callsAfterEnable = decorate.mock.calls.length;

    await write(term, "\u001b[?1049h  -x, --xray      alternate help\r\n");
    flushFrame();
    expect(term.buffer.active.type).toBe("alternate");
    expect(decorate.mock.calls.length).toBe(callsAfterEnable);

    dispose();
    expect(frames.size).toBe(0);
    const callsAtDispose = decorate.mock.calls.length;

    usePreferencesStore.setState({ terminalHelpHighlight: false });
    await write(term, "\u001b[?1049l\r\n  -q, --quiet      after dispose\r\n");
    flushFrame();
    expect(frames.size).toBe(0);
    expect(decorate.mock.calls.length).toBe(callsAtDispose);
    expect(term.buffer.active.type).toBe("normal");
  });
});
