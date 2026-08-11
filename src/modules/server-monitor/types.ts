// TDSF 服务器实时监控 —— 类型定义
// -----------------------------------------------------------------------------
// 与 Rust 侧采集逻辑对齐（前端通过 sshCommand 执行 shell 命令后由 parser.ts 解析）。
// 所有数值字段：CPU/内存/磁盘使用率为 0-100 浮点，字节/速度为原始字节数。

/** CPU 指标 */
export interface CpuMetrics {
  /** 总体使用率 (0-100) */
  overall: number;
  /** 每核使用率 (0-100)，长度 = 核心数 */
  perCore: number[];
  /** 逻辑核心总数 */
  coreCount: number;
}

/** 内存指标（单位：字节） */
export interface MemoryMetrics {
  /** 总物理内存 */
  total: number;
  /** 已用（total - available） */
  used: number;
  /** 可用（含可回收缓存，内核估算） */
  available: number;
  /** 使用率 (0-100) */
  usagePercent: number;
  /** Swap 总量（0 = 无 swap 分区） */
  swapTotal: number;
  /** Swap 已用 */
  swapUsed: number;
}

/** 单个磁盘分区指标 */
export interface DiskMetrics {
  /** 设备名（/dev/sda1 等） */
  filesystem: string;
  /** 挂载点 */
  mountPoint: string;
  /** 总容量（字节） */
  total: number;
  /** 已用（字节） */
  used: number;
  /** 可用（字节） */
  available: number;
  /** 使用率 (0-100) */
  usagePercent: number;
}

/** 单个网络接口指标 */
export interface NetInterfaceMetrics {
  /** 接口名（eth0 / enp0s3 等） */
  name: string;
  /** 当前接收速率（字节/秒） */
  rxRate: number;
  /** 当前发送速率（字节/秒） */
  txRate: number;
  /** 累计接收字节数 */
  rxBytesTotal: number;
  /** 累计发送字节数 */
  txBytesTotal: number;
}

/** 单个进程信息（Top N） */
export interface ProcessInfo {
  pid: number;
  user: string;
  cpuPercent: number;
  memPercent: number;
  /** 命令行（截断到 80 字符） */
  command: string;
}

/** 系统概览（采集一次，不轮询） */
export interface SystemOverview {
  hostname: string;
  os: string;
  kernel: string;
  /** 运行时间（秒） */
  uptime: number;
  /** 1/5/15 分钟平均负载 */
  loadAvg: [number, number, number];
}

/** 一次完整采集结果 */
export interface ServerMetrics {
  /** 采集时间戳（ms） */
  timestamp: number;
  cpu: CpuMetrics;
  memory: MemoryMetrics;
  disks: DiskMetrics[];
  network: NetInterfaceMetrics[];
  processes: ProcessInfo[];
  overview: SystemOverview;
}

/** 折线图历史数据点 */
export interface MetricHistoryPoint {
  timestamp: number;
  cpu: number;
  mem: number;
  rxRate: number;
  txRate: number;
}

/** 采集状态 */
export type CollectStatus =
  | 'idle'      // 未开始
  | 'polling'   // 正在轮询
  | 'error'     // 连续失败
  | 'stopped';  // 手动停止 / 会话断开
