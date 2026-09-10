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

export class AgentCommandEcho {
  private readonly expected: Uint8Array;
  private index = 0;
  private complete = false;

  constructor(command: string) {
    this.expected = encoder.encode(command.replace(/[\r\n]+$/, ""));
    this.complete = this.expected.length === 0;
  }

  isComplete(): boolean {
    return this.complete;
  }

  transform(bytes: Uint8Array): Uint8Array {
    if (this.complete || bytes.length === 0) return bytes;
    const output: number[] = [];
    for (const byte of bytes) {
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
}
