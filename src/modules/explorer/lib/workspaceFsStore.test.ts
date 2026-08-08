import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWorkspaceFsStore } from "./workspaceFsStore";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

import { invoke } from "@tauri-apps/api/core";
const mockInvoke = vi.mocked(invoke);

const ROOT_ENTRIES = [
  { name: "etc", path: "/etc", is_dir: true, size: 0, mtime: 0 },
  { name: "home", path: "/home", is_dir: true, size: 0, mtime: 0 },
  { name: "README.md", path: "/README.md", is_dir: false, size: 12, mtime: 0 },
];

beforeEach(() => {
  useWorkspaceFsStore.getState().clear();
  mockInvoke.mockReset();
});

describe("workspaceFsStore", () => {
  it("activate 原子替换状态并加载根目录", async () => {
    mockInvoke
      .mockResolvedValueOnce({ rename: true, delete: true })
      .mockResolvedValueOnce(ROOT_ENTRIES);

    useWorkspaceFsStore
      .getState()
      .activate({ spaceId: "s1", kind: "sftp", sessionId: 3, rootPath: "/" });

    // 等待两个异步 action 完成
    await vi.waitFor(() => {
      const s = useWorkspaceFsStore.getState();
      expect(s.spaceId).toBe("s1");
      expect(s.kind).toBe("sftp");
      expect(s.sessionId).toBe(3);
      expect(s.rootPath).toBe("/");
      expect(s.entriesByPath["/"]).toEqual(ROOT_ENTRIES);
      expect(s.capabilities).toEqual({ rename: true, delete: true });
    });
  });

  it("sftp 请求携带 sessionId, local 请求不带", async () => {
    mockInvoke.mockResolvedValue(ROOT_ENTRIES);
    useWorkspaceFsStore
      .getState()
      .activate({ spaceId: "s1", kind: "local", sessionId: null, rootPath: "C:\\Users" });
    await vi.waitFor(() => {
      const calls = mockInvoke.mock.calls;
      const listCall = calls.find(([name]) => name === "fsb_list");
      expect(listCall).toBeDefined();
      expect((listCall![1] as { sessionId: number | null }).sessionId).toBeNull();
    });

    mockInvoke.mockClear();
    useWorkspaceFsStore
      .getState()
      .activate({ spaceId: "s2", kind: "sftp", sessionId: 7, rootPath: "/" });
    await vi.waitFor(() => {
      const calls = mockInvoke.mock.calls;
      const listCall = calls.find(([name]) => name === "fsb_list");
      expect(listCall).toBeDefined();
      expect((listCall![1] as { sessionId: number | null }).sessionId).toBe(7);
    });
  });

  it("NotConnected 错误进入 fatalError 降级提示", async () => {
    mockInvoke.mockRejectedValue({ code: "NotConnected", message: "SSH 连接已断开" });
    useWorkspaceFsStore
      .getState()
      .activate({ spaceId: "s1", kind: "sftp", sessionId: 9, rootPath: "/" });

    await vi.waitFor(() => {
      expect(useWorkspaceFsStore.getState().fatalError).toBe("SSH 连接已断开，请重新连接");
    });
  });

  it("切换 Space 后旧目录数据被清空 (原子替换无中间态)", async () => {
    mockInvoke.mockResolvedValue(ROOT_ENTRIES);
    useWorkspaceFsStore
      .getState()
      .activate({ spaceId: "s1", kind: "sftp", sessionId: 1, rootPath: "/" });
    await vi.waitFor(() => {
      expect(useWorkspaceFsStore.getState().entriesByPath["/"]).toBeDefined();
    });

    useWorkspaceFsStore
      .getState()
      .activate({ spaceId: "s2", kind: "local", sessionId: null, rootPath: "C:\\x" });
    const s = useWorkspaceFsStore.getState();
    expect(s.spaceId).toBe("s2");
    expect(s.entriesByPath).toEqual({});
    expect(s.expanded.size).toBe(0);
  });
});
