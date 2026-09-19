/**
 * PredictionHistorySection + 预测历史清空的边界（P5）
 * -----------------------------------------------------------------------------
 * 锁三件事：
 *  1. 「清空预测历史」**只能发指令给主窗**——设置窗自己那份引擎是空的，
 *     在本窗 clearHistory() 等于什么都没清（真机实测抓出来的坑）；
 *  2. 顺手关掉自动导入（否则重启就被 shell histfile 里的手误行回填）；
 *  3. 清空是不可逆动作，必须两次点击；对用户 shell 历史文件零写入（源码断言）。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { PredictionHistorySection } from "./PredictionHistorySection";
import { getSuggestEngine } from "@/lib/suggest-engine";
import { usePreferencesStore } from "@/modules/settings/preferences";
import * as settingsStore from "@/modules/settings/store";

const emitTo = vi.fn(async (_label: string, _event: string) => undefined);
vi.mock("@tauri-apps/api/event", () => ({
  emitTo: (label: string, event: string) => emitTo(label, event),
  listen: async () => () => undefined,
}));

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

beforeEach(() => {
  vi.restoreAllMocks();
  emitTo.mockClear();
  getSuggestEngine().clearHistory();
  usePreferencesStore.setState({ predictionImportShellHistory: true });
});

describe("PredictionHistorySection", () => {
  it("requires a second click before clearing (不可逆动作要确认)", () => {
    render(<PredictionHistorySection />);

    fireEvent.click(screen.getByRole("button", { name: /清空预测历史/ }));

    expect(emitTo).not.toHaveBeenCalled();
    // getByRole 找不到就抛错，等价于"确认态按钮已出现"
    expect(
      screen.getByRole("button", { name: /再次点击确认清空/ }),
    ).toBeTruthy();
  });

  it("asks the main window to clear and disables shell-history import", () => {
    // 本窗引擎先塞一条：确认按钮**不该**去动它（动了就是清错了对象）
    const engine = getSuggestEngine();
    engine.addHistory("git", "linux");
    const spy = vi
      .spyOn(settingsStore, "setPredictionImportShellHistory")
      .mockResolvedValue();

    render(<PredictionHistorySection />);
    fireEvent.click(screen.getByRole("button", { name: /清空预测历史/ }));
    fireEvent.click(screen.getByRole("button", { name: /再次点击确认清空/ }));

    expect(emitTo).toHaveBeenCalledWith("main", "tdsf:prediction-clear");
    expect(spy).toHaveBeenCalledWith(false);
    expect(engine.getHistory("linux")).toHaveLength(1);
    expect(screen.getByTestId("prediction-clear-result")).toBeTruthy();
  });

  it("shows the shell history files as read-only in the copy (文案承诺不碰用户文件)", () => {
    render(<PredictionHistorySection />);
    expect(screen.getByText(/bash_history/).textContent).toContain("不会");
  });
});

describe("预测历史的来源边界", () => {
  it("preference defaults to importing shell history", () => {
    expect(usePreferencesStore.getState().predictionImportShellHistory).toBe(true);
  });

  it("history loading is gated by the preference", () => {
    const src = readFileSync(
      resolve(ROOT, "src/modules/terminal/lib/completionInjection.ts"),
      "utf8",
    );
    expect(src).toContain("predictionImportShellHistory");
    expect(src).toContain("loadHistoryIfNeeded");
  });

  it("no code path writes or deletes the user's own shell history files", () => {
    const sources = [
      "src/modules/terminal/lib/completionInjection.ts",
      "src/modules/terminal/lib/executionHistory.ts",
      "src/lib/shell-history.ts",
      "src/settings/sections/PredictionHistorySection.tsx",
    ].map((p) => readFileSync(resolve(ROOT, p), "utf8"));

    for (const src of sources) {
      // 读历史是允许的；写 / 追加 / 删除用户 histfile 不允许
      expect(src).not.toMatch(/\bappendFile\s*\(/);
      expect(src).not.toMatch(/\bwriteFileSync?\s*\(/);
      expect(src).not.toMatch(/\b(remove|unlink|rmSync)\s*\(/);
    }
  });
});
