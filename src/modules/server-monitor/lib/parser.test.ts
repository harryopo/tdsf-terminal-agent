// parser.test.ts — TDSF 服务器监控解析器单元测试
// -----------------------------------------------------------------------------
// 补齐 parser.ts 第 7 行注释声称的测试覆盖（P1 修复：虚假声称有测试）
// 覆盖所有核心解析函数 + 差值法计算函数。

import { describe, expect, it } from 'vitest';

import {
  calcCpuMetrics,
  calcCpuUsage,
  calcNetworkRates,
  parseDfOutput,
  parseFreeOutput,
  parseProcNetDev,
  parseProcStat,
  parsePsOutput,
  type CpuSnap,
  type NetSnap,
} from './parser';

// ============================================================================
// parseProcStat
// ============================================================================

describe('parseProcStat', () => {
  it('parses a normal aggregate cpu line', () => {
    const output = 'cpu  100 200 300 400 500 600 700 800 900 1000';
    const snaps = parseProcStat(output);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].name).toBe('cpu');
    expect(snaps[0].fields[0]).toBe(100);
    expect(snaps[0].fields[3]).toBe(400);
    expect(snaps[0].fields).toHaveLength(10);
  });

  it('parses aggregate + per-core lines', () => {
    const output = [
      'cpu  100 200 300 400 500',
      'cpu0 50 100 150 200 250',
      'cpu1 50 100 150 200 250',
    ].join('\n');
    const snaps = parseProcStat(output);
    expect(snaps).toHaveLength(3);
    expect(snaps.map((s) => s.name)).toEqual(['cpu', 'cpu0', 'cpu1']);
  });

  it('skips blank lines and non-cpu lines', () => {
    const output = [
      '',
      'some random text',
      'cpu  10 20 30 40 50',
      'intr 12345',
    ].join('\n');
    const snaps = parseProcStat(output);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].name).toBe('cpu');
  });

  it('skips lines with fewer than 4 numeric fields', () => {
    const snaps = parseProcStat('cpu  10 20 30');
    expect(snaps).toHaveLength(0);
  });

  it('filters out NaN values from fields', () => {
    // "abc" → NaN, filtered out; remaining [100, 300, 400, 500] has length 4 >= 4
    const snaps = parseProcStat('cpu  100 abc 300 400 500');
    expect(snaps).toHaveLength(1);
    expect(snaps[0].fields).toEqual([100, 300, 400, 500]);
  });
});

// ============================================================================
// parseFreeOutput
// ============================================================================

describe('parseFreeOutput', () => {
  const FREE_OUTPUT = [
    '               total        used        free      shared  buff/cache   available',
    'Mem:           15949        2345        9821         145        3782       13021',
    'Swap:          8192           0        8192',
  ].join('\n');

  it('parses Mem line correctly (default MB multiplier)', () => {
    const result = parseFreeOutput(FREE_OUTPUT);
    expect(result).not.toBeNull();
    expect(result!.total).toBe(15949 * 1024 * 1024);
    expect(result!.available).toBe(13021 * 1024 * 1024);
    // used = total - available = 15949 - 13021 = 2928
    expect(result!.used).toBe(2928 * 1024 * 1024);
    expect(result!.usagePercent).toBeCloseTo((2928 / 15949) * 100, 1);
  });

  it('parses Swap line', () => {
    const result = parseFreeOutput(FREE_OUTPUT);
    expect(result).not.toBeNull();
    expect(result!.swapTotal).toBe(8192 * 1024 * 1024);
    expect(result!.swapUsed).toBe(0);
  });

  it('returns null when no Mem line present', () => {
    expect(parseFreeOutput('Swap: 8192 0 8192')).toBeNull();
  });

  it('returns null when Mem line has fewer than 6 fields', () => {
    expect(parseFreeOutput('Mem: 15949 2345 9821')).toBeNull();
  });
});

// ============================================================================
// parseDfOutput
// ============================================================================

describe('parseDfOutput', () => {
  const DF_OUTPUT = [
    'Filesystem     1024-blocks    Used Available Capacity Mounted on',
    '/dev/sda1       52428800  21000000  31428800      41% /',
    'tmpfs             1024000       100   1023900       1% /tmp',
    '/dev/sdb1       104857600  50000000  54857600      48% /home',
  ].join('\n');

  it('parses /dev/ partitions', () => {
    const disks = parseDfOutput(DF_OUTPUT);
    expect(disks).toHaveLength(2);
    expect(disks[0].filesystem).toBe('/dev/sda1');
    expect(disks[0].mountPoint).toBe('/');
    expect(disks[1].filesystem).toBe('/dev/sdb1');
    expect(disks[1].mountPoint).toBe('/home');
  });

  it('filters out tmpfs and other non-/dev/ entries', () => {
    const disks = parseDfOutput(DF_OUTPUT);
    expect(disks.find((d) => d.mountPoint === '/tmp')).toBeUndefined();
  });

  it('converts KB blocks to bytes (× 1024)', () => {
    const disks = parseDfOutput(DF_OUTPUT);
    expect(disks[0].total).toBe(52428800 * 1024);
    expect(disks[0].used).toBe(21000000 * 1024);
    expect(disks[0].available).toBe(31428800 * 1024);
    expect(disks[0].usagePercent).toBe(41);
  });
});

// ============================================================================
// parseProcNetDev
// ============================================================================

describe('parseProcNetDev', () => {
  const NET_OUTPUT = [
    '  eth0: 1234567    100 0 0 0 0 0 0    7654321    200 0 0 0 0 0 0',
    '  lo: 123    1 0 0 0 0 0 0    123    1 0 0 0 0 0 0',
  ].join('\n');

  it('parses normal interfaces', () => {
    const snaps = parseProcNetDev(NET_OUTPUT);
    expect(snaps).toHaveLength(1);
    expect(snaps[0].name).toBe('eth0');
    expect(snaps[0].rxBytes).toBe(1234567);
    expect(snaps[0].txBytes).toBe(7654321);
  });

  it('filters out loopback interface (lo)', () => {
    const snaps = parseProcNetDev(NET_OUTPUT);
    expect(snaps.find((s) => s.name === 'lo')).toBeUndefined();
  });

  it('skips lines without colon separator', () => {
    expect(parseProcNetDev('no colon here')).toHaveLength(0);
  });

  it('skips lines with fewer than 9 data fields', () => {
    expect(parseProcNetDev('  eth0: 100 200 300')).toHaveLength(0);
  });
});

// ============================================================================
// parsePsOutput
// ============================================================================

describe('parsePsOutput', () => {
  const PS_OUTPUT = [
    'USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND',
    'root         1  0.0  0.1   1234   567 ?        Ss   2025   0:05 /sbin/init',
    'user      1234  5.2  3.1   9999   888 ?        S    2025   0:10 /usr/bin/python3 app.py',
  ].join('\n');

  it('parses process list correctly', () => {
    const procs = parsePsOutput(PS_OUTPUT);
    expect(procs).toHaveLength(2);
    expect(procs[0].pid).toBe(1);
    expect(procs[0].user).toBe('root');
    expect(procs[0].cpuPercent).toBe(0);
    expect(procs[0].command).toBe('/sbin/init');
    expect(procs[1].pid).toBe(1234);
    expect(procs[1].cpuPercent).toBe(5.2);
    expect(procs[1].memPercent).toBe(3.1);
    expect(procs[1].command).toBe('/usr/bin/python3 app.py');
  });

  it('skips the USER header line', () => {
    const procs = parsePsOutput(PS_OUTPUT);
    expect(procs.find((p) => p.user === 'USER')).toBeUndefined();
  });

  it('respects maxCount limit', () => {
    const procs = parsePsOutput(PS_OUTPUT, 1);
    expect(procs).toHaveLength(1);
  });

  it('skips lines with fewer than 11 fields', () => {
    expect(parsePsOutput('root 1 0.0 0.1 short')).toHaveLength(0);
  });
});

// ============================================================================
// calcCpuUsage
// ============================================================================

describe('calcCpuUsage', () => {
  it('calculates usage via delta method', () => {
    // prev: total=1100 (sum), idle=800 | curr: total=1200 (sum), idle=850
    // totalDelta=100, idleDelta=50 → usage=(100-50)/100*100=50%
    const prev: CpuSnap = { name: 'cpu', fields: [100, 100, 100, 800] };
    const curr: CpuSnap = { name: 'cpu', fields: [120, 120, 110, 850] };
    expect(calcCpuUsage(prev, curr)).toBeCloseTo(50, 5);
  });

  it('returns 0 when totalDelta <= 0', () => {
    const prev: CpuSnap = { name: 'cpu', fields: [100, 200, 300, 400] };
    const curr: CpuSnap = { name: 'cpu', fields: [100, 200, 300, 400] };
    expect(calcCpuUsage(prev, curr)).toBe(0);
  });

  it('returns 100 when idle unchanged but total increased', () => {
    // idle delta=0, total delta=80 → usage=80/80*100=100
    const prev: CpuSnap = { name: 'cpu', fields: [100, 100, 100, 100, 100] };
    const curr: CpuSnap = { name: 'cpu', fields: [120, 120, 120, 100, 100] };
    expect(calcCpuUsage(prev, curr)).toBe(100);
  });

  it('counts idle + iowait as non-busy (matches top / htop / node_exporter)', () => {
    // 仅 iowait 增长、其他列不变 —— iowait 是"等 IO"而非"算"，应视为非忙碌。
    // 旧实现（只取 idle）会把 iowait 增长错误地算成 100% 使用率。
    // prev: user=100 nice=0 system=100 idle=700 iowait=100 → total=1000
    // curr: user=100 nice=0 system=100 idle=700 iowait=160 → total=1060
    // totalDelta=60；idleDelta=(700+160)-(700+100)=60 → usage=(60-60)/60*100=0%
    const prev: CpuSnap = { name: 'cpu', fields: [100, 0, 100, 700, 100] };
    const curr: CpuSnap = { name: 'cpu', fields: [100, 0, 100, 700, 160] };
    expect(calcCpuUsage(prev, curr)).toBeCloseTo(0, 5);
  });

  it('falls back to idle-only when iowait column absent (old kernels)', () => {
    // 没有 iowait 列时回退到仅 idle 的旧行为
    // prev total=1100 idle=800；curr total=1200 idle=850
    // totalDelta=100 idleDelta=50 → usage=50%
    const prev: CpuSnap = { name: 'cpu', fields: [100, 100, 100, 800] };
    const curr: CpuSnap = { name: 'cpu', fields: [120, 120, 110, 850] };
    expect(calcCpuUsage(prev, curr)).toBeCloseTo(50, 5);
  });
});

// ============================================================================
// calcCpuMetrics
// ============================================================================

describe('calcCpuMetrics', () => {
  it('calculates overall + per-core usage from two snapshots', () => {
    const prev: CpuSnap[] = [
      { name: 'cpu', fields: [100, 100, 100, 700] },
      { name: 'cpu0', fields: [50, 50, 50, 350] },
      { name: 'cpu1', fields: [50, 50, 50, 350] },
    ];
    const curr: CpuSnap[] = [
      { name: 'cpu', fields: [110, 110, 110, 740] },
      { name: 'cpu0', fields: [55, 55, 55, 370] },
      { name: 'cpu1', fields: [55, 55, 55, 370] },
    ];
    const result = calcCpuMetrics(prev, curr);
    expect(result).not.toBeNull();
    // totalDelta=70, idleDelta=40 → usage=30/70*100≈42.86
    expect(result!.overall).toBeCloseTo(((70 - 40) / 70) * 100, 1);
    expect(result!.perCore).toHaveLength(2);
    expect(result!.coreCount).toBe(2);
  });

  it('returns null when no aggregate cpu snap exists', () => {
    const prev: CpuSnap[] = [{ name: 'cpu0', fields: [1, 2, 3, 4] }];
    const curr: CpuSnap[] = [{ name: 'cpu0', fields: [5, 6, 7, 8] }];
    expect(calcCpuMetrics(prev, curr)).toBeNull();
  });
});

// ============================================================================
// calcNetworkRates
// ============================================================================

describe('calcNetworkRates', () => {
  it('calculates rates via delta method', () => {
    const prev: NetSnap[] = [{ name: 'eth0', rxBytes: 1000, txBytes: 500 }];
    const curr: NetSnap[] = [{ name: 'eth0', rxBytes: 2000, txBytes: 700 }];
    const rates = calcNetworkRates(prev, curr, 2);
    expect(rates).toHaveLength(1);
    // rxDelta=1000 / 2s = 500 B/s
    expect(rates[0].rxRate).toBe(500);
    // txDelta=200 / 2s = 100 B/s
    expect(rates[0].txRate).toBe(100);
    expect(rates[0].rxBytesTotal).toBe(2000);
    expect(rates[0].txBytesTotal).toBe(700);
  });

  it('returns empty array when intervalSecs <= 0', () => {
    const prev: NetSnap[] = [{ name: 'eth0', rxBytes: 1000, txBytes: 500 }];
    const curr: NetSnap[] = [{ name: 'eth0', rxBytes: 2000, txBytes: 700 }];
    expect(calcNetworkRates(prev, curr, 0)).toHaveLength(0);
  });

  it('first sample (empty prev) returns empty array', () => {
    const curr: NetSnap[] = [{ name: 'eth0', rxBytes: 1000, txBytes: 500 }];
    expect(calcNetworkRates([], curr, 3)).toHaveLength(0);
  });

  it('skips interfaces without previous snapshot', () => {
    const prev: NetSnap[] = [{ name: 'eth0', rxBytes: 1000, txBytes: 500 }];
    const curr: NetSnap[] = [
      { name: 'eth0', rxBytes: 2000, txBytes: 700 },
      { name: 'wlan0', rxBytes: 3000, txBytes: 900 },
    ];
    const rates = calcNetworkRates(prev, curr, 1);
    expect(rates).toHaveLength(1);
    expect(rates[0].name).toBe('eth0');
  });

  it('clamps negative deltas to 0 (counter wrap)', () => {
    const prev: NetSnap[] = [{ name: 'eth0', rxBytes: 5000, txBytes: 5000 }];
    const curr: NetSnap[] = [{ name: 'eth0', rxBytes: 1000, txBytes: 1000 }];
    const rates = calcNetworkRates(prev, curr, 1);
    expect(rates[0].rxRate).toBe(0);
    expect(rates[0].txRate).toBe(0);
  });
});
