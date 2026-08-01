/**
 * runtime.ts — TDSF 运行时状态 Store (P1-B)
 * -----------------------------------------------------------------------------
 * 使用 React Context + useReducer (零依赖)
 * 集中管理 4 个状态域:
 *   1. mood       — 7 状态 (idle/thinking/stream/working/waiting/done/error)
 *   2. mode       — 3 模式 (plan/agent/yolo, 参考 CodeWhale / friday-code)
 *   3. permission — 3 模式 (always/auto/never) × 4 档 (L0-L4)
 *   4. needsYou   — needs-you 收件箱 (审批/错误/问题/handoff)
 *
 * 组件依赖:
 *   - StatusBar   → 读 mood + permission
 *   - Titlebar    → 写 mode + permission
 *   - AgentPanel  → 读 mood + 写 needsYou
 *   - NeedsYou    → 读 needsYou + 写 needsYou
 */
import { createContext, useContext, useReducer, useEffect, type ReactNode, type Dispatch } from 'react';
// P2-B T-P2-04: 导入 SshConnectParams 类型供 SshSessionItem.params 使用
import type { SshConnectParams } from '../lib/ssh-bridge';

// === 1. Mood (7 状态) =========================================================
export type Mood = 'idle' | 'thinking' | 'stream' | 'working' | 'waiting' | 'done' | 'error';

// === 2. Mode (3 模式, Shift+Tab 切换) =========================================
export type Mode = 'plan' | 'agent' | 'yolo';

// === T-P4-05: StatusBar 4 状态 ================================================
/**
 * StatusBar 4 状态（P4 新增）
 * - idle:    无 Agent 活动（空闲）
 * - herd:    多 Agent 并行（herd 模式，活跃 Agent 数 > 1）
 * - solo:    单 Agent 执行中（活跃 Agent 数 = 1）
 * - review:  等待用户审批（有 pending needs-you）
 */
export type StatusBarState = 'idle' | 'herd' | 'solo' | 'review';

// === 3. Permission (3 模式 × 4 档) ============================================
export type PermMode = 'always' | 'auto' | 'never';
export type RiskLevel = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';

// === 4. Needs-You 收件箱 =====================================================
export type NeedsYouType = 'approval' | 'error' | 'question' | 'handoff';

export interface NeedsYouItem {
  id: string;
  type: NeedsYouType;
  title: string;
  detail: string;
  createdAt: number;
  resolved: boolean;
  /** P1-1: 后端 needs_you 服务 req_id（审批按钮 RPC 回传用） */
  reqId?: string;
}

// === 5. Agent 消息 + 工具调用（P2-A 新增）=====================================
/** Agent 输出消息类型（与 Python 侧 agent_message 通知对齐） */
export type AgentMessageType =
  | 'thinking' // Agent 思考中
  | 'working' // Agent 执行中
  | 'output' // Agent 输出内容
  | 'done' // 完成消息
  | 'error' // 错误消息
  | 'plan' // 规划消息
  | 'observation' // 观察结果
  | 'reflection'; // 反思结果

export interface AgentMessage {
  id: string;
  type: AgentMessageType;
  content: string;
  timestamp: number;
  /** 关联的会话 ID（与 currentSessionId 对应） */
  sessionId?: string;
  /** 关联的子 Agent 名（main/coding/explore/history/teach） */
  agentName?: string;
}

/** 工具调用状态 */
export type ToolCallStatus = 'running' | 'success' | 'error' | 'pending_approval';

export interface ToolCallItem {
  id: string;
  /** 工具名（risk/decision/confidence/ground 等） */
  toolName: string;
  /** 调用参数 */
  params: Record<string, unknown>;
  /** 返回结果（success/error 时填充） */
  result?: Record<string, unknown>;
  /** 调用状态 */
  status: ToolCallStatus;
  /** 调用时间戳（开始时间） */
  startedAt: number;
  /** 完成时间戳 */
  finishedAt?: number;
  /** 错误信息（status=error 时填充） */
  error?: string;
  /** 关联的 needs-you ID（status=pending_approval 时填充） */
  needsYouId?: string;
  /** 风险等级（risk 工具返回） */
  riskLevel?: 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
}

// === 6. SSH 会话状态（P2-B T-P2-04 新增）=====================================
/**
 * SSH 会话状态枚举（与 Rust session.rs SshSessionState 对齐，9 态有限状态机）
 *
 * 状态转换图：
 *   Idle → Connecting → Handshaking → HostVerifying → Authenticating → Authenticated → Connected
 *   任意状态 → Failed（错误）
 *   任意状态 → Closed（主动断开或服务器断开）
 *   Connected → Reconnecting（KeepaliveTimeout，P3 实现）
 */
export type SshSessionStateValue =
  | 'idle'
  | 'connecting'
  | 'handshaking'
  | 'host_verifying'
  | 'authenticating'
  | 'authenticated'
  | 'connected'
  | 'reconnecting'
  | 'failed'
  | 'closed';

/** SSH 会话项（前端状态，与 Rust 端 session_id 对应） */
export interface SshSessionItem {
  /**
   * 前端生成的持久 key（作为 React key，跨 id 变化保持挂载）
   * 格式：`ssh-${Date.now()}-${random}`
   * 用途：SshTerminal/SshTabs 的 React key，连接成功前后保持一致
   */
  frontendKey: string;
  /**
   * Rust 端分配的 session_id
   * - 初始值：-1（未连接）
   * - 连接成功后：SshTerminal 调用 onConnected(sessionId) → update-ssh-session 更新
   * - 用于 sshDisconnect/sshWrite 等命令调用
   */
  id: number;
  /** 主机名 */
  host: string;
  /** 端口（默认 22） */
  port: number;
  /** 用户名 */
  user: string;
  /** 当前状态（9 态之一） */
  state: SshSessionStateValue;
  /** 错误信息（state=failed 时填充） */
  error?: string;
  /** 连接开始时间戳 */
  connectedAt: number;
  /** 主机指纹（HostVerifying 阶段填充，供前端弹窗显示） */
  fingerprint?: string;
  /** 待审批的 approval_id（HostVerifying 阶段填充，用户确认后清空） */
  pendingApprovalId?: string;
  /**
   * 连接参数（仅 pending 状态保留，连接成功后清除避免密码泄露）
   * SshTerminal 读取此字段发起 sshConnect
   */
  params?: SshConnectParams;
}

// === 7. 多路分屏 Pane 状态（P2-C T-P2-11 新增）===============================
/**
 * cmux 多路终端分屏 pane 项 (tmux 风格)
 *
 * - id: 持久 ID（pane-1, pane-2, ...），跨 re-render 保持稳定
 * - title: pane 标题栏显示文字
 * - terminalRef: xterm 容器 div 的 ref，由 TerminalMultiplexer 注入
 * - isFocused: 当前是否为聚焦 pane（仅 1 个 pane 为 true）
 */
export interface PaneItem {
  id: string;
  title: string;
  isFocused: boolean;
}

/**
 * 多路分屏布局类型 (cmux-tui 子集)
 * - tab:     单 pane 占满 (默认)
 * - split-v: 垂直二分 (左右)
 * - split-h: 水平二分 (上下)
 * - grid:    N x M 网格 (pane 数 > 2 时使用)
 */
export type MultiplexLayout = 'tab' | 'split-v' | 'split-h' | 'grid';

// === 8. 资源管理器 + Monaco Editor 状态（P2-B T-P2-05/06 新增）===============
/**
 * 已打开的远程文件项 (Monaco Editor 多 tab 管理)
 *
 * - path: 远程文件绝对路径 (作为唯一 key)
 * - name: 文件名 (从 path 分割,用于 tab 显示)
 * - content: 文件内容 (UTF-8 解码后的字符串)
 * - originalContent: SFTP 读取时的原始内容 (用于检测 dirty 状态)
 * - language: Monaco language id (如 'javascript' / 'typescript' / 'python' / 'markdown')
 * - size: 文件大小 (字节,用于状态栏显示)
 * - modified: 文件 mtime (Unix 秒,用于状态栏显示)
 * - loading: 是否正在 SFTP 读取中 (避免重复点击)
 * - error: 加载/保存错误信息 (null 表示无错误)
 */
export interface OpenFileItem {
  path: string;
  name: string;
  content: string;
  originalContent: string;
  language: string;
  size: number;
  modified: number;
  loading: boolean;
  error: string | null;
}

// === 9. 知识卡数据结构（P3 T-P3-08 新增）===================================
/**
 * 知识卡项（observe_node 自动检索知识库后注入到 AgentState）
 *
 * - title: 知识标题
 * - source: 知识来源（如 "nginx-docs" / "user-note"）
 * - snippet: 摘要（content 前 200 字符）
 * - url: 原始 URL（点击 "查看详情" 跳转）
 * - score: 相关度评分（0-1，越高越相关）
 * - matchType: 匹配类型（"fts5" 关键词 / "vector" 语义）
 */
export interface KnowledgeCardItem {
  title: string;
  source: string;
  snippet: string;
  url: string;
  score: number;
  matchType?: 'fts5' | 'vector';
}

// === T-P4-07: 9 子 Agent 状态（P4 新增）=====================================
/**
 * 子 Agent 状态项（用于 AgentPanel 9 子 Agent 卡片渲染）
 *
 * - name:    Agent 名（main/coding/explore/history/teach/debug/refactor/test/deploy）
 * - role:    角色描述（中文）
 * - active:  是否活跃（正在执行任务）
 * - mood:    当前 mood（thinking/working/done/error/idle）
 * - lastTask: 最近执行的任务描述（截断到 60 字符）
 * - invocations: 累计调用次数
 */
export interface AgentStateItem {
  name: string;
  role: string;
  active: boolean;
  mood: Mood | 'idle';
  lastTask: string;
  invocations: number;
}

/**
 * 9 子 Agent 默认配置（name + role）
 * 与 python-sidecar/agents/__init__.py AGENT_REGISTRY 对齐
 */
export const SUB_AGENT_DEFAULTS: ReadonlyArray<readonly [string, string]> = [
  ['main', '主 Agent（PAOR 监督 + 路由）'],
  ['coding', '代码生成与修改'],
  ['explore', '代码探索与搜索'],
  ['history', '历史查询与压缩'],
  ['teach', 'Linux 运维教学'],
  ['debug', '故障定位与根因分析'],
  ['refactor', '代码重构'],
  ['test', '测试用例生成与执行'],
  ['deploy', '部署流程编排'],
] as const;

/**
 * 文件树节点 (Explorer 内部状态,不持久化)
 *
 * - path: 远程绝对路径
 * - name: 显示名 (UTF-8 中文友好)
 * - isDir: 是否目录
 * - expanded: 目录是否展开 (仅 isDir=true 有效)
 * - loading: 子节点是否正在加载 (懒加载)
 * - children: 子节点 (未展开时为空数组)
 */
export interface ExplorerTreeNode {
  path: string;
  name: string;
  isDir: boolean;
  expanded: boolean;
  loading: boolean;
  children: ExplorerTreeNode[];
}

// === State + Action ==========================================================
export interface RuntimeState {
  mood: Mood;
  mode: Mode;
  permMode: PermMode;
  /** 各风险档的覆盖模式 (默认 auto) */
  permByLevel: Record<RiskLevel, PermMode>;
  needsYou: NeedsYouItem[];
  /** 网络状态 */
  net: 'online' | 'offline';
  /** Token 用量 (累计) */
  tokens: number;
  /** 内存占用 (MB) */
  memMb: number;
  /** === P2-A 新增 === */
  /** Agent 输出消息列表（按时间顺序追加） */
  agentMessages: AgentMessage[];
  /** 工具调用列表（按时间顺序追加） */
  toolCalls: ToolCallItem[];
  /** 当前会话 ID（关联 Python project_service.sessions） */
  currentSessionId: string;
  /** Agent 是否正在执行（与 mood=working/stream 不同，强调 invoke 进行中） */
  agentBusy: boolean;
  /** === P2-B T-P2-04 新增 === */
  /** SSH 会话列表（每 tab 一个会话，与 Rust 端 session_id 对应） */
  sshSessions: SshSessionItem[];
  /** 当前激活的 SSH 会话 frontendKey（null 表示 local tab） */
  activeSshFrontendKey: string | null;
  /** === P2-C T-P2-11 新增 (cmux 多路分屏) === */
  /** 多路分屏 pane 列表 (至少 1 个, 最多 N 个) */
  panes: PaneItem[];
  /** 当前聚焦的 pane ID (panes 中 isFocused=true 的那个) */
  activePaneId: string;
  /** 多路分屏布局 (tab/split-v/split-h/grid) */
  multiplexLayout: MultiplexLayout;
  /** === P2-B T-P2-05/06 新增 (资源管理器 + Monaco Editor) === */
  /** 资源管理器当前路径 (默认 '/',首次 SSH 连接成功后切换到 '~') */
  explorerPath: string;
  /** 已打开的远程文件列表 (Monaco Editor 多 tab 管理) */
  openFiles: OpenFileItem[];
  /** 当前激活的远程文件路径 (null 表示无文件打开) */
  activeFilepath: string | null;
  /** === P3 T-P3-08 新增（知识卡注入）=== */
  /** 知识卡列表（observe_node 自动检索后注入，每轮覆盖式更新） */
  knowledgeCards: KnowledgeCardItem[];
  /** === P4 T-P4-05 新增（StatusBar 4 状态）=== */
  /** StatusBar 当前状态（idle/herd/solo/review） */
  statusBarState: StatusBarState;
  /** 活跃 Agent 数量（用于 herd/solo 切换判断） */
  activeAgentCount: number;
  /** === P4 T-P4-07 新增（9 子 Agent 卡片）=== */
  /** 9 子 Agent 状态列表（用于 AgentPanel 渲染） */
  agentStates: AgentStateItem[];
}

export type RuntimeAction =
  | { type: 'set-mood'; mood: Mood }
  | { type: 'set-mode'; mode: Mode }
  | { type: 'set-perm-mode'; mode: PermMode }
  | { type: 'set-perm-level'; level: RiskLevel; mode: PermMode }
  | { type: 'add-needs-you'; item: Omit<NeedsYouItem, 'createdAt' | 'resolved'> }
  | { type: 'resolve-needs-you'; id: string }
  | { type: 'set-net'; net: 'online' | 'offline' }
  | { type: 'set-tokens'; tokens: number }
  | { type: 'set-mem'; memMb: number }
  /** === P2-A 新增 === */
  | { type: 'add-agent-message'; message: Omit<AgentMessage, 'id' | 'timestamp'> }
  | { type: 'clear-agent-messages' }
  | { type: 'add-tool-call'; toolCall: Omit<ToolCallItem, 'id' | 'startedAt'> }
  | { type: 'update-tool-call'; id: string; updates: Partial<ToolCallItem> }
  | { type: 'clear-tool-calls' }
  | { type: 'set-session-id'; sessionId: string }
  | { type: 'set-agent-busy'; busy: boolean }
  | { type: 'clear-agent-state' } // 清空 agentMessages + toolCalls + 重置 busy
  /** === P2-B T-P2-04 SSH 会话管理 === */
  | { type: 'add-ssh-session'; session: SshSessionItem }
  | { type: 'update-ssh-session'; frontendKey: string; updates: Partial<SshSessionItem> }
  | { type: 'remove-ssh-session'; frontendKey: string }
  | { type: 'set-active-ssh-session'; frontendKey: string | null }
  | { type: 'clear-ssh-sessions' }
  /** === P2-C T-P2-11 多路分屏管理 === */
  | { type: 'add-pane'; pane: PaneItem }
  | { type: 'remove-pane'; id: string }
  | { type: 'set-active-pane'; id: string }
  | { type: 'update-pane'; id: string; updates: Partial<PaneItem> }
  | { type: 'set-multiplex-layout'; layout: MultiplexLayout }
  /** === P2-B T-P2-05/06 资源管理器 + Monaco Editor 管理 === */
  | { type: 'set-explorer-path'; path: string }
  | { type: 'open-file'; file: OpenFileItem }
  | { type: 'close-file'; path: string }
  | { type: 'update-file'; path: string; updates: Partial<OpenFileItem> }
  | { type: 'set-active-file'; path: string | null }
  | { type: 'clear-open-files' }
  /** === P3 T-P3-08 知识卡注入（覆盖式更新）=== */
  | { type: 'set-knowledge-cards'; cards: KnowledgeCardItem[] }
  | { type: 'clear-knowledge-cards' }
  /** === P4 T-P4-05 StatusBar 4 状态 === */
  | { type: 'set-statusbar-state'; state: StatusBarState }
  | { type: 'set-active-agent-count'; count: number }
  /** === P4 T-P4-07 9 子 Agent 卡片 === */
  | { type: 'set-agent-states'; states: AgentStateItem[] }
  | { type: 'update-agent-state'; name: string; updates: Partial<AgentStateItem> }
  | { type: 'clear-agent-states' };

const DEFAULT_PERM_BY_LEVEL: Record<RiskLevel, PermMode> = {
  L0: 'auto',
  L1: 'auto',
  L2: 'auto',
  L3: 'always',
  L4: 'always',
};

const INITIAL_STATE: RuntimeState = {
  mood: 'idle',
  mode: 'agent',
  permMode: 'auto',
  permByLevel: { ...DEFAULT_PERM_BY_LEVEL },
  needsYou: [],
  net: 'online',
  tokens: 0,
  memMb: 0,
  // P2-A 新增
  agentMessages: [],
  toolCalls: [],
  currentSessionId: '',
  agentBusy: false,
  // P2-B T-P2-04 新增
  sshSessions: [],
  activeSshFrontendKey: null,
  // P2-C T-P2-11 新增 (cmux 多路分屏, 默认单 pane tab 布局)
  panes: [
    { id: 'pane-1', title: 'local', isFocused: true },
  ],
  activePaneId: 'pane-1',
  multiplexLayout: 'tab',
  // P2-B T-P2-05/06 新增 (资源管理器 + Monaco Editor)
  explorerPath: '/',
  openFiles: [],
  activeFilepath: null,
  // P3 T-P3-08 新增 (知识卡注入)
  knowledgeCards: [],
  // P4 T-P4-05 新增 (StatusBar 4 状态)
  statusBarState: 'idle',
  activeAgentCount: 0,
  // P4 T-P4-07 新增 (9 子 Agent 卡片，初始默认配置)
  agentStates: SUB_AGENT_DEFAULTS.map(([name, role]) => ({
    name,
    role,
    active: false,
    mood: 'idle' as const,
    lastTask: '',
    invocations: 0,
  })),
};

// === Reducer =================================================================
function reducer(state: RuntimeState, action: RuntimeAction): RuntimeState {
  switch (action.type) {
    case 'set-mood':
      return { ...state, mood: action.mood };
    case 'set-mode':
      return { ...state, mode: action.mode };
    case 'set-perm-mode':
      return { ...state, permMode: action.mode };
    case 'set-perm-level':
      return {
        ...state,
        permByLevel: { ...state.permByLevel, [action.level]: action.mode },
      };
    case 'add-needs-you': {
      const item: NeedsYouItem = {
        createdAt: Date.now(),
        resolved: false,
        ...action.item,
        // P1-1: 后端 req_id 映射到 reqId 字段（无 reqId 时用前端 id 兜底）
        reqId: action.item.reqId ?? action.item.id,
      };
      return { ...state, needsYou: [item, ...state.needsYou] };
    }
    case 'resolve-needs-you':
      return {
        ...state,
        needsYou: state.needsYou.map((it) =>
          it.id === action.id ? { ...it, resolved: true } : it,
        ),
      };
    case 'set-net':
      return { ...state, net: action.net };
    case 'set-tokens':
      return { ...state, tokens: action.tokens };
    case 'set-mem':
      return { ...state, memMb: action.memMb };
    // === P2-A 新增 ===
    case 'add-agent-message': {
      const msg: AgentMessage = {
        id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        timestamp: Date.now(),
        ...action.message,
      };
      return { ...state, agentMessages: [...state.agentMessages, msg] };
    }
    case 'clear-agent-messages':
      return { ...state, agentMessages: [] };
    case 'add-tool-call': {
      const tc: ToolCallItem = {
        id: `tc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        startedAt: Date.now(),
        ...action.toolCall,
      };
      return { ...state, toolCalls: [...state.toolCalls, tc] };
    }
    case 'update-tool-call':
      return {
        ...state,
        toolCalls: state.toolCalls.map((tc) =>
          tc.id === action.id ? { ...tc, ...action.updates } : tc,
        ),
      };
    case 'clear-tool-calls':
      return { ...state, toolCalls: [] };
    case 'set-session-id':
      return { ...state, currentSessionId: action.sessionId };
    case 'set-agent-busy':
      return { ...state, agentBusy: action.busy };
    case 'clear-agent-state':
      return {
        ...state,
        agentMessages: [],
        toolCalls: [],
        agentBusy: false,
        mood: 'idle',
        knowledgeCards: [], // T-P3-08: 同步清空知识卡
      };
    // === P2-B T-P2-04 SSH 会话管理 ===
    case 'add-ssh-session':
      return { ...state, sshSessions: [...state.sshSessions, action.session] };
    case 'update-ssh-session':
      return {
        ...state,
        sshSessions: state.sshSessions.map((s) =>
          s.frontendKey === action.frontendKey ? { ...s, ...action.updates } : s,
        ),
      };
    case 'remove-ssh-session': {
      const newSessions = state.sshSessions.filter(
        (s) => s.frontendKey !== action.frontendKey,
      );
      // 如果移除的是当前激活的会话，自动切到 local（null）或最后一个
      const newActive =
        state.activeSshFrontendKey === action.frontendKey
          ? newSessions.length > 0
            ? newSessions[newSessions.length - 1].frontendKey
            : null
          : state.activeSshFrontendKey;
      return {
        ...state,
        sshSessions: newSessions,
        activeSshFrontendKey: newActive,
      };
    }
    case 'set-active-ssh-session':
      return { ...state, activeSshFrontendKey: action.frontendKey };
    case 'clear-ssh-sessions':
      return { ...state, sshSessions: [], activeSshFrontendKey: null };
    // === P2-C T-P2-11 多路分屏管理 ===
    case 'add-pane': {
      // 新 pane 加入并自动聚焦 (其他 pane isFocused 置 false)
      const newPanes = state.panes.map((p) => ({ ...p, isFocused: false }));
      newPanes.push({ ...action.pane, isFocused: true });
      return {
        ...state,
        panes: newPanes,
        activePaneId: action.pane.id,
      };
    }
    case 'remove-pane': {
      const newPanes = state.panes.filter((p) => p.id !== action.id);
      // 保证至少 1 个 pane: 若删空, 重建 pane-1
      if (newPanes.length === 0) {
        return {
          ...state,
          panes: [{ id: 'pane-1', title: 'local', isFocused: true }],
          activePaneId: 'pane-1',
          multiplexLayout: 'tab',
        };
      }
      // 若移除的是当前激活 pane, 自动聚焦最后一个
      const newActive =
        state.activePaneId === action.id
          ? newPanes[newPanes.length - 1]!.id
          : state.activePaneId;
      const finalPanes = newPanes.map((p) => ({
        ...p,
        isFocused: p.id === newActive,
      }));
      return {
        ...state,
        panes: finalPanes,
        activePaneId: newActive,
      };
    }
    case 'set-active-pane': {
      // 切换聚焦: 仅 activePaneId 对应的 pane isFocused=true
      const newPanes = state.panes.map((p) => ({
        ...p,
        isFocused: p.id === action.id,
      }));
      return {
        ...state,
        panes: newPanes,
        activePaneId: action.id,
      };
    }
    case 'update-pane':
      return {
        ...state,
        panes: state.panes.map((p) =>
          p.id === action.id ? { ...p, ...action.updates } : p,
        ),
      };
    case 'set-multiplex-layout':
      return { ...state, multiplexLayout: action.layout };
    // === P2-B T-P2-05/06 资源管理器 + Monaco Editor 管理 ===
    case 'set-explorer-path':
      return { ...state, explorerPath: action.path };
    case 'open-file': {
      // 已存在则不重复添加 (按 path 去重)
      if (state.openFiles.some((f) => f.path === action.file.path)) {
        return { ...state, activeFilepath: action.file.path };
      }
      return {
        ...state,
        openFiles: [...state.openFiles, action.file],
        activeFilepath: action.file.path,
      };
    }
    case 'close-file': {
      const newFiles = state.openFiles.filter((f) => f.path !== action.path);
      // 若关闭的是当前激活文件, 自动切到最后一个 (或 null)
      const newActive =
        state.activeFilepath === action.path
          ? newFiles.length > 0
            ? newFiles[newFiles.length - 1]!.path
            : null
          : state.activeFilepath;
      return { ...state, openFiles: newFiles, activeFilepath: newActive };
    }
    case 'update-file':
      return {
        ...state,
        openFiles: state.openFiles.map((f) =>
          f.path === action.path ? { ...f, ...action.updates } : f,
        ),
      };
    case 'set-active-file':
      return { ...state, activeFilepath: action.path };
    case 'clear-open-files':
      return { ...state, openFiles: [], activeFilepath: null };
    // === P3 T-P3-08 知识卡注入（覆盖式更新）===
    case 'set-knowledge-cards':
      return { ...state, knowledgeCards: action.cards };
    case 'clear-knowledge-cards':
      return { ...state, knowledgeCards: [] };
    // === P4 T-P4-05 StatusBar 4 状态 ===
    case 'set-statusbar-state':
      return { ...state, statusBarState: action.state };
    case 'set-active-agent-count':
      return { ...state, activeAgentCount: action.count };
    // === P4 T-P4-07 9 子 Agent 卡片 ===
    case 'set-agent-states':
      return { ...state, agentStates: action.states };
    case 'update-agent-state':
      return {
        ...state,
        agentStates: state.agentStates.map((a) =>
          a.name === action.name ? { ...a, ...action.updates } : a,
        ),
      };
    case 'clear-agent-states':
      return {
        ...state,
        agentStates: SUB_AGENT_DEFAULTS.map(([name, role]) => ({
          name,
          role,
          active: false,
          mood: 'idle' as const,
          lastTask: '',
          invocations: 0,
        })),
      };
    // === clear-agent-state 同步清空知识卡 ===
    // 已在 clear-agent-state case 中处理
    default:
      return state;
  }
}

// === Context =================================================================
const RuntimeContext = createContext<{
  state: RuntimeState;
  dispatch: Dispatch<RuntimeAction>;
} | null>(null);

export function RuntimeProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, INITIAL_STATE);

  // 加载持久化偏好 (mode + permMode)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const savedMode = localStorage.getItem('tdsf-mode') as Mode | null;
    const savedPerm = localStorage.getItem('tdsf-perm') as PermMode | null;
    if (savedMode) dispatch({ type: 'set-mode', mode: savedMode });
    if (savedPerm) dispatch({ type: 'set-perm-mode', mode: savedPerm });
  }, []);

  // === P3 T-P3-10 E2E 测试 hook（仅 dev 模式暴露 dispatch） ===
  // 浏览器预览模式下 sidecar-bridge.subscribe 返回 no-op，无法触发 knowledge_cards 事件
  // 通过 window.__tdsfTestHook.dispatch 注入状态，便于 Playwright E2E 测试
  // 生产构建中 import.meta.env.DEV === false，此 hook 不生效
  useEffect(() => {
    if (typeof window === 'undefined' || !import.meta.env.DEV) return;
    (window as unknown as { __tdsfTestHook?: unknown }).__tdsfTestHook = {
      dispatch,
      getState: () => state,
    };
  }, [state, dispatch]);

  // 持久化 mode + permMode
  useEffect(() => {
    localStorage.setItem('tdsf-mode', state.mode);
  }, [state.mode]);
  useEffect(() => {
    localStorage.setItem('tdsf-perm', state.permMode);
  }, [state.permMode]);

  return (
    <RuntimeContext.Provider value={{ state, dispatch }}>
      {children}
    </RuntimeContext.Provider>
  );
}

export function useRuntime() {
  const ctx = useContext(RuntimeContext);
  if (!ctx) throw new Error('useRuntime must be used within RuntimeProvider');
  return ctx;
}

// === 常量 ====================================================================
export const MOOD_LIST: Mood[] = ['idle', 'thinking', 'stream', 'working', 'waiting', 'done', 'error'];

export const MODE_LIST: { value: Mode; label: string; desc: string }[] = [
  { value: 'plan', label: 'Plan', desc: 'AI 只读, 输出计划等确认' },
  { value: 'agent', label: 'Agent', desc: 'AI 执行 L0-L2, 拦截 L3+' },
  { value: 'yolo', label: 'Yolo', desc: 'AI 自由执行, 全部 L0-L4' },
];

export const PERM_LIST: { value: PermMode; label: string; desc: string }[] = [
  { value: 'always', label: 'Always', desc: '总是需要审批' },
  { value: 'auto', label: 'Auto', desc: '风险等级智能决定' },
  { value: 'never', label: 'Never', desc: '永不审批, 直接执行' },
];

export const RISK_LIST: RiskLevel[] = ['L0', 'L1', 'L2', 'L3', 'L4'];
