import { describe, expect, it } from "vitest";
import { AgentCommandEcho } from "./agentCommandEcho";

const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);
const encode = (text: string) => new TextEncoder().encode(text);

describe("AgentCommandEcho", () => {
  it("colors only a command echo split across terminal chunks", () => {
    const echo = new AgentCommandEcho("dnf install fastfetch\n");

    expect(decode(echo.transform(encode("[root]# dnf ins")))).toBe("[root]# ");
    expect(decode(echo.transform(encode("tall fastfetch\r\ninstalled\r\n")))).toBe(
      "\x1b[38;2;91;140;255mdnf install fastfetch\x1b[0m\r\ninstalled\r\n",
    );
    expect(echo.isComplete()).toBe(true);
  });

  it("leaves non-matching output byte-for-byte unchanged", () => {
    const echo = new AgentCommandEcho("uname -a\n");
    const output = encode("permission denied\r\n");

    expect(echo.transform(output)).toEqual(output);
  });
});
