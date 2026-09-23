import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  rejectForVisibleTerminal,
  type VisibleTerminalGateInput,
} from "./visibleTerminalGate";

/**
 * #118（2026-09-23）实测现场：用户选了"可见终端执行"，人停在欢迎页。
 * SSH 在后台是连着的（store connected、rust 会话号也在），但一块终端都没挂载
 * ⇒ 前端回 unavailable，agent 连撞三次同一个墙后汇报"命令未执行"。
 * 旧写法把三种情况揉成一句"没有与该 SSH 会话匹配的可见终端"，用户看不出该做什么。
 * 这里钉的是：**原因要分得开，文案要能照着做**；安全口径不变（不执行、不偷换后台）。
 */

function gate(over: Partial<VisibleTerminalGateInput> = {}): VisibleTerminalGateInput {
  return {
    hasRequestId: true,
    hasCommand: true,
    currentSessionId: 14,
    requestedSessionId: 14,
    leafId: 10,
    terminalMounted: true,
    ...over,
  };
}

describe("可见终端执行门禁：原因必须可分辨", () => {
  it("一切正常 → 不拒绝（正向配对：否则下面所有'被拒绝'都可能是恒真）", () => {
    expect(rejectForVisibleTerminal(gate())).toBeNull();
  });

  it("终端没挂载（停在欢迎页）→ no_visible_terminal，文案指向'打开工作区'", () => {
    const r = rejectForVisibleTerminal(gate({terminalMounted: false}));
    expect(r?.reason).toBe("no_visible_terminal");
    expect(r?.message).toContain("打开");
    expect(r?.message).toContain("工作区");
  });

  it("没有可见 SSH leaf（本地标签页在前）→ 同样归到 no_visible_terminal", () => {
    expect(rejectForVisibleTerminal(gate({leafId: null}))?.reason).toBe(
      "no_visible_terminal",
    );
  });

  it("会话号不匹配 → session_mismatch，且原因必须与上一个不同（三态不塌成一态）", () => {
    const mismatch = rejectForVisibleTerminal(gate({currentSessionId: 9}));
    expect(mismatch?.reason).toBe("session_mismatch");
    expect(mismatch?.reason).not.toBe(
      rejectForVisibleTerminal(gate({terminalMounted: false}))?.reason,
    );
    expect(mismatch?.message).toContain("标签页");
  });

  it("真实现场：当前压根没有可见 SSH 终端（本地标签页在前／欢迎页）→ no_visible_terminal", () => {
    // 上一轮我把这条写成 session_mismatch —— 那是把缺陷写进期望。
    // 现场三件事是同时成立的：取不到可见会话号、没有 SSH leaf、终端没挂载，
    // 而旧顺序先判会话号，于是"根本没终端"被告知"切回那台服务器的标签页"，
    // 用户照着切却发现没有这个标签页（2026-09-23 真机 agent 回合复现）。
    const r = rejectForVisibleTerminal(
      gate({currentSessionId: null, leafId: null, terminalMounted: false}),
    );
    expect(r?.reason).toBe("no_visible_terminal");
    expect(r?.message).toContain("终端");
  });

  it("只有会话号不同（那块终端确实存在，只是另一台机器）→ 才说 session_mismatch", () => {
    const r = rejectForVisibleTerminal(gate({currentSessionId: 3}));
    expect(r?.reason).toBe("session_mismatch");
    // 两态不许塌成一态：同样"不执行"，但指点的动作不同。
    expect(r?.reason).not.toBe(
      rejectForVisibleTerminal(gate({currentSessionId: null, leafId: null}))?.reason,
    );
  });

  it("请求缺 requestId / 缺命令 → malformed_request", () => {
    expect(rejectForVisibleTerminal(gate({hasRequestId: false}))?.reason).toBe(
      "malformed_request",
    );
    expect(rejectForVisibleTerminal(gate({hasCommand: false}))?.reason).toBe(
      "malformed_request",
    );
  });

  it("每条拒绝都要说清'命令未执行'（绝不让人以为已经跑了）", () => {
    const cases: Partial<VisibleTerminalGateInput>[] = [
      {terminalMounted: false},
      {leafId: undefined},
      {currentSessionId: 3},
      {currentSessionId: null},
      {hasRequestId: false},
    ];
    for (const c of cases) {
      const r = rejectForVisibleTerminal(gate(c));
      expect(r, `这组入参应当被拒：${JSON.stringify(c)}`).not.toBeNull();
      expect(r?.message).toContain("未执行");
    }
  });
});

/**
 * 接线钉：useAiLiveBridge 是个 hook，`startVisibleTerminalExecution` 埋在 effect 里，
 * 单元层挂不出来。删掉调用点后上面七条仍全绿 —— 所以按本仓既有做法（静态扫描）
 * 钉住"桥真的用这个判据"，并且钉住旧的那句糊话不许回来。
 */
describe("useAiLiveBridge 必须走这份判据（接线）", () => {
  const src = readFileSync(
    join(process.cwd(), "src/modules/ai/lib/useAiLiveBridge.ts"),
    "utf8",
  );

  it("可见终端执行调用 rejectForVisibleTerminal", () => {
    const start = src.indexOf("const startVisibleTerminalExecution = ");
    expect(start, "找不到 startVisibleTerminalExecution，门禁失效").toBeGreaterThan(-1);
    const body = src.slice(start, start + 4000);
    expect(
      body.includes("rejectForVisibleTerminal({"),
      "可见终端的拒绝原因又退回手写分支了 —— #118 会复发",
    ).toBe(true);
  });

  it("不许再把三种原因糊成一句 visible_terminal_unavailable", () => {
    expect(src).not.toContain("visible_terminal_unavailable");
  });
});
