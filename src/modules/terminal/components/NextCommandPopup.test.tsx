import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordTerminalBlock } from "@/modules/prediction/sessionBridge";
import {
  cancelAutoCorrection,
  closeNextCommand,
  getNextCommandState,
  initNextCommandInjection,
  nextCommandKeyHandler,
  openCorrection,
  openCorrectionForCommand,
  openNextCommand,
} from "@/modules/terminal/lib/nextCommandInjection";
import { NextCommandPopup } from "./NextCommandPopup";

let line = "";
let written: string[] = [];
const leaf = 3101;
let activeLeaf = leaf;

beforeEach(() => {
  cancelAutoCorrection();
  closeNextCommand();
  line = "";
  written = [];
  activeLeaf = leaf;
  initNextCommandInjection({
    getLine: () => line,
    writeLine: (_leafId, nextLine) => {
      written.push(nextLine);
      line = nextLine;
      return true;
    },
    getEnvironment: () => "linux",
    getRustSessionId: () => 1,
    getAvailableCommands: (_leafId, _rustSessionId) =>
      new Set(["pwd", "ls", "grep"]),
    getActiveLeafId: () => activeLeaf,
    evaluateRisk: async () => ({ level: "L0", source: "rpc" }),
  });
});

afterEach(() => {
  cleanup();
  cancelAutoCorrection();
  closeNextCommand();
});

describe("NextCommandPopup", () => {
  it("renders correction candidates and click only fills the line", async () => {
    recordTerminalBlock({
      sessionId: leaf,
      command: "grep -n error app.log",
      cwd: "",
      exitCode: 0,
      durationMs: 10,
      author: "user",
      startedAt: 1,
    });
    line = "grpe -n error app.log";

    await act(async () => {
      await openCorrection(leaf);
    });

    render(<NextCommandPopup />);
    expect(screen.getByTestId("next-command-popup")).toBeTruthy();
    expect(screen.getByText("当前行纠错")).toBeTruthy();
    expect(screen.getByText("原命令")).toBeTruthy();
    expect(screen.getByText("仅回填，不执行")).toBeTruthy();
    const candidate = screen.getByText("grep -n error app.log");
    fireEvent.click(candidate);

    expect(written).toEqual(["grep -n error app.log"]);
    expect(written[0]).not.toMatch(/[\r\n]/);
  });

  it("127 失败命令语境显示原命令与“上一条命令未找到”", async () => {
    recordTerminalBlock({
      sessionId: leaf,
      command: "grep -n error app.log",
      cwd: "",
      exitCode: 0,
      durationMs: 10,
      author: "user",
      startedAt: 1,
    });
    line = "";

    await act(async () => {
      await openCorrectionForCommand(leaf, "grpe -n error app.log");
    });

    render(<NextCommandPopup />);
    expect(screen.getByText("上一条命令未找到")).toBeTruthy();
    expect(screen.getByText("grpe -n error app.log")).toBeTruthy();
    expect(screen.getByText("grep -n error app.log")).toBeTruthy();
    expect(screen.getByText("仅回填，不执行")).toBeTruthy();
  });

  it("默认只显示首选；↓ 展开全部；↑ 在首项时收起", async () => {
    const leaf2 = 3102;
    activeLeaf = leaf2;
    for (const command of ["pwd", "ls", "grep"]) {
      recordTerminalBlock({
        sessionId: leaf2,
        command,
        cwd: "",
        exitCode: 0,
        durationMs: 5,
        author: "user",
        startedAt: 3,
      });
    }
    line = "";

    await act(async () => {
      await openNextCommand(leaf2);
    });
    render(<NextCommandPopup />);

    const total = getNextCommandState().candidates.length;
    expect(total).toBeGreaterThan(1);
    // 收起态：DOM 里只渲染最优先的一条。
    expect(screen.getAllByTestId("next-command-candidate").length).toBe(1);

    act(() => {
      nextCommandKeyHandler(
        leaf2,
        new KeyboardEvent("keydown", { key: "ArrowDown" }),
      );
    });
    expect(getNextCommandState().expanded).toBe(true);
    expect(screen.getAllByTestId("next-command-candidate").length).toBe(total);

    act(() => {
      nextCommandKeyHandler(
        leaf2,
        new KeyboardEvent("keydown", { key: "ArrowDown" }),
      );
    });
    expect(getNextCommandState().selectedIndex).toBe(1);

    act(() => {
      nextCommandKeyHandler(
        leaf2,
        new KeyboardEvent("keydown", { key: "ArrowUp" }),
      );
    });
    expect(getNextCommandState().selectedIndex).toBe(0);

    act(() => {
      nextCommandKeyHandler(
        leaf2,
        new KeyboardEvent("keydown", { key: "ArrowUp" }),
      );
    });
    expect(getNextCommandState().expanded).toBe(false);
    expect(screen.getAllByTestId("next-command-candidate").length).toBe(1);
  });

  it("App.tsx mounts the popup (wiring guard)", () => {
    const source = readFileSync("src/app/App.tsx", "utf8");
    expect(source).toContain(
      'import { NextCommandPopup } from "@/modules/terminal/components/NextCommandPopup";',
    );
    expect(source).toContain("<NextCommandPopup />");
  });
});
