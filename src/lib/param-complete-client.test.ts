/**
 * param-complete-client.test.ts — 命令参数补全客户端单元测试 (TDSF 2026-08-28)
 * -----------------------------------------------------------------------------
 * 覆盖（spec: add-carapace-param-completion T3/T5/T6）:
 *   1. escapeShSingleQuote: POSIX 单引号转义（a'b / 空串 / 空格 / $ 不展开）
 *   2. parseCarapaceJson: 宽容解析（正常 values / 空 / 畸形 / 非 JSON）
 *   3. buildRemoteCarapaceCommand: 远端命令构造（含 current 空串占位）
 *   4. buildParamRequest: tokens 拆分（含命令名 / sudo 跳过 / 尾随空格）
 *   5. mergeCandidates: carapace 优先去重合并 + limit 8 + 中文钩子
 *   6. remoteCarapaceInstalled: ssh_command 检测 + 会话级缓存 + 失效
 *   7. remoteParamComplete: 成功解析 / 非零退出 / 抛错 → null
 *   8. installRemoteCarapace: 调用顺序 mkdir → upload → chmod+verify
 *
 * Mock 策略: vi.mock('@tauri-apps/api/core')（ssh-bridge 依赖 invoke + Channel）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {},
}));

import {
  buildParamRequest,
  buildRemoteCarapaceCommand,
  CARAPACE_CHECK_CMD,
  CARAPACE_YES_MARK,
  escapeShSingleQuote,
  fetchRemoteCommands,
  getCachedRemoteCommands,
  getLeafCwd,
  getLeafRemoteCwd,
  getLeafSshSession,
  installRemoteCarapace,
  invalidateRemoteCarapaceCache,
  invalidateRemoteCommands,
  mergeCandidates,
  parseCarapaceJson,
  REMOTE_COMMANDS_CMD,
  remoteCarapaceInstalled,
  remoteParamComplete,
  setLeafCwd,
  setLeafSshSession,
} from './param-complete-client';
import { invoke } from '@tauri-apps/api/core';
import type { SuggestionResult } from './suggest-engine';

const mockInvoke = vi.mocked(invoke);

/** ssh_command 的成功返回（与 Rust SshCommandResult 对齐，camelCase） */
function sshResult(output: string, exitCode = 0) {
  return { ok: true, output, stderr: '', exitCode, duration: 0.01 };
}

beforeEach(() => {
  mockInvoke.mockReset();
  // 清掉可能被前序用例污染的会话级缓存
  [42, 7].forEach(invalidateRemoteCarapaceCache);
});

// === escapeShSingleQuote =====================================================

describe('escapeShSingleQuote', () => {
  it('无特殊字符 → 原样单引号包裹', () => {
    expect(escapeShSingleQuote('git')).toBe("'git'");
  });

  it("含单引号 a'b → 'a'\\''b'（sh 单引号拼接惯例）", () => {
    expect(escapeShSingleQuote("a'b")).toBe(`'a'\\''b'`);
  });

  it('空串 → \'\'（保留空参数占位）', () => {
    expect(escapeShSingleQuote('')).toBe("''");
  });

  it('空格 → 包裹后不拆词', () => {
    expect(escapeShSingleQuote('a b')).toBe("'a b'");
  });

  it('$ 与反引号在单引号内不展开（防注入）', () => {
    expect(escapeShSingleQuote('$HOME; rm -rf /')).toBe("'$HOME; rm -rf /'");
    expect(escapeShSingleQuote('`id`')).toBe("'`id`'");
  });
});

// === parseCarapaceJson =======================================================

describe('parseCarapaceJson', () => {
  it('正常 values → 候选数组', () => {
    const out = JSON.stringify({
      values: [
        { value: 'main', description: 'branch main', tag: '240' },
        { value: '-b', description: '' },
      ],
    });
    expect(parseCarapaceJson(out)).toEqual([
      { value: 'main', description: 'branch main', tag: '240' },
      { value: '-b', description: '', tag: undefined },
    ]);
  });

  it('values 缺 description/tag → 默认值', () => {
    expect(parseCarapaceJson('{"values":[{"value":"x"}]}')).toEqual([
      { value: 'x', description: '', tag: undefined },
    ]);
  });

  it('空 values → []', () => {
    expect(parseCarapaceJson('{"values":[]}')).toEqual([]);
  });

  it('畸形 JSON → []（不抛错）', () => {
    expect(parseCarapaceJson('{"values": [broken')).toEqual([]);
  });

  it('非 JSON 文本 → []', () => {
    expect(parseCarapaceJson('carapace: error')).toEqual([]);
  });

  it('候选缺 value / value 非字符串 → 过滤', () => {
    expect(
      parseCarapaceJson('{"values":[{"description":"no value"},{"value":42}]}'),
    ).toEqual([]);
  });

  it('values 非数组 → []', () => {
    expect(parseCarapaceJson('{"values":"nope"}')).toEqual([]);
  });
});

// === buildRemoteCarapaceCommand ==============================================

describe('buildRemoteCarapaceCommand', () => {
  it("git checkout 空词 → completer 单独 + current '' 占位", () => {
    expect(buildRemoteCarapaceCommand('git', ['checkout'], '')).toBe(
      "~/.local/bin/carapace 'git' export 'checkout' '' 2>/dev/null",
    );
  });

  it('正在输入的词作为最后一个参数', () => {
    expect(buildRemoteCarapaceCommand('git', ['checkout'], 'ma')).toBe(
      "~/.local/bin/carapace 'git' export 'checkout' 'ma' 2>/dev/null",
    );
  });

  it("tokens 含单引号 → 转义", () => {
    expect(buildRemoteCarapaceCommand("a'b", [], '')).toBe(
      `~/.local/bin/carapace 'a'\\''b' export '' 2>/dev/null`,
    );
  });

  it('cwd 传入 → 前缀 cd 且同样转义（exec 默认在 home，动态候选需正确目录）', () => {
    expect(buildRemoteCarapaceCommand('git', ['checkout'], 't', '/home/u/my repo')).toBe(
      "cd '/home/u/my repo' && ~/.local/bin/carapace 'git' export 'checkout' 't' 2>/dev/null",
    );
  });

  it('cwd 为 null/undefined → 不加 cd 前缀（行为与旧版一致）', () => {
    expect(buildRemoteCarapaceCommand('git', ['checkout'], '', null)).toBe(
      buildRemoteCarapaceCommand('git', ['checkout'], ''),
    );
  });
});

// === buildParamRequest =======================================================

describe('buildParamRequest', () => {
  it('普通行 → tokens 含命令名，current 为最后一个词', () => {
    expect(buildParamRequest('git checkout ma')).toEqual({
      cmd: 'git',
      tokens: ['git', 'checkout', 'ma'],
      current: 'ma',
    });
  });

  it('尾随空格 → current 为空串（正在输入新 token）', () => {
    expect(buildParamRequest('git checkout ')).toEqual({
      cmd: 'git',
      tokens: ['git', 'checkout'],
      current: '',
    });
  });

  it('sudo 前缀命令跳过（与 parseCommandLine 对齐）', () => {
    expect(buildParamRequest('sudo apt install -')).toEqual({
      cmd: 'apt',
      tokens: ['apt', 'install', '-'],
      current: '-',
    });
  });

  it('仅前缀命令 → cmd 为命令本体', () => {
    expect(buildParamRequest('sudo ')).toEqual({
      cmd: '',
      tokens: [],
      current: '',
    });
  });
});

// === mergeCandidates =========================================================

describe('mergeCandidates', () => {
  const fallback = (text: string): SuggestionResult => ({
    command: text,
    source: 'arg',
    kind: 'arg',
  });

  it('carapace 候选 → SuggestionResult（source/kind = arg）', () => {
    const merged = mergeCandidates(
      [{ value: 'main', description: 'branch' }],
      [],
    );
    expect(merged).toEqual([
      { command: 'main', source: 'arg', kind: 'arg', description: 'branch' },
    ]);
  });

  it('按 value 去重，carapace 优先', () => {
    const merged = mergeCandidates(
      [{ value: '-b', description: 'from carapace' }],
      [fallback('-b'), fallback('--bare')],
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]?.description).toBe('from carapace');
    expect(merged.map((m) => m.command)).toEqual(['-b', '--bare']);
  });

  it('空 value 候选被过滤', () => {
    expect(mergeCandidates([{ value: '', description: '' }], [fallback('x')])).toEqual([
      expect.objectContaining({ command: 'x' }),
    ]);
  });

  it('超过 8 条截断', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      value: `v${i}`,
      description: '',
    }));
    expect(mergeCandidates(many, [])).toHaveLength(8);
  });

  it('zhDescription 钩子中文优先，无中文回退 carapace 描述', () => {
    const merged = mergeCandidates(
      [
        { value: '-n', description: 'no headings' },
        { value: '--all', description: 'show all' },
      ],
      [],
      { zhDescription: (v) => (v === '-n' ? '不显示标题' : undefined) },
    );
    expect(merged[0]?.description).toBe('不显示标题');
    expect(merged[1]?.description).toBe('show all');
  });

  it('空描述 → description 省略（undefined）', () => {
    const merged = mergeCandidates([{ value: 'x', description: '' }], []);
    expect(merged[0]?.description).toBeUndefined();
  });
});

// === leaf cwd / ssh session 注册表 ==========================================

describe('leaf registry (setLeafCwd / setLeafSshSession)', () => {
  it('setLeafCwd 注册后 getLeafCwd 可读；null 注销', () => {
    setLeafCwd(9001, 'D:/repo');
    expect(getLeafCwd(9001)).toBe('D:/repo');
    setLeafCwd(9001, null);
    expect(getLeafCwd(9001)).toBeNull();
  });

  it('setLeafSshSession 带 remoteCwd getter → getLeafRemoteCwd 取最新值', () => {
    let cwd: string | null = '/home/u';
    setLeafSshSession(9002, 7, () => cwd);
    expect(getLeafSshSession(9002)).toBe(7);
    expect(getLeafRemoteCwd(9002)).toBe('/home/u');
    // getter 闭包读外部变量 —— 模拟 sshStore.currentPathBySession 更新
    cwd = '/home/u/project';
    expect(getLeafRemoteCwd(9002)).toBe('/home/u/project');
  });

  it('注销（null）同时清 session 与 remoteCwd', () => {
    setLeafSshSession(9003, 8, () => '/tmp');
    setLeafSshSession(9003, null);
    expect(getLeafSshSession(9003)).toBeNull();
    expect(getLeafRemoteCwd(9003)).toBeNull();
  });

  it('双参重载（不带 getter）→ getLeafRemoteCwd 为 null', () => {
    setLeafSshSession(9004, 9);
    expect(getLeafSshSession(9004)).toBe(9);
    expect(getLeafRemoteCwd(9004)).toBeNull();
    setLeafSshSession(9004, null);
  });
});

// === remoteCarapaceInstalled（检测 + 会话级缓存）=============================

describe('remoteCarapaceInstalled', () => {
  it('远端有 carapace（输出含标记）→ true', async () => {
    mockInvoke.mockResolvedValueOnce(sshResult(`${CARAPACE_YES_MARK}\n`));
    await expect(remoteCarapaceInstalled(42)).resolves.toBe(true);
    expect(mockInvoke).toHaveBeenCalledWith(
      'ssh_command',
      expect.objectContaining({ sessionId: 42, command: CARAPACE_CHECK_CMD }),
    );
  });

  it('结果进入会话级缓存：第二次调用不再 invoke', async () => {
    mockInvoke.mockResolvedValueOnce(sshResult(CARAPACE_YES_MARK));
    await remoteCarapaceInstalled(42);
    await remoteCarapaceInstalled(42);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('invalidateRemoteCarapaceCache 后重新检测', async () => {
    mockInvoke.mockResolvedValue(sshResult(CARAPACE_YES_MARK));
    await remoteCarapaceInstalled(42);
    invalidateRemoteCarapaceCache(42);
    await remoteCarapaceInstalled(42);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it('未安装（无标记输出）→ false 且缓存', async () => {
    mockInvoke.mockResolvedValue(sshResult('', 1));
    await expect(remoteCarapaceInstalled(42)).resolves.toBe(false);
    await remoteCarapaceInstalled(42);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('invoke 抛错 → false（静默，不抛给调用方）', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('session gone'));
    await expect(remoteCarapaceInstalled(42)).resolves.toBe(false);
  });
});

// === fetchRemoteCommands（二轮改进：远端命令全集，供命令模式过滤假候选）====

describe('fetchRemoteCommands', () => {
  beforeEach(() => {
    invalidateRemoteCommands(42);
  });

  it('成功拉取 → 按行 split 成 Set 并缓存', async () => {
    mockInvoke.mockResolvedValueOnce(
      sshResult('ls\ngit\nsystemctl\nip\ngit\n'),
    );
    const cmds = await fetchRemoteCommands(42);
    expect(cmds).not.toBeNull();
    expect(cmds!.has('ls')).toBe(true);
    expect(cmds!.has('systemctl')).toBe(true);
    expect(cmds!.size).toBe(4); // git 重复行去重
    expect(mockInvoke).toHaveBeenCalledWith(
      'ssh_command',
      expect.objectContaining({ sessionId: 42, command: REMOTE_COMMANDS_CMD }),
    );
    // 缓存命中：第二次不再 invoke
    await fetchRemoteCommands(42);
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('非零退出 → null 且不缓存（下次重试）', async () => {
    mockInvoke.mockResolvedValue(sshResult('', 1));
    await expect(fetchRemoteCommands(42)).resolves.toBeNull();
    expect(getCachedRemoteCommands(42)).toBeNull();
    await fetchRemoteCommands(42);
    expect(mockInvoke).toHaveBeenCalledTimes(2); // 未缓存 → 重试
  });

  it('输出为空（compgen 不存在的 sh 环境）→ null 且不缓存', async () => {
    mockInvoke.mockResolvedValue(sshResult(''));
    await expect(fetchRemoteCommands(42)).resolves.toBeNull();
    expect(getCachedRemoteCommands(42)).toBeNull();
  });

  it('invoke 抛错 → null（静默，不抛给调用方）', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('session gone'));
    await expect(fetchRemoteCommands(42)).resolves.toBeNull();
    expect(getCachedRemoteCommands(42)).toBeNull();
  });

  it('invalidateRemoteCommands 后重新拉取', async () => {
    mockInvoke.mockResolvedValue(sshResult('ls\n'));
    await fetchRemoteCommands(42);
    invalidateRemoteCommands(42);
    await fetchRemoteCommands(42);
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });
});

// === remoteParamComplete =====================================================

describe('remoteParamComplete', () => {
  it('远端输出 JSON → 解析为 SuggestionResult[]', async () => {
    mockInvoke.mockResolvedValueOnce(
      sshResult(
        JSON.stringify({
          values: [
            { value: 'main', description: 'branch' },
            { value: '-b' },
          ],
        }),
      ),
    );
    await expect(remoteParamComplete(42, 'git', ['checkout'], 'ma')).resolves.toEqual([
      { command: 'main', source: 'arg', kind: 'arg', description: 'branch' },
      { command: '-b', source: 'arg', kind: 'arg', description: undefined },
    ]);
  });

  it('命令带单引号转义传给 ssh_command', async () => {
    mockInvoke.mockResolvedValueOnce(sshResult(JSON.stringify({ values: [] })));
    await remoteParamComplete(42, 'git', ["a'b"], '');
    expect(mockInvoke).toHaveBeenCalledWith(
      'ssh_command',
      expect.objectContaining({
        timeout: 2,
        command: expect.stringContaining(`'a'\\''b'`),
      }),
    );
  });

  it('非零退出 → null', async () => {
    mockInvoke.mockResolvedValueOnce(sshResult('nope', 127));
    await expect(remoteParamComplete(42, 'git', [], '')).resolves.toBeNull();
  });

  it('ok=false（超时/链路异常）→ null', async () => {
    mockInvoke.mockResolvedValueOnce({ ok: false, output: '', stderr: 'timeout', exitCode: -1, duration: 2 });
    await expect(remoteParamComplete(42, 'git', [], '')).resolves.toBeNull();
  });

  it('空输出 → null', async () => {
    mockInvoke.mockResolvedValueOnce(sshResult(''));
    await expect(remoteParamComplete(42, 'git', [], '')).resolves.toBeNull();
  });

  it('invoke 抛错 → null（静默回退）', async () => {
    mockInvoke.mockRejectedValueOnce(new Error('boom'));
    await expect(remoteParamComplete(42, 'git', [], '')).resolves.toBeNull();
  });
});

// === installRemoteCarapace（顺序：mkdir → upload → chmod+verify）=============

describe('installRemoteCarapace', () => {
  /** 按 invoke 的命令名/内容分发 mock */
  function mockInstallFlow(over?: { mkdirFail?: boolean; verifyFail?: boolean }) {
    const calls: Array<{ cmd: string; args: unknown }> = [];
    mockInvoke.mockImplementation(async (cmd: string, args?: unknown) => {
      calls.push({ cmd, args });
      if (cmd === 'carapace_linux_path') return 'C:/pkg/carapace-linux-amd64';
      if (cmd === 'sftp_upload_file') return undefined;
      if (cmd === 'ssh_command') {
        const { command } = (args ?? {}) as { command: string };
        if (command.startsWith('mkdir -p')) {
          if (over?.mkdirFail) return sshResult('', 1);
          return sshResult('/root\n');
        }
        if (command.startsWith('chmod +x')) {
          if (over?.verifyFail) return sshResult('permission denied', 1);
          return sshResult('carapace version 0.7.0');
        }
      }
      throw new Error(`unexpected invoke: ${cmd}`);
    });
    return calls;
  }

  it('成功路径：mkdir → 取本地路径 → upload → chmod+verify，且 mkdir 在 upload 前', async () => {
    const stages: string[] = [];
    const calls = mockInstallFlow();
    await expect(
      installRemoteCarapace(42, (s) => stages.push(s)),
    ).resolves.toBe(true);

    const kinds = calls.map((c) => c.cmd);
    // 顺序断言：mkdir（ssh_command #1）在 sftp_upload_file 之前，chmod 验证在最后
    expect(kinds).toEqual([
      'ssh_command',
      'carapace_linux_path',
      'sftp_upload_file',
      'ssh_command',
    ]);
    // upload 参数：sessionId + localPath + 远端绝对路径（$HOME 展开，~ 不被 sftp 展开）
    const upload = calls[2] as { args: Record<string, unknown> };
    expect(upload.args).toEqual({
      sessionId: 42,
      localPath: 'C:/pkg/carapace-linux-amd64',
      remotePath: '/root/.local/bin/carapace',
    });
    // 进度回调完整走完
    expect(stages).toEqual(['preparing', 'uploading', 'configuring', 'done']);
  });

  it('mkdir 失败 → false 且不触发上传', async () => {
    const calls = mockInstallFlow({ mkdirFail: true });
    await expect(installRemoteCarapace(42)).resolves.toBe(false);
    expect(calls.map((c) => c.cmd)).not.toContain('sftp_upload_file');
  });

  it('chmod/verify 失败 → false', async () => {
    mockInstallFlow({ verifyFail: true });
    await expect(installRemoteCarapace(42)).resolves.toBe(false);
  });

  it('carapace_linux_path 抛错（后端未就绪）→ false 静默', async () => {
    mockInvoke.mockImplementation(async (cmd: string) => {
      if (cmd === 'ssh_command') return sshResult('/root\n');
      throw new Error('unknown command');
    });
    await expect(installRemoteCarapace(42)).resolves.toBe(false);
  });
});
