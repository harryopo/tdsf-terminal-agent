/**
 * command-tracker-addon.ts — OSC 633 命令追踪 (源自 electerm, MIT)
 * -----------------------------------------------------------------------------
 * 来源: electerm/src/client/components/terminal/command-tracker-addon.js
 * 适配: 纯 JavaScript 类, 零依赖改动, 仅加 TypeScript 类型注解
 *
 * OSC 633 协议 (Shell Integration):
 *   OSC 633 ; A            → Prompt 开始
 *   OSC 633 ; C            → 命令开始执行
 *   OSC 633 ; D ; <code>   → 命令执行完毕 (含退出码)
 *   OSC 633 ; E ; <cmd>    → 正在执行的命令行
 *   OSC 633 ; P ; Cwd=<p>  → 当前工作目录
 */
import type { Terminal, IDisposable } from '@xterm/xterm';

export interface CommandTrackerAddon {
  /** 注册命令执行回调 (收到 OSC 633;E 时触发) */
  onCommandExecuted(callback: (command: string) => void): void;
  /** 注册目录变更回调 (收到 OSC 633;P;Cwd= 时触发) */
  onCwdChanged(callback: (cwd: string) => void): void;
  activate(terminal: Terminal): void;
  dispose(): void;
  getCurrentCommand(): string;
  getLastExitCode(): number | null;
  getCwd(): string;
  hasShellIntegration(): boolean;
}

interface CommandTrackerAddonImpl extends CommandTrackerAddon {
  terminal: Terminal | null;
  currentCommand: string;
  executedCommand: string;
  lastExitCode: number | null;
  cwd: string;
  shellIntegrationActive: boolean;
  _disposables: IDisposable[];
  _onCommandExecuted: ((command: string) => void) | null;
  _onCwdChanged: ((cwd: string) => void) | null;
}

/**
 * CommandTrackerAddon — OSC 633 命令追踪 addon
 *
 * 通过解析 Shell Integration (OSC 633) 转义序列, 追踪:
 *   - 当前正在执行的命令
 *   - 上一条命令的退出码
 *   - 当前工作目录 (CWD)
 *
 * 使用方式:
 *   const tracker = new CommandTrackerAddon();
 *   tracker.activate(terminal);
 *   tracker.onCommandExecuted((cmd) => console.log('exec:', cmd));
 */
export class CommandTrackerAddon {
  constructor() {
    (this as unknown as CommandTrackerAddonImpl).terminal = null;
    (this as unknown as CommandTrackerAddonImpl)._disposables = [];
    (this as unknown as CommandTrackerAddonImpl).currentCommand = '';
    (this as unknown as CommandTrackerAddonImpl).executedCommand = '';
    (this as unknown as CommandTrackerAddonImpl).lastExitCode = null;
    (this as unknown as CommandTrackerAddonImpl).cwd = '';
    (this as unknown as CommandTrackerAddonImpl).shellIntegrationActive = false;
    (this as unknown as CommandTrackerAddonImpl)._onCommandExecuted = null;
    (this as unknown as CommandTrackerAddonImpl)._onCwdChanged = null;
  }

  onCommandExecuted(callback: (command: string) => void): void {
    (this as unknown as CommandTrackerAddonImpl)._onCommandExecuted = callback;
  }

  onCwdChanged(callback: (cwd: string) => void): void {
    (this as unknown as CommandTrackerAddonImpl)._onCwdChanged = callback;
  }

  activate(terminal: Terminal): void {
    const self = this as unknown as CommandTrackerAddonImpl;
    self.terminal = terminal;

    // 注册 OSC 633 处理器
    if (terminal.parser?.registerOscHandler) {
      const oscHandler = terminal.parser.registerOscHandler(633, (data: string) => {
        return self._handleOsc633(data);
      });
      self._disposables.push(oscHandler);
    }
  }

  dispose(): void {
    const self = this as unknown as CommandTrackerAddonImpl;
    self.terminal = null;
    if (self._disposables) {
      self._disposables.forEach((d: IDisposable) => d.dispose());
      self._disposables.length = 0;
    }
  }

  /** 处理 OSC 633 shell integration 序列 */
  private _handleOsc633(data: string): boolean {
    if (!data) return false;

    const self = this as unknown as CommandTrackerAddonImpl;
    const command = data.charAt(0);
    const args = data.length > 1 ? data.substring(2) : '';

    switch (command) {
      case 'A': // Prompt started
        self.shellIntegrationActive = true;
        self.currentCommand = '';
        return true;

      case 'C': // Command execution started
        return true;

      case 'D': { // Command finished
        if (args) {
          self.lastExitCode = parseInt(args, 10);
        } else {
          self.lastExitCode = null;
        }
        return true;
      }

      case 'E': { // Command line
        self.executedCommand = deserializeOscValue(args);
        self.currentCommand = self.executedCommand;
        if (self._onCommandExecuted && self.executedCommand) {
          self._onCommandExecuted(self.executedCommand);
        }
        return true;
      }

      case 'P': // Property (e.g., Cwd=<path>)
        handleProperty(self, args);
        return true;

      default:
        return false;
    }
  }

  getCurrentCommand(): string {
    const self = this as unknown as CommandTrackerAddonImpl;
    return self.executedCommand || self.currentCommand || '';
  }

  getLastExitCode(): number | null {
    return (this as unknown as CommandTrackerAddonImpl).lastExitCode;
  }

  getCwd(): string {
    return (this as unknown as CommandTrackerAddonImpl).cwd;
  }

  hasShellIntegration(): boolean {
    return (this as unknown as CommandTrackerAddonImpl).shellIntegrationActive;
  }
}

// ==== 私有辅助函数 (不挂类原型, 减少 this 绑定复杂度) ====

function deserializeOscValue(value: string): string {
  if (!value) return '';
  return value
    .replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\\/g, '\\');
}

function handleProperty(self: CommandTrackerAddonImpl, data: string): void {
  const eqIndex = data.indexOf('=');
  if (eqIndex === -1) return;

  const key = data.substring(0, eqIndex);
  const value = deserializeOscValue(data.substring(eqIndex + 1));

  switch (key) {
    case 'Cwd': {
      const oldCwd = self.cwd;
      self.cwd = value;
      if (self._onCwdChanged && oldCwd !== value) {
        self._onCwdChanged(value);
      }
      break;
    }
  }
}
