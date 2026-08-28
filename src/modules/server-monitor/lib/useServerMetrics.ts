// TDSF 服务器实时监控 —— 采集轮询 hook
// -----------------------------------------------------------------------------
// 通过 sshCommand 执行合并命令采集远程服务器指标，setInterval 定时轮询。
// 设计要点：
//   - 合并多个采集命令为一次 SSH 往返（减少 channel 开销）
//   - CPU/网络使用差值法（保存上一次快照）
//   - 面板关闭或会话断开时自动停止轮询
//   - 连续失败 3 次自动停止并标记 error 状态

import { useCallback, useEffect, useRef, useState } from 'react';

import { sshCommand } from '@/lib/ssh-bridge';
import { selectActiveSession, useSshStore, isSessionConnected } from '@/modules/ssh-explorer/sshStore';
import type {
  CollectStatus,
  CpuMetrics,
  DiskMetrics,
  MetricHistoryPoint,
  NetInterfaceMetrics,
  ProcessInfo,
  ServerMetrics,
  SystemOverview,
} from '../types';
import {
  calcCpuMetrics,
  calcNetworkRates,
  parseDfOutput,
  parseFreeOutput,
  parseProcNetDev,
  parseProcStat,
  parsePsOutput,
  parseSystemOverview,
  type CpuSnap,
  type NetSnap,
} from './parser';

/** 合并采集命令（一次 SSH 往返采集所有指标） */
const COLLECT_CMD = [
  'echo "===STAT==="; head -n 1 /proc/stat',
  'echo "===CORES==="; grep "^cpu[0-9]" /proc/stat',
  'echo "===MEM==="; free -m',
  'echo "===DISK==="; df -kP | awk \'$1 ~ /^\\/dev\\// {print}\'',
  'echo "===NET==="; cat /proc/net/dev | tail -n +3',
  'echo "===PROC==="; ps aux --sort=-%cpu | head -6',
].join('; ');

/** 概览采集命令（仅在首次连接时执行一次） */
const OVERVIEW_CMD = [
  'hostname',
  'cat /etc/os-release 2>/dev/null || echo "PRETTY_NAME=\\"Unknown\\""', 
  'uname -r',
  'cat /proc/uptime',
  'cat /proc/loadavg',
].join('; echo "===SEP==="; ');

/** 历史数据最大保留点数 */
const MAX_HISTORY = 60;
/** 默认轮询间隔（毫秒） */
const DEFAULT_INTERVAL = 3000;
/** 连续失败最大次数（超过自动停止） */
const MAX_FAILURES = 3;

/** 内部快照（不暴露给 UI） */
interface InternalSnapshots {
  cpuSnaps: CpuSnap[];
  netSnaps: NetSnap[];
  lastCollectTime: number;
  failures: number;
}

/** hook 返回值 */
interface UseServerMetricsReturn {
  /** 最新一次完整指标 */
  metrics: ServerMetrics | null;
  /** 折线图历史（最近 MAX_HISTORY 个点） */
  history: MetricHistoryPoint[];
  /** 采集状态 */
  status: CollectStatus;
  /** 错误信息（status === 'error' 时有值） */
  error: string | null;
  /** 当前轮询间隔（毫秒） */
  intervalMs: number;
  /** 设置轮询间隔 */
  setIntervalMs: (ms: number) => void;
}

/**
 * 服务器监控采集 hook。
 *
 * @param enabled 是否启用采集（面板可见时才轮询）
 * @param intervalMs 轮询间隔，默认 3 秒
 */
export function useServerMetrics(
  enabled: boolean,
  intervalMs: number = DEFAULT_INTERVAL,
): UseServerMetricsReturn {
  const activeSession = useSshStore(selectActiveSession);
  const sessionId = activeSession?.rustSessionId ?? null;
  const sessionConnected = activeSession ? isSessionConnected(activeSession) : false;

  const [metrics, setMetrics] = useState<ServerMetrics | null>(null);
  const [history, setHistory] = useState<MetricHistoryPoint[]>([]);
  const [status, setStatus] = useState<CollectStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [currentInterval, setCurrentInterval] = useState(intervalMs);

  // 用 ref 存快照，避免触发重渲染
  const snapshotsRef = useRef<InternalSnapshots>({
    cpuSnaps: [],
    netSnaps: [],
    lastCollectTime: 0,
    failures: 0,
  });
  const overviewRef = useRef<SystemOverview | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // U2 修复：并发采集锁，防止 SSH 慢时 setInterval 堆积多个 collectOnce
  const isCollectingRef = useRef(false);

  /** 解析合并命令输出为结构化指标 */
  const parseCollectOutput = useCallback(
    (rawOutput: string, intervalSecs: number): Omit<ServerMetrics, 'overview' | 'timestamp'> | null => {
      const sections = splitSections(rawOutput);

      // CPU（差值法）
      let cpu: CpuMetrics | null = null;
      const statSection = sections.get('STAT');
      const coresSection = sections.get('CORES');
      if (statSection && coresSection) {
        const currSnaps = [
          ...parseProcStat(statSection),
          ...parseProcStat(coresSection),
        ];
        const prevSnaps = snapshotsRef.current.cpuSnaps;
        if (prevSnaps.length > 0) {
          cpu = calcCpuMetrics(prevSnaps, currSnaps);
        } else {
          // 首次采集无法计算差值，用每核 idle 反推
          const agg = currSnaps.find((s) => s.name === 'cpu');
          if (agg) {
            const idle = agg.fields[3] ?? 0;
            const total = agg.fields.reduce((a, b) => a + b, 0);
            const usageVal = total > 0 ? (1 - idle / total) * 100 : 0;
            cpu = {
              overall: Math.max(0, Math.min(100, usageVal)),
              perCore: [Math.max(0, Math.min(100, usageVal))],
              coreCount: currSnaps.filter((s) => /^cpu\d+$/.test(s.name)).length || 1,
            };
          }
        }
        snapshotsRef.current.cpuSnaps = currSnaps;
      }
      if (!cpu) return null;

      // 内存
      const memSection = sections.get('MEM');
      const memory = memSection ? parseFreeOutput(memSection) : null;
      if (!memory) return null;

      // 磁盘
      const diskSection = sections.get('DISK');
      const disks: DiskMetrics[] = diskSection ? parseDfOutput(diskSection) : [];

      // 网络（差值法）
      const netSection = sections.get('NET');
      let network: NetInterfaceMetrics[] = [];
      if (netSection) {
        const currNet = parseProcNetDev(netSection);
        const prevNet = snapshotsRef.current.netSnaps;
        if (prevNet.length > 0) {
          // U1 修复：用真实两次采样时间差计算网络速率，而非配置间隔
          const lastTime = snapshotsRef.current.lastCollectTime;
          const realSecs = lastTime > 0 ? (Date.now() - lastTime) / 1000 : intervalSecs;
          network = calcNetworkRates(prevNet, currNet, realSecs > 0 ? realSecs : intervalSecs);
        }
        snapshotsRef.current.netSnaps = currNet;
      }

      // 进程
      const procSection = sections.get('PROC');
      const processes: ProcessInfo[] = procSection
        ? parsePsOutput(procSection)
        : [];

      return { cpu, memory, disks, network, processes };
    },
    [],
  );

  /** 执行一次采集 */
  const collectOnce = useCallback(
    async (sid: number, intervalSecs: number) => {
      // U2 修复：并发采集锁，已在采集时跳过本次
      if (isCollectingRef.current) return;
      isCollectingRef.current = true;
      try {
        const result = await sshCommand(sid, COLLECT_CMD, 10);
        if (!result.ok || result.exitCode !== 0) {
          throw new Error(result.stderr || `exit=${result.exitCode}`);
        }

        const parsed = parseCollectOutput(result.output, intervalSecs);
        if (!parsed) {
          throw new Error('解析采集数据失败');
        }

        const now = Date.now();
        const overview = overviewRef.current ?? {
          hostname: '—',
          os: '—',
          kernel: '—',
          uptime: 0,
          loadAvg: [0, 0, 0] as [number, number, number],
        };

        const fullMetrics: ServerMetrics = {
          ...parsed,
          overview,
          timestamp: now,
        };

        setMetrics(fullMetrics);
        setError(null);
        snapshotsRef.current.failures = 0;
        // U1 修复：记录本次采集时间戳，供下次网络速率差值法使用
        snapshotsRef.current.lastCollectTime = now;
        setStatus('polling');

        // 追加历史点
        const totalRxRate = fullMetrics.network.reduce((sum, n) => sum + n.rxRate, 0);
        const totalTxRate = fullMetrics.network.reduce((sum, n) => sum + n.txRate, 0);
        const point: MetricHistoryPoint = {
          timestamp: now,
          cpu: fullMetrics.cpu.overall,
          mem: fullMetrics.memory.usagePercent,
          rxRate: totalRxRate,
          txRate: totalTxRate,
        };
        setHistory((prev) => [...prev.slice(-(MAX_HISTORY - 1)), point]);
      } catch (err) {
        snapshotsRef.current.failures += 1;
        const errMsg = err instanceof Error ? err.message : String(err);

        if (snapshotsRef.current.failures >= MAX_FAILURES) {
          setStatus('error');
          setError(`采集连续失败 ${MAX_FAILURES} 次：${errMsg}`);
          // ROADMAP #20 声称"连续失败 3 次自动停止轮询"——此前只置 error
          // 状态，interval 仍在每轮空发采集命令（2026-08-28 审查修复）。
          // 停止后由主轮询 effect 在会话重连/参数变化时重建恢复。
          if (timerRef.current) {
            clearInterval(timerRef.current);
            timerRef.current = null;
          }
        } else {
          setError(errMsg);
        }
      } finally {
        isCollectingRef.current = false;
      }
    },
    [parseCollectOutput],
  );

  /** 采集系统概览（一次性） */
  const collectOverview = useCallback(async (sid: number) => {
    try {
      const result = await sshCommand(sid, OVERVIEW_CMD, 10);
      if (!result.ok) return;
      const parts = result.output.split('===SEP===').map((s) => s.trim());
      if (parts.length >= 5) {
        overviewRef.current = parseSystemOverview(
          parts[0],
          parts[1],
          parts[2],
          parts[3],
          parts[4],
        );
      }
    } catch (e) {
      // U5 修复：概览采集失败不影响主流程，但记录日志便于排查
      console.warn('[server-monitor] collectOverview failed:', e);
    }
  }, []);

  /** 设置轮询间隔 */
  const setIntervalMs = useCallback((ms: number) => {
    setCurrentInterval(Math.max(1000, Math.min(10000, ms)));
  }, []);

  // 主轮询 effect
  useEffect(() => {
    // 清理旧定时器
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    // 条件检查：面板未启用 / 无会话 / 未连接 → 停止
    if (!enabled || sessionId === null || !sessionConnected) {
      setStatus((prev) => (prev === 'polling' ? 'stopped' : prev));
      // 重置快照（会话切换后差值法需重新初始化）
      snapshotsRef.current = {
        cpuSnaps: [],
        netSnaps: [],
        lastCollectTime: 0,
        failures: 0,
      };
      return;
    }

    setStatus('polling');
    setError(null);

    // 首次采集概览
    void collectOverview(sessionId);

    const intervalSecs = currentInterval / 1000;
    // 首次立即采集一次
    void collectOnce(sessionId, intervalSecs);
    // 定时轮询
    timerRef.current = setInterval(() => {
      void collectOnce(sessionId, intervalSecs);
    }, currentInterval);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [enabled, sessionId, sessionConnected, currentInterval, collectOnce, collectOverview]);

  return {
    metrics,
    history,
    status,
    error,
    intervalMs: currentInterval,
    setIntervalMs,
  };
}

// ============================================================================
// 内部工具
// ============================================================================

/** 将合并命令输出按 "===SECTION===" 标记拆分为多个段 */
function splitSections(output: string): Map<string, string> {
  const sections = new Map<string, string>();
  const lines = output.split('\n');
  let currentSection = '';
  let currentLines: string[] = [];

  for (const line of lines) {
    const match = line.match(/^===(\w+)===/);
    if (match) {
      if (currentSection) {
        sections.set(currentSection, currentLines.join('\n'));
      }
      currentSection = match[1];
      currentLines = [];
    } else if (currentSection) {
      currentLines.push(line);
    }
  }
  if (currentSection) {
    sections.set(currentSection, currentLines.join('\n'));
  }

  return sections;
}
