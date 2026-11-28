import test from "node:test";
import assert from "node:assert/strict";
import { ShellSession } from "../shell-session.js";
import { tasks } from "../lesson-tasks.js";

function createSession() {
  return new ShellSession(tasks);
}

function submit(session, command, output) {
  session.observeInput(`${command}\r`);
  session.observeOutput(output);
  session.observeOutput("/root% ");
}

test("step keys use stable task step identifiers for server sync", () => {
  const session = createSession();
  assert.equal(session.stepKey(0), "files-pwd");
  assert.equal(session.stepKey(1, 1), "permissions-passwd-mode");
});

test("server progress hydrates completed steps and task state", () => {
  const session = createSession();
  session.applyServerProgress(["files-pwd", "files-ls", "files-os-release"]);
  assert.equal(session.getProgress().executed, 3);
  assert.equal(session.getProgress().completed, 1);
  assert.equal(session.isTaskComplete("files"), true);
});

test("hint fills the current command without executing or advancing", () => {
  const session = createSession();
  const result = session.fillHint();
  assert.deepEqual(result, { ok: true, command: "pwd" });
  assert.equal(session.getCurrentStep().command, "pwd");
  assert.equal(session.getProgress().completed, 0);
  assert.equal(session.getProgress().executed, 0);
});

test("a submitted command advances only after a real shell prompt returns", () => {
  const session = createSession();
  session.observeInput("pwd\r");
  assert.equal(session.getCurrentStep().command, "pwd");
  session.observeOutput("/root\n");
  assert.equal(session.getCurrentStep().command, "pwd");
  session.observeOutput("/root% ");
  assert.equal(session.getCurrentStep().command, "ls -la");
  assert.equal(session.getProgress().executed, 1);
  assert.equal(session.getLastResult().status, "success");
});

test("a wrong command does not advance the lesson", () => {
  const session = createSession();
  submit(session, "whoami", "root\n");
  assert.equal(session.getCurrentStep().command, "pwd");
  assert.equal(session.getProgress().executed, 0);
  assert.equal(session.getLastResult().status, "mismatch");
});

test("a correct command without expected output does not advance", () => {
  const session = createSession();
  submit(session, "pwd", "permission denied\n");
  assert.equal(session.getCurrentStep().command, "pwd");
  assert.equal(session.getProgress().executed, 0);
  assert.equal(session.getLastResult().status, "output-mismatch");
});

test("finishing all steps completes the task and updates progress", () => {
  const session = createSession();
  submit(session, "pwd", "/root\n");
  submit(session, "ls -la", "drwx------ .\ndrwxr-xr-x ..\n");
  submit(session, "cat /etc/os-release", "PRETTY_NAME=\"Buildroot 2013.08.1\"\n");
  assert.equal(session.getProgress().completed, 1);
  assert.equal(session.getProgress().executed, 3);
  assert.equal(session.isTaskComplete("files"), true);
});

test("switching tasks preserves completed work", () => {
  const session = createSession();
  submit(session, "pwd", "/root\n");
  submit(session, "ls -la", ".\n..\n");
  submit(session, "cat /etc/os-release", "Buildroot 2013.08.1\n");
  session.selectTask(1);
  assert.equal(session.getCurrentStep().command, "id");
  session.selectTask(0);
  assert.equal(session.isTaskComplete("files"), true);
  assert.equal(session.getProgress().completed, 1);
});

test("repeated hint clicks do not concatenate commands", () => {
  const session = createSession();
  assert.equal(session.fillHint().ok, true);
  const second = session.fillHint();
  assert.equal(second.ok, false);
  assert.equal(second.reason, "input-not-empty");
  session.observeInput("\r");
  session.observeOutput("/root\n/root% ");
  assert.equal(session.getCurrentStep().command, "ls -la");
});

test("zero-width format characters cannot corrupt the receipt command", () => {
  const session = createSession();
  session.observeInput("p\u200bwd\r");
  assert.equal(session.getPending().command, "pwd");
  session.observeOutput("/root\n/root% ");
  assert.equal(session.getLastResult().command, "pwd");
  assert.equal(session.getLastResult().status, "success");
});

test("replacement characters cannot corrupt the receipt command", () => {
  const session = createSession();
  session.observeInput("p\uFFFDwd\r");
  assert.equal(session.getPending().command, "pwd");
  session.observeOutput("/root\n/root% ");
  assert.equal(session.getLastResult().status, "success");
});

test("command echo is not accepted as output evidence", () => {
  const session = createSession();
  submit(session, "pwd", "/root\n");
  submit(session, "ls -la", "ls -la\r\ncannot access ..: No such file\n");
  assert.equal(session.getCurrentStep().command, "ls -la");
  assert.equal(session.getLastResult().status, "output-mismatch");
});

test("real shell echo corrects the submitted command after history navigation", () => {
  const session = createSession();
  session.observeInput("\x1b[A");
  session.observeInput("\r");
  session.observeOutput("pwd\r\n/root\n/root% ");
  assert.equal(session.getCurrentStep().command, "ls -la");
  assert.equal(session.getLastResult().status, "success");
  assert.equal(session.getLastResult().command, "pwd");
});

test("real shell echo overrides a divergent local buffer after line editing", () => {
  const session = createSession();
  session.observeInput("\x1b[A");
  session.observeInput("x");
  session.observeInput("\r");
  assert.equal(session.getPending().command, "x");
  session.observeOutput("pwd\r\n/root\n/root% ");
  assert.equal(session.getLastResult().command, "pwd");
  assert.equal(session.getLastResult().status, "success");
});

test("an error containing the target path is not ls permission evidence", () => {
  const step = tasks[1].steps[1];
  const session = new ShellSession([{ id: "permissions", steps: [step] }]);
  submit(session, step.command, "ls: /etc/passwd: No such file or directory\n");
  assert.equal(session.getLastResult().status, "output-mismatch");
  assert.equal(session.getProgress().executed, 0);
});

test("hint is blocked after shell line editing keys", () => {
  const session = createSession();
  session.observeInput("\x1b[A");
  assert.deepEqual(session.fillHint(), { ok: false, reason: "line-edited" });
});

test("pasted commands settle in order and cannot lend output to the wrong command", () => {
  const session = createSession();
  session.observeInput("/root\rpwd\r");
  assert.equal(session.getPending().command, "/root");
  session.observeOutput("/root\r\n/root% ");
  assert.equal(session.getLastResult().status, "mismatch");
  assert.equal(session.getProgress().executed, 0);
  assert.equal(session.getPending().command, "pwd");
  session.observeOutput("pwd\r\n/root\r\n/root% ");
  assert.equal(session.getLastResult().status, "success");
  assert.equal(session.getProgress().executed, 1);
  assert.equal(session.getCurrentStep().command, "ls -la");
});

test("task switching preserves partial shell input and blocks hint concatenation", () => {
  const session = createSession();
  session.observeInput("pw");
  assert.equal(session.selectTask(1), true);
  assert.equal(session.inputBuffer, "pw");
  assert.deepEqual(session.fillHint(), { ok: false, reason: "input-not-empty" });
});

test("task switching is blocked while a command is pending", () => {
  const session = createSession();
  session.observeInput("pwd\r");
  assert.equal(session.selectTask(1), false);
  assert.equal(session.taskIndex, 0);
  assert.equal(session.getPending().command, "pwd");
});

test("history recall succeeds when echo and output arrive in separate carriage-return chunks", () => {
  const session = createSession();
  session.observeInput("\x1b[A");
  session.observeInput("\r");
  session.observeOutput("pwd\r");
  session.observeOutput("/root\r\n");
  session.observeOutput("/root% ");
  assert.equal(session.getLastResult().command, "pwd");
  assert.equal(session.getLastResult().status, "success");
  assert.equal(session.getProgress().executed, 1);
});

test("shell echo received before enter is preserved for command matching", () => {
  const step = tasks[1].steps[0];
  const session = new ShellSession([{ id: "permissions", steps: [step] }]);
  session.observeOutput("i");
  session.observeOutput("d");
  session.observeInput("id\r");
  session.observeOutput("\r\nuid=0(root) gid=0(root) groups=0(root)\r\n/root% ");
  assert.equal(session.getLastResult().command, "id");
  assert.equal(session.getLastResult().status, "success");
});

test("streamed ANSI color sequences do not hide directory evidence", () => {
  const session = createSession();
  submit(session, "pwd", "/root\n");
  session.observeInput("ls -la\r");
  const output = "ls -la\r\ntotal 1\r\ndrwxr-xr-x 2 root root 1024 Jul 14 2014 \x1b[1;34m..\x1b[0m\r\n/root% ";
  for (const char of output) session.observeOutput(char);
  assert.equal(session.getLastResult().status, "success");
  assert.equal(session.getProgress().executed, 2);
});

test("queued commands bind the step that is current when they start", () => {
  const session = createSession();
  session.observeInput("pwd\rls -la\r");
  session.observeOutput("/root\r\n/root% ");
  assert.equal(session.getPending().expected, "ls -la");
  assert.equal(session.getPending().stepIndex, 1);
  session.observeOutput("ls -la\r\ndrwxr-xr-x 2 root root 1024 Jul 14 2014 ..\r\n/root% ");
  assert.equal(session.getLastResult().status, "success");
  assert.equal(session.getProgress().executed, 2);
});

test("root directory prompt finishes a command and unlocks task switching", () => {
  const session = createSession();
  session.observeInput("cd /\r");
  session.observeOutput("cd /\r\n/% ");
  assert.equal(session.getPending(), null);
  assert.equal(session.getLastResult().status, "mismatch");
  assert.equal(session.selectTask(1), true);
});

test("backspace edits input and control-c cancels a pending command", () => {
  const session = createSession();
  session.observeInput("pwdx");
  session.observeInput("\x7f");
  session.observeInput("\r");
  assert.equal(session.getPending().command, "pwd");
  session.observeInput("\x03");
  assert.equal(session.getPending(), null);
  assert.equal(session.getLastResult().status, "cancelled");
});
