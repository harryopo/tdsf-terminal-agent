/**
 * shell-history.ts — Shell 历史解析 (T-P2-10.2)
 * -----------------------------------------------------------------------------
 * 职责:
 *   1. 解析 bash/zsh/fish/powershell history 文件内容为命令列表
 *   2. 通过 Tauri invoke 调用 Rust 后端读取 shell history 文件
 *
 * 各 shell history 格式:
 *   - bash:    每行一条命令, 无时间戳
 *               Example: `ls -la\n`
 *   - zsh:     每行 `: <timestamp>:<duration>;<command>` 格式
 *               Example: `: 1700000000:0;ls -la\n`
 *   - fish:    多行格式, `- cmd: <command>` + `  when: <timestamp>`
 *               Example:
 *               ```
 *               - cmd: ls -la
 *                 when: 1700000000
 *               ```
 *   - powershell: 每行一条命令 (PSReadLine ConsoleHost_history.txt)
 *
 * 设计要点:
 *   - 纯函数, 输入 string 输出 string[], 无副作用
 *   - 容错: 单行解析失败不影响其他行
 *   - 去重策略由调用方决定 (CompletionEngine.loadHistory 会累加 useCount)
 * -----------------------------------------------------------------------------
 */
import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './tauri';

// ============================================================================
// 类型定义
// ============================================================================

/** Shell 类型 */
export type ShellType = 'bash' | 'zsh' | 'fish' | 'powershell' | 'unknown';

/** Rust 后端返回的 shell history 信息 */
export interface ShellHistoryInfo {
  /** 当前检测到的 shell 类型 */
  shellType: ShellType;
  /** history 文件路径 (绝对路径) */
  historyPath: string;
  /** 解析后的命令列表 (已按时间顺序, 旧的在前) */
  commands: string[];
}

// ============================================================================
// bash history 解析
// ============================================================================

/**
 * 解析 bash history 文件内容
 * - 每行一条命令, 无时间戳
 * - 支持多行命令 (bash history 默认不跨行, 但 `\` 续行会被合并)
 * - 跳过空行和注释行 (以 # 开头且非 shebang)
 */
export function parseBashHistory(content: string): string[] {
  const commands: string[] = [];
  const lines = content.split('\n');
  let pending = '';

  for (const line of lines) {
    // bash history 续行处理: 行尾 `\` 表示续行
    if (line.endsWith('\\')) {
      pending += line.slice(0, -1) + ' ';
      continue;
    }
    const full = (pending + line).trim();
    pending = '';
    if (full.length === 0) continue;
    // 跳过纯注释行 (bash history 一般不含, 但防御性处理)
    if (full.startsWith('#') && !full.startsWith('#!')) continue;
    commands.push(full);
  }
  // 处理末尾未闭合的续行
  if (pending.trim().length > 0) {
    commands.push(pending.trim());
  }
  return commands;
}

// ============================================================================
// zsh history 解析
// ============================================================================

/**
 * 解析 zsh history 文件内容
 * - 格式: `: <timestamp>:<duration>;<command>`
 * - 旧格式可能无时间戳, 直接是命令
 *
 * Example:
 *   `: 1700000000:0;ls -la`
 *   `: 1700000000:0;git commit -m "test"`
 */
export function parseZshHistory(content: string): string[] {
  const commands: string[] = [];
  const lines = content.split('\n');

  // 正则匹配: `: <timestamp>:<duration>;<command>`
  // - timestamp: 数字 (秒级 epoch)
  // - duration: 数字 (秒)
  // - command: 任意字符 (含分号、空格)
  const zshLineRe = /^:\s*(\d+):\d+;(.*)$/;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    if (trimmed.length === 0) continue;

    const match = zshLineRe.exec(trimmed);
    if (match) {
      const cmd = match[2]!.trim();
      if (cmd.length > 0) commands.push(cmd);
      continue;
    }

    // 旧格式 (无时间戳): 直接当作命令
    // 但要排除明显的元数据行
    if (trimmed.startsWith('#')) continue;
    const cleaned = trimmed.trim();
    if (cleaned.length > 0 && !cleaned.startsWith(': ')) {
      commands.push(cleaned);
    }
  }
  return commands;
}

// ============================================================================
// fish history 解析
// ============================================================================

/**
 * 解析 fish history 文件内容
 * - YAML 格式, 每个 entry:
 *   ```
 *   - cmd: <command>
 *     when: <timestamp>
 *   ```
 * - 不依赖 YAML 解析器, 用简单状态机解析
 */
export function parseFishHistory(content: string): string[] {
  const commands: string[] = [];
  const lines = content.split('\n');

  // 匹配 `- cmd: <command>` (允许 cmd 后有空格)
  const cmdRe = /^-\s+cmd:\s*(.*)$/;
  // 匹配 `  when: <timestamp>` (缩进 + when: + 数字)
  // 注: when 行不影响命令提取, 这里只是验证格式正确

  for (const line of lines) {
    const match = cmdRe.exec(line);
    if (match) {
      const cmd = match[1]!.trim();
      if (cmd.length > 0) commands.push(cmd);
    }
    // when: 行和 paths: 行自动跳过 (不匹配 cmdRe)
  }
  return commands;
}

// ============================================================================
// PowerShell history 解析
// ============================================================================

/**
 * 解析 PowerShell PSReadLine history 文件内容
 * - 文件: ~/.config/powershell/PSReadLine/ConsoleHost_history.txt
 * - 每行一条命令 (UTF-8)
 * - 跨行命令用反斜杠续行 (类似 bash)
 */
export function parsePowershellHistory(content: string): string[] {
  // PowerShell PSReadLine 与 bash 一样是单行命令, 复用解析逻辑
  // 区别: PowerShell 注释符是 #
  return parseBashHistory(content);
}

// ============================================================================
// 按类型分发解析
// ============================================================================

/** 按 shell 类型选择对应的解析器 */
export function parseShellHistory(
  content: string,
  shellType: ShellType,
): string[] {
  switch (shellType) {
    case 'bash':
      return parseBashHistory(content);
    case 'zsh':
      return parseZshHistory(content);
    case 'fish':
      return parseFishHistory(content);
    case 'powershell':
      return parsePowershellHistory(content);
    case 'unknown':
    default:
      // 未知 shell, 退化为 bash 风格解析 (最常见)
      return parseBashHistory(content);
  }
}

// ============================================================================
// Tauri invoke: 从 Rust 后端加载 shell history
// ============================================================================

/**
 * 通过 Tauri invoke 调用 Rust 后端读取 shell history
 *
 * Rust 命令: read_shell_history
 * 返回: ShellHistoryInfo (shell 类型 + 路径 + 命令列表)
 *
 * 浏览器预览模式 (非 Tauri): 返回空结果, 不抛错
 */
export async function loadHistoryFromRust(): Promise<ShellHistoryInfo> {
  // 浏览器预览模式: Tauri 内部对象不存在, 返回空结果
  if (!isTauri()) {
    return {
      shellType: 'unknown',
      historyPath: '',
      commands: [],
    };
  }

  try {
    return await invoke<ShellHistoryInfo>('read_shell_history');
  } catch (err) {
    // 读取失败 (文件不存在 / 权限不足) 不应阻塞前端
    console.warn(
      '[shell-history] read_shell_history failed:',
      err instanceof Error ? err.message : String(err),
    );
    return {
      shellType: 'unknown',
      historyPath: '',
      commands: [],
    };
  }
}
