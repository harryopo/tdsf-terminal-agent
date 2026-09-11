import { describe, expect, it } from "vitest";
import { AgentCommandEcho } from "./agentCommandEcho";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const encode = (text: string) => new TextEncoder().encode(text);

describe("AgentCommandEcho", () => {
  it("forwards split command echo immediately while coloring it", () => {
    const echo = new AgentCommandEcho("dnf install fastfetch\n");

    expect(decode(echo.transform(encode("[root]# dnf ins")))).toBe(
      "[root]# \x1b[38;2;91;140;255mdnf ins",
    );
    expect(
      decode(echo.transform(encode("tall fastfetch\r\ninstalled\r\n"))),
    ).toBe("tall fastfetch\x1b[0m\r\ninstalled\r\n");
    expect(echo.isComplete()).toBe(true);
  });

  it("does not leave a temporary color span open after a mismatch", () => {
    const echo = new AgentCommandEcho("dnf install\n");

    expect(decode(echo.transform(encode("dX")))).toBe(
      "\x1b[38;2;91;140;255md\x1b[0mX",
    );
    expect(echo.isComplete()).toBe(false);
  });

  it("passes split OSC 7 control strings through without coloring their payload", () => {
    const echo = new AgentCommandEcho("ls -l /var/www/html\n");
    const first = encode("\x1b]7;file://localhost");
    const second = encode("/root\x07[root]# ls");

    expect(echo.transform(first)).toEqual(first);
    expect(decode(echo.transform(second))).toBe(
      "/root\x07[root]# \x1b[38;2;91;140;255mls",
    );
    expect(decode(echo.transform(encode(" -l /var/www/html\r\n")))).toBe(
      " -l /var/www/html\x1b[0m\r\n",
    );
    expect(echo.isComplete()).toBe(true);
  });

  it("waits for a prompt boundary before coloring a human-typed command", () => {
    const echo = new AgentCommandEcho("rpm -q samba\n", {
      waitForPrompt: true,
    });

    expect(decode(echo.transform(encode("[root@server ~]# ")))).toBe(
      "[root@server ~]# ",
    );
    expect(decode(echo.transform(encode("rpm -q samba\r\n")))).toBe(
      "\x1b[38;2;91;140;255mrpm -q samba\x1b[0m\r\n",
    );
    expect(echo.isComplete()).toBe(true);
  });

  it("leaves non-matching output byte-for-byte unchanged", () => {
    const echo = new AgentCommandEcho("uname -a\n");
    const output = encode("permission denied\r\n");

    expect(echo.transform(output)).toEqual(output);
  });
});
