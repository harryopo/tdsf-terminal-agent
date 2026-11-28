import test from "node:test";
import assert from "node:assert/strict";
import * as shellSessionModule from "../shell-session.js";

test("command display makes spaces explicit without changing the real command", () => {
  assert.equal(shellSessionModule.formatCommandForDisplay("ls -la"), "ls · -la");
  assert.equal(shellSessionModule.formatCommandForDisplay("grep '^root:' /etc/passwd"), "grep · '^root:' · /etc/passwd");
});
