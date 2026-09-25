export const DEFAULT_WATCH: string[];
export function traceEager(
  entry: string,
  watch?: string[],
): {
  moduleCount: number;
  /** 静态可达的本地模块（相对仓库根、正斜杠） */
  files: Set<string>;
  /** 这个图里出现的 `import("x")` 懒边界指向的本地模块（同样相对根） */
  lazyFiles: Set<string>;
  hits: Map<string, { spec: string; file: string }>;
};
