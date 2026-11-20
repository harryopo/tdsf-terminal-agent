import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import * as settings from "@/modules/settings/store";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { useChatStore } from "../store/chatStore";
import { AgentModeSwitcher } from "./AgentModeSwitcher";
import { AgentTypingCard } from "@/settings/sections/AgentTypingCard";

const originalPrefs = usePreferencesStore.getState();
const originalChat = useChatStore.getState();

beforeEach(() => {
  usePreferencesStore.setState({
    ...usePreferencesStore.getState(),
    agentExecutionChannel: "background",
    agentTypingMode: "instant",
    agentTypingSpeed: 1,
    agentAutoTypeCommands: true,
  });
  useChatStore.setState({
    ...useChatStore.getState(),
    agentMode: "confirm",
    teach: false,
    sessions: [],
    activeSessionId: null,
  });

  vi.spyOn(settings, "setAgentTypingMode").mockImplementation(async (mode) => {
    usePreferencesStore.setState({ agentTypingMode: mode });
  });
  vi.spyOn(settings, "setAgentExecutionChannel").mockImplementation(async (channel) => {
    usePreferencesStore.setState({ agentExecutionChannel: channel });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  act(() => {
    usePreferencesStore.setState({
      agentExecutionChannel: originalPrefs.agentExecutionChannel,
      agentTypingMode: originalPrefs.agentTypingMode,
      agentTypingSpeed: originalPrefs.agentTypingSpeed,
      agentAutoTypeCommands: originalPrefs.agentAutoTypeCommands,
    });
    useChatStore.setState({
      agentMode: originalChat.agentMode,
      teach: originalChat.teach,
      sessions: originalChat.sessions,
      activeSessionId: originalChat.activeSessionId,
    });
  });
});

function openSwitcher() {
  fireEvent.click(screen.getByTestId("agent-mode-trigger"));
}

describe("Agent typing shortcut feedback", () => {
  it("hides the typing shortcut on the default background execution channel", () => {
    usePreferencesStore.setState({ agentTypingMode: "human" });
    render(<AgentModeSwitcher />);
    openSwitcher();
    expect(screen.queryByTestId("agent-mode-autotype")).toBeNull();
  });

  it("shows and toggles the shared instant/human preference without changing auto-type permission", async () => {
    usePreferencesStore.setState({ agentExecutionChannel: "visible-terminal" });
    render(<AgentModeSwitcher />);
    openSwitcher();

    const shortcut = screen.getByTestId("agent-mode-autotype");
    expect(shortcut.textContent).toContain("整段注入");
    expect(shortcut.getAttribute("aria-checked")).toBe("false");
    await act(async () => {
      fireEvent.click(shortcut);
      await Promise.resolve();
    });
    expect(usePreferencesStore.getState().agentTypingMode).toBe("human");
    expect(screen.getByTestId("agent-mode-autotype").textContent).toContain("逐字演示");
    expect(screen.getByTestId("agent-mode-autotype").getAttribute("aria-checked")).toBe("true");
    expect(usePreferencesStore.getState().agentAutoTypeCommands).toBe(true);

    await act(async () => {
      fireEvent.click(screen.getByTestId("agent-mode-autotype"));
      await Promise.resolve();
    });
    expect(usePreferencesStore.getState().agentTypingMode).toBe("instant");
    expect(screen.getByTestId("agent-mode-autotype").textContent).toContain("整段注入");
    expect(usePreferencesStore.getState().agentAutoTypeCommands).toBe(true);
  });

  it("reflects Settings channel and typing-mode changes in the shortcut", async () => {
    const { container } = render(
      <>
        <AgentTypingCard />
        <AgentModeSwitcher />
      </>,
    );
    const [channelSelect, typingModeSelect] = within(container).getAllByRole("combobox");

    fireEvent.click(channelSelect);
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /可见终端 Shell/ }));
      await Promise.resolve();
    });
    openSwitcher();
    expect(screen.getByTestId("agent-mode-autotype").textContent).toContain("整段注入");
    fireEvent.click(screen.getByTestId("agent-mode-trigger"));

    fireEvent.click(typingModeSelect);
    await act(async () => {
      fireEvent.click(screen.getByRole("option", { name: /逐字演示/ }));
      await Promise.resolve();
    });
    expect(usePreferencesStore.getState().agentTypingMode).toBe("human");
    openSwitcher();
    expect(screen.getByTestId("agent-mode-autotype").textContent).toContain("逐字演示");
    expect(usePreferencesStore.getState().agentAutoTypeCommands).toBe(true);
  });
});
