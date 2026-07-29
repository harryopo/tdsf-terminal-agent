// TDSF 魔改 (P4-T4.4): Skill 加载器
// -----------------------------------------------------------------------------
// 通过 IPC 调用 Python sidecar 的 `skill.list` 方法加载 skill 列表，
// 失败时降级到 registry.getBuiltinSkills() 返回硬编码的 5 个 builtin skill。
//
// 协议链路:
//   前端 invoke('ipc_invoke', {method:'skill.list', params:{}})
//     → Rust ipc_invoke (src-tauri/src/modules/ipc.rs)
//     → IPCClient.invoke → stdio JSON-RPC → Python MethodDispatcher
//     → skills.registry._skill_list → 返回 {skills: [...], total}
//     → 前端拿到 SkillListResponse，转成 SkillMetadata[]
//
// 降级场景:
//   - Python sidecar 未启动（Tauri 环境外运行测试）
//   - skill.list 方法未注册（旧版 sidecar）
//   - IPC 超时（5s 快速降级，避免 UI 长时间显示"正在加载 Skill 列表"）
//   - 任意异常
//   以上场景均返回 getBuiltinSkills()，不抛错，让 UI 继续展示。

import { invoke } from "@tauri-apps/api/core";
import { dictToMetadata, getBuiltinSkills } from "./registry";
import type { SkillListResponse, SkillMetadata } from "./types";

/**
 * Skill 列表加载超时（5s）
 *
 * 设计原因:
 *   - 旧版 30s 超时导致 UI 长时间停在"正在加载 Skill 列表..."，体验差
 *   - 5s 足够 Python sidecar 完成首次响应（实测冷启动 < 2s）
 *   - 超时后快速降级到 builtin 列表，让 UI 立即可用
 *   - 用户可点击"刷新"按钮重试
 */
const SKILL_LIST_TIMEOUT_MS = 5_000;

/**
 * 加载所有已注册的 Skill
 *
 * 调用 Python `skill.list` 获取完整列表（含 builtin + mock + 用户自定义），
 * 5s 内未响应或失败时降级到硬编码的 5 个 builtin skill。
 *
 * @returns SkillMetadata 数组（按 name 排序）
 */
export async function loadSkills(): Promise<SkillMetadata[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            new Error(`Skill 列表加载超时（${SKILL_LIST_TIMEOUT_MS / 1000}s）`),
          ),
        SKILL_LIST_TIMEOUT_MS,
      );
    });

    const resp = await Promise.race([
      invoke<SkillListResponse>("ipc_invoke", {
        method: "skill.list",
        params: {},
      }),
      timeout,
    ]);

    if (!resp || !Array.isArray(resp.skills)) {
      // 响应结构异常，降级
      return getBuiltinSkills();
    }
    const skills = resp.skills.map(dictToMetadata);
    // 按 name 排序，与 Python 端 list() 行为一致
    skills.sort((a, b) => a.name.localeCompare(b.name));
    return skills;
  } catch {
    // IPC 失败（sidecar 未启动 / 方法不存在 / 超时），降级到 builtin
    return getBuiltinSkills();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 加载单个 builtin skill 元数据（同步，仅 builtin）
 *
 * 用于 SkillInvoker 在用户调用前快速预览，不依赖 IPC。
 *
 * @param name Skill 名称
 * @returns 元数据；不存在返回 undefined
 */
export function getBuiltinSync(name: string): SkillMetadata | undefined {
  return getBuiltinSkills().find((s) => s.name === name);
}
