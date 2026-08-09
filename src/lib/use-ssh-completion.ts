/**
 * use-ssh-completion.ts — SSH 终端命令补全 hook (TDSF 2026-08-09)
 * -----------------------------------------------------------------------------
 * 轻量版：复用 completion.ts 的 Trie+Frecency 引擎，
 * 但数据源用静态 Linux 常用命令表（不依赖 Rust 读 shell history）。
 *
 * SSH 场景下远端 shell 的原生 Tab 补全仍然可用（Tab 字符透传到 PTY），
 * 此 hook 提供额外的"前端侧命令建议"——按 Tab 时如果 xterm 有匹配的
 * 静态命令前缀，弹出候选列表；如果没有匹配，回退到默认行为（Tab 透传）。
 *
 * 使用方式（在 SshTerminalHost 里）：
 *   const { popup, handleKeyEventHandler, closePopup, selectCompletion } =
 *     useSshCompletion({ xtermRef, containerRef, onWrite: (d) => handle.write(d) });
 *   useEffect(() => {
 *     paneHandle.attachCustomKeyEventHandler(handleKeyEventHandler);
 *   }, [handleKeyEventHandler]);
 * -----------------------------------------------------------------------------
 */
import { useCallback, useRef, useState } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import { CompletionEngine, type CompletionItem } from "./completion";

// ============================================================================
// 常量
// ============================================================================

/** SSH 场景常用的 Linux 命令（运维 + 教学场景） */
const SSH_COMMANDS: string[] = [
  // 文件操作
  "ls", "ll", "la", "cp", "mv", "rm", "mkdir", "rmdir", "touch", "find",
  "ln", "stat", "file", "tree", "du", "df",
  // 文本处理
  "cat", "head", "tail", "less", "more", "grep", "sed", "awk", "sort",
  "uniq", "wc", "cut", "tr", "tee", "diff", "vim", "nano",
  // 系统信息
  "uname", "hostname", "uptime", "who", "whoami", "id", "date", "cal",
  "free", "top", "htop", "ps", "kill", "killall", "jobs", "bg", "fg",
  "nohup", "lsof", "ulimit",
  // 网络
  "ping", "curl", "wget", "ssh", "scp", "rsync", "netstat", "ss",
  "ifconfig", "ip", "dig", "nslookup", "traceroute", "tcpdump",
  "iptables", "firewall-cmd", "ufw",
  // 包管理
  "apt", "apt-get", "dpkg", "yum", "dnf", "rpm", "pip", "npm", "pnpm",
  // 服务管理
  "systemctl", "service", "journalctl", "docker", "kubectl",
  // 用户权限
  "sudo", "su", "chmod", "chown", "chgrp", "passwd", "useradd", "usermod",
  "userdel", "groupadd", "visudo",
  // 压缩
  "tar", "zip", "unzip", "gzip", "gunzip", "bzip2",
  // 目录导航
  "cd", "pwd", "pushd", "popd",
  // 其他
  "echo", "printf", "export", "source", "alias", "history", "man",
  "which", "whereis", "type", "env", "set", "crontab", "at",
  // 教学场景
  "bash", "sh", "python3", "git", "make", "gcc",
];

// ============================================================================
// 类型
// ============================================================================

export interface UseSshCompletionParams {
  readonly xtermRef: React.RefObject<XTerm | null>;
  readonly onWrite: (data: string) => void;
}

export interface SshCompletionPopupState {
  visible: boolean;
  items: CompletionItem[];
  prefix: string;
  cursorX: number;
  cursorY: number;
}

// ============================================================================
// Hook
// ============================================================================

export function useSshCompletion({
  xtermRef,
  onWrite,
}: UseSshCompletionParams) {
  const engineRef = useRef<CompletionEngine | null>(null);
  const [popup, setPopup] = useState<SshCompletionPopupState>({
    visible: false,
    items: [],
    prefix: "",
    cursorX: 0,
    cursorY: 0,
  });

  // 懒加载引擎（首次 Tab 触发）
  const ensureEngine = useCallback(() => {
    if (!engineRef.current) {
      engineRef.current = new CompletionEngine();
      // 注入静态命令列表
      for (const cmd of SSH_COMMANDS) {
        engineRef.current.addCommand(cmd);
      }
    }
    return engineRef.current;
  }, []);

  // 从 xterm buffer 提取当前行前缀
  const getCurrentPrefix = useCallback((): string => {
    const term = xtermRef.current;
    if (!term) return "";
    const buffer = term.buffer.active;
    const y = buffer.cursorY;
    const line = buffer.getLine(y);
    if (!line) return "";
    const text = line.translateToString(true);
    // 取光标前的文本（光标位置 = cursorX）
    return text.slice(0, buffer.cursorX).trim();
  }, [xtermRef]);

  // 关闭弹窗
  const closePopup = useCallback(() => {
    setPopup((s) => (s.visible ? { ...s, visible: false } : s));
  }, []);

  // 选择补全项
  const selectCompletion = useCallback(
    (item: CompletionItem) => {
      const term = xtermRef.current;
      if (!term) return;
      const prefix = getCurrentPrefix();
      // 计算需要写入的字符（补全后 - 已输入前缀）
      const remaining = item.command.slice(prefix.length);
      if (remaining) {
        onWrite(remaining);
      }
      closePopup();
    },
    [xtermRef, getCurrentPrefix, onWrite, closePopup],
  );

  // xterm CustomKeyEventHandler
  const handleKeyEventHandler = useCallback(
    (_event: KeyboardEvent): boolean => {
      const term = xtermRef.current;
      if (!term) return true;

      // Tab 键处理
      if (_event.key === "Tab" && !_event.ctrlKey && !_event.metaKey) {
        // 只在 keydown 时处理（避免重复触发）
        if (_event.type !== "keydown") return true;

        const prefix = getCurrentPrefix();
        // 空前缀或含空格（已经在输参数了）→ 回退到远端 Tab
        if (!prefix || prefix.includes(" ")) {
          closePopup();
          return true; // 让 Tab 透传到 PTY
        }

        const engine = ensureEngine();
        const result = engine.complete(prefix, 10);
        const matches = result.items;

        if (matches.length === 0) {
          closePopup();
          return true; // 无匹配 → Tab 透传
        }

        if (matches.length === 1) {
          // 唯一匹配 → 直接补全
          const remaining = matches[0].command.slice(prefix.length);
          if (remaining) onWrite(remaining);
          closePopup();
          return false; // 阻止 Tab 透传
        }

        // 多个匹配 → 弹窗
        const buffer = term.buffer.active;
        setPopup({
          visible: true,
          items: matches,
          prefix,
          cursorX: buffer.cursorX,
          cursorY: buffer.cursorY,
        });
        return false; // 阻止 Tab 透传
      }

      // Escape / Enter → 关闭弹窗
      if (_event.key === "Escape" || _event.key === "Enter") {
        if (_event.type === "keydown") closePopup();
      }

      return true;
    },
    [xtermRef, getCurrentPrefix, ensureEngine, onWrite, closePopup],
  );

  return {
    popup,
    handleKeyEventHandler,
    closePopup,
    selectCompletion,
  };
}
