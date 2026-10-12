import type { SshSessionDetail } from "@/lib/ssh-bridge";

export type SshTerminalContext = NonNullable<SshSessionDetail["terminalContext"]>;
export type RemoteOscGate = (code: 7 | 133 | 633, data: string) => boolean;

type ShellReceipt = {
  connectionId: string;
  shell: string;
  cwd: string;
};

const CONTEXT_PREFIX = "P;TdsfContext=";

function parseReceipt(data: string): ShellReceipt | null {
  const fields = data.slice(CONTEXT_PREFIX.length).split(";");
  if (fields.length !== 4 || !/^[0-9a-f]{32}$/.test(fields[0]) ||
      !/^\d+-\d+-\d+$/.test(fields[1])) return null;
  try {
    const user = decodeURIComponent(fields[2]);
    const cwd = decodeURIComponent(fields[3]);
    if (!user || !cwd.startsWith("/") || cwd.includes("\0")) return null;
    return { connectionId: fields[0], shell: fields[1], cwd };
  } catch {
    return null;
  }
}

/** Connection/shell association, not authentication of hostile server output. */
export class RemoteShellIntegration {
  private connection: SshTerminalContext | null = null;
  private receipt: ShellReceipt | null = null;
  private candidate: ShellReceipt | null = null;
  private candidateAtPrompt = false;
  private candidateExecuting = false;
  private accepted = false;
  private promptReceipt = false;
  private running = false;
  private pendingCwd: string | null = null;
  private publishedCwd: string | null = null;

  constructor(private readonly callbacks: {
    onCwd: (cwd: string) => void;
    onContextChange: () => void;
  }) {}

  setConnection(context: SshTerminalContext | null): void {
    if (context?.connectionId === this.connection?.connectionId &&
        context?.bashHooksPath === this.connection?.bashHooksPath) return;
    const candidate = this.connection === null ? this.candidate : null;
    const atPrompt = this.candidateAtPrompt;
    const executing = this.candidateExecuting;
    this.callbacks.onContextChange();
    this.connection = context;
    this.receipt = null;
    this.candidate = null;
    this.accepted = false;
    this.promptReceipt = false;
    this.running = false;
    this.pendingCwd = null;
    this.publishedCwd = null;
    if (candidate && context?.bashHooksPath &&
        candidate.connectionId === context.connectionId) {
      this.adopt(candidate, false);
      this.running = executing;
      this.promptReceipt = !executing;
      if (atPrompt) this.publishCwd();
    }
  }

  acceptFrame: RemoteOscGate = (code, data) => {
    if (this.connection?.bashHooksPath === null) return true;
    if (code === 633 && data.startsWith(CONTEXT_PREFIX)) {
      const receipt = parseReceipt(data);
      if (!this.connection) {
        this.candidate = receipt;
        this.candidateAtPrompt = false;
        this.candidateExecuting = false;
      } else if (receipt?.connectionId === this.connection.connectionId) {
        this.adopt(receipt, true);
      } else {
        // A wrong-source prompt must not settle this shell's pending command.
        this.accepted = false;
      }
      return false;
    }
    if (!this.connection) {
      if (this.candidate && (code === 133 || code === 633)) {
        if (/^[AD](?:;|$)/.test(data)) {
          this.candidateAtPrompt = true;
          this.candidateExecuting = false;
        } else if (/^[CE](?:;|$)/.test(data)) {
          this.candidateAtPrompt = false;
          this.candidateExecuting = true;
        }
      }
      return false;
    }
    // Bash's URI-encoded Context is authoritative, not raw Cwd or a URI host.
    if (code === 7 || (code === 633 && data.startsWith("P;"))) return false;
    if (!this.accepted) return false;
    if (/^[AD](?:;|$)/.test(data)) {
      if (!this.promptReceipt) return false;
      this.running = false;
      this.publishCwd();
    } else if (/^[CE](?:;|$)/.test(data)) {
      this.running = true;
      this.promptReceipt = false;
    }
    return true;
  };

  private adopt(receipt: ShellReceipt, publish: boolean): void {
    if (this.receipt?.shell !== receipt.shell) {
      this.callbacks.onContextChange();
      this.running = false;
      this.publishedCwd = null;
    }
    this.receipt = receipt;
    this.accepted = true;
    this.promptReceipt = true;
    this.pendingCwd = receipt.cwd;
    if (publish && !this.running) this.publishCwd();
  }

  private publishCwd(): void {
    if (this.pendingCwd === null) return;
    const cwd = this.pendingCwd;
    this.pendingCwd = null;
    if (this.publishedCwd === cwd) return;
    this.publishedCwd = cwd;
    this.callbacks.onCwd(cwd);
  }
}
