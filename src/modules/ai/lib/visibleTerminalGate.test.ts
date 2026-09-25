import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  rejectForVisibleTerminal,
  rerouteToBackground,
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

  /**
   * #118 后半（2026-09-25 用户拍板）：只读命令在没有可见终端时改走后台。
   * 这道闸是"有没有可写终端"的唯一主人，所以**由它标注哪一种拒绝等于
   * "命令一个字都没写进终端"**（后台重派发因此不可能二次执行）；
   * 风险级不由这里判 —— 写操作要不要改道由 sidecar 决定。
   */
  it("no_visible_terminal → 标注可改道后台（连接活着、命令确实没写进去）", () => {
    expect(
      rejectForVisibleTerminal(gate({terminalMounted: false}))
        ?.reroutableToBackground,
    ).toBe(true);
  });

  it("另两种拒绝不许标注可改道（负向配正向）", () => {
    // session_mismatch：那块终端确实存在、只是另一台机器 → 悄悄打到另一台是更糟的
    // "所见非所跑"；malformed_request：连命令都没有，后台也没法执行。
    expect(
      rejectForVisibleTerminal(gate({currentSessionId: 3}))?.reroutableToBackground,
    ).toBe(false);
    expect(
      rejectForVisibleTerminal(gate({hasCommand: false}))?.reroutableToBackground,
    ).toBe(false);
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

  it("桥按门禁给的 reroutableToBackground 标记决定改道，不自己重判原因", () => {
    // 原因清单的主人只有这一个文件：桥里再写一遍 `reason === "no_visible_terminal"`
    // 就是同一件事两个主人（#116/#128 一族病：改一处忘改另一处）。
    const start = src.indexOf("const startVisibleTerminalExecution = ");
    const body = src.slice(start, start + 4000);
    expect(
      body.includes("rejected.reroutableToBackground"),
      "桥没有读门禁的改道标记 —— 只读命令又会白撞三次",
    ).toBe(true);
    expect(
      body.includes("rerouteToBackground("),
      "改道回执必须走这份载荷工厂，桥里不许各写一遍键名",
    ).toBe(true);
    expect(
      body.includes('reason === "no_visible_terminal"'),
      "桥里不许再抄一份原因判据",
    ).toBe(false);
  });
});

/**
 * 跨语言契约：sidecar 读的字面量是 `status=="reroute" && channel=="background"`
 * （strands_backend/tools/__init__.py）。写错一个字符不会报错，只会让只读命令
 * 退回"白撞三次"——所以载荷形状单独钉一条，两边各写一处、值必须逐字对上。
 */
describe("改道回执的载荷形状", () => {
  it("四个键与 sidecar 读的字段名逐字一致", () => {
    expect(rerouteToBackground("no_visible_terminal", "指引")).toEqual({
      status: "reroute",
      channel: "background",
      reason: "no_visible_terminal",
      message: "指引",
    });
  });
});
