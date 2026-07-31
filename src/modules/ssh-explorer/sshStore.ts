// TDSF 魔改 (P4-T4.1): SSH 远程资源管理器 Zustand store
// -----------------------------------------------------------------------------
// 管理 SSH 会话列表 + 远程文件树状态 + 远程文件编辑器状态 + TOFU 主机审批
//
// 设计要点:
//   - 每个会话有前端 id (crypto.randomUUID) + Rust sessionId (ssh_connect 返回)
//   - 文件树状态按前端 id 隔离 (currentPath / entries / loading / expandedPaths)
//   - 编辑器一次只编辑一个文件 (editingFile), 与 SshFileEditor 组件配合
//   - 主机审批请求 (pendingApproval) 由 ssh:host_verify 事件推送, 弹窗询问用户
import { create } from 'zustand';
import { toast } from 'sonner';
import {
  sshConnect,
  sshCredentialsDelete,
  sshCredentialsGetSecret,
  sshCredentialsList,
  sshCredentialsSave,
  sshCredentialsTouch,
  sshTest,
  type SshConnectParams,
  type SshCredentialProfile,
  type SshSession,
  type SshSessionStateValue,
  type SshStatusEvent,
  type HostApprovalRequest,
} from '@/lib/ssh-bridge';
import {
  sftpList,
  sftpRead,
  sftpWrite,
  sftpMkdir,
  sftpRemove,
  sftpRename,
  decodeUtf8,
  encodeUtf8,
  type SftpEntry,
  joinRemotePath,
} from '@/lib/sftp-bridge';

// === 类型定义 ================================================================

/** SSH 会话信息 (前端管理) */
export interface SshSessionInfo {
  /** 前端唯一 id (crypto.randomUUID) */
  id: string;
  /** Rust 端分配的 session_id (ssh_connect 成功后填充) */
  rustSessionId: number | null;
  /** 连接参数 (host/port/user/auth, 用于重连) */
  params: SshConnectParams;
  /** 当前状态 (与 Rust SshSessionState 对齐, snake_case) */
  state: SshSessionStateValue;
  /** 错误信息 (Failed 状态时填充) */
  error?: string;
  /** 连接时间戳 (Unix 毫秒) */
  connectedAt: number;
  /** SshSession 句柄 (含 write/resize/close) */
  handle: SshSession | null;
}

/** 远程文件编辑状态 */
export interface SshEditingFile {
  /** 远程文件完整路径 */
  path: string;
  /** 文件名 (路径最后一段) */
  name: string;
  /** 文件内容 (UTF-8 文本) */
  content: string;
  /** 原始内容 (用于 dirty 判断) */
  originalContent: string;
  /** 关联的会话前端 id */
  sessionId: string;
  /** 是否已修改 (content !== originalContent) */
  dirty: boolean;
  /** 是否正在保存 */
  saving: boolean;
  /** 是否加载中 (读取远程文件) */
  loading: boolean;
}

/** 单次文件传输任务 (上传/下载) */
export interface SshTransferTask {
  id: string;
  /** 关联会话前端 id */
  sessionId: string;
  /** 方向 */
  direction: 'upload' | 'download';
  /** 远程路径 */
  remotePath: string;
  /** 本地路径 (上传时源, 下载时目标) */
  localPath: string;
  /** 已传输字节 */
  transferred: number;
  /** 总字节 (未知为 null) */
  total: number | null;
  /** 状态 */
  status: 'pending' | 'transferring' | 'done' | 'error';
  error?: string;
}

// === Store 定义 ==============================================================

interface SshExplorerState {
  // === 会话管理 ===
  sessions: SshSessionInfo[];
  activeSessionId: string | null;
  /** 待处理的主机审批请求 (ssh:host_verify 事件推送) */
  pendingApproval: HostApprovalRequest | null;

  // === 文件树状态 (按会话 id 隔离) ===
  /** 每个会话的当前目录路径 (用于 SSH 终端默认 cwd / "返回上一级" 面包屑) */
  currentPathBySession: Record<string, string>;
  /** 每个会话当前目录的条目列表 (即 currentPath 下的直接子条目) */
  entriesBySession: Record<string, SftpEntry[]>;
  /** 每个会话的当前目录加载状态 */
  loadingBySession: Record<string, boolean>;
  /**
   * 每个会话已展开的目录子树缓存: sessionId -> { path -> entries }。
   *
   * TDSF 魔改 2026-07-29: 让 SshFileTree 跟本地 FileExplorer 一样支持可展开
   * 树形结构, 用户点开哪个目录就 lazy load 哪个目录的子条目, 不再只能
   * 用面包屑逐级 navigate。entriesBySession 只保留"当前 cwd"一份, 这里
   * 缓存所有已展开过的子树, 切换活跃目录/会话时不会重新拉取。
   */
  childrenByPathBySession: Record<string, Record<string, SftpEntry[]>>;
  /** 每个会话每个展开目录的子条目加载状态: sessionId -> { path -> boolean } */
  loadingChildrenByPathBySession: Record<string, Record<string, boolean>>;
  /** 每个会话展开的目录路径集合 */
  expandedPathsBySession: Record<string, Set<string>>;
  /** 选中的文件路径 (单选, 用于高亮) */
  selectedPath: string | null;

  // === 编辑器状态 ===
  editingFile: SshEditingFile | null;

  // === 文件传输任务 ===
  transferTasks: SshTransferTask[];

  // === 连接对话框 ===
  connectDialogOpen: boolean;

  // === TDSF 魔改: 已保存的连接 (永久密钥 + 自动登录) ===
  /** 已保存的连接列表 (按 lastUsed 倒序, 启动时加载) */
  savedConnections: SshCredentialProfile[];
  /** 是否正在加载已保存连接 */
  savedConnectionsLoading: boolean;
  /** 自动登录的会话 id (启动时尝试自动连接 lastUsed 最近的那个) */
  autoConnectSessionId: string | null;

  // === Actions ===
  openConnectDialog: () => void;
  closeConnectDialog: () => void;
  connect: (params: SshConnectParams) => Promise<string | null>;
  disconnect: (sessionId: string) => Promise<void>;
  setActiveSession: (id: string) => void;
  updateSessionStatus: (
    sessionId: string,
    event: SshStatusEvent,
  ) => void;
  resolveApproval: (approved: boolean) => Promise<void>;

  // 文件树 actions
  listDir: (sessionId: string, path: string) => Promise<void>;
  navigateTo: (sessionId: string, path: string) => Promise<void>;
  /**
   * 切换目录的展开/折叠状态。
   *
   * TDSF 魔改 2026-07-29: 第一次展开时触发 loadChildren lazy 加载该目录
   * 的子条目, 跟本地 FileExplorer 的 toggle 行为一致。
   * 已展开则折叠并保留缓存 (下次展开不再请求后端)。
   */
  toggleExpand: (sessionId: string, path: string) => void;
  /**
   * 加载指定目录的子条目 (用于 SshFileTree 树形展开时 lazy 加载)。
   * 如果已缓存则直接复用, 不重复请求后端。
   */
  loadChildren: (sessionId: string, path: string) => Promise<void>;
  selectPath: (path: string | null) => void;
  refreshCurrent: (sessionId: string) => Promise<void>;
  /**
   * 创建远程文件。
   *
   * TDSF 魔改 2026-07-29: 为统一文件资源管理器补齐 CRUD, 行为与本地
   * FileExplorer 一致。成功后会刷新父目录缓存。
   */
  createFile: (sessionId: string, parentPath: string, name: string) => Promise<void>;
  /**
   * 创建远程目录。
   */
  createDir: (sessionId: string, parentPath: string, name: string) => Promise<void>;
  /**
   * 重命名远程文件/目录。
   */
  renamePath: (sessionId: string, from: string, to: string) => Promise<void>;
  /**
   * 删除远程文件/目录。
   *
   * 目录删除目前只支持空目录 (Rust sftp_remove_dir 未暴露), 非空会报错。
   */
  deletePath: (sessionId: string, path: string, isDir: boolean) => Promise<void>;

  // 编辑器 actions
  openFile: (sessionId: string, path: string, name: string) => Promise<void>;
  saveFile: () => Promise<void>;
  closeEditor: () => void;
  updateEditorContent: (content: string) => void;

  // 传输任务 actions
  removeTransferTask: (id: string) => void;

  // === TDSF 魔改: 凭据持久化 actions ===
  /** 测试连接 (不保留会话) */
  testConnection: (params: SshConnectParams) => Promise<{ ok: boolean; message: string }>;
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
  connectWithSaved: (profile: SshCredentialProfile) => Promise<string | null>;

  // === TDSF 魔改: SSH 终端数据订阅 (修复黑屏) ===
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

// === TDSF 魔改: SSH 终端数据订阅 (修复黑屏卡顿) ==============================
//
// 问题根因: 原 sshStore.connect 的 onData 是空函数, PTY 输出数据被直接丢弃,
// 导致 SSH 连接成功后终端区域一片漆黑 (无任何输出)。
//
// 修复方案: 在 module-level 维护订阅者集合 (避免 zustand state 频繁更新),
// onData 改为 fan-out 转发到所有订阅者。SshTerminalPane 组件挂载时订阅,
// 收到字节后写入 xterm 实例渲染。
//
// TDSF 魔改 2026-07-28: 新增"先到数据缓冲"机制
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

/** TDSF 魔改: 先到数据缓冲, sessionId -> 累积的字节数组 (每片一片) */
const pendingBuffer = new Map<string, Uint8Array[]>();

/** TDSF 魔改: 单会话缓冲上限, 防止挂死/不挂订阅时内存爆炸 */
const BUFFER_LIMIT_BYTES = 256 * 1024;

/** TDSF 魔改: 缓冲中当前会话已缓冲字节数, 用于快速判断是否超限 */
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

  // TDSF 魔改: 挂载时立即 flush 缓冲区的先到数据, 修复"打开终端前 SSH 已就绪
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
    // TDSF 魔改: 没有订阅者时, 把数据先缓冲起来, 等订阅者挂载时 flush
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
  // TDSF 魔改: 同步清理缓冲, 避免断开会话后残余数据被新会话错误消费
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
  pendingApproval: null,
  currentPathBySession: {},
  entriesBySession: {},
  loadingBySession: {},
  // TDSF 魔改 2026-07-29: 树形展开所需的子树缓存与加载状态
  childrenByPathBySession: {},
  loadingChildrenByPathBySession: {},
  expandedPathsBySession: {},
  selectedPath: null,
  editingFile: null,
  transferTasks: [],
  connectDialogOpen: false,
  // TDSF 魔改: 凭据持久化初始状态
  savedConnections: [],
  savedConnectionsLoading: false,
  autoConnectSessionId: null,

  // === Actions ===
  openConnectDialog: () => set({ connectDialogOpen: true }),
  closeConnectDialog: () => set({ connectDialogOpen: false }),

  connect: async (params) => {
    const sessionId = genId();
    const session: SshSessionInfo = {
      id: sessionId,
      rustSessionId: null,
      params,
      // TDSF 魔改: 初始状态改为 connecting, 给 UI 立即 loading 反馈
      // 原为 idle 会让用户以为没点上, 也无法触发 SshExplorer 的 SessionStatusView spinner
      state: 'connecting',
      connectedAt: Date.now(),
      handle: null,
    };
    set((s) => ({
      sessions: [...s.sessions, session],
      activeSessionId: sessionId,
      connectDialogOpen: false,
    }));

    try {
      const handle = await sshConnect(params, {
        onData: (bytes: Uint8Array) => {
          // TDSF 魔改: 转发 PTY 输出到所有订阅者 (SshTerminalPane 组件)
          // 修复黑屏: 原 onData 是空函数, 数据被丢弃, 现在通过订阅机制 fan-out 到 xterm
          emitTerminalData(sessionId, bytes);
        },
        onStatus: (event) => {
          get().updateSessionStatus(sessionId, event);
        },
        onExit: () => {
          // TDSF 魔改: 远端 shell 退出时, 标记为 closed 并主动调用 handle.close()
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

      // TDSF 魔改: 默认列出根目录, 但失败不影响连接状态 (连接已成功, 仅文件树加载失败)
      // 用户可手动刷新或切换目录, 不应因 SFTP 列目录失败而回滚已建立的 SSH 连接
      // 默认列出用户 home 目录 (Linux 服务器通常 ~ 解析为 /home/user)
      // 用 "/" 作为起点更通用, 用户可导航到 /home/user
      void get().navigateTo(sessionId, '/').catch((e) => {
        console.warn('[sshStore] initial navigateTo failed:', e);
      });
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
      // TDSF 魔改: 弹 toast 让用户立即知晓失败原因 (而不只是在会话标签上显示 failed 状态)
      // 配合 ssh-bridge 的 dev mode 检测和 15s 超时, 用户能清楚知道为什么连不上
      toast.error('SSH 连接失败', { description: msg });
      return null;
    }
  },

  disconnect: async (sessionId) => {
    const session = get().sessions.find((s) => s.id === sessionId);
    if (!session?.handle) return;
    const wasActive = get().activeSessionId === sessionId;
    try {
      await session.handle.close();
    } catch (e) {
      console.warn('[sshStore] disconnect failed:', e);
    }
    // TDSF 魔改: 清理终端数据订阅者, 避免已断开会话的回调泄漏
    clearTerminalSubscribers(sessionId);
    set((s) => ({
      sessions: s.sessions.filter((sess) => sess.id !== sessionId),
      activeSessionId:
        s.activeSessionId === sessionId
          ? (s.sessions.find((x) => x.id !== sessionId)?.id ?? null)
          : s.activeSessionId,
      // TDSF 魔改: 完整清理会话相关状态, 避免残留影响重连或新会话
      // 清理文件树状态
      currentPathBySession: Object.fromEntries(
        Object.entries(s.currentPathBySession).filter(
          ([k]) => k !== sessionId,
        ),
      ),
      entriesBySession: Object.fromEntries(
        Object.entries(s.entriesBySession).filter(([k]) => k !== sessionId),
      ),
      loadingBySession: Object.fromEntries(
        Object.entries(s.loadingBySession).filter(([k]) => k !== sessionId),
      ),
      expandedPathsBySession: Object.fromEntries(
        Object.entries(s.expandedPathsBySession).filter(
          ([k]) => k !== sessionId,
        ),
      ),
      // TDSF 魔改 2026-07-29: 树形展开所需的子树缓存也按会话清理
      childrenByPathBySession: Object.fromEntries(
        Object.entries(s.childrenByPathBySession).filter(
          ([k]) => k !== sessionId,
        ),
      ),
      loadingChildrenByPathBySession: Object.fromEntries(
        Object.entries(s.loadingChildrenByPathBySession).filter(
          ([k]) => k !== sessionId,
        ),
      ),
      // 清理传输任务 (会话已断开, 任务不再有意义)
      transferTasks: s.transferTasks.filter((t) => t.sessionId !== sessionId),
      // 清理选中状态: 断开的是活跃会话时, selectedPath 必然属于该会话, 应清空
      selectedPath: wasActive ? null : s.selectedPath,
      editingFile:
        s.editingFile?.sessionId === sessionId ? null : s.editingFile,
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

  resolveApproval: async (approved) => {
    const { pendingApproval } = get();
    if (!pendingApproval) return;
    try {
      const { sshApproveHost } = await import('@/lib/ssh-bridge');
      await sshApproveHost(pendingApproval.approvalId, approved);
    } catch (e) {
      console.warn('[sshStore] approve host failed:', e);
    } finally {
      set({ pendingApproval: null });
    }
  },

  // === 文件树 actions ===
  listDir: async (sessionId, path) => {
    const session = get().sessions.find((s) => s.id === sessionId);
    if (!session?.rustSessionId) return;

    set((s) => ({
      loadingBySession: { ...s.loadingBySession, [sessionId]: true },
    }));

    try {
      const entries = await sftpList(session.rustSessionId, path);
      set((s) => ({
        entriesBySession: { ...s.entriesBySession, [sessionId]: entries },
        // TDSF 魔改 2026-07-29: 同步把"当前 cwd"也写入子树缓存,
        // 这样 SshFileTree 用统一的 childrenByPathBySession 渲染, 不再
        // 区分"当前目录 vs 已展开子目录", 跟本地 FileExplorer 行为一致.
        childrenByPathBySession: {
          ...s.childrenByPathBySession,
          [sessionId]: {
            ...(s.childrenByPathBySession[sessionId] ?? {}),
            [path]: entries,
          },
        },
        loadingBySession: { ...s.loadingBySession, [sessionId]: false },
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[sshStore] listDir failed:', path, msg);
      set((s) => ({
        loadingBySession: { ...s.loadingBySession, [sessionId]: false },
      }));
      throw e;
    }
  },

  navigateTo: async (sessionId, path) => {
    set((s) => ({
      currentPathBySession: { ...s.currentPathBySession, [sessionId]: path },
    }));
    await get().listDir(sessionId, path);
  },

  /**
   * 加载指定目录的子条目 (lazy, 树形展开时调用).
   *
   * 已缓存则直接复用, 避免重复请求后端。
   * TDSF 魔改 2026-07-29: 与本地 useFileTree.fetchChildren 行为对齐。
   */
  loadChildren: async (sessionId, path) => {
    const session = get().sessions.find((s) => s.id === sessionId);
    if (!session?.rustSessionId) return;

    const cache = get().childrenByPathBySession[sessionId] ?? {};
    // 已缓存: 跳过网络请求, 复用本地数据
    if (cache[path]) return;

    set((s) => ({
      loadingChildrenByPathBySession: {
        ...s.loadingChildrenByPathBySession,
        [sessionId]: {
          ...(s.loadingChildrenByPathBySession[sessionId] ?? {}),
          [path]: true,
        },
      },
    }));

    try {
      const entries = await sftpList(session.rustSessionId, path);
      set((s) => ({
        childrenByPathBySession: {
          ...s.childrenByPathBySession,
          [sessionId]: {
            ...(s.childrenByPathBySession[sessionId] ?? {}),
            [path]: entries,
          },
        },
        loadingChildrenByPathBySession: {
          ...s.loadingChildrenByPathBySession,
          [sessionId]: {
            ...(s.loadingChildrenByPathBySession[sessionId] ?? {}),
            [path]: false,
          },
        },
      }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[sshStore] loadChildren failed:', path, msg);
      set((s) => ({
        loadingChildrenByPathBySession: {
          ...s.loadingChildrenByPathBySession,
          [sessionId]: {
            ...(s.loadingChildrenByPathBySession[sessionId] ?? {}),
            [path]: false,
          },
        },
      }));
      // 加载失败不抛出, 保持 UI 稳定; 用户可点重试或刷新
    }
  },

  /**
   * 切换目录展开/折叠。
   *
   * TDSF 魔改 2026-07-29: 第一次展开时触发 loadChildren, 跟本地
   * FileExplorer 的 toggle 行为一致。已展开则折叠 (保留缓存)。
   */
  toggleExpand: (sessionId, path) => {
    const current = get().expandedPathsBySession[sessionId] ?? new Set<string>();
    const wasExpanded = current.has(path);
    const next = new Set(current);
    if (wasExpanded) {
      next.delete(path);
    } else {
      next.add(path);
    }
    set({
      expandedPathsBySession: {
        ...get().expandedPathsBySession,
        [sessionId]: next,
      },
    });
    // 展开时: 第一次没缓存则 lazy 加载
    if (!wasExpanded) {
      void get().loadChildren(sessionId, path);
    }
  },

  selectPath: (path) => set({ selectedPath: path }),

  refreshCurrent: async (sessionId) => {
    const path = get().currentPathBySession[sessionId];
    if (path) await get().listDir(sessionId, path);
  },

  /**
   * 创建远程文件 (空文件)。
   *
   * TDSF 魔改 2026-07-29: 用 sftp_write 写入空内容来创建文件, 成功后
   * 刷新父目录缓存, 让 FileExplorer 等 UI 立即看到新文件。
   */
  createFile: async (sessionId, parentPath, name) => {
    const session = get().sessions.find((s) => s.id === sessionId);
    if (!session?.rustSessionId) {
      throw new Error('SSH 会话未连接, 无法创建文件');
    }
    const path = joinRemotePath(parentPath, name);
    try {
      await sftpWrite(session.rustSessionId, path, encodeUtf8(''));
      // 刷新父目录: 先清缓存再重新加载
      set((s) => ({
        childrenByPathBySession: {
          ...s.childrenByPathBySession,
          [sessionId]: {
            ...(s.childrenByPathBySession[sessionId] ?? {}),
            [parentPath]: [], // 占位, 下面 loadChildren 会重新填充
          },
        },
      }));
      await get().loadChildren(sessionId, parentPath);
      // 同时刷新当前 cwd (如果父路径就是 cwd)
      if (get().currentPathBySession[sessionId] === parentPath) {
        await get().listDir(sessionId, parentPath);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[sshStore] createFile failed:', path, msg);
      toast.error('创建文件失败', { description: msg });
      throw e;
    }
  },

  /**
   * 创建远程目录。
   */
  createDir: async (sessionId, parentPath, name) => {
    const session = get().sessions.find((s) => s.id === sessionId);
    if (!session?.rustSessionId) {
      throw new Error('SSH 会话未连接, 无法创建目录');
    }
    const path = joinRemotePath(parentPath, name);
    try {
      await sftpMkdir(session.rustSessionId, path);
      set((s) => ({
        childrenByPathBySession: {
          ...s.childrenByPathBySession,
          [sessionId]: {
            ...(s.childrenByPathBySession[sessionId] ?? {}),
            [parentPath]: [],
          },
        },
      }));
      await get().loadChildren(sessionId, parentPath);
      if (get().currentPathBySession[sessionId] === parentPath) {
        await get().listDir(sessionId, parentPath);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[sshStore] createDir failed:', path, msg);
      toast.error('创建目录失败', { description: msg });
      throw e;
    }
  },

  /**
   * 重命名远程文件/目录。
   */
  renamePath: async (sessionId, from, to) => {
    const session = get().sessions.find((s) => s.id === sessionId);
    if (!session?.rustSessionId) {
      throw new Error('SSH 会话未连接, 无法重命名');
    }
    const fromParent = from.slice(0, from.lastIndexOf('/') || 1);
    const toParent = to.slice(0, to.lastIndexOf('/') || 1);
    try {
      await sftpRename(session.rustSessionId, from, to);
      // 刷新涉及的父目录
      const refreshParents = [fromParent];
      if (toParent !== fromParent) refreshParents.push(toParent);
      for (const p of refreshParents) {
        set((s) => ({
          childrenByPathBySession: {
            ...s.childrenByPathBySession,
            [sessionId]: {
              ...(s.childrenByPathBySession[sessionId] ?? {}),
              [p]: [],
            },
          },
        }));
        await get().loadChildren(sessionId, p);
        if (get().currentPathBySession[sessionId] === p) {
          await get().listDir(sessionId, p);
        }
      }
      // 如果被重命名的是已展开目录, 需要折叠它 (路径失效)
      const expanded = get().expandedPathsBySession[sessionId] ?? new Set<string>();
      if (expanded.has(from)) {
        const next = new Set(expanded);
        next.delete(from);
        set((s) => ({
          expandedPathsBySession: {
            ...s.expandedPathsBySession,
            [sessionId]: next,
          },
        }));
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[sshStore] renamePath failed:', from, '->', to, msg);
      toast.error('重命名失败', { description: msg });
      throw e;
    }
  },

  /**
   * 删除远程文件/目录。
   *
   * 目录删除: 当前 Rust 端只暴露了 sftp_remove, 它通常只能删除空目录。
   * 非空目录会报错, 用户需先清空目录再删除。
   */
  deletePath: async (sessionId, path, _isDir) => {
    const session = get().sessions.find((s) => s.id === sessionId);
    if (!session?.rustSessionId) {
      throw new Error('SSH 会话未连接, 无法删除');
    }
    const parent = path.slice(0, path.lastIndexOf('/') || 1);
    try {
      await sftpRemove(session.rustSessionId, path);
      // 清理相关缓存
      set((s) => ({
        childrenByPathBySession: {
          ...s.childrenByPathBySession,
          [sessionId]: {
            ...(s.childrenByPathBySession[sessionId] ?? {}),
            [parent]: [],
            [path]: [],
          },
        },
      }));
      await get().loadChildren(sessionId, parent);
      if (get().currentPathBySession[sessionId] === parent) {
        await get().listDir(sessionId, parent);
      }
      // 如果删除的是已展开目录, 清理展开状态
      const expanded = get().expandedPathsBySession[sessionId] ?? new Set<string>();
      if (expanded.has(path)) {
        const next = new Set(expanded);
        next.delete(path);
        set((s) => ({
          expandedPathsBySession: {
            ...s.expandedPathsBySession,
            [sessionId]: next,
          },
        }));
      }
      // 如果当前选中的是被删除路径, 清空选中
      if (get().selectedPath === path) {
        set({ selectedPath: null });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[sshStore] deletePath failed:', path, msg);
      toast.error('删除失败', { description: msg });
      throw e;
    }
  },

  // === 编辑器 actions ===
  openFile: async (sessionId, path, name) => {
    const session = get().sessions.find((s) => s.id === sessionId);
    if (!session?.rustSessionId) return;

    // 先设置 loading 状态
    set({
      editingFile: {
        path,
        name,
        content: '',
        originalContent: '',
        sessionId,
        dirty: false,
        saving: false,
        loading: true,
      },
    });

    try {
      const bytes = await sftpRead(session.rustSessionId, path);
      const content = decodeUtf8(bytes);
      set({
        editingFile: {
          path,
          name,
          content,
          originalContent: content,
          sessionId,
          dirty: false,
          saving: false,
          loading: false,
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[sshStore] openFile failed:', path, msg);
      set({ editingFile: null });
      throw e;
    }
  },

  saveFile: async () => {
    const { editingFile } = get();
    if (!editingFile || editingFile.saving) return;

    const session = get().sessions.find(
      (s) => s.id === editingFile.sessionId,
    );
    if (!session?.rustSessionId) return;

    set({
      editingFile: { ...editingFile, saving: true },
    });

    try {
      const bytes = encodeUtf8(editingFile.content);
      await sftpWrite(session.rustSessionId, editingFile.path, bytes);
      set({
        editingFile: {
          ...editingFile,
          originalContent: editingFile.content,
          dirty: false,
          saving: false,
        },
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[sshStore] saveFile failed:', msg);
      set({
        editingFile: { ...editingFile, saving: false },
      });
      throw e;
    }
  },

  closeEditor: () => set({ editingFile: null }),

  updateEditorContent: (content) => {
    set((s) => {
      if (!s.editingFile) return s;
      return {
        editingFile: {
          ...s.editingFile,
          content,
          dirty: content !== s.editingFile.originalContent,
        },
      };
    });
  },

  removeTransferTask: (id) => {
    set((s) => ({
      transferTasks: s.transferTasks.filter((t) => t.id !== id),
    }));
  },

  // === TDSF 魔改: 凭据持久化 actions ===

  /**
   * 测试连接 (不保留会话)
   *
   * 调用 Rust ssh_test 命令, 成功后立即断开。
   * 用于 SshConnectDialog 的"测试连接"按钮, 让用户在保存前验证凭据可用。
   */
  testConnection: async (params) => {
    try {
      return await sshTest(params);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, message: msg };
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
  connectWithSaved: async (profile) => {
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

      // 3. 调用 connect
      const sessionId = await get().connect(params);

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

  // === TDSF 魔改: SSH 终端数据订阅 (修复黑屏) ===
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

/** 按 id 获取会话 (不存在时返回 null) */
export function selectSessionById(
  state: SshExplorerState,
  id: string | null | undefined,
): SshSessionInfo | null {
  if (!id) return null;
  return state.sessions.find((s) => s.id === id) ?? null;
}

/** 获取当前活跃会话的远程当前目录 (无活跃会话或未记录时返回 null) */
export function selectActiveSessionCurrentPath(
  state: SshExplorerState,
): string | null {
  const id = state.activeSessionId;
  if (!id) return null;
  return state.currentPathBySession[id] ?? null;
}

/** 按 id 获取会话的远程当前目录 */
export function selectSessionCurrentPath(
  state: SshExplorerState,
  id: string | null | undefined,
): string | null {
  if (!id) return null;
  return state.currentPathBySession[id] ?? null;
}

// === 事件订阅 (在 SshExplorer 挂载时调用) =====================================
//
// 监听 ssh:host_verify / ssh:host_key_mismatch 事件, 推送到 pendingApproval。
// 由 SshExplorer useEffect 中调用 subscribeHostVerify / subscribeHostKeyMismatch。

export { joinRemotePath };
