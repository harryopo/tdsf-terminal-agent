import { act, cleanup, renderHook } from "@testing-library/react";
import { useSpaces } from "@/modules/spaces";
import { afterEach, describe, expect, it, vi } from "vitest";
import { labelFor } from "./tabLabel";
import { useTabs } from "./useTabs";

vi.mock("@/modules/terminal", () => ({ leafHasForegroundProcess: vi.fn(), leafIds: vi.fn() }));
afterEach(cleanup);

describe("SSH workspace placeholder", () => {
  it("stays cold until a session is attached, including explicit warm-up", () => {
    const { result } = renderHook(() => useTabs());
    act(() => result.current.markBooted());

    let tabId = 0;
    act(() => {
      tabId = result.current.newTabInSpace("ssh-workspace", "/remote", {
        sshSessionId: null,
        sshPending: true,
      });
      result.current.setActiveId(tabId);
    });
    const tab = () => result.current.tabs.find((item) => item.id === tabId);
    expect(tab()).toMatchObject({ cold: true, sshSessionId: null });
    expect(labelFor(tab()!)).toBe("等待连接");

    act(() => result.current.warmUpTab(tabId));
    expect(tab()).toMatchObject({ cold: true, sshSessionId: null });

    act(() => result.current.updateTab(tabId, { sshSessionId: "connected-session" }));
    expect(tab()).toMatchObject({ cold: false, sshSessionId: "connected-session" });
    expect(result.current.activeId).toBe(tabId);
  });

  it("can still explicitly warm an ordinary local tab", () => {
    const { result } = renderHook(() => useTabs());
    act(() => result.current.warmUpTab(1));
    expect(result.current.tabs.find((tab) => tab.id === 1)?.cold).toBe(false);
  });

  it("keeps an empty SSH fallback workspace offline when another space is removed", () => {
    const previous = useSpaces.getState().spaces;
    useSpaces.setState({
      spaces: [{
        id: "ssh-fallback",
        name: "Server",
        root: "/remote",
        env: { kind: "ssh", user: "dev", host: "server.test", port: 22, label: "Server" },
        createdAt: 0,
        updatedAt: 0,
      }],
    });
    try {
      const { result } = renderHook(() => useTabs());
      act(() => result.current.markBooted());
      const localSpaceId = result.current.tabs[0].spaceId;
      act(() => result.current.removeTabsForSpace(localSpaceId, "ssh-fallback", "/remote"));
      expect(result.current.tabs).toHaveLength(1);
      expect(result.current.tabs[0]).toMatchObject({
        id: result.current.activeId,
        spaceId: "ssh-fallback",
        cold: true,
        sshPending: true,
      });
    } finally {
      useSpaces.setState({ spaces: previous });
    }
  });
});
