/**
 * TEAM-FIX-01 定向用例：技能“只读参考”语义
 * -----------------------------------------------------------------------------
 * 覆盖 ROOT 在 Issue #53 指定的四类假 IPC 响应：
 *   1. 带 executor 元数据、execution=not_run 的参考资料
 *   2. 空资料
 *   3. 读取失败
 *   4. 既有 executed-result 兼容分支
 *
 * 断言参考路径只发一次 skill.invoke，没有额外 shell/SSH/终端写入调用；
 * 组件层断言界面不得把参考资料写成“执行完成”。
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
import { SkillInvoker } from "./SkillInvoker";
import { invokeSkill } from "./executor";
import { useSkillsStore } from "./skillsStore";
import type { SkillMetadata } from "./types";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const mockedInvoke = vi.mocked(invoke);

const skill: SkillMetadata = {
  name: "linux-ops",
  description: "Linux 运维参考",
  category: "linux",
  whenToUse: "排查 Linux 服务",
  examples: ["uptime"],
  source: "builtin",
  enabled: true,
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

beforeEach(() => {
  mockedInvoke.mockReset();
  useSkillsStore.setState({ invokingSkill: null, history: [] });
});

afterEach(() => {
  cleanup();
});

describe("invokeSkill — 参考结果语义", () => {
  it("not_run + executor 元数据只按参考资料返回，不写执行完成", async () => {
    mockedInvoke.mockResolvedValue({
      ok: true,
      result: referenceResult,
    } as never);

    const res = await invokeSkill("linux-ops", "");

    expect(res.mode).toBe("reference");
    expect(res.success).toBe(true);
    expect(res.output).toContain("仅作参考");
    expect(res.output).not.toContain("执行完成");
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    expect(mockedInvoke.mock.calls[0]?.[1]).toMatchObject({
      method: "skill.invoke",
      params: { name: "linux-ops" },
    });
  });

  it("空资料返回空输出，不伪装成执行成功", async () => {
    mockedInvoke.mockResolvedValue({
      ok: true,
      result: { ...referenceResult, content: "", when_to_use: "" },
    } as never);

    const res = await invokeSkill("linux-ops", "");

    expect(res.mode).toBe("reference");
    expect(res.output).toBe("");
    expect(res.output).not.toContain("执行完成");
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
  });

  it("读取失败如实返回 failed，不写成功", async () => {
    mockedInvoke.mockResolvedValue({
      ok: false,
      error: "skill not found: nope",
    } as never);

    const res = await invokeSkill("nope", "");

    expect(res.mode).toBe("failed");
    expect(res.success).toBe(false);
    expect(res.output).toContain("skill not found");
  });

  it("既有 executed 结果保持执行语义（兼容分支不删）", async () => {
    mockedInvoke.mockResolvedValue({
      ok: true,
      result: {
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
      },
    } as never);

    const res = await invokeSkill("uptime", "");

    expect(res.mode).toBe("executed");
    expect(res.success).toBe(true);
    expect(res.output).toContain("up 3 days");
  });
});

describe("SkillInvoker — 参考界面文案", () => {
  it("not_run 资料加载后显示参考资料与未执行提示，不出现执行完成", async () => {
    mockedInvoke.mockResolvedValue({
      ok: true,
      result: referenceResult,
    } as never);

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
});