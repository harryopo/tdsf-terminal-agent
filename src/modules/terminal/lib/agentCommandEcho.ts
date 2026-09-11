/**
 * Colors the echo of one Agent-entered command without changing the bytes sent
 * to the shell.  The matcher operates on bytes so arbitrary terminal output
 * (including split UTF-8 sequences) is forwarded losslessly.
 */
const AGENT_COMMAND_BLUE = "\x1b[38;2;91;140;255m";
const RESET_STYLE = "\x1b[0m";
const encoder = new TextEncoder();
const AGENT_COMMAND_BLUE_BYTES = encoder.encode(AGENT_COMMAND_BLUE);
const RESET_STYLE_BYTES = encoder.encode(RESET_STYLE);
type ControlState = "none" | "escape" | "csi" | "string" | "stringEscape";
export type AgentCommandEchoOptions = {
  /** Wait for a shell prompt boundary before matching the command echo. */
  waitForPrompt?: boolean;
};

export class AgentCommandEcho {
  private readonly expected: Uint8Array;
  private index = 0;
  private complete = false;
  private controlState: ControlState = "none";
  private readonly waitForPrompt: boolean;
  private promptReady: boolean;
  private promptMarkerPending = false;

  constructor(command: string, options: AgentCommandEchoOptions = {}) {
    this.expected = encoder.encode(command.replace(/[\r\n]+$/, ""));
    this.complete = this.expected.length === 0;
    this.waitForPrompt = options.waitForPrompt === true;
    this.promptReady = !this.waitForPrompt;
  }

  isComplete(): boolean {
    return this.complete;
  }

  transform(bytes: Uint8Array): Uint8Array {
    if (this.complete || bytes.length === 0) return bytes;
    const output: number[] = [];
    for (const byte of bytes) {
      if (this.controlState !== "none") {
        this.consumeControlByte(byte, output);
        continue;
      }

      // Never inject SGR bytes inside terminal control strings. In particular,
      // OSC 7 carries `file://localhost/...`; corrupting it makes the URL leak
      // into the visible shell prompt instead of being consumed by xterm.
      if (byte === 0x1b) {
        output.push(byte);
        this.controlState = "escape";
        continue;
      }

      // C0 controls are not command text. Keep them lossless and restart a
      // partial match at a new line so a previous prompt cannot bleed into the
      // next command.
      if (byte < 0x20 || byte === 0x7f) {
        output.push(byte);
        if (byte === 0x0a || byte === 0x0d) {
          this.index = 0;
          this.promptReady = !this.waitForPrompt;
          this.promptMarkerPending = false;
        }
        continue;
      }

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
        continue;
      }

      // The armed command has already completed in this same PTY chunk. Do
      // not try to match the prompt/output that follows it.
      if (this.complete) {
        output.push(byte);
        continue;
      }

      if (this.index === 0) {
        if (byte === this.expected[0]) {
          // Start the color span as soon as the first echoed byte arrives.
          // Buffering the candidate until the whole command matched made
          // human/typewriter input appear frozen in the terminal.
          output.push(...AGENT_COMMAND_BLUE_BYTES, byte);
          this.index = 1;
        } else {
          output.push(byte);
        }
        continue;
      }

      if (byte === this.expected[this.index]) {
        output.push(byte);
        this.index += 1;
        if (this.index === this.expected.length) {
          output.push(...RESET_STYLE_BYTES);
          this.complete = true;
        }
        continue;
      }

      // The shell echoed something other than the armed command. Close the
      // temporary color span and forward the mismatching byte immediately.
      output.push(...RESET_STYLE_BYTES);
      this.index = 0;
      if (byte === this.expected[0]) {
        output.push(...AGENT_COMMAND_BLUE_BYTES, byte);
        this.index = 1;
      } else {
        output.push(byte);
      }
    }
    return Uint8Array.from(output);
  }

  private consumeControlByte(byte: number, output: number[]): void {
    output.push(byte);
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
