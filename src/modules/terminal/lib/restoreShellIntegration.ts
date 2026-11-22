import type { Terminal } from "@xterm/xterm";
import { parseShellReceipt, type ShellReceipt, type SshTerminalContext } from "./remoteShellIntegration";

export function restoreShellIntegration({
  term, context, write, isCurrent, signal,
}: {
  term: Terminal;
  context: SshTerminalContext;
  write: (data: string) => boolean | void | Promise<void>;
  isCurrent: () => boolean;
  signal?: AbortSignal;
}): Promise<ShellReceipt> {
  const connection = context.connectionId;
  const path = `/tmp/tdsf-osc7-${connection}.hooks.bash`;
  if (!/^[0-9a-f]{32}$/.test(connection) || context.bashHooksPath !== path) {
    return Promise.reject(new Error("当前连接没有可验证的 Bash 集成文件。"));
  }
  if (!isCurrent() || signal?.aborted) {
    return Promise.reject(new Error("当前终端已变化，恢复请求已取消。"));
  }
  const request = crypto.randomUUID().replaceAll("-", "");
  const success = `P;TdsfRestore=${connection};${request};`;
  const failure = `P;TdsfRestoreFailed=${connection};${request};`;
  // Load only this connection's existing file. No rc, PS1, EXIT trap or stdin reset.
  const command = [
    `if [ -n "\${BASH_VERSION:-}" ] && [ -r '${path}' ]; then`,
    `if [ -z "$(trap -p DEBUG)" ] && ! shopt -q extdebug 2>/dev/null; then`,
    `source '${path}' --tdsf-debug-unclaimed; else source '${path}'; fi &&`,
    `if [ "\${__TDSF_OSC133_GUARD:-}" = 1 ] &&`,
    `[ "\${__TDSF_CONNECTION_CONTEXT:-}" = '${connection}' ] &&`,
    `[ "$(type -t _tdsf_precmd)" = function ]; then`,
    `printf '\\033]633;${success}%s\\007' "$__TDSF_SHELL_INSTANCE";`,
    `else printf '\\033]633;${failure}failed\\007'; fi || printf '\\033]633;${failure}failed\\007';`,
    `else printf '\\033]633;${failure}unavailable\\007'; fi\r`,
  ].join(" ");

  return new Promise((resolve, reject) => {
    let finished = false;
    let shell: string | null = null;
    const finish = (error: Error | null, receipt?: ShellReceipt) => {
      if (finished) return;
      finished = true;
      listener.dispose();
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else if (receipt) resolve(receipt);
    };
    const abort = () => finish(new Error(
      "恢复等待已取消；已经送入终端的命令不会被中断或自动重试。",
    ));
    const listener = term.parser.registerOscHandler(633, (data) => {
      if (!isCurrent()) {
        finish(new Error("当前终端或连接已变化，恢复请求已取消。"));
        return false;
      }
      if (data.startsWith(failure)) {
        finish(new Error("未确认恢复：请确认同一服务器的 Bash 提示符及临时集成文件可读。"));
      } else if (data.startsWith(success)) {
        const instance = data.slice(success.length);
        if (/^\d+-\d+-\d+$/.test(instance)) shell = instance;
      } else if (shell) {
        const receipt = parseShellReceipt(data);
        if (receipt?.connectionId === connection && receipt.shell === shell) {
          finish(null, receipt);
        }
      }
      return false;
    });
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => finish(new Error(
      "12 秒内未收到匹配的终端回执，恢复未确认。请查看终端；不会自动重试。",
    )), 12_000);
    try {
      const result = write(command);
      if (result === false) finish(new Error("命令未送入当前终端，恢复未确认。"));
      else void Promise.resolve(result).catch((error: unknown) => finish(
        error instanceof Error ? error : new Error("终端写入失败，恢复未确认。"),
      ));
    } catch (error) {
      finish(error instanceof Error ? error : new Error("终端写入失败，恢复未确认。"));
    }
  });
}
