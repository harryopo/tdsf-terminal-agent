/**
 * sandbox-bridge.ts — Docker 沙箱桥接层 (P2-D T-P2-08.6, DEC-V321-10)
 * -----------------------------------------------------------------------------
 * 封装前端 ↔ Rust SandboxManager 的所有 Tauri invoke 调用，
 * 提供类型化的容器生命周期 + 命令执行 API。
 *
 * 通信链路:
 *   前端 sandboxCreate(config)
 *     → invoke('sandbox_create', { config })
 *     → Rust 侧 SandboxManager::create_container(bollard)
 *     → 返回 container_id (64 字符 hex)
 *
 * Rust 侧命令 (src-tauri/src/modules/sandbox/mod.rs):
 *   - sandbox_status()                                -> DockerStatus
 *   - sandbox_create(config: SandboxConfig)           -> String (container_id)
 *   - sandbox_start(id: String)                      -> ()
 *   - sandbox_stop(id: String)                       -> ()
 *   - sandbox_remove(id: String)                     -> ()
 *   - sandbox_exec(id: String, cmd: Vec<String>)     -> ExecResult
 *   - sandbox_list()                                  -> Vec<ContainerInfo>
 *
 * 类型对齐:
 *   - Rust SandboxConfig: #[serde(rename_all = "camelCase")] → 前端 camelCase
 *   - Rust ExecResult / ContainerInfo / DockerStatus / DockerVersion 同上
 *   - Rust 容器命名前缀: SANDBOX_NAME_PREFIX = "tdsf-sandbox-"
 *
 * 与 Python Sidecar 的关系:
 *   - 容器生命周期 (create/start/stop/remove) 必须走本桥接（Rust bollard）
 *   - 命令执行 (exec) 既可走本桥接，也可走 Python sandbox_proxy.execute
 *   - 前端默认走 Rust 通道（性能更好，无 subprocess 开销）
 */
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauri';

// === 类型定义 ================================================================

/**
 * 沙箱配置（前端 → Rust）
 *
 * 所有字段都有默认值，前端可只传需要覆盖的字段：
 *   ```ts
 *   await sandboxCreate({ image: 'ubuntu:24.04' });  // 其他用默认
 *   ```
 *
 * 默认值（与 Rust 侧 SandboxConfig::default 对齐）:
 *   - image:            'alpine:3.20'
 *   - memoryLimitBytes: 512 * 1024 * 1024  (512MB)
 *   - nanoCpus:         1_000_000_000      (1 CPU)
 *   - pidsLimit:        256
 *   - networkMode:      'none'             (无网络)
 *   - user:             'nobody:nobody'    (非 root)
 *   - readOnlyRootfs:   true               (只读根文件系统)
 *   - tmpfsSizeBytes:   64 * 1024 * 1024   (64MB /tmp)
 *   - seccompProfile:   'default'
 */
export interface SandboxConfig {
  /** 容器镜像 (默认 'alpine:3.20') */
  image?: string;
  /** 容器名前缀 (实际名 = 前缀 + uuid, 默认 'tdsf-sandbox-') */
  namePrefix?: string;
  /** 内存上限 (字节, 默认 512MB) */
  memoryLimitBytes?: number;
  /** CPU 配额 (10⁻⁹ CPU 单位, 默认 1_000_000_000 = 1 CPU) */
  nanoCpus?: number;
  /** 进程数限制 (cgroups pids, 默认 256) */
  pidsLimit?: number;
  /** 网络模式 (默认 'none' 无网络) */
  networkMode?: string;
  /** 容器内执行用户 (默认 'nobody:nobody') */
  user?: string;
  /** 是否只读根文件系统 (默认 true) */
  readOnlyRootfs?: boolean;
  /** /tmp tmpfs 大小 (字节, 默认 64MB) */
  tmpfsSizeBytes?: number;
  /** seccomp profile 路径 ('default' 表示 Docker 默认) */
  seccompProfile?: string;
  /** 是否启用 ssl (本地连接通常不需要) */
  enableSsl?: boolean;
}

/**
 * Docker 版本信息 (Rust 侧 DockerVersion, camelCase)
 */
export interface DockerVersion {
  /** Docker 版本 (如 '27.0.3') */
  version: string;
  /** API 版本 (如 '1.45') */
  apiVersion: string;
  /** Docker 组件 (如 ['Docker Desktop', 'community']) */
  components: string[];
  /** OS/Arch (如 'linux/amd64') */
  osArch: string;
}

/**
 * Docker 可用性状态 (Rust 侧 DockerStatus, camelCase)
 *
 * 前端首次进入沙箱面板时调用 sandboxStatus()，根据结果决定 UI 状态：
 *   - available=true:  显示沙箱操作面板
 *   - available=false: 显示引导安装 Docker Desktop 的提示
 */
export interface DockerStatus {
  /** Docker daemon 是否可用 */
  available: boolean;
  /** 版本信息 (available=true 时有值) */
  version?: DockerVersion;
  /** 不可用原因 (available=false 时有值, 含安装引导) */
  error?: string;
  /** 检测到的连接方式 ('unix_socket' / 'named_pipe' / 'http' / 'ssl') */
  transport?: string;
}

/**
 * 命令执行结果 (Rust 侧 ExecResult, camelCase)
 */
export interface ExecResult {
  /** 容器 ID */
  containerId: string;
  /** 执行的命令 (含参数) */
  cmd: string[];
  /** 标准输出 (UTF-8) */
  stdout: string;
  /** 标准错误 (UTF-8) */
  stderr: string;
  /** 退出码 (0=成功, 127=命令不存在, 137=OOM 等) */
  exitCode: number;
  /** 执行耗时 (毫秒) */
  durationMs: number;
}

/**
 * 容器信息 (Rust 侧 ContainerInfo, camelCase)
 */
export interface ContainerInfo {
  /** 容器 ID (完整 64 字符 hex) */
  id: string;
  /** 容器名 (已去掉前导 '/') */
  name: string;
  /** 镜像名 (image:tag) */
  image: string;
  /** 状态 ('running' / 'exited' / 'paused' / 'created') */
  state: string;
  /** 状态简写 ('Up 5 seconds' / 'Exited (0) 2 minutes ago') */
  status: string;
  /** 创建时间戳 (Unix 秒) */
  created: number;
}

// === 核心 API ================================================================

/**
 * 检测 Docker daemon 可用性
 *
 * 前端首次进入沙箱面板时调用，根据结果决定 UI 状态。
 * 返回 DockerStatus，available=false 时 error 字段含安装引导。
 *
 * @example
 * ```ts
 * const status = await sandboxStatus();
 * if (!status.available) {
 *   // 显示引导用户安装 Docker Desktop 的提示
 *   showInstallGuide(status.error);
 *   return;
 * }
 * console.log('Docker version:', status.version?.version);
 * ```
 */
export async function sandboxStatus(): Promise<DockerStatus> {
  if (!isTauri()) {
    return createBrowserMockStatus();
  }
  return invoke<DockerStatus>('sandbox_status');
}

/**
 * 创建沙箱容器
 *
 * 应用完整安全配置: cap_drop ALL + read_only_rootfs + 非 root + seccomp +
 * 资源限制 (512MB / 1 CPU / 256 pids) + 网络 none + /tmp tmpfs 64MB。
 *
 * @param config 沙箱配置 (可选字段使用默认值)
 * @returns 容器 ID (64 字符 hex)
 *
 * @example
 * ```ts
 * // 用默认配置创建 (alpine:3.20 + 全套安全加固)
 * const id = await sandboxCreate({});
 *
 * // 用自定义镜像创建
 * const id2 = await sandboxCreate({ image: 'ubuntu:24.04', memoryLimitBytes: 1024 * 1024 * 1024 });
 * ```
 */
export async function sandboxCreate(config: SandboxConfig = {}): Promise<string> {
  if (!isTauri()) {
    throw createBrowserOnlyError('sandbox_create');
  }
  return invoke<string>('sandbox_create', { config });
}

/**
 * 启动容器 (已创建但未运行的容器)
 *
 * @param id 容器 ID (sandboxCreate 返回值)
 *
 * @example
 * ```ts
 * const id = await sandboxCreate({});
 * await sandboxStart(id);
 * ```
 */
export async function sandboxStart(id: string): Promise<void> {
  if (!isTauri()) {
    throw createBrowserOnlyError('sandbox_start');
  }
  await invoke<void>('sandbox_start', { id });
}

/**
 * 优雅停止容器 (10s 超时后强制 kill)
 *
 * @param id 容器 ID
 *
 * @example
 * ```ts
 * await sandboxStop(id);
 * ```
 */
export async function sandboxStop(id: string): Promise<void> {
  if (!isTauri()) {
    throw createBrowserOnlyError('sandbox_stop');
  }
  await invoke<void>('sandbox_stop', { id });
}

/**
 * 删除容器 (force=true, 即使运行中也会强制 kill+remove)
 *
 * @param id 容器 ID
 *
 * @example
 * ```ts
 * await sandboxStop(id);
 * await sandboxRemove(id);
 * ```
 */
export async function sandboxRemove(id: string): Promise<void> {
  if (!isTauri()) {
    throw createBrowserOnlyError('sandbox_remove');
  }
  await invoke<void>('sandbox_remove', { id });
}

/**
 * 在容器内执行命令并收集输出
 *
 * 默认走 Rust bollard 通道（性能更好，无 subprocess 开销）。
 * 若需走 Python docker CLI 通道，使用 invokeRpc('sandbox.execute', ...)。
 *
 * @param id 容器 ID
 * @param cmd 命令 argv (如 ['ls', '-l', '/'])
 * @returns ExecResult { stdout, stderr, exitCode, durationMs }
 *
 * @example
 * ```ts
 * const result = await sandboxExec(id, ['ls', '-l', '/']);
 * console.log(result.exitCode, result.stdout);
 *
 * // 检查命令是否成功
 * if (result.exitCode === 0) {
 *   console.log('命令成功:', result.stdout);
 * } else {
 *   console.error('命令失败:', result.stderr);
 * }
 * ```
 */
export async function sandboxExec(id: string, cmd: string[]): Promise<ExecResult> {
  if (!isTauri()) {
    throw createBrowserOnlyError('sandbox_exec');
  }
  return invoke<ExecResult>('sandbox_exec', { id, cmd });
}

/**
 * 列出所有 tdsf-sandbox-* 容器 (按 created 降序)
 *
 * @returns 容器信息数组
 *
 * @example
 * ```ts
 * const containers = await sandboxList();
 * containers.forEach(c => {
 *   console.log(`${c.name}: ${c.state} (${c.status})`);
 * });
 * ```
 */
export async function sandboxList(): Promise<ContainerInfo[]> {
  if (!isTauri()) {
    return [];
  }
  return invoke<ContainerInfo[]>('sandbox_list');
}

// === 高层辅助函数 ============================================================

/**
 * 完整的沙箱执行流程: 创建 → 启动 → 执行 → 删除
 *
 * 适用于一次性命令场景（不需要保留容器）。
 * 任一步骤失败会自动清理已创建的容器。
 *
 * @param cmd 命令 argv
 * @param config 沙箱配置 (可选)
 * @returns 执行结果 (stdout / stderr / exitCode)
 *
 * @example
 * ```ts
 * const result = await sandboxRunOnce(['echo', 'hello']);
 * console.log(result.stdout); // 'hello\n'
 * ```
 */
export async function sandboxRunOnce(
  cmd: string[],
  config: SandboxConfig = {}
): Promise<ExecResult> {
  const id = await sandboxCreate(config);
  try {
    await sandboxStart(id);
    return await sandboxExec(id, cmd);
  } finally {
    // 无论成功失败都尝试清理
    try {
      await sandboxRemove(id);
    } catch {
      // 忽略清理错误（容器可能已被删除）
    }
  }
}

/**
 * 判断 Docker 是否可用（轻量检测，不抛错）
 *
 * @example
 * ```ts
 * if (await isDockerAvailable()) {
 *   // 显示沙箱面板
 * }
 * ```
 */
export async function isDockerAvailable(): Promise<boolean> {
  const status = await sandboxStatus();
  return status.available;
}

// === 浏览器预览模式辅助 ======================================================

/** 浏览器模式下抛出友好错误（提示用户在 Tauri 窗口中运行） */
function createBrowserOnlyError(command: string): Error {
  return new Error(
    `Tauri command '${command}' is only available in Tauri window. ` +
      `Running in browser preview mode, Docker sandbox not accessible.`
  );
}

/** 浏览器模式下返回的 mock 状态（避免 UI 报错） */
function createBrowserMockStatus(): DockerStatus {
  return {
    available: false,
    error:
      'Docker sandbox not available in browser preview mode. ' +
      'Run `pnpm tauri dev` to enable.',
  };
}
