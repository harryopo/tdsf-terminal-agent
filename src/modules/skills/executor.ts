// TDSF (P4-T4.4): Skill 结果适配器
// -----------------------------------------------------------------------------
// 通过 IPC 调用 Python sidecar 的 `skill.invoke`，把返回结构解码成前端合同：
//
// TEAM-FIX-01 合同（第二阶段）:
//   1. execution === "not_run" 优先：即使混有 executor/success/output 字段，
//      也只按参考资料返回，不宣称执行。
//   2. 只有确证为执行结果（success 布尔 + exit_code/stdout/stderr/output 形状）
//      才进入 executed 分支；旧 executed 成功/失败继续按真实语义展示。
//   3. 有参考字段（content/body/when_to_use/whenToUse/steps/examples）→ reference；
//      空资料也是 reference，但不伪装成命令成功。
//   4. 空对象、数组、字符串等无法识别的结构 → unknown；未知不得落到成功兜底。
//   5. IPC 失败、ok=false、超时 → failed。
//
// 字段兼容：when_to_use/whenToUse、allowed_tools/allowedTools、
// exit_code/exitCode、duration_ms/durationMs 在读取时归一，不新增后端协议。
//
// 协议链路:
//   前端 invoke('ipc_invoke', {method:'skill.invoke', params:{name, params}})
//     → Rust ipc_invoke → Python MethodDispatcher
//     → skills.registry._skill_invoke(name, params)
//     → SkillRegistry.get_reference(name, params)   # 当前入口只读参考
//     → {ok: true, result: {... execution: "not_run"...}}

import { invoke } from "@tauri-apps/api/core";
import type {
  SkillExecution,
  SkillExecutor,
  SkillInvokeExecutedResult,
  SkillInvokeKnowledgeResult,
  SkillInvokeResponse,
} from "./types";

/** IPC 调用超时（与 sidecar-adapter 保持一致） */
const SKILL_INVOKE_TIMEOUT_MS = 30_000;

type RawRecord = Record<string, unknown>;

function asRecord(value: unknown): RawRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as RawRecord;
}

function hasKey(record: RawRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

/** 读取字符串字段（按顺序取第一个非空匹配，兼容 snake/camel） */
function readString(record: RawRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

/** 读取数字字段（兼容 snake/camel） */
function readNumber(record: RawRecord, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function toStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((item): item is string => typeof item === "string");
}

function toPlaybook(
  value: unknown,
): Array<Record<string, string>> | undefined {
  if (!Array.isArray(value)) return undefined;
  const steps: Array<Record<string, string>> = [];
  for (const item of value) {
    const record = asRecord(item);
    if (!record) continue;
    const step: Record<string, string> = {};
    for (const [key, raw] of Object.entries(record)) {
      step[key] = String(raw);
    }
    steps.push(step);
  }
  return steps.length > 0 ? steps : undefined;
}

/** 归一 executor 元数据；不合法的形状返回 null，不伪造命令 */
function toExecutor(value: unknown): SkillExecutor | null {
  const record = asRecord(value);
  if (!record) return null;
  const type = record.type;
  if (type === "shell" && typeof record.command === "string") {
    return {
      type: "shell",
      command: record.command,
      args: toStringArray(record.args),
      timeout: readNumber(record, "timeout") ?? 0,
      description: readString(record, "description"),
    };
  }
  if (type === "python" && typeof record.script === "string") {
    return {
      type: "python",
      script: record.script,
      timeout: readNumber(record, "timeout") ?? 0,
      description: readString(record, "description"),
    };
  }
  if (
    type === "http" &&
    typeof record.method === "string" &&
    typeof record.url === "string"
  ) {
    return {
      type: "http",
      method: record.method,
      url: record.url,
      headers: asRecord(record.headers) as Record<string, string> | undefined,
      timeout: readNumber(record, "timeout") ?? 0,
      description: readString(record, "description"),
    };
  }
  return null;
}

function failed(output: string, durationMs: number): SkillExecution {
  return { success: false, output, durationMs, mode: "failed" };
}

function unknown(output: string, durationMs: number): SkillExecution {
  return { success: false, output, durationMs, mode: "unknown" };
}

/** 参考资料分支：not_run 与普通知识卡共用 */
function referenceExecution(
  fallbackName: string,
  raw: RawRecord,
  durationMs: number,
): SkillExecution {
  const content = (readString(raw, "content", "body") ?? "").trim();
  const whenToUse = (
    readString(raw, "whenToUse", "when_to_use") ?? ""
  ).trim();
  const output = content || whenToUse;

  const knowledge: SkillInvokeKnowledgeResult = {
    name: readString(raw, "name") ?? fallbackName,
    content,
    whenToUse,
    steps: readString(raw, "steps"),
    examples: readString(raw, "examples"),
    params: asRecord(raw.params) ?? {},
    source: readString(raw, "source") ?? "unknown",
    execution: "not_run",
    description: readString(raw, "description"),
    tags: toStringArray(raw.tags),
    triggers: toStringArray(raw.triggers),
    allowed_tools: toStringArray(raw.allowed_tools ?? raw.allowedTools),
    playbook: toPlaybook(raw.playbook),
    executor: toExecutor(raw.executor),
    note: readString(raw, "note"),
  };

  return {
    success: true,
    output,
    durationMs,
    mode: "reference",
    empty: output.length === 0,
    result: knowledge,
  };
}

/** 执行结果分支：只对已确证为执行形状的旧结果使用 */
function executedExecution(
  fallbackName: string,
  raw: RawRecord,
  durationMs: number,
): SkillExecution {
  const name = readString(raw, "name") ?? fallbackName;
  const executor = toExecutor(raw.executor);
  const stdout = readString(raw, "stdout") ?? "";
  const stderr = readString(raw, "stderr") ?? "";
  const outputOnly = readString(raw, "output") ?? "";
  const combined = [stdout, stderr].filter(Boolean).join("\n");
  const exitCode = readNumber(raw, "exit_code", "exitCode");
  const execDuration = readNumber(raw, "duration_ms", "durationMs");

  const parts: string[] = [];
  if (executor?.type === "shell") {
    parts.push(`# ${name} (shell executor)`);
    parts.push(`$ ${executor.command}`);
  } else if (executor?.type === "python") {
    parts.push(`# ${name} (python executor)`);
    parts.push("$ python <script>");
  } else if (executor?.type === "http") {
    parts.push(`# ${name} (http executor)`);
    parts.push(`$ ${executor.method} ${executor.url}`);
  } else {
    parts.push(`# ${name} (executor 结果)`);
  }
  parts.push(
    `# 退出码: ${exitCode ?? "未提供"} | 耗时: ${execDuration ?? durationMs}ms`,
  );
  parts.push("");
  if (stdout) {
    parts.push("## stdout");
    parts.push(stdout.trimEnd());
  }
  if (stderr) {
    parts.push("## stderr");
    parts.push(stderr.trimEnd());
  }
  // 旧 executed-result 可能只有 output 字段：没有 stdout/stderr 时展示真实 output，
  // 不能显示“无输出”；有分流输出时不再重复展示 output。
  const showOutputOnly = !stdout && !stderr && outputOnly.trim().length > 0;
  if (showOutputOnly) {
    parts.push("## output");
    parts.push(outputOnly.trimEnd());
  }
  if (!stdout && !stderr && !showOutputOnly) {
    parts.push("(无输出)");
  }
  const error = readString(raw, "error");
  if (error) {
    parts.push("");
    parts.push("## 执行器异常");
    parts.push(error);
  }

  const success = raw.success === true;
  const executed: SkillInvokeExecutedResult = {
    name,
    executor,
    success,
    exit_code: exitCode,
    output: outputOnly || combined,
    stdout,
    stderr,
    duration_ms: execDuration,
    params: asRecord(raw.params) ?? {},
    source: readString(raw, "source") ?? "unknown",
    error,
  };

  return {
    success,
    output: parts.join("\n"),
    durationMs,
    mode: "executed",
    result: executed,
  };
}

/**
 * 读取 Skill 参考资料（或兼容既有执行结果）
 *
 * @param name Skill 名称（大小写不敏感，Python 端处理）
 * @param args 调用参数（字符串，会作为 params.input 传给 Python）
 */
export async function invokeSkill(
  name: string,
  args: string,
): Promise<SkillExecution> {
  const start = Date.now();
  const params = { input: args };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`Skill 调用超时（${SKILL_INVOKE_TIMEOUT_MS / 1000}s）`),
          ),
        SKILL_INVOKE_TIMEOUT_MS,
      );
    });

    const resp = await Promise.race([
      invoke<SkillInvokeResponse>("ipc_invoke", {
        method: "skill.invoke",
        params: { name, params },
      }),
      timeout,
    ]);

    const durationMs = Date.now() - start;

    if (!resp) {
      return failed("Sidecar 返回空响应（未执行命令）", durationMs);
    }

    if (!resp.ok) {
      return failed(resp.error ?? "Skill 调用失败（未知错误）", durationMs);
    }

    const raw = asRecord(resp.result);
    if (!raw) {
      return unknown(
        "Sidecar 返回的技能结果格式无法识别（未执行命令）",
        durationMs,
      );
    }

    // 1) not_run 优先：executor/success/output 混合字段也不能推翻它
    if (raw.execution === "not_run") {
      return referenceExecution(name, raw, durationMs);
    }

    // 2) 确证执行形状：success 布尔 + 执行结果字段（兼容旧 executed-result）
    const hasSuccessBool = typeof raw.success === "boolean";
    const hasExecutedShape =
      hasSuccessBool &&
      (hasKey(raw, "exit_code") ||
        hasKey(raw, "stdout") ||
        hasKey(raw, "stderr") ||
        hasKey(raw, "output") ||
        hasKey(raw, "duration_ms"));
    if (hasExecutedShape) {
      return executedExecution(name, raw, durationMs);
    }

    // 3) 参考形状（snake/camel 都可）
    // 参考字段必须是字符串：{content:{...}} 这类格式错误不能被当作成功参考
    const hasStringField = (...keys: string[]) =>
      keys.some((key) => typeof raw[key] === "string");
    const hasReferenceShape = hasStringField(
      "content",
      "body",
      "when_to_use",
      "whenToUse",
      "steps",
      "examples",
    );
    if (hasReferenceShape) {
      return referenceExecution(name, raw, durationMs);
    }

    // 4) 其余一律无法识别，不落到成功参考兜底
    return unknown(
      "Sidecar 返回的技能结果无法识别（未执行命令）",
      durationMs,
    );
  } catch (err) {
    const durationMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    return failed(`Skill ${name} 读取失败: ${msg}`, durationMs);
  } finally {
    if (timer) clearTimeout(timer);
  }
}