/**
 * completion.ts — TDSF 终端补全引擎 (T-P2-10)
 * -----------------------------------------------------------------------------
 * 职责:
 *   1. Trie 前缀树: O(L) 查找前缀匹配的命令 (L = 前缀长度)
 *   2. Frecency 排序: 参考 Mozilla Firefox frecency 算法,
 *      综合 frequency (使用次数) + recency (最近使用时间) 排序
 *   3. CompletionEngine: 整合 Trie + Frecency, 提供 complete() API
 *
 * Frecency 公式 (T-P2-10.1):
 *   score = useCount * (1 + 1 / (hoursSinceLastUse + 1))
 *   - useCount: 历史使用次数
 *   - hoursSinceLastUse: 距离上次使用的小时数
 *   - 时间衰减项 1/(h+1): 1h 内 +1.0, 24h 内 +0.04, 168h(一周) 内 +0.006
 *   - 即: 越最近使用 → 衰减越小 → 分数越高
 *
 * 设计要点:
 *   - 严格 TypeScript, 无 any
 *   - Trie 节点用 Map<string, TrieNode>, 字符级查找 O(1)
 *   - Frecency 排序稳定 (相同分数按字典序)
 *   - 完全无副作用, 纯函数式 + 类封装
 * -----------------------------------------------------------------------------
 */

// ============================================================================
// 类型定义
// ============================================================================

/** 命令元数据 (使用统计) */
export interface CommandMeta {
  /** 完整命令字符串 */
  command: string;
  /** 历史使用次数 */
  useCount: number;
  /** 上次使用时间戳 (毫秒 epoch) — Frecency 评分用 */
  timestamp: number;
  /** 上次使用时间戳 (毫秒 epoch) — UI 展示用 (与 timestamp 同步) */
  lastUsed: number;
}

/** 补全候选条目 (返回给 UI) */
export interface CompletionItem {
  /** 完整命令 */
  command: string;
  /** 使用次数 */
  useCount: number;
  /** 上次使用时间戳 (毫秒 epoch) */
  lastUsedMs: number;
}

/** 补全结果 */
export interface CompletionResult {
  /** 用户输入的前缀 (已 trim) */
  prefix: string;
  /** 排序后的候选列表 */
  items: CompletionItem[];
}

// ============================================================================
// TrieNode / CommandTrie — 前缀树
// ============================================================================

/**
 * Trie 节点
 * - children: 子节点映射 (字符 → 子节点)
 * - isEnd: 是否为命令结束节点
 * - command: 完整命令 (仅 isEnd=true 时有值)
 * - metadata: 命令元数据 (使用统计)
 */
export interface TrieNode {
  readonly children: Map<string, TrieNode>;
  isEnd: boolean;
  command: string | null;
  metadata: CommandMeta | null;
}

/** 创建空 Trie 节点 */
function createTrieNode(): TrieNode {
  return {
    children: new Map(),
    isEnd: false,
    command: null,
    metadata: null,
  };
}

/**
 * 命令前缀树
 * - insert: O(L), L = 命令长度
 * - search: O(L + M), L = 前缀长度, M = 匹配的命令数量
 */
export class CommandTrie {
  readonly root: TrieNode = createTrieNode();

  /** 插入命令到 Trie */
  insert(command: string, meta?: CommandMeta): void {
    const trimmed = command.trim();
    if (trimmed.length === 0) return;

    let node = this.root;
    for (const ch of trimmed) {
      let child = node.children.get(ch);
      if (!child) {
        child = createTrieNode();
        node.children.set(ch, child);
      }
      node = child;
    }
    node.isEnd = true;
    node.command = trimmed;
    node.metadata = meta ?? null;
  }

  /**
   * 搜索前缀匹配的所有命令
   * @param prefix 前缀字符串
   * @returns 匹配的命令列表 (未排序, 按 Trie DFS 遍历顺序)
   */
  search(prefix: string): string[] {
    const trimmed = prefix.trim();
    if (trimmed.length === 0) return [];

    // 定位到前缀末节点
    let node: TrieNode | undefined = this.root;
    for (const ch of trimmed) {
      node = node.children.get(ch);
      if (!node) return [];
    }

    // DFS 收集所有完整命令
    const results: string[] = [];
    const stack: TrieNode[] = [node];
    while (stack.length > 0) {
      const cur = stack.pop()!;
      if (cur.isEnd && cur.command !== null) {
        results.push(cur.command);
      }
      // Map 的迭代顺序是插入顺序, 这里仅作收集, 排序交给 frecencySort
      for (const child of cur.children.values()) {
        stack.push(child);
      }
    }
    return results;
  }

  /**
   * 按 Frecency 排序命令
   * - 有 metadata 的用 metadata 计算
   * - 无 metadata 的视为 useCount=0, 永不使用 (分数 0, 排末尾)
   */
  frecencySort(commands: string[], now: number = Date.now()): string[] {
    const withMeta = commands.map((cmd) => {
      const meta = this.findMetadata(cmd);
      const score = meta
        ? Frecency.score(meta.useCount, meta.timestamp, now)
        : 0;
      return { command: cmd, score };
    });
    withMeta.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      // 相同分数按字典序 (稳定排序)
      return a.command.localeCompare(b.command);
    });
    return withMeta.map((x) => x.command);
  }

  /** 获取命令的 metadata (内部使用) */
  private findMetadata(command: string): CommandMeta | null {
    let node: TrieNode | undefined = this.root;
    for (const ch of command) {
      node = node.children.get(ch);
      if (!node) return null;
    }
    return node.isEnd ? node.metadata : null;
  }
}

// ============================================================================
// Frecency — Mozilla Firefox 风格 frecency 评分
// ============================================================================

/**
 * Frecency 静态类
 *
 * 算法 (T-P2-10.1):
 *   score = useCount * (1 + 1 / (hoursSinceLastUse + 1))
 *
 * 等价变形:
 *   score = useCount + useCount / (hoursSinceLastUse + 1)
 *   → 第一项是 frequency, 第二项是 recency 加权
 *
 * 设计取舍:
 *   - 不采用 Mozilla 的"按访问时间分桶再加权"复杂方案,
 *     用连续衰减函数 1/(h+1) 简化实现, 仍能体现 recency 语义
 *   - 单调递减, 平滑衰减, 无突变
 */
export class Frecency {
  /**
   * 计算 Frecency 分数
   * @param useCount 历史使用次数
   * @param lastUsedMs 上次使用时间戳 (毫秒 epoch)
   * @param nowMs 当前时间戳 (毫秒 epoch), 默认 Date.now()
   * @returns Frecency 分数 (≥0, 越高越优先)
   */
  static score(
    useCount: number,
    lastUsedMs: number,
    nowMs: number = Date.now(),
  ): number {
    if (useCount <= 0) return 0;
    const elapsedMs = Math.max(0, nowMs - lastUsedMs);
    const hoursSinceLastUse = elapsedMs / (1000 * 60 * 60);
    return useCount * (1 + 1 / (hoursSinceLastUse + 1));
  }

  /**
   * 按 Frecency 分数排序命令列表
   * - 高分在前, 同分按命令字典序
   * @param items 命令元数据列表
   * @returns 排序后的列表
   */
  static rank(items: CommandMeta[], now: number = Date.now()): CommandMeta[] {
    return [...items]
      .map((item) => ({
        item,
        score: Frecency.score(item.useCount, item.timestamp, now),
      }))
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.item.command.localeCompare(b.item.command);
      })
      .map((x) => x.item);
  }
}

// ============================================================================
// CompletionEngine — 整合 Trie + Frecency 的高层引擎
// ============================================================================

/**
 * 终端补全引擎
 * - 维护 Trie 索引 + 命令历史 (Map<command, CommandMeta>)
 * - complete(prefix, limit): 返回排序后的补全候选
 * - updateUsage(command): 命令执行后更新使用统计
 */
export class CompletionEngine {
  private readonly trie: CommandTrie = new CommandTrie();
  private readonly history: Map<string, CommandMeta> = new Map();

  /** 添加命令到 Trie (重复插入会刷新 metadata) */
  addCommand(command: string, meta?: Partial<CommandMeta>): void {
    const trimmed = command.trim();
    if (trimmed.length === 0) return;

    // 合并现有 metadata + 新传入的 metadata
    const existing = this.history.get(trimmed);
    const now = Date.now();
    const merged: CommandMeta = {
      command: trimmed,
      useCount: meta?.useCount ?? existing?.useCount ?? 0,
      timestamp: meta?.timestamp ?? existing?.timestamp ?? now,
      lastUsed: meta?.lastUsed ?? existing?.lastUsed ?? now,
    };
    this.history.set(trimmed, merged);
    this.trie.insert(trimmed, merged);
  }

  /**
   * 补全候选查询
   * @param prefix 用户已输入的前缀
   * @param limit 返回的最大候选数 (默认 10)
   * @returns 补全结果 (含原始 prefix + 排序后的候选列表)
   */
  complete(prefix: string, limit: number = 10): CompletionResult {
    const trimmed = prefix.trim();
    if (trimmed.length === 0) {
      return { prefix: trimmed, items: [] };
    }

    const matched = this.trie.search(trimmed);
    const sorted = this.trie.frecencySort(matched);
    const top = sorted.slice(0, Math.max(0, limit));

    const items: CompletionItem[] = top.map((cmd) => {
      const meta = this.history.get(cmd);
      return {
        command: cmd,
        useCount: meta?.useCount ?? 0,
        lastUsedMs: meta?.timestamp ?? 0,
      };
    });

    return { prefix: trimmed, items };
  }

  /**
   * 更新命令使用统计 (命令执行后调用)
   * - useCount +1
   * - timestamp 刷新为当前时间
   */
  updateUsage(command: string): void {
    const trimmed = command.trim();
    if (trimmed.length === 0) return;

    const existing = this.history.get(trimmed);
    const now = Date.now();
    const meta: CommandMeta = {
      command: trimmed,
      useCount: (existing?.useCount ?? 0) + 1,
      timestamp: now,
      lastUsed: now,
    };
    this.history.set(trimmed, meta);
    this.trie.insert(trimmed, meta);
  }

  /**
   * 批量加载历史命令
   * - 用于初始化时从 shell history 文件加载
   * - 顺序加载, 同名命令累加 useCount
   */
  loadHistory(commands: string[]): void {
    const now = Date.now();
    for (const raw of commands) {
      const cmd = raw.trim();
      if (cmd.length === 0) continue;

      const existing = this.history.get(cmd);
      // 历史命令默认 useCount=1 (出现过即视为用过一次)
      // 重复出现的同名命令累加 useCount
      const meta: CommandMeta = {
        command: cmd,
        useCount: (existing?.useCount ?? 0) + 1,
        timestamp: now,
        lastUsed: now,
      };
      this.history.set(cmd, meta);
      this.trie.insert(cmd, meta);
    }
  }

  /** 清空所有命令索引和历史 */
  clear(): void {
    this.history.clear();
    // Trie 根节点是 readonly, 但其 children 可以清空
    this.trie.root.children.clear();
    this.trie.root.isEnd = false;
    this.trie.root.command = null;
    this.trie.root.metadata = null;
  }
}

// ============================================================================
// formatRelativeTime — 相对时间格式化 (供 UI 使用)
// ============================================================================

/**
 * 将时间戳格式化为相对时间字符串 (如 "5m ago", "2h ago")
 * - <1 分钟: "just now"
 * - <1 小时: "Nm ago"
 * - <1 天:   "Nh ago"
 * - <1 周:   "Nd ago"
 * - ≥1 周:   "Nw ago"
 *
 * @param timestampMs 时间戳 (毫秒 epoch)
 * @param now 当前时间戳, 默认 Date.now()
 */
export function formatRelativeTime(
  timestampMs: number,
  now: number = Date.now(),
): string {
  if (timestampMs <= 0) return '';
  const diffSec = Math.max(0, Math.floor((now - timestampMs) / 1000));
  if (diffSec < 60) return 'just now';
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}h ago`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  const diffWeek = Math.floor(diffDay / 7);
  return `${diffWeek}w ago`;
}
