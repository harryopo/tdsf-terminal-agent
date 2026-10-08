import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";
import { usePreferencesStore } from "@/modules/settings/preferences";

type HelpSpan = { start: number; length: number; kind: "option" | "value" };

/** Help tables only: an ASCII option column followed by a separated description. */
export function helpOutputSpans(text: string): HelpSpan[] {
  const row = /^( *)(-{1,2}[A-Za-z0-9][ -~]*?) {2,}\S/.exec(text);
  if (!row || /[;|&]/.test(row[2])) return [];
  return [...row[2].matchAll(/--?[A-Za-z0-9][A-Za-z0-9-]*|<[^<> ]+>|\b[A-Z][A-Z0-9_-]*\b/g)].map((match) => ({
    start: row[1].length + match.index,
    length: match[0].length,
    kind: match[0].startsWith("-") ? "option" : "value",
  }));
}

/** Viewport-only xterm decorations; never rewrites PTY data or buffer cells. */
export function registerHelpOutputHighlight(term: Terminal): () => void {
  const entries = new Map<number, { key: string; marker: IMarker; decorations: IDecoration[] }>();
  let raf: number | null = null;
  let disposed = false;
  const remove = (index: number) => {
    const entry = entries.get(index);
    if (!entry) return;
    entries.delete(index);
    entry.decorations.forEach((decoration) => decoration.dispose());
    entry.marker.dispose();
  };
  const refresh = () => {
    raf = null;
    if (disposed) return;
    const buffer = term.buffer.active;
    if (!usePreferencesStore.getState().terminalHelpHighlight || buffer.type !== "normal") {
      [...entries.keys()].forEach(remove);
      return;
    }
    const first = buffer.viewportY;
    // Do not color the active input/partial-output line.
    const end = Math.min(first + term.rows, buffer.baseY + buffer.cursorY);
    for (const index of entries.keys()) {
      if (index < first || index >= end) remove(index);
    }
    const theme = term.options.theme;
    const colors = { option: theme?.cyan ?? "#56b6c2", value: theme?.magenta ?? "#c678dd" };
    for (let index = first; index < end; index++) {
      const line = buffer.getLine(index);
      const spans = line && !line.isWrapped ? helpOutputSpans(line.translateToString(true)) : [];
      const runs: Array<{ x: number; width: number; color: string }> = [];
      for (const span of spans) {
        let start = -1;
        for (let x = span.start; x <= span.start + span.length; x++) {
          const cell = x < span.start + span.length ? line?.getCell(x) : undefined;
          if (cell?.isFgDefault() && cell.isBgDefault()) {
            if (start < 0) start = x;
          } else if (start >= 0) {
            runs.push({ x: start, width: x - start, color: colors[span.kind] });
            start = -1;
          }
        }
      }
      const key = JSON.stringify(runs);
      const previous = entries.get(index);
      if (previous?.key === key && previous.marker.line === index && !previous.marker.isDisposed) continue;
      remove(index);
      if (!runs.length) continue;
      const marker = term.registerMarker(index - buffer.baseY - buffer.cursorY);
      if (!marker) continue;
      const decorations = runs.map(({ x, width, color }) => term.registerDecoration({
        marker, x, width, foregroundColor: color, layer: "bottom",
      })).filter((decoration): decoration is IDecoration => decoration !== undefined);
      entries.set(index, { key, marker, decorations });
    }
  };
  const schedule = () => {
    if (!disposed && raf === null) raf = requestAnimationFrame(refresh);
  };
  const listeners = [term.onWriteParsed(schedule), term.onScroll(schedule), term.onRender(schedule), term.onResize(schedule)];
  const unsubscribe = usePreferencesStore.subscribe((next, prev) => {
    if (next.terminalHelpHighlight !== prev.terminalHelpHighlight) schedule();
  });
  schedule();
  return () => {
    disposed = true;
    if (raf !== null) cancelAnimationFrame(raf);
    listeners.forEach((listener) => listener.dispose());
    unsubscribe();
    [...entries.keys()].forEach(remove);
  };
}
