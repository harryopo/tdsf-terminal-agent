/**
 * completion.test.ts — 终端补全引擎测试 (T-P2-10.6)
 * -----------------------------------------------------------------------------
 * 覆盖:
 *   1. CommandTrie: insert + search + 前缀匹配 + 空前缀返回空
 *   2. Frecency: score 计算公式 + rank 排序 + 最近优先 + 频繁优先
 *   3. CompletionEngine: addCommand + complete + limit + updateUsage + loadHistory
 *
 * Frecency 公式 (验证基线):
 *   score = useCount * (1 + 1 / (hoursSinceLastUse + 1))
 *   - 1h 内 +1.0, 24h 内 +0.04, 168h(一周) 内 +0.006
 *   - 即: 越最近使用 → 衰减越小 → 分数越高
 */
import { describe, it, expect } from 'vitest';
import {
  CommandTrie,
  Frecency,
  CompletionEngine,
  type CommandMeta,
} from './completion';

// ============================================================================
// CommandTrie 测试
// ============================================================================

describe('CommandTrie — 前缀树', () => {
  it('test_trie_insert_and_search: 插入命令后能按前缀搜索到', () => {
    const trie = new CommandTrie();
    trie.insert('ls');
    trie.insert('ls -la');
    trie.insert('ls -lh');
    trie.insert('cd /tmp');
    trie.insert('cat');

    const results = trie.search('ls');
    // 应该匹配所有以 'ls' 开头的命令 (含 'ls' 本身)
    expect(results).toContain('ls');
    expect(results).toContain('ls -la');
    expect(results).toContain('ls -lh');
    // 不应包含其他前缀
    expect(results).not.toContain('cat');
    expect(results).not.toContain('cd /tmp');
    // 总共 3 条匹配
    expect(results.length).toBe(3);
  });

  it('test_trie_prefix_match: 不同前缀返回不同结果集', () => {
    const trie = new CommandTrie();
    trie.insert('git status');
    trie.insert('git push');
    trie.insert('git commit');
    trie.insert('go build');
    trie.insert('go test');
    trie.insert('grep -r foo .');

    // 'git' 前缀
    const gitResults = trie.search('git');
    expect(gitResults.length).toBe(3);
    expect(gitResults.sort()).toEqual(
      ['git commit', 'git push', 'git status'].sort(),
    );

    // 'go' 前缀
    const goResults = trie.search('go');
    expect(goResults.length).toBe(2);
    expect(goResults.sort()).toEqual(['go build', 'go test'].sort());

    // 'g' 前缀应同时匹配 git + go + grep
    const gResults = trie.search('g');
    expect(gResults.length).toBe(6);

    // 完整命令 'grep -r foo .' 也匹配
    const grepResults = trie.search('grep');
    expect(grepResults).toEqual(['grep -r foo .']);
  });

  it('test_trie_empty_returns_empty: 空前缀或不存在前缀返回空数组', () => {
    const trie = new CommandTrie();
    trie.insert('ls');
    trie.insert('cd');

    // 空前缀
    expect(trie.search('')).toEqual([]);

    // 仅空白前缀 (应 trim 后为空)
    expect(trie.search('   ')).toEqual([]);

    // 不存在的前缀
    expect(trie.search('xyz')).toEqual([]);

    // 部分匹配但无完整命令 (例如 Trie 中只有 'ls', 搜索 'lsx' 应返回空)
    expect(trie.search('lsx')).toEqual([]);
  });

  it('test_trie_insert_empty_command: 空命令或纯空白命令不插入', () => {
    const trie = new CommandTrie();
    // 空字符串/纯空白不应插入 (防御性)
    trie.insert('');
    trie.insert('   ');
    trie.insert('\t\n');

    expect(trie.search('')).toEqual([]);
    expect(trie.search(' ')).toEqual([]);
  });

  it('test_trie_insert_with_metadata: 插入时携带 metadata 可被 frecencySort 利用', () => {
    const trie = new CommandTrie();
    const now = Date.now();
    const meta1: CommandMeta = {
      command: 'ls',
      useCount: 10,
      timestamp: now,
      lastUsed: now,
    };
    const meta2: CommandMeta = {
      command: 'ls -la',
      useCount: 1,
      timestamp: now - 24 * 60 * 60 * 1000, // 1 天前
      lastUsed: now - 24 * 60 * 60 * 1000,
    };
    trie.insert('ls', meta1);
    trie.insert('ls -la', meta2);

    const results = trie.search('ls');
    expect(results.length).toBe(2);

    // 按 frecency 排序: useCount=10 + 刚使用 应排在 useCount=1 + 1天前 之前
    const sorted = trie.frecencySort(results, now);
    expect(sorted[0]).toBe('ls');
    expect(sorted[1]).toBe('ls -la');
  });
});

// ============================================================================
// Frecency 测试
// ============================================================================

describe('Frecency — 评分算法', () => {
  it('test_frecency_score_recent_high: 最近使用的命令分数更高', () => {
    const now = Date.now();
    // 两条命令 useCount 相同 (都是 5)
    // cmd1: 1 小时前使用
    // cmd2: 24 小时前使用
    // 期望: cmd1 分数 > cmd2 分数
    const oneHourAgo = now - 1 * 60 * 60 * 1000;
    const oneDayAgo = now - 24 * 60 * 60 * 1000;

    const score1 = Frecency.score(5, oneHourAgo, now);
    const score2 = Frecency.score(5, oneDayAgo, now);

    expect(score1).toBeGreaterThan(score2);
    // 验证公式: score1 = 5 * (1 + 1/(1+1)) = 5 * 1.5 = 7.5
    expect(score1).toBeCloseTo(7.5, 2);
    // score2 = 5 * (1 + 1/(24+1)) = 5 * 1.04 = 5.2
    expect(score2).toBeCloseTo(5.2, 2);
  });

  it('test_frecency_score_frequent_high: 使用次数多的命令分数更高', () => {
    const now = Date.now();
    const lastUsed = now - 60 * 60 * 1000; // 1 小时前

    // 同样最近使用, 但 useCount 不同
    // cmd1: useCount=10
    // cmd2: useCount=1
    // 期望: score1 > score2 且 score1 ≈ 10 * score2
    const score1 = Frecency.score(10, lastUsed, now);
    const score2 = Frecency.score(1, lastUsed, now);

    expect(score1).toBeGreaterThan(score2);
    // 公式: score = useCount * (1 + 1/(1+1)) = useCount * 1.5
    // useCount 比例直接传导到 score 比例
    expect(score1 / score2).toBeCloseTo(10, 2);
  });

  it('test_frecency_rank_sorts_by_score: rank 按 frecency 分数降序排序', () => {
    const now = Date.now();
    const items: CommandMeta[] = [
      // 使用 1 次, 1 周前
      {
        command: 'old-cmd',
        useCount: 1,
        timestamp: now - 7 * 24 * 60 * 60 * 1000,
        lastUsed: now - 7 * 24 * 60 * 60 * 1000,
      },
      // 使用 10 次, 1 分钟前 (应排第一)
      {
        command: 'recent-frequent',
        useCount: 10,
        timestamp: now - 60 * 1000,
        lastUsed: now - 60 * 1000,
      },
      // 使用 5 次, 1 小时前
      {
        command: 'mid',
        useCount: 5,
        timestamp: now - 60 * 60 * 1000,
        lastUsed: now - 60 * 60 * 1000,
      },
    ];

    const ranked = Frecency.rank(items, now);
    expect(ranked[0]!.command).toBe('recent-frequent');
    expect(ranked[1]!.command).toBe('mid');
    expect(ranked[2]!.command).toBe('old-cmd');
  });

  it('test_frecency_score_zero_use_count: useCount=0 返回 0 分', () => {
    const now = Date.now();
    expect(Frecency.score(0, now, now)).toBe(0);
    // 负数 useCount 也视为 0
    expect(Frecency.score(-5, now, now)).toBe(0);
  });

  it('test_frecency_score_future_timestamp: 未来时间戳视为 0 衰减 (取 max(0))', () => {
    const now = Date.now();
    // lastUsed 在未来 (时钟漂移场景) → 衰减应视为 0
    const future = now + 60 * 60 * 1000; // 1 小时后
    const score = Frecency.score(5, future, now);
    // score = 5 * (1 + 1/(0+1)) = 5 * 2 = 10
    expect(score).toBeCloseTo(10, 2);
  });

  it('test_frecency_rank_empty: 空列表输入返回空列表', () => {
    expect(Frecency.rank([], Date.now())).toEqual([]);
  });
});

// ============================================================================
// CompletionEngine 测试
// ============================================================================

describe('CompletionEngine — 补全引擎', () => {
  it('test_completion_engine_add_and_complete: addCommand 后 complete 返回匹配候选', () => {
    const engine = new CompletionEngine();
    engine.addCommand('ls');
    engine.addCommand('ls -la');
    engine.addCommand('ls -lh');
    engine.addCommand('cd');
    engine.addCommand('cat');

    const result = engine.complete('ls');
    expect(result.prefix).toBe('ls');
    expect(result.items.length).toBe(3);
    const cmds = result.items.map((i) => i.command);
    expect(cmds).toContain('ls');
    expect(cmds).toContain('ls -la');
    expect(cmds).toContain('ls -lh');

    // 'cd' 前缀
    const cdResult = engine.complete('cd');
    expect(cdResult.items.length).toBe(1);
    expect(cdResult.items[0]!.command).toBe('cd');

    // 不存在的前缀
    const empty = engine.complete('xyz');
    expect(empty.items).toEqual([]);
  });

  it('test_completion_engine_limit: limit 参数限制返回候选数', () => {
    const engine = new CompletionEngine();
    // 插入 15 个 'git' 前缀命令
    for (let i = 0; i < 15; i++) {
      engine.addCommand(`git cmd${i}`);
    }

    // limit=5: 返回 5 条
    const r5 = engine.complete('git', 5);
    expect(r5.items.length).toBe(5);

    // limit=10 (默认): 返回 10 条
    const r10 = engine.complete('git', 10);
    expect(r10.items.length).toBe(10);

    // limit=0: 返回空 (slice(0, 0))
    const r0 = engine.complete('git', 0);
    expect(r0.items.length).toBe(0);

    // limit 超过候选总数: 返回所有匹配项 (15 条)
    const r100 = engine.complete('git', 100);
    expect(r100.items.length).toBe(15);
  });

  it('test_completion_engine_update_usage: updateUsage 累加 useCount 并影响排序', () => {
    const engine = new CompletionEngine();
    engine.addCommand('git status');
    engine.addCommand('git push');

    // 初始时两个命令 useCount 都是 0
    let result = engine.complete('git');
    const initial = result.items.find((i) => i.command === 'git status');
    expect(initial?.useCount).toBe(0);

    // 执行 git status 3 次
    engine.updateUsage('git status');
    engine.updateUsage('git status');
    engine.updateUsage('git status');
    // 执行 git push 1 次
    engine.updateUsage('git push');

    // 现在查询: git status useCount=3, git push useCount=1
    result = engine.complete('git');
    const statusItem = result.items.find((i) => i.command === 'git status');
    const pushItem = result.items.find((i) => i.command === 'git push');
    expect(statusItem?.useCount).toBe(3);
    expect(pushItem?.useCount).toBe(1);

    // useCount 高的应排在前面 (相同最近时间下)
    expect(result.items[0]!.command).toBe('git status');
  });

  it('test_completion_engine_load_history: 批量加载历史命令并累加 useCount', () => {
    const engine = new CompletionEngine();

    // 模拟 shell history 文件内容 (重复命令会被累加 useCount)
    const history = [
      'ls',
      'ls',
      'ls',
      'cd /tmp',
      'cd /tmp',
      'git status',
      'ls',
      'cat file.txt',
    ];

    engine.loadHistory(history);

    // 'ls' 出现 4 次 → useCount=4
    // 'cd /tmp' 出现 2 次 → useCount=2
    // 'git status' 出现 1 次 → useCount=1
    // 'cat file.txt' 出现 1 次 → useCount=1
    const lsResult = engine.complete('ls');
    expect(lsResult.items.length).toBe(1);
    expect(lsResult.items[0]!.useCount).toBe(4);

    const cdResult = engine.complete('cd');
    expect(cdResult.items[0]!.useCount).toBe(2);

    const gitResult = engine.complete('git');
    expect(gitResult.items[0]!.useCount).toBe(1);

    const catResult = engine.complete('cat');
    expect(catResult.items[0]!.useCount).toBe(1);
  });

  it('test_completion_engine_empty_prefix: 空前缀返回空候选', () => {
    const engine = new CompletionEngine();
    engine.addCommand('ls');
    engine.addCommand('cd');

    expect(engine.complete('').items).toEqual([]);
    expect(engine.complete('   ').items).toEqual([]);
  });

  it('test_completion_engine_clear: clear 清空所有索引和历史', () => {
    const engine = new CompletionEngine();
    engine.addCommand('ls');
    engine.addCommand('cd');
    engine.updateUsage('ls');

    // 清空后查询应返回空
    engine.clear();
    expect(engine.complete('ls').items).toEqual([]);
    expect(engine.complete('cd').items).toEqual([]);

    // 清空后仍可重新添加
    engine.addCommand('pwd');
    expect(engine.complete('pwd').items.length).toBe(1);
  });

  it('test_completion_engine_returns_lastUsedMs: complete 结果含 lastUsedMs 时间戳', () => {
    const engine = new CompletionEngine();
    engine.addCommand('ls');

    // updateUsage 设置 timestamp
    engine.updateUsage('ls');

    const result = engine.complete('ls');
    expect(result.items.length).toBe(1);
    expect(result.items[0]!.lastUsedMs).toBeGreaterThan(0);
    // 应为最近时间 (1 秒内)
    const now = Date.now();
    expect(now - result.items[0]!.lastUsedMs).toBeLessThan(1000);
  });

  it('test_completion_engine_load_history_skips_empty: loadHistory 跳过空行和空白行', () => {
    const engine = new CompletionEngine();
    const history = [
      'ls',
      '',
      '   ',
      '\t',
      'cd',
    ];
    engine.loadHistory(history);

    // 应只加载 2 条非空命令
    expect(engine.complete('ls').items.length).toBe(1);
    expect(engine.complete('cd').items.length).toBe(1);
    expect(engine.complete('').items).toEqual([]);
  });

  it('test_completion_engine_frecency_ordering: 同时有 frequency 和 recency 差异时综合排序', () => {
    const engine = new CompletionEngine();

    // cmd1: 1 周前用 10 次 (老但频繁)
    // cmd2: 1 分钟前用 1 次 (新但不频繁)
    // Frecency 公式:
    //   cmd1: 10 * (1 + 1/(168+1)) = 10 * 1.006 ≈ 10.06
    //   cmd2: 1 * (1 + 1/(0.0167+1)) = 1 * 1.98 ≈ 1.98
    // 期望: cmd1 分数更高 (频繁压倒新近)
    const now = Date.now();
    engine.addCommand('cmd1', {
      useCount: 10,
      timestamp: now - 7 * 24 * 60 * 60 * 1000,
      lastUsed: now - 7 * 24 * 60 * 60 * 1000,
    });
    engine.addCommand('cmd2', {
      useCount: 1,
      timestamp: now - 60 * 1000,
      lastUsed: now - 60 * 1000,
    });

    const result = engine.complete('cmd');
    expect(result.items[0]!.command).toBe('cmd1');
    expect(result.items[1]!.command).toBe('cmd2');
  });
});
