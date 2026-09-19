/**
 * 主窗这一侧的预测历史进出边界（P5）
 * -----------------------------------------------------------------------------
 * 两条链路都得钉住：
 *  1. 导入开关：用户关掉以后**连 histfile 都不该去读**（读了再丢掉不算关掉）；
 *     开着时导入，但手误行由 sanitizeShellHistory 挡在门外。
 *  2. 清空指令：设置窗是独立 JS context，清不到主窗的内存，所以主窗必须
 *     注册 tdsf:prediction-clear 监听，并且清空后本会话不再被回填。
 * 用 mock 把三条外部依赖钉住，正反两向都断言。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  loadHistoryFromRust: vi.fn(),
  parseShellHistory: vi.fn((content: string) => content.split("\n").filter(Boolean)),
  historyCommands: vi.fn(async () => ["git", "docker"]),
  flag: { value: true },
  listeners: [] as Array<{ event: string; cb: (e: unknown) => void }>,
}));

vi.mock("@/lib/shell-history", () => ({
  loadHistoryFromRust: h.loadHistoryFromRust,
  parseShellHistory: h.parseShellHistory,
}));
vi.mock("@/modules/terminal/block/lib/history", () => ({
  historyCommands: h.historyCommands,
}));
vi.mock("@/modules/settings/preferences", () => ({
  usePreferencesStore: {
    getState: () => ({ predictionImportShellHistory: h.flag.value }),
  },
}));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (event: string, cb: (e: unknown) => void) => {
    h.listeners.push({ event, cb });
    return () => undefined;
  },
  emitTo: async () => undefined,
}));

async function loadOnce() {
  const m = await import("./completionInjection");
  await m.loadHistoryIfNeeded();
  const { getSuggestEngine } = await import("@/lib/suggest-engine");
  return getSuggestEngine();
}

beforeEach(() => {
  vi.resetModules();
  h.loadHistoryFromRust.mockReset();
  h.historyCommands.mockClear();
  h.listeners.length = 0;
  h.flag.value = true;
  h.loadHistoryFromRust.mockResolvedValue({
    shellType: "powershell",
    commands: ["git status -sb", "gitstaus -hb"],
  });
});

describe("loadHistoryIfNeeded 导入开关", () => {
  it("关掉开关时连 shell 历史文件都不读（清空才不会被回填）", async () => {
    h.flag.value = false;
    const engine = await loadOnce();

    expect(h.loadHistoryFromRust).not.toHaveBeenCalled();
    expect(engine.getHistory("windows")).toEqual([]);
  });

  it("开着开关时导入，并把手误行过滤掉", async () => {
    h.flag.value = true;
    const engine = await loadOnce();

    expect(h.loadHistoryFromRust).toHaveBeenCalledTimes(1);
    const history = engine.getHistory("windows");
    expect(history).toContain("git");
    expect(history).not.toContain("gitstaus");
  });
});

describe("设置窗 → 主窗的清空指令", () => {
  it("主窗注册监听，收到事件后清掉两个环境且本会话不再回填", async () => {
    const m = await import("./completionInjection");
    m.initPredictionClearListener();
    await Promise.resolve();
    await Promise.resolve();

    const sub = h.listeners.find((l) => l.event === "tdsf:prediction-clear");
    expect(sub).toBeTruthy();

    const engine = (await import("@/lib/suggest-engine")).getSuggestEngine();
    engine.addHistory("git", "windows");
    engine.addHistory("ls", "linux");

    sub!.cb({ payload: null });
    expect(engine.getHistory("windows")).toEqual([]);
    expect(engine.getHistory("linux")).toEqual([]);

    // 清空后即使开关仍是 true，本会话也不该再去读 histfile 把历史灌回来
    h.flag.value = true;
    await m.loadHistoryIfNeeded();
    expect(h.loadHistoryFromRust).not.toHaveBeenCalled();
  });
});
