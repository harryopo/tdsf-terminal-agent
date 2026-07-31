/**
 * translateStore.test.ts — 翻译 store 状态机测试
 *
 * 2026-07-31 新增：覆盖 showTooltip / showMissing / hideTooltip / toggleEnabled
 * 关键场景，确保翻译模块未命中词典时也能给用户反馈。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useTranslateStore } from "./translateStore";
import type { TranslationResult } from "./translateApi";

const sampleResult: TranslationResult = {
  source: "ls",
  target: "[命令] 列出目录内容 (linux)",
  success: true,
  entries: [{ word: "ls", zh: "列出目录内容", pos: "命令", tag: "linux", exact: true }],
};

function reset() {
  useTranslateStore.setState({
    enabled: false,
    result: null,
    missing: null,
    x: 0,
    y: 0,
  });
}

describe("translateStore", () => {
  beforeEach(reset);

  it("showTooltip 设置 result 并清除 missing", () => {
    useTranslateStore.getState().showMissing("xxx", 10, 20);
    useTranslateStore.getState().showTooltip(sampleResult, 30, 40);
    const s = useTranslateStore.getState();
    expect(s.result).toEqual(sampleResult);
    expect(s.missing).toBeNull();
    expect(s.x).toBe(30);
    expect(s.y).toBe(40);
  });

  it("showMissing 设置 missing 并清除 result", () => {
    useTranslateStore.getState().showTooltip(sampleResult, 30, 40);
    useTranslateStore.getState().showMissing("unknown", 50, 60);
    const s = useTranslateStore.getState();
    expect(s.missing).toBe("unknown");
    expect(s.result).toBeNull();
    expect(s.x).toBe(50);
    expect(s.y).toBe(60);
  });

  it("hideTooltip 清除 result 和 missing", () => {
    useTranslateStore.getState().showTooltip(sampleResult, 1, 2);
    useTranslateStore.getState().showMissing("foo", 3, 4);
    useTranslateStore.getState().hideTooltip();
    const s = useTranslateStore.getState();
    expect(s.result).toBeNull();
    expect(s.missing).toBeNull();
  });

  it("toggleEnabled 关闭时清除 result 和 missing", () => {
    useTranslateStore.getState().setEnabled(true);
    useTranslateStore.getState().showMissing("foo", 1, 2);
    useTranslateStore.getState().toggleEnabled(); // true → false
    const s = useTranslateStore.getState();
    expect(s.enabled).toBe(false);
    expect(s.result).toBeNull();
    expect(s.missing).toBeNull();
  });

  it("setEnabled(false) 清除 result 和 missing", () => {
    useTranslateStore.getState().showTooltip(sampleResult, 1, 2);
    useTranslateStore.getState().showMissing("foo", 3, 4);
    useTranslateStore.getState().setEnabled(false);
    const s = useTranslateStore.getState();
    expect(s.enabled).toBe(false);
    expect(s.result).toBeNull();
    expect(s.missing).toBeNull();
  });

  it("setEnabled(true) 不清除已设置的 result/missing", () => {
    useTranslateStore.getState().showTooltip(sampleResult, 1, 2);
    useTranslateStore.getState().setEnabled(true);
    const s = useTranslateStore.getState();
    expect(s.enabled).toBe(true);
    expect(s.result).toEqual(sampleResult);
  });
});
