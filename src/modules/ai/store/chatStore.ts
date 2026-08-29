import type { Chat, UIMessage } from "@ai-sdk/react";
import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import {
  DEFAULT_MODEL_ID,
  endpointIdFromCompatModel,
  getModel,
  isCompatModelId,
  providerNeedsKey,
  type ModelId,
  type ProviderId,
} from "../config";
import { useTodosStore } from "./todoStore";
import type { AgentUsage } from "../lib/agent";
import { EMPTY_PROVIDER_KEYS, type ProviderKeys, type CustomEndpointKeys } from "../lib/keyring";
import {
  DEFAULT_AGENT_MODE,
  DEFAULT_TDSF_AGENT,
  isAgentMode,
  type AgentMode,
  type TdsfAgentId,
} from "../agents/registry";
import {
  deleteSessionData,
  deriveTitle,
  loadAll,
  loadMessages,
  newSessionId,
  saveActiveId,
  saveMessages,
  saveSessionsList,
  type SessionMeta,
} from "../lib/sessions";
import { pushRecentModel } from "../lib/modelPrefs";
// TDSF B1 (2026-08-29): 终端 block 流水账类型（<terminal-history> 数据源）
import type { TerminalBlock } from "@/modules/terminal/lib/terminalBlocks";

export type Live = {
  getCwd: () => string | null;
  getTerminalContext: () => string | null;
  isActiveTerminalPrivate: () => boolean;
  injectIntoActivePty: (text: string) => boolean;
  getWorkspaceRoot: () => string | null;
  getActiveFile: () => string | null;
  openPreview: (url: string) => boolean;
  spawnManagedAgent: (
    prompt: string,
    sessionId: string,
  ) => { tabId: number; leafId: number } | null;
  readLeafBuffer: (leafId: number) => string | null;
  /**
   * 获取当前活跃 SSH 会话的 Rust session_id (u32)。
   *
   * TDSF 魔改 2026-07-30: Strands 运维工具需要通过 RustBridge 调
   * ssh_command / sftp_* 命令，这些命令的 sessionId 参数期望 u32 类型
   * (来自 ssh_connect 返回值)。前端 LiveSnapshot.sshSessionId 字段
   * 从此方法取值，注入到 state.live.sshSessionId，Python 侧
   * ToolContext.ssh_session_id 据此填充。
   *
   * 返回 null 表示当前无活跃 SSH 会话（本地终端模式）。
   */
  getSshRustSessionId: () => number | null;
  /**
   * TDSF B1 (2026-08-29, 方案书 §4.7): 一次性环境探测
   * {os_pretty_name, kernel, shell}——SSH 会话经 sidecar→RustBridge 在
   * 目标机执行合并命令，本地会话读本地信息；sidecar 会话级缓存。
   * 失败返回 null（<environment> 分区静默省略，不阻塞对话）。
   */
  getEnvironmentProbe?: () => Promise<EnvironmentProbe | null>;
  /**
   * TDSF B1: 活跃终端最近 N 条 block 流水账
   * （command/cwd/exit/duration/author/outputTail），供
   * <terminal-history> 注入。无活跃终端返回 []。
   */
  getTerminalHistory?: () => TerminalBlock[];
};

/** 环境探测结果（sidecar system.probe_env 返回，snake_case 对齐协议） */
export type EnvironmentProbe = {
  ok: boolean;
  os_pretty_name: string;
  kernel: string;
  shell: string;
  /** local = 本地探测 / ssh = 远端探测 / cache = 会话级缓存命中 */
  source: "local" | "ssh" | "cache";
};

export type AgentRunStatus =
  | "idle"
  | "thinking"
  | "streaming"
  | "awaiting-approval"
  | "error";

export type AgentMeta = {
  status: AgentRunStatus;
  step: string | null;
  approvalsPending: number;
  error: string | null;
  tokens: AgentUsage;
  lastInputTokens: number;
  lastCachedTokens: number;
  hitStepCap: boolean;
  compactionNotice: { droppedCount: number; at: number } | null;
};

const ZERO_USAGE: AgentUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
};

const IDLE_META: AgentMeta = {
  status: "idle",
  step: null,
  approvalsPending: 0,
  error: null,
  tokens: ZERO_USAGE,
  lastInputTokens: 0,
  lastCachedTokens: 0,
  hitStepCap: false,
  compactionNotice: null,
};

export type MiniState = {
  open: boolean;
};

export type PendingSelection = {
  id: string;
  text: string;
  source: "terminal" | "editor";
};

export type ApprovalResponder = (
  approvalId: string,
  approved: boolean,
) => void;

type StoreState = {
  live: Live;
  setLive: (live: Live) => void;

  /**
   * Set by AgentRunBridge each render. Lets surfaces outside the chat hook
   * tree (e.g. the AI diff tab in the editor area) resolve a pending tool
   * approval through the active session's `addToolApprovalResponse`.
   */
  approvalResponder: ApprovalResponder | null;
  setApprovalResponder: (fn: ApprovalResponder | null) => void;
  respondToApproval: (approvalId: string, approved: boolean) => void;

  apiKeys: ProviderKeys;
  setApiKeys: (keys: ProviderKeys) => void;
  setApiKey: (provider: ProviderId, key: string | null) => void;

  customEndpointKeys: CustomEndpointKeys;
  setCustomEndpointKeys: (keys: CustomEndpointKeys) => void;

  selectedModelId: string;
  setSelectedModelId: (id: string) => void;

  /**
   * 当前激活的 TDSF Agent id
   *
   * v3.1 收敛（方案书 §4.1）：子 agent 委派机制已删除，此值恒为 'main'——
   * 它只剩一个职责：非 null 时 transport.ts 路由到 Sidecar 路径
   * （null 才走 Vercel AI SDK fallback）。保留字段维持该路由开关语义。
   *
   * 能力差异改由 agentMode（三模式信任体系）+ teach（教学皮肤）表达，
   * 两者随 agent.invoke 的 state.live 下发 sidecar。
   */
  tdsfAgentId: TdsfAgentId;
  setTdsfAgent: (id: TdsfAgentId) => void;

  /**
   * Agent 信任模式（方案书 v3.1 三模式：observe/confirm/auto）
   *
   * 会话级状态 + per-session 持久化（SessionMeta.agentMode）：
   *   - setAgentMode 写回活跃会话元数据（saveSessionsList 落盘）
   *   - hydrateSessions / switchSession / newSession 时恢复或重置
   *   - chatRuntime.getLive() 每轮读取，随 state.live.agentMode 下发 sidecar
   *   - 缺省 confirm（中间态最安全）
   */
  agentMode: AgentMode;
  setAgentMode: (mode: AgentMode) => void;

  /**
   * 教学皮肤开关（叠加在任意模式上，不改变权限矩阵）
   *
   * per-session 持久化（SessionMeta.teach）；chatRuntime.getLive() 每轮读取，
   * 随 state.live.teach 下发 sidecar；前端 AiChat 按 teach + 输出契约渲染 TeachCard。
   */
  teach: boolean;
  setTeach: (on: boolean) => void;

  /**
   * 会话级只读免审标志（Task 5，方案书 v3.1 §4.5 免确认记忆三级）
   *
   * ⚡「批准且本会话只读免审」按钮点击时置位；纯内存不落盘（spec：
   * 会话级不落盘），切会话/新建会话时重置为 false。Python 侧经
   * needs_you.respond 的 trust 响应同步记录（trust_store.SessionTrustStore），
   * 本字段仅承载前端会话状态（审批卡提示等 UI 消费）。
   */
  sessionReadOnlyTrust: boolean;
  setSessionReadOnlyTrust: (on: boolean) => void;

  /**
   * 终端执行模式开关（TDSF 魔改 2026-08-09）
   *
   * 打开后，agent 建议的命令自动注入终端并执行（加换行符），
   * 用户在终端上实时看到命令执行和输出回显。
   * 关闭时（默认），命令只生成卡片等用户点击 Insert。
   */
  autoExecuteInTerminal: boolean;
  setAutoExecuteInTerminal: (on: boolean) => void;

  mini: MiniState;
  openMini: () => void;
  closeMini: () => void;
  toggleMini: () => void;

  panelOpen: boolean;
  openPanel: () => void;
  closePanel: () => void;
  togglePanel: () => void;

  focusSignal: number;
  pendingPrefill: string | null;
  focusInput: (prefill?: string | null) => void;
  consumePrefill: () => string | null;

  pendingSelections: PendingSelection[];
  attachSelection: (text: string, source: "terminal" | "editor") => void;
  consumeSelections: () => PendingSelection[];

  agentMeta: AgentMeta;
  patchAgentMeta: (patch: Partial<AgentMeta>) => void;
  resetAgentMeta: () => void;

  // Sessions
  sessionsHydrated: boolean;
  sessions: SessionMeta[];
  activeSessionId: string | null;
  hydrateSessions: () => Promise<void>;
  newSession: () => string;
  switchSession: (id: string) => void;
  deleteSession: (id: string) => void;
  renameSession: (id: string, title: string) => void;
  /** Persist messages of a session and bump its updatedAt + auto-title. */
  persistMessages: (id: string, messages: UIMessage[]) => void;
};

const NOOP_LIVE: Live = {
  getCwd: () => null,
  getTerminalContext: () => null,
  isActiveTerminalPrivate: () => false,
  injectIntoActivePty: () => false,
  getWorkspaceRoot: () => null,
  getActiveFile: () => null,
  openPreview: () => false,
  spawnManagedAgent: () => null,
  readLeafBuffer: () => null,
  getSshRustSessionId: () => null,
};

const CHATS_LRU_CAP = 8;
export const chats = new Map<string, Chat<UIMessage>>();

export function touchChat(id: string, c: Chat<UIMessage>) {
  if (chats.has(id)) chats.delete(id);
  chats.set(id, c);
  while (chats.size > CHATS_LRU_CAP) {
    const oldest = chats.keys().next().value;
    if (!oldest || oldest === id) break;
    if (useChatStore.getState().activeSessionId === oldest) break;
    flushPersistEntry(oldest);
    void chats.get(oldest)?.stop();
    chats.delete(oldest);
  }
}
// Initial messages for a session, populated at hydration time and consumed
// when the matching Chat is constructed.
export const seedMessages = new Map<string, UIMessage[]>();

// Trailing debounce for per-token message persistence. Streaming fires
// `persistMessages` on every token; without this we'd JSON-serialize the
// full message array and round-trip to the store plugin per token, which
// stalls the UI. Flush on idle (status transition) via `flushPersist`.
const PERSIST_DEBOUNCE_MS = 300;
const pendingPersist = new Map<
  string,
  { latest: UIMessage[]; timer: ReturnType<typeof setTimeout> }
>();

function flushPersistEntry(id: string) {
  const entry = pendingPersist.get(id);
  if (!entry) return;
  clearTimeout(entry.timer);
  pendingPersist.delete(id);
  void saveMessages(id, entry.latest);
}

export function flushPersist(id?: string): void {
  if (id) {
    flushPersistEntry(id);
    return;
  }
  for (const key of Array.from(pendingPersist.keys())) flushPersistEntry(key);
}

// ============================================================================
// T14 (2026-08-28): 会话记忆沉淀 — 会话收尾时 fire-and-forget LLM 摘要写入决策库
// ============================================================================

/** 至少 2 轮对话（4 条消息）才值得沉淀，避免空转 LLM */
const MIN_MEMORY_MESSAGES = 4;
/** 每个应用生命周期内每会话至多沉淀一次（幂等兜底：sidecar 侧同 id 也是覆盖写） */
const summarizedSessions = new Set<string>();

/** UIMessage → {role, content} 扁平 transcript（只取 text part） */
function extractTranscript(messages: UIMessage[]): {
  role: string;
  content: string;
}[] {
  return messages
    .map((m) => ({
      role: m.role,
      content:
        m.parts
          ?.filter((p): p is { type: "text"; text: string } => p.type === "text")
          .map((p) => p.text)
          .join("\n") ?? "",
    }))
    .filter((m) => m.content.trim().length > 0);
}

/**
 * 会话收尾（新建/删除会话时对旧会话调用）：消息量达标则异步触发
 * memory.summarize_session。fire-and-forget——沉淀失败静默，
 * 不阻塞不提示（记忆是后台增值能力，不应干扰用户操作）。
 */
async function maybeSummarizeSession(id: string): Promise<void> {
  if (!id || summarizedSessions.has(id)) return;
  try {
    // 优先内存中的 Chat（LRU 内）；被淘汰的会话回退持久化存储
    let messages: UIMessage[] | undefined = chats.get(id)?.messages;
    if (!messages) messages = (await loadMessages(id)) ?? undefined;
    const transcript = messages ? extractTranscript(messages) : [];
    if (transcript.length < MIN_MEMORY_MESSAGES) return;

    summarizedSessions.add(id);
    await invoke("ipc_invoke", {
      method: "memory.summarize_session",
      params: { session_id: id, transcript },
    });
  } catch {
    // 静默：会话记忆沉淀失败不影响用户操作
  }
}

/**
 * v3.1 三模式 per-session 持久化辅助
 * ----------------------------------------------------------------------------
 * 模式/教学开关是会话级状态：切换会话要恢复该会话上次的模式，重启后也要恢复
 * （spec: add-agent-trust-modes "模式 per-session 持久化"）。
 * 存储复用现有会话元数据管道：SessionMeta.agentMode / SessionMeta.teach，
 * 随 saveSessionsList 落盘（tdsf-sessions.json），不引入新存储。
 */

/** 把 agentMode/teach 增量写回活跃会话元数据并落盘（setAgentMode/setTeach 用） */
function persistModeToActiveSession(
  state: { activeSessionId: string | null; sessions: SessionMeta[] },
  patch: { agentMode?: AgentMode; teach?: boolean },
): void {
  const id = state.activeSessionId;
  if (!id) return;
  const meta = state.sessions.find((s) => s.id === id);
  if (!meta) return;
  // 同值短路：避免每档点击都重写 sessions 数组（触发订阅者重渲染 + store 写）
  if (
    (patch.agentMode === undefined || meta.agentMode === patch.agentMode) &&
    (patch.teach === undefined || meta.teach === patch.teach)
  ) {
    return;
  }
  const next = state.sessions.map((s) => (s.id === id ? { ...s, ...patch } : s));
  useChatStore.setState({ sessions: next });
  void saveSessionsList(next);
}

/** 从会话元数据恢复模式/教学开关到 store（缺字段回退默认值，兼容老会话） */
function restoreModeFromMeta(meta: SessionMeta | undefined): void {
  const mode =
    meta?.agentMode && isAgentMode(meta.agentMode)
      ? meta.agentMode
      : DEFAULT_AGENT_MODE;
  useChatStore.setState({
    agentMode: mode,
    teach: meta?.teach === true,
    // Task 5: 会话级只读免审不落盘——切会话一律重置（spec「会话级不落盘」）
    sessionReadOnlyTrust: false,
  });
}

export const useChatStore = create<StoreState>((set, get) => ({
  live: NOOP_LIVE,
  setLive: (live) => set({ live }),

  approvalResponder: null,
  setApprovalResponder: (fn) => set({ approvalResponder: fn }),
  respondToApproval: (approvalId, approved) => {
    const fn = get().approvalResponder;
    if (fn) fn(approvalId, approved);
  },

  apiKeys: { ...EMPTY_PROVIDER_KEYS },
  setApiKeys: (keys) => set({ apiKeys: keys }),
  setApiKey: (provider, key) => {
    set({ apiKeys: { ...get().apiKeys, [provider]: key } });
  },

  customEndpointKeys: {},
  setCustomEndpointKeys: (keys) => set({ customEndpointKeys: keys }),

  selectedModelId: DEFAULT_MODEL_ID,
  setSelectedModelId: (id) => {
    set({ selectedModelId: id });
    void pushRecentModel(id);
  },

  // TDSF Agent: 默认 'main'，唯一入口（v3.1 收敛）
  tdsfAgentId: DEFAULT_TDSF_AGENT,
  setTdsfAgent: (id) => set({ tdsfAgentId: id }),

  // Agent 信任模式（v3.1 三模式）：缺省 confirm + per-session 持久化
  agentMode: DEFAULT_AGENT_MODE,
  setAgentMode: (mode) => {
    set({ agentMode: mode });
    persistModeToActiveSession(get(), { agentMode: mode });
  },

  // 教学皮肤开关（叠加在任意模式上）：缺省关 + per-session 持久化
  teach: false,
  setTeach: (on) => {
    set({ teach: on });
    persistModeToActiveSession(get(), { teach: on });
  },

  // 会话级只读免审（Task 5 ⚡）：纯内存不落盘，切会话随 restoreModeFromMeta 重置
  sessionReadOnlyTrust: false,
  setSessionReadOnlyTrust: (on) => set({ sessionReadOnlyTrust: on }),

  autoExecuteInTerminal: false,
  setAutoExecuteInTerminal: (on) => set({ autoExecuteInTerminal: on }),

  mini: { open: false },
  openMini: () => set({ mini: { open: true } }),
  closeMini: () => set({ mini: { open: false } }),
  toggleMini: () => set((s) => ({ mini: { open: !s.mini.open } })),

  panelOpen: false,
  openPanel: () => set({ panelOpen: true }),
  closePanel: () => set({ panelOpen: false }),
  togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),

  focusSignal: 0,
  pendingPrefill: null,
  focusInput: (prefill = null) =>
    set((s) => ({
      panelOpen: true,
      focusSignal: s.focusSignal + 1,
      pendingPrefill: prefill ?? null,
    })),
  consumePrefill: () => {
    const v = get().pendingPrefill;
    if (v != null) set({ pendingPrefill: null });
    return v;
  },

  pendingSelections: [],
  attachSelection: (text, source) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    const id = `sel-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    set((s) => ({
      panelOpen: true,
      focusSignal: s.focusSignal + 1,
      pendingSelections: [...s.pendingSelections, { id, text: trimmed, source }],
    }));
  },
  consumeSelections: () => {
    const v = get().pendingSelections;
    if (v.length > 0) set({ pendingSelections: [] });
    return v;
  },

  agentMeta: IDLE_META,
  patchAgentMeta: (patch) =>
    set((s) => ({ agentMeta: { ...s.agentMeta, ...patch } })),
  resetAgentMeta: () => set({ agentMeta: IDLE_META }),

  sessionsHydrated: false,
  sessions: [],
  activeSessionId: null,

  hydrateSessions: async () => {
    if (get().sessionsHydrated) return;
    const { sessions } = await loadAll();

    // Reuse the most recent untitled "新会话" session if one exists from
    // the previous run — no point stacking empty placeholder sessions every
    // launch. Otherwise prepend a fresh one.
    const reusable = sessions[0]?.title === "新会话" ? sessions[0] : null;
    let nextSessions: SessionMeta[];
    let freshId: string;
    if (reusable) {
      nextSessions = sessions;
      freshId = reusable.id;
    } else {
      freshId = newSessionId();
      const fresh: SessionMeta = {
        id: freshId,
        title: "新会话",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      nextSessions = [fresh, ...sessions];
      void saveSessionsList(nextSessions);
    }
    void saveActiveId(freshId);

    // v3.1: 恢复激活会话的信任模式/教学开关（重启后恢复上次选择）
    restoreModeFromMeta(reusable ?? undefined);

    set({
      sessions: nextSessions,
      activeSessionId: freshId,
      sessionsHydrated: true,
    });
  },

  newSession: () => {
    // T14: 对即将被切走的旧会话触发记忆沉淀（fire-and-forget）
    const oldId = get().activeSessionId;
    if (oldId) void maybeSummarizeSession(oldId);

    const id = newSessionId();
    const meta: SessionMeta = {
      id,
      title: "新会话",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    const next = [meta, ...get().sessions];
    set({ sessions: next, activeSessionId: id, agentMeta: IDLE_META });
    // v3.1: 新会话重置为默认模式（确认 + 教学关）
    restoreModeFromMeta(meta);
    void saveSessionsList(next);
    void saveActiveId(id);
    return id;
  },

  switchSession: (id) => {
    if (get().activeSessionId === id) return;
    if (!get().sessions.some((s) => s.id === id)) return;

    // Lazily seed the chat with persisted messages the first time we open
    // this session. Subsequent switches reuse the cached Chat instance.
    const flip = () => {
      set({ activeSessionId: id, agentMeta: IDLE_META });
      // v3.1: 切会话恢复该会话上次选用的模式/教学开关
      restoreModeFromMeta(get().sessions.find((s) => s.id === id));
      void saveActiveId(id);
    };
    if (chats.has(id) || seedMessages.has(id)) {
      flip();
      return;
    }
    void loadMessages(id).then((m) => {
      if (m && m.length > 0 && !chats.has(id)) seedMessages.set(id, m);
      flip();
    });
  },

  deleteSession: (id) => {
    // T14: 删除前对被删会话触发记忆沉淀（在清理 chats 之前取消息）
    void maybeSummarizeSession(id);

    const remaining = get().sessions.filter((s) => s.id !== id);
    chats.get(id)?.stop();
    chats.delete(id);
    seedMessages.delete(id);
    const pend = pendingPersist.get(id);
    if (pend) {
      clearTimeout(pend.timer);
      pendingPersist.delete(id);
    }
    void deleteSessionData(id);
    void useTodosStore.getState().clearSession(id);

    if (remaining.length === 0) {
      const fresh: SessionMeta = {
        id: newSessionId(),
        title: "新会话",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      set({ sessions: [fresh], activeSessionId: fresh.id });
      // v3.1: 全删后新建的会话重置为默认模式
      restoreModeFromMeta(fresh);
      void saveSessionsList([fresh]);
      void saveActiveId(fresh.id);
      return;
    }

    const wasActive = get().activeSessionId === id;
    const nextActive = wasActive ? remaining[0].id : get().activeSessionId;
    set({ sessions: remaining, activeSessionId: nextActive });
    void saveSessionsList(remaining);
    if (wasActive) {
      void saveActiveId(nextActive);
      // v3.1: 激活会话被删后切到剩余首个，恢复其模式/教学开关
      restoreModeFromMeta(remaining.find((s) => s.id === nextActive));
    }
  },

  renameSession: (id, title) => {
    const next = get().sessions.map((s) =>
      s.id === id ? { ...s, title, updatedAt: Date.now() } : s,
    );
    set({ sessions: next });
    void saveSessionsList(next);
  },

  persistMessages: (id, messages) => {
    // Debounce the message-blob write so streaming doesn't pound the store.
    const existing = pendingPersist.get(id);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      const entry = pendingPersist.get(id);
      if (!entry) return;
      pendingPersist.delete(id);
      void saveMessages(id, entry.latest);
    }, PERSIST_DEBOUNCE_MS);
    pendingPersist.set(id, { latest: messages, timer });

    // Update zustand session list only when the derived title actually
    // changes — otherwise we'd rewrite the sessions array (and trigger
    // re-renders + a store write) on every token.
    const sessions = get().sessions;
    const meta = sessions.find((s) => s.id === id);
    if (!meta) return;
    const isUntitled = !meta.title || meta.title === "新会话";
    if (!isUntitled) return;
    const nextTitle = deriveTitle(messages);
    if (nextTitle === meta.title) return;
    const next = sessions.map((s) =>
      s.id === id ? { ...s, title: nextTitle, updatedAt: Date.now() } : s,
    );
    set({ sessions: next });
    void saveSessionsList(next);
  },
}));

export function getAgentMeta(): AgentMeta {
  return useChatStore.getState().agentMeta;
}

export function getActiveProviderKey(): string | null {
  const { selectedModelId, apiKeys, customEndpointKeys } = useChatStore.getState();
  if (isCompatModelId(selectedModelId)) {
    const eid = endpointIdFromCompatModel(selectedModelId);
    return customEndpointKeys[eid] ?? null;
  }
  return apiKeys[getModel(selectedModelId as ModelId).provider] ?? null;
}

export function hasKeyForModel(modelId: string): boolean {
  const { apiKeys } = useChatStore.getState();
  if (isCompatModelId(modelId)) {
    return true;
  }
  const provider = getModel(modelId as ModelId).provider;
  return providerNeedsKey(provider) ? !!apiKeys[provider] : true;
}

export function getChat(sessionId?: string): Chat<UIMessage> | undefined {
  if (sessionId) return chats.get(sessionId);
  const id = useChatStore.getState().activeSessionId;
  return id ? chats.get(id) : undefined;
}

export function stop(): void {
  const id = useChatStore.getState().activeSessionId;
  if (!id) return;
  void chats.get(id)?.stop();
}
