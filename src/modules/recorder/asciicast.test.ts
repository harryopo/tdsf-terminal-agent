import { describe, expect, it } from "vitest";
import {
  AsciicastRecorder,
  castFileName,
} from "./asciicast";

type FakeTerm = {
  write: (data: string) => void;
  cols: number;
  rows: number;
};

function fakeTerm(): FakeTerm {
  return { write: () => {}, cols: 80, rows: 24 };
}

describe("AsciicastRecorder", () => {
  it("录制输出并序列化为 v2 格式", () => {
    const term = fakeTerm();
    const rec = new AsciicastRecorder();
    rec.attach(term);
    term.write("hello");
    term.write(" world");
    const cast = rec.stop(80, 24);
    const lines = cast.split("\n");
    const header = JSON.parse(lines[0]);
    expect(header.version).toBe(2);
    expect(header.width).toBe(80);
    const events = lines.slice(1).map((l) => JSON.parse(l));
    expect(events).toHaveLength(2);
    expect(events[0][1]).toBe("o");
    expect(events[0][2]).toBe("hello");
    expect(events[1][2]).toBe(" world");
    expect(events[0][0]).toBeLessThanOrEqual(events[1][0]);
  });

  it("连续相同输出合并为单事件", () => {
    const term = fakeTerm();
    const rec = new AsciicastRecorder();
    rec.attach(term);
    term.write("aaaa");
    term.write("aaaa");
    const cast = rec.stop(80, 24);
    const events = cast
      .split("\n")
      .slice(1)
      .map((l) => JSON.parse(l));
    expect(events).toHaveLength(1);
    expect(events[0][2]).toBe("aaaa");
  });

  it("detach 恢复后 write 正常可用（不泄漏 wrap）", () => {
    const term = fakeTerm();
    const rec = new AsciicastRecorder();
    rec.attach(term);
    rec.stop(80, 24);
    // 恢复后直接写入不抛错（wrap 已移除，无记录副作用）
    expect(() => term.write("after")).not.toThrow();
    // 再次 attach 不会叠加录制（旧实例已 detach）
    const rec2 = new AsciicastRecorder();
    rec2.attach(term);
    term.write("x");
    const cast = rec2.stop(80, 24);
    const events = cast
      .split("\n")
      .slice(1)
      .map((l) => JSON.parse(l));
    expect(events).toHaveLength(1);
  });

  it("attach 幂等：同实例重复挂载不双录", () => {
    const term = fakeTerm();
    const rec = new AsciicastRecorder();
    rec.attach(term);
    rec.attach(term); // 幂等
    term.write("x");
    const cast = rec.stop(80, 24);
    const events = cast
      .split("\n")
      .slice(1)
      .map((l) => JSON.parse(l));
    expect(events).toHaveLength(1);
  });

  it("未录制时 stop 输出仅 header", () => {
    const rec = new AsciicastRecorder();
    const cast = rec.stop(80, 24);
    expect(cast.split("\n")).toHaveLength(1);
  });

  it("stats 统计事件数与字节数", () => {
    const term = fakeTerm();
    const rec = new AsciicastRecorder();
    rec.attach(term);
    term.write("abc");
    term.write("def");
    const s = rec.stats;
    expect(s.events).toBe(2);
    expect(s.bytes).toBe(6);
  });
});

describe("castFileName", () => {
  it("生成带时间戳的文件名", () => {
    const name = castFileName();
    expect(name).toMatch(/^tdsf-recording-\d{8}-\d{6}\.cast$/);
  });
});
