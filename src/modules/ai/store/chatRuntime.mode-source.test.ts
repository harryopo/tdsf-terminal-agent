import { afterEach, describe, expect, it, vi } from "vitest";
import { createContextAwareTransport } from "../lib/transport";
import { syncRunningMode } from "../lib/live-mode-sync";
import { getOrCreateChat } from "./chatRuntime";
import { chats, useChatStore } from "./chatStore";

vi.mock("../lib/transport", () => ({ createContextAwareTransport: vi.fn(() => ({})) }));
vi.mock("../lib/sessions", async (importOriginal) => ({
  ...await importOriginal<typeof import("../lib/sessions")>(),
  saveSessionsList: vi.fn(async () => {}),
}));
vi.mock("sonner", () => ({ toast: { info: vi.fn() } }));

afterEach(() => {
  chats.clear();
  vi.mocked(createContextAwareTransport).mockClear();
});

it("reads only the original chat's mode across active-store restoration writes", () => {
  useChatStore.setState({
    activeSessionId: "chat-a", agentMode: "confirm",
    sessions: [
      { id: "chat-a", title: "A", createdAt: 1, updatedAt: 1, agentMode: "confirm", scope: { kind: "ssh", host: "fixture-a", user: "root", port: 22 } },
      { id: "chat-b", title: "B", createdAt: 1, updatedAt: 1, agentMode: "auto", scope: { kind: "ssh", host: "fixture-b", user: "root", port: 22 } },
    ],
  });
  getOrCreateChat("chat-b");
  const deps = vi.mocked(createContextAwareTransport).mock.calls[0][0];
  const source = deps.modeSource!;
  const observed: string[] = [];
  const unsubscribe = source.subscribe(() => observed.push(source.get()));
  expect(source.get()).toBe("auto");
  expect(deps.getLive().conversationServer?.host).toBe("fixture-b");
  // selectSession writes activeId and restores the global mode separately.
  useChatStore.setState({ activeSessionId: "chat-b" });
  useChatStore.setState({ agentMode: "auto" });
  expect(observed).toEqual(["auto", "auto"]);
  expect(deps.getLive().conversationServer?.host).toBe("fixture-b");
  useChatStore.getState().setAgentMode("confirm");
  expect(source.get()).toBe("confirm");
  unsubscribe();
});

describe("actual mode setter respects running schema boundaries", () => {
  it("keeps observe/teach changes out of a running invocation without touching the other chat", () => {
    useChatStore.setState({
      activeSessionId: "chat-a", agentMode: "confirm", teach: false,
      sessions: [{ id: "chat-a", title: "A", createdAt: 1, updatedAt: 1, agentMode: "confirm" }],
    });
    const dispose = syncRunningMode({
      sessionId: "chat-a", streamId: "fixture", initialMode: "confirm",
      source: { get: () => "confirm", subscribe: () => () => {} }, onError: vi.fn(),
    });
    try {
      useChatStore.getState().setAgentMode("teach");
      expect(useChatStore.getState().agentMode).toBe("confirm");
      expect(useChatStore.getState().teach).toBe(false);
      expect(useChatStore.getState().sessions[0].agentMode).toBe("confirm");
      useChatStore.getState().setAgentMode("auto");
      expect(useChatStore.getState().sessions[0].agentMode).toBe("auto");
      useChatStore.setState({ activeSessionId: "chat-b" });
      useChatStore.getState().setAgentMode("observe");
      expect(useChatStore.getState().agentMode).toBe("observe");
    } finally {
      dispose();
    }
  });
});
