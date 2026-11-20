import { describe, expect, it } from "vitest";
import { mapButton, RELEASE_BUTTONS, RELEASE_KEYS, withOwner } from "./desktopInput";

describe("desktopInput", () => {
  it("mapButton 把 React 的左/中/右键映射为 RDP 语义", () => {
    expect(mapButton(0)).toBe(1);
    expect(mapButton(1)).toBe(3);
    expect(mapButton(2)).toBe(2);
    expect(mapButton(7)).toBe(3);
  });

  it("mouseup 保留 button 身份，不随 event.buttons 变 0 而丢失", () => {
    const event = { kind: "mouse", x: 10, y: 20, button: mapButton(0), down: false };
    expect(event.button).toBe(1);
    expect(event.down).toBe(false);
  });

  it("withOwner 强制 owner/generation 身份", () => {
    const params = withOwner(7, "desktop-dialog", 3, { kind: "key", code: 0x1c, pressed: false });
    expect(params).toMatchObject({
      sessionId: 7,
      owner: "desktop-dialog",
      generation: 3,
      event: { kind: "key", code: 0x1c, pressed: false },
    });
  });

  it("失焦释放包含修饰键与三个鼠标按钮", () => {
    expect(RELEASE_KEYS).toContain(0x1d);
    expect(RELEASE_KEYS).toContain(0x2a);
    expect(RELEASE_KEYS).toContain(0x38);
    expect(RELEASE_BUTTONS).toEqual([1, 2, 3]);
  });
});