import { describe, expect, it } from "vitest";
import { AgentCommandEcho } from "./agentCommandEcho";

const decoder = new TextDecoder();
const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => decoder.decode(bytes);

const BLUE = "\x1b[38;2;91;140;255m";
const RESET = "\x1b[0m";

type Stream = { output: string; openSpanAtEnd: boolean };

function feed(command: string, chunks: string[], progressive = false): Stream {
  const echo = new AgentCommandEcho(command, { progressive });
  return run(echo, chunks);
}

function run(echo: AgentCommandEcho, chunks: string[]): Stream {
  const inputs: number[] = [];
  const outputs: number[] = [];
  for (const chunk of chunks) {
    const bytes = encode(chunk);
    inputs.push(...bytes);
    outputs.push(...echo.transform(bytes));
  }
  const text = decode(Uint8Array.from(outputs));
  return { output: text, openSpanAtEnd: countSpans(text).open };
}

function countSpans(text: string) {
  let blue = 0;
  let reset = 0;
  let open = false;
  for (const part of text.split(/(\x1b\[38;2;91;140;255m|\x1b\[0m)/)) {
    if (part === BLUE) {
      blue += 1;
      open = true;
    } else if (part === RESET) {
      reset += 1;
      open = false;
    }
  }
  return { blue, reset, open };
}

/**
 * 不变式：匹配器只允许注入「一对」蓝色 SGR，其余字节一律原样透传。
 * 剥掉成对注入的 SGR 后必须与输入逐字节相等，蓝色与 RESET 数量相等、严格
 * 交替，喂完一轮后不留未闭合的区间——这一条同时挡住提示符被染色、半行蓝
 * 半行白、以及蓝色渗进后面所有行这三类渲染混乱。
 */
function assertLossless(input: string[], output: Stream) {
  const { blue, reset, open } = countSpans(output.output);
  expect(blue).toBe(reset);
  expect(open).toBe(false);
  expect(output.output.split(BLUE).join("").split(RESET).join("")).toBe(
    input.join(""),
  );
}

describe("AgentCommandEcho — 确认模式（整段注入）", () => {
  it("提示符里撞见命令首字母时，提示符一个字节都不许改", () => {
    const chunks = ["[root@localhost data]# ls -la /var/log\r\n"];
    const stream = feed("ls -la /var/log\n", chunks);

    expect(stream.output).toBe(
      "[root@localhost data]# " + BLUE + "ls -la /var/log" + RESET + "\r\n",
    );
    assertLossless(chunks, stream);
  });

  it("半行命中不算命令回显：整条输出逐字节原样透传", () => {
    const chunks = ["lossy output\r\n"];
    const stream = feed("ls\n", chunks);

    expect(stream.output).toBe("lossy output\r\n");
    assertLossless(chunks, stream);
  });

  it("跨 chunk 的整行回显照样着色，行尾一到就把扣留的字节交回去", () => {
    const chunks = ["[root]# dnf ins", "tall fastfetch\r\ninstalled\r\n"];
    const stream = feed("dnf install fastfetch\n", chunks);

    expect(stream.output).toBe(
      "[root]# " + BLUE + "dnf install fastfetch" + RESET + "\r\ninstalled\r\n",
    );
    assertLossless(chunks, stream);
  });

  it("多行命令逐行各自成对着色，行间的提示符不参与", () => {
    const chunks = ["[host tmp]# cd /tmp\r\n", "ls -l\r\n"];
    const stream = feed("cd /tmp\nls -l\n", chunks);

    expect(stream.output).toBe(
      "[host tmp]# " +
        BLUE +
        "cd /tmp" +
        RESET +
        "\r\n" +
        BLUE +
        "ls -l" +
        RESET +
        "\r\n",
    );
    assertLossless(chunks, stream);
  });

  it("分块的 OSC 7 不被染色，也不打断随后整行命令的匹配", () => {
    const chunks = [
      "\x1b]7;file://localhost",
      "/root\x07[root]# ls",
      " -l /var/www/html\r\n",
    ];
    const stream = feed("ls -l /var/www/html\n", chunks);

    expect(stream.output).toBe(
      "\x1b]7;file://localhost/root\x07[root]# " +
        BLUE +
        "ls -l /var/www/html" +
        RESET +
        "\r\n",
    );
    assertLossless(chunks, stream);
  });

  it("只回显了半行就换行时不着色（行内容不是这条命令）", () => {
    const chunks = ["dnf instal\r\n", "led something\r\n"];
    const stream = feed("dnf install fastfetch\n", chunks);

    expect(stream.output).toBe("dnf instal\r\nled something\r\n");
    assertLossless(chunks, stream);
  });

  it("命令没回显时丢弃匹配器要把扣留的字节交回去（不能吞输出）", () => {
    const echo = new AgentCommandEcho("ls -la\n");
    const held = echo.transform(encode("[root]# l"));

    expect(decode(held)).toBe("[root]# ");
    expect(decode(echo.discard())).toBe("l");
    expect(echo.discard().length).toBe(0);
  });

  it("扣留上限：候选被大量控制序列夹住时放弃匹配并原样放行", () => {
    const echo = new AgentCommandEcho("ls -la\n");
    const junk = "\x1b[1;1H".repeat(200);
    const first = decode(echo.transform(encode("l")));
    const rest = decode(echo.transform(encode(junk)));

    expect(first).toBe("");
    expect(first + rest).toBe("l" + junk);
  });
});

describe("AgentCommandEcho — 打字机模式（逐字注入）", () => {
  it("提示符边界之前不着色，边界之后的命令整段是蓝的", () => {
    const chunks = ["[root@server ~]# ", "rpm -q samba\r\n"];
    const stream = feed("rpm -q samba\n", chunks, true);

    expect(stream.output).toBe(
      "[root@server ~]# " + BLUE + "rpm -q samba" + RESET + "\r\n",
    );
    assertLossless(chunks, stream);
  });

  it("换行前必须收尾：蓝色不渗到下一行的提示符", () => {
    const chunks = ["# ", "dnf ins", "\r\n", "output lines\r\n"];
    const stream = feed("dnf install\n", chunks, true);

    expect(stream.output).toBe("# " + BLUE + "dnf ins" + RESET + "\r\noutput lines\r\n");
    assertLossless(chunks, stream);
  });

  it("中途撞上不匹配的字节时立刻收尾，把这一段留在同一行内", () => {
    const chunks = ["# dX\r\n"];
    const stream = feed("dnf install\n", chunks, true);

    expect(stream.output).toBe("# " + BLUE + "d" + RESET + "X\r\n");
    assertLossless(chunks, stream);
  });
});

describe("AgentCommandEcho — 通用护栏", () => {
  it("完全不相干的输出逐字节原样透传", () => {
    for (const progressive of [false, true]) {
      const echo = new AgentCommandEcho("uname -a\n", { progressive });
      const output = encode("permission denied\r\n");

      expect(echo.transform(output)).toEqual(output);
    }
  });
});
