/**
 * remoteCarapaceAdmin.ts — 设置页管理「远端补全组件」的唯一逻辑层
 * -----------------------------------------------------------------------------
 * 为什么需要这一层（用户 2026-09-28 反馈）：安装入口原来只长在 SSH 终端右下角
 * 一个小图标上，设置页那一行只管"图标显不显示"，用户从来不知道有这回事，
 * 装失败也只在图标里说一句。这里给设置页一个能主动列出服务器、看状态、点安装
 * 的入口，并把失败原因原文带出来。
 *
 * 三条口径：
 *   - 数据源只有一个：会话列表走 `ssh_sessions_detail`（Rust 的权威账），
 *     存在性检测复用 `CARAPACE_CHECK_CMD` 与 `CARAPACE_YES_MARK`（不另抄一份路径），
 *     安装复用 `installRemoteCarapace`（同一条四步链，不再写第二遍）。
 *   - `ssh_sessions_detail` 在真机挂起过（#126 记着）⇒ 一切 IPC 读取都带截止时间，
 *     超时返回错误状态而不是让界面永远转圈。
 *   - 装完必须让**主窗**那一侧知道：设置窗与主窗是两个 JS context，各自一份
 *     `remoteInstalledCache`，不发消息的话主窗角标会一直挂着"未安装"。
 */
import { emit } from '@tauri-apps/api/event';
import {
  CARAPACE_CHECK_CMD,
  CARAPACE_YES_MARK,
  installRemoteCarapace,
  type CarapaceInstallStage,
} from '@/lib/param-complete-client';
import { CARAPACE_CHANGED_EVENT } from '@/lib/sshCarapaceEvents';
import {
  sshCommand,
  sshSessionsDetail,
  type SshCommandResult,
  type SshSessionDetail,
} from '@/lib/ssh-bridge';

/** 会话列表读取的截止时间（这条 IPC 挂起过，界面不能因此卡死） */
export const CARAPACE_TARGETS_DEADLINE_MS = 4000;

/**
 * 上传体积的展示口径（设置页文案里那个数）。
 * 真值由 `remoteCarapaceSize.test.ts` 读 `src-tauri/bin/carapace-linux-amd64`
 * 的实际字节数钉住 —— 换二进制时必须回来改这个数。
 */
export const CARAPACE_BINARY_MB = 80;

/** 一台服务器上的一行（同一台的多条会话去重后只留一条作代表） */
export interface CarapaceTarget {
  sessionId: number;
  label: string;
}

/** 存在性检测的三态：分不清的别硬塞进"未安装" */
export type CarapaceProbeState = 'installed' | 'missing' | 'error';

export interface CarapaceProbeResult {
  state: CarapaceProbeState;
  /** state 为 error 时的原因（原文，不糊成一句"检测失败"） */
  detail?: string;
}

export interface CarapaceTargetsResult {
  targets: CarapaceTarget[];
  /** 读取失败/超时的原因；为空表示确实没有连着的服务器 */
  error?: string;
}

function sessionLabel(d: SshSessionDetail): string {
  return `${d.user}@${d.host}:${d.port}`;
}

/**
 * 纯函数：只留「已连上」的会话，并按 user@host:port 去重（保留会话号最小那条）。
 *
 * 去重理由：组件装在服务器的 ~/.local/bin，装一次对该机上所有会话都生效；
 * 而 #89 之后一个标签页一条连接，同一台服务器常有 2-3 条会话，不去重会把列表
 * 刷成一排重复行，用户会以为是"每台都要装一次"。
 */
export function pickCarapaceTargets(
  details: readonly SshSessionDetail[],
): CarapaceTarget[] {
  const byKey = new Map<string, SshSessionDetail>();
  for (const d of details) {
    if (d.state !== 'connected') continue;
    const key = sessionLabel(d);
    const kept = byKey.get(key);
    if (!kept || d.sessionId < kept.sessionId) byKey.set(key, d);
  }
  return [...byKey.values()]
    .sort((a, b) => a.sessionId - b.sessionId)
    .map((d) => ({ sessionId: d.sessionId, label: sessionLabel(d) }));
}

/** 带截止时间的等待：超时返回哨兵而不是抛错（调用方据此给界面一句真话） */
const TIMEOUT: unique symbol = Symbol('timeout');

async function withDeadline<T>(
  p: Promise<T>,
  timeoutMs: number,
): Promise<T | typeof TIMEOUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<typeof TIMEOUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 列出可安装的服务器。失败一律降级成 `{ targets: [], error }` ——
 * 设置页不能因为一次 IPC 挂起或抛错就把整块界面弄没（#125 那一族）。
 */
export async function listCarapaceTargets(
  deadlineMs = CARAPACE_TARGETS_DEADLINE_MS,
): Promise<CarapaceTargetsResult> {
  const raced = await withDeadline(
    sshSessionsDetail().then(
      (list): SshSessionDetail[] | string => list,
      (e: unknown) =>
        `没拿到会话列表：${e instanceof Error ? e.message : String(e)}`,
    ),
    deadlineMs,
  );
  if (raced === TIMEOUT) {
    return {
      targets: [],
      error: '没拿到会话列表（查询超时），请稍后再点一次刷新',
    };
  }
  if (typeof raced === 'string') return { targets: [], error: raced };
  return { targets: pickCarapaceTargets(raced) };
}

/**
 * 单独一条命令的存在性检测，比 `remoteCarapaceInstalled` 多分出 error：
 * 那个函数是预测链路上的静默降级（拿不到就当没装，不打扰输入），
 * 而设置页要把"没装"和"没测出来"说成两句话。
 */
export async function probeCarapaceTarget(sessionId: number): Promise<CarapaceProbeResult> {
  let r: SshCommandResult;
  try {
    r = await sshCommand(sessionId, CARAPACE_CHECK_CMD, 5);
  } catch (e) {
    return { state: 'error', detail: e instanceof Error ? e.message : String(e) };
  }
  if (r.output.includes(CARAPACE_YES_MARK)) return { state: 'installed' };
  // 链路正常且拿到了退出码才敢说"未安装"；-1（没收到退出状态）归 error
  if (r.ok && r.exitCode !== -1) return { state: 'missing' };
  return {
    state: 'error',
    detail: (r.stderr || r.output || '命令没有返回结果').trim(),
  };
}

/**
 * 装到一台服务器：走既有的四步链（建目录 → 传二进制 → chmod + 验证 → 失效缓存）。
 * 成功后发跨窗事件，并清掉本窗这份缓存，让下一次检测问服务器而不是问内存。
 */
export async function installCarapaceTarget(
  sessionId: number,
  onStage?: (stage: CarapaceInstallStage) => void,
): Promise<{ ok: boolean; message?: string }> {
  let message = '';
  const ok = await installRemoteCarapace(
    sessionId,
    (stage) => {
      onStage?.(stage);
      if (stage === 'done') message = '已装好，远端参数补全启用';
    },
    (err) => {
      message = err;
    },
  );
  if (!ok) return { ok: false, message: message || '安装失败（没有拿到具体原因）' };
  // 缓存失效由 installRemoteCarapace 的第 4 步负责（实测过：摘掉那行才会红，
  // 在这里再调一次是重复劳动）—— 本层只负责把"装好了"这件事通知别的窗。
  try {
    // 用全局 emit 而不是 emitTo("main")：工作台窗可能不止一扇（#64 允许多开），
    // 每扇都注册了同一个监听；设置窗自己不监听，收到也不会多干一遍。
    await emit(CARAPACE_CHANGED_EVENT, { sessionId });
  } catch (e) {
    // 发不出去只是主窗那一侧暂时不知道，服务器上确实装好了 —— 说清但不算失败
    console.warn('[carapace-admin] 跨窗通知发送失败:', e);
  }
  return { ok: true, message };
}
