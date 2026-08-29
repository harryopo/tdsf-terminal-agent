/**
 * NeedsYouApprovalCards.test.tsx — sidecar needs_you 审批渲染闭环测试（Task 6.5）
 * -----------------------------------------------------------------------------
 * 覆盖：
 *   1. 工具直发副本（扁平字段）created → 渲染四层审批卡
 *   2. 服务事件形态（Event 包装 + request.extra）→ 同样渲染
 *   3. 双通道幂等：同一 req_id 两次 created 只渲染一张卡
 *   4. 非 approval 类型（question/error/handoff）不渲染
 *   5. 执行 → needs_you.respond RPC（approved:true）→ 卡移除
 *   6. ⚡批准且本会话只读免审 → response 带 decision/sessionTrust + 前端标志置位
 *   7. 拒绝附言 → response 带 reason/note
 *   8. responded/timeout 事件到达 → 卡自动移除
 *   9. RPC 失败 → 卡保留可重试 + console.error（不静默吞错）
 *  10. session_id 与当前会话不符 → 不渲染
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invokeRpc, onNeedsYou } from "@/lib/sidecar-bridge";
import { NeedsYouApprovalCards } from "./NeedsYouApprovalCards";
import { useChatStore } from "../store/chatStore";

type NeedsYouCb = (payload: unknown) => void;
let needsYouCb: NeedsYouCb | null = null;

vi.mock("@/lib/sidecar-bridge", () => ({
  invokeRpc: vi.fn(),
  onNeedsYou: vi.fn(async (cb: NeedsYouCb) => {
    needsYouCb = cb;
    return () => {};
  }),
}));

/** 模拟 Rust 侧推送 needs_you 事件（组件 useEffect 订阅完成后调用） */
const emitNeedsYou = (payload: unknown) =>
  act(() => {
    needsYouCb?.(payload);
  });

/** 工具直发副本（strands_backend/tools request_approval_and_wait 扁平结构） */
const toolDirectCreated = (overrides: Record<string, unknown> = {}) => ({
  needs_type: "approval",
  title: "高危命令审批请求: service",
  description: "Agent 试图通过工具 ssh_command 执行命令",
  priority: "high",
  event: undefined,
  id: "ny-abc123",
  type: "approval",
  detail: "Agent 试图通过工具 ssh_command 执行命令",
  command: "systemctl restart nginx",
  semantic: "想操作服务：nginx",
  explanation: "重启 nginx 使新配置生效",
  impact: { summary: "操作服务：nginx", max_risk_l: 3 },
  risk_l: 3,
  tool_name: "ssh_command",
  ...overrides,
});

/** 服务事件形态（needs_you.py _emit_event，经 Rust Event dict 包装） */
const serviceCreated = (extra: Record<string, unknown> = {}) => ({
  event_type: "needs_you",
  payload: {
    needs_type: "approval",
    event: "created",
    title: "高危命令审批请求: service",
    description: "Agent 试图通过工具 ssh_command 执行命令",
    priority: "high",
    request: {
      id: "ny-abc123",
      type: "approval",
      session_id: "sess-1",
      status: "pending",
      extra,
    },
  },
  session_id: "sess-1",
});

async function mount() {
  render(<NeedsYouApprovalCards />);
  // flush useEffect 内 onNeedsYou 订阅 promise，确保回调已注册
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  expect(onNeedsYou).toHaveBeenCalled();
  expect(needsYouCb).toBeTruthy();
}

beforeEach(() => {
  vi.mocked(invokeRpc).mockReset();
  vi.mocked(onNeedsYou).mockClear();
  needsYouCb = null;
  useChatStore.setState({ activeSessionId: "sess-1", sessionReadOnlyTrust: false });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NeedsYouApprovalCards — 事件渲染", () => {
  it("工具直发副本 created → 渲染四层卡面（语义/命令/解释/影响/L 色带）", async () => {
    await mount();
    emitNeedsYou(toolDirectCreated());

    expect(await screen.findByText("需要你的确认")).toBeTruthy();
    expect(screen.getByText("想操作服务：nginx")).toBeTruthy();
    expect(screen.getByText("systemctl restart nginx")).toBeTruthy();
    expect(screen.getByText("重启 nginx 使新配置生效")).toBeTruthy();
    expect(screen.getByText("L3 高风险")).toBeTruthy();
  });

  it("服务事件形态（Event 包装 + request.extra 四层字段）→ 同样渲染", async () => {
    await mount();
    emitNeedsYou(
      serviceCreated({
        command: "rm -rf /tmp/old",
        semantic: "想删除文件：/tmp/old",
        impact: null,
        risk_l: 4,
      }),
    );

    expect(await screen.findByText("需要你的确认")).toBeTruthy();
    expect(screen.getByText("想删除文件：/tmp/old")).toBeTruthy();
    expect(screen.getByText("rm -rf /tmp/old")).toBeTruthy();
    expect(screen.getByText("L4 危险")).toBeTruthy();
  });

  it("双通道幂等：同一 req_id 两次 created 只渲染一张卡", async () => {
    await mount();
    // 服务副本先到（extra 无四层字段），工具直发副本后到（扁平四层字段）
    emitNeedsYou(serviceCreated({ risk_l: 3 }));
    emitNeedsYou(toolDirectCreated());

    await screen.findByText("想操作服务：nginx");
    expect(screen.getAllByText("需要你的确认")).toHaveLength(1);
  });

  it("非 approval 类型（question）不渲染", async () => {
    await mount();
    emitNeedsYou(
      toolDirectCreated({ needs_type: "question", id: "ny-q1" }),
    );
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.queryByText("需要你的确认")).toBeNull();
  });

  it("session_id 与当前会话不符 → 不渲染（其他会话的卡仍正常）", async () => {
    await mount();
    // 当前会话 sess-1 的卡：正常渲染
    emitNeedsYou(serviceCreated({ command: "uptime", risk_l: 0 }));
    // 其他会话 sess-OTHER 的卡：不渲染
    emitNeedsYou({
      event_type: "needs_you",
      payload: {
        needs_type: "approval",
        event: "created",
        request: {
          id: "ny-other",
          type: "approval",
          session_id: "sess-OTHER",
          extra: { command: "shutdown -h now", risk_l: 4 },
        },
      },
      session_id: "sess-OTHER",
    });
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByText("需要你的确认")).toBeTruthy();
    expect(screen.queryByText("shutdown -h now")).toBeNull();
    expect(screen.getByText("uptime")).toBeTruthy();
  });
});

describe("NeedsYouApprovalCards — 三按钮 RPC 回传", () => {
  it("执行按钮 → needs_you.respond(approved:true) → 成功后卡移除", async () => {
    vi.mocked(invokeRpc).mockResolvedValue({});
    await mount();
    emitNeedsYou(toolDirectCreated({ risk_l: 1 }));

    fireEvent.click(await screen.findByText("执行"));

    await waitFor(() => {
      expect(invokeRpc).toHaveBeenCalledWith("needs_you.respond", {
        req_id: "ny-abc123",
        response: { approved: true },
      });
    });
    await waitFor(() => {
      expect(screen.queryByText("需要你的确认")).toBeNull();
    });
  });

  it("⚡批准且本会话只读免审 → response 带 decision/sessionTrust + 前端标志置位", async () => {
    vi.mocked(invokeRpc).mockResolvedValue({});
    await mount();
    emitNeedsYou(toolDirectCreated({ risk_l: 1 }));

    fireEvent.click(await screen.findByText("批准且本会话只读免审"));

    await waitFor(() => {
      expect(invokeRpc).toHaveBeenCalledWith("needs_you.respond", {
        req_id: "ny-abc123",
        response: {
          approved: true,
          decision: "trust",
          sessionTrust: true,
        },
      });
    });
    // 前端会话免审标志同步置位（chatStore.sessionReadOnlyTrust）
    expect(useChatStore.getState().sessionReadOnlyTrust).toBe(true);
  });

  it("拒绝附言 → response 带 reason/note（approved:false）", async () => {
    vi.mocked(invokeRpc).mockResolvedValue({});
    await mount();
    emitNeedsYou(toolDirectCreated({ risk_l: 3 }));

    fireEvent.click(await screen.findByText("拒绝"));
    fireEvent.change(
      screen.getByPlaceholderText(/附言（可选）/) ,
      { target: { value: "nginx 不能现在重启，先灰度" } },
    );
    fireEvent.click(screen.getByText("确认拒绝"));

    await waitFor(() => {
      expect(invokeRpc).toHaveBeenCalledWith("needs_you.respond", {
        req_id: "ny-abc123",
        response: {
          approved: false,
          reason: "nginx 不能现在重启，先灰度",
          note: "nginx 不能现在重启，先灰度",
        },
      });
    });
  });

  it("responded/timeout 事件到达 → 卡自动移除（无需用户操作）", async () => {
    await mount();
    emitNeedsYou(toolDirectCreated());
    await screen.findByText("需要你的确认");

    emitNeedsYou({
      event_type: "needs_you",
      payload: {
        needs_type: "approval",
        event: "timeout",
        request: { id: "ny-abc123", type: "approval", session_id: "sess-1" },
      },
    });

    await waitFor(() => {
      expect(screen.queryByText("需要你的确认")).toBeNull();
    });
    expect(invokeRpc).not.toHaveBeenCalled();
  });

  it("RPC 失败 → 卡保留可重试 + console.error（不静默吞错）", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(invokeRpc).mockRejectedValueOnce(new Error("sidecar down"));
    await mount();
    emitNeedsYou(toolDirectCreated({ risk_l: 1 }));

    fireEvent.click(await screen.findByText("执行"));

    await waitFor(() => {
      expect(errSpy).toHaveBeenCalledWith(
        expect.stringContaining("needs_you.respond failed"),
        expect.any(Error),
      );
    });
    // 卡保留（请求仍 pending），可再次点击重试
    expect(screen.getByText("需要你的确认")).toBeTruthy();
    vi.mocked(invokeRpc).mockResolvedValue({});
    fireEvent.click(screen.getByText("执行"));
    await waitFor(() => {
      expect(vi.mocked(invokeRpc)).toHaveBeenCalledTimes(2);
    });
  });
});
