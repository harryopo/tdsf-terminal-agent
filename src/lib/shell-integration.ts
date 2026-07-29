/**
 * shell-integration.ts — Shell 集成脚本 (源自 electerm, MIT)
 * -----------------------------------------------------------------------------
 * 来源: electerm/src/client/components/terminal/shell.js
 * 适配: 移除 runCmd 依赖, 纯客户端脚本注入, 仅用于本地 PTY
 *
 * 作用: 向 shell (bash/zsh/fish/sh) 注入 OSC 633 序列,
 *       使终端能追踪命令执行、退出码、当前目录
 *
 * OSC 633 协议:
 *   OSC 633 ; A            → Prompt 开始
 *   OSC 633 ; C            → 命令执行开始
 *   OSC 633 ; D ; <code>   → 命令完成 (退出码)
 *   OSC 633 ; E ; <cmd>    → 命令内容
 *   OSC 633 ; P ; Cwd=<p>  → 当前目录
 */

type ShellType = 'bash' | 'zsh' | 'fish' | 'sh';

/**
 * Bash 内联集成脚本 (一行, 分号连接)
 * 通过 trap DEBUG + PROMPT_COMMAND 注入 OSC 633
 */
function getBashIntegration(): string {
  return [
    'if [[ $- == *i* ]] && [[ -z "${ELECTERM_SHELL_INTEGRATION:-}" ]]',
    'then export ELECTERM_SHELL_INTEGRATION=1',
    '__e_esc() { local v="$1"; v="${v//\\\\/\\\\\\\\}"; v="${v//;/\\\\x3b}"; printf \'%s\' "$v"; }',
    '__e_pre() { [[ "$BASH_COMMAND" == "$PROMPT_COMMAND" ]] && return; [[ "$BASH_COMMAND" == "__e_"* ]] && return; [[ "${__e_in:-0}" == "0" ]] && { __e_in=1; printf \'\\e]633;E;%s\\a\\e]633;C\\a\' "$(__e_esc "$BASH_COMMAND")"; }; }',
    '__e_cmd() { local c="$?"; [[ "${__e_in:-0}" == "1" ]] && { printf \'\\e]633;D;%s\\a\' "$c"; __e_in=0; }; printf \'\\e]633;P;Cwd=%s\\a\\e]633;A\\a\' "$(__e_esc "$PWD")"; return "$c"; }',
    'trap \'__e_pre\' DEBUG',
    'PROMPT_COMMAND="__e_cmd${PROMPT_COMMAND:+; $PROMPT_COMMAND}"',
    'fi',
  ].join('; ');
}

/**
 * Zsh 内联集成脚本 (一行, 分号连接)
 * 通过 precmd/preexec hooks 注入 OSC 633
 */
function getZshIntegration(): string {
  return [
    'if [[ -o interactive ]] && [[ -z "${ELECTERM_SHELL_INTEGRATION:-}" ]]',
    'then export ELECTERM_SHELL_INTEGRATION=1',
    '__e_esc() { local v="$1"; v="${v//\\\\/\\\\\\\\}"; v="${v//;/\\\\x3b}"; builtin printf \'%s\' "$v"; }',
    '__e_preexec() { __e_cmd="$1"; builtin printf \'\\e]633;E;%s\\a\\e]633;C\\a\' "$(__e_esc "$1")"; }',
    '__e_precmd() { local c="$?"; [[ -n "$__e_cmd" ]] && builtin printf \'\\e]633;D;%s\\a\' "$c"; __e_cmd=""; builtin printf \'\\e]633;P;Cwd=%s\\a\\e]633;A\\a\' "$(__e_esc "$PWD")"; }',
    'autoload -Uz add-zsh-hook',
    'add-zsh-hook precmd __e_precmd',
    'add-zsh-hook preexec __e_preexec',
    'fi',
  ].join('; ');
}

/**
 * Fish 内联集成脚本 (一行, 分号连接)
 * 通过 fish_prompt / fish_preexec / fish_postexec 事件注入 OSC 633
 */
function getFishIntegration(): string {
  return [
    'if status is-interactive; and not set -q ELECTERM_SHELL_INTEGRATION',
    'set -g ELECTERM_SHELL_INTEGRATION 1',
    'function __e_esc; echo $argv | string replace -a \'\\\\\' \'\\\\\\\\\' | string replace -a \';\' \'\\\\x3b\'; end',
    'function __e_prompt --on-event fish_prompt; printf \'\\e]633;A\\a\\e]633;P;Cwd=%s\\a\' (__e_esc "$PWD"); end',
    'function __e_preexec --on-event fish_preexec; printf \'\\e]633;E;%s\\a\\e]633;C\\a\' (__e_esc "$argv"); end',
    'function __e_postexec --on-event fish_postexec; printf \'\\e]633;D;%s\\a\' $status; end',
    'end',
  ].join('; ');
}

/**
 * POSIX sh/ash 内联集成脚本 (一行, 分号连接)
 * 通过 PS1 注入 OSC 633 (sh 无 PROMPT_COMMAND)
 */
function getShIntegration(): string {
  return [
    'if [ -z "$ELECTERM_SHELL_INTEGRATION" ]',
    'then export ELECTERM_SHELL_INTEGRATION=1',
    '__e_esc() { printf "%s" "$1" | sed "s/\\\\/\\\\\\\\/g; s/;/\\\\x3b/g"; }',
    'export PS1="\\e]633;P;Cwd=$(__e_esc "$PWD")\\a\\e]633;A\\a${PS1:-# }"',
    'fi',
  ].join('; ');
}

/** 从 shell 路径字符串检测 shell 类型 */
export function detectShellType(shellStr: string): ShellType {
  if (shellStr.includes('bash')) return 'bash';
  if (shellStr.includes('zsh')) return 'zsh';
  if (shellStr.includes('fish')) return 'fish';
  return 'sh';
}

/** 获取指定 shell 的内联集成脚本 */
function getInlineShellIntegration(shellType: ShellType): string {
  switch (shellType) {
    case 'bash': return getBashIntegration();
    case 'zsh': return getZshIntegration();
    case 'fish': return getFishIntegration();
    default: return getShIntegration();
  }
}

/**
 * 包装静默执行命令
 * - 前面空格: 不写入 shell 历史
 * - eval + 单引号转义: 确保单行正确执行
 * - 2>/dev/null: 丢弃标准错误输出
 */
export function wrapSilent(cmd: string): string {
  const escaped = cmd.replace(/'/g, "'\\''");
  return ` eval '${escaped}' 2>/dev/null\r`;
}

/**
 * 获取完整的 shell 集成命令 (可直接发送到终端)
 *
 * 用法:
 *   const cmd = getShellIntegrationCommand('bash');
 *   pty.write(cmd);  // 发送到 PTY
 */
export function getShellIntegrationCommand(shellType: ShellType = 'bash'): string {
  const cmd = getInlineShellIntegration(shellType);
  return wrapSilent(cmd);
}
