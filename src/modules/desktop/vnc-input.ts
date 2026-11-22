export interface VncKey {
  keysym: number;
  code: string;
}

const XK = {
  BackSpace: 0xff08,
  Tab: 0xff09,
  Return: 0xff0d,
  Escape: 0xff1b,
  Home: 0xff50,
  Left: 0xff51,
  Up: 0xff52,
  Right: 0xff53,
  Down: 0xff54,
  PageUp: 0xff55,
  PageDown: 0xff56,
  End: 0xff57,
  Insert: 0xff63,
  Delete: 0xffff,
  F1: 0xffbe,
  NumLock: 0xff7f,
  ScrollLock: 0xff14,
  CapsLock: 0xffe5,
  ShiftLeft: 0xffe1,
  ShiftRight: 0xffe2,
  ControlLeft: 0xffe3,
  ControlRight: 0xffe4,
  AltLeft: 0xffe9,
  AltRight: 0xffea,
  MetaLeft: 0xffeb,
  MetaRight: 0xffec,
} as const;

const SPECIAL_KEYSYMS: Record<string, number> = {
  Backspace: XK.BackSpace,
  Tab: XK.Tab,
  Enter: XK.Return,
  NumpadEnter: XK.Return,
  Escape: XK.Escape,
  Home: XK.Home,
  ArrowLeft: XK.Left,
  ArrowUp: XK.Up,
  ArrowRight: XK.Right,
  ArrowDown: XK.Down,
  PageUp: XK.PageUp,
  PageDown: XK.PageDown,
  End: XK.End,
  Insert: XK.Insert,
  Delete: XK.Delete,
  NumLock: XK.NumLock,
  ScrollLock: XK.ScrollLock,
  CapsLock: XK.CapsLock,
  ShiftLeft: XK.ShiftLeft,
  ShiftRight: XK.ShiftRight,
  ControlLeft: XK.ControlLeft,
  ControlRight: XK.ControlRight,
  AltLeft: XK.AltLeft,
  AltRight: XK.AltRight,
  MetaLeft: XK.MetaLeft,
  MetaRight: XK.MetaRight,
};

for (let index = 0; index < 12; index += 1) {
  SPECIAL_KEYSYMS[`F${index + 1}`] = XK.F1 + index;
}

export function unicodeKeysym(character: string): number | null {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) return null;
  return codePoint <= 0xff ? codePoint : 0x01000000 | codePoint;
}

export function vncKeyForKeyboardEvent(
  event: KeyboardEvent,
  composing: boolean,
): VncKey | null {
  if (composing) return null;
  const producesText = event.key.length === 1 || event.key === "Dead";
  const hasCommandModifier = event.ctrlKey || event.altKey || event.metaKey;
  if (
    producesText &&
    (!hasCommandModifier || event.getModifierState("AltGraph"))
  ) {
    return null;
  }

  const special = SPECIAL_KEYSYMS[event.code];
  const keysym =
    special ?? (event.key.length === 1 ? unicodeKeysym(event.key) : null);
  if (keysym === null) return null;
  return { keysym, code: event.code };
}