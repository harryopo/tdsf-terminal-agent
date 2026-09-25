/**
 * #142（2026-09-25）等你确认时应用必须出声 —— 两条接线 + 一条行为
 * ---------------------------------------------------------------------------
 * 缺陷形状：`agentMeta.status` 里 "awaiting-approval" 这个状态**早就存在**，
 * 通知桥也照着它写了"需要你确认"的分支，但 `approvalsPending` 只数 AI-SDK 的
 * `approval-requested` part，**sidecar 的 needs_you 审批一条都不算** ⇒ 那个分支
 * 对 sidecar 审批永远走不到。后果正是 #133 那种回合：整轮停在等用户，
 * 而人不看窗口时既没有系统通知、小窗也不弹——没有任何出口。
 *
 * 通知桥本身（routeAgentNotification）在 `focused && visible` 时才静默，
 * 所以"面板没开 / 窗口没焦点"这两种情况本来就该发声。
 */
import { act, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/modules/agents/lib/route", () => ({ routeAgentNotification: vi.fn() }));
vi.mock("@/modules/agents/lib/useWindowFocus", () => ({
  useWindowFocus: () => false,
}));

import { routeAgentNotification } from "@/modules/agents/lib/route";
import { useChatStore } from "../store/chatStore";
import { useNeedsYouWait } from "../store/needsYouWaitStore";
import { LocalAgentNotificationsBridge } from "./LocalAgentNotificationsBridge";

const SESSION = "sess-142";

function setStatus(status: string) {
  act(() => {
    useChatStore.setState((s) => ({
      agentMeta: { ...s.agentMeta, status } as typeof s.agentMeta,
    }));
  });
}

beforeEach(() => {
  vi.mocked(routeAgentNotification).mockClear();
  useNeedsYouWait.getState().reset();
  useChatStore.setState({
    activeSessionId: SESSION,
    panelOpen: false,
    agentMeta: {
      ...useChatStore.getState().agentMeta,
      status: "thinking",
      error: null,
    },
  });
});

describe("LocalAgentNotificationsBridge — 审批挂起要出声（#142）", () => {
  it("翻到「等用户确认」时发 attention 通知，标题是中文", () => {
    render(<LocalAgentNotificationsBridge />);
    setStatus("awaiting-approval");

    const call = vi
      .mocked(routeAgentNotification)
      .mock.calls.find((c) => c[0].kind === "attention");
    expect(call, "等待确认时没有发出 attention 通知").toBeTruthy();
    expect(call![0].title).toBe("TDSF 需要你的确认");
    // 品牌名 TDSF 本来就是拉丁字母，判"整句英文"要先把它摘掉再量
    expect(call![0].title.replace(/TDSF/g, "")).not.toMatch(/[A-Za-z]{2,}/);
  });

  it("跑完时报的也是中文（同一族英文文案一并收掉）", () => {
    render(<LocalAgentNotificationsBridge />);
    setStatus("idle");

    const call = vi
      .mocked(routeAgentNotification)
      .mock.calls.find((c) => c[0].kind === "finished");
    expect(call).toBeTruthy();
    expect(call![0].title).toContain("跑完");
  });
});

describe("#142 接线：sidecar 审批必须并进 approvalsPending", () => {
  const src = readFileSync(
    join(process.cwd(), "src/modules/ai/components/AgentRunBridge.tsx"),
    "utf8",
  );

  it("AgentRunBridge 必须读 needsYouWaitStore 的待答条数", () => {
    // 行为用例证明不了这条：AgentRunBridge 要真 chat 实例才能挂载，
    // 而"实现了但没接上"正是这次缺陷本身（状态与通知分支都在，只是没人喂数）。
    expect(src).toMatch(/pendingNeedsYouCount/);
    expect(src).toMatch(/approvalsPending\s*=\s*messageApprovals\s*\+\s*sidecarApprovals/);
  });

  it("通知文案不许再留整句英文（标题位）", () => {
    const bridge = readFileSync(
      join(process.cwd(), "src/modules/ai/components/LocalAgentNotificationsBridge.tsx"),
      "utf8",
    );
    for (const stale of [
      "needs your approval",
      "Approve a tool to continue",
      "TDSF finished",
      "Your task is ready",
      "TDSF run failed",
    ]) {
      expect(bridge, `通知文案里还留着英文：${stale}`).not.toContain(stale);
    }
  });
});
