/**
 * use-completion.ts — 终端补全集成 hook (T-P2-10.4)
 * -----------------------------------------------------------------------------
 * 职责:
 *   1. 懒加载 CompletionEngine (首次 Tab 触发时加载 shell history)
 *   2. 提供 xterm CustomKeyEventHandler: 拦截 Tab 键触发补全
 *   3. 解析当前光标行输入, 提取待补全前缀
 *   4. 弹窗 state 管理 (visible / items / position)
 *   5. 选择补全项时计算需写入 xterm 的字符 (完整命令 - 已输入前缀)
 *
 * 使用方式:
 *   ```tsx
 *   const xtermRef = useRef<XTerm>(null);
 *   const { popup, closePopup, selectCompletion, handleKeyEventHandler } =
 *     useCompletion({ xtermRef, containerRef, onWrite: (data) => pty.write(data) });
 *
 *   useEffect(() => {
 *     xtermRef.current?.attachCustomKeyEventHandler(handleKeyEventHandler);
 *   }, [handleKeyEventHandler]);
 *
 *   return (
 *     <div ref={containerRef}>
 *       <XTerm ref={xtermRef} />
 *       {popup.visible && <CompletionPopup {...popup} />}
 *     </div>
 *   );
 *   ```
 *
 * 设计取舍:
 *   - shell history 通过 Tauri invoke 异步加载, 首次 Tab 触发 (懒加载)
 *   - 加载完成后再次触发补全 (避免用户首次按 Tab 无响应)
 *   - 弹窗位置基于 xterm buffer.cursorX/cursorY + 单元格尺寸估算
 * -----------------------------------------------------------------------------
 */
import { useCallback, useRef, useState } from 'react';
import type { Terminal as XTerm } from '@xterm/xterm';
import { CompletionEngine, type CompletionItem } from './completion';
import { loadHistoryFromRust, parseShellHistory } from './shell-history';

// ============================================================================
// 类型定义
// ============================================================================

export interface UseCompletionParams {
  /** xterm 实例 ref (通过 ref 读取最新实例) */
  readonly xtermRef: React.RefObject<XTerm | null>;
  /** 终端容器 DOM ref (用于弹窗相对定位 + 视窗边界检查) */
  readonly containerRef: React.RefObject<HTMLDivElement | null>;
  /** 写入到 PTY/SSH 的回调 (补全确认时调用) */
  readonly onWrite: (data: string) => void;
  /** 命令执行后回调 (用于更新 useCount, 可选) */
  readonly onCommandExecuted?: (command: string) => void;
}

export interface CompletionPopupState {
  /** 是否显示 */
  visible: boolean;
  /** 候选列表 (Frecency 排序) */
  items: CompletionItem[];
  /** 用户输入的前缀 */
  prefix: string;
  /** 弹窗位置 (相对容器, px) */
  position: { x: number; y: number };
}

export interface UseCompletionResult {
  /** 弹窗 state (供 CompletionPopup 渲染) */
  popup: CompletionPopupState;
  /** 关闭弹窗 */
  closePopup: () => void;
  /** 选择补全项 (写入 xterm 并关闭弹窗) */
  selectCompletion: (command: string) => void;
  /**
   * xterm CustomKeyEventHandler
   * - 返回 true: 让 xterm 继续处理该键
   * - 返回 false: 阻止 xterm 默认行为
   */
  handleKeyEventHandler: (event: KeyboardEvent) => boolean;
}

// ============================================================================
// 常量
// ============================================================================

/** 弹窗最大候选数 */
const POPUP_LIMIT = 8;

/** xterm 单元格尺寸估算 (px, 仅用于弹窗定位, 不要求精确) */
const CELL_WIDTH = 7.2;
const CELL_HEIGHT = 21;

// ============================================================================
// 解析当前光标行前缀
// ============================================================================

/**
 * 从 xterm 当前光标位置解析"待补全的前缀"
 *
 * 规则:
 *   - 取当前行从行首到光标位置的字符串
 *   - 找最后一个空白/管道符/分号/重定向符后的部分作为前缀
 *   - 如果光标在行首或前一个字符是空白, 返回空前缀 (不触发补全)
 *
 * @returns { prefix: string, lineStart: number }
 *   - prefix: 待补全的前缀 (已 trim)
 *   - lineStart: 前缀在当前行的起始列 (用于回退删除)
 */
function extractPrefixAtCursor(
  xterm: XTerm,
): { prefix: string; lineStartCol: number } {
  const buffer = xterm.buffer.active;
  const cy = buffer.cursorY;
  const cx = buffer.cursorX;
  const line = buffer.getLine(cy);
  if (!line) return { prefix: '', lineStartCol: cx };

  // 从行首到光标位置的字符串
  const lineText = line.translateToString(true, 0, cx);

  // 从光标往前找最后一个"分隔符" (空格 / | / ; / & / > / <)
  // 分隔符后的部分即为待补全前缀
  // 注: 字符类 [] 内的 | 不需要转义
  const separators = /\s|[|;&<>]/;
  let startCol = 0;
  for (let i = lineText.length - 1; i >= 0; i--) {
    const ch = lineText[i]!;
    if (separators.test(ch)) {
      startCol = i + 1;
      break;
    }
  }

  const prefix = lineText.slice(startCol).trim();
  // 起始列 = 行内偏移 + startCol (这里 startCol 是字符串偏移, 与列偏移大致一致)
  return { prefix, lineStartCol: startCol };
}

// ============================================================================
// hook 实现
// ============================================================================

export function useCompletion(
  params: UseCompletionParams,
): UseCompletionResult {
  const { xtermRef, containerRef, onWrite, onCommandExecuted } = params;

  const [popup, setPopup] = useState<CompletionPopupState>({
    visible: false,
    items: [],
    prefix: '',
    position: { x: 0, y: 0 },
  });

  const engineRef = useRef<CompletionEngine | null>(null);
  const loadingRef = useRef(false);

  // === 懒加载 CompletionEngine + shell history ===
  const ensureEngineLoaded = useCallback(async (): Promise<CompletionEngine> => {
    if (engineRef.current) return engineRef.current;
    if (loadingRef.current) {
      // 等待其他加载请求完成 (简单轮询)
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (engineRef.current) return engineRef.current;
    }
    loadingRef.current = true;

    const engine = new CompletionEngine();
    try {
      const info = await loadHistoryFromRust();
      if (info.commands.length > 0) {
        const parsed = parseShellHistory(
          // Rust 端返回的是原始行, 用 \n 重新拼接后整体解析
          // (parseShellHistory 内部会按 \n 分割)
          info.commands.join('\n'),
          info.shellType,
        );
        engine.loadHistory(parsed);
      }
    } catch (err) {
      console.warn(
        '[use-completion] load shell history failed:',
        err instanceof Error ? err.message : String(err),
      );
    }

    engineRef.current = engine;
    loadingRef.current = false;
    return engine;
  }, []);

  // === 关闭弹窗 ===
  const closePopup = useCallback(() => {
    setPopup((prev) => (prev.visible ? { ...prev, visible: false } : prev));
  }, []);

  // === 选择补全项: 写入剩余部分到 xterm ===
  const selectCompletion = useCallback(
    (command: string) => {
      const xterm = xtermRef.current;
      if (!xterm) return;

      // 计算已输入的前缀 (基于当前光标位置)
      const { prefix } = extractPrefixAtCursor(xterm);

      // 写入剩余部分 (完整命令 - 已输入前缀)
      const remaining = command.slice(prefix.length);
      if (remaining.length > 0) {
        onWrite(remaining);
      }

      // 更新使用统计
      const engine = engineRef.current;
      if (engine) {
        engine.updateUsage(command);
        onCommandExecuted?.(command);
      }

      // 关闭弹窗
      setPopup((prev) => ({ ...prev, visible: false }));
    },
    [xtermRef, onWrite, onCommandExecuted],
  );

  // === 触发补全 (Tab 按下时调用) ===
  const triggerCompletion = useCallback(async (): Promise<boolean> => {
    const xterm = xtermRef.current;
    const container = containerRef.current;
    if (!xterm || !container) return false;

    const { prefix } = extractPrefixAtCursor(xterm);
    // 空前缀不触发 (避免在空白行弹窗)
    if (prefix.length === 0) return false;

    const engine = await ensureEngineLoaded();
    const result = engine.complete(prefix, POPUP_LIMIT);
    if (result.items.length === 0) {
      // 无候选: 关闭已显示的弹窗, 让 Tab 透传到 PTY
      setPopup((prev) =>
        prev.visible ? { ...prev, visible: false } : prev,
      );
      return false;
    }

    // 仅一个候选: 直接补全, 不弹窗 (类似 bash 的 Tab 行为)
    if (result.items.length === 1) {
      const cmd = result.items[0]!.command;
      const remaining = cmd.slice(prefix.length);
      if (remaining.length > 0) {
        onWrite(remaining);
      }
      engine.updateUsage(cmd);
      onCommandExecuted?.(cmd);
      setPopup((prev) => ({ ...prev, visible: false }));
      return true;
    }

    // 多个候选: 显示弹窗
    // 估算弹窗位置 (光标右下方, 但不超过容器边界)
    const buffer = xterm.buffer.active;
    const cursorX = buffer.cursorX;
    const cursorY = buffer.cursorY;
    const popupX = cursorX * CELL_WIDTH;
    const popupY = (cursorY + 1) * CELL_HEIGHT;

    // 边界检查: 弹窗宽度约 300px, 如果右边溢出则左移
    const containerWidth = container.clientWidth;
    const adjustedX = popupX + 300 > containerWidth
      ? Math.max(0, containerWidth - 320)
      : popupX;

    setPopup({
      visible: true,
      items: result.items,
      prefix: result.prefix,
      position: { x: adjustedX, y: popupY },
    });
    return true;
  }, [xtermRef, containerRef, ensureEngineLoaded, onWrite, onCommandExecuted]);

  // === xterm CustomKeyEventHandler ===
  // 注: 此函数会被 xterm 在每次 keydown 时调用
  // state 通过闭包捕获, 但因为是 useCallback 重新创建, 闭包是最新的
  const handleKeyEventHandler = useCallback(
    (event: KeyboardEvent): boolean => {
      // 仅处理 Tab 键 (key === 'Tab' 或 keyCode === 9)
      if (event.key !== 'Tab' && event.keyCode !== 9) {
        // 弹窗显示时, 其他键透传 (CompletionPopup 自己监听 document)
        return true;
      }

      // Tab 按下时触发补全 (避免 keyup 重复触发)
      if (event.type !== 'keydown') return true;

      // 异步触发, 但同步返回 false 阻止 xterm 把 Tab 透传到 PTY
      // (Tab 在终端会触发 tab 字符 \t, 我们要避免它写入)
      void triggerCompletion();

      // 始终阻止 xterm 处理 Tab (避免写入 \t)
      // 补全失败时让 PTY 自己处理 (但 xterm 默认行为就是写 \t, 与 PTY 无关)
      // 改进: 仅当弹窗已显示时阻止, 否则让 Tab 透传 (bash 自动补全)
      // 但这样首次 Tab 会先写 \t 再触发补全, 体验差
      // 折中: 始终阻止 xterm 默认 Tab 行为, triggerCompletion 内部决定是否补全
      return false;
    },
    [triggerCompletion],
  );

  return {
    popup,
    closePopup,
    selectCompletion,
    handleKeyEventHandler,
  };
}
