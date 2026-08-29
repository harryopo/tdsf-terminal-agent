// registry.ts 单元测试（v3.1 收敛版）
// -----------------------------------------------------------------------------
// v3.1（方案书 §4.1 / spec: add-agent-trust-modes）：
// 4 子 agent（coder/explore/history/teach）委派机制已删除，TDSF_AGENTS 收敛为
// main 单入口。能力差异由 AgentMode 三模式信任体系 + Teach 教学皮肤表达。
//
// 覆盖:
//   1. TDSF_AGENTS 仅 main 入口且 pythonName 与 Python AGENT_REGISTRY 对应
//   2. isTdsfAgent 类型守卫（合法/非法 id）
//   3. AgentMode 三档 + isAgentMode 守卫 + DEFAULT_AGENT_MODE = confirm
//   4. AGENT_MODE_META / AGENT_MODES 完整性（切换器与 Pill 渲染依赖）
import { describe, expect, it } from "vitest";
import {
  AGENT_MODES,
  AGENT_MODE_META,
  DEFAULT_AGENT_MODE,
  DEFAULT_TDSF_AGENT,
  isAgentMode,
  isTdsfAgent,
  TDSF_AGENTS,
  type AgentMode,
  type TdsfAgentId,
} from "./registry";

describe("TDSF_AGENTS — v3.1 收敛为 main 单入口", () => {
  it("注册表仅含 main 入口（4 子 agent 委派已删除）", () => {
    expect(Object.keys(TDSF_AGENTS)).toEqual(["main"]);
  });

  it("main 入口有 pythonName 字段（与 Python AGENT_REGISTRY 对应）", () => {
    const agent = TDSF_AGENTS.main;
    expect(agent.pythonName).toBe("main");
    expect(agent.label.length).toBeGreaterThan(0);
    expect(agent.mode.length).toBeGreaterThan(0);
    expect(agent.desc.length).toBeGreaterThan(0);
    expect(agent.systemPrompt.length).toBeGreaterThan(0);
  });

  it("id 字段与 Record key 严格一一对应", () => {
    for (const key of Object.keys(TDSF_AGENTS) as TdsfAgentId[]) {
      expect(TDSF_AGENTS[key].id).toBe(key);
    }
  });

  it("DEFAULT_TDSF_AGENT 是 'main'（唯一入口）", () => {
    expect(DEFAULT_TDSF_AGENT).toBe("main");
  });
});

describe("isTdsfAgent — 类型守卫", () => {
  it("合法 id 返回 true", () => {
    expect(isTdsfAgent("main")).toBe(true);
  });

  it("旧子 agent id 与其他非法 id 返回 false", () => {
    // v3.1 已删除的 4 个前端子 agent 入口
    expect(isTdsfAgent("coder")).toBe(false);
    expect(isTdsfAgent("explore")).toBe(false);
    expect(isTdsfAgent("history")).toBe(false);
    expect(isTdsfAgent("teach")).toBe(false);
    // Python key 与任意非法字符串
    expect(isTdsfAgent("coding")).toBe(false);
    expect(isTdsfAgent("")).toBe(false);
    expect(isTdsfAgent("unknown")).toBe(false);
  });

  it("类型守卫收窄后能直接索引 TDSF_AGENTS", () => {
    const ids = ["main", "teach", "invalid"];
    for (const id of ids) {
      if (isTdsfAgent(id)) {
        const agent = TDSF_AGENTS[id];
        expect(agent).toBeDefined();
        expect(agent.pythonName.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("AgentMode — 三模式信任体系（v3.1）", () => {
  it("三档常量列表顺序与档位正确", () => {
    expect(AGENT_MODES).toEqual(["observe", "confirm", "auto"]);
  });

  it("DEFAULT_AGENT_MODE 是 confirm（缺省缺字段最安全中间态）", () => {
    expect(DEFAULT_AGENT_MODE).toBe("confirm");
  });

  it("isAgentMode 类型守卫正确", () => {
    expect(isAgentMode("observe")).toBe(true);
    expect(isAgentMode("confirm")).toBe(true);
    expect(isAgentMode("auto")).toBe(true);
    expect(isAgentMode("debug")).toBe(false);
    expect(isAgentMode("")).toBe(false);
    expect(isAgentMode("OBSERVE")).toBe(false);
  });

  it("AGENT_MODE_META 与三档一一对应（label/badge/desc 非空）", () => {
    for (const mode of AGENT_MODES as readonly AgentMode[]) {
      const meta = AGENT_MODE_META[mode];
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.badge).toContain(meta.label);
      expect(meta.desc.length).toBeGreaterThan(0);
    }
    expect(Object.keys(AGENT_MODE_META).sort()).toEqual(
      ["auto", "confirm", "observe"].sort(),
    );
  });
});
