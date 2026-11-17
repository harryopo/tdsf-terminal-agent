/**
 * TEAM-FIX-01 定向用例：技能结果合同与两个入口
 * -----------------------------------------------------------------------------
 * 覆盖 Issue #53 第二阶段与 ROOT 本轮新增边界：
 *   1. not_run 优先于 executor/success/output 混合字段
 *   2. 正常/空参考、when_to_use 与 whenToUse 兼容
 *   3. 非法参考字段（content 为对象）、未知对象、IPC 异常 → 不成功兜底
 *   4. 确证 executed 成功/失败；output-only 旧结果必须展示真实 output
 *   5. store → 对话框、store → /skill：mode/通知一致
 *   6. 历史缺 mode 不清除、不反推执行；recordHistory=false 不写历史
 *   7. 两个对话框收到 executed 时不得同时出现“未执行命令”
 *
 * 断言使用原生 DOM 属性，不依赖全局 jest-dom matcher。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillContentDialog } from "./SkillContentDialog";
import { SkillInvoker } from "./SkillInvoker";
import { invokeSkill } from "./executor";
import {
  describeSkillContext,
  describeSkillResult,
  type SkillResultNotice,
} from "./resultNotice";
import { runSlashSkillCommand } from "./slashSkill";
import { useSkillsStore } from "./skillsStore";
import type { SkillExecution, SkillHistoryEntry, SkillMetadata } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("streamdown", () => ({
  Streamdown: ({ children }: { children?: string }) => (
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

function textOf(el: Element | null): string {
  return el?.textContent ?? "";
}

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
  });

  it("非法参考字段（content 为对象）返回 unknown，不按成功参考兜底", async () => {
    mockedInvoke.mockResolvedValue({
      ok: true,
      result: { content: { unexpected: true } },
    } as never);

    const res = await invokeSkill("linux-ops", "");

    expect(res.mode).toBe("unknown");
    expect(res.success).toBe(false);
    expect(res.output).toContain("无法识别");
  });

  it("非法参考字段（数组/标量/null）同样返回 unknown", async () => {
    const cases: unknown[] = [[], 123, null, true];
    for (const value of cases) {
      mockedInvoke.mockResolvedValueOnce({
        ok: true,
        result: { content: value, when_to_use: value },
      } as never);
      const res = await invokeSkill("bad", "");
      expect(res.mode).toBe("unknown");
      expect(res.success).toBe(false);
    }
  });

  it("未知/格式错误结果返回 unknown", async () => {
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

  it("output-only 旧执行结果展示真实 output，不显示“无输出”", async () => {
    mockedInvoke.mockResolvedValue({
      ok: true,
      result: {
        success: true,
        exit_code: 0,
        output: "synthetic actual output",
      },
    } as never);

    const res = await invokeSkill("legacy", "");

    expect(res.mode).toBe("executed");
    expect(res.output).toContain("synthetic actual output");
    expect(res.output).not.toContain("(无输出)");
  });

  it("有 stdout 时不重复展示 output 字段", async () => {
    mockedInvoke.mockResolvedValue({
      ok: true,
      result: {
        success: true,
        exit_code: 0,
        output: "same text",
        stdout: "same text",
      },
    } as never);

    const res = await invokeSkill("legacy", "");
    const occurrences = res.output.split("same text").length - 1;

    expect(res.mode).toBe("executed");
    expect(occurrences).toBe(1);
    expect(res.output).not.toContain("## output");
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

describe("describeSkillResult / describeSkillContext", () => {
  const base: SkillExecution = {
    success: true,
    output: "参考",
    durationMs: 1,
    mode: "reference",
  };

  it("四种 mode 的标签与顶部说明互不矛盾", () => {
    expect(describeSkillResult("s", base).label).toBe("参考资料已加载");
    expect(describeSkillResult("s", { ...base, empty: true }).label).toBe(
      "未提供参考资料",
    );
    expect(describeSkillResult("s", { ...base, mode: "executed" }).label).toBe(
      "执行结束",
    );
    expect(
      describeSkillResult("s", { ...base, mode: "executed", success: false })
        .label,
    ).toBe("执行失败");
    expect(describeSkillResult("s", { ...base, mode: "unknown" }).label).toBe(
      "结果无法识别",
    );
    expect(
      describeSkillResult("s", { ...base, mode: "failed", success: false })
        .label,
    ).toBe("读取失败");

    expect(describeSkillContext(null)).toContain("仅提供参考资料");
    expect(describeSkillContext(base)).toContain("仅提供参考资料");
    expect(describeSkillContext({ ...base, mode: "executed" })).toContain(
      "执行结果",
    );
    expect(describeSkillContext({ ...base, mode: "executed" })).not.toContain(
      "未执行命令",
    );
    expect(describeSkillContext({ ...base, mode: "unknown" })).not.toContain(
      "未执行命令",
    );
  });
});

describe("SkillInvoker — 参考界面文案", () => {
  it("not_run 资料加载后显示参考资料与未执行提示", async () => {
    mockedInvoke.mockResolvedValue({ ok: true, result: referenceResult } as never);

    render(<SkillInvoker skill={skill} onOpenChange={() => {}} />);
    fireEvent.click(screen.getByTestId("skill-invoker-submit"));

    await waitFor(() => {
      expect(textOf(screen.getByTestId("skill-invoker-output"))).toContain(
        "仅作参考",
      );
    });
    expect(screen.getAllByText(/参考资料已加载/).length).toBeGreaterThan(0);
    expect(
      screen.getByText(/仅提供参考资料，未执行命令/),
    ).toBeTruthy();
    expect(screen.queryByText(/执行完成/)).toBeNull();
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
  });

  it("unknown 结果明确提示，不显示成功参考", async () => {
    mockedInvoke.mockResolvedValue({ ok: true, result: {} } as never);

    render(<SkillInvoker skill={skill} onOpenChange={() => {}} />);
    fireEvent.click(screen.getByTestId("skill-invoker-submit"));

    await waitFor(() => {
      expect(textOf(screen.getByTestId("skill-invoker-output"))).toContain(
        "无法识别",
      );
    });
    expect(screen.queryByText(/参考资料已加载/)).toBeNull();
  });

  it("executed 结果显示执行输出，不再固定声称未执行", async () => {
    mockedInvoke.mockResolvedValue({ ok: true, result: executedResult } as never);

    render(<SkillInvoker skill={skill} onOpenChange={() => {}} />);
    fireEvent.click(screen.getByTestId("skill-invoker-submit"));

    await waitFor(() => {
      expect(textOf(screen.getByTestId("skill-invoker-output"))).toContain(
        "up 3 days",
      );
    });
    expect(screen.getByText(/返回既有执行结果/)).toBeTruthy();
    expect(screen.queryByText(/仅提供参考资料，未执行命令/)).toBeNull();
    expect(screen.queryByText(/执行完成/)).toBeNull();
  });

  it("executed 失败显示 stderr 与执行失败，不写未执行", async () => {
    mockedInvoke.mockResolvedValue({
      ok: true,
      result: {
        ...executedResult,
        success: false,
        exit_code: 1,
        stdout: "",
        stderr: "boom",
      },
    } as never);

    render(<SkillInvoker skill={skill} onOpenChange={() => {}} />);
    fireEvent.click(screen.getByTestId("skill-invoker-submit"));

    await waitFor(() => {
      expect(textOf(screen.getByTestId("skill-invoker-output"))).toContain(
        "boom",
      );
    });
    expect(screen.getByText(/执行失败/)).toBeTruthy();
    expect(screen.queryByText(/仅提供参考资料，未执行命令/)).toBeNull();
  });
});

describe("SkillContentDialog — 侧栏入口同样按 mode 展示", () => {
  it("reference 展示参考内容并说明未执行", async () => {
    mockedInvoke.mockResolvedValue({ ok: true, result: referenceResult } as never);

    render(<SkillContentDialog skill={skill} onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(textOf(screen.getByTestId("streamdown"))).toContain("仅作参考");
    });
    expect(screen.getByText(/仅提供参考资料，未执行命令/)).toBeTruthy();
    expect(screen.getByText("参考资料已加载")).toBeTruthy();
  });

  it("空参考明确显示未提供参考资料", async () => {
    mockedInvoke.mockResolvedValue({
      ok: true,
      result: { ...referenceResult, content: "", when_to_use: "" },
    } as never);

    render(<SkillContentDialog skill={skill} onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("该技能未提供参考资料。")).toBeTruthy();
    });
  });

  it("读取失败回退本地预览并标注未执行", async () => {
    mockedInvoke.mockResolvedValue({ ok: false, error: "ipc down" } as never);

    render(<SkillContentDialog skill={skill} onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(
        screen.getByText(/以下为本地 SKILL.md 预览（未执行命令）/),
      ).toBeTruthy();
    });
    expect(textOf(screen.getByTestId("streamdown"))).toContain("本地预览内容");
  });

  it("executed 结果展示真实输出，不丢内容也不自称未执行", async () => {
    mockedInvoke.mockResolvedValue({ ok: true, result: executedResult } as never);

    render(<SkillContentDialog skill={skill} onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(textOf(screen.getByTestId("streamdown"))).toContain("up 3 days");
    });
    expect(screen.getByText(/返回既有执行结果/)).toBeTruthy();
    expect(screen.queryByText(/仅提供参考资料，未执行命令/)).toBeNull();
    expect(screen.queryByText(/暂无内容/)).toBeNull();
  });

  it("executed 失败展示 stderr，不显示暂无内容或未执行", async () => {
    mockedInvoke.mockResolvedValue({
      ok: true,
      result: {
        ...executedResult,
        success: false,
        exit_code: 1,
        stdout: "",
        stderr: "boom",
      },
    } as never);

    render(<SkillContentDialog skill={skill} onOpenChange={() => {}} />);

    await waitFor(() => {
      expect(textOf(screen.getByTestId("streamdown"))).toContain("boom");
    });
    expect(screen.getByText(/执行失败/)).toBeTruthy();
    expect(screen.queryByText(/暂无内容/)).toBeNull();
    expect(screen.queryByText(/仅提供参考资料，未执行命令/)).toBeNull();
  });
});

describe("/skill 消费段 — runSlashSkillCommand", () => {
  it("只调用一次 invoke，通知与 reference 结果一致", async () => {
    const invokeFn = vi.fn().mockResolvedValue({
      success: true,
      output: "参考",
      durationMs: 1,
      mode: "reference",
    } as SkillExecution);
    const notices: SkillResultNotice[] = [];

    await runSlashSkillCommand(
      { name: "linux-ops", args: "uptime" },
      invokeFn,
      (n) => notices.push(n),
    );

    expect(invokeFn).toHaveBeenCalledTimes(1);
    expect(invokeFn).toHaveBeenCalledWith("linux-ops", "uptime");
    expect(notices[0]?.label).toBe("参考资料已加载");
    expect(notices[0]?.description).toContain("未执行命令");
  });

  it("executed 通知执行结束，unknown 通知无法识别", async () => {
    const executedInvoke = vi.fn().mockResolvedValue({
      success: true,
      output: "up",
      durationMs: 1,
      mode: "executed",
    } as SkillExecution);
    const executedNotices: SkillResultNotice[] = [];
    await runSlashSkillCommand(
      { name: "uptime", args: "" },
      executedInvoke,
      (n) => executedNotices.push(n),
    );
    expect(executedNotices[0]?.label).toBe("执行结束");
    expect(executedNotices[0]?.title).not.toContain("参考资料");

    const unknownInvoke = vi.fn().mockResolvedValue({
      success: false,
      output: "无法识别",
      durationMs: 1,
      mode: "unknown",
    } as SkillExecution);
    const unknownNotices: SkillResultNotice[] = [];
    await runSlashSkillCommand(
      { name: "mystery", args: "" },
      unknownInvoke,
      (n) => unknownNotices.push(n),
    );
    expect(unknownNotices[0]?.label).toBe("结果无法识别");
  });
});