// TDSF 服务器实时监控 —— 远程命令输出解析器
// -----------------------------------------------------------------------------
// 解析通过 sshCommand 执行的 shell 命令输出（cat /proc/stat / free -m / df / 等），
// 将文本转换为结构化的 ServerMetrics。
//
// 解析策略：容错优先 —— 任何一行格式异常都不影响其他指标的解析，返回 null 跳过。
// 单元测试覆盖所有解析器（parser.test.ts）。

import type {
  CpuMetrics,
  DiskMetrics,
  MemoryMetrics,
  NetInterfaceMetrics,
  ProcessInfo,
  SystemOverview,
} from '../types';

// ============================================================================
// CPU 解析（/proc/stat 差值法）
// ============================================================================

/** /proc/stat 单行 cpu 数据快照 */
export interface CpuSnap {
  /** 标识：'cpu'（聚合）或 'cpu0' 'cpu1'（每核） */
  name: string;
  /** 各列累加值：user nice system idle iowait irq softirq steal ... */
  fields: number[];
}

/**
 * 解析 /proc/stat 全部内容，返回聚合行 + 每核行的快照。
 * 格式：`cpu  100 200 300 400 ...` / `cpu0 50 100 150 200 ...`
 */
export function parseProcStat(output: string): CpuSnap[] {
  const snaps: CpuSnap[] = [];
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    // 匹配 "cpu" 或 "cpu0" "cpu12" 开头
    const match = trimmed.match(/^(cpu\d*)\s+(.*)/);
    if (!match) continue;
    const name = match[1];
    const fields = match[2]
      .split(/\s+/)
      .map(Number)
      .filter((n) => !Number.isNaN(n));
    if (fields.length < 4) continue;
    snaps.push({ name, fields });
  }
  return snaps;
}

/**
 * 从两个 /proc/stat 快照计算 CPU 使用率（差值法）。
 * 公式：usage = (total_delta - idle_delta) / total_delta × 100
 *
 * 业界标准（top / htop / node_exporter）：idle + iowait 都视为"非忙碌"时间，
 * 因此 idle_delta 取 idle（index 3）与 iowait（index 4）之和。
 * 极旧内核的 /proc/stat 可能没有 iowait 列，此时 fields[4] 为 undefined，
 * 用 ?? 0 兜底，保证回退到仅 idle 的旧行为。
 */
export function calcCpuUsage(prev: CpuSnap, curr: CpuSnap): number {
  const prevTotal = prev.fields.reduce((a, b) => a + b, 0);
  const currTotal = curr.fields.reduce((a, b) => a + b, 0);
  const totalDelta = currTotal - prevTotal;
  if (totalDelta <= 0) return 0;
  // idle 在 index 3，iowait 在 index 4（极旧内核无 iowait 列 → undefined → 0）
  const prevIdle = (prev.fields[3] ?? 0) + (prev.fields[4] ?? 0);
  const currIdle = (curr.fields[3] ?? 0) + (curr.fields[4] ?? 0);
  const idleDelta = currIdle - prevIdle;
  const usage = ((totalDelta - idleDelta) / totalDelta) * 100;
  return Math.max(0, Math.min(100, usage));
}

/** 从两次 /proc/stat 快照计算完整 CPU 指标 */
export function calcCpuMetrics(
  prevSnaps: CpuSnap[],
  currSnaps: CpuSnap[],
): CpuMetrics | null {
  const prevAgg = prevSnaps.find((s) => s.name === 'cpu');
  const currAgg = currSnaps.find((s) => s.name === 'cpu');
  if (!prevAgg || !currAgg) return null;

  const overall = calcCpuUsage(prevAgg, currAgg);

  // 每核使用率
  const perCore: number[] = [];
  const currCores = currSnaps.filter((s) => /^cpu\d+$/.test(s.name));
  for (const currCore of currCores) {
    const prevCore = prevSnaps.find((s) => s.name === currCore.name);
    if (prevCore) {
      perCore.push(calcCpuUsage(prevCore, currCore));
    }
  }

  return {
    overall,
    perCore: perCore.length > 0 ? perCore : [overall],
    coreCount: currCores.length || perCore.length || 1,
  };
}

// ============================================================================
// 内存解析（free -m 或 free -k）
// ============================================================================

/**
 * 解析 `free -m` 输出（推荐，跨发行版稳定）。
 * 示例：
 *   total used free shared buff/cache available
 *   Mem:   15949  2345  9821   145  3782  13021
 *   Swap:  8192    0    8192
 *
 * @param unitMultiplier 将单位转为字节的倍率（free -m → 1024×1024；free -k → 1024）
 */
export function parseFreeOutput(
  output: string,
  unitMultiplier = 1024 * 1024,
): MemoryMetrics | null {
  const lines = output.split('\n');
  let memLine: string | null = null;
  let swapLine: string | null = null;

  for (const line of lines) {
    if (/^\s*Mem:/.test(line)) memLine = line;
    else if (/^\s*Swap:/.test(line)) swapLine = line;
  }

  if (!memLine) return null;

  // Mem 行：total used free shared buff/cache available
  const memParts = memLine.trim().split(/\s+/).slice(1).map(Number);
  if (memParts.length < 6) return null;
  // eslint 下标用解构更安全
  const [total, , , , , available] = memParts;
  if (!Number.isFinite(total) || total <= 0) return null;

  const avail = Number.isFinite(available) ? available : 0;
  const used = total - avail;
  const usagePercent = total > 0 ? (used / total) * 100 : 0;

  // Swap 行：total used free
  let swapTotal = 0;
  let swapUsed = 0;
  if (swapLine) {
    const swapParts = swapLine.trim().split(/\s+/).slice(1).map(Number);
    if (swapParts.length >= 2) {
      swapTotal = swapParts[0] ?? 0;
      swapUsed = swapParts[1] ?? 0;
    }
  }

  return {
    total: total * unitMultiplier,
    used: used * unitMultiplier,
    available: avail * unitMultiplier,
    usagePercent: Math.max(0, Math.min(100, usagePercent)),
    swapTotal: swapTotal * unitMultiplier,
    swapUsed: swapUsed * unitMultiplier,
  };
}

// ============================================================================
// 磁盘解析（df -k）
// ============================================================================

/**
 * 解析 `df -kP`（-P = POSIX 格式，一行一个文件系统，不折行）。
 * 示例：
 *   Filesystem 1024-blocks Used Available Capacity Mounted on
 *   /dev/sda1 52428800 21000000 31428800 41% /
 *
 * 只统计 /dev/ 开头的物理分区，跳过 tmpfs/devtmpfs/overlay。
 */
export function parseDfOutput(output: string): DiskMetrics[] {
  const disks: DiskMetrics[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Filesystem')) continue;
    // 只统计物理分区
    if (!trimmed.startsWith('/dev/')) continue;

    const parts = trimmed.split(/\s+/);
    if (parts.length < 6) continue;

    const filesystem = parts[0];
    // df -k 单位为 1KB blocks
    const totalKB = Number(parts[1]);
    const usedKB = Number(parts[2]);
    const availKB = Number(parts[3]);
    const capacityStr = parts[4].replace('%', '');
    const usagePercent = Number(capacityStr);
    // 挂载点可能含空格（罕见），取最后一个字段
    const mountPoint = parts.slice(5).join(' ');

    if (!Number.isFinite(totalKB) || totalKB <= 0) continue;

    disks.push({
      filesystem,
      mountPoint,
      total: totalKB * 1024,
      used: usedKB * 1024,
      available: availKB * 1024,
      usagePercent: Number.isFinite(usagePercent) ? usagePercent : 0,
    });
  }

  return disks;
}

// ============================================================================
// 网络解析（/proc/net/dev）
// ============================================================================

/** /proc/net/dev 单接口快照 */
export interface NetSnap {
  name: string;
  rxBytes: number;
  txBytes: number;
}

/**
 * 解析 /proc/net/dev，返回各接口快照。
 * 格式（跳过前两行表头）：
 *   interfacename: rx_bytes rx_packets ... tx_bytes tx_packets ...
 */
export function parseProcNetDev(output: string): NetSnap[] {
  const snaps: NetSnap[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    const colonIdx = line.indexOf(':');
    if (colonIdx < 0) continue;

    const name = line.slice(0, colonIdx).trim();
    // 跳过回环接口和虚拟接口
    if (!name || name === 'lo') continue;

    const dataPart = line.slice(colonIdx + 1).trim();
    const fields = dataPart.split(/\s+/).map(Number);
    if (fields.length < 9) continue;
    // 接收字节在第 1 列（index 0），发送字节在第 9 列（index 8）
    const rxBytes = fields[0];
    const txBytes = fields[8];
    if (!Number.isFinite(rxBytes) || !Number.isFinite(txBytes)) continue;

    snaps.push({ name, rxBytes, txBytes });
  }

  return snaps;
}

/** 从两次 /proc/net/dev 快照计算网络速率（字节/秒） */
export function calcNetworkRates(
  prev: NetSnap[],
  curr: NetSnap[],
  intervalSecs: number,
): NetInterfaceMetrics[] {
  if (intervalSecs <= 0) return [];
  const result: NetInterfaceMetrics[] = [];

  for (const c of curr) {
    const p = prev.find((s) => s.name === c.name);
    if (!p) continue;
    const rxDelta = Math.max(0, c.rxBytes - p.rxBytes);
    const txDelta = Math.max(0, c.txBytes - p.txBytes);
    result.push({
      name: c.name,
      rxRate: rxDelta / intervalSecs,
      txRate: txDelta / intervalSecs,
      rxBytesTotal: c.rxBytes,
      txBytesTotal: c.txBytes,
    });
  }

  return result;
}

// ============================================================================
// 进程解析（ps aux --sort=-%cpu）
// ============================================================================

/**
 * 解析 `ps aux --sort=-%cpu | head -6`（Top 5 进程 + 表头）。
 * 格式：
 *   USER PID %CPU %MEM VSZ RSS TTY STAT START TIME COMMAND
 */
export function parsePsOutput(output: string, maxCount = 5): ProcessInfo[] {
  const procs: ProcessInfo[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('USER')) continue;
    if (procs.length >= maxCount) break;

    const parts = trimmed.split(/\s+/);
    if (parts.length < 11) continue;

    const user = parts[0];
    const pid = Number(parts[1]);
    const cpuPercent = Number(parts[2]);
    const memPercent = Number(parts[3]);
    // COMMAND 在第 11 列起（index 10），可能含空格
    const command = parts.slice(10).join(' ').slice(0, 80);

    if (!Number.isFinite(pid) || pid <= 0) continue;

    procs.push({
      pid,
      user,
      cpuPercent: Number.isFinite(cpuPercent) ? cpuPercent : 0,
      memPercent: Number.isFinite(memPercent) ? memPercent : 0,
      command,
    });
  }

  return procs;
}

// ============================================================================
// 系统概览解析
// ============================================================================

/**
 * 解析系统概览信息（hostname / cat /etc/os-release / uname -r / cat /proc/uptime / cat /proc/loadavg）。
 * 期望输入是多个命令的合并输出，每行一项。
 */
export function parseSystemOverview(
  hostname: string,
  osRelease: string,
  kernel: string,
  uptime: string,
  loadavg: string,
): SystemOverview {
  // os-release 取 PRETTY_NAME 值
  let os = 'Unknown';
  for (const line of osRelease.split('\n')) {
    const match = line.match(/^PRETTY_NAME\s*=\s*"(.*)"/);
    if (match) {
      os = match[1];
      break;
    }
  }

  // uptime 第一个数字是运行秒数
  const uptimeSecs = Number((uptime.trim().split(/\s+/)[0] ?? '0'));
  const uptimeVal = Number.isFinite(uptimeSecs) ? uptimeSecs : 0;

  // loadavg：三个浮点数
  const loadParts = loadavg.trim().split(/\s+/).map(Number);
  const loadAvg: [number, number, number] = [
    loadParts[0] ?? 0,
    loadParts[1] ?? 0,
    loadParts[2] ?? 0,
  ];

  return {
    hostname: hostname.trim() || 'unknown',
    os,
    kernel: kernel.trim(),
    uptime: uptimeVal,
    loadAvg,
  };
}

// ============================================================================
// 工具函数
// ============================================================================

/**
 * 将运行时间（秒）格式化为人类可读字符串。
 * 如 93784 → "2d 2h"
 */
export function formatUptime(seconds: number): string {
  if (seconds < 0 || !Number.isFinite(seconds)) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/**
 * 将字节数格式化为人类可读的速度（自动选单位）。
 * 如 1024 → "1.0 KB/s"，1048576 → "1.0 MB/s"
 */
export function formatRate(bytesPerSec: number): string {
  if (bytesPerSec < 0 || !Number.isFinite(bytesPerSec)) return '—';
  if (bytesPerSec < 1024) return `${bytesPerSec.toFixed(0)} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  if (bytesPerSec < 1024 * 1024 * 1024)
    return `${(bytesPerSec / 1024 / 1024).toFixed(1)} MB/s`;
  return `${(bytesPerSec / 1024 / 1024 / 1024).toFixed(1)} GB/s`;
}

/**
 * 将字节数格式化为人类可读的容量。
 * 如 15949 * 1024 * 1024 → "15.6 GB"
 */
export function formatBytes(bytes: number): string {
  if (bytes < 0 || !Number.isFinite(bytes)) return '—';
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  const KB = 1024;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= KB) return `${(bytes / KB).toFixed(1)} KB`;
  return `${bytes.toFixed(0)} B`;
}

/**
 * 根据使用率返回对应的颜色类名（Tailwind）。
 * < 60% 绿，60-80% 黄，> 80% 红
 */
export function usageColor(percent: number): string {
  if (percent >= 80) return 'text-red-500';
  if (percent >= 60) return 'text-amber-500';
  return 'text-emerald-500';
}

/** 根据使用率返回进度条的背景色类名 */
export function usageBarColor(percent: number): string {
  if (percent >= 80) return 'bg-red-500';
  if (percent >= 60) return 'bg-amber-500';
  return 'bg-emerald-500';
}
