// TDSF 魔改 (P4-T4.3): Teach Agent OSC7 教学触发 + 教学 MD 生成
// =============================================================================
//
// 监听 shell 命令执行（通过 OSC 7 cwd 通知），降频调用 teach agent
// 推送一句简短讲解（≤80 字符），以非阻塞 toast 显示，并追加到教学历史 MD。
//
// 触发链路:
//   1. 用户在终端输入命令 → useTerminalSession.submitToLeaf(text)
//   2. submitToLeaf 调用 recordSubmittedCommand(text) 记录命令文本
//   3. shell 执行完毕后发出 OSC 7（precmd 钩子，每条命令都会发）
//   4. osc-handlers.registerOsc7TeachTrigger 解析 cwd → notifyCommandExecuted(cmd, cwd)
//   5. notifyCommandExecuted 降频检查（默认每 3 条触发一次）
//   6. 命中阈值 → runSidecarStream({agentId:"teach", input:"explain: <cmd>"})
//   7. 流式响应 → toast.info() 非阻塞显示 + appendToTeachHistory 写 MD
//
// 设计原则:
//   - 非阻塞：toast duration 5000ms，不抢焦点；sidecar 调用失败静默吞掉
//   - 降频：默认每 3 条命令触发，用户可在设置中改 1/2/3/5
//   - 隔离：不改 ai/agents/registry、不改 sidecar-adapter 实现、不切换 chatStore agent
//   - 持久化：教学历史追加到 ~/.tdsf/teach/teach-history.md（先读后写模拟追加）

import { runSidecarStream } from "@/modules/ai/lib/sidecar-adapter";
import { usePreferencesStore } from "@/modules/settings/preferences";
import { invoke } from "@tauri-apps/api/core";
import { homeDir, join } from "@tauri-apps/api/path";
import { toast } from "sonner";

// === 常量 ====================================================================

/** 默认降频阈值：每 3 条命令触发一次讲解 */
const DEFAULT_TEACH_THRESHOLD = 3;

/** 合法的降频阈值选项（用户可在设置中选） */
const VALID_THRESHOLDS = new Set([1, 2, 3, 5]);

/** Sidecar 调用超时（15s，比 sidecar 默认 30s 短，避免教学阻塞主流程） */
const TEACH_SIDECAR_TIMEOUT_MS = 15_000;

/** Toast 显示时长（ms） */
const TEACH_TOAST_DURATION_MS = 5_000;

/** 教学 MD 文件相对路径（home 下） */
const TEACH_HISTORY_REL_PATH = ["tdsf", "teach", "teach-history.md"];

/** 教学 MD 文件头部（首次创建时写入） */
const TEACH_HISTORY_HEADER = "# TDSF 教学历史\n\n";

// === 模块级状态 ==============================================================

/**
 * 命令计数器（模块级，所有终端会话共享）
 *
 * 降频逻辑：每 N 条命令触发一次（N 由 teachThreshold 偏好决定，默认 3）。
 * 计数器在以下情况重置：
 *   - 用户在设置中点"清空历史"按钮 → resetTeachCounter()
 *   - 用户切换降频阈值（避免旧计数错位）
 */
let commandCount = 0;

/**
 * 最近一次提交到 PTY 的命令文本
 *
 * OSC 7 不携带命令文本，只携带 cwd。所以需要在 submitToLeaf 时
 * 通过 recordSubmittedCommand(text) 预先记录，OSC 7 触发时读取。
 *
 * 已知限制：若用户快速连续提交多条命令，OSC 7 触发时读到的是最后一条。
 * 对于教学场景（降频 1/3）可接受。
 */
let lastSubmittedCommand = "";

// === 内部工具函数 ============================================================

/**
 * 获取当前降频阈值
 *
 * 优先读 preferences store；若未配置或值非法，返回默认 3。
 */
function getThreshold(): number {
  const prefs = usePreferencesStore.getState();
  const n = (prefs as { teachThreshold?: unknown }).teachThreshold;
  if (typeof n === "number" && VALID_THRESHOLDS.has(n)) return n;
  return DEFAULT_TEACH_THRESHOLD;
}

/**
 * 检查 Teach Agent 是否启用
 *
 * 默认 true（teachAgentEnabled !== false 兼容旧偏好未设置的情况）
 */
function isTeachEnabled(): boolean {
  const prefs = usePreferencesStore.getState();
  return (prefs as { teachAgentEnabled?: unknown }).teachAgentEnabled !== false;
}

/**
 * 格式化时间戳为 "YYYY-MM-DD HH:mm"（本地时区，用于 MD 标题）
 */
function formatTimestamp(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

/**
 * 构造一条教学历史 MD 段落
 *
 * 格式见 resources/teach/teach-template.md
 */
function buildHistoryEntry(
  command: string,
  cwd: string,
  explanation: string,
): string {
  const ts = formatTimestamp(new Date());
  return (
    `## ${ts}\n\n` +
    `**命令**: \`${command}\`\n` +
    `**目录**: \`${cwd}\`\n` +
    `**讲解**:\n${explanation}\n\n` +
    `---\n\n`
  );
}

/**
 * 读取现有教学历史 MD 内容
 *
 * 文件不存在时返回空字符串（不抛错，让调用方按"新建文件"处理）。
 * 走 Rust 端 fs_read_file（已注册的 Tauri command，无需改 src-tauri）。
 */
async function readTeachHistory(path: string): Promise<string> {
  type ReadResult =
    | { kind: "text"; content: string; size: number; mtime: number }
    | { kind: "binary"; size: number }
    | { kind: "toolarge"; size: number; limit: number };
  try {
    const res = await invoke<ReadResult>("fs_read_file", {
      path,
      workspace: null,
      force: false,
    });
    if (res.kind === "text") return res.content;
    return "";
  } catch {
    // 文件不存在 / 读取失败 → 当作空文件
    return "";
  }
}

// === 公开 API ================================================================

/**
 * 记录用户最近一次提交到 PTY 的命令文本
 *
 * 在 useTerminalSession.submitToLeaf 中调用（命令通过风险评估后）。
 * OSC 7 触发时通过 getLastSubmittedCommand 读取，作为讲解 input。
 *
 * @param text 用户提交的命令文本（可能含换行，由调用方传入原始文本）
 */
export function recordSubmittedCommand(text: string): void {
  lastSubmittedCommand = text;
}

/**
 * 获取最近一次提交的命令文本（OSC 7 触发时调用）
 */
export function getLastSubmittedCommand(): string {
  return lastSubmittedCommand;
}

/**
 * 重置命令计数器
 *
 * 使用场景：
 *   - 用户在设置中点"清空历史"按钮
 *   - 单测中每个 case 重置，避免相互污染
 *   - 用户切换降频阈值后清零（避免旧计数错位）
 */
export function resetTeachCounter(): void {
  commandCount = 0;
}

/**
 * 通知一次命令执行完成（由 OSC 7 触发）
 *
 * 降频逻辑：计数器 +1，若 count % threshold !== 0 则静默返回。
 * 命中阈值时：
 *   1. 调 runSidecarStream({agentId:"teach", input:"explain: <cmd>"})
 *   2. 收集流式响应 → toast.info() 显示（非阻塞，duration 5000ms）
 *   3. appendToTeachHistory 写入 MD 文件
 *
 * 错误处理：sidecar 调用失败 / toast 异常 / MD 写入失败 全部静默吞掉，
 * 不弹错误 toast，避免教学功能干扰主流程。
 *
 * @param command 命令文本（OSC 7 不携带命令，由 recordSubmittedCommand 提供）
 * @param cwd     命令执行后的工作目录（OSC 7 携带）
 */
export async function notifyCommandExecuted(
  command: string,
  cwd: string,
): Promise<void> {
  // 0. 空命令 / 仅空白 → 跳过（不计数，避免误触发）
  const cmd = command.trim();
  if (!cmd) return;

  // 1. 偏好检查
  if (!isTeachEnabled()) return;

  // 2. 降频计数
  commandCount += 1;
  const threshold = getThreshold();
  if (commandCount % threshold !== 0) return;

  // 3. 调 teach agent（带 15s 超时保护）
  let explanation = "";
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TEACH_SIDECAR_TIMEOUT_MS);

    for await (const part of runSidecarStream({
      agentId: "teach",
      input: `explain: ${cmd}`,
      messages: [],
      // TDSF 魔改 2026-07-30 (Bug 5): SidecarStreamOptions.live 必填，
      // teach-trigger 触发时无终端上下文（仅 command + cwd），传最小空 live。
      // Python teach agent 会收到 sshSessionId=null，不会调运维工具。
      live: {
        cwd: cwd,
        terminalPrivate: false,
        workspaceRoot: null,
        activeFile: null,
        sshSessionId: null,
      },
      abortSignal: ac.signal,
    })) {
      if (part.type === "text-delta") {
        explanation += part.delta;
      } else if (part.type === "error") {
        // 静默吞掉错误：不弹错误 toast，直接返回
        clearTimeout(timer);
        return;
      } else if (part.type === "finish") {
        break;
      }
    }
    clearTimeout(timer);
  } catch {
    // sidecar 调用失败 / 超时 / abort → 静默吞掉
    return;
  }

  // 4. 空讲解 → 跳过（不弹空 toast，不写空 MD）
  if (!explanation.trim()) return;

  // 5. toast 显示（非阻塞，duration 5000ms，不抢焦点）
  try {
    toast.info(explanation, {
      duration: TEACH_TOAST_DURATION_MS,
      description: `cmd: ${cmd}`,
    });
  } catch {
    // toast 异常不影响 MD 写入
  }

  // 6. 追加到教学历史 MD（异步，不阻塞返回）
  void appendToTeachHistory(cmd, cwd, explanation);
}

/**
 * 把一次讲解追加到 ~/.tdsf/teach/teach-history.md
 *
 * 文件不存在时自动创建（含头部 # TDSF 教学历史）。
 * 通过 Rust 端 fs_write_file 原子写入（先读后写模拟追加）。
 *
 * @param command    命令文本
 * @param cwd        命令执行时的工作目录
 * @param explanation 讲解内容（teach agent 输出）
 */
export async function appendToTeachHistory(
  command: string,
  cwd: string,
  explanation: string,
): Promise<void> {
  try {
    const home = await homeDir();
    const path = await join(home, ...TEACH_HISTORY_REL_PATH);

    // 读取现有内容（文件不存在时返回空）
    const existing = await readTeachHistory(path);

    // 构造新内容：首次创建时加头部，之后追加
    const entry = buildHistoryEntry(command, cwd, explanation);
    const content =
      existing.length === 0
        ? `${TEACH_HISTORY_HEADER}${entry}`
        : existing + entry;

    // 原子写入（fs_write_file 内部用 tempfile + rename）
    await invoke("fs_write_file", {
      path,
      content,
      workspace: null,
      source: "tdsf-teach",
    });
  } catch {
    // 写入失败静默吞掉（不阻塞主流程，不打扰用户）
  }
}

/**
 * 清空教学历史 MD 文件
 *
 * 写入空字符串（保留文件，方便下次直接追加头部）。
 * 同时重置命令计数器，让降频从头开始。
 *
 * 使用场景：用户在设置面板点"清空历史"按钮。
 */
export async function clearTeachHistory(): Promise<void> {
  try {
    const home = await homeDir();
    const path = await join(home, ...TEACH_HISTORY_REL_PATH);
    await invoke("fs_write_file", {
      path,
      content: "",
      workspace: null,
      source: "tdsf-teach-clear",
    });
  } catch {
    // 静默吞掉
  }
  resetTeachCounter();
}

// === 测试专用钩子 ============================================================
//
// 以下导出仅供单测使用，用于在 vitest 中重置模块级状态。
// 生产代码不要调用。

/**
 * @internal 仅供测试使用：读取当前命令计数器值
 */
export function _getCommandCountForTest(): number {
  return commandCount;
}

/**
 * @internal 仅供测试使用：直接设置命令计数器值
 */
export function _setCommandCountForTest(n: number): void {
  commandCount = n;
}
