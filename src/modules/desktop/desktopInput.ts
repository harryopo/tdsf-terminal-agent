// 远程桌面输入辅助：把浏览器按键/鼠标事件映射为 RDP 语义，便于单测。

/** React MouseEvent.button → RDP button 编号（1 左 / 2 右 / 3 中 / 0 无按钮）。 */
export function mapButton(button: number): number {
  if (button === 0) return 1;
  if (button === 2) return 2;
  return 3;
}

/** 失焦时需要释放的修饰键与鼠标按钮。 */
export const RELEASE_KEYS = [0x1d, 0x2a, 0x38] as const; // Control / Shift / Alt
export const RELEASE_BUTTONS = [1, 2, 3] as const; // 左 / 右 / 中

export interface OwnerGeneration {
  owner: string;
  generation: number;
}

/** 组装带 owner/generation 的 desktop_input 参数，防止跨窗口/旧代次误操作。 */
export function withOwner(
  sessionId: number,
  owner: string,
  generation: number,
  event: Record<string, unknown>,
): OwnerGeneration & { sessionId: number; event: Record<string, unknown> } {
  return { sessionId, owner, generation, event };
}