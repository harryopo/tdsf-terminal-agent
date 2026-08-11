// TDSF 服务器实时监控 —— 主面板（浮动右上角）
// -----------------------------------------------------------------------------
// 浮动面板样式参考 AiMiniWindow（fixed z-40 rounded-2xl border shadow）。
// 布局：
//   - 顶部拖拽栏（标题 + 连接状态 + 刷新间隔 + 关闭按钮）
//   - 滚动内容区（系统概览 → CPU → 内存 → 磁盘 → 网络 → 进程）
//
// 不遮挡 AI 对话模块（AiMiniWindow 在右下角，本面板在右上角）。

import {
  Cancel01Icon,
  CpuIcon,
  DashboardSquare01Icon,
  HardDriveIcon,
  MemoryStickIcon,
  Activity01Icon,
  Wifi01Icon,
  ReloadIcon,
} from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Component, type ErrorInfo, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { usePreferencesStore } from '@/modules/settings/preferences';
import { selectActiveSession, useSshStore } from '@/modules/ssh-explorer/sshStore';
import type {
  CollectStatus,
  CpuMetrics,
  DiskMetrics,
  MemoryMetrics,
  NetInterfaceMetrics,
  ProcessInfo,
  ServerMetrics,
  SystemOverview,
} from '../types';
import {
  formatBytes,
  formatRate,
  formatUptime,
  usageBarColor,
  usageColor,
} from '../lib/parser';
import { useServerMetrics } from '../lib/useServerMetrics';
import { MiniSparkline } from './MiniSparkline';

interface ServerMonitorPanelProps {
  /** 关闭面板 */
  onClose: () => void;
  /** 面板宽度 */
  width?: number;
}

/** 默认轮询间隔选项（用于设置界面） */
export function ServerMonitorPanel({ onClose, width = 340 }: ServerMonitorPanelProps) {
  const activeSession = useSshStore(selectActiveSession);
  const sessionLabel = activeSession
    ? `${activeSession.params.user}@${activeSession.params.host}`
    : null;

  // 从设置界面读取采集间隔；面板宽度使用默认 340px（见 width prop）
  const settingsInterval = usePreferencesStore((s) => s.serverMonitorInterval);

  // 面板打开时始终启用采集，间隔由设置控制
  const { metrics, history, status, error } =
    useServerMetrics(true, settingsInterval);

  return (
    <div
      data-no-drag
      style={{ width }}
      className={cn(
        'fixed right-3 top-12 z-40 flex max-h-[calc(100vh-64px)] flex-col overflow-hidden',
        'rounded-2xl border border-border/60 bg-card/95 text-[12px] backdrop-blur-xl',
        'shadow-[0_24px_48px_-12px_rgba(0,0,0,0.45),0_8px_16px_-8px_rgba(0,0,0,0.3)]',
        'ring-1 ring-black/5 dark:ring-white/5',
        'animate-in fade-in-0 zoom-in-95 slide-in-from-top-2 duration-200',
      )}
    >
      {/* ====== 顶部栏 ====== */}
      <PanelHeader
        sessionLabel={sessionLabel}
        status={status}
        onClose={onClose}
      />

      {/* ====== 内容区 ====== */}
      <div className="no-scrollbar flex-1 overflow-y-auto p-3">
        <MonitorErrorBoundary>
          {!sessionLabel ? (
            <EmptyState message="未连接 SSH 服务器" />
          ) : status === 'error' && !metrics ? (
            <ErrorState message={error} />
          ) : !metrics ? (
            <LoadingState />
          ) : (
            <div className="flex flex-col gap-3">
              <SystemOverviewCard overview={metrics.overview} />
              <CpuCard cpu={metrics.cpu} history={history.map((h) => h.cpu)} />
              <MemoryCard memory={metrics.memory} history={history.map((h) => h.mem)} />
              <DiskCard disks={metrics.disks} />
              <NetworkCard
                network={metrics.network}
                rxHistory={history.map((h) => h.rxRate)}
                txHistory={history.map((h) => h.txRate)}
              />
              <ProcessCard processes={metrics.processes} />
            </div>
          )}
        </MonitorErrorBoundary>
      </div>
    </div>
  );
}

// ============================================================================
// Error Boundary — 防止远端畸形数据导致面板白屏（M1 修复）
// ============================================================================

interface MonitorErrorBoundaryState {
  hasError: boolean;
}

class MonitorErrorBoundary extends Component<
  { children: ReactNode },
  MonitorErrorBoundaryState
> {
  state: MonitorErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): MonitorErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[server-monitor] panel render error:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
          <p className="text-sm font-medium text-red-500">监控数据异常</p>
          <p className="text-[10px] text-muted-foreground">请刷新面板重试</p>
        </div>
      );
    }
    return this.props.children;
  }
}

// ============================================================================
// 顶部栏
// ============================================================================

function PanelHeader({
  sessionLabel,
  status,
  onClose,
}: {
  sessionLabel: string | null;
  status: CollectStatus;
  onClose: () => void;
}) {
  const statusColor =
    status === 'polling'
      ? 'bg-emerald-500'
      : status === 'error'
        ? 'bg-red-500'
        : 'bg-muted-foreground/30';

  return (
    <div className="flex items-center gap-2 border-b border-border/60 px-3 py-2">
      <HugeiconsIcon
        icon={DashboardSquare01Icon}
        size={15}
        strokeWidth={1.75}
        className="shrink-0 text-muted-foreground"
      />
      <span className="font-medium text-foreground">服务器监控</span>

      {/* 连接状态指示灯 */}
      <span className={cn('size-2 shrink-0 rounded-full', statusColor)} />

      {/* 会话标签 */}
      {sessionLabel && (
        <span className="truncate font-mono text-[10px] text-muted-foreground">
          {sessionLabel}
        </span>
      )}

      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onClose}
          className="text-muted-foreground hover:text-foreground"
          title="关闭监控面板"
        >
          <HugeiconsIcon icon={Cancel01Icon} size={14} strokeWidth={1.75} />
        </Button>
      </div>
    </div>
  );
}

// ============================================================================
// 状态占位
// ============================================================================

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <HugeiconsIcon
        icon={DashboardSquare01Icon}
        size={32}
        strokeWidth={1.25}
        className="text-muted-foreground/40"
      />
      <p className="text-muted-foreground">{message}</p>
      <p className="text-[10px] text-muted-foreground/60">
        连接 SSH 后自动开始监控
      </p>
    </div>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12">
      <HugeiconsIcon
        icon={ReloadIcon}
        size={24}
        strokeWidth={1.5}
        className="animate-spin text-muted-foreground/60"
      />
      <p className="text-muted-foreground">采集中…</p>
    </div>
  );
}

function ErrorState({ message }: { message: string | null }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-12 text-center">
      <p className="text-sm font-medium text-red-500">采集失败</p>
      <p className="max-w-[260px] truncate text-[10px] text-muted-foreground">
        {message ?? '未知错误'}
      </p>
    </div>
  );
}

// ============================================================================
// 卡片公共容器
// ============================================================================

function MetricCard({
  icon,
  title,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-border/40 bg-background/40 p-2.5">
      <div className="mb-2 flex items-center gap-1.5">
        {icon}
        <span className="text-[11px] font-medium text-muted-foreground">{title}</span>
      </div>
      {children}
    </div>
  );
}

// ============================================================================
// 系统概览卡片
// ============================================================================

function SystemOverviewCard({ overview }: { overview: SystemOverview }) {
  return (
    <MetricCard
      icon={<HugeiconsIcon icon={Activity01Icon} size={13} strokeWidth={1.75} className="text-muted-foreground" />}
      title="系统概览"
    >
      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <InfoRow label="主机名" value={overview.hostname} />
        <InfoRow label="运行" value={formatUptime(overview.uptime)} />
        <InfoRow label="内核" value={overview.kernel || '—'} className="col-span-2" />
        <InfoRow label="系统" value={overview.os} className="col-span-2" />
        <InfoRow
          label="负载"
          value={overview.loadAvg.map((v) => v.toFixed(2)).join(' / ')}
          className="col-span-2"
        />
      </div>
    </MetricCard>
  );
}

function InfoRow({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center justify-between gap-2', className)}>
      <span className="shrink-0 text-muted-foreground/70">{label}</span>
      <span className="truncate font-mono text-foreground/90">{value}</span>
    </div>
  );
}

// ============================================================================
// CPU 卡片
// ============================================================================

function CpuCard({ cpu, history }: { cpu: CpuMetrics; history: number[] }) {
  const cpuColor = usageColor(cpu.overall);
  return (
    <MetricCard
      icon={<HugeiconsIcon icon={CpuIcon} size={13} strokeWidth={1.75} className="text-muted-foreground" />}
      title="CPU"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-1">
          <span className={cn('font-mono text-2xl font-bold tabular-nums', cpuColor)}>
            {cpu.overall.toFixed(1)}
          </span>
          <span className="text-[10px] text-muted-foreground">%</span>
        </div>
        <div className={cpuColor}>
          <MiniSparkline data={history} width={100} height={28} color="currentColor" />
        </div>
      </div>

      {/* 每核迷你条 */}
      {cpu.perCore.length > 1 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {cpu.perCore.map((usage, i) => (
            <div key={i} className="flex flex-col items-center gap-0.5">
              <div className="relative h-8 w-2 overflow-hidden rounded-full bg-muted">
                <div
                  className={cn('absolute bottom-0 w-full rounded-full transition-all duration-300', usageBarColor(usage))}
                  style={{ height: `${Math.max(2, usage)}%` }}
                />
              </div>
              <span className="text-[8px] text-muted-foreground/60">{i}</span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-1.5 text-[10px] text-muted-foreground">
        {cpu.coreCount} 核心
      </div>
    </MetricCard>
  );
}

// ============================================================================
// 内存卡片
// ============================================================================

function MemoryCard({ memory, history }: { memory: MemoryMetrics; history: number[] }) {
  const memColor = usageColor(memory.usagePercent);
  return (
    <MetricCard
      icon={<HugeiconsIcon icon={MemoryStickIcon} size={13} strokeWidth={1.75} className="text-muted-foreground" />}
      title="内存"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-1">
          <span className={cn('font-mono text-2xl font-bold tabular-nums', memColor)}>
            {memory.usagePercent.toFixed(1)}
          </span>
          <span className="text-[10px] text-muted-foreground">%</span>
        </div>
        <div className={memColor}>
          <MiniSparkline data={history} width={100} height={28} color="currentColor" />
        </div>
      </div>

      <div className="mt-2 space-y-1 text-[11px]">
        <InfoRow
          label="已用 / 总量"
          value={`${formatBytes(memory.used)} / ${formatBytes(memory.total)}`}
        />
        <InfoRow label="可用" value={formatBytes(memory.available)} />
        {memory.swapTotal > 0 && (
          <InfoRow
            label="Swap"
            value={`${formatBytes(memory.swapUsed)} / ${formatBytes(memory.swapTotal)}`}
          />
        )}
      </div>
    </MetricCard>
  );
}

// ============================================================================
// 磁盘卡片
// ============================================================================

function DiskCard({ disks }: { disks: DiskMetrics[] }) {
  if (disks.length === 0) {
    return (
      <MetricCard
        icon={<HugeiconsIcon icon={HardDriveIcon} size={13} strokeWidth={1.75} className="text-muted-foreground" />}
        title="磁盘"
      >
        <p className="text-[11px] text-muted-foreground">未检测到分区</p>
      </MetricCard>
    );
  }

  return (
    <MetricCard
      icon={<HugeiconsIcon icon={HardDriveIcon} size={13} strokeWidth={1.75} className="text-muted-foreground" />}
      title="磁盘"
    >
      <div className="space-y-2">
        {disks.map((disk) => (
          <div key={disk.mountPoint}>
            <div className="mb-0.5 flex items-center justify-between text-[11px]">
              <span className="truncate font-mono text-foreground/90">{disk.mountPoint}</span>
              <span className={cn('shrink-0 font-mono', usageColor(disk.usagePercent))}>
                {disk.usagePercent.toFixed(0)}%
              </span>
            </div>
            {/* 进度条 */}
            <div className="relative h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={cn('absolute left-0 h-full rounded-full transition-all duration-300', usageBarColor(disk.usagePercent))}
                style={{ width: `${Math.min(100, disk.usagePercent)}%` }}
              />
            </div>
            <div className="mt-0.5 text-[9px] text-muted-foreground/70">
              {formatBytes(disk.used)} / {formatBytes(disk.total)}
            </div>
          </div>
        ))}
      </div>
    </MetricCard>
  );
}

// ============================================================================
// 网络卡片
// ============================================================================

function NetworkCard({
  network,
  rxHistory,
  txHistory,
}: {
  network: NetInterfaceMetrics[];
  rxHistory: number[];
  txHistory: number[];
}) {
  if (network.length === 0) {
    return (
      <MetricCard
        icon={<HugeiconsIcon icon={Wifi01Icon} size={13} strokeWidth={1.75} className="text-muted-foreground" />}
        title="网络"
      >
        <p className="text-[11px] text-muted-foreground">无网络接口</p>
      </MetricCard>
    );
  }

  const totalRx = network.reduce((sum, n) => sum + n.rxRate, 0);
  const totalTx = network.reduce((sum, n) => sum + n.txRate, 0);

  return (
    <MetricCard
      icon={<HugeiconsIcon icon={Wifi01Icon} size={13} strokeWidth={1.75} className="text-muted-foreground" />}
      title="网络"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex-1">
          <div className="text-[10px] text-muted-foreground">↓ 下行</div>
          <div className="font-mono text-sm font-bold text-emerald-500">
            {formatRate(totalRx)}
          </div>
        </div>
        <div className="flex-1 text-right">
          <div className="text-[10px] text-muted-foreground">↑ 上行</div>
          <div className="font-mono text-sm font-bold text-sky-500">
            {formatRate(totalTx)}
          </div>
        </div>
      </div>

      {/* 双线折线图 */}
      <div className="mt-2 flex items-center gap-1">
        <div className="text-emerald-500">
          <MiniSparkline data={rxHistory} width={140} height={24} color="currentColor" />
        </div>
        <div className="text-sky-500">
          <MiniSparkline data={txHistory} width={140} height={24} color="currentColor" />
        </div>
      </div>

      {/* 各接口列表 */}
      {network.length > 1 && (
        <div className="mt-2 space-y-0.5">
          {network.map((iface) => (
            <div key={iface.name} className="flex items-center justify-between text-[10px]">
              <span className="font-mono text-muted-foreground">{iface.name}</span>
              <span className="font-mono text-foreground/80">
                ↓ {formatRate(iface.rxRate)} ↑ {formatRate(iface.txRate)}
              </span>
            </div>
          ))}
        </div>
      )}
    </MetricCard>
  );
}

// ============================================================================
// 进程卡片
// ============================================================================

function ProcessCard({ processes }: { processes: ProcessInfo[] }) {
  if (processes.length === 0) {
    return null;
  }

  return (
    <MetricCard
      icon={<HugeiconsIcon icon={CpuIcon} size={13} strokeWidth={1.75} className="text-muted-foreground" />}
      title="Top 进程"
    >
      <div className="space-y-1">
        {processes.map((proc) => (
          <div key={proc.pid} className="flex items-center gap-2 text-[10px]">
            <span className="w-10 shrink-0 truncate font-mono text-muted-foreground">
              {proc.user}
            </span>
            <span className="w-8 shrink-0 text-right font-mono text-emerald-500/80">
              {proc.cpuPercent.toFixed(1)}%
            </span>
            <span className="w-8 shrink-0 text-right font-mono text-amber-500/80">
              {proc.memPercent.toFixed(1)}%
            </span>
            <span className="truncate text-foreground/70">{proc.command}</span>
          </div>
        ))}
      </div>
    </MetricCard>
  );
}

// 导出 ServerMetrics 类型供外部使用
export type { ServerMetrics };
