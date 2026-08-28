/**
 * command-abbrevs.test.ts — 子命令缩写表测试 (TDSF 2026-08-28 二轮改进)
 * -----------------------------------------------------------------------------
 * 覆盖:
 *   1. findAbbrevSuggestions: ip a → address（用户实测痛点）/ systemctl s →
 *      status / 前缀过滤（abbrev 与 full 双匹配）/ full 去重 / 未知命令空 /
 *      limit / 描述后缀（= 缩写）
 */
import { describe, expect, it } from 'vitest';
import { COMMAND_ABBREVS, findAbbrevSuggestions } from './command-abbrevs';

describe('findAbbrevSuggestions', () => {
  it('ip + current=a → address（缩写 a 与 addr 同 full 去重为一条）', () => {
    const items = findAbbrevSuggestions('ip', 'a');
    const addressItems = items.filter((it) => it.command === 'address');
    expect(addressItems).toHaveLength(1);
    expect(addressItems[0]?.kind).toBe('arg');
    expect(addressItems[0]?.source).toBe('arg');
    // 缩写条目描述带"= 缩写"后缀（教学说明）
    expect(addressItems[0]?.description).toContain('（= a 缩写）');
    // 同屏还有 link/route/neighbour/stats（full 以 a 开头的只有 address，
    // 其余缩写 l/r/n/s 的 full 不以 a 开头 → 不出现）
    const commands = items.map((it) => it.command);
    expect(commands).not.toContain('link');
    expect(commands).not.toContain('route');
  });

  it('ip 空 current → 全量缩写（address/link/route/neighbour/stats，addr→address 去重）', () => {
    const items = findAbbrevSuggestions('ip', '');
    const commands = items.map((it) => it.command);
    expect(commands).toContain('address');
    expect(commands).toContain('link');
    expect(commands).toContain('route');
    expect(commands).toContain('neighbour');
    expect(commands).toContain('stats');
    // a 与 addr 同指 address → 去重后只一条
    expect(commands.filter((c) => c === 'address')).toHaveLength(1);
  });

  it('systemctl + current=s → status 在首（表序），含 start/stop，不含 restart', () => {
    const items = findAbbrevSuggestions('systemctl', 's');
    const commands = items.map((it) => it.command);
    expect(commands[0]).toBe('status');
    expect(commands).toContain('start');
    expect(commands).toContain('stop');
    // restart 不以 s 开头（abbrev/full 均否）
    expect(commands).not.toContain('restart');
    // disable 的缩写 dis 以 d 开头 → 不出现
    expect(commands).not.toContain('disable');
  });

  it('systemctl + current=list-u → list-units / list-unit-files（full 前缀匹配）', () => {
    const commands = findAbbrevSuggestions('systemctl', 'list-u').map(
      (it) => it.command,
    );
    expect(commands).toContain('list-units');
    expect(commands).toContain('list-unit-files');
  });

  it('abbrev===full 的条目（start/cat）描述不加"= 缩写"后缀', () => {
    const items = findAbbrevSuggestions('systemctl', 'start');
    expect(items).toHaveLength(1);
    expect(items[0]?.command).toBe('start');
    expect(items[0]?.description).toBe('启动单元');
  });

  it('limit 生效', () => {
    expect(findAbbrevSuggestions('systemctl', '', 3)).toHaveLength(3);
  });

  it('缩写表条目规模：宁缺毋滥（5 个命令、24 条左右）', () => {
    const cmds = Object.keys(COMMAND_ABBREVS);
    expect(cmds).toContain('ip');
    expect(cmds).toContain('systemctl');
    expect(cmds).toContain('nmcli');
    expect(cmds).toContain('dnf');
    expect(cmds).toContain('yum');
    const total = Object.values(COMMAND_ABBREVS).reduce(
      (n, list) => n + list.length,
      0,
    );
    expect(total).toBeGreaterThanOrEqual(20);
    expect(total).toBeLessThanOrEqual(30);
  });

  it('未知命令 → 空数组', () => {
    expect(findAbbrevSuggestions('__not_a_command__', '')).toEqual([]);
    expect(findAbbrevSuggestions('ls', '')).toEqual([]); // ls 无缩写表
  });
});
