// TDSF 阶段3: registry.ts 单元测试
// -----------------------------------------------------------------------------
// 验证:
//   1. TDSF_AGENTS 4 个 agent 都有 pythonName 字段（与 Python AGENT_REGISTRY 对应）
//   2. isTdsfAgent 类型守卫正确（合法 id 返回 true，非法 id 返回 false）
//   3. TDSF_AGENTS 的 id 字段与 key 严格一一对应（Record 类型保证）
//   4. 4 个 agent 的 pythonName 与 PLANS §11.1.2 映射表一致
import { describe, expect, it } from "vitest";
import {
  DEFAULT_TDSF_AGENT,
  isTdsfAgent,
  TDSF_AGENTS,
  type TdsfAgentId,
} from "./registry";

describe("TDSF_AGENTS — 4 agent 注册表完整性", () => {
  it("4 个 agent 都有 pythonName 字段（与 Python AGENT_REGISTRY 对应）", () => {
    const ids: TdsfAgentId[] = ["coder", "explore", "history", "teach"];
    for (const id of ids) {
      const agent = TDSF_AGENTS[id];
      expect(agent).toBeDefined();
      expect(typeof agent.pythonName).toBe("string");
      expect(agent.pythonName.length).toBeGreaterThan(0);
    }
  });

  it("pythonName 与 PLANS §11.1.2 映射表一致（coder→coding 等）", () => {
    expect(TDSF_AGENTS.coder.pythonName).toBe("coding");
    expect(TDSF_AGENTS.explore.pythonName).toBe("explore");
    expect(TDSF_AGENTS.history.pythonName).toBe("history");
    expect(TDSF_AGENTS.teach.pythonName).toBe("teach");
  });

  it("id 字段与 Record key 严格一一对应", () => {
    for (const key of Object.keys(TDSF_AGENTS) as TdsfAgentId[]) {
      expect(TDSF_AGENTS[key].id).toBe(key);
    }
  });

  it("4 个 agent 都有 label / mode / desc / systemPrompt 字段（前端 UI 必需）", () => {
    for (const id of Object.keys(TDSF_AGENTS) as TdsfAgentId[]) {
      const a = TDSF_AGENTS[id];
      expect(a.label.length).toBeGreaterThan(0);
      expect(a.mode.length).toBeGreaterThan(0);
      expect(a.desc.length).toBeGreaterThan(0);
      expect(a.systemPrompt.length).toBeGreaterThan(0);
    }
  });

  it("DEFAULT_TDSF_AGENT 是 'main'（v2026-07-29 统一主 Agent 入口）", () => {
    expect(DEFAULT_TDSF_AGENT).toBe("main");
  });
});

describe("isTdsfAgent — 类型守卫", () => {
  it("合法 id 返回 true", () => {
    expect(isTdsfAgent("main")).toBe(true); // v2026-07-29 统一主 Agent 入口
    expect(isTdsfAgent("coder")).toBe(true);
    expect(isTdsfAgent("explore")).toBe(true);
    expect(isTdsfAgent("history")).toBe(true);
    expect(isTdsfAgent("teach")).toBe(true);
  });

  it("非法 id 返回 false", () => {
    expect(isTdsfAgent("coding")).toBe(false); // Python key，不是前端 id
    expect(isTdsfAgent("debug")).toBe(false);
    expect(isTdsfAgent("refactor")).toBe(false);
    expect(isTdsfAgent("test")).toBe(false);
    expect(isTdsfAgent("deploy")).toBe(false);
    expect(isTdsfAgent("")).toBe(false);
    expect(isTdsfAgent("unknown")).toBe(false);
  });

  it("类型守卫收窄后能直接索引 TDSF_AGENTS", () => {
    const ids = ["coder", "explore", "history", "teach", "invalid"];
    for (const id of ids) {
      if (isTdsfAgent(id)) {
        // TypeScript 编译期: 这里 id 已收窄为 TdsfAgentId，可直接索引
        const agent = TDSF_AGENTS[id];
        expect(agent).toBeDefined();
        expect(agent.pythonName.length).toBeGreaterThan(0);
      }
    }
  });
});
