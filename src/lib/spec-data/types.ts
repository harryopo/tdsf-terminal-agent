/**
 * types.ts — Fig completion spec 类型子集 (TDSF 2026-08-15)
 * -----------------------------------------------------------------------------
 * 仅保留前端可用的静态字段（动态 generators 函数已在构建时剥离）。
 * 与 scripts/build-fig-specs.mjs 的 cleanSpec 输出对齐。
 * 完整 schema 见 opensource-reference/fig-autocomplete/schemas/fig-spec-schema.json
 */

/** Fig spec：一个命令的结构化定义（命令/子命令/选项/参数） */
export interface FigSpec {
  name?: string | string[];
  description?: string;
  options?: FigOption[];
  subcommands?: FigSpec[];
  args?: FigArg | FigArg[];
}

export interface FigOption {
  /** 短/长名，如 "-n" 或 ["-o", "--output"] */
  name?: string | string[];
  description?: string;
  /** 该选项后面跟随的参数 */
  args?: FigArg | FigArg[];
  /** 持久化选项（子命令下也可用，如 --help） */
  isPersistent?: boolean;
  /** 互斥选项 */
  exclusiveOn?: string[];
}

export interface FigArg {
  name?: string;
  description?: string;
  /** 静态参数值建议，如 ["json", "yaml"] 或 [{ name, description }] */
  suggestions?: Array<string | { name?: string; description?: string }>;
  isOptional?: boolean;
  isVariadic?: boolean;
}
