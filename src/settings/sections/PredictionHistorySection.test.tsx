/**
 * PredictionHistorySection + 预测历史清空的边界（P5）
 * -----------------------------------------------------------------------------
 * 锁三件事：
 *  1. 「清空预测历史」确实清掉引擎的两个环境，并且顺手关掉自动导入
 *     （否则重启就被 shell histfile 里的手误行回填，清空等于没做）；
 *  2. 清空是不可逆动作，必须两次点击；
 *  3. 代码路径上不存在对用户 shell 历史文件的写入/删除（红线用源码断言守住）。
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

beforeEach(() => {
  vi.restoreAllMocks();
  getSuggestEngine().clearHistory();
  usePreferencesStore.setState({ predictionImportShellHistory: true });
});

describe("PredictionHistorySection", () => {
  it("requires a second click before clearing (不可逆动作要确认)", () => {
    getSuggestEngine().addHistory("git", "linux");
    render(<PredictionHistorySection />);

    fireEvent.click(screen.getByRole("button", { name: /清空预测历史/ }));

    expect(getSuggestEngine().getHistory("linux")).toHaveLength(1);
    // getByRole 找不到就抛错，等价于"确认态按钮已出现"
    expect(
      screen.getByRole("button", { name: /再次点击确认清空/ }),
    ).toBeTruthy();
  });

  it("clears both environments and disables shell-history import (清空 + 关导入)", () => {
    const engine = getSuggestEngine();
    engine.addHistory("git", "linux");
    engine.addHistory("git", "windows");
    const spy = vi.spyOn(settingsStore, "setPredictionImportShellHistory").mockResolvedValue();

    render(<PredictionHistorySection />);
    const button = screen.getByRole("button", { name: /清空预测历史/ });
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("button", { name: /再次点击确认清空/ }));

    expect(engine.getHistory("linux")).toEqual([]);
    expect(engine.getHistory("windows")).toEqual([]);
    expect(spy).toHaveBeenCalledWith(false);
    // 两行容量读数都归零
    expect(screen.getAllByText(/0\s*条/).length).toBe(2);
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
