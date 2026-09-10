/**
 * Colors the echo of one Agent-entered command without changing the bytes sent
 * to the shell.  The matcher operates on bytes so arbitrary terminal output
 * (including split UTF-8 sequences) is forwarded losslessly.
 */
const AGENT_COMMAND_BLUE = "\x1b[38;2;91;140;255m";
const RESET_STYLE = "\x1b[0m";
const encoder = new TextEncoder();

export class AgentCommandEcho {
  private readonly expected: Uint8Array;
  private candidate: number[] = [];
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
      if (this.index === 0) {
        if (byte === this.expected[0]) {
          this.candidate.push(byte);
          this.index = 1;
        } else {
          output.push(byte);
        }
        continue;
      }

      this.candidate.push(byte);
      if (byte === this.expected[this.index]) {
        this.index += 1;
        if (this.index === this.expected.length) {
          output.push(...encoder.encode(AGENT_COMMAND_BLUE), ...this.candidate);
          output.push(...encoder.encode(RESET_STYLE));
          this.candidate = [];
          this.complete = true;
        }
        continue;
      }

      output.push(...this.candidate);
      this.candidate = [];
      this.index = 0;
    }
    return Uint8Array.from(output);
  }
}
