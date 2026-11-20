import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ check: vi.fn(), notify: vi.fn() }));

vi.mock("@tauri-apps/plugin-updater", () => ({ check: m.check }));
vi.mock("@/lib/tauriRuntime", () => ({ isTauriRuntime: () => true }));
vi.mock("@/modules/agents/lib/notify", () => ({ osNotify: m.notify }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function update(version: string) {
  return {
    available: true,
    version,
    body: null,
    close: vi.fn(async () => undefined),
    download: vi.fn<(onEvent?: (event: unknown) => void) => Promise<void>>(
      async () => undefined,
    ),
    install: vi.fn(async () => undefined),
  };
}

let checkUpdate: typeof import("./checkUpdate");
let store: (typeof import("./updateStore"))["useUpdateStore"];

beforeEach(async () => {
  vi.clearAllMocks();
  window.localStorage.clear();
  vi.resetModules();
  checkUpdate = await import("./checkUpdate");
  store = (await import("./updateStore")).useUpdateStore;
});

describe("更新检查生命周期", () => {
  it.each(["resolve", "reject"] as const)(
    "并发检查中较早请求%s时，迟到结果不能夺走较新结果",
    async (lateResult) => {
      const oldReply = deferred<ReturnType<typeof update> | null>();
      const newUpdate = update("1.0.4");
      m.check
        .mockReturnValueOnce(oldReply.promise)
        .mockResolvedValueOnce(newUpdate);

      const oldRequest = checkUpdate.runUpdateCheck({ force: true });
      await vi.waitFor(() => expect(m.check).toHaveBeenCalledTimes(1));
      const newRequest = checkUpdate.runUpdateCheck({ force: true });
      await vi.waitFor(() => expect(m.check).toHaveBeenCalledTimes(2));
      await newRequest;
      const newCheckedAt = store.getState().checkedAt;
      expect(checkUpdate.getHeldUpdate()).toBe(newUpdate);

      if (lateResult === "resolve") oldReply.resolve(update("1.0.3"));
      else oldReply.reject(new Error("late network failure"));
      await oldRequest;

      expect(checkUpdate.getHeldUpdate()).toBe(newUpdate);
      expect(store.getState()).toMatchObject({
        phase: "available",
        version: "1.0.4",
        checkedAt: newCheckedAt,
      });
      expect(m.notify).toHaveBeenCalledTimes(1);
      expect(m.notify).toHaveBeenCalledWith(
        "发现新版本",
        expect.stringContaining("1.0.4"),
      );
    },
  );

  it("下载、已就绪或安装中时，force 检查不发请求且保留对象和进度", async () => {
    const download = deferred<void>();
    let reportProgress: ((event: unknown) => void) | undefined;
    const held = update("1.0.4");
    held.download = vi.fn((onEvent?: (event: unknown) => void) => {
      reportProgress = onEvent;
      return download.promise;
    });
    m.check.mockResolvedValue(held);
    await checkUpdate.runUpdateCheck({ force: true });

    const downloading = checkUpdate.downloadHeldUpdate();
    await vi.waitFor(() => expect(held.download).toHaveBeenCalledTimes(1));
    reportProgress?.({ event: "Progress", data: { chunkLength: 7 } });
    await checkUpdate.runUpdateCheck({ force: true });
    expect(m.check).toHaveBeenCalledTimes(1);
    expect(checkUpdate.getHeldUpdate()).toBe(held);
    expect(store.getState()).toMatchObject({
      phase: "downloading",
      received: 7,
    });

    download.resolve();
    await downloading;
    await checkUpdate.runUpdateCheck({ force: true });
    expect(m.check).toHaveBeenCalledTimes(1);
    expect(checkUpdate.getHeldUpdate()).toBe(held);
    expect(store.getState().phase).toBe("ready");

    store.getState().setPhase("installing");
    await checkUpdate.runUpdateCheck({ force: true });
    expect(m.check).toHaveBeenCalledTimes(1);
    expect(checkUpdate.getHeldUpdate()).toBe(held);
    expect(store.getState().phase).toBe("installing");
  });

  it("同一更新的并发下载只派发一次", async () => {
    const download = deferred<void>();
    const oldUpdate = update("1.0.3");
    oldUpdate.download = vi.fn(() => download.promise);
    m.check.mockResolvedValue(oldUpdate);
    await checkUpdate.runUpdateCheck({ force: true });

    const firstDownload = checkUpdate.downloadHeldUpdate();
    await vi.waitFor(() => expect(oldUpdate.download).toHaveBeenCalledTimes(1));
    const duplicateDownload = checkUpdate.downloadHeldUpdate();
    await Promise.resolve();
    expect(oldUpdate.download).toHaveBeenCalledTimes(1);
    download.resolve();
    await Promise.all([firstDownload, duplicateDownload]);
  });

  it("释放后旧下载的 Started/Progress 和迟到拒绝不能改写新检查对象", async () => {
    const download = deferred<void>();
    let reportProgress: ((event: unknown) => void) | undefined;
    const oldUpdate = update("1.0.3");
    oldUpdate.download = vi.fn((onEvent?: (event: unknown) => void) => {
      reportProgress = onEvent;
      return download.promise;
    });
    const newUpdate = update("1.0.4");
    m.check.mockResolvedValueOnce(oldUpdate).mockResolvedValueOnce(newUpdate);
    await checkUpdate.runUpdateCheck({ force: true });

    const oldDownload = checkUpdate.downloadHeldUpdate();
    await vi.waitFor(() => expect(oldUpdate.download).toHaveBeenCalledTimes(1));
    checkUpdate.releaseHeldUpdate();
    await checkUpdate.runUpdateCheck({ force: true });
    const newCheckedAt = store.getState().checkedAt;
    reportProgress?.({ event: "Started", data: { contentLength: 500 } });
    reportProgress?.({ event: "Progress", data: { chunkLength: 99 } });
    download.reject(new Error("late download failure"));
    await oldDownload;

    expect(checkUpdate.getHeldUpdate()).toBe(newUpdate);
    expect(store.getState()).toMatchObject({
      phase: "available",
      version: "1.0.4",
      checkedAt: newCheckedAt,
      bytes: null,
      received: 0,
    });
  });
});
