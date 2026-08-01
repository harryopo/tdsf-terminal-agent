// ============================================================================
// TDSF Agent 注册表（前端 5 个用户可切换的 Agent）
// ============================================================================
//
// P0-1 (2026-08-01, 方案书 B 方案): 前后端对齐 — 每个前端入口对应一个
// **真实** Strands Agent 实例（strands_backend/adapter.py _SUB_AGENT_SPECS）：
//   前端 id   ↔ 后端 agent key（pythonName）↔ Strands Agent 实例
//   main    ↔ main     （全量 7 工具，通用入口）
//   coder   ↔ coding   （ssh_command + read_remote_file + suggest_command）
//   explore ↔ explore  （只读 5 工具，无 ssh_command）
//   history ↔ history  （suggest_command + skill_invoke）
//   teach   ↔ teach    （只读 + skill_invoke，结构化教学输出）
// 旧版"main 在 Python 端按关键词路由到 8 个子 Agent"的模拟已移除：
// 用户选哪个 Tab，后端就跑哪个真实 Agent；AgentStatusPill 显示与之一致。
//
// 设计原则:
//   - 前端 id 用业务语义命名（coder），与 Python key（coding 动词形式）解耦
//   - pythonName 字段作为 RPC 调用时传入的 agent name（agent.invoke 的 params.name）
//   - 简短 systemPrompt 仅用于前端 Tab tooltip 展示，实际 prompt 由 Python 端构建
//
// 与现有 SUBAGENTS 的区别:
//   - SUBAGENTS 是 Vercel AI SDK 内部 subagent（run_subagent 工具的白名单），仅 fallback 路径用
//   - TDSF_AGENTS 是顶层 Agent 集合，走 Python Sidecar（Strands）路径
//   - 两者互不冲突，可并存

/** TDSF 顶层 Agent 的 id（前端 5 个可切换入口，每个对应后端一个真实 Strands Agent） */
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
 * P0-1：每个入口对应后端一个真实 Strands Agent（见 adapter.py _SUB_AGENT_SPECS）。
 */
export const TDSF_AGENTS: Record<TdsfAgentId, TdsfAgentDef> = {
  main: {
    id: "main",
    label: "Main",
    mode: "MAIN",
    desc: "通用主 Agent（全量 7 工具：SSH 执行/文件/日志/进程/网络/技能/命令建议）",
    pythonName: "main",
    systemPrompt:
      "Main Agent：通用 Linux 运维助手，可执行 SSH 命令、读写文件、分析日志、诊断网络。",
  },
  coder: {
    id: "coder",
    label: "Coder",
    mode: "CODE",
    desc: "代码与配置修改（SSH 执行 + 读文件 + 命令建议）",
    pythonName: "coding",
    systemPrompt:
      "Coding Agent：定位并修复远程主机上的代码/配置问题，高危命令触发审批。",
  },
  explore: {
    id: "explore",
    label: "Explore",
    mode: "SCAN",
    desc: "只读探索（文件/日志/进程/网络，不执行命令）",
    pythonName: "explore",
    systemPrompt:
      "Explore Agent：只读分析远程主机（读文件/日志/进程/网络诊断），不执行命令。",
  },
  history: {
    id: "history",
    label: "History",
    mode: "HIST",
    desc: "历史与知识（基于会话上下文复盘 + 领域知识卡）",
    pythonName: "history",
    systemPrompt:
      "History Agent：基于会话上下文回答历史操作/命令/排障模式，可查阅领域知识卡。",
  },
  teach: {
    id: "teach",
    label: "Teach",
    mode: "TEACH",
    desc: "Linux 运维教学（概念+示例+易错点+练习，不执行命令）",
    pythonName: "teach",
    systemPrompt:
      "Teach Agent：结构化教学（概念原理/操作示例/易错点/练习），只读 + 知识卡，不执行命令。",
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
