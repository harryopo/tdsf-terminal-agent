/**
 * chatStore.workspace-sync.test.ts — 方案1 工作区自动绑定 + 独立对话（2026-09-03）
 * -----------------------------------------------------------------------------
 * 覆盖 syncSessionToWorkspace：
 *   1. 无活跃工作区 → 不动（门控 spaces.length===0 引导新建）
 *   2. 空会话 + 有活跃工作区 → 重绑 scope 到 workspace（无缝、无污染）
 *   3. 已绑定当前工作区 → 幂等不动
 *   4. 有历史会话切到别的工作区（目标无会话）→ 新建绑定新工作区的会话，旧会话保留（防污染）
 *   5. 有历史 + 目标工作区已有会话 → 切到该会话（不新建）
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// mock sessions 持久化（tauri store plugin 在 jsdom 不可用），保留 newSessionId 等纯函数
vi.mock("../lib/sessions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/sessions")>();
  return {
    ...actual,
    saveSessionsList: vi.fn(async () => {}),
    saveActiveId: vi.fn(async () => {}),
    saveMessages: vi.fn(async () => {}),
    // newSession 会对旧会话 fire-and-forget 触发 maybeSummarizeSession→loadMessages，
    // tauri store plugin 在 jsdom 不可用，mock 为空避免 unhandled rejection
    loadMessages: vi.fn(async () => []),
    loadAll: vi.fn(async () => ({ sessions: [], messages: new Map() })),
  };
});

import { chats, seedMessages, useChatStore } from "./chatStore";
import { useSpaces } from "@/modules/spaces";
import type { SessionMeta } from "../lib/sessions";

function meta(
  id: string,
  title: string,
  scope: SessionMeta["scope"],
  updatedAt = 1,
): SessionMeta {
  return { id, title, createdAt: updatedAt, updatedAt, scope };
}

beforeEach(() => {
  seedMessages.clear();
  chats.clear();
  useChatStore.setState({ sessions: [], activeSessionId: null });
  useSpaces.setState({ spaces: [], activeId: null });
});

describe("chatStore.syncSessionToWorkspace — 方案1 自动绑定 + 独立对话", () => {
  it("无活跃工作区 → 不动 scope", () => {
    useChatStore.setState({
      sessions: [meta("s1", "新会话", { kind: "local" })],
      activeSessionId: "s1",
    });
    useSpaces.setState({ activeId: null, spaces: [] });
    useChatStore.getState().syncSessionToWorkspace();
    expect(useChatStore.getState().sessions[0]?.scope).toEqual({
      kind: "local",
    });
  });

  it("空会话 + 有活跃工作区 → 重绑 scope 到 workspace（无缝进入）", () => {
    useChatStore.setState({
      sessions: [meta("s1", "新会话", { kind: "local" })],
      activeSessionId: "s1",
    });
    useSpaces.setState({
      activeId: "ws-1",
      spaces: [{ id: "ws-1", name: "root@192.168.45.200" } as never],
    });
    useChatStore.getState().syncSessionToWorkspace();
    expect(useChatStore.getState().sessions[0]?.scope).toEqual({
      kind: "workspace",
      spaceId: "ws-1",
    });
    // 仍是同一会话（未新建），activeSessionId 不变
    expect(useChatStore.getState().activeSessionId).toBe("s1");
  });

  it("SSH scope 空会话 + 活跃工作区 → 重绑（修冷启动竞态导致的卡门控）", () => {
    useChatStore.setState({
      sessions: [
        meta("s1", "新会话", { kind: "ssh", user: "root", host: "h", port: 22 }),
      ],
      activeSessionId: "s1",
    });
    useSpaces.setState({
      activeId: "ws-1",
      spaces: [{ id: "ws-1", name: "root@h" } as never],
    });
    useChatStore.getState().syncSessionToWorkspace();
    expect(useChatStore.getState().sessions[0]?.scope).toEqual({
      kind: "workspace",
      spaceId: "ws-1",
    });
  });

  it("已绑定当前工作区 → 幂等不动", () => {
    useChatStore.setState({
      sessions: [meta("s1", "对话A", { kind: "workspace", spaceId: "ws-1" })],
      activeSessionId: "s1",
    });
    useSpaces.setState({
      activeId: "ws-1",
      spaces: [{ id: "ws-1" } as never],
    });
    useChatStore.getState().syncSessionToWorkspace();
    expect(useChatStore.getState().activeSessionId).toBe("s1");
    expect(useChatStore.getState().sessions.length).toBe(1);
  });

  it("有历史会话切到别的工作区（目标无会话）→ 新建绑定新工作区会话，旧会话保留防污染", () => {
    useChatStore.setState({
      sessions: [
        meta("s1", "服务器A的对话", { kind: "workspace", spaceId: "ws-1" }),
      ],
      activeSessionId: "s1",
    });
    // s1 有消息历史（非空会话）
    seedMessages.set("s1", [
      { id: "m1", role: "user", parts: [] } as never,
    ]);
    useSpaces.setState({
      activeId: "ws-2",
      spaces: [{ id: "ws-1" } as never, { id: "ws-2" } as never],
    });
    useChatStore.getState().syncSessionToWorkspace();
    const st = useChatStore.getState();
    // 切到新建的 ws-2 会话
    expect(st.activeSessionId).not.toBe("s1");
    const newActive = st.sessions.find((s) => s.id === st.activeSessionId);
    expect(newActive?.scope).toEqual({ kind: "workspace", spaceId: "ws-2" });
    // s1 保留在 ws-1（未被重绑，防跨区污染）
    expect(st.sessions.find((s) => s.id === "s1")?.scope).toEqual({
      kind: "workspace",
      spaceId: "ws-1",
    });
  });

  it("有历史 + 目标工作区已有会话 → 切到该会话（不新建）", () => {
    useChatStore.setState({
      sessions: [
        meta("s1", "A对话", { kind: "workspace", spaceId: "ws-1" }, 1),
        meta("s2", "B对话", { kind: "workspace", spaceId: "ws-2" }, 2),
      ],
      activeSessionId: "s1",
    });
    seedMessages.set("s1", [
      { id: "m1", role: "user", parts: [] } as never,
    ]);
    useSpaces.setState({
      activeId: "ws-2",
      spaces: [{ id: "ws-1" } as never, { id: "ws-2" } as never],
    });
    // s2 有消息缓存 → switchSession 走同步 flip（否则异步 loadMessages 后才 flip）
    seedMessages.set("s2", [{ id: "m2", role: "user", parts: [] } as never]);
    useChatStore.getState().syncSessionToWorkspace();
    // 切到 ws-2 现有会话 s2（不新建）
    expect(useChatStore.getState().activeSessionId).toBe("s2");
  });
});
