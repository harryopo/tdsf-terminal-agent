/**
 * TEAM-FIX-01 定向用例：技能结果合同与两个入口
 * -----------------------------------------------------------------------------
 * 覆盖 Issue #53 验收矩阵：
 *   1. not_run + executor + success/output 混合 → 以 not_run 为准
 *   2. 正常参考、空参考、when_to_use/whenToUse 兼容
 *   3. 空/未知/格式错误结果、IPC 异常 → 不落到成功参考兜底
 *   4. 确证旧 executed 成功/失败 → 保持真实语义
 *   5. store → 对话框、store → /skill：mode 一致，通知文案一致
 *   6. 历史缺 mode 不清除、不反推执行；recordHistory=false 不写历史
 *
 * 参考路径只允许一次 skill.invoke，没有额外 shell/SSH/终端写入调用。
 */
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillContentDialog } from "./SkillContentDialog";
import { SkillInvoker } from "./SkillInvoker";
import { invokeSkill } from "./executor";
import { describeSkillResult } from "./resultNotice";
import { useSkillsStore } from "./skillsStore";
import type { SkillExecution, SkillHistoryEntry, SkillMetadata } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("streamdown", () => ({
  Streamdown: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="streamdown">{children}</div>
  ),
}));

const mockedInvoke = vi.mocked(invoke);

const skill: SkillMetadata = {
  name: "linux-ops",
  description: "Linux 运维参考",
  category: "linux",
  whenToUse: "排查 Linux 服务",
  examples: ["uptime"],
  source: "builtin",
  enabled: true,
  rawContent: "# 本地 SKILL.md\n\n本地预览内容。",
};

const referenceResult = {
  name: "linux-ops",
  description: "Linux 运维参考",
  content: "# Linux 运维\n\n仅作参考。",
  when_to_use: "排查 Linux 服务",
  steps: "1. uptime",
  examples: "uptime",
  params: {},
  source: "builtin",
  execution: "not_run" as const,
  executor: { type: "shell" as const, command: "uptime", timeout: 5 },
};

const executedResult = {
  name: "uptime",
  executor: { type: "shell", command: "uptime", timeout: 5 },
  success: true,
  exit_code: 0,
  output: "up 3 days",
  stdout: "up 3 days",
  stderr: "",
  duration_ms: 3,
  params: {},
  source: "builtin",
};

function oldHistoryEntry(): SkillHistoryEntry {
  return {
    timestamp: 1,
    skillName: "old-skill",
    args: "",
    success: true,
    durationMs: 1,
    outputPreview: "旧记录",
  };
}

beforeEach(() => {
  mockedInvoke.mockReset();
  useSkillsStore.setState({ invokingSkill: null, history: [] });
});

afterEach(() => {
  cleanup();
});

describe("invokeSkill — 结果合同", () => {
  it("not_run 优先于 executor/success/output 混合字段", async () => {
    mockedInvoke.mockResolvedValue({
      ok: true,
      result: {
        ...referenceResult,
        success: true,
        exit_code: 0,
        output: "up 3 days",
        stdout: "up 3 days",
      },
    } as never);

    const res = await invokeSkill("linux-ops", "");

    expect(res.mode).toBe("reference");
    expect(res.success).toBe(true);
    expect(res.empty).toBe(false);
    expect(res.output).toContain("仅作参考");
    expect(res.output).not.toContain("up 3 days");
    expect(res.output).not.toContain("执行完成");
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke.mock.calls[0]?.[1]).toMatchObject({
      method: "skill.invoke",
      params: { name: "linux-ops" },
    });
  });

  it("兼容 when_to_use 与 whenToUse 两种字段名", async () => {
    mockedInvoke.mockResolvedValueOnce({
      ok: true,
      result: { name: "a", content: "", when_to_use: "snake 条件" },
    } as never);
    const snake = await invokeSkill("a", "");
    expect(snake.mode).toBe("reference");
    expect(snake.output).toBe("snake 条件");

    mockedInvoke.mockResolvedValueOnce({
      ok: true,
      result: { name: "b", content: "", whenToUse: "camel 条件" },
    } as never);
    const camel = await invokeSkill("b", "");
    expect(camel.mode).toBe("reference");
    expect(camel.output).toBe("camel 条件");
  });

  it("空参考仍是 reference，不伪装命令成功", async () => {
    mockedInvoke.mockResolvedValue({
      ok: true,
      result: { ...referenceResult, content: "", when_to_use: "" },
    } as never);

    const res = await invokeSkill("linux-ops", "");

    expect(res.mode).toBe("reference");
    expect(res.empty).toBe(true);
    expect(res.output).toBe("");
    expect(res.output).not.toContain("执行完成");
  });

  it("未知/格式错误结果返回 unknown，不落到成功参考", async () => {
    mockedInvoke.mockResolvedValueOnce({ ok: true, result: {} } as never);
    const empty = await invokeSkill("a", "");
    expect(empty.mode).toBe("unknown");
    expect(empty.success).toBe(false);

    mockedInvoke.mockResolvedValueOnce({
      ok: true,
      result: "not-an-object",
    } as never);
    const text = await invokeSkill("b", "");
    expect(text.mode).toBe("unknown");
    expect(text.success).toBe(false);

    mockedInvoke.mockResolvedValueOnce({ ok: true } as never);
    const missing = await invokeSkill("c", "");
    expect(missing.mode).toBe("unknown");
    expect(missing.success).toBe(false);
  });

  it("IPC 异常与 ok=false 返回 failed", async () => {
    mockedInvoke.mockRejectedValueOnce(new Error("ipc down"));
    const rejected = await invokeSkill("a", "");
    expect(rejected.mode).toBe("failed");
    expect(rejected.success).toBe(false);
    expect(rejected.output).toContain("ipc down");

    mockedInvoke.mockResolvedValueOnce({
      ok: false,
      error: "skill not found: nope",
    } as never);
    const notFound = await invokeSkill("nope", "");
    expect(notFound.mode).toBe("failed");
    expect(notFound.output).toContain("skill not found");
  });

  it("确证 executed 成功/失败保持真实语义", async () => {
    mockedInvoke.mockResolvedValueOnce({
      ok: true,
      result: executedResult,
    } as never);
    const ok = await invokeSkill("uptime", "");
    expect(ok.mode).toBe("executed");
    expect(ok.success).toBe(true);
    expect(ok.output).toContain("up 3 days");
    expect(ok.output).not.toContain("当前 SSH");

    mockedInvoke.mockResolvedValueOnce({
      ok: true,
      result: {
        ...executedResult,
        success: false,
        exit_code: 1,
        stdout: "",
        stderr: "boom",
      },
    } as never);
    const bad = await invokeSkill("uptime", "");
    expect(bad.mode).toBe("executed");
    expect(bad.success).toBe(false);
    expect(bad.output).toContain("boom");
    expect(bad.output).toContain("退出码: 1");
  });
});

describe("skillsStore — mode 传递与历史兼容", () => {
  it("invoke 返回 mode，新历史记录带 mode", async () => {
    mockedInvoke.mockResolvedValue({ ok: true, result: referenceResult } as never);

    const res = await useSkillsStore.getState().invoke("linux-ops", "");
    expect(res.mode).toBe("reference");

    const entry = useSkillsStore.getState().history[0];
    expect(entry?.mode).toBe("reference");
    expect(entry?.skillName).toBe("linux-ops");
  });

  it("旧历史缺 mode 时保留记录，不反推执行", async () => {
    const old = oldHistoryEntry();
    useSkillsStore.setState({ history: [old], invokingSkill: null });
    mockedInvoke.mockResolvedValue({ ok: true, result: referenceResult } as never);

    await useSkillsStore.getState().invoke("linux-ops", "");

    const history = useSkillsStore.getState().history;
    expect(history).toHaveLength(2);
    expect(history[1]).toEqual(old);
    expect(history[1]?.mode).toBeUndefined();
    expect(history[0]?.mode).toBe("reference");
  });

  it("recordHistory=false 的纯查看入口不写历史", async () => {
    mockedInvoke.mockResolvedValue({ ok: true, result: referenceResult } as never);

    await useSkillsStore
      .getState()
      .invoke("linux-ops", "", { recordHistory: false });

    expect(useSkillsStore.getState().history).toHaveLength(0);
  });
});

describe("describeSkillResult — 两个入口共用文案", () => {
  const base: SkillExecution = {
    success: true,
    output: "参考",
    durationMs: 1,
    mode: "reference",
  };

  it("reference / 空参考 / executed / unknown / failed 各有明确语义", () => {
    expect(describeSkillResult("s", base).label).toBe("参考资料已加载");
    expect(describeSkillResult("s", { ...base, empty: true }).label).toBe(
      "未提供参考资料",
    );
    expect(
      describeSkillResult("s", { ...base, mode: "executed" }).label,
    ).toBe("执行结束");
    expect(
      describeSkillResult("s", {
        ...base,
        mode: "executed",
        success: false,
      }).label,
    ).toBe("执行失败");
    expect(describeSkillResult("s", { ...base, mode: "unknown" }).label).toBe(
      "结果无法识别",
    );
    expect(
      describeSkillResult("s", {
        ...base,
        mode: "failed",
        success: false,
      }).label,
    ).toBe("读取失败");
  });
});

describe("SkillInvoker — 参考界面文案", () => {
  it("not_run 资料加载后显示参考资料与未执行提示", async () => {
    mockedInvoke.mockResolvedValue({ ok: true, result: referenceResult } as never);

    render(<SkillInvoker skill={skill} onOpenChange={() => {}} />);
    fireEvent.click(screen.getByTestId("skill-invoker-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("skill-invoker-output")).toHaveTextContent(
        "仅作参考",
      );
    });
    expect(screen.getAllByText(/参考资料已加载/).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/仅提供参考资料，未执行命令/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/执行完成/)).toBeNull();
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
  });

  it("unknown 结果明确提示，不显示成功参考", async () => {
    mockedInvoke.mockResolvedValue({ ok: true, result: {} } as never);

    render(<SkillInvoker skill={skill} onOpenChange={() => {}} />);
    fireEvent.click(screen.getByTestId("skill-invoker-submit"));

    await waitFor(() => {
      expect(screen.getByTestId("skill-invoker-output")).toHaveTextContent(
        "无法识别",
      );
    });
    expect(screen.queryByText(/参考资料已加载/)).toBeNull();
  });
});

describe("SkillContentDialog — 侧栏入口同样按 mode 展示", () => {
  it("reference 展示参考内容并说明未执行", async () => {
    mockedInvoke.mockResolvedValue({ ok: true, result: referenceResult } as never);

    render(<SkillContentDialog skill={skill} onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByTestId("streamdown")).toHaveTextContent("仅作参考");
    });
    expect(screen.getByText(/仅提供参考资料，未执行命令/)).toBeInTheDocument();
    expect(screen.getByText("参考资料已加载")).toBeInTheDocument();
  });

  it("空参考明确显示未提供参考资料", async () => {
    mockedInvoke.mockResolvedValue({
      ok: true,
      result: { ...referenceResult, content: "", when_to_use: "" },
    } as never);

    render(<SkillContentDialog skill={skill} onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("该技能未提供参考资料。")).toBeInTheDocument();
    });
  });

  it("读取失败回退本地预览并标注未执行", async () => {
    mockedInvoke.mockResolvedValue({ ok: false, error: "ipc down" } as never);

    render(<SkillContentDialog skill={skill} onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(
        screen.getByText(/以下为本地 SKILL.md 预览（未执行命令）/),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("streamdown")).toHaveTextContent("本地预览内容");
  });
});