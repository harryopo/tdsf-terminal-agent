import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  // 返回类型必须写出来：不写的话 TS 按**第一次** mockResolvedValue 的形状
  // （activeId: null）把签名钉死，后面任何用例给 activeId 赋字符串都报红。
  loadAll: vi.fn(
    async (): Promise<{ sessions: SessionMeta[]; activeId: string | null }> => ({
      sessions: [],
      activeId: null,
    }),
  ),
  saveSessionsList: vi.fn(async (_sessions: SessionMeta[]) => {}),
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
import { seedMessages, useChatStore } from "./chatStore";

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
    const down: SshSessionInfo = {
      ...connectedSsh("uuid-1", 7, "192.168.45.200"),
      // 状态机里没有 "disconnected"，未连接就是 "idle"
      state: "idle",
    };
    useSshStore.setState({ sessions: [down], activeSessionId: "uuid-1" });

    await useChatStore.getState().hydrateSessions();

    expect(useChatStore.getState().sessions[0]?.scope).toEqual({
      kind: "local",
    });
  });
});

/**
 * #116 续（2026-09-23 第二次实测）：上面那轮只补了「跨启动复用」这一半，
 * 冷启动这一半当时没抓到 —— 因为量具本身就是错的（把 store api 当状态读，
 * 读出 sessions: []）。真实现场是：13:45 冷启动 → hydrateSessions 先跑，
 * 启动自动连接**后**到，所以那条「新会话」的 scope 必然停在 {kind:"local"}，
 * 而 sshStore 随后就有了 connected 的会话。⇒ **每次冷启动的第一个对话都认不出服务器**，
 * 与用户有没有手动新建对话无关。所以重算的时刻必须是"要用它的时候"，不能只有"启动的时候"。
 */
describe("空占位在开跑前重算环境口径（#116 续：hydrate 早于自动连接）", () => {
  beforeEach(() => {
    useChatStore.setState({
      sessions: [placeholder("s-new", { kind: "local" })],
      activeSessionId: "s-new",
      sessionsHydrated: true,
    });
  });

  it("连接在 hydrate 之后才建立 → 重算后占位升级到那台服务器并落盘", () => {
    useSshStore.setState({
      sessions: [connectedSsh("uuid-1", 7, "192.168.45.200")],
      activeSessionId: "uuid-1",
    });

    const changed = useChatStore.getState().rebindEmptySessionScope();

    expect(changed).toBe(true);
    expect(useChatStore.getState().sessions[0]?.scope).toEqual({
      kind: "ssh",
      user: "root",
      host: "192.168.45.200",
      port: 22,
    });
    expect(mocks.saveSessionsList).toHaveBeenCalledTimes(1);
  });

  it("口径已经是新的 → 不写盘（不为了刷新而空转一次持久化）", () => {
    useSshStore.setState({
      sessions: [connectedSsh("uuid-1", 7, "192.168.45.200")],
      activeSessionId: "uuid-1",
    });
    useChatStore.setState({
      sessions: [
        placeholder("s-new", {
          kind: "ssh",
          user: "root",
          host: "192.168.45.200",
          port: 22,
        }),
      ],
    });

    expect(useChatStore.getState().rebindEmptySessionScope()).toBe(false);
    expect(mocks.saveSessionsList).not.toHaveBeenCalled();
  });

  it("已经说过话的会话不许重绑（A1 隔离：归属是历史事实）", () => {
    seedMessages.set("s-new", [
      { id: "m1", role: "user", parts: [{ type: "text", text: "刚才那句" }] },
    ] as never);
    useSshStore.setState({
      sessions: [connectedSsh("uuid-1", 7, "192.168.45.200")],
      activeSessionId: "uuid-1",
    });

    expect(useChatStore.getState().rebindEmptySessionScope()).toBe(false);
    expect(mocks.saveSessionsList).not.toHaveBeenCalled();
    // 正向配对：不是"什么都没测到"，是这条被明确跳过了
    expect(useChatStore.getState().sessions[0]?.scope).toEqual({
      kind: "local",
    });
    seedMessages.delete("s-new");
  });

  it("没连服务器也没工作区 → 保持 local，不无中生有", () => {
    expect(useChatStore.getState().rebindEmptySessionScope()).toBe(false);
    expect(useChatStore.getState().sessions[0]?.scope).toEqual({
      kind: "local",
    });
  });
});

/**
 * 接线钉：上面那条"开跑前重算"的实际生效点在 chatRuntime.sendMessage()，
 * 而 chatRuntime 装了 @ai-sdk 的 Chat 构造，单元层测不到它。删掉那一行
 * 上面所有用例仍然全绿 —— 所以按本仓既有做法（静态扫描型门禁）钉住顺序。
 * 判据形状照 retired-remote-tree / ipcWorkspaceEnv：锚点必须存在且唯一，
 * 找不到就抛错，绝不"没扫到 = 通过"。
 */
describe("sendMessage 在取环境快照前重算占位 scope（接线）", () => {
  it("chatRuntime.sendMessage 里 rebind 必须出现在 getOrCreateChat 之前", () => {
    const src = readFileSync(
      join(process.cwd(), "src/modules/ai/store/chatRuntime.ts"),
      "utf8",
    );
    const start = src.indexOf("export async function sendMessage(");
    expect(start, "找不到 sendMessage，门禁失效").toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}", start) + 2);
    const rebind = body.indexOf("rebindEmptySessionScope()");
    const chat = body.indexOf("getOrCreateChat(sessionId)");
    expect(rebind, "sendMessage 里不再重算占位 scope —— #116 会复发").toBeGreaterThan(
      -1,
    );
    expect(chat).toBeGreaterThan(-1);
    expect(rebind).toBeLessThan(chat);
  });
});
