import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPersistedSpaces: vi.fn(),
  toastError: vi.fn(),
  loadMessages: vi.fn(async () => [] as unknown[]),
}));

vi.mock("../lib/sessions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/sessions")>();
  return {
    ...actual,
    saveSessionsList: vi.fn(async () => {}),
    saveActiveId: vi.fn(async () => {}),
    saveMessages: vi.fn(async () => {}),
    loadMessages: mocks.loadMessages,
    loadAll: vi.fn(async () => ({ sessions: [], activeId: null })),
  };
});

vi.mock("@/modules/spaces/lib/store", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/modules/spaces/lib/store")
  >();
  return { ...actual, loadAll: mocks.loadPersistedSpaces };
});

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

import type { SshCredentialProfile } from "@/lib/ssh-bridge";
import { useSpaces } from "@/modules/spaces";
import type { SpaceMeta } from "@/modules/spaces/lib/store";
import { useSshStore } from "@/modules/ssh-explorer/sshStore";
import type { SessionMeta } from "../lib/sessions";
import {
  __resetAutoTypeProvenance,
  isLiveMessage,
} from "../lib/autoTypeProvenance";
import {
  chats,
  seedMessages,
  sessionsVisibleInWorkspace,
  useChatStore,
} from "./chatStore";

function meta(
  id: string,
  scope: SessionMeta["scope"],
  updatedAt = 1,
): SessionMeta {
  return { id, title: id, createdAt: updatedAt, updatedAt, scope };
}

function sshSpace(
  id: string,
  host: string,
  user = "root",
  port = 22,
): SpaceMeta {
  return {
    id,
    name: `${user}@${host}`,
    root: `/home/${user}`,
    env: {
      kind: "ssh",
      host,
      user,
      port,
      label: `${user}@${host}`,
    },
    createdAt: 1,
    updatedAt: 1,
  };
}

const profile: SshCredentialProfile = {
  id: "profile-stable-id",
  alias: "Production",
  host: "server.example",
  port: 2222,
  user: "ops",
  auth: { type: "password" },
  lastUsed: 1,
  createdAt: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
  chats.clear();
  seedMessages.clear();
  useChatStore.setState({ sessions: [], activeSessionId: null });
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

describe("SSH-bound conversation history", () => {
  it("persists an SSH server identity instead of an ephemeral workspace id", () => {
    useSpaces.setState({
      spaces: [sshSpace("ws-ssh", "server.example", "ops", 2222)],
      activeId: "ws-ssh",
    });

    const id = useChatStore.getState().newSession();

    expect(useChatStore.getState().sessions.find((s) => s.id === id)?.scope)
      .toEqual({
        kind: "ssh",
        host: "server.example",
        user: "ops",
        port: 2222,
      });
  });

  it("shows every conversation for the active server across stable scopes", () => {
    const spaces = [
      sshSpace("ws-current", "server.example", "ops", 2222),
      sshSpace("ws-alias", "server.example", "ops", 2222),
      sshSpace("ws-other", "other.example", "ops", 2222),
    ];
    const sessions = [
      meta("current-workspace", { kind: "workspace", spaceId: "ws-current" }),
      meta("same-server", {
        kind: "ssh",
        host: "server.example",
        user: "ops",
        port: 2222,
      }),
      meta("same-server-old-workspace", {
        kind: "workspace",
        spaceId: "ws-alias",
      }),
      meta("other-server", { kind: "workspace", spaceId: "ws-other" }),
      meta("local", { kind: "local" }),
    ];

    expect(
      sessionsVisibleInWorkspace(sessions, spaces, "ws-current").map(
        (session) => session.id,
      ),
    ).toEqual([
      "current-workspace",
      "same-server",
      "same-server-old-workspace",
    ]);
  });

  it("connects with the exact saved profile before activating history", async () => {
    const current = meta("current", { kind: "local" });
    const target = meta("target", {
      kind: "ssh",
      host: profile.host,
      user: profile.user,
      port: profile.port,
    });
    seedMessages.set("target", []);
    useChatStore.setState({
      sessions: [current, target],
      activeSessionId: current.id,
    });
    const loadSavedConnections = vi.fn(async () => {
      useSshStore.setState({ savedConnections: [profile] });
    });
    const connectWithSaved = vi.fn(async () => "ssh-runtime-id");
    useSshStore.setState({ loadSavedConnections, connectWithSaved });

    await expect(useChatStore.getState().openSession(target.id)).resolves.toBe(
      true,
    );

    expect(loadSavedConnections).toHaveBeenCalledOnce();
    expect(connectWithSaved).toHaveBeenCalledWith(profile);
    expect(useChatStore.getState().activeSessionId).toBe(target.id);
  });

  it("restores every persisted history for the connected server", async () => {
    const current = meta("current", { kind: "local" });
    const target = meta("target", {
      kind: "ssh",
      host: profile.host,
      user: profile.user,
      port: profile.port,
    });
    const legacy = meta("legacy", {
      kind: "workspace",
      spaceId: "ws-legacy",
    });
    seedMessages.set(target.id, []);
    useChatStore.setState({
      sessions: [current, target, legacy],
      activeSessionId: current.id,
    });
    mocks.loadPersistedSpaces.mockResolvedValue({
      spaces: [
        sshSpace("ws-legacy", profile.host, profile.user, profile.port),
      ],
      activeId: null,
      states: new Map(),
    });
    const loadSavedConnections = vi.fn(async () => {
      useSshStore.setState({ savedConnections: [profile] });
    });
    const connectWithSaved = vi.fn(async () => "ssh-runtime-id");
    useSshStore.setState({ loadSavedConnections, connectWithSaved });

    await expect(useChatStore.getState().openSession(target.id)).resolves.toBe(
      true,
    );

    expect(mocks.loadPersistedSpaces).toHaveBeenCalledOnce();
    expect(useChatStore.getState().sessions.find((s) => s.id === legacy.id)?.scope)
      .toEqual({
        kind: "ssh",
        host: profile.host,
        user: profile.user,
        port: profile.port,
      });
  });

  it("keeps the current conversation active when reconnecting fails", async () => {
    const current = meta("current", { kind: "local" });
    const target = meta("target", {
      kind: "ssh",
      host: profile.host,
      user: profile.user,
      port: profile.port,
    });
    useChatStore.setState({
      sessions: [current, target],
      activeSessionId: current.id,
    });
    const loadSavedConnections = vi.fn(async () => {
      useSshStore.setState({ savedConnections: [profile] });
    });
    const connectWithSaved = vi.fn(async () => null);
    useSshStore.setState({ loadSavedConnections, connectWithSaved });

    await expect(useChatStore.getState().openSession(target.id)).resolves.toBe(
      false,
    );

    expect(useChatStore.getState().activeSessionId).toBe(current.id);
  });

  it("waits for the target server when another SSH workspace is active", async () => {
    const current = meta("current", {
      kind: "ssh",
      host: "other.example",
      user: "ops",
      port: 22,
    });
    const target = meta("target", {
      kind: "ssh",
      host: profile.host,
      user: profile.user,
      port: profile.port,
    });
    seedMessages.set(target.id, []);
    useChatStore.setState({
      sessions: [current, target],
      activeSessionId: current.id,
    });
    useSpaces.setState({
      spaces: [sshSpace("ws-other", "other.example", "ops", 22)],
      activeId: "ws-other",
    });
    const loadSavedConnections = vi.fn(async () => {
      useSshStore.setState({ savedConnections: [profile] });
    });
    let finishConnect: (sessionId: string | null) => void = () => {};
    const connectWithSaved = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          finishConnect = resolve;
        }),
    );
    useSshStore.setState({ loadSavedConnections, connectWithSaved });

    const opening = useChatStore.getState().openSession(target.id);
    await vi.waitFor(() =>
      expect(connectWithSaved).toHaveBeenCalledWith(profile),
    );

    expect(useChatStore.getState().activeSessionId).toBe(current.id);
    finishConnect("ssh-runtime-id");
    await expect(opening).resolves.toBe(true);
    expect(useChatStore.getState().activeSessionId).toBe(target.id);
  });

  it("keeps the current conversation when switching from another SSH server fails", async () => {
    const current = meta("current", {
      kind: "ssh",
      host: "other.example",
      user: "ops",
      port: 22,
    });
    const target = meta("target", {
      kind: "ssh",
      host: profile.host,
      user: profile.user,
      port: profile.port,
    });
    useChatStore.setState({
      sessions: [current, target],
      activeSessionId: current.id,
    });
    useSpaces.setState({
      spaces: [sshSpace("ws-other", "other.example", "ops", 22)],
      activeId: "ws-other",
    });
    const loadSavedConnections = vi.fn(async () => {
      useSshStore.setState({ savedConnections: [profile] });
    });
    const connectWithSaved = vi.fn(async () => null);
    useSshStore.setState({ loadSavedConnections, connectWithSaved });

    await expect(useChatStore.getState().openSession(target.id)).resolves.toBe(
      false,
    );

    expect(connectWithSaved).toHaveBeenCalledWith(profile);
    expect(useChatStore.getState().activeSessionId).toBe(current.id);
  });

  it("opens same-server history without reconnecting", async () => {
    const current = meta("current", {
      kind: "ssh",
      host: profile.host,
      user: profile.user,
      port: profile.port,
    });
    const target = meta("target", {
      kind: "workspace",
      spaceId: "ws-alias",
    });
    seedMessages.set(target.id, []);
    useChatStore.setState({
      sessions: [current, target],
      activeSessionId: current.id,
    });
    useSpaces.setState({
      spaces: [
        sshSpace("ws-current", profile.host, profile.user, profile.port),
        sshSpace("ws-alias", profile.host, profile.user, profile.port),
      ],
      activeId: "ws-current",
    });
    const loadSavedConnections = vi.fn(async () => {});
    const connectWithSaved = vi.fn(async () => null);
    useSshStore.setState({ loadSavedConnections, connectWithSaved });

    await expect(useChatStore.getState().openSession(target.id)).resolves.toBe(
      true,
    );

    expect(loadSavedConnections).not.toHaveBeenCalled();
    expect(connectWithSaved).not.toHaveBeenCalled();
    expect(useChatStore.getState().activeSessionId).toBe(target.id);
    expect(useChatStore.getState().sessions.find((s) => s.id === target.id)?.scope)
      .toEqual({
        kind: "ssh",
        host: profile.host,
        user: profile.user,
        port: profile.port,
      });
  });

  it("does not open history from a different local workspace", async () => {
    const current = meta("current", {
      kind: "workspace",
      spaceId: "ws-current",
    });
    const target = meta("target", {
      kind: "workspace",
      spaceId: "ws-other",
    });
    useChatStore.setState({
      sessions: [current, target],
      activeSessionId: current.id,
    });
    useSpaces.setState({
      spaces: [
        { id: "ws-current" } as SpaceMeta,
        { id: "ws-other" } as SpaceMeta,
      ],
      activeId: "ws-current",
    });

    await expect(useChatStore.getState().openSession(target.id)).resolves.toBe(
      false,
    );

    expect(useChatStore.getState().activeSessionId).toBe(current.id);
  });

  it("reports a missing exact profile without fabricating a connection", async () => {
    const current = meta("current", { kind: "local" });
    const target = meta("target", {
      kind: "ssh",
      host: profile.host,
      user: profile.user,
      port: profile.port,
    });
    useChatStore.setState({
      sessions: [current, target],
      activeSessionId: current.id,
    });
    const loadSavedConnections = vi.fn(async () => {
      useSshStore.setState({
        savedConnections: [{ ...profile, port: 22 }],
      });
    });
    const connectWithSaved = vi.fn(async () => "should-not-connect");
    useSshStore.setState({ loadSavedConnections, connectWithSaved });

    await expect(useChatStore.getState().openSession(target.id)).resolves.toBe(
      false,
    );

    expect(connectWithSaved).not.toHaveBeenCalled();
    expect(mocks.toastError).toHaveBeenCalledWith(
      "无法恢复服务器会话",
      expect.objectContaining({
        description: expect.stringContaining("ops@server.example:2222"),
      }),
    );
    expect(useChatStore.getState().activeSessionId).toBe(current.id);
  });

  it("keeps the existing local-history switch behavior", async () => {
    const current = meta("current", { kind: "local" });
    const target = meta("target", { kind: "local" });
    seedMessages.set(target.id, []);
    useChatStore.setState({
      sessions: [current, target],
      activeSessionId: current.id,
    });
    const loadSavedConnections = vi.fn(async () => {});
    const connectWithSaved = vi.fn(async () => null);
    useSshStore.setState({ loadSavedConnections, connectWithSaved });

    await expect(useChatStore.getState().openSession(target.id)).resolves.toBe(
      true,
    );

    expect(loadSavedConnections).not.toHaveBeenCalled();
    expect(connectWithSaved).not.toHaveBeenCalled();
    expect(useChatStore.getState().activeSessionId).toBe(target.id);
  });

  it("resolves an orphaned workspace scope through persisted workspace metadata", async () => {
    const current = meta("current", { kind: "local" });
    const target = meta("target", {
      kind: "workspace",
      spaceId: "remembered-workspace",
    });
    seedMessages.set("target", []);
    useChatStore.setState({
      sessions: [current, target],
      activeSessionId: current.id,
    });
    mocks.loadPersistedSpaces.mockResolvedValue({
      spaces: [
        sshSpace(
          "remembered-workspace",
          profile.host,
          profile.user,
          profile.port,
        ),
      ],
      activeId: null,
      states: new Map(),
    });
    const loadSavedConnections = vi.fn(async () => {
      useSshStore.setState({ savedConnections: [profile] });
    });
    const connectWithSaved = vi.fn(async () => "ssh-runtime-id");
    useSshStore.setState({ loadSavedConnections, connectWithSaved });

    await expect(useChatStore.getState().openSession(target.id)).resolves.toBe(
      true,
    );

    expect(mocks.loadPersistedSpaces).toHaveBeenCalledOnce();
    expect(connectWithSaved).toHaveBeenCalledWith(profile);
    expect(
      useChatStore.getState().sessions.find((s) => s.id === target.id)?.scope,
    )
      .toEqual({
        kind: "ssh",
        host: profile.host,
        user: profile.user,
        port: profile.port,
      });
    expect(useChatStore.getState().activeSessionId).toBe(target.id);
  });

  // ==========================================================================
  // 出身登记（2026-09-21）：从盘上读回来的消息在这里进 UI，也必须在这里被记住
  // --------------------------------------------------------------------------
  // 命令卡的自动打字只允许发生在"本次运行生成的消息"上。switchSession 是持久化
  // 消息进入界面的唯一入口（loadMessages 的另一处调用只做记忆沉淀，不进 UI），
  // 所以登记必须钉在这里——漏一次，冷启动打开历史对话就会重放旧命令。
  // ==========================================================================
  it("marks persisted messages as restored so their command cards never auto-type", async () => {
    __resetAutoTypeProvenance();
    const current = meta("current", { kind: "local" });
    const target = meta("target", { kind: "local" });
    useChatStore.setState({
      sessions: [current, target],
      activeSessionId: current.id,
    });
    mocks.loadMessages.mockResolvedValueOnce([
      { id: "old-user", role: "user", parts: [] },
      { id: "old-assistant", role: "assistant", parts: [] },
    ]);

    useChatStore.getState().switchSession(target.id);

    await vi.waitFor(() =>
      expect(useChatStore.getState().activeSessionId).toBe(target.id),
    );
    expect(isLiveMessage("old-user")).toBe(false);
    expect(isLiveMessage("old-assistant")).toBe(false);
    // 配对正向断言：本次运行里新产生的消息（未登记）仍然是 live
    expect(isLiveMessage("brand-new-message")).toBe(true);
  });
});
