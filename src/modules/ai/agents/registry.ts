// ============================================================================
// TDSF Agent 注册表（v3.1 收敛：main 唯一入口 + 三模式信任体系）
// ============================================================================
//
// 方案书 v3.1（docs/agent/方案书-v3.1-三模式信任体系与Agent收敛.md §4.1）：
// 原 main + 4 静态子 agent（coder/explore/history/teach）委派机制已整体删除——
// 意图路由靠 LLM 猜不可控、三个子 agent 工具集是 main 的真子集（委派纯开销）。
// 现在前端只有 main 一个入口，"能力差异"改由 AgentMode 三模式信任体系 +
// Teach 教学皮肤表达（随 agent.invoke 的 state.live.agentMode / state.live.teach
// 下发 sidecar，缺省时 sidecar 按 confirm 执行）。
//
// 与 SUBAGENTS 的区别（保留不变）:
//   - SUBAGENTS 是 Vercel AI SDK 内部 subagent（run_subagent 工具的白名单），
//     仅 fallback 路径用
//   - TDSF_AGENTS 是顶层 Agent 集合，走 Python Sidecar（Strands）路径
//   - 两者互不冲突，可并存

/** TDSF 顶层 Agent id（v3.1 收敛后仅 main 一个入口） */
export type TdsfAgentId = "main";

/**
 * Agent 三模式信任档位（方案书 v3.1 §3.2 模式 × 权限映射矩阵）
 *
 * - observe：观察——只读分析，任何写/执行类操作 fail-closed 拒绝并如实报告
 * - confirm：确认——只读/L0-L1 放行，L2-L4 逐条审批卡（最安全中间态）
 * - auto：自动——L0-L2 自动放行，L3/L4 仍升级确认（L4 任何模式/白名单不可绕）
 *
 * 模式为会话级状态（chatStore.agentMode，per-session 持久化），随
 * agent.invoke 的 state.live.agentMode 下发 sidecar；缺省缺字段时
 * sidecar 按 confirm 执行（spec: 老会话兼容）。
 */
export type AgentMode = "observe" | "confirm" | "auto" | "teach";

/** 默认模式：confirm（中间态最安全，对齐 spec"缺省缺字段时默认 confirm"） */
export const DEFAULT_AGENT_MODE: AgentMode = "confirm";

/** 四档模式常量列表（AgentModeSwitcher 渲染顺序；teach 为第四档，用户钦定 2026-08-29） */
export const AGENT_MODES: readonly AgentMode[] = [
  "observe",
  "confirm",
  "auto",
  "teach",
];

/** 模式元数据（切换器 + AgentStatusPill + TdsfAgentPanel 显示用） */
export const AGENT_MODE_META: Record<
  AgentMode,
  { label: string; badge: string; desc: string; brief: string }
> = {
  observe: {
    label: "观察",
    badge: "观察 · 只读",
    desc: "只读分析，不执行任何写操作",
    brief: "只读分析",
  },
  confirm: {
    label: "确认",
    badge: "确认 · 审批",
    desc: "写操作逐条审批后执行",
    brief: "操作前确认",
  },
  auto: {
    label: "自动",
    badge: "自动 · 执行",
    desc: "低危自动放行，高危仍需确认",
    brief: "自由执行",
  },
  teach: {
    label: "教学",
    badge: "教学 · 讲解",
    desc: "只读 + 结构化教学输出（概念/示例/易错点/练习），适合跟学，不改系统",
    brief: "讲解跟学",
  },
};

/**
 * 四档模式强调色（用户钦定 2026-09-01：观察=黄 / 确认=绿 / 自动=红 / 教学=紫）。
 * 单一真源——AgentModeSwitcher 卡片、AgentStatusPill 徽章等统一消费，
 * 保证同一模式在任何 UI 处颜色一致。
 */
export const AGENT_MODE_ACCENT: Record<
  AgentMode,
  { text: string; softBg: string }
> = {
  observe: {
    text: "text-amber-500 dark:text-amber-400",
    softBg: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  },
  confirm: {
    text: "text-emerald-500 dark:text-emerald-400",
    softBg: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  },
  auto: {
    text: "text-red-500 dark:text-red-400",
    softBg: "bg-red-500/10 text-red-600 dark:text-red-400",
  },
  teach: {
    text: "text-violet-500 dark:text-violet-400",
    softBg: "bg-violet-500/10 text-violet-600 dark:text-violet-400",
  },
};

/** 类型守卫：字符串是否为合法 AgentMode（会话元数据反序列化用） */
export function isAgentMode(v: string): v is AgentMode {
  return v === "observe" || v === "confirm" || v === "auto" || v === "teach";
}

/**
 * 四档模式 → sidecar 传参映射。
 *
 * sidecar 的权限矩阵只认三模式（observe/confirm/auto）+ teach 布尔
 * （adapter.py 读 state.live.agentMode / state.live.teach）；前端第四档
 * "教学" = 只读 + 教学 prompt 的预置组合，下发时展开为 observe + teach=true。
 */
export function toSidecarMode(mode: AgentMode): {
  agentMode: "observe" | "confirm" | "auto";
  teach: boolean;
} {
  if (mode === "teach") return { agentMode: "observe", teach: true };
  return { agentMode: mode, teach: false };
}

/** TDSF Agent 定义（前端展示 + Python RPC 调用所需元数据；v3.1 后仅 main） */
export type TdsfAgentDef = {
  /** 前端 id */
  id: TdsfAgentId;
  /** 显示名 */
  label: string;
  /** 短模式标签（Header 徽章用） */
  mode: string;
  /** 一句话描述（空状态展示用） */
  desc: string;
  /** 对应 Python AGENT_REGISTRY 的 key（agent.invoke 的 params.name） */
  pythonName: "main";
  /** 简短 system prompt（仅前端展示用，实际 prompt 由 Python 端按模式构建） */
  systemPrompt: string;
};

/**
 * TDSF 顶层 Agent 注册表（v3.1 收敛后仅 main）
 *
 * 用 Record<TdsfAgentId, TdsfAgentDef> 保证 id 字段与 key 严格一一对应。
 */
export const TDSF_AGENTS: Record<TdsfAgentId, TdsfAgentDef> = {
  main: {
    id: "main",
    label: "Main",
    mode: "MAIN",
    desc: "通用主 Agent（全量工具 × 模式过滤，模式感知 prompt + 可选教学皮肤）",
    pythonName: "main",
    systemPrompt:
      "Main Agent：通用 Linux 运维助手，可执行 SSH 命令、读写文件、分析日志、诊断网络。",
  },
};

/** 默认激活的 TDSF agent id — v3.1 收敛后恒为 'main'（唯一入口） */
export const DEFAULT_TDSF_AGENT: TdsfAgentId = "main";

/**
 * 类型守卫：判断字符串是否为合法的 TdsfAgentId
 *
 * 使用场景:
 *   - transport.ts 路由分支前收窄 getTdsfAgentId() 返回值类型
 *
 * @param id 待校验的字符串
 * @returns 是 TdsfAgentId 则 true，否则 false
 */
export function isTdsfAgent(id: string): id is TdsfAgentId {
  return id === "main";
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
