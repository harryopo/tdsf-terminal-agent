import { beforeEach, describe, expect, it } from "vitest";
import type { SshCommandOutputEvent } from "@/lib/sidecar-bridge";
import { useSshCommandOutputStore } from "./sshCommandOutputStore";

const command = "uname -a";
const backendToolCallId = "backend-1";
const toolCallId = "front-1";

function begin(frontId = toolCallId, backendId = backendToolCallId) {
  useSshCommandOutputStore.getState().begin({
    toolCallId: frontId,
    backendToolCallId: backendId,
    conversationSessionId: "session-1",
    toolName: "ssh_command",
    command,
  });
}

function event(fields: Partial<SshCommandOutputEvent> = {}): SshCommandOutputEvent {
  return {
    toolCallId: backendToolCallId,
    operationId: "operation-1",
    conversationSessionId: "session-1",
    sshSessionId: 1,
    toolName: "ssh_command",
    command,
    stream: "status",
    chunk: "",
    status: "running",
    ...fields,
  };
}

function call() {
  return useSshCommandOutputStore.getState().calls[toolCallId];
}

beforeEach(() => {
  useSshCommandOutputStore.setState({ calls: {} });
});

describe("SSH command output ownership", () => {
  it("binds the first Rust running status to operation and SSH session", () => {
    begin();
    useSshCommandOutputStore.getState().record(event({
      stream: "stdout",
      chunk: "too early",
    }));
    useSshCommandOutputStore.getState().record(event({
      operationId: undefined,
      stream: "status",
    }));
    useSshCommandOutputStore.getState().record(event({
      operationId: null,
      stream: "status",
    }));
    expect(call().stdout).toBe("");
    expect(call().operationId).toBeUndefined();

    useSshCommandOutputStore.getState().record(event());
    expect(call().operationId).toBe("operation-1");
    expect(call().sshSessionId).toBe(1);
  });

  it("rejects missing or mismatched identity fields and accepts the exact owner", () => {
    begin();
    useSshCommandOutputStore.getState().record(event({
      stream: "status",
      toolCallId: undefined,
    }));
    useSshCommandOutputStore.getState().record(event({ stream: "status", toolCallId: "wrong-backend" }));
    useSshCommandOutputStore.getState().record(event({ stream: "status", conversationSessionId: "other-session" }));
    useSshCommandOutputStore.getState().record(event({ stream: "status", toolName: "other_tool" }));
    useSshCommandOutputStore.getState().record(event({ stream: "status", command: "other command" }));
    useSshCommandOutputStore.getState().record(event({ stream: "status", operationId: "" }));
    expect(call().operationId).toBeUndefined();

    useSshCommandOutputStore.getState().record(event());
    useSshCommandOutputStore.getState().record(event({ operationId: "wrong-operation", stream: "stdout", chunk: "wrong" }));
    useSshCommandOutputStore.getState().record(event({ sshSessionId: 2, stream: "stdout", chunk: "wrong session" }));
    expect(call().stdout).toBe("");

    useSshCommandOutputStore.getState().record(event({ stream: "stdout", chunk: "owned" }));
    expect(call().stdout).toBe("owned");
  });

  it("does not attach SSH output to an empty-command remote file lifecycle record", () => {
    useSshCommandOutputStore.getState().begin({
      toolCallId: "front-write",
      backendToolCallId: "backend-write",
      conversationSessionId: "session-1",
      toolName: "write_remote_file",
      command: "",
      sshSessionId: 42,
    });
    const writeCall = () => useSshCommandOutputStore.getState().calls["front-write"];
    const forged = (fields: Partial<SshCommandOutputEvent> = {}) =>
      event({
        toolCallId: "backend-write",
        toolName: "write_remote_file",
        command: "",
        sshSessionId: 42,
        ...fields,
      });

    useSshCommandOutputStore.getState().record(forged({
      stream: "status",
      status: "running",
      operationId: "forged-operation",
    }));
    useSshCommandOutputStore.getState().record(forged({
      stream: "stdout",
      chunk: "forged output",
      operationId: "forged-operation",
    }));
    expect(writeCall().operationId).toBeUndefined();
    expect(writeCall().stdout).toBe("");

    begin("front-valid", "backend-valid");
    useSshCommandOutputStore.getState().record(event({
      toolCallId: "backend-valid",
      stream: "status",
      status: "running",
    }));
    useSshCommandOutputStore.getState().record(event({
      toolCallId: "backend-valid",
      stream: "stdout",
      chunk: "valid SSH output",
    }));
    expect(useSshCommandOutputStore.getState().calls["front-valid"].stdout)
      .toBe("valid SSH output");
  });

  it("ignores events after completion and explicit finish", () => {
    begin();
    useSshCommandOutputStore.getState().record(event());
    useSshCommandOutputStore.getState().record(event({ status: "completed", exitCode: 0 }));
    useSshCommandOutputStore.getState().record(event({ stream: "stdout", chunk: "late" }));
    expect(call().ended).toBe(true);
    expect(call().stdout).toBe("");

    begin("front-2", "backend-2");
    useSshCommandOutputStore.getState().record(event({
      toolCallId: "backend-2",
      operationId: "operation-2",
    }));
    useSshCommandOutputStore.getState().finish("front-2");
    useSshCommandOutputStore.getState().record(event({
      toolCallId: "backend-2",
      operationId: "operation-2",
      stream: "stderr",
      chunk: "late too",
    }));
    expect(useSshCommandOutputStore.getState().calls["front-2"].ended).toBe(true);
    expect(useSshCommandOutputStore.getState().calls["front-2"].stderr).toBe("");
  });

  it("bounds both streams and never starts a UTF-16 tail with a low surrogate", () => {
    begin();
    useSshCommandOutputStore.getState().record(event());
    useSshCommandOutputStore.getState().record(event({
      stream: "stdout",
      chunk: `😀${"x".repeat(65_535)}`,
    }));
    useSshCommandOutputStore.getState().record(event({
      stream: "stderr",
      chunk: "e".repeat(65_537),
    }));

    expect(call().stdout).toHaveLength(65_535);
    const firstCodeUnit = call().stdout.charCodeAt(0);
    expect(firstCodeUnit >= 0xdc00 && firstCodeUnit <= 0xdfff).toBe(false);
    expect(call().stderr).toHaveLength(65_536);
    expect(call().stderr[0]).toBe("e");
    expect(call().truncated).toBe(true);
  });

  it("retains at most 32 calls", () => {
    for (let index = 0; index < 33; index += 1) {
      begin(`front-${index}`, `backend-${index}`);
    }

    const calls = useSshCommandOutputStore.getState().calls;
    expect(Object.keys(calls)).toHaveLength(32);
    expect(calls["front-0"]).toBeUndefined();
    expect(calls["front-32"]).toBeDefined();
  });
});
