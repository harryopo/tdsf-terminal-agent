import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #116（2026-09-23）：占位"新会话"跨启动复用时会带着**上次创建时**的 scope。
 *
 * 实测现场：CDP 驱动一次真实 agent 回合，模型 reasoning 写
 * 「The environment says connection_mode: none — no terminal session open」
 * 于是拒绝执行任何命令；同一时刻 sshStore 里有一条 state=connected、
 * rustSessionId=1 的活跃 SSH 会话。那条对话 createdAt=08:12（那会儿没连服务器），
 * 13:04 被 hydrate 复用 —— scope={kind:"local"} 从未重算，
 * chatRuntime 见 isLocalScope 就把可见 SSH 掩成"无终端"。
 *
 * 所以这里钉的不变量是：**还没写过消息的占位会话，环境口径必须跟上当前环境**；
 * 已经有消息的会话不许改（不改写历史的归属）。
 */

const mocks = vi.hoisted(() => ({
  loadPersistedSpaces: vi.fn(),
  loadAll: vi.fn(async () => ({ sessions: [] as unknown[], activeId: null })),
  saveSessionsList: vi.fn(async () => {}),
  saveActiveId: vi.fn(async () => {}),
}));

vi.mock("../lib/sessions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/sessions")>();
  return {
    ...actual,
    loadAll: mocks.loadAll,
    saveSessionsList: mocks.saveSessionsList,
    saveActiveId: mocks.saveActiveId,
    loadMessages: vi.fn(async () => [] as unknown[]),
    saveMessages: vi.fn(async () => {}),
  };
});

vi.mock("@/modules/spaces/lib/store", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/modules/spaces/lib/store")
  >();
  return { ...actual, loadAll: mocks.loadPersistedSpaces };
});

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

import { useSpaces, type SpaceMeta } from "@/modules/spaces";
import {
  useSshStore,
  type SshSessionInfo,
} from "@/modules/ssh-explorer/sshStore";
import type { SessionMeta } from "../lib/sessions";
import { useChatStore } from "./chatStore";

function placeholder(
  id: string,
  scope: SessionMeta["scope"],
  title = "新会话",
): SessionMeta {
  return { id, title, createdAt: 1000, updatedAt: 1000, scope };
}

function connectedSsh(
  id: string,
  rustSessionId: number,
  host: string,
): SshSessionInfo {
  return {
    id,
    rustSessionId,
    params: { host, port: 22, user: "root", cols: 80, rows: 24 },
    state: "connected",
    connectedAt: 5,
    handle: "h",
    autoConnect: false,
    error: null,
  } as unknown as SshSessionInfo;
}

function localSpace(id: string, root: string): SpaceMeta {
  return {
    id,
    name: id,
    root,
    env: { kind: "local" },
    createdAt: 1,
    updatedAt: 1,
  } as SpaceMeta;
}

beforeEach(() => {
  vi.clearAllMocks();
  useChatStore.setState({
    sessions: [],
    activeSessionId: null,
    sessionsHydrated: false,
  });
  useSpaces.setState({ spaces: [], activeId: null, hydrated: true });
  useSshStore.setState({
    sessions: [],
    activeSessionId: null,
    savedConnections: [],
  });
  mocks.loadPersistedSpaces.mockResolvedValue({
    spaces: [],
    activeId: null,
    states: new Map(),
  });
});

describe("hydrateSessions 复用占位会话时重算 scope（#116）", () => {
  it("占位会话上次是 local、现在有已连接 SSH → scope 升级成那台服务器", async () => {
    mocks.loadAll.mockResolvedValue({
      sessions: [placeholder("s-old", { kind: "local" })],
      activeId: "s-old",
    });
    useSshStore.setState({
      sessions: [connectedSsh("uuid-1", 7, "192.168.45.200")],
      activeSessionId: "uuid-1",
    });

    await useChatStore.getState().hydrateSessions();

    const s = useChatStore
      .getState()
      .sessions.find((x) => x.id === "s-old");
    expect(s?.scope).toEqual({
      kind: "ssh",
      user: "root",
      host: "192.168.45.200",
      port: 22,
    });
    // 正向配对：复用的还是那一条（不是新建了一条把旧的顶掉）
    expect(useChatStore.getState().activeSessionId).toBe("s-old");
    expect(useChatStore.getState().sessions).toHaveLength(1);
  });

  it("重算后的 scope 必须落盘，否则下次启动又读回旧标签", async () => {
    mocks.loadAll.mockResolvedValue({
      sessions: [placeholder("s-old", { kind: "local" })],
      activeId: "s-old",
    });
    useSshStore.setState({
      sessions: [connectedSsh("uuid-1", 7, "192.168.45.200")],
      activeSessionId: "uuid-1",
    });

    await useChatStore.getState().hydrateSessions();

    expect(mocks.saveSessionsList).toHaveBeenCalledTimes(1);
    const saved = mocks.saveSessionsList.mock.calls[0][0] as SessionMeta[];
    expect(saved[0]?.scope).toMatchObject({ kind: "ssh", host: "192.168.45.200" });
  });

  it("当前没有已连接会话 → 占位保持 local（不许无中生有造绑定）", async () => {
    mocks.loadAll.mockResolvedValue({
      sessions: [placeholder("s-old", { kind: "local" })],
      activeId: "s-old",
    });

    await useChatStore.getState().hydrateSessions();

    expect(useChatStore.getState().sessions[0]?.scope).toEqual({
      kind: "local",
    });
    expect(mocks.saveSessionsList).not.toHaveBeenCalled();
  });

  it("活跃工作区存在时，占位按工作区口径绑定（不是 local 也不是裸 SSH）", async () => {
    mocks.loadAll.mockResolvedValue({
      sessions: [placeholder("s-old", { kind: "local" })],
      activeId: "s-old",
    });
    useSpaces.setState({
      spaces: [localSpace("sp-1", "D:/proj")],
      activeId: "sp-1",
    });

    await useChatStore.getState().hydrateSessions();

    expect(useChatStore.getState().sessions[0]?.scope).toEqual({
      kind: "workspace",
      spaceId: "sp-1",
    });
  });

  it("已有消息的会话不被改判；新建的占位按当前环境绑定", async () => {
    const used = placeholder("s-used", { kind: "local" }, "刚才那句问话");
    mocks.loadAll.mockResolvedValue({
      sessions: [used],
      activeId: "s-used",
    });
    useSshStore.setState({
      sessions: [connectedSsh("uuid-1", 7, "192.168.45.200")],
      activeSessionId: "uuid-1",
    });

    await useChatStore.getState().hydrateSessions();

    const { sessions, activeSessionId } = useChatStore.getState();
    // 正向配对：确实新建了一条并激活它（不是因为"啥也没发生"才没改旧的）
    expect(sessions).toHaveLength(2);
    expect(activeSessionId).not.toBe("s-used");
    // 新占位按当前环境绑定
    expect(sessions.find((s) => s.id === activeSessionId)?.scope).toMatchObject({
      kind: "ssh",
      host: "192.168.45.200",
    });
    // 旧会话的归属不许被改写
    expect(sessions.find((s) => s.id === "s-used")?.scope).toEqual({
      kind: "local",
    });
  });

  it("未连接的 SSH 会话不算绑定（断线期间仍按当前环境判）", async () => {
    mocks.loadAll.mockResolvedValue({
      sessions: [placeholder("s-old", { kind: "local" })],
      activeId: "s-old",
    });
    const down = {
      ...connectedSsh("uuid-1", 7, "192.168.45.200"),
      state: "disconnected",
    } as SshSessionInfo;
    useSshStore.setState({ sessions: [down], activeSessionId: "uuid-1" });

    await useChatStore.getState().hydrateSessions();

    expect(useChatStore.getState().sessions[0]?.scope).toEqual({
      kind: "local",
    });
  });
});
