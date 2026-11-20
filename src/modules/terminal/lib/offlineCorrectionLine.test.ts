import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelAutoCorrection } from "./nextCommandInjection";
import {
  completionKeyHandler,
  getCompletionLine,
  getCompletionLineState,
  initCompletionInjection,
  noteTerminalInput,
  setLeafEnvironment,
  writeCompletionLine,
} from "./completionInjection";

const key = (value: string): KeyboardEvent =>
  ({
    type: "keydown",
    key: value,
    keyCode: value.charCodeAt(0),
    isComposing: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    preventDefault: vi.fn(),
  }) as unknown as KeyboardEvent;

afterEach(() => {
  cancelAutoCorrection();
  vi.useRealTimers();
});

describe("offline correction line injection", () => {
  it("只替换当前可见输入行，不追加换行、不执行", () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    initCompletionInjection(() => null, (_leafId, data) => {
      writes.push(data);
    });
    const leaf = 1301;
    setLeafEnvironment(leaf, "linux");

    for (const char of "grpe") {
      completionKeyHandler(leaf, key(char));
    }
    expect(getCompletionLine(leaf)).toBe("grpe");

    expect(writeCompletionLine(leaf, "grep")).toBe(true);
    expect(writes).toEqual(["\b\b\b\bgrep"]);
    expect(writes[0]).not.toMatch(/[\r\n]/);
    expect(getCompletionLine(leaf)).toBe("grep");
  });
});

// CORR-02 C2：方向键/编辑键使内存缓冲与真实输入行失配后，绝不允许把候选
// 写进未知光标位置（ROOT 反例：ArrowLeft 后 writeCompletionLine 仍返回 true）。
describe("CORR-02 C2 未知输入行拒绝回填", () => {
  function freshLeaf(leaf: number): string[] {
    const writes: string[] = [];
    initCompletionInjection(() => null, (leafId, data) => {
      writes.push(data);
      void leafId;
    });
    setLeafEnvironment(leaf, "linux");
    return writes;
  }

  const cases: { name: string; press: (leaf: number) => void }[] = [
    { name: "ArrowLeft", press: (leaf) => completionKeyHandler(leaf, key("ArrowLeft")) },
    { name: "Home", press: (leaf) => completionKeyHandler(leaf, key("Home")) },
    { name: "Delete", press: (leaf) => completionKeyHandler(leaf, key("Delete")) },
    {
      name: "Ctrl+V 粘贴",
      press: (leaf) =>
        completionKeyHandler(leaf, {
          ...key("v"),
          key: "v",
          ctrlKey: true,
        } as KeyboardEvent),
    },
    {
      name: "Ctrl+T 换位",
      press: (leaf) =>
        completionKeyHandler(leaf, {
          ...key("t"),
          key: "t",
          ctrlKey: true,
        } as KeyboardEvent),
    },
  ];

  for (const item of cases) {
    it(`${item.name} 后 writeCompletionLine 返回 false 且不写入`, () => {
      vi.useFakeTimers();
      const leaf = 1320 + cases.indexOf(item);
      const writes = freshLeaf(leaf);
      for (const char of "grpe") completionKeyHandler(leaf, key(char));
      item.press(leaf);
      expect(writeCompletionLine(leaf, "grep")).toBe(false);
      expect(writes).toEqual([]);
    });
  }

  it("Enter/Ctrl+C 之后是已知空行，可安全回填", () => {
    vi.useFakeTimers();
    const leaf = 1339;
    const writes = freshLeaf(leaf);
    for (const char of "grpe") completionKeyHandler(leaf, key(char));
    completionKeyHandler(leaf, key("ArrowLeft"));
    expect(writeCompletionLine(leaf, "grep")).toBe(false);
    completionKeyHandler(leaf, key("Enter"));
    expect(writeCompletionLine(leaf, "grep")).toBe(true);
    // 回车后是空提示符，不需要退格清行。
    expect(writes).toEqual(["grep"]);
  });
});

// CORR-02 C2：按键追踪覆盖不到的输入（term.onData 回执）。
describe("CORR-02 C2 终端输入回执三态", () => {
  it("单字符/Insert 不改变已知状态；粘贴、IME 多字节、控制序列转未知", () => {
    vi.useFakeTimers();
    initCompletionInjection(() => null, () => {});
    const leaf = 1341;
    setLeafEnvironment(leaf, "linux");

    for (const char of "grpe") completionKeyHandler(leaf, key(char));
    noteTerminalInput(leaf, "x");
    expect(getCompletionLineState(leaf)).toBe("known-text");
    noteTerminalInput(leaf, "\x1b[2~"); // Insert
    expect(getCompletionLineState(leaf)).toBe("known-text");

    noteTerminalInput(leaf, "粘贴文本"); // 多字节/多字符
    expect(getCompletionLineState(leaf)).toBe("unknown");
    expect(writeCompletionLine(leaf, "grep")).toBe(false);
  });
});
