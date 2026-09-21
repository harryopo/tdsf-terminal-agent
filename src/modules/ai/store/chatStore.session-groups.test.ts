/**
 * chatStore.session-groups.test.ts — #65 会话按「连接对象」归组（2026-09-20）
 *
 * 背景：工作区记录 id 是易逝的（删掉重建即换新 id），早期生命周期还会整键
 * 覆写注册表，结果用户机器上 22 条对话失去入口——它们的 scope 指向已经不
 * 存在的工作区，或压根没有 scope。本文件钉住三件事：
 *   1. 归组键来自稳定身份（服务器 user@host:port / 本地目录），不来自 spaceId
 *   2. 解析不出身份的进「未归属」，且该组永远排在最后、可以打开
 *   3. 打开只补绑定，不删除任何历史
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  loadPersistedSpaces: vi.fn(),
  saveSessionsList: vi.fn(async () => {}),
  toastError: vi.fn(),
}));

vi.mock("../lib/sessions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/sessions")>();
  return {
    ...actual,
    saveSessionsList: mocks.saveSessionsList,
    saveActiveId: vi.fn(async () => {}),
    saveMessages: vi.fn(async () => {}),
    loadMessages: vi.fn(async () => []),
    loadAll: vi.fn(async () => ({ sessions: [], activeId: null })),
  };
});

vi.mock("@/modules/spaces/lib/store", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/modules/spaces/lib/store")>();
  return { ...actual, loadAll: mocks.loadPersistedSpaces };
});

vi.mock("sonner", () => ({
  toast: {
    error: mocks.toastError,
    success: vi.fn(),
    warning: vi.fn(),
  },
}));

import { useSpaces } from "@/modules/spaces";
import type { SpaceMeta } from "@/modules/spaces/lib/store";
import { useSshStore } from "@/modules/ssh-explorer/sshStore";
import type { SessionMeta } from "../lib/sessions";
import {
  chats,
  groupSessionsByConnection,
  seedMessages,
  sessionGroupKeyOf,
  sessionsVisibleInWorkspace,
  UNGROUPED_KEY,
  useChatStore,
} from "./chatStore";

function meta(
  id: string,
  scope: SessionMeta["scope"],
  updatedAt = 1,
): SessionMeta {
  return { id, title: id, createdAt: updatedAt, updatedAt, scope };
}

function space(id: string, root: string | null, name?: string): SpaceMeta {
  return {
    id,
    name: name ?? id,
    root,
    env: { kind: "local" },
    createdAt: 1,
    updatedAt: 1,
  };
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
    env: { kind: "ssh", host, user, port, label: `${user}@${host}` },
    createdAt: 1,
    updatedAt: 1,
  };
}

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

describe("#65 归组键", () => {
  it("同一台服务器的两个工作区算同一组，服务器身份不同的不算", () => {
    const spaces = [
      sshSpace("ws-a", "10.0.0.8"),
      sshSpace("ws-b", "10.0.0.8", "root", 22),
      sshSpace("ws-c", "10.0.0.9"),
    ];
    const sameAsA = sessionGroupKeyOf(
      meta("s1", { kind: "workspace", spaceId: "ws-a" }),
      spaces,
    );

    expect(sameAsA).toBe("ssh:root@10.0.0.8:22");
    expect(
      sessionGroupKeyOf(
        meta("s2", { kind: "ssh", user: "root", host: "10.0.0.8", port: 22 }),
        spaces,
      ),
    ).toBe(sameAsA);
    expect(
      sessionGroupKeyOf(
        meta("s3", { kind: "workspace", spaceId: "ws-c" }),
        spaces,
      ),
    ).not.toBe(sameAsA);
  });

  it("端口不同的同一主机不算同一组", () => {
    const spaces = [sshSpace("ws-2222", "10.0.0.8", "root", 2222)];
    expect(
      sessionGroupKeyOf(
        meta("s1", { kind: "workspace", spaceId: "ws-2222" }),
        spaces,
      ),
    ).toBe("ssh:root@10.0.0.8:2222");
  });

  it("同一目录的两个本地工作区算同一组，目录大小写/尾斜杠不影响", () => {
    const spaces = [
      space("ws-1", "D:/ai/proj"),
      space("ws-2", "D:\\ai\\proj\\"),
    ];
    const keyOf = (spaceId: string) =>
      sessionGroupKeyOf(meta("s", { kind: "workspace", spaceId }), spaces);

    expect(keyOf("ws-1")).toBe("local:d:/ai/proj");
    expect(keyOf("ws-2")).toBe(keyOf("ws-1"));
  });

  it("WSL 与本机终端下的同名目录不算同一组（不是同一台机器）", () => {
    const spaces: SpaceMeta[] = [
      space("ws-local", "/home/me/app"),
      {
        ...space("ws-wsl", "/home/me/app"),
        env: { kind: "wsl", distro: "Ubuntu" },
      },
    ];
    const localKey = sessionGroupKeyOf(
      meta("a", { kind: "workspace", spaceId: "ws-local" }),
      spaces,
    );
    const wslKey = sessionGroupKeyOf(
      meta("b", { kind: "workspace", spaceId: "ws-wsl" }),
      spaces,
    );

    expect(localKey).toBe("local:/home/me/app");
    expect(wslKey).toBe("wsl:ubuntu:/home/me/app");
  });

  it("工作区已消失 / 无 scope / 仅 local scope 都进未归属", () => {
    const gone = meta("gone", { kind: "workspace", spaceId: "ws-deleted" }, 5);
    const noScope = meta("no-scope", undefined, 4);
    const localOnly = meta("local", { kind: "local" }, 3);

    for (const session of [gone, noScope, localOnly]) {
      expect(sessionGroupKeyOf(session, [])).toBe(UNGROUPED_KEY);
    }
  });

  it("拿不到目录的残缺工作区退回按工作区区分，不并组", () => {
    const spaces = [{ id: "ws-x" } as SpaceMeta, { id: "ws-y" } as SpaceMeta];
    const kx = sessionGroupKeyOf(
      meta("sx", { kind: "workspace", spaceId: "ws-x" }),
      spaces,
    );
    const ky = sessionGroupKeyOf(
      meta("sy", { kind: "workspace", spaceId: "ws-y" }),
      spaces,
    );

    expect(kx).toBe("space:ws-x");
    expect(ky).not.toBe(kx);
  });
});

describe("#65 分组列表", () => {
  it("当前组在最前，未归属永远压轴，其余按最近活动", () => {
    const spaces = [
      space("ws-current", "/home/me/current"),
      space("ws-other", "/home/me/other"),
      sshSpace("ws-ssh", "10.0.0.8"),
    ];
    const sessions = [
      meta("orphan", { kind: "workspace", spaceId: "ws-deleted" }, 99),
      meta("cur-old", { kind: "workspace", spaceId: "ws-current" }, 1),
      meta("ssh", { kind: "workspace", spaceId: "ws-ssh" }, 50),
      meta("cur-new", { kind: "workspace", spaceId: "ws-current" }, 80),
      meta("other", { kind: "workspace", spaceId: "ws-other" }, 60),
    ];

    const groups = groupSessionsByConnection(sessions, spaces, "ws-current");

    expect(groups.map((g) => g.key)).toEqual([
      "local:/home/me/current",
      "local:/home/me/other",
      "ssh:root@10.0.0.8:22",
      UNGROUPED_KEY,
    ]);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["cur-new", "cur-old"]);
    expect(groups[0].label).toBe("current");
    expect(groups[0].detail).toBe("/home/me/current");
    expect(groups.at(-1)?.label).toBe("未归属");
    expect(groups.at(-1)?.sessions.map((s) => s.id)).toEqual(["orphan"]);
  });

  it("无活跃工作区时也要把未归属列出来（22 条历史对话的入口）", () => {
    const groups = groupSessionsByConnection(
      [meta("a", undefined, 2), meta("b", { kind: "local" }, 1)],
      [],
      null,
    );

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe(UNGROUPED_KEY);
    expect(groups[0].sessions.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("同目录的另一个工作区现在也算当前可见", () => {
    const spaces = [space("ws-1", "/srv/app"), space("ws-2", "/srv/app")];
    const visible = sessionsVisibleInWorkspace(
      [
        meta("from-ws1", { kind: "workspace", spaceId: "ws-1" }),
        meta("from-ws2", { kind: "workspace", spaceId: "ws-2" }),
        meta("elsewhere", { kind: "workspace", spaceId: "ws-3" }, 1),
      ],
      spaces,
      "ws-2",
    );

    expect(visible.map((s) => s.id)).toEqual(["from-ws1", "from-ws2"]);
  });
});

describe("#65 打开未归属对话", () => {
  it("有活跃工作区时也能打开，并只补绑定（不删任何会话）", async () => {
    const current = meta("cur", { kind: "workspace", spaceId: "ws-1" });
    const orphan = meta("orphan", { kind: "workspace", spaceId: "ws-gone" }, 9);
    seedMessages.set("orphan", []);
    useChatStore.setState({
      sessions: [current, orphan],
      activeSessionId: current.id,
    });
    useSpaces.setState({
      spaces: [space("ws-1", "/srv/app")],
      activeId: "ws-1",
    });

    await expect(useChatStore.getState().openSession("orphan")).resolves.toBe(
      true,
    );

    const state = useChatStore.getState();
    expect(state.activeSessionId).toBe("orphan");
    expect(state.sessions).toHaveLength(2);
    expect(state.sessions.find((s) => s.id === "cur")?.scope).toEqual({
      kind: "workspace",
      spaceId: "ws-1",
    });
    expect(state.sessions.find((s) => s.id === "orphan")?.scope).toEqual({
      kind: "workspace",
      spaceId: "ws-1",
    });
    expect(mocks.saveSessionsList).toHaveBeenCalledOnce();
  });

  it("另一个本地工作区的对话仍然打不开（防跨区污染）", async () => {
    useChatStore.setState({
      sessions: [
        meta("cur", { kind: "workspace", spaceId: "ws-1" }),
        meta("other", { kind: "workspace", spaceId: "ws-2" }),
      ],
      activeSessionId: "cur",
    });
    useSpaces.setState({
      spaces: [space("ws-1", "/srv/a"), space("ws-2", "/srv/b")],
      activeId: "ws-1",
    });

    await expect(useChatStore.getState().openSession("other")).resolves.toBe(
      false,
    );
    expect(useChatStore.getState().activeSessionId).toBe("cur");
    expect(mocks.saveSessionsList).not.toHaveBeenCalled();
  });

  it("同目录的另一个工作区可以打开（归组即按目录）", async () => {
    useChatStore.setState({
      sessions: [
        meta("cur", { kind: "workspace", spaceId: "ws-1" }),
        meta("twin", { kind: "workspace", spaceId: "ws-2" }),
      ],
      activeSessionId: "cur",
    });
    useSpaces.setState({
      spaces: [space("ws-1", "/srv/a"), space("ws-2", "/srv/a/")],
      activeId: "ws-1",
    });
    seedMessages.set("twin", []);

    await expect(useChatStore.getState().openSession("twin")).resolves.toBe(
      true,
    );
    expect(useChatStore.getState().activeSessionId).toBe("twin");
    expect(mocks.saveSessionsList).not.toHaveBeenCalled();
  });
});
