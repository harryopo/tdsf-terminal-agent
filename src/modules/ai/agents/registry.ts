// ============================================================================
// TDSF Agent 注册表（与 Python Sidecar AGENT_REGISTRY 一一对应）
// ============================================================================
//
// v2026-07-29 改造：统一主 Agent 入口
//   - 新增 'main' 顶层 Agent：作为 PAOR 监督者，自动根据用户意图路由到 8 个子Agent
//   - 前端不再让用户手动切换 4 个 Tab，DEFAULT_TDSF_AGENT = 'main'
//   - 用户视角看是"一个统一的 AI"，实际由 main_agent 在 Python 端做智能调度
//   - 后端 main_agent.invoke() 会在 PAOR 循环中推送 agent_switch 事件，
//     前端 AgentStatusPill 实时显示"正在使用 Teach/Coding/Debug..."
//
// 映射关系（前端 id ↔ Python AGENT_REGISTRY key）:
//   main    ↔ main     (MainAgent — PAOR 监督 + 智能路由)
//   coder   ↔ coding   (CodingAgent  — 子Agent，被 main 调度)
//   explore ↔ explore  (ExploreAgent — 子Agent，被 main 调度)
//   history ↔ history  (HistoryAgent — 子Agent，被 main 调度)
//   teach   ↔ teach    (TeachAgent   — 子Agent，被 main 调度)
//
// 设计原则:
//   - 前端 id 用业务语义命名（coder），与 Python key（coding 动词形式）解耦
//   - pythonName 字段作为 RPC 调用时传入的 agent name（agent.invoke 的 params.name）
//   - 简短 systemPrompt 仅用于前端 Tab tooltip 展示，实际 prompt 由 Python 端 BaseAgent.build_system_prompt 生成
//
// 与现有 SUBAGENTS 的区别:
//   - SUBAGENTS 是 Vercel AI SDK 内部 subagent（run_subagent 工具的白名单），仅 fallback 路径用
//   - TDSF_AGENTS 是顶层 Agent 集合，其中 'main' 是统一入口，走 Python Sidecar 路径
//   - 两者互不冲突，可并存

/** TDSF 顶层 Agent 的 id（与 Python AGENT_REGISTRY key 一一对应） */
export type TdsfAgentId = "main" | "coder" | "explore" | "history" | "teach";

/** TDSF Agent 定义（前端 Tab + Python RPC 调用所需元数据） */
export type TdsfAgentDef = {
  /** 前端 id（业务语义命名） */
  id: TdsfAgentId;
  /** Tab 显示名 */
  label: string;
  /** 短模式标签（Header 徽章用，≤6 字符） */
  mode: string;
  /** 一句话描述（Tab tooltip + 空状态展示用） */
  desc: string;
  /** 对应 Python AGENT_REGISTRY 的 key（agent.invoke 的 params.name） */
  pythonName: "main" | "coding" | "explore" | "history" | "teach";
  /** 简短 system prompt（仅前端展示用，实际 prompt 由 Python 端构建） */
  systemPrompt: string;
};

/**
 * TDSF 顶层 Agent 注册表
 *
 * 用 Record<TdsfAgentId, TdsfAgentDef> 保证 id 字段与 key 严格一一对应，
 * TypeScript 编译期就能发现遗漏或拼写错误。
 *
 * v2026-07-29：'main' 作为统一入口，由 main_agent 自动路由到子Agent。
 */
export const TDSF_AGENTS: Record<TdsfAgentId, TdsfAgentDef> = {
  main: {
    id: "main",
    label: "Main",
    mode: "MAIN",
    desc: "统一主 Agent（PAOR 监督 + 智能路由到 8 个子 Agent）",
    pythonName: "main",
    systemPrompt:
      "Main Agent：PAOR 监督循环主 Agent。根据用户意图自动路由到 8 个子 Agent（coding / explore / history / teach / debug / refactor / test / deploy）。用户无需手动选择。",
  },
  coder: {
    id: "coder",
    label: "Coder",
    mode: "CODE",
    desc: "代码生成与重构",
    pythonName: "coding",
    systemPrompt:
      "Coding Agent：负责代码生成、修改、Bug 修复。调用 risk/decision/confidence 工具评估方案。",
  },
  explore: {
    id: "explore",
    label: "Explore",
    mode: "SCAN",
    desc: "代码库扫描与索引",
    pythonName: "explore",
    systemPrompt:
      "Explore Agent：只读分析代码库架构、追踪调用链、生成文档。不修改文件。",
  },
  history: {
    id: "history",
    label: "History",
    mode: "HIST",
    desc: "命令历史与回放",
    pythonName: "history",
    systemPrompt:
      "History Agent：检索过往会话、命令历史、错误模式，辅助复盘与教学。",
  },
  teach: {
    id: "teach",
    label: "Teach",
    mode: "TEACH",
    desc: "Linux 运维教学",
    pythonName: "teach",
    systemPrompt:
      "Teach Agent：基于知识库 + tldr-pages 解释命令原理、给出易错点与考点。",
  },
};

/** 默认激活的 TDSF agent id — v2026-07-29 改为 'main'，统一入口 */
export const DEFAULT_TDSF_AGENT: TdsfAgentId = "main";

/**
 * 类型守卫：判断字符串是否为合法的 TdsfAgentId
 *
 * 使用场景:
 *   - transport.ts 路由分支前收窄 getTdsfAgentId() 返回值类型
 *   - TdsfAgentPanel Tab 切换时校验传入的 id
 *
 * @param id 待校验的字符串
 * @returns 是 TdsfAgentId 则 true，否则 false
 */
export function isTdsfAgent(id: string): id is TdsfAgentId {
  return (
    id === "main" ||
    id === "coder" ||
    id === "explore" ||
    id === "history" ||
    id === "teach"
  );
}

// ============================================================================

export type SubagentType = "explore" | "code-review" | "security" | "general";

export type SubagentDef = {
  id: SubagentType;
  label: string;
  description: string;
  /**
   * Whitelist of tools the subagent may call. Excludes mutating tools and
   * `run_subagent` itself to prevent recursion. The runner filters down the
   * main toolset to this list before constructing the inner Agent.
   */
  tools: string[];
  systemPrompt: string;
};

const READ_ONLY_TOOLS = ["read_file", "list_directory", "grep", "glob"];

export const SUBAGENTS: Record<SubagentType, SubagentDef> = {
  explore: {
    id: "explore",
    label: "Explore",
    description:
      "Read-only codebase explorer. Locates files, traces references, summarizes architecture.",
    tools: READ_ONLY_TOOLS,
    systemPrompt: `You are an exploration subagent. Your job is to answer the spawn question by READING the codebase only — no edits, no commands. Use grep/glob/list_directory/read_file. Be terse. Return a concise summary suitable for the main agent to act on (file paths, key findings, line numbers). Stop as soon as you can answer.`,
  },
  "code-review": {
    id: "code-review",
    label: "Code review",
    description:
      "Reviews changed code for correctness, architecture, performance, security.",
    tools: READ_ONLY_TOOLS,
    systemPrompt: `You are a code-review subagent. Inspect the requested code and report only ACTIONABLE findings: correctness bugs, architecture violations, performance issues, security risks. Skip style/formatting. Format each finding as: "[MUST/SHOULD/NIT] file:line — issue → fix". If nothing is wrong, say "Looks good." Do NOT propose unrelated cleanups.`,
  },
  security: {
    id: "security",
    label: "Security review",
    description:
      "Audits code/configuration for security risks (auth, injection, secrets, etc).",
    tools: READ_ONLY_TOOLS,
    systemPrompt: `You are a security-review subagent. Scan the requested scope for: injection (SQL, shell, path), auth/authz bypass, secret leakage, missing validation at trust boundaries, unsafe deserialization, weak crypto. Report concrete findings with file:line and severity. Be conservative — false positives hurt more than missed nits. If nothing is wrong, say "No security issues found."`,
  },
  general: {
    id: "general",
    label: "General research",
    description:
      "General-purpose worker for multi-step research questions that span many files.",
    tools: READ_ONLY_TOOLS,
    systemPrompt: `You are a general-purpose research subagent. Answer the spawn question by reading the codebase. Don't speculate — verify. Return a tight summary with the evidence you used (paths, line numbers).`,
  },
};
