/**
 * Colors the echo of one Agent-entered command without changing the bytes the
 * shell would have displayed. The matcher works on bytes so arbitrary terminal
 * output (including split UTF-8 sequences) is forwarded losslessly.
 *
 * Two modes, split by how the command reaches the shell:
 *
 * - **confirmed** (default, whole-segment injection): a line is colored only
 *   after its whole text has echoed *and* the line then ends. Candidate bytes
 *   are held during the match, so a false start inside a prompt or earlier
 *   output costs nothing on screen. This is what keeps the terminal from
 *   showing half a blue line: the matcher never injects an SGR pair it cannot
 *   close, and an unclosed span can never bleed into the next prompt.
 * - **progressive** (typewriter demo): the pump echoes one character per read,
 *   so holding would freeze the display until Enter. The span opens at the
 *   first matching character instead — which is why that path needs a prompt
 *   boundary to know where the command starts.
 *
 * A multi-line command is matched line by line, so every line of it is either
 * colored as a unit or left completely alone.
 */
const AGENT_COMMAND_BLUE = "\x1b[38;2;91;140;255m";
const RESET_STYLE = "\x1b[0m";
const encoder = new TextEncoder();
const AGENT_COMMAND_BLUE_BYTES = encoder.encode(AGENT_COMMAND_BLUE);
const RESET_STYLE_BYTES = encoder.encode(RESET_STYLE);
/**
 * Confirmed mode withholds candidate bytes. A real echo needs at most a handful
 * of control sequences between its first and last printable byte; anything
 * longer means we are parked inside a banner or a redraw, so the candidate is
 * dropped rather than holding the display hostage.
 */
const MAX_CANDIDATE_HOLD = 512;
type ControlState = "none" | "escape" | "csi" | "string" | "stringEscape";
export type AgentCommandEchoOptions = {
  /**
   * Typewriter mode: display bytes as they arrive and open the color span at
   * the first match, gated on a prompt boundary. Default (false) confirms the
   * whole line first.
   */
  progressive?: boolean;
};

export class AgentCommandEcho {
  private readonly lines: Uint8Array[];
  private readonly progressive: boolean;
  private lineIndex = 0;
  private matched = 0;
  private complete = false;
  /** Confirmed mode: verbatim bytes consumed since the live candidate began. */
  private held: number[] = [];
  /** Progressive mode: a blue span has been emitted and still owes a reset. */
  private spanOpen = false;
  private controlState: ControlState = "none";
  private promptReady: boolean;
  private promptMarkerPending = false;

  constructor(command: string, options: AgentCommandEchoOptions = {}) {
    const text = command.replace(/[\r\n]+$/, "");
    this.lines = text
      .split(/\r\n|\n|\r/)
      .map((line) => encoder.encode(line))
      .filter((line) => line.length > 0);
    this.complete = this.lines.length === 0;
    this.progressive = options.progressive === true;
    this.promptReady = !this.progressive;
  }

  isComplete(): boolean {
    return this.complete;
  }

  /**
   * Give up on the armed command and hand back everything still owed to the
   * display: withheld candidate bytes plus, in progressive mode, the reset that
   * closes an open span. Callers must write the result or bytes go missing.
   */
  discard(): Uint8Array {
    const output = [...this.held];
    this.held = [];
    if (this.spanOpen) {
      output.push(...RESET_STYLE_BYTES);
      this.spanOpen = false;
    }
    this.matched = 0;
    this.complete = true;
    return Uint8Array.from(output);
  }

  transform(bytes: Uint8Array): Uint8Array {
    if (this.complete || bytes.length === 0) return bytes;
    const output: number[] = [];
    for (let i = 0; i < bytes.length; i += 1) {
      if (this.complete) {
        // The command finished mid-chunk: everything after it in the same read
        // is ordinary shell output and must be forwarded, not swallowed.
        for (; i < bytes.length; i += 1) output.push(bytes[i]);
        break;
      }
      this.consume(bytes[i], output);
    }
    return Uint8Array.from(output);
  }

  private consume(byte: number, output: number[]): void {
    if (this.controlState !== "none") {
      this.consumeControlByte(byte, output);
      return;
    }

    // Never inject SGR bytes inside terminal control strings. In particular,
    // OSC 7 carries `file://localhost/...`; corrupting it makes the URL leak
    // into the visible shell prompt instead of being consumed by xterm.
    if (byte === 0x1b) {
      this.emitControl(byte, output);
      this.controlState = "escape";
      return;
    }

    // C0 controls are not command text. Keep them lossless and end the line at
    // CR/LF, which is where a confirmed candidate is finally judged.
    if (byte < 0x20 || byte === 0x7f) {
      if (byte === 0x0a || byte === 0x0d) this.endLine(output, byte);
      else this.emitControl(byte, output);
      return;
    }

    if (this.progressive) this.consumeProgressive(byte, output);
    else this.consumeConfirmed(byte, output);
  }

  /** Confirmed mode: hold the candidate, inject SGR only once it is proven. */
  private consumeConfirmed(byte: number, output: number[]): void {
    const line = this.currentLine();
    if (line === null) {
      output.push(byte);
      return;
    }

    if (this.held.length === 0) {
      if (byte === line[0]) this.held = [byte];
      else output.push(byte);
      this.matched = this.held.length === 0 ? 0 : 1;
      return;
    }

    if (this.matched < line.length && byte === line[this.matched]) {
      this.held.push(byte);
      this.matched += 1;
      return;
    }

    // Either the line text is done and more text followed it, or the shell
    // echoed something else. Both mean this run was not the command echo.
    this.rejectCandidate(output);
    if (byte === line[0]) this.held = [byte];
    else output.push(byte);
  }

  /** Progressive mode: color from the first byte, so never wait for a line. */
  private consumeProgressive(byte: number, output: number[]): void {
    if (!this.promptReady) {
      output.push(byte);
      if (this.promptMarkerPending) {
        this.promptReady = byte === 0x20 || byte === 0x09;
        this.promptMarkerPending = false;
      } else if (
        byte === 0x23 ||
        byte === 0x24 ||
        byte === 0x25 ||
        byte === 0x3e
      ) {
        // Common POSIX / PowerShell prompt terminators: #, $, %, >.
        this.promptMarkerPending = true;
      }
      return;
    }

    const line = this.currentLine();
    if (line === null) {
      output.push(byte);
      return;
    }

    if (!this.spanOpen) {
      if (byte === line[0]) {
        // Opening the span on the first echoed byte is what keeps human-paced
        // input from looking frozen; the cost is that a false start colors a
        // prompt fragment, which is why this mode needs the gate above.
        output.push(...AGENT_COMMAND_BLUE_BYTES, byte);
        this.spanOpen = true;
        this.matched = 1;
      } else {
        output.push(byte);
      }
      return;
    }

    if (this.matched < line.length && byte === line[this.matched]) {
      output.push(byte);
      this.matched += 1;
      if (this.matched === line.length) this.commitSpan(output);
      return;
    }

    this.closeSpan(output);
    if (byte === line[0]) {
      output.push(...AGENT_COMMAND_BLUE_BYTES, byte);
      this.spanOpen = true;
      this.matched = 1;
    } else {
      output.push(byte);
    }
  }

  private endLine(output: number[], byte: number): void {
    const line = this.currentLine();
    if (line !== null && this.held.length > 0 && this.matched === line.length) {
      this.commitCandidate(output);
      this.advanceLine();
    } else {
      // The run died inside this line, or a progressive span is still open
      // because the shell never echoed the rest of the command: either way the
      // span must close before the newline, or blue bleeds into the next prompt.
      this.rejectCandidate(output);
      this.closeSpan(output);
      this.matched = 0;
    }
    output.push(byte);
    this.promptReady = !this.progressive;
    this.promptMarkerPending = false;
  }

  private currentLine(): Uint8Array | null {
    if (this.complete) return null;
    return this.lines[this.lineIndex] ?? null;
  }

  private commitCandidate(output: number[]): void {
    output.push(...AGENT_COMMAND_BLUE_BYTES, ...this.held, ...RESET_STYLE_BYTES);
    this.held = [];
  }

  private rejectCandidate(output: number[]): void {
    if (this.held.length === 0) return;
    output.push(...this.held);
    this.held = [];
  }

  private commitSpan(output: number[]): void {
    this.closeSpan(output);
    this.advanceLine();
  }

  private closeSpan(output: number[]): void {
    if (!this.spanOpen) return;
    output.push(...RESET_STYLE_BYTES);
    this.spanOpen = false;
  }

  private advanceLine(): void {
    this.matched = 0;
    this.lineIndex += 1;
    if (this.lineIndex >= this.lines.length) this.complete = true;
  }

  private emitControl(byte: number, output: number[]): void {
    if (this.held.length > 0) {
      this.held.push(byte);
      // A candidate can only be held briefly: if the shell is streaming redraw
      // sequences around it, give up and release the bytes in order.
      const limit = (this.currentLine()?.length ?? 0) + MAX_CANDIDATE_HOLD;
      if (this.held.length > limit) this.rejectCandidate(output);
      return;
    }
    output.push(byte);
  }

  private consumeControlByte(byte: number, output: number[]): void {
    this.emitControl(byte, output);
    switch (this.controlState) {
      case "escape":
        if (byte === 0x5b) {
          this.controlState = "csi";
        } else if (
          byte === 0x5d ||
          byte === 0x50 ||
          byte === 0x58 ||
          byte === 0x5e ||
          byte === 0x5f
        ) {
          // OSC / DCS / SOS / PM / APC: all terminate with BEL or ST (ESC \\).
          this.controlState = "string";
        } else {
          this.controlState = "none";
        }
        break;
      case "csi":
        if (byte >= 0x40 && byte <= 0x7e) this.controlState = "none";
        break;
      case "string":
        if (byte === 0x07) this.controlState = "none";
        else if (byte === 0x1b) this.controlState = "stringEscape";
        break;
      case "stringEscape":
        if (byte === 0x5c) this.controlState = "none";
        else if (byte !== 0x1b) this.controlState = "string";
        break;
      case "none":
        break;
    }
  }
}
