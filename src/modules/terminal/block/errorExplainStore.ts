/**
 * errorExplainStore — 失败块"AI 解释"状态（B1-G3，TDSF 魔改 2026-08-28）
 * -----------------------------------------------------------------------------
 * 用户拍板：手动触发（点击失败块工具条的"AI 解释"按钮），不自动弹出。
 *
 * 链路：BlockOverlay 按钮 → request() → runSidecarStream(agentId:"teach",
 * input:"explain-error: ...") → 流式追加 text → ErrorExplainCard 订阅渲染。
 *
 * 节流（spec §3.3）：
 * - 同一块已完成 → 重复点击复用（setBlockId 直接展示，不重发请求）
 * - 全局单飞行 → streaming 期间忽略其他块的请求
 *
 * 块文本尾部 2KB 过 redactSensitive（B1-G1）后才进 LLM。
 */
import { create } from "zustand";
import { redactSensitive } from "@/modules/ai/lib/redact";
import { usePreferencesStore } from "@/modules/settings/preferences";

export type ExplainStatus = "idle" | "streaming" | "done" | "error";

type ExplainState = {
  /** 当前展示解释的 block id；null = 关闭 */
  blockId: string | null;
  status: ExplainStatus;
  text: string;
  error: string | null;
  /** 已请求过的块（同块只解释一次；结果被 reset 清空后可重发） */
  requested: Set<string>;
  /** 打开/重试某块的解释（streaming 期间全局单飞行，忽略新请求） */
  request: (args: {
    blockId: string;
    command: string;
    exitCode: number | null;
    tail: string;
  }) => Promise<void>;
  close: () => void;
};

/** 块文本送 LLM 的尾部截断长度（spec §3.3） */
const TAIL_MAX_CHARS = 2048;

export const useErrorExplainStore = create<ExplainState>((set, get) => ({
  blockId: null,
  status: "idle",
  text: "",
  error: null,
  requested: new Set<string>(),
  request: async ({ blockId, command, exitCode, tail }) => {
    const { status, requested } = get();
    // 全局单飞行：已有请求在途 → 忽略（按钮置 disabled，不排队）
    if (status === "streaming") return;
    // 同块复用：已完成 → 仅切换展示
    if (requested.has(blockId) && get().blockId === blockId) return;

    set({
      blockId,
      status: "streaming",
      text: "",
      error: null,
      requested: new Set(requested).add(blockId),
    });

    // 输入构造（spec §3.3）：命令 + 退出码 + 输出尾部（脱敏后）
    const cut = tail.length > TAIL_MAX_CHARS ? tail.slice(-TAIL_MAX_CHARS) : tail;
    const input = [
      "explain-error:",
      `命令: ${command || "(unknown)"}`,
      `退出码: ${exitCode ?? "(none)"}`,
      cut ? `输出尾部:\n${redactSensitive(cut)}` : "输出尾部: (empty)",
    ].join("\n");

    let acc = "";
    try {
      // 动态 import：终端模块不静态拉起 AI 栈（eager-budget 红线）
      const { runSidecarStream } = await import(
        "@/modules/ai/lib/sidecar-adapter"
      );
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 30_000);
      try {
        // v3.1 收敛: teach 子 agent 已删除（方案书 §4.1），唯一入口 main；
        // live 不带 agentMode → sidecar 缺省 confirm，错误解释为纯只读输出。
        for await (const part of runSidecarStream({
          agentId: "main",
          input,
          messages: [],
          // 与 teach-trigger 相同的最小 live（错误解释无需终端上下文，
          // Python 侧收到 sshSessionId=null 不会调运维工具）
          live: {
            cwd: null,
            terminalPrivate: false,
            workspaceRoot: null,
            activeFile: null,
            sshSessionId: null,
          },
          abortSignal: ac.signal,
        })) {
          if (part.type === "text-delta") {
            acc += part.delta;
            set({ text: acc });
          } else if (part.type === "error") {
            set({ status: "error", error: part.error });
            return;
          } else if (part.type === "finish") {
            break;
          }
        }
      } finally {
        clearTimeout(timer);
      }
      // 空回复按错误处理（不打扰用户空卡片）
      if (!acc.trim()) {
        set({ status: "error", error: "AI 未返回解释内容" });
        return;
      }
      set({ status: "done" });
    } catch (e) {
      set({
        status: "error",
        error: e instanceof Error ? e.message : "AI 解释请求失败",
      });
    }
  },
  close: () => set({ blockId: null }),
}));

/** Teach 开关（teachAgentEnabled）是否允许解释按钮渲染 */
export function isExplainEnabled(): boolean {
  return usePreferencesStore.getState().teachAgentEnabled !== false;
}
