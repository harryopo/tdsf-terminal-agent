// TDSF 魔改 (P4-T4.4): Skill 系统类型定义
// -----------------------------------------------------------------------------
// 与 Python sidecar `skills/registry.py` 的 SkillDict 字段对齐，
// 并补充前端专属字段（category / source / enabled）。
//
// Python `skill.list` 返回的 SkillDict 字段:
//   name / description / version / author / tags / when_to_use /
//   steps / examples / body / file_path
//
// Python `skill.invoke` 返回的 result 字段（builtin）:
//   name / content / when_to_use / steps / examples / params / source

/** Skill 分类（用于面板筛选 tab） */
export type SkillCategory = "linux" | "docker" | "ssh" | "python" | "custom";

/** Skill 来源 */
export type SkillSource = "builtin" | "installed" | "user";

/**
 * 前端 Skill 元数据
 *
 * 由 `loader.ts` 从 Python `skill.list` 返回的 SkillDict 转换而来，
 * 字段命名采用 camelCase（与 clone 项目风格一致），转换逻辑见 loader。
 */
export interface SkillMetadata {
  /** Skill 唯一标识（如 "linux-ops"） */
  name: string;
  /** 一句话描述 */
  description: string;
  /** 分类（由 tags 推断，用于面板筛选） */
  category: SkillCategory;
  /** 触发条件（"When to use" 章节内容） */
  whenToUse: string;
  /** 使用示例（"Examples" 章节内容，按行拆分） */
  examples: string[];
  /** 来源（builtin=内置 / installed=市场安装 / user=用户自定义） */
  source: SkillSource;
  /** 是否启用（前端本地状态，控制 /skill: 调用是否允许） */
  enabled: boolean;
  /** 版本号（可选，仅展示用） */
  version?: string;
  /** 作者（可选，仅展示用） */
  author?: string;
  /** tags 原始列表（可选，仅展示用） */
  tags?: string[];
  // TDSF 魔改: SKILL.md 原文内容，供 SkillContentDialog 渲染预览
  // 来源：Python skill.list 返回的 body 字段；降级模式（IPC 不可用）下可能为空。
  rawContent?: string;
  // TDSF 魔改: SKILL.md 在磁盘上的绝对路径，供"打开目录"按钮调用 revealItemInDir
  // 来源：Python skill.list 返回的 file_path 字段；builtin 降级列表无此字段。
  filePath?: string | null;
}

/**
 * Python `skill.invoke` 返回的 result 结构（builtin skill）
 *
 * 注意 Python 端包装了一层 `{ok, result, error}`，executor.ts 会先解包 ok，
 * 这里是 result 内部的字段。
 */
export interface SkillInvokeResult {
  /** Skill 名称 */
  name: string;
  /** 完整 Markdown body（skill 的主体内容） */
  content: string;
  /** 触发条件 */
  whenToUse: string;
  /** 执行步骤 */
  steps: string;
  /** 使用示例（原始字符串） */
  examples: string;
  /** 调用参数（透传） */
  params: Record<string, unknown>;
  /** 来源标识（"builtin" / "mock"） */
  source: string;
}

/**
 * `invokeSkill` 的执行结果（前端最终拿到的结构）
 *
 * 包含调用耗时和成功/失败标志，便于 UI 展示。
 */
export interface SkillExecution {
  /** 是否成功 */
  success: boolean;
  /** 输出内容（成功时为 skill content，失败时为错误信息） */
  output: string;
  /** 调用耗时（毫秒） */
  durationMs: number;
  /** 完整结果（成功时存在） */
  result?: SkillInvokeResult;
}

/**
 * 单次调用历史记录（用于 store 持久化调用记录）
 */
export interface SkillHistoryEntry {
  /** 调用时间戳（Unix 毫秒） */
  timestamp: number;
  /** Skill 名称 */
  skillName: string;
  /** 调用参数（原始字符串） */
  args: string;
  /** 是否成功 */
  success: boolean;
  /** 耗时（毫秒） */
  durationMs: number;
  /** 输出片段（截断前 200 字符，便于列表展示） */
  outputPreview: string;
}

/** Python `skill.list` 返回的顶层结构 */
export interface SkillListResponse {
  skills: SkillDict[];
  total: number;
}

/** Python `skill.invoke` 返回的顶层结构（含 ok 包装） */
export interface SkillInvokeResponse {
  ok: boolean;
  result?: SkillInvokeResult;
  error?: string;
}

/**
 * Python `skill.list` 返回的原始 SkillDict（snake_case）
 *
 * 与 `skills/parser.py` 的 `Skill.to_dict()` 对齐。
 * loader.ts 会将其转换为前端 `SkillMetadata`。
 */
export interface SkillDict {
  name: string;
  description: string;
  version: string;
  author: string;
  tags: string[];
  when_to_use: string;
  steps: string;
  examples: string;
  body: string;
  file_path: string | null;
  // TDSF 魔改 (P0-2 修复 2026-07-28): executor 字段, 标识该 skill 是否可真正执行
  // 来自 SKILL.md frontmatter, 支持 shell/python/http 三种 type
  executor?: SkillExecutor | null;
}

/**
 * Skill 可执行体描述 (TDSF 魔改 P0-2 修复 2026-07-28)
 *
 * 来自 SKILL.md frontmatter 的 executor 块, 标识该 skill 是否真的能跑命令.
 *  - shell:  在用户 shell 中跑 command
 *  - python: 在 python 子进程中跑 script
 *  - http:   用 urllib 跑 HTTP 请求
 */
export type SkillExecutor =
  | {
      type: "shell";
      command: string;
      args?: string[];
      timeout: number;
      description?: string;
    }
  | {
      type: "python";
      script: string;
      timeout: number;
      description?: string;
    }
  | {
      type: "http";
      method: string;
      url: string;
      headers?: Record<string, string>;
      timeout: number;
      description?: string;
    };

/**
 * Python `skill.invoke` 的真实执行结果 (TDSF 魔改 P0-2 修复 2026-07-28)
 *
 * 含 executor 的 skill 被调用时返回这种结构, 包含真正执行 stdout/stderr/exit_code
 */
export interface SkillInvokeExecutedResult {
  /** Skill 名称 */
  name: string;
  /** 执行器描述 */
  executor: SkillExecutor;
  /** 是否成功 (exit_code == 0) */
  success: boolean;
  /** 进程退出码 */
  exit_code: number;
  /** 组合后的输出 (stdout + [stderr]) */
  output: string;
  /** 标准输出 */
  stdout: string;
  /** 标准错误 */
  stderr: string;
  /** 耗时毫秒 */
  duration_ms: number;
  /** 调用参数 (透传) */
  params: Record<string, unknown>;
  /** 来源 builtin/mock */
  source: string;
  /** 执行器异常时存在 */
  error?: string;
}

/**
 * Python `skill.invoke` 返回的 result 结构 (无 executor 的 builtin skill)
 *
 * 与 SkillInvokeExecutedResult 不同, 知识卡只回显 SKILL.md 内容.
 */
export interface SkillInvokeKnowledgeResult {
  /** Skill 名称 */
  name: string;
  /** 完整 Markdown body (skill 的主体内容) */
  content: string;
  /** 触发条件 */
  whenToUse: string;
  /** 执行步骤 */
  steps: string;
  /** 使用示例 (原始字符串) */
  examples: string;
  /** 调用参数 (透传) */
  params: Record<string, unknown>;
  /** 来源标识 (builtin / mock) */
  source: string;
}
