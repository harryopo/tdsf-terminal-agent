import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";
import type { Kind, OutputSpan } from "./outputSyntaxHighlight";

/** Always enabled, viewport bounded, and never mutates PTY bytes or buffer cells. */
export function registerOutputHighlight(term: Terminal): () => void {
  const entries = new Map<number, { key: string; marker: IMarker; decorations: IDecoration[] }>();
  let cache = new Map<string, OutputSpan[]>();
  let classify: ((text: string) => OutputSpan[]) | null = null;
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
    if (buffer.type !== "normal") {
      [...entries.keys()].forEach(remove);
      return;
    }
    const first = buffer.viewportY;
    const end = Math.min(first + term.rows, buffer.baseY + buffer.cursorY);
    for (const index of entries.keys()) if (index < first || index >= end) remove(index);
    const theme = term.options.theme;
    const colors: Record<Kind, string> = {
      option: theme?.cyan ?? "#56b6c2", value: theme?.magenta ?? "#c678dd",
      keyword: theme?.magenta ?? "#c678dd", string: theme?.green ?? "#98c379",
      number: theme?.yellow ?? "#e5c07b", key: theme?.cyan ?? "#56b6c2",
      comment: theme?.brightBlack ?? "#7f848e", error: theme?.red ?? "#e06c75",
      warning: theme?.yellow ?? "#e5c07b", success: theme?.green ?? "#98c379",
      path: theme?.cyan ?? "#56b6c2", address: theme?.blue ?? "#61afef",
    };
    const nextCache = new Map<string, OutputSpan[]>();
    for (let index = first; index < end; index++) {
      const line = buffer.getLine(index);
      const text = line?.translateToString(true) ?? "";
      const spans = line && !line.isWrapped ? (classify ? cache.get(text) ?? classify(text) : []) : [];
      nextCache.set(text, spans);
      const runs: Array<{ x: number; width: number; color: string }> = [];
      let offset = 0;
      for (let x = 0; line && x < line.length && offset < text.length; x++) {
        const cell = line.getCell(x)!;
        if (cell.getWidth() === 0) continue;
        const length = (cell.getChars() || " ").length;
        const span = spans.find((item) => item.start < offset + length && item.start + item.length > offset);
        if (span && cell.isFgDefault() && cell.isBgDefault()) {
          const color = colors[span.kind];
          const previous = runs.at(-1);
          if (previous && previous.x + previous.width === x && previous.color === color) previous.width += cell.getWidth();
          else runs.push({ x, width: cell.getWidth(), color });
        }
        offset += length;
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
    cache = nextCache;
  };
  const schedule = () => { if (!disposed && raf === null) raf = requestAnimationFrame(refresh); };
  const listeners = [term.onWriteParsed(schedule), term.onScroll(schedule), term.onRender(schedule), term.onResize(schedule)];
  void import("./outputSyntaxHighlight").then((module) => {
    if (disposed) return;
    classify = module.outputHighlightSpans;
    cache.clear();
    schedule();
  }).catch(() => console.warn("[terminal] Output highlighting unavailable"));
  schedule();
  return () => {
    disposed = true;
    if (raf !== null) cancelAnimationFrame(raf);
    listeners.forEach((listener) => listener.dispose());
    [...entries.keys()].forEach(remove);
    cache.clear();
  };
}
