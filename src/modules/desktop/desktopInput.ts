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

export interface DesktopSize {
  width: number;
  height: number;
}

export function fitDesktopSize(remote: DesktopSize, viewport: DesktopSize): DesktopSize {
  if (remote.width <= 0 || remote.height <= 0) return { width: 0, height: 0 };
  if (viewport.width <= 0 || viewport.height <= 0) return remote;
  const scale = Math.min(viewport.width / remote.width, viewport.height / remote.height);
  return {
    width: Math.max(1, Math.floor(remote.width * scale)),
    height: Math.max(1, Math.floor(remote.height * scale)),
  };
}

export interface ScancodeMapping {
  code: number;
  extended: boolean;
}

const SCANCODE_BY_CODE: Record<string, ScancodeMapping> = {
  Escape: { code: 0x01, extended: false },
  F1: { code: 0x3b, extended: false },
  F2: { code: 0x3c, extended: false },
  F3: { code: 0x3d, extended: false },
  F4: { code: 0x3e, extended: false },
  F5: { code: 0x3f, extended: false },
  F6: { code: 0x40, extended: false },
  F7: { code: 0x41, extended: false },
  F8: { code: 0x42, extended: false },
  F9: { code: 0x43, extended: false },
  F10: { code: 0x44, extended: false },
  F11: { code: 0x57, extended: false },
  F12: { code: 0x58, extended: false },
  PrintScreen: { code: 0x37, extended: true },
  ScrollLock: { code: 0x46, extended: false },
  Pause: { code: 0x45, extended: false },
  Backquote: { code: 0x29, extended: false },
  Digit1: { code: 0x02, extended: false },
  Digit2: { code: 0x03, extended: false },
  Digit3: { code: 0x04, extended: false },
  Digit4: { code: 0x05, extended: false },
  Digit5: { code: 0x06, extended: false },
  Digit6: { code: 0x07, extended: false },
  Digit7: { code: 0x08, extended: false },
  Digit8: { code: 0x09, extended: false },
  Digit9: { code: 0x0a, extended: false },
  Digit0: { code: 0x0b, extended: false },
  Minus: { code: 0x0c, extended: false },
  Equal: { code: 0x0d, extended: false },
  Backspace: { code: 0x0e, extended: false },
  Tab: { code: 0x0f, extended: false },
  KeyQ: { code: 0x10, extended: false },
  KeyW: { code: 0x11, extended: false },
  KeyE: { code: 0x12, extended: false },
  KeyR: { code: 0x13, extended: false },
  KeyT: { code: 0x14, extended: false },
  KeyY: { code: 0x15, extended: false },
  KeyU: { code: 0x16, extended: false },
  KeyI: { code: 0x17, extended: false },
  KeyO: { code: 0x18, extended: false },
  KeyP: { code: 0x19, extended: false },
  BracketLeft: { code: 0x1a, extended: false },
  BracketRight: { code: 0x1b, extended: false },
  Enter: { code: 0x1c, extended: false },
  ControlLeft: { code: 0x1d, extended: false },
  KeyA: { code: 0x1e, extended: false },
  KeyS: { code: 0x1f, extended: false },
  KeyD: { code: 0x20, extended: false },
  KeyF: { code: 0x21, extended: false },
  KeyG: { code: 0x22, extended: false },
  KeyH: { code: 0x23, extended: false },
  KeyJ: { code: 0x24, extended: false },
  KeyK: { code: 0x25, extended: false },
  KeyL: { code: 0x26, extended: false },
  Semicolon: { code: 0x27, extended: false },
  Quote: { code: 0x28, extended: false },
  Backslash: { code: 0x2b, extended: false },
  ShiftLeft: { code: 0x2a, extended: false },
  IntlBackslash: { code: 0x56, extended: false },
  KeyZ: { code: 0x2c, extended: false },
  KeyX: { code: 0x2d, extended: false },
  KeyC: { code: 0x2e, extended: false },
  KeyV: { code: 0x2f, extended: false },
  KeyB: { code: 0x30, extended: false },
  KeyN: { code: 0x31, extended: false },
  KeyM: { code: 0x32, extended: false },
  Comma: { code: 0x33, extended: false },
  Period: { code: 0x34, extended: false },
  Slash: { code: 0x35, extended: false },
  ShiftRight: { code: 0x36, extended: false },
  ControlRight: { code: 0x1d, extended: true },
  AltLeft: { code: 0x38, extended: false },
  AltRight: { code: 0x38, extended: true },
  Space: { code: 0x39, extended: false },
  CapsLock: { code: 0x3a, extended: false },
  NumLock: { code: 0x45, extended: false },
  Numpad0: { code: 0x52, extended: false },
  Numpad1: { code: 0x4f, extended: false },
  Numpad2: { code: 0x50, extended: false },
  Numpad3: { code: 0x51, extended: false },
  Numpad4: { code: 0x4b, extended: false },
  Numpad5: { code: 0x4c, extended: false },
  Numpad6: { code: 0x4d, extended: false },
  Numpad7: { code: 0x47, extended: false },
  Numpad8: { code: 0x48, extended: false },
  Numpad9: { code: 0x49, extended: false },
  NumpadDecimal: { code: 0x53, extended: false },
  NumpadAdd: { code: 0x4e, extended: false },
  NumpadSubtract: { code: 0x4a, extended: false },
  NumpadMultiply: { code: 0x37, extended: false },
  NumpadDivide: { code: 0x35, extended: true },
  NumpadEnter: { code: 0x1c, extended: true },
  Insert: { code: 0x52, extended: true },
  Delete: { code: 0x53, extended: true },
  Home: { code: 0x47, extended: true },
  End: { code: 0x4f, extended: true },
  PageUp: { code: 0x49, extended: true },
  PageDown: { code: 0x51, extended: true },
  ArrowUp: { code: 0x48, extended: true },
  ArrowDown: { code: 0x50, extended: true },
  ArrowLeft: { code: 0x4b, extended: true },
  ArrowRight: { code: 0x4d, extended: true },
  MetaLeft: { code: 0x5b, extended: true },
  MetaRight: { code: 0x5c, extended: true },
  ContextMenu: { code: 0x5d, extended: true },
};

export function mapScancode(code: string): ScancodeMapping | null {
  return SCANCODE_BY_CODE[code] ?? null;
}

export interface WheelStep {
  rotation: number;
  remainder: number;
}

export function accumulateWheel(remainder: number, delta: number, deltaMode: number): WheelStep {
  const multiplier = deltaMode === 1 ? 16 : deltaMode === 2 ? 720 : 1;
  const total = remainder + delta * multiplier;
  const rotation = Math.max(-256, Math.min(255, Math.trunc(-total)));
  return {
    rotation,
    remainder: rotation === -256 || rotation === 255 ? 0 : total + rotation,
  };
}

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
): Record<string, unknown> & OwnerGeneration & { sessionId: number; event: Record<string, unknown> } {
  return { sessionId, owner, generation, event };
}