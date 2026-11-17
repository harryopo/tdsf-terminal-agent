// TDSF (P4-T4.4): Skill 执行器
// -----------------------------------------------------------------------------
// 通过 IPC 调用 Python sidecar 的 `skill.invoke` 方法读取技能资料或执行 skill，
// 失败时返回 `{success: false, output: error}`，不抛错。
//
// 协议链路:
//   前端 invoke('ipc_invoke', {method:'skill.invoke', params:{name, params}})
//     → Rust ipc_invoke → Python MethodDispatcher
//     → skills.registry._skill_invoke(name, params)
//     → SkillRegistry.get_reference(name, params)
//     - 返回参考资料，`execution: "not_run"`；即使带 executor 元数据也不执行
//     → 前端包装层 {ok: true, result: {...}}
//
// TEAM-FIX-01 (2026-11-17): 当前入口只读参考，结果语义必须如实展示：
//   - reference: 参考资料已加载，未执行命令
//   - executed:  既有 executor 结果（兼容保留）
//   - failed:    读取/调用失败
//
// 错误处理:
//   - skill 不存在 → Python 返回 {ok: false, error: "skill not found: ..."}
//   - IPC 失败 → catch 后返回 {success: false, output: ...}
//   - 调用超时（30s）→ catch 后返回 {success: false, output: "调用超时"}

import { invoke } from "@tauri-apps/api/core";
import type {
  SkillExecution,
  SkillInvokeExecutedResult,
  SkillInvokeKnowledgeResult,
  SkillInvokeResponse,
} from "./types";

/** IPC 调用超时（与 sidecar-adapter 保持一致） */
const SKILL_INVOKE_TIMEOUT_MS = 30_000;

/**
 * 读取 Skill 参考资料（或兼容既有执行结果）
 *
 * @param name Skill 名称（大小写不敏感，Python 端处理）
 * @param args 调用参数（字符串，会作为 params.input 传给 Python）
 * @returns SkillExecution（含 success / output / durationMs / mode / result）
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
      return {
        success: false,
        output: "Sidecar 返回空响应",
        durationMs,
        mode: "failed",
      };
    }

    if (!resp.ok) {
      return {
        success: false,
        output: resp.error ?? "Skill 调用失败（未知错误）",
        durationMs,
        mode: "failed",
      };
    }

    // TDSF 2026-07-28 (Outsider Review P0-1): 区分 executor 执行结果 vs 知识卡
    // 之前实现只看 result.content / whenToUse, 导致有 executor 的 skill 在前端
    // 全部显示"执行完成（无输出内容）"——后端真跑通, 前端丢数据.
    // 修复: 通过 result.success / exit_code / output 字段判断是否 executor 执行.
    //   - executor 模式:  result.success === boolean, 含 output/stdout/stderr
    //   - 知识卡模式:    result.content 是 SKILL.md body, 无 success 字段
    const result = resp.result as
      | SkillInvokeExecutedResult
      | SkillInvokeKnowledgeResult
      | undefined;
    if (!result) {
      return {
        success: false,
        output: "Sidecar 返回 ok=true 但缺少 result 字段",
        durationMs,
        mode: "failed",
      };
    }

    // 分支 1: executor 模式 (有 output 字段 + 布尔 success) → 真正执行结果
    // TEAM-FIX-01：只有该分支才允许叫“执行结果”，其余一律按参考资料展示。
    if (
      "output" in result &&
      typeof (result as SkillInvokeExecutedResult).success === "boolean"
    ) {
      const execResult = result as SkillInvokeExecutedResult;
      const outputParts: string[] = [];
      // 标题: executor 类型 + 命令/脚本
      // 注意 SkillExecutor 是判别联合 (type: shell/python/http),
      // 需要在分支中显式收窄类型后才能访问对应字段.
      const execType = execResult.executor?.type ?? "unknown";
      let execDesc = "";
      if (
        execType === "shell" &&
        execResult.executor &&
        "command" in execResult.executor
      ) {
        execDesc = `$ ${execResult.executor.command}`;
      } else if (execType === "python") {
        execDesc = "$ python <script>";
      } else if (
        execType === "http" &&
        execResult.executor &&
        "method" in execResult.executor &&
        "url" in execResult.executor
      ) {
        execDesc = `$ ${execResult.executor.method} ${execResult.executor.url}`;
      }
      outputParts.push(`# ${execResult.name} (${execType} executor)`);
      if (execDesc) outputParts.push(execDesc);
      outputParts.push(
        `# 退出码: ${execResult.exit_code} | 耗时: ${execResult.duration_ms}ms`,
      );
      outputParts.push("");
      // 真实输出 (stdout + stderr)
      if (execResult.stdout) {
        outputParts.push("## stdout");
        outputParts.push(execResult.stdout.trimEnd());
      }
      if (execResult.stderr) {
        outputParts.push("## stderr");
        outputParts.push(execResult.stderr.trimEnd());
      }
      if (!execResult.stdout && !execResult.stderr) {
        outputParts.push("(无输出)");
      }
      if (execResult.error) {
        outputParts.push("");
        outputParts.push(`## 执行器异常`);
        outputParts.push(execResult.error);
      }
      return {
        success: execResult.success,
        output: outputParts.join("\n"),
        durationMs,
        mode: "executed",
        result: execResult as never, // 前端 SkillExecution.result 仍用宽类型兼容
      };
    }

    // 分支 2: 参考模式（TEAM-FIX-01）
    // 当前 skill.invoke → get_reference 只返回参考资料，execution="not_run"。
    // 即使结果带 executor 元数据，也只表示目标环境的步骤声明，不代表执行；
    // 文案不得写“执行完成”，空资料也不得伪装成成功输出。
    const knowledgeResult = result as SkillInvokeKnowledgeResult;
    const content = knowledgeResult.content?.trim() ?? "";
    const whenToUse = knowledgeResult.whenToUse?.trim() ?? "";
    const output = content || whenToUse;

    return {
      success: true,
      output,
      durationMs,
      mode: "reference",
      result: knowledgeResult as never,
    };
  } catch (err) {
    const durationMs = Date.now() - start;
    const msg = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      output: `Skill ${name} 读取失败: ${msg}`,
      durationMs,
      mode: "failed",
    };
  } finally {
    // 无论成功失败都清理 timer，避免内存泄漏
    if (timer) clearTimeout(timer);
  }
}