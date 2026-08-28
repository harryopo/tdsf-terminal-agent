/**
 * tldr-params.ts — tldr 选项级中文参数候选（TDSF 2026-08-28 二轮改进）
 * -----------------------------------------------------------------------------
 * 背景（用户实测反馈）：carapace 只有 git/docker/npm 等开发工具 completer，
 * Fig specs 也没有 ls/ip/systemctl 等基础命令——SSH 终端输完 `ls ` 弹不出 -l。
 * 而 tldr-zh-options.ts 已有 168 命令/1291 选项的中文说明数据（ls 的 -a/-l/-lh、
 * systemctl、grep、chmod 全覆盖），本文件把它接入参数预测数据源。
 *
 * 产出与 paramSuggest/param-complete-client 一致：SuggestionResult，
 * kind:'arg' / source:'arg'（acceptPrediction 的 token 替换逻辑共用）。
 * 数据缺失（命令不在表内）→ 返回 []，调用方降级到其他数据源，无害。
 */
import type { SuggestionResult } from '@/lib/suggest-engine';
import { TLDR_ZH_OPTIONS } from './generated/tldr-zh-options';
import { SPEC_INDEX } from './generated/spec-index';

/** SPEC_INDEX 是数组，转 Set 一次（模块级，避免每次按键重建） */
const specCommandNames = new Set(SPEC_INDEX.map((entry) => entry.name));

/**
 * 单条选项的中文说明（cmd 或 opt 不在表内 → undefined）。
 * 供 param-complete-client 的 mergeCandidates zhDescription 钩子使用：
 * carapace 动态候选的英文描述优先换成 tldr 中文说明。
 */
export function tldrOptionZh(cmd: string, opt: string): string | undefined {
  return TLDR_ZH_OPTIONS[cmd]?.[opt];
}

/**
 * tldr 参数候选：查 TLDR_ZH_OPTIONS[cmd]。
 *   - current === ''（刚打完空格）→ 返回全部选项（按对象键序，稳定输出）
 *   - current 非空 → 仅返回以 current 开头的选项（前缀匹配，与终端补全直觉一致）
 *   - cmd 不在表内 → []（如 ip：tldr 数据没覆盖主 ip 页，由缩写表兜底）
 */
export function tldrParamSuggestions(
  cmd: string,
  current: string,
  limit = 8,
): SuggestionResult[] {
  const table = TLDR_ZH_OPTIONS[cmd];
  if (!table) return [];
  const out: SuggestionResult[] = [];
  // Object.entries 按字符串键的插入序遍历（生成器写入序 = tldr 页示例行序，
  // 高频示例在前），保证输出稳定
  for (const [opt, zh] of Object.entries(table)) {
    if (out.length >= limit) break;
    if (current && !opt.startsWith(current)) continue;
    out.push({
      command: opt,
      source: 'arg',
      kind: 'arg',
      description: zh,
    });
  }
  return out;
}

/**
 * 判断命令名是否有参数候选数据源（tldr 表 || Fig specs 索引）。
 * 供"尾部无空格触发"使用：输完命令名（如 `ls`，还没敲空格）时判断
 * 是否值得并行拉一次参数候选（避免对无数据源的命令白拉）。
 */
export function isParamCandidateCommand(name: string): boolean {
  if (!name) return false;
  return (
    Object.prototype.hasOwnProperty.call(TLDR_ZH_OPTIONS, name) ||
    specCommandNames.has(name)
  );
}
