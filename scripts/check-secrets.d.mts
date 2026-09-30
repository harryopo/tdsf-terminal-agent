export type FindingKind = "token" | "password" | "allowed" | "sentinel-misuse";

export interface Finding {
  kind: FindingKind;
  filePath: string;
  lineno: number;
  rule: string;
  /** 前 2 字符 + 长度 + sha256 前 8 位 —— 判据的输出里永远不该出现凭据本体 */
  masked: string;
  /** 命中段被指纹替换后的行（仅报红时用，夹具豁免没有这个字段） */
  excerpt?: string;
  /** kind === "allowed" 时说明走的是哪条豁免 */
  why?: string;
}

export interface ScanOptions {
  filePath?: string;
  startLine?: number;
  /** 单测注入口：不传就按 filePath 去盘上读文件头判断有没有声明豁免 */
  fileDeclaresSentinel?: boolean;
}

export function scanText(text: string, options?: ScanOptions): Finding[];
export function mask(value: string): string;
