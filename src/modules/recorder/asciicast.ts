/**
 * asciicast v2 会话录制器（P1-v5-6）
 *
 * 挂载到 xterm Terminal 实例的 write 方法，记录终端输出流 +
 * 时间戳，停止后序列化为 asciicast v2 格式（header + events）。
 * 最小可用版：录制当前活动终端（本地/SSH 均可，统一经 rendererPool）。
 */
/** 录制只依赖 write 方法（结构性类型，兼容 xterm Terminal 与测试替身） */
export type RecordableTerminal = {
  write(data: string): void;
};

export type CastEvent = [number, string, string];

export type CastHeader = {
  version: 2;
  width: number;
  height: number;
  timestamp: number;
  env?: Record<string, string>;
  title?: string;
};

export class AsciicastRecorder {
  private events: CastEvent[] = [];
  private startedAt = 0;
  private wrapped: RecordableTerminal | null = null;
  private originalWrite: RecordableTerminal["write"] | null = null;
  private recorded = 0;

  get isRecording(): boolean {
    return this.wrapped !== null;
  }

  get eventCount(): number {
    return this.events.length;
  }

  /** 挂载到终端实例（幂等：已挂载则忽略） */
  attach(term: RecordableTerminal, title?: string): void {
    if (this.wrapped === term) return;
    this.detach();
    this.wrapped = term;
    this.startedAt = Date.now();
    this.events = [];
    this.recorded = 0;
    this.title = title;
    this.originalWrite = term.write.bind(term);
    term.write = ((data: string) => {
      const now = Date.now();
      const t = (now - this.startedAt) / 1000;
      if (this.events.length > 0) {
        const last = this.events[this.events.length - 1];
        if (last[2] === data) {
          last[0] = t; // 合并连续相同输出（更新末次时间戳）
          this.recorded += data.length;
          return this.originalWrite!(data);
        }
      }
      this.events.push([t, "o", data]);
      this.recorded += data.length;
      return this.originalWrite!(data);
    }) as RecordableTerminal["write"];
  }

  private title?: string;

  detach(): void {
    if (this.wrapped && this.originalWrite) {
      this.wrapped.write = this.originalWrite;
    }
    this.wrapped = null;
    this.originalWrite = null;
  }

  /** 停止并序列化为 asciicast v2 JSON 文本 */
  stop(width: number, height: number): string {
    this.detach();
    const header: CastHeader = {
      version: 2,
      width,
      height,
      timestamp: Math.floor(this.startedAt / 1000),
      env: { TERM: "xterm-256color", SHELL: "/bin/sh" },
      title: this.title,
    };
    const body = this.events
      .map((e) => JSON.stringify(e))
      .join("\n");
    return body
      ? `${JSON.stringify(header)}\n${body}`
      : JSON.stringify(header);
  }

  get stats(): { events: number; bytes: number } {
    return { events: this.events.length, bytes: this.recorded };
  }
}

/** 生成导出文件名（本地时间戳） */
export function castFileName(prefix = "tdsf-recording"): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${prefix}-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.cast`;
}
