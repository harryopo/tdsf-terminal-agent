/**
 * NeedsYouApprovalCards.test.tsx — sidecar needs_you 审批渲染闭环测试（Task 6.5）
 * -----------------------------------------------------------------------------
 * 覆盖：
 *   1. 工具直发副本（扁平字段）created → 渲染四层审批卡
 *   2. 服务事件形态（Event 包装 + request.extra）→ 同样渲染
 *   3. 双通道幂等：同一 req_id 两次 created 只渲染一张卡
 *   4. question 类型渲染提问卡并在确认后回传 answer
 *   5. 执行 → needs_you.respond RPC（approved:true）→ 卡移除
 *   6. ⚡批准且本会话只读免审 → response 带 decision/sessionTrust + 前端标志置位
 *   7. 拒绝附言 → response 带 reason/note
 *   8. responded/timeout 事件到达 → 卡自动移除
 *   9. RPC 失败 → 卡保留可重试 + console.error（不静默吞错）
 *  10. session_id 与当前会话不符 → 不渲染
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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

const questionCreated = () => ({
  event_type: "needs_you",
  payload: {
    needs_type: "question",
    event: "created",
    title: "Agent 需要你的回答",
    description: "请选择虚拟机网络模式",
    request: {
      id: "ny-q1",
      type: "question",
      session_id: "sess-1",
      extra: {
        question: "请选择虚拟机网络模式",
        options: ["NAT", "桥接"],
        confirm_label: "确认并继续",
      },
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
  useChatStore.setState({
    activeSessionId: "sess-1",
    sessionReadOnlyTrust: false,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("NeedsYouApprovalCards — 事件渲染", () => {
  it("工具直发副本 created → 渲染四层卡面（语义/命令/解释/影响/L 色带）", async () => {
    await mount();
    emitNeedsYou(toolDirectCreated());

    expect(await screen.findByText("等待你的确认")).toBeTruthy();
    expect(screen.getByText("systemctl restart nginx")).toBeTruthy();
    expect(screen.getByText("重启 nginx 使新配置生效")).toBeTruthy();
    expect(screen.getByText("操作服务：nginx")).toBeTruthy();
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

    expect(await screen.findByText("等待你的确认")).toBeTruthy();
    expect(screen.getByText("想删除文件：/tmp/old")).toBeTruthy();
    expect(screen.getByText("rm -rf /tmp/old")).toBeTruthy();
    expect(screen.getByText("L4 危险")).toBeTruthy();
  });

  it("双通道幂等：同一 req_id 两次 created 只渲染一张卡", async () => {
    await mount();
    // 服务副本先到（extra 无四层字段），工具直发副本后到（扁平四层字段）
    emitNeedsYou(serviceCreated({ risk_l: 3 }));
    emitNeedsYou(toolDirectCreated());

    await screen.findByText("重启 nginx 使新配置生效");
    expect(screen.getAllByText("等待你的确认")).toHaveLength(1);
  });

  it("question 类型渲染提问卡", async () => {
    await mount();
    emitNeedsYou(questionCreated());
    expect(await screen.findByText("Agent 需要你的回答")).toBeTruthy();
    expect(screen.getByText("请选择虚拟机网络模式")).toBeTruthy();
    expect(screen.getByText("NAT")).toBeTruthy();
    expect(screen.getByText("桥接")).toBeTruthy();
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
    expect(screen.getByText("等待你的确认")).toBeTruthy();
    expect(screen.queryByText("shutdown -h now")).toBeNull();
    expect(screen.getByText("uptime")).toBeTruthy();
  });
});

describe("NeedsYouApprovalCards — 三按钮 RPC 回传", () => {
  it("提问卡选择后确认 → 回传 answer 并移除", async () => {
    vi.mocked(invokeRpc).mockResolvedValue({});
    await mount();
    emitNeedsYou(questionCreated());

    fireEvent.click(await screen.findByText("桥接"));
    fireEvent.click(screen.getByText("确认并继续"));

    await waitFor(() => {
      expect(invokeRpc).toHaveBeenCalledWith("needs_you.respond", {
        req_id: "ny-q1",
        response: { answer: "桥接" },
      });
    });
    await waitFor(() =>
      expect(screen.queryByText("请选择虚拟机网络模式")).toBeNull(),
    );
  });

  it("执行按钮 → needs_you.respond(approved:true) → 成功后卡移除", async () => {
    vi.mocked(invokeRpc).mockResolvedValue({});
    await mount();
    emitNeedsYou(
      toolDirectCreated({
        risk_l: 1,
        impact: {
          summary: "只读查看服务状态",
          max_risk_l: 1,
          segments: [{ category: "readonly", risk_l: 1 }],
        },
      }),
    );

    fireEvent.click(await screen.findByText("执行"));

    await waitFor(() => {
      expect(invokeRpc).toHaveBeenCalledWith("needs_you.respond", {
        req_id: "ny-abc123",
        response: { approved: true },
      });
    });
    await waitFor(() => {
      expect(screen.queryByText("等待你的确认")).toBeNull();
    });
  });

  it("⚡批准且本会话只读免审 → response 带 decision/sessionTrust + 前端标志置位", async () => {
    vi.mocked(invokeRpc).mockResolvedValue({});
    await mount();
    emitNeedsYou(
      toolDirectCreated({
        risk_l: 1,
        impact: {
          summary: "只读查看服务状态",
          max_risk_l: 1,
          segments: [{ category: "readonly", risk_l: 1 }],
        },
      }),
    );

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
    fireEvent.change(screen.getByPlaceholderText(/附言（可选）/), {
      target: { value: "nginx 不能现在重启，先灰度" },
    });
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
    await screen.findByText("等待你的确认");

    emitNeedsYou({
      event_type: "needs_you",
      payload: {
        needs_type: "approval",
        event: "timeout",
        request: { id: "ny-abc123", type: "approval", session_id: "sess-1" },
      },
    });

    await waitFor(() => {
      expect(screen.queryByText("等待你的确认")).toBeNull();
    });
    // 超时/已响应由后端收尾，前端不再回传 respond
    // （#59 后挂载会调一次 needs_you.list，故只断言 respond 没被调用）
    expect(
      vi.mocked(invokeRpc).mock.calls.filter(
        (call) => call[0] === "needs_you.respond",
      ),
    ).toHaveLength(0);
  });

  it("RPC 失败 → 卡保留可重试 + console.error（不静默吞错）", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // 只让 respond 失败；挂载时的 needs_you.list 补拉（#59）正常返回空
    const respondCalls = () =>
      vi.mocked(invokeRpc).mock.calls.filter(
        (call) => call[0] === "needs_you.respond",
      ).length;
    vi.mocked(invokeRpc).mockImplementation(async (method: string) => {
      if (method === "needs_you.respond") throw new Error("sidecar down");
      return [];
    });
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
    expect(screen.getByText("等待你的确认")).toBeTruthy();
    vi.mocked(invokeRpc).mockImplementation(async (method: string) => {
      if (method === "needs_you.respond") return {};
      return [];
    });
    fireEvent.click(screen.getByText("执行"));
    await waitFor(() => {
      expect(respondCalls()).toBe(2);
    });
    await waitFor(() => {
      expect(screen.queryByText("等待你的确认")).toBeNull();
    });
  });
});

describe("NeedsYouApprovalCards FIFO", () => {
  it("shows only the queue head and reveals the next approval after a successful response", async () => {
    let resolveResponse: ((value: unknown) => void) | undefined;
    // 按方法分派（不是 Once）：挂载时的 needs_you.list 补拉（#59）不能吃掉
    // 这个为 respond 准备的 deferred promise。
    vi.mocked(invokeRpc).mockImplementation((method: string) => {
      if (method !== "needs_you.respond") return Promise.resolve([]);
      return new Promise((resolve) => {
        resolveResponse = resolve;
      });
    });
    await mount();
    emitNeedsYou(
      toolDirectCreated({ id: "ny-first", command: "echo FIRST_APPROVAL" }),
    );
    emitNeedsYou(
      toolDirectCreated({ id: "ny-second", command: "echo SECOND_APPROVAL" }),
    );

    expect(await screen.findByText("echo FIRST_APPROVAL")).toBeTruthy();
    expect(screen.queryByText("echo SECOND_APPROVAL")).toBeNull();
    expect(
      document
        .querySelector("[data-needs-you-cards]")
        ?.getAttribute("data-queued-approvals"),
    ).toBe("1");

    fireEvent.click(screen.getByText("执行"));
    expect(screen.getByText("echo FIRST_APPROVAL")).toBeTruthy();
    expect(screen.queryByText("echo SECOND_APPROVAL")).toBeNull();

    await act(async () => {
      resolveResponse?.({});
      await Promise.resolve();
    });
    expect(await screen.findByText("echo SECOND_APPROVAL")).toBeTruthy();
    expect(screen.queryByText("echo FIRST_APPROVAL")).toBeNull();
  });
});

// ==========================================================================
// #59：挂载时按 needs_you.list 补水合
// --------------------------------------------------------------------------
// created 事件只推一次；页面重载 / 挂载竞态期间错过的请求不会重放。approval 尚有
// 300s 超时兜底，question 的 deadline 恒为 None → Python wait_for_response 永久
// 阻塞工具线程。所以下面钉住：挂载必须补拉一次，并且不与后到的事件重复插入。
// ==========================================================================

/** needs_you.list 返回的就是 NeedsYouRequest.to_dict() 列表 */
const pendingQuestionRow = (overrides: Record<string, unknown> = {}) => ({
  id: "ny-r1",
  type: "question",
  title: "Agent 需要你的回答",
  description: "请选择虚拟机网络模式",
  session_id: "sess-1",
  status: "pending",
  extra: {
    question: "请选择虚拟机网络模式",
    options: ["NAT", "桥接"],
    confirm_label: "确认并继续",
  },
  ...overrides,
});

describe("NeedsYouApprovalCards — #59 挂载补水合", () => {
  it("挂载时拉 needs_you.list，把错过的 pending question 补成可回答的卡片", async () => {
    vi.mocked(invokeRpc).mockImplementation(async (method: string) =>
      method === "needs_you.list" ? [pendingQuestionRow()] : {},
    );

    render(<NeedsYouApprovalCards />);
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(invokeRpc).toHaveBeenCalledWith("needs_you.list", {});
    expect(await screen.findByText("请选择虚拟机网络模式")).toBeTruthy();
    expect(screen.getByText("NAT")).toBeTruthy();
  });

  it("补水合后用户作答 → needs_you.respond 带 answer 唤醒后端等待线程", async () => {
    vi.mocked(invokeRpc).mockImplementation(async (method: string) => {
      if (method === "needs_you.list") return [pendingQuestionRow()];
      return {};
    });
    render(<NeedsYouApprovalCards />);
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    fireEvent.click(await screen.findByText("桥接"));
    fireEvent.click(screen.getByText("确认并继续"));

    await waitFor(() =>
      expect(invokeRpc).toHaveBeenCalledWith("needs_you.respond", {
        req_id: "ny-r1",
        response: { answer: "桥接" },
      }),
    );
    await waitFor(() =>
      expect(document.querySelector("[data-question-card]")).toBeNull(),
    );
  });

  it("同一请求：先补拉后到 created 事件 → 只有一张卡（不重复插入）", async () => {
    vi.mocked(invokeRpc).mockImplementation(async (method: string) =>
      method === "needs_you.list" ? [pendingQuestionRow()] : {},
    );
    render(<NeedsYouApprovalCards />);
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    await screen.findByText("请选择虚拟机网络模式");

    emitNeedsYou({
      needs_type: "question",
      event: "created",
      request: pendingQuestionRow(),
    });
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(document.querySelectorAll("[data-question-card]")).toHaveLength(1);
    expect(
      document
        .querySelector("[data-needs-you-cards]")
        ?.getAttribute("data-queued-approvals"),
    ).toBe("0");
  });

  it("补拉失败（sidecar 未就绪）不崩、不渲染，且事件通道仍然可用", async () => {
    vi.mocked(invokeRpc).mockImplementation(async (method: string) => {
      if (method === "needs_you.list") throw new Error("sidecar not running");
      return {};
    });
    await mount();
    expect(document.querySelector("[data-needs-you-cards]")).toBeNull();

    emitNeedsYou(toolDirectCreated());
    expect(await screen.findByText("等待你的确认")).toBeTruthy();
  });

  it("其他会话的 pending 请求不补水渲染（跨会话隔离对补拉同样生效）", async () => {
    vi.mocked(invokeRpc).mockImplementation(async (method: string) =>
      method === "needs_you.list"
        ? [pendingQuestionRow({ id: "ny-other", session_id: "sess-2" })]
        : {},
    );
    render(<NeedsYouApprovalCards />);
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(screen.queryByText("请选择虚拟机网络模式")).toBeNull();
  });

  it("error / handoff 类请求不参与补水合（沿用既有状态提示通道）", async () => {
    vi.mocked(invokeRpc).mockImplementation(async (method: string) =>
      method === "needs_you.list"
        ? [
            pendingQuestionRow({ id: "ny-e", type: "error" }),
            pendingQuestionRow({ id: "ny-h", type: "handoff" }),
          ]
        : {},
    );
    render(<NeedsYouApprovalCards />);
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });

    expect(document.querySelector("[data-needs-you-cards]")).toBeNull();
  });
});
