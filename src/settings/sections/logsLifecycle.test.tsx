import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { AgentHistorySection } from "./AgentHistorySection";
import { RuntimeLogsSection } from "./RuntimeLogsSection";

const { isTauriMock, invokeRpcMock } = vi.hoisted(() => ({
  isTauriMock: vi.fn(),
  invokeRpcMock: vi.fn(),
}));

vi.mock("@/lib/tauriRuntime", () => ({
  isTauriRuntime: () => isTauriMock(),
}));

vi.mock("@/lib/sidecar-bridge", () => ({
  invokeRpc: (...args: unknown[]) => invokeRpcMock(...args),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function openSelect(trigger: HTMLElement) {
  fireEvent.pointerDown(trigger, {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

function chooseOption(option: HTMLElement) {
  act(() => {
    option.focus();
    fireEvent.keyDown(option, { key: "Enter" });
  });
}

const sessions = {
  ok: true,
  files: [
    {
      session_id: "session-alpha-1234",
      file: "session-alpha-1234.jsonl",
      size: 1024,
      mtime: 1700000000,
    },
  ],
  latest_session_id: "session-alpha-1234",
};

beforeEach(() => {
  isTauriMock.mockReset();
  isTauriMock.mockReturnValue(true);
  invokeRpcMock.mockReset();
  Object.defineProperty(HTMLElement.prototype, "hasPointerCapture", {
    configurable: true,
    value: () => false,
  });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: () => undefined,
  });
  Object.defineProperty(HTMLElement.prototype, "releasePointerCapture", {
    configurable: true,
    value: () => undefined,
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("settings log lifecycle", () => {
  it("Agent History opens the real event filter with all events and leaves default type unset", async () => {
    invokeRpcMock.mockImplementation(
      (_method: string, params?: Record<string, unknown>) =>
        params?.session_id
          ? Promise.resolve({ ok: true, lines: [], total_in_file: 0 })
          : Promise.resolve(sessions),
    );
    render(<AgentHistorySection />);

    await waitFor(() => {
      expect(invokeRpcMock).toHaveBeenCalledWith("debug.agent_log_tail", {
        session_id: "session-alpha-1234",
        lines: 200,
      });
    });
    expect(
      invokeRpcMock.mock.calls.some(([, params]) => "type" in (params ?? {})),
    ).toBe(false);

    const filter = screen.getAllByRole("combobox")[1];
    expect(() => openSelect(filter)).not.toThrow();
    expect(
      await screen.findByRole("option", { name: "全部事件" }),
    ).toBeTruthy();
  });

  it("Agent History reports an unsuccessful response without rendering its lines", async () => {
    invokeRpcMock.mockImplementation(
      (_method: string, params?: Record<string, unknown>) =>
        params?.session_id
          ? Promise.resolve({
              ok: false,
              error: "history read failed",
              lines: [{ type: "user_msg", content: "temporary event alpha" }],
            })
          : Promise.resolve(sessions),
    );
    render(<AgentHistorySection />);

    expect(await screen.findByText("history read failed")).toBeTruthy();
    expect(screen.queryByText("temporary event alpha")).toBeNull();
  });

  it("Agent History reports an unsuccessful session-list response", async () => {
    invokeRpcMock.mockResolvedValue({
      ok: false,
      error: "session list unavailable",
    });
    render(<AgentHistorySection />);

    expect(await screen.findByText("session list unavailable")).toBeTruthy();
  });

  it("Agent History ignores a late response after the user selects another event filter", async () => {
    const oldFilter = deferred<{
      ok: true;
      lines: { type: string; content: string }[];
      total_in_file: number;
    }>();
    invokeRpcMock.mockImplementation(
      (_method: string, params?: Record<string, unknown>) => {
        if (!params?.session_id) return Promise.resolve(sessions);
        if (params.type === "reasoning") return oldFilter.promise;
        if (params.type === "tool_call")
          return Promise.resolve({
            ok: true,
            lines: [{ type: "tool_call", content: "current event beta" }],
            total_in_file: 1,
          });
        return Promise.resolve({ ok: true, lines: [], total_in_file: 0 });
      },
    );
    render(<AgentHistorySection />);
    await waitFor(() =>
      expect(invokeRpcMock).toHaveBeenCalledWith(
        "debug.agent_log_tail",
        expect.objectContaining({ session_id: "session-alpha-1234" }),
      ),
    );

    const filter = screen.getAllByRole("combobox")[1];
    openSelect(filter);
    const reasoningOption = await screen.findByRole("option", { name: "思考" });
    chooseOption(reasoningOption);
    await waitFor(() =>
      expect(invokeRpcMock).toHaveBeenCalledWith(
        "debug.agent_log_tail",
        expect.objectContaining({ type: "reasoning" }),
      ),
    );
    expect(screen.getAllByRole("combobox")[1].textContent).toContain("思考");

    openSelect(screen.getAllByRole("combobox")[1]);
    expect(
      (await screen.findByRole("option", { name: "思考" })).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
    const toolOption = await screen.findByRole("option", { name: "工具调用" });
    chooseOption(toolOption);
    await waitFor(() =>
      expect(invokeRpcMock).toHaveBeenCalledWith(
        "debug.agent_log_tail",
        expect.objectContaining({ type: "tool_call" }),
      ),
    );
    expect(screen.getAllByRole("combobox")[1].textContent).toContain(
      "工具调用",
    );
    expect(await screen.findByText("current event beta")).toBeTruthy();
    await act(async () =>
      oldFilter.resolve({
        ok: true,
        lines: [{ type: "reasoning", content: "stale event alpha" }],
        total_in_file: 1,
      }),
    );
    expect(screen.queryByText("stale event alpha")).toBeNull();
    expect(screen.getByText("current event beta")).toBeTruthy();
  });

  it("Runtime Logs ignores a late response after changing the level filter", async () => {
    const oldFilter = deferred<{
      ok: true;
      lines: { ts: number; level: string; msg: string }[];
      total: number;
    }>();
    invokeRpcMock.mockImplementation(
      (_method: string, params?: Record<string, unknown>) => {
        if (params?.level_filter === "DEBUG") return oldFilter.promise;
        if (params?.level_filter === "ERROR")
          return Promise.resolve({
            ok: true,
            lines: [
              { ts: 1700000002, level: "ERROR", msg: "current log beta" },
            ],
            total: 1,
          });
        return Promise.resolve({ ok: true, lines: [], total: 0 });
      },
    );
    render(<RuntimeLogsSection />);

    const filter = screen.getByRole("combobox");
    openSelect(filter);
    const debugOption = await screen.findByRole("option", { name: "调试" });
    chooseOption(debugOption);
    await waitFor(() =>
      expect(invokeRpcMock).toHaveBeenCalledWith("log.tail", {
        lines: 300,
        level_filter: "DEBUG",
      }),
    );
    expect(screen.getByRole("combobox").textContent).toContain("调试");

    openSelect(screen.getByRole("combobox"));
    expect(
      (await screen.findByRole("option", { name: "调试" })).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
    const errorOption = await screen.findByRole("option", { name: "错误" });
    chooseOption(errorOption);
    await waitFor(() =>
      expect(invokeRpcMock).toHaveBeenCalledWith("log.tail", {
        lines: 300,
        level_filter: "ERROR",
      }),
    );
    expect(screen.getByRole("combobox").textContent).toContain("错误");
    expect(await screen.findByText("current log beta")).toBeTruthy();
    await act(async () =>
      oldFilter.resolve({
        ok: true,
        lines: [{ ts: 1700000001, level: "DEBUG", msg: "stale log alpha" }],
        total: 1,
      }),
    );
    expect(screen.queryByText("stale log alpha")).toBeNull();
    expect(screen.getByText("current log beta")).toBeTruthy();
  });

  it("Runtime Logs ignores an error from a superseded filter request", async () => {
    const oldFilter = deferred<{ ok: true; lines: never[]; total: number }>();
    invokeRpcMock.mockImplementation(
      (_method: string, params?: Record<string, unknown>) => {
        if (params?.level_filter === "DEBUG") return oldFilter.promise;
        if (params?.level_filter === "INFO")
          return Promise.resolve({
            ok: true,
            lines: [
              { ts: 1700000002, level: "INFO", msg: "current log gamma" },
            ],
            total: 1,
          });
        return Promise.resolve({ ok: true, lines: [], total: 0 });
      },
    );
    render(<RuntimeLogsSection />);

    openSelect(screen.getByRole("combobox"));
    const debugOption = await screen.findByRole("option", { name: "调试" });
    chooseOption(debugOption);
    await waitFor(() =>
      expect(invokeRpcMock).toHaveBeenCalledWith("log.tail", {
        lines: 300,
        level_filter: "DEBUG",
      }),
    );

    openSelect(screen.getByRole("combobox"));
    const infoOption = await screen.findByRole("option", { name: "信息" });
    chooseOption(infoOption);
    await waitFor(() =>
      expect(invokeRpcMock).toHaveBeenCalledWith("log.tail", {
        lines: 300,
        level_filter: "INFO",
      }),
    );
    expect(await screen.findByText("current log gamma")).toBeTruthy();

    await act(async () =>
      oldFilter.reject(new Error("superseded filter failed")),
    );
    expect(screen.queryByText("superseded filter failed")).toBeNull();
    expect(screen.getByText("current log gamma")).toBeTruthy();
  });

  it("Runtime Logs does not overlap automatic refresh requests for the same filter", async () => {
    vi.useFakeTimers();
    const pending = deferred<{ ok: true; lines: never[]; total: number }>();
    invokeRpcMock.mockReturnValue(pending.promise);
    render(<RuntimeLogsSection />);
    expect(invokeRpcMock).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "自动刷新：关" }));

    await act(async () => vi.advanceTimersByTimeAsync(6000));
    expect(invokeRpcMock).toHaveBeenCalledTimes(1);
    await act(async () => pending.resolve({ ok: true, lines: [], total: 0 }));
    await act(async () => vi.advanceTimersByTimeAsync(2000));
    expect(invokeRpcMock).toHaveBeenCalledTimes(2);
  });

  it("Runtime Logs clears old-filter lines when the current filter RPC fails", async () => {
    invokeRpcMock.mockImplementation(
      (_method: string, params?: Record<string, unknown>) =>
        params?.level_filter === "ERROR"
          ? Promise.resolve({
              ok: true,
              lines: [
                { ts: 1700000001, level: "ERROR", msg: "old filter log alpha" },
              ],
              total: 1,
            })
          : Promise.reject(new Error("current filter unavailable")),
    );
    render(<RuntimeLogsSection />);
    openSelect(screen.getByRole("combobox"));
    const errorOption = await screen.findByRole("option", { name: "错误" });
    chooseOption(errorOption);
    await waitFor(() =>
      expect(invokeRpcMock).toHaveBeenCalledWith("log.tail", {
        lines: 300,
        level_filter: "ERROR",
      }),
    );
    expect(await screen.findByText("old filter log alpha")).toBeTruthy();

    openSelect(screen.getByRole("combobox"));
    expect(
      (await screen.findByRole("option", { name: "错误" })).getAttribute(
        "aria-selected",
      ),
    ).toBe("true");
    const infoOption = await screen.findByRole("option", { name: "信息" });
    chooseOption(infoOption);
    await waitFor(() =>
      expect(invokeRpcMock).toHaveBeenCalledWith("log.tail", {
        lines: 300,
        level_filter: "INFO",
      }),
    );
    expect(await screen.findByText("current filter unavailable")).toBeTruthy();
    expect(screen.queryByText("old filter log alpha")).toBeNull();
  });

  it("Runtime Logs preserves the visible logs and reports a failed clear RPC", async () => {
    invokeRpcMock.mockImplementation((method: string) => {
      if (method === "log.clear")
        return Promise.resolve({ ok: false, error: "clear refused" });
      return Promise.resolve({
        ok: true,
        lines: [{ ts: 1700000001, level: "INFO", msg: "retained log delta" }],
        total: 1,
      });
    });
    render(<RuntimeLogsSection />);
    expect(await screen.findByText("retained log delta")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "清空" }));
    expect(await screen.findByText("clear refused")).toBeTruthy();
    expect(screen.getByText("retained log delta")).toBeTruthy();
  });
});
