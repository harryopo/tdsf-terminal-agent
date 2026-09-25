// TDSF (P4-T4.1): SSH 会话 Zustand store
// -----------------------------------------------------------------------------
// 管理 SSH 会话列表 + 每条会话远端 shell 的当前目录 + 已保存凭据 + TOFU 主机审批队列
//
// 设计要点:
//   - 每个会话有前端 id (crypto.randomUUID) + Rust sessionId (ssh_connect 返回)
//   - 远端 shell 的 cwd 按前端 id 隔离；远程文件树不走这里（见 currentPathBySession 注释）
//   - 主机审批请求 (pendingApprovals 队列) 由 ssh:host_verify / ssh:host_key_mismatch
//     事件推送, 弹窗按到达顺序逐条询问用户
import { create } from 'zustand';
import { toast } from 'sonner';
import { describeSshFailure, describeSshFailureText } from './lib/sshErrorText';
import {
  sshConnect,
  sshCredentialsDelete,
  sshCredentialsGetSecret,
  sshCredentialsList,
  sshCredentialsSave,
  sshCredentialsTouch,
  sshCommand,
  sshTest,
  probeCmd,
  readProbeValue,
  type SshConnectParams,
  type SshCredentialProfile,
  type SshSession,
  type SshSessionStateValue,
  type SshStatusEvent,
  type HostApprovalRequest,
} from '@/lib/ssh-bridge';
import {
  fetchRemoteCommands,
  fetchRemoteOsInfo,
  remoteCarapaceInstalled,
  type RemoteOsInfo,
} from '@/lib/param-complete-client';

// TDSF 2026-08-28: SSH 会话的远端 carapace 检测状态（无弹窗设计，仅驱动小图标显隐）
/** 'checking' 检测中 / 'installed' 已装 / 'missing' 未装（键不存在 = 未检测） */
export type SshRemoteCarapaceState = 'checking' | 'installed' | 'missing';

// TDSF 诊断 (Phase 2): 集中 OSC 7 cwd 同步调试日志，避免污染控制台。
export type Osc7LogEntry = Record<string, unknown>;

declare global {
  interface Window {
    __TDSF_OSC7_LOG__?: Osc7LogEntry[];
  }
}

export function getOsc7Log(): Osc7LogEntry[] | null {
  if (typeof window === "undefined") return null;
  if (!window.__TDSF_OSC7_LOG__) window.__TDSF_OSC7_LOG__ = [];
  return window.__TDSF_OSC7_LOG__;
}

// --- 内部工具函数 (消除 sshStore 内重复模式) ---

/** 从 Record<sessionId, T> 中移除指定 session 的键 */
function omitSessionKey<T>(record: Record<string, T>, sessionId: string): Record<string, T> {
  return Object.fromEntries(
    Object.entries(record).filter(([k]) => k !== sessionId),
  );
}

// === 类型定义 ================================================================

/**
 * SSH 连接的出身（#101）。真源在 `spaces/lib/sshConnectedPlan`，此处只做类型别名，
 * 让会话对象与决策函数共用一个定义。
 */
export type SshSessionOrigin = 'space' | 'tab';

/** SSH 会话信息 (前端管理) */
export interface SshSessionInfo {  /** 前端唯一 id (crypto.randomUUID) */
  id: string;
  /** Rust 端分配的 session_id (ssh_connect 成功后填充) */
  rustSessionId: number | null;
  /** 连接参数 (host/port/user 等展示用字段; 不含 auth——明文凭据不落 store,
   *  auth 仅在 ssh_connect 调用时使用一次, 见 connect(), 2026-08-18 P1-9) */
  params: Omit<SshConnectParams, 'auth'>;
  /** 当前状态 (与 Rust SshSessionState 对齐, snake_case) */
  state: SshSessionStateValue;
  /** 错误信息 (Failed 状态时填充) */
  error?: string;
  /** 连接时间戳 (Unix 毫秒) */
  connectedAt: number;
  /** SshSession 句柄 (含 write/resize/close) */
  handle: SshSession | null;
  /** Authoritative sidecar probe result for this specific connected Rust session. */
  remoteOsInfo?: RemoteOsInfo;
  /**
   * TDSF 修复 2026-08-31: 标记该会话是否来自"开机自动连接"（connectWithSaved）。
   * 自动连接只恢复既有 SSH Space、绝不凭空新建工作区（否则本地用户开机被导向
   * 服务器）。在 connect() 创建会话时同步写入——避免用 store 级
   * autoConnectSessionId 标记的竞态（它在 connect 返回后才设，而 connected 状态
   * 转换在其之前就已触发订阅）。
   */
  autoConnect?: boolean;
  /**
   * TDSF #101（2026-09-21）：这条连接的出身。
   * - `"space"`（缺省）：工作区级连接（对话框 / 开机自动 / 恢复历史对话），
   *   连接成功后可以成为工作区主会话并占用一个终端标签页。
   * - `"tab"`：#89 之后「新建标签页」为**那一个 tab**单独开的连接 —— 它的 tab
   *   由调用方自己建、自己绑。连接订阅据此不再补建 tab、也不把工作区主会话指针
   *   挪到它身上（否则两条 tab 绑同一条会话 = 用户看到的"复制了一份 shell"）。
   */
  origin?: SshSessionOrigin;
}

// === Store 定义 ==============================================================

interface SshExplorerState {
  // === 会话管理 ===
  sessions: SshSessionInfo[];
  activeSessionId: string | null;
  /**
   * #91④：待处理的主机审批请求**队列**（ssh:host_verify / ssh:host_key_mismatch 推送）。
   *
   * 原先是单例字段：第二条请求覆盖第一条，用户从没见过第一条就问什么，而那条连接
   * 正挂在 Rust 侧等回执（5 分钟超时按拒绝处理）。并发连两台新主机必然踩到。
   * 弹窗只呈现队首，应答一条出队一条。
   */
  pendingApprovals: HostApprovalRequest[];

  // === 远端 shell 的当前目录 (按会话 id 隔离) ===
  /**
   * **只有一个语义**：这个会话里那条 shell 现在在哪个目录。
   *
   * 写它的人只有两类：① 远端终端的 OSC 7（`PaneTreeView` 的 SSH leaf、
   * `App.handleTerminalCwd`）；② 连接成功后 `echo $HOME` 的探针（新 shell 起点=家目录）。
   * 左侧远程文件树**不**写这里 —— 它走 `FileExplorer` + `fsb_*`（自己按路径缓存），
   * 曾有的 `SshFileTree`/`navigateTo` 那套已在 #91② 删除（见 retired-remote-tree.test.ts）。
   * 读它的人：状态栏/窗口标题/工作区下拉的落点、agent 的远端 cwd、carapace 动态候选。
   */
  currentPathBySession: Record<string, string>;

  // === TDSF: 已保存的连接 (永久密钥 + 自动登录) ===
  /** 已保存的连接列表 (按 lastUsed 倒序, 启动时加载) */
  savedConnections: SshCredentialProfile[];
  /** 是否正在加载已保存连接 */
  savedConnectionsLoading: boolean;

  // === TDSF 2026-08-28: 远端 carapace 检测状态 (per 会话, 无弹窗设计) ===
  /** 前端会话 id → 检测状态；键不存在 = 未检测（连接成功后静默异步检测） */
  remoteCarapaceBySession: Record<string, SshRemoteCarapaceState>;

  // === Actions ===
  /**
   * TDSF 修复 2026-08-31: opts.autoConnect=true 标记开机自动连接——
   * 订阅处理器据此决定"无匹配 SSH Space"时跳过（自动）还是新建（手动）。
   */
  connect: (
    params: SshConnectParams,
    opts?: { autoConnect?: boolean; origin?: SshSessionOrigin },
  ) => Promise<string | null>;
  disconnect: (sessionId: string) => Promise<void>;
  setActiveSession: (id: string) => void;
  updateSessionStatus: (
    sessionId: string,
    event: SshStatusEvent,
  ) => void;
  /** 主机审批请求入队（同一 approvalId 重复推送只留一条） */
  pushApproval: (req: HostApprovalRequest) => void;
  resolveApproval: (approved: boolean) => Promise<void>;

  /**
   * 记录某个会话里远端 shell 的当前目录（不触发网络请求）。
   *
   * 调用方只有两类：SSH leaf 的 OSC 7 处理器，和连接成功后解析 `$HOME` 的探针。
   * 左侧远程文件树不写这里（它走 FileExplorer + fsb_*，见 retired-remote-tree.test.ts）。
   */
  setCurrentPath: (sessionId: string, path: string) => void;

  // === TDSF: 凭据持久化 actions ===
  /** 测试连接 (不保留会话)；失败时 message 是人话、raw 留原文 */
  testConnection: (params: SshConnectParams) => Promise<{
    ok: boolean;
    message: string;
    /** 失败时的 Rust 原文（tooltip / 排查用；成功时没有） */
    raw?: string;
  }>;
  /** 加载已保存的连接列表 (启动时调用) */
  loadSavedConnections: () => Promise<void>;
  /** 保存当前连接配置 (含敏感字段写入 keyring) */
  saveConnection: (
    profile: SshCredentialProfile,
    secret: string | null,
  ) => Promise<void>;
  /** 删除已保存的连接 */
  deleteSavedConnection: (id: string) => Promise<void>;
  /** 用已保存的连接配置自动登录 (从 keyring 取敏感字段后调用 connect) */
  connectWithSaved: (
    profile: SshCredentialProfile,
    opts?: { autoConnect?: boolean; origin?: SshSessionOrigin },
  ) => Promise<string | null>;

  // === TDSF 2026-08-28: 远端 carapace 检测 (无弹窗设计) ===
  /** 连接成功后静默异步检测远端 carapace（preferences 开着才检测；不阻塞、不弹 UI） */
  detectRemoteCarapace: (sessionId: string) => Promise<void>;
  /** 写入会话的检测状态（badge 显隐驱动） */
  setRemoteCarapaceState: (sessionId: string, state: SshRemoteCarapaceState) => void;

  // === TDSF: SSH 终端数据订阅 (修复黑屏) ===
  /**
   * 订阅指定会话的 PTY 输出字节流, 返回 unsubscribe 函数。
   *
   * SshTerminalPane 挂载时调用此方法, 收到字节后写入 xterm 实例。
   * 数据流不经过 zustand state, 避免高频更新触发 React rerender。
   */
  subscribeTerminalData: (
    sessionId: string,
    cb: (bytes: Uint8Array) => void,
  ) => () => void;
}

// === 辅助函数 ================================================================

/** 生成前端唯一 id (优先 crypto.randomUUID, 兜底时间戳) */
function genId(): string {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `ssh-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// === TDSF: SSH 终端数据订阅 (修复黑屏卡顿) ==============================
//
// 问题根因: 原 sshStore.connect 的 onData 是空函数, PTY 输出数据被直接丢弃,
// 导致 SSH 连接成功后终端区域一片漆黑 (无任何输出)。
//
// 修复方案: 在 module-level 维护订阅者集合 (避免 zustand state 频繁更新),
// onData 改为 fan-out 转发到所有订阅者。SshTerminalPane 组件挂载时订阅,
// 收到字节后写入 xterm 实例渲染。
//
// TDSF 2026-07-28: 新增"先到数据缓冲"机制
//   - SshTerminalPane 组件挂载前 (Rust 端 SSH 握手 + 认证 + 开 PTY 完成后),
//     onData 回调已经触发, 但前端组件还没准备好 (React 渲染前).
//   - 旧实现: 数据直接丢失, xterm.write 永远不调用, 终端一片漆黑.
//   - 新实现: 没订阅者时数据累积到 pendingBuffer, 订阅者挂载时立即 flush
//     buffer 内的所有数据. 缓冲上限 256 KiB 防止内存爆炸.
//
// 设计理由 (不放入 zustand state):
//   - PTY 输出是高频字节流 (一次 ls /etc 可能 50+ 次回调)
//   - zustand state 每次更新会触发订阅了该字段的组件 rerender
//   - 用 module-level Map + 手动订阅模式, 数据流不经过 React 渲染管线
//   - 与 xterm.write 直连, 60fps 渲染不受 React 调度影响

/** 终端数据订阅者: (bytes: Uint8Array) => void */
type TerminalSubscriber = (bytes: Uint8Array) => void;

/** module-level 订阅者存储: sessionId -> Set<subscriber> */
const terminalSubscribers = new Map<string, Set<TerminalSubscriber>>();

/** TDSF: 先到数据缓冲, sessionId -> 累积的字节数组 (每片一片) */
const pendingBuffer = new Map<string, Uint8Array[]>();

/** TDSF: 单会话缓冲上限, 防止挂死/不挂订阅时内存爆炸 */
const BUFFER_LIMIT_BYTES = 256 * 1024;

/** TDSF: 缓冲中当前会话已缓冲字节数, 用于快速判断是否超限 */
const bufferedSize = new Map<string, number>();

/**
 * TDSF 诊断 (SSH shell 黑屏排查): 记录已打过"首帧 PTY 数据"日志的会话,
 * 避免高频字节流刷屏。只在每个会话第一次收到 PTY 数据时输出一行,
 * 用于确认 Rust on_data → 前端 emitTerminalData 边界是否真的有数据流入。
 */
const firstDataLogged = new Set<string>();

/** 注册 SSH 终端数据订阅, 返回 unsubscribe 函数 */
function subscribeTerminalData(
  sessionId: string,
  cb: TerminalSubscriber,
): () => void {
  let set = terminalSubscribers.get(sessionId);
  if (!set) {
    set = new Set();
    terminalSubscribers.set(sessionId, set);
  }
  set.add(cb);

  // TDSF: 挂载时立即 flush 缓冲区的先到数据, 修复"打开终端前 SSH 已就绪
  // 导致前 N 个字节丢失"的经典竞态. 这里同步调用 cb 是 OK 的: 缓冲数据
  // 已经在内存里, 没必要再做 setTimeout(0) 异步化, 同步刷新更快更省。
  const buffered = pendingBuffer.get(sessionId);
  let flushedChunks = 0;
  if (buffered && buffered.length > 0) {
    for (const bytes of buffered) {
      try {
        cb(bytes);
        flushedChunks += 1;
      } catch (e) {
        console.warn('[sshStore] terminal subscriber flush error:', e);
      }
    }
    pendingBuffer.delete(sessionId);
    bufferedSize.delete(sessionId);
  }
  // TDSF 诊断: 确认 SshTerminalPane 挂载并以匹配的 sessionId 订阅成功
  console.info(
    `[sshStore] terminal subscribe: session=${sessionId} flushedChunks=${flushedChunks} totalSubscribers=${set.size}`,
  );

  return () => {
    const s = terminalSubscribers.get(sessionId);
    if (s) {
      s.delete(cb);
      if (s.size === 0) {
        terminalSubscribers.delete(sessionId);
      }
    }
  };
}

/** 向所有订阅者 fan-out PTY 输出字节 (供 sshStore.connect 的 onData 调用) */
function emitTerminalData(sessionId: string, bytes: Uint8Array): void {
  const set = terminalSubscribers.get(sessionId);
  // TDSF 诊断: 每会话首帧数据打一行, 确认 Rust on_data 边界真有数据流入
  if (!firstDataLogged.has(sessionId)) {
    firstDataLogged.add(sessionId);
    console.info(
      `[sshStore] first PTY data: session=${sessionId} bytes=${bytes.byteLength} subscribers=${set?.size ?? 0}`,
    );
  }
  if (!set || set.size === 0) {
    // TDSF: 没有订阅者时, 把数据先缓冲起来, 等订阅者挂载时 flush
    // 修复黑屏: SSH 握手期间 (auth -> pty_open) 触发的首批数据不再丢失
    let buf = pendingBuffer.get(sessionId);
    let cur = bufferedSize.get(sessionId) ?? 0;
    if (!buf) {
      buf = [];
      pendingBuffer.set(sessionId, buf);
    }
    // 超过上限时丢弃最早的数据, 防止异常场景下内存泄漏
    if (cur + bytes.byteLength > BUFFER_LIMIT_BYTES) {
      const overflow = cur + bytes.byteLength - BUFFER_LIMIT_BYTES;
      const newBuf: Uint8Array[] = [];
      let dropped = 0;
      for (const chunk of buf) {
        if (dropped >= overflow) {
          newBuf.push(chunk);
          continue;
        }
        if (dropped + chunk.byteLength <= overflow) {
          dropped += chunk.byteLength;
        } else {
          const remain = dropped + chunk.byteLength - overflow;
          newBuf.push(chunk.slice(remain));
          dropped = overflow;
        }
      }
      pendingBuffer.set(sessionId, newBuf);
      cur = newBuf.reduce((s, c) => s + c.byteLength, 0);
      // P2-NEW-v3-4 修复 (2026-07-30): 缓冲区溢出重建 newBuf 后,
      // 局部变量 buf 必须同步指向 newBuf, 否则下方 buf.push(bytes)
      // 会 push 到已被丢弃的旧数组 (pendingBuffer 已指向 newBuf),
      // 导致新数据 bytes 直接丢失。修复前: 溢出后新数据全丢;
      // 修复后: 新数据正确进入 newBuf。
      buf = newBuf;
    }
    buf.push(bytes);
    bufferedSize.set(sessionId, cur + bytes.byteLength);
    return;
  }
  set.forEach((cb) => {
    try {
      cb(bytes);
    } catch (e) {
      console.warn('[sshStore] terminal subscriber error:', e);
    }
  });
}

/** 清理会话所有订阅者 (在 disconnect 时调用) */
function clearTerminalSubscribers(sessionId: string): void {
  terminalSubscribers.delete(sessionId);
  // TDSF: 同步清理缓冲, 避免断开会话后残余数据被新会话错误消费
  pendingBuffer.delete(sessionId);
  bufferedSize.delete(sessionId);
  // TDSF 诊断: 清理首帧日志标记, 让重连的同 id 会话可再次记录
  firstDataLogged.delete(sessionId);
}

// === Store 实现 ==============================================================

export const useSshStore = create<SshExplorerState>((set, get) => ({
  // === 初始状态 ===
  sessions: [],
  activeSessionId: null,
  pendingApprovals: [],
  currentPathBySession: {},
  // TDSF: 凭据持久化初始状态
  savedConnections: [],
  savedConnectionsLoading: false,
  // TDSF 2026-08-28: 远端 carapace 检测状态初始（键不存在 = 未检测）
  remoteCarapaceBySession: {},

  connect: async (params, opts) => {
    const sessionId = genId();
    // TDSF 2026-08-18 (P1-9): 明文凭据不落 store——auth.password/
    // passphrase 是明文, 原实现连同完整 params 存入 zustand, 任何订阅者/
    // DevTools/__TDSF_DBG__ 均可读到密码。会话建立后下游只用 host/user/
    // port (auth 仅在 sshConnect 调用时使用一次), 此处剥离后再入库。
    const safeParams: Omit<SshConnectParams, 'auth'> = {
      host: params.host,
      port: params.port,
      user: params.user,
      cols: params.cols,
      rows: params.rows,
      term: params.term,
    };
    const session: SshSessionInfo = {
      id: sessionId,
      rustSessionId: null,
      params: safeParams,
      // TDSF: 初始状态改为 connecting, 给 UI 立即 loading 反馈
      // 原为 idle 会让用户以为没点上, 也无法触发 SshExplorer 的 SessionStatusView spinner
      state: 'connecting',
      connectedAt: Date.now(),
      handle: null,
      autoConnect: opts?.autoConnect,
      origin: opts?.origin,
    };
    set((s) => ({
      sessions: [...s.sessions, session],
      activeSessionId: sessionId,
    }));

    try {
      const handle = await sshConnect(params, {
        onData: (bytes: Uint8Array) => {
          // TDSF: 转发 PTY 输出到所有订阅者 (SshTerminalPane 组件)
          // 修复黑屏: 原 onData 是空函数, 数据被丢弃, 现在通过订阅机制 fan-out 到 xterm
          emitTerminalData(sessionId, bytes);
        },
        onStatus: (event) => {
          get().updateSessionStatus(sessionId, event);
        },
        onExit: () => {
          // TDSF: 远端 shell 退出时, 标记为 closed 并主动调用 handle.close()
          // 触发 Rust 端 SshState.take() 清理 session + SFTP 缓存, 避免资源泄漏
          const sess = get().sessions.find((s) => s.id === sessionId);
          if (sess?.handle) {
            void sess.handle.close().catch((e) => {
              console.warn('[sshStore] onExit close failed:', e);
            });
          }
          set((s) => ({
            sessions: s.sessions.map((sess) =>
              sess.id === sessionId
                ? { ...sess, state: 'closed' as SshSessionStateValue }
                : sess,
            ),
          }));
        },
      });

      // 连接成功: 记录 rustSessionId + handle, 默认打开根目录
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === sessionId
            ? { ...sess, rustSessionId: handle.id, handle }
            : sess,
        ),
      }));

      // TDSF 2026-08-31: 连接后默认落到远端家目录 (而非硬编码 "/")。
      // 用户实测: 参考软件连接后显示 /root (家目录), 本项目却进 /。
      // 解析方式: ssh_command exec 'echo $HOME'（exec 模式，不污染 PTY）。
      // 失败 (超时/非零退出/空输出) 降级 "/" —— 连接已成功, 仅起点降级。
      // 这也是**新 shell 的起点**, 所以写进"远端 shell 的 cwd"那一份即可
      // （#91② 之后这里只有一个 currentPathBySession, 不再有文件树要刷新）。
      void (async () => {
        let initial = '/';
        try {
          const sid = get().sessions.find((s) => s.id === sessionId)
            ?.rustSessionId;
          if (sid != null) {
            // 走哨兵协议：部分服务器连非交互 exec 也先吐一段欢迎横幅，
            // 直接取首行会把横幅当成路径（详见 ssh-bridge PROBE_MARK）。
            const r = await sshCommand(sid, probeCmd('echo $HOME'), 5);
            const home = r.ok && r.exitCode === 0 ? readProbeValue(r.output) : null;
            if (home?.startsWith('/')) {
              initial = home;
            }
          }
        } catch (e) {
          console.warn('[sshStore] resolve $HOME failed, fallback /:', e);
        }
        // 会话可能在解析期间已断开 —— 断开时 currentPathBySession 已清理,
        // 再写会留下孤儿键; 守卫: 仅当会话仍存在时写入。
        if (!get().sessions.some((s) => s.id === sessionId)) return;
        get().setCurrentPath(sessionId, initial);
      })().catch((e) => {
        console.warn('[sshStore] initial $HOME seed failed:', e);
      });

      // TDSF 2026-08-28: 连接成功后静默检测远端 carapace（无弹窗设计：
      // 不阻塞连接流程、不弹 Toast，结果仅写入 remoteCarapaceBySession
      // 驱动 SSH 终端角落小图标的显隐；preferences 关闭时跳过检测）
      void get().detectRemoteCarapace(sessionId);

      // TDSF 2026-08-28(二): 连接成功后静默预取远端命令全集（compgen -c），
      // 供命令模式预测过滤假候选（用户实测：词典/fuzzy 弹出远端没装的命令）。
      // 同样不阻塞、失败静默（fetchRemoteCommands 内部全捕获，不缓存失败结果）。
      // 注意不放在 detectRemoteCarapace 里——那个受 preferences 开关控制，
      // 而命令全集过滤是预测核心功能，与 badge 提示开关无关。
      const rustSessionId = get().sessions.find((s) => s.id === sessionId)
        ?.rustSessionId;
      if (rustSessionId) {
        void fetchRemoteCommands(rustSessionId);
        void fetchRemoteOsInfo(rustSessionId).then((remoteOsInfo) => {
          if (!remoteOsInfo) return;
          const current = get().sessions.find((sess) => sess.id === sessionId);
          if (current?.rustSessionId !== rustSessionId) return;
          set((s) => ({
            sessions: s.sessions.map((sess) =>
              sess.id === sessionId && sess.rustSessionId === rustSessionId
                ? { ...sess, remoteOsInfo }
                : sess,
            ),
          }));
        });
      }

      return sessionId;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set((s) => ({
        sessions: s.sessions.map((sess) =>
          sess.id === sessionId
            ? { ...sess, state: 'failed' as SshSessionStateValue, error: msg }
            : sess,
        ),
      }));
      // TDSF: 弹 toast 让用户立即知晓失败原因 (而不只是在会话标签上显示 failed 状态)
      // 配合 ssh-bridge 的 dev mode 检测和 15s 超时, 用户能清楚知道为什么连不上。
      // #110：russh 的 Debug 结构体（`Failure { remaining_methods: MethodSet(...) }`）
      // 用户读不出该做什么 —— 认得出的形状翻成人话 + 指真实入口，认不出的原样保留。
      // 原文仍留在 session.error 里（状态点 tooltip / 排查用）。
      const copy = describeSshFailure(msg);
      toast.error(copy.headline, { description: copy.description });
      return null;
    }
  },

  disconnect: async (sessionId) => {
    const session = get().sessions.find((s) => s.id === sessionId);
    // TDSF 2026-08-18 (P1-7): 无 handle 的会话（连接失败/未完成）也
    // 能清理——原实现 `if (!session?.handle) return` 导致 failed 会话永久
    // 残留 sessions 数组, 用户无法通过断开按钮移除, 只能重启应用。
    if (!session) return;
    if (session.handle) {
      try {
        await session.handle.close();
      } catch (e) {
        console.warn('[sshStore] disconnect failed:', e);
      }
    }
    // TDSF: 清理终端数据订阅者, 避免已断开会话的回调泄漏
    clearTerminalSubscribers(sessionId);
    set((s) => ({
      sessions: s.sessions.filter((sess) => sess.id !== sessionId),
      activeSessionId:
        s.activeSessionId === sessionId
          ? (s.sessions.find((x) => x.id !== sessionId)?.id ?? null)
          : s.activeSessionId,
      // TDSF: 完整清理会话相关状态, 避免残留影响重连或新会话
      currentPathBySession: omitSessionKey(s.currentPathBySession, sessionId),
      // TDSF 2026-08-28: 远端 carapace 检测状态也按会话清理
      remoteCarapaceBySession: omitSessionKey(s.remoteCarapaceBySession, sessionId),
    }));
  },

  setActiveSession: (id) => set({ activeSessionId: id }),

  updateSessionStatus: (sessionId, event) => {
    set((s) => ({
      sessions: s.sessions.map((sess) =>
        sess.id === sessionId
          ? { ...sess, state: event.state, error: event.error }
          : sess,
      ),
    }));
  },

  pushApproval: (req) => {
    set((s) =>
      s.pendingApprovals.some((r) => r.approvalId === req.approvalId)
        ? {}
        : { pendingApprovals: [...s.pendingApprovals, req] },
    );
  },

  resolveApproval: async (approved) => {
    const head = get().pendingApprovals[0];
    if (!head) return;
    try {
      const { sshApproveHost } = await import('@/lib/ssh-bridge');
      await sshApproveHost(head.approvalId, approved);
    } catch (e) {
      console.warn('[sshStore] approve host failed:', e);
    } finally {
      // 按 id 出队（不是 shift）：await 期间可能有新请求入队，
      // 而后端对已失效的 approval_id 回 Err —— 也必须出队，否则整条
      // 审批链永远卡在一个答不上的队首上。
      set((s) => ({
        pendingApprovals: s.pendingApprovals.filter(
          (r) => r.approvalId !== head.approvalId,
        ),
      }));
    }
  },

  setCurrentPath: (sessionId, path) => {
    const log = getOsc7Log();
    log?.push({ source: "sshStore.setCurrentPath", sessionId, path });
    set((s) => ({
      currentPathBySession: { ...s.currentPathBySession, [sessionId]: path },
    }));
  },

  // === TDSF: 凭据持久化 actions ===

  /**
   * 测试连接 (不保留会话)
   *
   * 调用 Rust ssh_test 命令, 成功后立即断开。
   * 用于「新建工作区 → SSH 服务器」表单里的"测试连接"按钮。
   *
   * #111：失败原因在这里统一翻成人话（`describeSshFailureText`），两个调用方都受益 ——
   * Rust 回的是 russh 的 Debug 结构体，用户读不出该做什么。原文放 `raw`，界面拿它做 tooltip。
   */
  testConnection: async (params) => {
    try {
      const r = await sshTest(params);
      if (r.ok) return r;
      return { ok: false, message: describeSshFailureText(r.message), raw: r.message };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, message: describeSshFailureText(msg), raw: msg };
    }
  },

  /**
   * 加载已保存的连接列表
   *
   * 启动时 SshExplorer 调用, 从 JSON 文件读取所有 profile (按 lastUsed 倒序)。
   * 失败时清空列表 + toast 提示, 不阻塞 UI。
   */
  loadSavedConnections: async () => {
    set({ savedConnectionsLoading: true });
    try {
      const list = await sshCredentialsList();
      set({ savedConnections: list, savedConnectionsLoading: false });
    } catch (e) {
      console.warn('[sshStore] loadSavedConnections failed:', e);
      set({ savedConnections: [], savedConnectionsLoading: false });
    }
  },

  /**
   * 保存连接配置 (含敏感字段写入 keyring)
   *
   * 流程:
   *   1. sshCredentialsSave: 写 keyring (敏感字段) + JSON (元数据)
   *   2. 重新加载列表, 让 UI 立即看到新保存的连接
   *
   * @param profile 连接元数据
   * @param secret  敏感字段 (password / passphrase), publickey 无口令时传 null
   */
  saveConnection: async (profile, secret) => {
    await sshCredentialsSave(profile, secret);
    await get().loadSavedConnections();
    toast.success('连接已永久保存', {
      description: `${profile.alias} · 下次启动可自动登录`,
    });
  },

  /**
   * 删除已保存的连接
   *
   * 同时清理 JSON 元数据 + keyring 敏感字段。
   * 删除后重新加载列表, 让 UI 立即更新。
   */
  deleteSavedConnection: async (id) => {
    await sshCredentialsDelete(id);
    await get().loadSavedConnections();
    toast.success('已删除保存的连接');
  },

  /**
   * 用已保存的连接配置自动登录
   *
   * 流程:
   *   1. 从 keyring 取敏感字段 (password / passphrase)
   *   2. 组装完整 SshConnectParams
   *   3. 调用 connect() 发起连接
   *   4. 连接成功后更新 lastUsed 时间戳
   *
   * 用于:
   *   - 启动时自动登录 (SshExplorer 加载列表后自动调用此方法)
   *   - 用户点击已保存连接列表项一键登录
   *
   * @returns 成功时返回 sessionId, 失败返回 null (并 toast 提示)
   */
  connectWithSaved: async (profile, opts) => {
    try {
      // 1. 从 keyring 取敏感字段
      const secret = await sshCredentialsGetSecret(profile.id);

      // 2. 组装完整 SshConnectParams
      let auth: SshConnectParams['auth'];
      if (profile.auth.type === 'password') {
        if (secret === null) {
          throw new Error('keyring 中未找到密码, 请重新保存凭据');
        }
        auth = { type: 'password', password: secret };
      } else {
        // publickey
        auth = {
          type: 'publickey',
          privateKeyPath: profile.auth.privateKeyPath,
          passphrase: secret ?? undefined,
        };
      }

      const params: SshConnectParams = {
        host: profile.host,
        port: profile.port,
        user: profile.user,
        auth,
        cols: 80,
        rows: 24,
        term: 'xterm-256color',
      };

      // 3. 调用 connect（透传 autoConnect 标记，订阅处理器据此决定
      //    "无匹配 SSH Space"时跳过（开机自动）还是新建（对话框手动））
      const sessionId = await get().connect(params, {
        autoConnect: opts?.autoConnect,
        origin: opts?.origin,
      });

      // 4. 连接成功后更新 lastUsed
      if (sessionId) {
        void sshCredentialsTouch(profile.id).catch((e) => {
          console.warn('[sshStore] touch lastUsed failed:', e);
        });
        // 重新加载列表 (lastUsed 排序变化)
        void get().loadSavedConnections();
      }

      return sessionId;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[sshStore] connectWithSaved failed:', msg);
      toast.error('自动登录失败', { description: msg });
      return null;
    }
  },

  // === TDSF 2026-08-28: 远端 carapace 静默检测（无弹窗设计） ====================

  setRemoteCarapaceState: (sessionId, state) => {
    set((s) => ({
      remoteCarapaceBySession: { ...s.remoteCarapaceBySession, [sessionId]: state },
    }));
  },

  detectRemoteCarapace: async (sessionId) => {
    // preferences 开关关闭 → 不检测（状态保持"未检测"，badge 永不显示）。
    // 动态 import settings 模块：避免 ssh-explorer → settings 的顶层模块环，
    // 且检测本身是惰性场景（首次 SSH 连接才需要）。
    try {
      const { usePreferencesStore } = await import('@/modules/settings/preferences');
      if (!usePreferencesStore.getState().sshRemoteCarapacePrompt) return;
    } catch (e) {
      console.warn('[sshStore] read carapace prompt preference failed:', e);
    }
    // 已有结果（checking/installed/missing）→ 不重复检测
    if (get().remoteCarapaceBySession[sessionId]) return;
    const sess = get().sessions.find((s) => s.id === sessionId);
    if (!sess?.rustSessionId) return;
    get().setRemoteCarapaceState(sessionId, 'checking');
    // remoteCarapaceInstalled 自带会话级缓存 + 失败静默（返回 false）
    const installed = await remoteCarapaceInstalled(sess.rustSessionId);
    // 检测期间会话可能已断开（disconnect 清空了状态）→ 不复活旧会话的状态
    if (!get().sessions.some((s) => s.id === sessionId)) return;
    get().setRemoteCarapaceState(sessionId, installed ? 'installed' : 'missing');
  },

  // === TDSF: SSH 终端数据订阅 (修复黑屏) ===
  // 暴露 module-level subscribeTerminalData 给组件使用
  subscribeTerminalData: (sessionId, cb) => subscribeTerminalData(sessionId, cb),
}));

// === 辅助选择器 (供组件使用) ==================================================

/** 获取当前活跃会话 */
export function selectActiveSession(state: SshExplorerState): SshSessionInfo | null {
  return (
    state.sessions.find((s) => s.id === state.activeSessionId) ?? null
  );
}

/** 判断会话是否已连接 (state === 'connected') */
export function isSessionConnected(state: SshSessionInfo): boolean {
  return state.state === 'connected' && state.rustSessionId !== null;
}

/**
 * "连接正在建立"的状态集合（含断线自动重连）。
 *
 * 收口前这份清单抄在两处：App.tsx 用它决定终端区显示连接进度还是空状态页，
 * #102 的离线面板要用同一个口径判断"这台服务器正在重连"。口径分开写就会漂,
 * 所以只留这一个主人。
 */
const SSH_CONNECTING_STATES: ReadonlySet<SshSessionStateValue> = new Set([
  'connecting',
  'handshaking',
  'host_verifying',
  'authenticating',
  'authenticated',
  'reconnecting',
]);

/** 判断会话是否处于"正在建立连接"（既不是已连上, 也不是死掉） */
export function isSessionConnecting(session: SshSessionInfo): boolean {
  return SSH_CONNECTING_STATES.has(session.state);
}

/** 按 id 获取会话 (不存在时返回 null) */
export function selectSessionById(
  state: SshExplorerState,
  id: string | null | undefined,
): SshSessionInfo | null {
  if (!id) return null;
  return state.sessions.find((s) => s.id === id) ?? null;
}

/** 按 id 获取会话的远程当前目录 */
export function selectSessionCurrentPath(
  state: SshExplorerState,
  id: string | null | undefined,
): string | null {
  if (!id) return null;
  return state.currentPathBySession[id] ?? null;
}
