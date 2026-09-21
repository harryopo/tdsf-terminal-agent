/**
 * collectContract.test.ts — 采集命令与读取端的标记必须对得上
 * -----------------------------------------------------------------------------
 * `===NAME===` 这套标记同时写在两边：远端 echo 出去的字符串（useServerMetrics）
 * 和 splitSections 切完之后按键取值的读取端。两边各写一遍就会漂移 —— #104 那轮
 * 就是读取端按"标记必须在行首"切，远端却因欢迎横幅把首个标记粘到了横幅尾巴上。
 *
 * 这里把契约钉成一条：命令原样跑出来的输出，必须能被 splitSections 切出
 * 该命令声明的**全部**段名；并且前面压一段横幅也不会丢段。
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), Channel: vi.fn() }));

import { COLLECT_CMD, COLLECT_PARTS, OVERVIEW_CMD, OVERVIEW_PARTS } from './useServerMetrics';
import { splitSections } from './parser';

/** 实测服务器的欢迎横幅：多行、含 === 装饰线、末尾不带换行 */
const BANNER = [
  'Welcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-88-generic x86_64)',
  '=== 系统提示 ===',
  '*  本服务器已开启防火墙，请联系管理员开放端口  *',
  'Last login: Mon Sep 21 19:37:24 2026 from 192.168.45.1',
].join('\n');

const CASES = [
  { label: 'COLLECT_CMD', cmd: COLLECT_CMD, parts: COLLECT_PARTS },
  { label: 'OVERVIEW_CMD', cmd: OVERVIEW_CMD, parts: OVERVIEW_PARTS },
] as const;

describe.each(CASES)('$label 的分节契约', ({ label, cmd, parts }) => {
  const names = parts.map(([name]) => name);

  it('命令里为每个声明的段名都 echo 了标记', () => {
    for (const name of names) {
      expect(cmd).toContain(`echo "===${name}==="`);
    }
  });

  it('段名没有重复（重复会让后一段覆盖前一段，读取端静默拿到错数据）', () => {
    expect(new Set(names).size).toBe(names.length);
  });

  it('干净输出能切出全部段', () => {
    const sections = splitSections(cmd);
    expect(names.every((n) => sections.has(n))).toBe(true);
  });

  it(`横幅粘在首个标记前（${label}）仍然切得出全部段`, () => {
    const sections = splitSections(`${BANNER}${cmd}`);
    const missing = names.filter((n) => !sections.has(n));
    expect(missing).toEqual([]);
  });

  it('横幅末尾带换行时同样切得出全部段', () => {
    const sections = splitSections(`${BANNER}\n${cmd}`);
    expect(names.every((n) => sections.has(n))).toBe(true);
  });
});
