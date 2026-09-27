import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  BOOT_CHECK_DELAY_MS,
  UPDATE_CHECK_INTERVAL_MS,
  writeLastCheckAt,
} from "./updateFacts";

const m = vi.hoisted(() => ({
  check: vi.fn(),
  notify: vi.fn(),
  isTauri: true,
}));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: m.check }));
vi.mock("@/lib/tauriRuntime", () => ({
  isTauriRuntime: () => m.isTauri,
}));
vi.mock("@/modules/agents/lib/notify", () => ({ osNotify: m.notify }));

type CheckModule = typeof import("./checkUpdate");
let mod: CheckModule;
let useStore: (typeof import("./updateStore"))["useUpdateStore"];

beforeEach(async () => {
  vi.clearAllMocks();
  vi.useRealTimers();
  window.localStorage.clear();
  m.isTauri = true;
  // 模块级的"手上那个更新对象"和"这条版本已经通知过"都是进程内状态，
  // 每个用例重新求值一次，否则用例之间互相影响（通知只发一次那条会假绿/假红）。
  vi.resetModules();
  mod = await import("./checkUpdate");
  useStore = (await import("./updateStore")).useUpdateStore;
});

function updateFixture(over: Record<string, unknown> = {}) {
  return {
    available: true,
    version: "1.0.2",
    body: "修了两条命令",
    date: undefined,
    download: vi.fn(async (onEvent?: (e: unknown) => void) => {
      onEvent?.({ event: "Started", data: { contentLength: 219_060_856 } });
      onEvent?.({ event: "Progress", data: { chunkLength: 1_048_576 } });
    }),
    install: vi.fn(async () => undefined),
    ...over,
  };
}

describe("开发版不许去查更新", () => {
  it("PROD 为 false ⇒ 过多久都不发请求", async () => {
    vi.stubEnv("PROD", false);
    m.check.mockResolvedValue(null);
    vi.useFakeTimers();
    mod.initUpdateCheckOnBoot();
    // 必须用 *Async 版本推进：到点后 runUpdateCheck 里还有一步 await import，
    // 只 advanceTimersByTime 不冲微任务 ⇒ "没发请求"会因为"还没跑到"而假绿。
    await vi.advanceTimersByTimeAsync(BOOT_CHECK_DELAY_MS * 3);
    expect(m.check).not.toHaveBeenCalled();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("发布版：到点才查（不在首屏抢启动自动连接的时机）", async () => {
    vi.stubEnv("PROD", true);
    m.check.mockResolvedValue(null);
    vi.useFakeTimers();
    mod.initUpdateCheckOnBoot();
    vi.advanceTimersByTime(BOOT_CHECK_DELAY_MS - 1);
    expect(m.check).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(m.check).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });
});

describe("24 小时节流", () => {
  it("刚查过 ⇒ 自动请求不发出去", async () => {
    writeLastCheckAt(Date.now());
    await mod.runUpdateCheck();
    expect(m.check).not.toHaveBeenCalled();
  });

  it("手动检查（force）可以越过节流", async () => {
    writeLastCheckAt(Date.now());
    m.check.mockResolvedValue(null);
    await mod.runUpdateCheck({ force: true });
    expect(m.check).toHaveBeenCalledTimes(1);
  });

  it("满一天后自动放行", async () => {
    writeLastCheckAt(Date.now() - UPDATE_CHECK_INTERVAL_MS - 1);
    m.check.mockResolvedValue(null);
    await mod.runUpdateCheck();
    expect(m.check).toHaveBeenCalledTimes(1);
  });
});

describe("检查结果必须落成看得见的状态", () => {
  it("没有新版 ⇒ up-to-date，并记下这次查的时刻", async () => {
    m.check.mockResolvedValue(null);
    await mod.runUpdateCheck();
    const s = useStore.getState();
    expect(s.phase).toBe("up-to-date");
    expect(s.checkedAt).not.toBeNull();
  });

  it("有新版 ⇒ available + 版本号 + 发一次通知", async () => {
    m.check.mockResolvedValue(updateFixture());
    await mod.runUpdateCheck({ force: true });
    expect(useStore.getState().phase).toBe("available");
    expect(useStore.getState().version).toBe("1.0.2");
    expect(m.notify).toHaveBeenCalledTimes(1);
  });

  it("同一个版本查两次不重复通知", async () => {
    m.check.mockResolvedValue(updateFixture());
    await mod.runUpdateCheck({ force: true });
    await mod.runUpdateCheck({ force: true });
    expect(m.notify).toHaveBeenCalledTimes(1);
  });

  it("新版本换了 ⇒ 要再通知一次", async () => {
    m.check.mockResolvedValue(updateFixture());
    await mod.runUpdateCheck({ force: true });
    m.check.mockResolvedValue(updateFixture({ version: "1.0.3" }));
    await mod.runUpdateCheck({ force: true });
    expect(m.notify).toHaveBeenCalledTimes(2);
  });

  it("查失败 ⇒ error，且**不许**记这次时刻（否则一次断网把人挡一整天）", async () => {
    m.check.mockRejectedValue(new Error("dns error: no records"));
    await mod.runUpdateCheck();
    const s = useStore.getState();
    expect(s.phase).toBe("error");
    expect(s.error).toContain("连不上更新服务器");
    expect(window.localStorage.getItem("tdsf-update-last-check")).toBeNull();
  });

  it("非桌面运行时（纯浏览器 dev / vitest）一声不响，不报假失败", async () => {
    m.isTauri = false;
    await mod.runUpdateCheck({ force: true });
    expect(m.check).not.toHaveBeenCalled();
    expect(useStore.getState().phase).toBe("idle");
  });
});

describe("下载", () => {
  it("进度事件落成总字节与已下载字节", async () => {
    const update = updateFixture();
    m.check.mockResolvedValue(update);
    await mod.runUpdateCheck({ force: true });
    await mod.downloadHeldUpdate();
    const s = useStore.getState();
    expect(s.phase).toBe("ready");
    expect(s.bytes).toBe(219_060_856);
    expect(s.received).toBe(1_048_576);
    expect(update.download).toHaveBeenCalledTimes(1);
  });

  it("没检查过就点下载 ⇒ 明确说没有待安装的更新，不去调插件", async () => {
    await mod.downloadHeldUpdate();
    expect(useStore.getState().phase).toBe("error");
    expect(useStore.getState().error).toContain("请先检查更新");
  });

  it("下载失败 ⇒ error 且手上对象丢掉（不许拿半成品去装）", async () => {
    const update = updateFixture({
      download: vi.fn(async () => {
        throw new Error("HTTP status code: 403");
      }),
    });
    m.check.mockResolvedValue(update);
    await mod.runUpdateCheck({ force: true });
    await mod.downloadHeldUpdate();
    expect(useStore.getState().phase).toBe("error");
    await mod.downloadHeldUpdate();
    expect(update.download).toHaveBeenCalledTimes(1);
  });
});
