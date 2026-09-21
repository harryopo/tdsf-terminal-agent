/**
 * AiChat.autoType.test.tsx — 出身闸门的接线（消息 → 命令卡）
 * -----------------------------------------------------------------------------
 * 单元测试只能证明「闸门本身好用」，证不出「RenderedMessage 真的把它传下去了」。
 * 这条链路断过一次教训：#79 那轮探针假绿就是因为只测了局部。这里从 AiChatView
 * 整棵子树渲染，走真实 Streamdown → MarkdownCode → CommandCard，验证：
 *   - 从盘上读回来的消息（登记过 id）挂载时一个字都不打；
 *   - 同一份消息未登记（本次运行生成）时照常打字。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { UIMessage } from "ai";

vi.mock("../store/chatRuntime", () => ({
  sendMessage: vi.fn(async () => true),
}));
vi.mock("../lib/evidence", () => ({
  evidenceLabel: () => null,
  evidenceTime: () => "",
  fetchEvidence: vi.fn(async () => []),
  groupEvidence: () => [],
}));
vi.mock("./NeedsYouApprovalCards", () => ({
  NeedsYouApprovalCards: () => null,
}));

import { __resetAutoTypeLedger } from "../lib/autoTypeLedger";
import {
  __resetAutoTypeProvenance,
  markMessagesRestored,
} from "../lib/autoTypeProvenance";
import { useChatStore } from "../store/chatStore";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { AiChatView } from "./AiChat";

function assistantWithCommand(id: string, command: string): UIMessage {
  return {
    id,
    role: "assistant",
    parts: [
      {
        type: "text",
        text: "执行这条命令：\n\n```bash\n" + command + "\n```\n",
      },
    ],
  } as unknown as UIMessage;
}

function renderChat(messages: UIMessage[]) {
  return render(
    <AiChatView
      messages={messages}
      status="ready"
      error={undefined}
      clearError={vi.fn()}
      addToolApprovalResponse={vi.fn()}
      stop={vi.fn()}
    />,
  );
}

describe("AiChatView — 历史消息不自动打字（出身闸门接线）", () => {
  const originalLive = useChatStore.getState().live;
  const originalAutoType = usePreferencesStore.getState().agentAutoTypeCommands;
  const originalAgentMode = useChatStore.getState().agentMode;
  const inject = vi.fn(() => true);

  beforeEach(() => {
    __resetAutoTypeLedger();
    __resetAutoTypeProvenance();
    inject.mockClear();
    usePreferencesStore.setState({ agentAutoTypeCommands: true });
    useChatStore.setState({ agentMode: "confirm", activeSessionId: "sess-1" });
    useChatStore.setState((s) => ({
      live: {
        ...s.live,
        canAutoTypeToActiveTerminal: () => true,
        isActiveTerminalPrivate: () => false,
        injectIntoActivePty: inject,
      },
    }));
  });

  afterEach(() => {
    useChatStore.setState({ live: originalLive, agentMode: originalAgentMode });
    usePreferencesStore.setState({ agentAutoTypeCommands: originalAutoType });
  });

  it("消息 id 登记为读回来 → 挂载后零注入", () => {
    markMessagesRestored([{ id: "old-1" }]);
    renderChat([assistantWithCommand("old-1", "systemctl restart nginx")]);
    // 命令卡确实渲染出来了（否则"没注入"是假绿）
    expect(
      screen.getByRole("button", { name: "Run in active terminal" }),
    ).toBeTruthy();
    expect(inject).not.toHaveBeenCalled();
  });

  it("同一条消息未登记（本次运行生成）→ 照常注入一次", () => {
    renderChat([assistantWithCommand("fresh-1", "systemctl restart nginx")]);
    expect(inject).toHaveBeenCalledTimes(1);
    expect(inject).toHaveBeenCalledWith("systemctl restart nginx");
  });
});
