/**
 * use-ssh-completion.ts — SSH 终端实时命令预测 (TDSF 2026-08-09)
 * -----------------------------------------------------------------------------
 * 核心体验（类似 fish shell + IDE 自动提示）：
 *   1. 用户输入时自动弹出 4-5 条预测命令（每条带中文翻译）
 *   2. Tab = 远端原生补全（透传到 PTY，让 bash/zsh 自己处理）
 *   3. 右箭头 = 接受第一条预测（自动补全剩余部分）
 *   4. 上下键 = 在预测列表中选择
 *   5. 鼠标点击 = 选择某条预测
 *   6. Enter / Escape = 关闭弹窗
 *
 * 设计取舍：
 *   - 纯前端，不需要远端配合（延迟 0ms）
 *   - 数据源：command-dictionary.ts（180+ Linux 命令 + 中文翻译）
 *   - 输入含空格时不弹预测（已经在输参数了）
 *   - 只拦截右箭头和上下键，Tab 和其他键正常透传
 * -----------------------------------------------------------------------------
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Terminal as XTerm } from "@xterm/xterm";
import { predictCommands, type CommandDictEntry } from "./command-dictionary";

// ============================================================================
// 类型
// ============================================================================

export interface UseSshCompletionParams {
  /** xterm 实例 ref */
  readonly xtermRef: React.RefObject<XTerm | null>;
  /** 写入到 SSH 的回调 */
  readonly onWrite: (data: string) => void;
}

export interface PredictionPopupState {
  visible: boolean;
  items: CommandDictEntry[];
  selectedIndex: number;
  prefix: string;
}

// ============================================================================
// Hook
// ============================================================================

export function useSshCompletion({ xtermRef, onWrite }: UseSshCompletionParams) {
  const [popup, setPopup] = useState<PredictionPopupState>({
    visible: false,
    items: [],
    selectedIndex: 0,
    prefix: "",
  });
  const popupRef = useRef(popup);
  popupRef.current = popup;

  // 从 xterm buffer 提取当前行输入前缀
  const getCurrentPrefix = useCallback((): string => {
    const term = xtermRef.current;
    if (!term) return "";
    const buffer = term.buffer.active;
    const y = buffer.cursorY;
    const line = buffer.getLine(y);
    if (!line) return "";
    const text = line.translateToString(true);
    return text.slice(0, buffer.cursorX).trim();
  }, [xtermRef]);

  // 更新预测
  const updatePredictions = useCallback(() => {
    const prefix = getCurrentPrefix();
    // 空前缀或含空格 → 不弹预测
    if (!prefix || prefix.includes(" ")) {
      setPopup((s) => (s.visible ? { ...s, visible: false } : s));
      return;
    }
    const items = predictCommands(prefix, 5);
    if (items.length === 0) {
      setPopup((s) => (s.visible ? { ...s, visible: false } : s));
    } else {
      setPopup({ visible: true, items, selectedIndex: 0, prefix });
    }
  }, [getCurrentPrefix]);

  // 接受预测：写入补全的剩余部分
  const acceptPrediction = useCallback(
    (entry: CommandDictEntry) => {
      const prefix = getCurrentPrefix();
      const remaining = entry.command.slice(prefix.length);
      if (remaining) {
        onWrite(remaining);
      }
      setPopup((s) => ({ ...s, visible: false }));
    },
    [getCurrentPrefix, onWrite],
  );

  // 选择某条预测（鼠标点击或上下键 Enter）
  const selectPrediction = useCallback(
    (index: number) => {
      const current = popupRef.current;
      if (!current.visible || index < 0 || index >= current.items.length) return;
      acceptPrediction(current.items[index]);
    },
    [acceptPrediction],
  );

  // xterm 自定义键盘处理（返回 true = 透传，false = 拦截）
  const handleKeyEventHandler = useCallback(
    (event: KeyboardEvent): boolean => {
      const current = popupRef.current;

      // 右箭头 = 接受第一条预测（只在弹窗可见且光标在行尾时）
      if (event.key === "ArrowRight" && event.type === "keydown") {
        if (current.visible && current.items.length > 0) {
          // 检查光标是否在行尾
          const term = xtermRef.current;
          if (term) {
            const buffer = term.buffer.active;
            const line = buffer.getLine(buffer.cursorY);
            const fullLine = line?.translateToString(true) ?? "";
            const trimmed = fullLine.trimEnd();
            if (buffer.cursorX >= trimmed.length) {
              acceptPrediction(current.items[0]);
              return false; // 拦截
            }
          }
        }
        return true; // 透传
      }

      // 向下箭头 = 选择下一条预测
      if (event.key === "ArrowDown" && event.type === "keydown") {
        if (current.visible && current.items.length > 1) {
          event.preventDefault();
          setPopup((s) => ({
            ...s,
            selectedIndex: (s.selectedIndex + 1) % s.items.length,
          }));
          return false; // 拦截（不让光标在终端里下移）
        }
        return true;
      }

      // 向上箭头 = 选择上一条预测
      if (event.key === "ArrowUp" && event.type === "keydown") {
        if (current.visible && current.items.length > 1) {
          event.preventDefault();
          setPopup((s) => ({
            ...s,
            selectedIndex:
              (s.selectedIndex - 1 + s.items.length) % s.items.length,
          }));
          return false;
        }
        return true;
      }

      // Enter = 选择当前高亮项（如果有弹窗）
      if (event.key === "Enter" && event.type === "keydown") {
        if (current.visible && current.items.length > 0) {
          acceptPrediction(current.items[current.selectedIndex]);
          // 不拦截 Enter——让命令正常执行
        }
        setPopup((s) => ({ ...s, visible: false }));
        return true;
      }

      // Escape = 关闭弹窗
      if (event.key === "Escape" && event.type === "keydown") {
        setPopup((s) => (s.visible ? { ...s, visible: false } : s));
        return true;
      }

      // Tab = 透传（远端原生补全），关闭弹窗
      if (event.key === "Tab") {
        setPopup((s) => (s.visible ? { ...s, visible: false } : s));
        return true;
      }

      // 其他可打印字符 → 延迟更新预测（等 xterm 处理完字符后再读 buffer）
      if (event.type === "keydown" && event.key.length === 1) {
        setTimeout(() => updatePredictions(), 0);
      }

      // Backspace → 也延迟更新
      if (event.type === "keydown" && event.key === "Backspace") {
        setTimeout(() => updatePredictions(), 0);
      }

      return true; // 所有其他键透传
    },
    [xtermRef, acceptPrediction, updatePredictions],
  );

  // 鼠标点击选择
  const onPopupClick = useCallback(
    (index: number) => {
      selectPrediction(index);
    },
    [selectPrediction],
  );

  // 关闭弹窗
  const closePopup = useCallback(() => {
    setPopup((s) => (s.visible ? { ...s, visible: false } : s));
  }, []);

  // 当弹窗不可见时清理
  useEffect(() => {
    if (!popup.visible) return;
    // 5 秒后自动关闭（避免弹窗卡住）
    const timer = setTimeout(() => closePopup(), 5000);
    return () => clearTimeout(timer);
  }, [popup.visible, closePopup]);

  return {
    popup,
    handleKeyEventHandler,
    onPopupClick,
    closePopup,
    selectPrediction,
    updatePredictions,
  };
}
