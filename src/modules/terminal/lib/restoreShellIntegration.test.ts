import { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { restoreShellIntegration } from "./restoreShellIntegration";

const ST = `${String.fromCharCode(27)}\\`;
const conn = "0123456789abcdef0123456789abcdef";
const otherConn = "fedcba9876543210fedcba9876543210";
const hooks = `/tmp/tdsf-osc7-${conn}.hooks.bash`;
const osc = (code: number, data: string) => `${String.fromCharCode(27)}]${code};${data}${ST}`;
const feed = (term: Terminal, data: string) =>
  new Promise<void>((resolve) => term.write(data, resolve));
const terminals: Terminal[] = [];
const controllers: AbortController[] = [];

function setup(
  write: (data: string) => boolean | void | Promise<void> = () => true,
  signal?: AbortSignal,
) {
  const term = new Terminal({ cols: 80, rows: 24 });
  terminals.push(term);
  let command = "";
  let current = true;
  const promise = restoreShellIntegration({
    term,
    context: { connectionId: conn, bashHooksPath: hooks },
    write: (data) => { command = data; return write(data); },
    isCurrent: () => current,
    signal,
  });
  void promise.catch(() => undefined);
  const request = () => {
    const match = command.match(/P;TdsfRestore=([0-9a-f]{32});([0-9a-f]{32});/);
    expect(match?.[1]).toBe(conn);
    expect(command.match(/\r/g)).toHaveLength(1);
    return match?.[2] ?? "";
  };
  return { term, promise, request, setCurrent: (value: boolean) => { current = value; } };
}

function context(id = conn, shell = "123-11-22", cwd = "/home/alice", user = "alice") {
  return osc(633, `P;TdsfContext=${id};${shell};${encodeURIComponent(user)};${encodeURIComponent(cwd)}`);
}

function ack(id: string, request: string, shell = "123-11-22") {
  return osc(633, `P;TdsfRestore=${id};${request};${shell}`);
}

afterEach(() => {
  terminals.splice(0).forEach((term) => term.dispose());
  controllers.splice(0).forEach((controller) => controller.abort());
  vi.useRealTimers();
});

describe("restoreShellIntegration", () => {
  it("resolves only after matching ACK then matching shell Context", async () => {
    const h = setup();
    await feed(h.term, ack(conn, h.request()));
    await feed(h.term, context());
    await expect(h.promise).resolves.toEqual({ connectionId: conn, shell: "123-11-22", user: "alice", cwd: "/home/alice" });
    h.term.dispose();
  });

  it("does not resolve from ordinary Context before its request ACK", async () => {
    const h = setup();
    await feed(h.term, context());
    let settled = false;
    void h.promise.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await feed(h.term, ack(conn, h.request()));
    await feed(h.term, context());
    await expect(h.promise).resolves.toMatchObject({ connectionId: conn, shell: "123-11-22" });
    h.term.dispose();
  });

  it("ignores wrong connection, nonce, shell, and ordinary command markers", async () => {
    const h = setup();
    const request = h.request();
    await feed(h.term, ack(otherConn, request) + context(otherConn) + ack(conn, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") + context(conn, "999-1-1") + osc(133, "A"));
    let settled = false;
    void h.promise.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    await feed(h.term, ack(conn, request) + context());
    await expect(h.promise).resolves.toMatchObject({ connectionId: conn, shell: "123-11-22" });
  });

  it("rejects an explicit unavailable response", async () => {
    const h = setup();
    await feed(h.term, osc(633, `P;TdsfRestoreFailed=${conn};${h.request()};unavailable`));
    await expect(h.promise).rejects.toBeDefined();
    h.term.dispose();
  });

  it("rejects when the command write returns false or rejects", async () => {
    const noWrite = setup(() => false);
    await expect(noWrite.promise).rejects.toBeDefined();
    noWrite.term.dispose();
    const failedWrite = setup(() => Promise.reject(new Error("write failed")));
    await expect(failedWrite.promise).rejects.toThrow("write failed");
    failedWrite.term.dispose();
  });

  it("writes one guarded source command without resetting the prompt or shell", async () => {
    const controller = new AbortController();
    controllers.push(controller);
    const term = new Terminal({ cols: 80, rows: 24 });
    terminals.push(term);
    let command = "";
    const pending = restoreShellIntegration({
      term,
      context: { connectionId: conn, bashHooksPath: hooks },
      write: (data) => { command = data; return true; },
      isCurrent: () => true,
      signal: controller.signal,
    });
    void pending.catch(() => undefined);
    expect(command).toContain(`if [ -n "\${BASH_VERSION:-}" ] && [ -r '${hooks}' ]`);
    expect(command).toContain(`source '${hooks}' --tdsf-debug-unclaimed`);
    expect(command).toContain(`source '${hooks}'`);
    expect(command).toContain(`trap -p DEBUG`);
    expect(command).toContain(`shopt -q extdebug`);
    expect(command.match(/\r/g)).toHaveLength(1);
    expect(command).not.toMatch(/\x03|\x1b\[2J|\\033\[2J|\.bashrc|\.bash_profile|PS1|EXIT|\bclear\b/);
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  });

  it("rejects invalid connection identity or hooks path before writing, with valid path as control", async () => {
    const term = new Terminal({ cols: 80, rows: 24 });
    terminals.push(term);
    const write = vi.fn(() => true);
    await expect(restoreShellIntegration({
      term,
      context: { connectionId: conn, bashHooksPath: `${hooks}.other` },
      write,
      isCurrent: () => true,
    })).rejects.toBeDefined();
    await expect(restoreShellIntegration({
      term,
      context: { connectionId: "invalid", bashHooksPath: "/tmp/tdsf-osc7-invalid.hooks.bash" },
      write,
      isCurrent: () => true,
    })).rejects.toBeDefined();
    expect(write).not.toHaveBeenCalled();

    const controller = new AbortController();
    controllers.push(controller);
    const validWrite = vi.fn(() => true);
    const valid = restoreShellIntegration({
      term,
      context: { connectionId: conn, bashHooksPath: hooks },
      write: validWrite,
      isCurrent: () => true,
      signal: controller.signal,
    });
    void valid.catch(() => undefined);
    expect(validWrite).toHaveBeenCalledOnce();
    controller.abort();
    await expect(valid).rejects.toBeDefined();
  });

  it("rejects on abort or stale ownership", async () => {
    const controller = new AbortController();
    controllers.push(controller);
    const term = new Terminal({ cols: 80, rows: 24 });
    terminals.push(term);
    const aborted = restoreShellIntegration({ term, context: { connectionId: conn, bashHooksPath: hooks }, write: () => true, isCurrent: () => true, signal: controller.signal });
    controller.abort();
    await expect(aborted).rejects.toBeDefined();
    term.dispose();
    const stale = setup();
    stale.setCurrent(false);
    await feed(stale.term, ack(conn, stale.request()));
    await expect(stale.promise).rejects.toBeDefined();
  });

  it("rejects if ownership changes after ACK but before Context", async () => {
    const h = setup();
    await feed(h.term, ack(conn, h.request()));
    h.setCurrent(false);
    await feed(h.term, context());
    await expect(h.promise).rejects.toBeDefined();
    h.term.dispose();
  });

  it("rejects after the fixed 12 second deadline", async () => {
    vi.useFakeTimers();
    const h = setup();
    const assertion = expect(h.promise).rejects.toBeDefined();
    await vi.advanceTimersByTimeAsync(12_001);
    await assertion;
    h.term.dispose();
  });

  it("does not accept a receipt after terminal disposal", async () => {
    const controller = new AbortController();
    controllers.push(controller);
    const h = setup(() => true, controller.signal);
    await feed(h.term, ack(conn, h.request()));
    h.term.dispose();
    let settled = false;
    void h.promise.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    controller.abort();
    await expect(h.promise).rejects.toBeDefined();
  });
});
