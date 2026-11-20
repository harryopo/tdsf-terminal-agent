// TEAM-FIX-01: 技能结果通知适配（侧栏对话框与 /skill 入口共用）
// -----------------------------------------------------------------------------
// 两个入口必须按同一份 SkillExecution.mode 展示：
//   - reference: 只加载参考资料，未执行命令
//   - executed:  既有 executor 结果，按真实成功/失败展示
//   - failed:    读取/调用失败
//   - unknown:   结果结构无法识别，不能落到成功兜底
import type { SkillExecution } from "./types";

export type SkillNoticeTone = "success" | "error" | "warning";

export interface SkillResultNotice {
  /** toast 级别 */
  tone: SkillNoticeTone;
  /** 状态标签短文案 */
  label: string;
  /** toast 标题 */
  title: string;
  /** toast 说明 */
  description: string;
}

/** 截断错误说明，避免把长输出塞进 toast */
function brief(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * 把结果语义翻译成统一的界面文案
 *
 * 注意：这里不推断执行主机；executed 只说明“返回的是执行结果”，
 * 不声称它来自当前 SSH 会话。
 */
export function describeSkillResult(
  skillName: string,
  result: SkillExecution,
): SkillResultNotice {
  if (result.mode === "executed") {
    return result.success
      ? {
          tone: "success",
          label: "执行结束",
          title: `Skill "${skillName}" 执行结束`,
          description: `真实执行结果 · 耗时 ${result.durationMs}ms`,
        }
      : {
          tone: "error",
          label: "执行失败",
          title: `Skill "${skillName}" 执行失败`,
          description: brief(result.output),
        };
  }

  if (result.mode === "unknown") {
    return {
      tone: "warning",
      label: "结果无法识别",
      title: `Skill "${skillName}" 结果无法识别`,
      description: "未执行命令，也未取得可展示的参考资料。",
    };
  }

  if (result.mode === "reference") {
    if (result.empty) {
      return {
        tone: "warning",
        label: "未提供参考资料",
        title: `Skill "${skillName}" 未提供参考资料`,
        description: "仅提供参考资料，未执行命令。",
      };
    }
    return {
      tone: "success",
      label: "参考资料已加载",
      title: `Skill "${skillName}" 参考资料已加载`,
      description: `仅提供参考资料，未执行命令 · 耗时 ${result.durationMs}ms`,
    };
  }

  return {
    tone: "error",
    label: "读取失败",
    title: `Skill "${skillName}" 参考资料读取失败`,
    description: brief(result.output),
  };
}
/**
 * 顶部上下文说明：按 mode 区分
 *
 * executed 结果不能同时显示“未执行命令”；失败/未知也不能据此推断远端状态。
 */
export function describeSkillContext(
  result?: SkillExecution | null,
): string {
  if (!result) return "仅提供参考资料，未执行命令。";
  if (result.mode === "executed") {
    return "返回既有执行结果，未提供执行主机信息。";
  }
  if (result.mode === "failed" || result.mode === "unknown") {
    return "未取得可展示的参考资料，不能据此推断执行结果。";
  }
  return "仅提供参考资料，未执行命令。";
}