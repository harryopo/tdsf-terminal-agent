/**
 * terminalBlocksStore.ts — 终端 block 流水账 zustand store
 * （方案书 v3.1 §4.7 B1，2026-08-29）
 *
 * 按 leafId 存储已完成命令 block，供 transport.ts 组装
 * `<terminal-history>` 上下文注入（agent 终端感知）。
 *
 * author=agent 标记：agent 经 injectIntoActivePty 注入命令时
 * markAgentPending 打"待命标记"（带 10s 窗口），下一条 block 结算时
 * resolveAuthor 消费之 → author="agent"（atuin Agent Hooks 思想，
 * 教学回放"AI 本轮做了什么"）。不比对命令文本——远端 633;E 上报的
 * 文本可能与注入文本有 \r 等差异，时间窗口法更稳。
 */
import { create } from "zustand";
import type { TerminalBlock, TerminalBlockAuthor } from "./terminalBlocks";

/** 每个 leaf 保留的 block 上限（上下文只用最近 10 条，50 条余量足够） */
const MAX_BLOCKS_PER_LEAF = 50;
/** agent 待命标记有效期（注入 → 远端 shell 回显 633;E 的往返延迟） */
const AGENT_PENDING_TTL_MS = 10_000;

type TerminalBlocksState = {
  blocksByLeaf: Record<number, TerminalBlock[]>;
  /** leafId → agent 注入待命标记时刻（undefined = 无标记） */
  agentPending: Record<number, number | undefined>;
  pushBlock: (block: TerminalBlock) => void;
  markAgentPending: (leafId: number) => void;
  /** block 结算时调用：命中待命标记 → "agent" 并清除；否则 "user" */
  resolveAuthor: (leafId: number, command: string) => TerminalBlockAuthor;
  getRecent: (leafId: number, n: number) => TerminalBlock[];
  clearLeaf: (leafId: number) => void;
};

export const useTerminalBlocksStore = create<TerminalBlocksState>(
  (set, get) => ({
    blocksByLeaf: {},
    agentPending: {},

    pushBlock(block) {
      set((s) => {
        const list = s.blocksByLeaf[block.sessionId] ?? [];
        const next = [...list, block];
        while (next.length > MAX_BLOCKS_PER_LEAF) next.shift();
        return {
          blocksByLeaf: { ...s.blocksByLeaf, [block.sessionId]: next },
        };
      });
    },

    markAgentPending(leafId) {
      set((s) => ({
        agentPending: { ...s.agentPending, [leafId]: Date.now() },
      }));
    },

    resolveAuthor(leafId, _command) {
      const ts = get().agentPending[leafId];
      if (ts === undefined) return "user";
      // 用后即清（无论是否过期）——防止标记漂移到后续用户命令上
      set((s) => {
        const next = { ...s.agentPending };
        delete next[leafId];
        return { agentPending: next };
      });
      return Date.now() - ts <= AGENT_PENDING_TTL_MS ? "agent" : "user";
    },

    getRecent(leafId, n) {
      const list = get().blocksByLeaf[leafId] ?? [];
      return n >= list.length ? list.slice() : list.slice(-n);
    },

    clearLeaf(leafId) {
      set((s) => {
        const next = { ...s.blocksByLeaf };
        delete next[leafId];
        const nextPending = { ...s.agentPending };
        delete nextPending[leafId];
        return { blocksByLeaf: next, agentPending: nextPending };
      });
    },
  }),
);
