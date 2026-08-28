/**
 * tldr-params.test.ts — tldr 选项级中文参数候选测试 (TDSF 2026-08-28 二轮改进)
 * -----------------------------------------------------------------------------
 * 覆盖:
 *   1. tldrParamSuggestions: 空 current 全量（键序稳定）/ 前缀过滤 / limit /
 *      未知命令空
 *   2. tldrOptionZh: 单条中文说明查询（命中/未命中/未知命令）
 *   3. isParamCandidateCommand: tldr 表命中 / SPEC_INDEX 命中 / 未命中
 */
import { describe, expect, it } from 'vitest';
import {
  isParamCandidateCommand,
  tldrOptionZh,
  tldrParamSuggestions,
} from './tldr-params';

describe('tldrParamSuggestions', () => {
  it('ls 空 current → 全量候选（limit 8），前几条按生成器键序稳定输出', () => {
    const items = tldrParamSuggestions('ls', '');
    expect(items).toHaveLength(8);
    // ls 表前三个键（tldr 页示例行序，高频在前）
    expect(items[0]?.command).toBe('-1');
    expect(items[1]?.command).toBe('-a');
    expect(items[2]?.command).toBe('--all');
    // 产出与参数层契约一致（acceptPrediction token 替换共用）
    for (const it of items) {
      expect(it.kind).toBe('arg');
      expect(it.source).toBe('arg');
      expect(it.description).toBeTruthy();
    }
  });

  it('ls current=-l → 仅返回以 -l 开头的选项（如 -la/-l/-lh）', () => {
    const items = tldrParamSuggestions('ls', '-l');
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(8);
    const commands = items.map((it) => it.command);
    expect(commands).toContain('-l');
    expect(commands).toContain('-lh');
    for (const c of commands) expect(c.startsWith('-l')).toBe(true);
    // 不含非 -l 前缀的选项
    expect(commands).not.toContain('-a');
  });

  it('ls current=--h → 长选项前缀过滤', () => {
    const items = tldrParamSuggestions('ls', '--h');
    const commands = items.map((it) => it.command);
    expect(commands).toContain('--human-readable');
    for (const c of commands) expect(c.startsWith('--h')).toBe(true);
  });

  it('limit 参数生效', () => {
    expect(tldrParamSuggestions('ls', '', 3)).toHaveLength(3);
    expect(tldrParamSuggestions('ls', '', 1)?.[0]?.command).toBe('-1');
  });

  it('未知命令 → 空数组（如 ip 不在 tldr 数据内，降级到缩写表）', () => {
    expect(tldrParamSuggestions('ip', '')).toEqual([]);
    expect(tldrParamSuggestions('__not_a_command__', '')).toEqual([]);
  });

  it('systemctl 空 current → 有候选（--failed/-t 等）', () => {
    const items = tldrParamSuggestions('systemctl', '');
    expect(items.length).toBeGreaterThan(0);
    expect(items.map((it) => it.command)).toContain('--failed');
  });
});

describe('tldrOptionZh', () => {
  it('命中 → 非空中文说明', () => {
    const zh = tldrOptionZh('ls', '-l');
    expect(typeof zh).toBe('string');
    expect(zh!.length).toBeGreaterThan(0);
  });

  it('选项不存在 → undefined', () => {
    expect(tldrOptionZh('ls', '--nope')).toBeUndefined();
  });

  it('命令不在表内 → undefined', () => {
    expect(tldrOptionZh('__not_a_command__', '-a')).toBeUndefined();
  });
});

describe('isParamCandidateCommand', () => {
  it('tldr 表内命令 → true', () => {
    expect(isParamCandidateCommand('ls')).toBe(true);
    expect(isParamCandidateCommand('systemctl')).toBe(true);
    expect(isParamCandidateCommand('grep')).toBe(true);
  });

  it('SPEC_INDEX 内的命令 → true', () => {
    expect(isParamCandidateCommand('git')).toBe(true);
    expect(isParamCandidateCommand('docker')).toBe(true);
  });

  it('无数据源命令 → false', () => {
    expect(isParamCandidateCommand('ip')).toBe(false); // 实测：ip 不在 tldr/specs
    expect(isParamCandidateCommand('__not_a_command__')).toBe(false);
    expect(isParamCandidateCommand('')).toBe(false);
  });
});
