/**
 * suggest-engine.ts — Fish autosuggest 三层预测引擎，按环境分流 (TDSF 2026-08-09/28)
 * -----------------------------------------------------------------------------
 * 核心算法移植自 fish-shell 的 autosuggest（C++ → TypeScript），
 * 参考 deep-research-ultra 调研报告的推荐方案：
 *
 *   Layer 1: 命令历史匹配（fish 风格，最近优先）
 *   Layer 2: 命令字典精确匹配（前缀 startsWith，按匹配质量排序）
 *   Layer 3: fuzzysort 模糊匹配（fzf 风格子序列匹配 + 评分，严格阈值兜底）
 *
 * 环境分流（TDSF 2026-08-28，用户反馈"本地预测 Linux 命令输入了没用"）：
 *   - windows 环境：本地 pwsh/cmd → WINDOWS_COMMAND_LIST（真实可用的
 *     PowerShell cmdlet + cmd 工具），历史独立记录
 *   - linux 环境：SSH 服务器 → Fig specs 707 命令 + 中文描述（tldr zh），
 *     历史独立记录
 *
 * 开源参考：
 *   - fish-shell/src/complete.cpp (GPL-2.0) — autosuggest 核心算法（借鉴思想）
 *   - fuzzysort (MIT) — fzf 风格模糊匹配引擎
 *   - Fig specs (MIT) — CLI 命令结构化定义
 *   - tldr-pages (CC BY 4.0) — 命令中文描述（scripts/build-tldr-zh.mjs 生成）
 *
 * 性能：单次 getSuggestions() < 1ms（内存缓存 + 前缀索引）
 * -----------------------------------------------------------------------------
 */
import fuzzysort from "fuzzysort";
import { COMMAND_LIST, type CommandDictEntry } from "./command-dictionary";
import { WINDOWS_COMMAND_LIST } from "./windows-commands";
import { SPEC_INDEX } from "./spec-data/generated/spec-index";
import { TLDR_ZH } from "./spec-data/generated/tldr-zh";

// ============================================================================
// 类型
// ============================================================================

/** 终端环境：windows = 本地 pwsh/cmd，linux = SSH 远程服务器 */
export type TerminalEnv = "windows" | "linux";

export interface SuggestionResult {
  /** 完整的建议命令（含已输入前缀）或参数建议文本（-n/--noheadings） */
  command: string;
  /** 来源：history / dictionary / fuzzy（命令层）/ arg（参数层） */
  source: "history" | "dictionary" | "fuzzy" | "arg";
  /** 中文翻译（仅手编词典覆盖的命令有） */
  zh?: string;
  /** 英文描述（Fig spec description / 参数说明） */
  description?: string;
  /** fuzzy 匹配分数（仅 fuzzy 来源有，越低越好） */
  score?: number;
  /** 建议类别：cmd=命令名预测，arg=参数预测（替换当前 token） */
  kind?: "cmd" | "arg";
}

// ============================================================================
// 引擎
// ============================================================================

/** 单环境的命令字典条目 */
interface EnvCommand {
  name: string;
  zh?: string;
  description?: string;
}

export class SuggestEngine {
  /** 历史按环境隔离：本地敲过的 Windows 命令不应混进 SSH 的 Linux 预测 */
  private history: Record<TerminalEnv, string[]> = {
    windows: [],
    linux: [],
  };
  private historySet: Record<TerminalEnv, Set<string>> = {
    windows: new Set(),
    linux: new Set(),
  };
  /** 历史最大保留条数 */
  private readonly maxHistory = 500;

  /** linux 环境：Fig spec 索引 + 中文（tldr zh 优先，手编词典次之） */
  private linuxCommands: EnvCommand[];
  /** windows 环境：手编 PowerShell/cmd 命令表 */
  private windowsCommands: EnvCommand[];

  constructor() {
    // 手编词典（180+ 常用 Linux 命令，含 ll/la 等 shell 别名）
    const manualMap = new Map<string, CommandDictEntry>(
      COMMAND_LIST.map((e) => [e.command, e]),
    );
    // 2026-08-28: 手编词典中的命令**并入预测集**（此前只当翻译映射用）。
    // ll/la 等别名不在 Fig specs 里，导致输入 ll 时精确匹配层为空，
    // fuzzy 兜底弹出 ollama 这类弱子序列命令（用户反馈）。
    const extra: EnvCommand[] = [];
    for (const e of COMMAND_LIST) {
      if (!SPEC_INDEX.some((s) => s.name === e.command)) {
        extra.push({ name: e.command, zh: e.zh });
      }
    }
    this.linuxCommands = [
      ...SPEC_INDEX.map((e) => ({
        name: e.name,
        // 中文优先级: tldr zh（开源全量）> 手编词典 > 无
        zh: TLDR_ZH[e.name] ?? manualMap.get(e.name)?.zh,
        description: e.description,
      })),
      ...extra,
    ];
    this.windowsCommands = WINDOWS_COMMAND_LIST.map((e) => ({
      name: e.command,
      zh: e.zh,
    }));
  }

  // ========================================================================
  // 核心：获取建议（fish 三层算法，按环境分流）
  // ========================================================================

  /**
   * 根据当前输入获取预测建议
   *
   * Fish 优先级：历史 > 字典精确 > fuzzy 模糊（fuzzy 仅兜底，严格阈值）
   *
   * @param input 当前输入前缀
   * @param limit 返回最大条数（默认 5）
   * @param env 终端环境（决定命令集与历史，默认 linux）
   */
  getSuggestions(
    input: string,
    limit = 5,
    env: TerminalEnv = "linux",
  ): SuggestionResult[] {
    if (!input || input.length < 1) return [];
    if (input.includes(" ")) return []; // 含空格 = 在输参数，不预测命令名

    const commands =
      env === "windows" ? this.windowsCommands : this.linuxCommands;
    const history = this.history[env];

    const results: SuggestionResult[] = [];
    const seen = new Set<string>();

    // ── Layer 1: 历史匹配（fish 核心算法，最近优先）─────────────────────
    for (let i = history.length - 1; i >= 0 && results.length < limit; i--) {
      const cmd = history[i];
      if (!cmd.startsWith(input)) continue;
      if (cmd.length <= input.length) continue; // 建议必须比输入长
      if (seen.has(cmd)) continue;
      seen.add(cmd);
      results.push({ command: cmd, source: "history" });
    }

    // ── Layer 2: 精确前缀匹配（收集全部命中后按匹配质量排序）────────────
    // 2026-08-28 修复"模糊感"：原先按字母序边遍历边截断，前几个字母序命令
    // 会占满 limit，真正贴近输入的匹配进不来。现收集全部命中后按
    // 「长度差升序（越贴近输入越靠前）→ 字母序」排序再截断。
    if (results.length < limit) {
      const lower = input.toLowerCase();
      const matched: EnvCommand[] = [];
      for (const c of commands) {
        if (c.name.toLowerCase().startsWith(lower)) matched.push(c);
      }
      matched.sort((a, b) => {
        const da = a.name.length - input.length;
        const db = b.name.length - input.length;
        return da !== db ? da - db : a.name.localeCompare(b.name);
      });
      for (const c of matched) {
        if (results.length >= limit) break;
        if (seen.has(c.name)) continue;
        seen.add(c.name);
        results.push({
          command: c.name,
          source: "dictionary",
          zh: c.zh,
          description: c.description,
        });
      }
    }

    // ── Layer 3: fuzzysort 模糊匹配（严格阈值 + 首字符约束，仅兜底）──────
    // 2026-08-28: threshold 0.3 → 0.6，弱子序列匹配（如输入 ge 弹出 gh）
    // 正是"模糊预测排在前面/很多无效"的体感来源；模糊只做最后的兜底。
    // 另加首字符一致约束：输入 ll 不应弹出 ollama（首字符都不一样，
    // 纯子序列巧合命中，对用户是噪音）。
    if (results.length < limit) {
      const names = commands.map((c) => c.name);
      const first = input[0].toLowerCase();
      const fuzzyResults = fuzzysort.go(input, names, {
        limit: limit * 3, // 多取一些，过滤首字符不一致后再截断
        threshold: 0.6, // v4: 0=任意匹配, 0.5=良好, 1=精确
      });

      for (const fr of fuzzyResults) {
        if (results.length >= limit) break;
        if (fr.target[0].toLowerCase() !== first) continue; // 首字符必须一致
        if (seen.has(fr.target)) continue;
        seen.add(fr.target);
        const c = commands.find((x) => x.name === fr.target);
        results.push({
          command: fr.target,
          source: "fuzzy",
          zh: c?.zh,
          score: fr.score,
        });
      }
    }

    return results;
  }

  // ========================================================================
  // 历史管理（按环境隔离）
  // ========================================================================

  /**
   * 添加一条命令到历史（fish 行为：Enter 时调用）
   * 自动去重（移到末尾而非保留旧位置）
   */
  addHistory(command: string, env: TerminalEnv = "linux"): void {
    const cmd = command.trim();
    if (!cmd) return;

    const history = this.history[env];
    const historySet = this.historySet[env];

    // fish 风格：如果已存在，移到末尾（最近使用优先）
    if (historySet.has(cmd)) {
      this.history[env] = history.filter((c) => c !== cmd);
    }
    this.history[env].push(cmd);
    historySet.add(cmd);

    // 限制最大长度（移除最旧的）
    if (this.history[env].length > this.maxHistory) {
      const removed = this.history[env].shift();
      if (removed) historySet.delete(removed);
    }
  }

  /**
   * 批量加载历史（从 Rust history_list 或其他持久化恢复）
   * @param commands 历史命令列表（从旧到新）
   */
  loadHistory(commands: string[], env: TerminalEnv = "linux"): void {
    for (const cmd of commands) {
      this.addHistory(cmd, env);
    }
    if (this.history[env].length > this.maxHistory) {
      this.history[env] = this.history[env].slice(-this.maxHistory);
      this.historySet[env] = new Set(this.history[env]);
    }
  }

  /** 获取指定环境的全部历史 */
  getHistory(env: TerminalEnv = "linux"): readonly string[] {
    return this.history[env];
  }

  /** 清空指定环境（或不传则全部）历史 */
  clearHistory(env?: TerminalEnv): void {
    if (env) {
      this.history[env] = [];
      this.historySet[env] = new Set();
    } else {
      this.history = { windows: [], linux: [] };
      this.historySet = { windows: new Set(), linux: new Set() };
    }
  }
}

// ============================================================================
// 单例
// ============================================================================

let _engine: SuggestEngine | null = null;

export function getSuggestEngine(): SuggestEngine {
  if (!_engine) {
    _engine = new SuggestEngine();
  }
  return _engine;
}
