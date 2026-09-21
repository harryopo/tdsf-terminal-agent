/**
 * commandCardTarget —— 命令卡的归属终端守卫（#91 第⑤条）。
 *
 * 要钉住的行为：tab1 生成的命令卡，切到 tab2 再点 Run，命令**不许**打进 tab2。
 */
import { describe, expect, it } from "vitest";
import {
  driftMessage,
  targetDrift,
  type TerminalTarget,
} from "./commandCardTarget";

const tab1 = (over?: Partial<TerminalTarget>): TerminalTarget => ({
  tabId: 1,
  leafId: 11,
  sshRustSessionId: null,
  label: "docs",
  ...over,
});

describe("targetDrift", () => {
  it("卡片生成时就没有活动终端 → 不拦（没有归属可言，保持既有行为）", () => {
    expect(targetDrift(null, tab1())).toBeNull();
    expect(targetDrift(null, null)).toBeNull();
  });

  it("还是同一条终端 → 放行", () => {
    expect(targetDrift(tab1(), tab1())).toBeNull();
  });

  it("换到别的标签页 → other-terminal", () => {
    expect(targetDrift(tab1(), tab1({ tabId: 2, leafId: 21 }))).toBe(
      "other-terminal",
    );
  });

  it("同一个标签页里切了分屏 pane → 也算换人", () => {
    expect(targetDrift(tab1(), tab1({ leafId: 12 }))).toBe("other-terminal");
  });

  it("标签页没变但 SSH 重连过（会话号变了）→ 算换人", () => {
    expect(targetDrift(tab1({ sshRustSessionId: 7 }), tab1({ sshRustSessionId: 8 }))).toBe(
      "other-terminal",
    );
  });

  it("本地终端 ↔ SSH 终端互切 → 算换人", () => {
    expect(targetDrift(tab1(), tab1({ sshRustSessionId: 7 }))).toBe(
      "other-terminal",
    );
    expect(targetDrift(tab1({ sshRustSessionId: 7 }), tab1())).toBe(
      "other-terminal",
    );
  });

  it("有归属但当前没有终端了 → no-terminal", () => {
    expect(targetDrift(tab1(), null)).toBe("no-terminal");
  });
});

describe("driftMessage", () => {
  it("要说清切回哪一条，并承诺不会打进别的终端", () => {
    const msg = driftMessage("other-terminal", tab1({ label: "root@10.0.0.8" }));
    expect(msg).toContain("root@10.0.0.8");
    expect(msg).toContain("不会打进别的终端");
    expect(driftMessage("no-terminal", tab1({ label: "docs" }))).toContain(
      "当前没有可用终端",
    );
  });
});
