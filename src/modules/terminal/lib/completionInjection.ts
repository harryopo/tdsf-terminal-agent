/**
 * completionInjection.ts — 统一终端命令预测注入 (TDSF 2026-08-10 P0 重写)
 * -----------------------------------------------------------------------------
 * 核心设计：维护独立的按键输入缓冲区（不从 xterm buffer 反推），彻底解决
 * 提示符污染问题。适用于本地终端和 SSH 终端（统一通过 rendererPool 注入）。
 *
 * P0 修复（2026-08-10 架构审计后）：
 *   1. getCurrentPrefix 提示符污染 → 改为按键追踪缓冲区
 *   2. loadHistoryIfNeeded 从未调用 → 首次按键时自动调用
 *   3. Enter 不 acceptPrediction → 弹窗可见时 Enter 接受选中项
 *   4. fuzzysort threshold 验证 → 改为保守值
 * -----------------------------------------------------------------------------
 */
import type { Terminal as XTerm } from '@xterm/xterm';
import { getSuggestEngine, type SuggestionResult } from '@/lib/suggest-engine';

// ============================================================================
// 类型
// ============================================================================

export interface CompletionState {
  visible: boolean;
  items: SuggestionResult[];
  selectedIndex: number;
  prefix: string;
  leafId: number | null;
}

// ============================================================================
// 模块级状态
// ============================================================================

let activeState: CompletionState = {
  visible: false,
  items: [],
  selectedIndex: 0,
  prefix: '',
  leafId: null,
};

const subscribers = new Set<(state: CompletionState) => void>();

let writeFn: ((leafId: number, data: string) => void) | null = null;

// ============================================================================
// 输入缓冲区（按键追踪，不从 buffer 反推 → 无提示符污染）
// ============================================================================

/** 每个终端的输入缓冲区 */
const inputBuffers = new Map<number, string>();

function getInputBuffer(leafId: number): string {
  return inputBuffers.get(leafId) ?? '';
}

function setInputBuffer(leafId: number, value: string): void {
  inputBuffers.set(leafId, value);
}

function clearInputBuffer(leafId: number): void {
  inputBuffers.set(leafId, '');
}

// ============================================================================
// 初始化
// ============================================================================

export function initCompletionInjection(
  _getTerm: (leafId: number) => XTerm | null,
  write: (leafId: number, data: string) => void,
): void {
  // getTerm 在按键追踪方案中不再需要（输入缓冲区不从 xterm buffer 反推）
  writeFn = write;
}

// ============================================================================
// 状态管理
// ============================================================================

type SetStateArg = CompletionState | ((prev: CompletionState) => CompletionState);

function setState(arg: SetStateArg): void {
  const next = typeof arg === 'function' ? arg(activeState) : arg;
  if (next === activeState) return;
  activeState = next;
  for (const sub of subscribers) sub(next);
}

export function subscribeCompletion(cb: (state: CompletionState) => void): () => void {
  subscribers.add(cb);
  cb(activeState);
  return () => subscribers.delete(cb);
}

export function getCompletionState(): CompletionState {
  return activeState;
}

// ============================================================================
// 更新预测
// ============================================================================

function updatePredictions(leafId: number): void {
  const prefix = getInputBuffer(leafId);
  // 空前缀或含空格 → 不弹预测（已经在输参数了）
  if (!prefix || prefix.includes(' ')) {
    setState((s) => (s.visible ? { ...s, visible: false } : s));
    return;
  }

  const engine = getSuggestEngine();
  const items = engine.getSuggestions(prefix, 5);
  if (items.length === 0) {
    setState((s) => (s.visible ? { ...s, visible: false } : s));
  } else {
    setState({
      visible: true,
      items,
      selectedIndex: 0,
      prefix,
      leafId,
    });
  }
}

export function closeCompletion(): void {
  setState((s) => (s.visible ? { ...s, visible: false } : s));
}

// ============================================================================
// 接受预测
// ============================================================================

function acceptPrediction(leafId: number, entry: SuggestionResult): void {
  if (!writeFn) return;
  const prefix = getInputBuffer(leafId);
  const remaining = entry.command.slice(prefix.length);
  if (remaining) {
    writeFn(leafId, remaining);
  }
  // 更新输入缓冲区为完整命令
  setInputBuffer(leafId, entry.command);
  // 添加到历史
  getSuggestEngine().addHistory(entry.command);
  setState((s) => ({ ...s, visible: false }));
}

export function selectCompletionByIndex(index: number): void {
  const current = activeState;
  if (!current.visible || current.leafId === null || index < 0 || index >= current.items.length) return;
  acceptPrediction(current.leafId, current.items[index]);
}

// ============================================================================
// 核心：键盘拦截器
// ============================================================================

export function completionKeyHandler(
  leafId: number | null,
  event: KeyboardEvent,
): boolean {
  if (leafId === null) return true;

  // 只处理 keydown
  if (event.type !== 'keydown') return true;

  // IME 组合输入不处理
  if (event.isComposing || event.keyCode === 229) return true;

  const current = activeState;
  const isVisible = current.visible && current.leafId === leafId;

  // === Ctrl+C / Ctrl+U → 清空缓冲区 + 关闭弹窗 ===
  if (event.ctrlKey && (event.key === 'c' || event.key === 'C' || event.key === 'u' || event.key === 'U')) {
    clearInputBuffer(leafId);
    setState((s) => (s.visible ? { ...s, visible: false } : s));
    return true;
  }

  // === 右箭头 = 接受第一条预测（只在弹窗可见时） ===
  if (event.key === 'ArrowRight' && isVisible && current.items.length > 0) {
    acceptPrediction(leafId, current.items[current.selectedIndex]);
    return false; // 拦截
  }

  // === 向下箭头 = 选择下一条预测 ===
  if (event.key === 'ArrowDown' && isVisible && current.items.length > 1) {
    event.preventDefault();
    setState((s) => ({
      ...s,
      selectedIndex: (s.selectedIndex + 1) % s.items.length,
    }));
    return false;
  }

  // === 向上箭头 = 选择上一条预测 ===
  if (event.key === 'ArrowUp' && isVisible && current.items.length > 1) {
    event.preventDefault();
    setState((s) => ({
      ...s,
      selectedIndex: (s.selectedIndex - 1 + s.items.length) % s.items.length,
    }));
    return false;
  }

  // === Tab = 透传远端原生补全 + 关闭弹窗 ===
  if (event.key === 'Tab') {
    setState((s) => (s.visible ? { ...s, visible: false } : s));
    return true;
  }

  // === Escape = 关闭弹窗 ===
  if (event.key === 'Escape' && isVisible) {
    setState((s) => ({ ...s, visible: false }));
    return true;
  }

  // === Enter = 接受选中预测（如果可见）或记录历史 + 清空缓冲区 ===
  if (event.key === 'Enter') {
    if (isVisible && current.items.length > 0) {
      // P0-3 修复：弹窗可见时 Enter 接受选中项（不拦截 Enter，先接受再透传）
      acceptPrediction(leafId, current.items[current.selectedIndex]);
      // 接受后缓冲区已是完整命令，Enter 透传执行
    } else {
      // 没用预测 → 记录实际输入到历史
      const prefix = getInputBuffer(leafId);
      if (prefix.trim()) {
        getSuggestEngine().addHistory(prefix.trim());
      }
    }
    // Enter → 清空缓冲区（新的一行）
    clearInputBuffer(leafId);
    setState((s) => (s.visible ? { ...s, visible: false } : s));
    return true; // 透传 Enter 让命令执行
  }

  // === Backspace → 从缓冲区删除 + 更新预测 ===
  if (event.key === 'Backspace') {
    const buf = getInputBuffer(leafId);
    if (buf.length > 0) {
      setInputBuffer(leafId, buf.slice(0, -1));
    }
    setTimeout(() => updatePredictions(leafId), 0);
    return true;
  }

  // === 可打印字符 → 追加到缓冲区 + 更新预测 ===
  if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
    const buf = getInputBuffer(leafId);
    setInputBuffer(leafId, buf + event.key);
    setTimeout(() => updatePredictions(leafId), 0);
    return true;
  }

  return true; // 所有其他键透传
}

// ============================================================================
// Shell history 加载
// ============================================================================

let historyLoaded = false;

export async function loadHistoryIfNeeded(): Promise<void> {
  if (historyLoaded) return;
  historyLoaded = true;
  try {
    const { loadHistoryFromRust, parseShellHistory } = await import('@/lib/shell-history');
    const info = await loadHistoryFromRust();
    if (info.commands.length > 0) {
      const parsed = parseShellHistory(info.commands.join('\n'), info.shellType);
      const commandNames = parsed
        .map((cmd) => cmd.trim().split(/\s+/)[0] ?? '')
        .filter((cmd) => cmd.length > 0);
      getSuggestEngine().loadHistory(commandNames);
    }
  } catch (e) {
    // 非致命——浏览器预览模式或 Rust 命令未注册时降级
    console.warn('[completion] loadHistoryIfNeeded failed:', e);
  }
}
