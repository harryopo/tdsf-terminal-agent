/**
 * command-abbrevs.ts — 子命令缩写表（教学高频，TDSF 2026-08-28 二轮改进）
 * -----------------------------------------------------------------------------
 * 背景（用户实测反馈）：输 `ip a` 没预测——ip 的子命令缩写（a=address 等）
 * 既不在 carapace（无 ip completer）也不在 Fig specs/tldr（无 ip 数据）。
 * 参考 fish-shell 的 ip.fish completions 样板手编教学高频缩写。
 *
 * 匹配语义：用户输入 current（如 `ip a` 的 "a"）时，abbrev 或 full 以
 * current 开头的条目都命中（`ip ad` → address；`ip l` → link）。
 * 宁缺毋滥：只收确认无误的缩写/子命令，useradd/usermod 这类无缩写命令不编。
 */
import type { SuggestionResult } from './suggest-engine';

/** 单条缩写：abbrev=用户可敲的缩写形式，full=完整子命令，zh=中文教学说明 */
export interface CommandAbbrev {
  abbrev: string;
  full: string;
  zh: string;
}

/**
 * 命令 → 子命令缩写表。start/stop/list-units 等完整子命令也收进来：
 * 用户敲 `systemctl st` 时 start/status/restart 都能按前缀命中提示。
 */
export const COMMAND_ABBREVS: Record<string, CommandAbbrev[]> = {
  ip: [
    { abbrev: 'a', full: 'address', zh: '查看/管理 IP 地址' },
    { abbrev: 'addr', full: 'address', zh: '查看/管理 IP 地址' },
    { abbrev: 'l', full: 'link', zh: '查看/管理网络接口' },
    { abbrev: 'r', full: 'route', zh: '查看/管理路由表' },
    { abbrev: 'n', full: 'neighbour', zh: '查看 ARP 邻居表' },
    { abbrev: 's', full: 'stats', zh: '查看网络统计信息' },
  ],
  systemctl: [
    { abbrev: 's', full: 'status', zh: '查看单元运行状态' },
    { abbrev: 'start', full: 'start', zh: '启动单元' },
    { abbrev: 'stop', full: 'stop', zh: '停止单元' },
    { abbrev: 'restart', full: 'restart', zh: '重启单元' },
    { abbrev: 'reload', full: 'reload', zh: '重载单元配置' },
    { abbrev: 'en', full: 'enable', zh: '设置开机自启' },
    { abbrev: 'dis', full: 'disable', zh: '取消开机自启' },
    { abbrev: 'list-units', full: 'list-units', zh: '列出已加载单元' },
    { abbrev: 'list-unit-files', full: 'list-unit-files', zh: '列出已安装单元文件' },
    { abbrev: 'cat', full: 'cat', zh: '查看单元配置文件内容' },
    { abbrev: 'daemon-reload', full: 'daemon-reload', zh: '重新加载 systemd 管理器配置' },
  ],
  nmcli: [
    { abbrev: 'c', full: 'connection', zh: '管理网络连接' },
    { abbrev: 'd', full: 'device', zh: '管理网络设备' },
  ],
  dnf: [
    { abbrev: 'in', full: 'install', zh: '安装软件包' },
    { abbrev: 'rm', full: 'remove', zh: '卸载软件包' },
  ],
  yum: [
    { abbrev: 'in', full: 'install', zh: '安装软件包' },
    { abbrev: 'rm', full: 'remove', zh: '卸载软件包' },
  ],
};

/**
 * 子命令缩写候选：COMMAND_ABBREVS[cmd] 中 abbrev 或 full 以 current 开头的
 * 条目 → SuggestionResult（command=完整子命令 full，kind/source='arg'，
 * description=中文说明 +（= abbrev 缩写））。abbrev 与 full 相同的条目
 * （如 start）不加"= 缩写"后缀。同一 full 的多个缩写命中（如 ip a/addr →
 * address）按表序取首个，不去重会弹重复条目。cmd 不在表内 → []。
 */
export function findAbbrevSuggestions(
  cmd: string,
  current: string,
  limit = 8,
): SuggestionResult[] {
  const entries = COMMAND_ABBREVS[cmd];
  if (!entries) return [];
  const out: SuggestionResult[] = [];
  const seenFull = new Set<string>();
  for (const { abbrev, full, zh } of entries) {
    if (out.length >= limit) break;
    if (current && !abbrev.startsWith(current) && !full.startsWith(current)) {
      continue;
    }
    if (seenFull.has(full)) continue;
    seenFull.add(full);
    out.push({
      command: full,
      source: 'arg',
      kind: 'arg',
      description: abbrev === full ? zh : `${zh}（= ${abbrev} 缩写）`,
    });
  }
  return out;
}
