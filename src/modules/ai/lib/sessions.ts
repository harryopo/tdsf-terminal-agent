import type { UIMessage } from "@ai-sdk/react";
import { LazyStore } from "@tauri-apps/plugin-store";
import type { AgentMode } from "../agents/registry";

/**
 * 会话环境范围（A1 多服务器隔离，2026-09-01 用户钦定）。
 *
 * 类比 AI 编程 agent 的工作目录隔离：这里每个对话创建时绑定一个
 * 环境范围——本地 或 某台 SSH 服务器（按 user+host+port 身份绑定，
 * 重连后 rust session id 变化不影响归属）。对话内的环境感知
 * （<env> 块 / sshSessionId / 终端上下文）都按 scope 解析，
 * 不再全局跟随"当前活跃终端"，跨服务器上下文不再互相污染。
 * 可选：老会话无此字段 → 回退全局行为（兼容不迁移）。
 */
export type SessionScope =
  | { kind: "local" }
  | { kind: "ssh"; host: string; user: string; port: number }
  | { kind: "workspace"; spaceId: string };

export type SessionMeta = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /**
   * Agent 信任模式（方案书 v3.1 三模式，per-session 持久化）。
   * 可选：老会话元数据无此字段，读取时回退 DEFAULT_AGENT_MODE。
   */
  agentMode?: AgentMode;
  /** 教学皮肤开关（叠加在任意模式上，不改变权限矩阵）。可选，缺省 false。 */
  teach?: boolean;
  /** 环境范围（A1 隔离）。可选：老会话缺省 → 全局行为。 */
  scope?: SessionScope;
};

// TDSF 魔改: store path 改为 tdsf-sessions.json(原 "terax-ai-sessions.json" 保留为注释供溯源)
// 注意: 修改后已存的会话历史将不再可见(可手动迁移)
// const STORE_PATH_LEGACY = "terax-ai-sessions.json";
const STORE_PATH = "tdsf-sessions.json";
const KEY_SESSIONS = "sessions";
const KEY_ACTIVE = "activeId";
const messagesKey = (id: string) => `messages:${id}`;

const store = new LazyStore(STORE_PATH, { defaults: {}, autoSave: 200 });

export type LoadedSessions = {
  sessions: SessionMeta[];
  activeId: string | null;
};

export async function loadAll(): Promise<LoadedSessions> {
  // One IPC roundtrip via entries() rather than two parallel get()s. Per-
  // session messages are loaded lazily via `loadMessages` only when a
  // session is opened, so cold boot stays at a single store call.
  const entries = await store.entries();
  let sessions: SessionMeta[] | undefined;
  let activeId: string | null | undefined;
  for (const [k, v] of entries) {
    if (k === KEY_SESSIONS) sessions = v as SessionMeta[];
    else if (k === KEY_ACTIVE) activeId = v as string | null;
  }
  return { sessions: sessions ?? [], activeId: activeId ?? null };
}

export async function loadMessages(id: string): Promise<UIMessage[] | null> {
  return (await store.get<UIMessage[]>(messagesKey(id))) ?? null;
}

export async function saveSessionsList(sessions: SessionMeta[]): Promise<void> {
  await store.set(KEY_SESSIONS, sessions);
}

export async function saveActiveId(id: string | null): Promise<void> {
  await store.set(KEY_ACTIVE, id);
}

export async function saveMessages(
  id: string,
  messages: UIMessage[],
): Promise<void> {
  await store.set(messagesKey(id), messages);
}

export async function deleteSessionData(id: string): Promise<void> {
  await store.delete(messagesKey(id));
}

export function newSessionId(): string {
  return `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function deriveTitle(messages: UIMessage[]): string {
  for (const m of messages) {
    if (m.role !== "user") continue;
    for (const p of m.parts) {
      if (p.type !== "text") continue;
      const text = (p as { text: string }).text
        .replace(/<terminal-context[\s\S]*?<\/terminal-context>\s*/g, "")
        .replace(/<selection[\s\S]*?<\/selection>\s*/g, "")
        .replace(/<file[\s\S]*?<\/file>\s*/g, "")
        .trim();
      if (!text) continue;
      const first = text.split("\n")[0].trim();
      return first.length > 40 ? `${first.slice(0, 40)}…` : first;
    }
  }
  return "新会话";
}
