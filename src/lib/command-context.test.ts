import { describe, expect, it } from "vitest";
import { commandContext, completionReplacement } from "./command-context";

describe("shared command context", () => {
  it.each([
    ["sudo --user root env X=1 systemctl st", "systemctl", ["systemctl", "st"]],
    ["echo 'a | b' && git remote ad", "git", ["git", "remote", "ad"]],
    ["printf a\\ b | grep a\\ b", "grep", ["grep", "a b"]],
    ["Get-ChildItem C:\\Users\\Public", "Get-ChildItem", ["Get-ChildItem", "C:\\Users\\Public"]],
    ["Get-ChildItem \\\\host\\share", "Get-ChildItem", ["Get-ChildItem", "\\\\host\\share"]],
  ])("resolves %s without evaluating input", (line, cmd, tokens) => {
    expect(commandContext(line as string)).toMatchObject({ cmd, tokens });
  });

  it.each(["sudo -u ", "git > out", "echo $(pwd)", 'echo "$(pwd)"', "echo `pwd`", "git # status"])(
    "suppresses an incomplete or unsupported context: %s", (line) => {
      expect(commandContext(line).cmd).toBe("");
    },
  );

  it("does not interpret operators inside a literal quoted token", () => {
    expect(commandContext("grep 'a;$(pwd)' ")).toMatchObject({ cmd: "grep", tokens: ["grep", "a;$(pwd)"], current: "" });
  });

  it.each([
    ["cat f", "file name", false, "cat 'file name'"],
    ["cat f", "x; echo unsafe", false, "cat 'x; echo unsafe'"],
    ["cat f", "it's.txt", false, "cat 'it'\\''s.txt'"],
    ["Get-Content f", "it's.txt", true, "Get-Content 'it''s.txt'"],
    ['cat "f', "$HOME.txt", false, 'cat "\\$HOME.txt'],
  ])("quotes completion data without changing command structure", (line, value, windows, expected) => {
    const { from, text } = completionReplacement(line as string, value as string, true, windows as boolean);
    expect((line as string).slice(0, from) + text).toBe(expected);
  });
});

describe("accepting only the current token", () => {
  it.each([
    ["echo hi | gi", "git", false, "echo hi | git"],
    ["sudo -u root systemctl st", "status", true, "sudo -u root systemctl status"],
    ["tar --hole-detection=ra", "raw", true, "tar --hole-detection=raw"],
    ['tool --format "j', "json", true, 'tool --format "json'],
    ['tool --format="j"', "json", true, 'tool --format="json"'],
    ["sudo ls", "-l", true, "sudo ls -l "],
    ["git remote ", "add", true, "git remote add "],
  ])("preserves the rest of %s", (line, value, argument, expected) => {
    const { from, text } = completionReplacement(line as string, value as string, argument as boolean);
    expect((line as string).slice(0, from) + text).toBe(expected);
  });
});
