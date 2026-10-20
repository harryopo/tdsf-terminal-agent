import { isTauriRuntime } from "@/lib/tauriRuntime";
import { osNotify } from "@/modules/agents/lib/notify";
import {
  BOOT_CHECK_DELAY_MS,
  describeUpdateFailure,
  readLastCheckAt,
  shouldAutoCheck,
  writeLastCheckAt,
} from "./updateFacts";
import { useUpdateStore } from "./updateStore";
import type { Update } from "@tauri-apps/plugin-updater";

const CHECK_TIMEOUT_MS = 15_000;

let heldUpdate: Update | null = null;
let notifiedVersion: string | null = null;
let checkRequest = 0;

function transferInProgress(): boolean {
  const phase = useUpdateStore.getState().phase;
  return (
    heldUpdate !== null &&
    (phase === "downloading" || phase === "ready" || phase === "installing")
  );
}

function closeUpdate(update: Update | null): void {
  if (update) {
    void update.close().catch(() => {
      console.warn("[update] 无法释放已不用的更新资源");
    });
  }
}

/** 下载与安装要用的那个更新对象。攥在这里，不让它进 zustand state（它是个资源句柄）。 */
export function getHeldUpdate(): Update | null {
  return heldUpdate;
}

export function releaseHeldUpdate(): void {
  const previous = heldUpdate;
  heldUpdate = null;
  checkRequest++;
  closeUpdate(previous);
}

export async function runUpdateCheck(
  opts: { force?: boolean } = {},
): Promise<void> {
  if (!isTauriRuntime() || transferInProgress()) return;
  const now = Date.now();
  if (!opts.force && !shouldAutoCheck(now, readLastCheckAt())) return;
  const store = useUpdateStore.getState();
  const request = ++checkRequest;
  const isCurrent = () => request === checkRequest && !transferInProgress();
  store.beginCheck();
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    if (!isCurrent()) return;
    const update = await check({ timeout: CHECK_TIMEOUT_MS });
    if (!isCurrent()) {
      if (update !== heldUpdate) closeUpdate(update);
      return;
    }
    const at = Date.now();
    // 查成功才记时刻：失败还写，等于让一次断网把用户挡在外面一整天
    writeLastCheckAt(at);
    if (!update || !update.available) {
      const previous = heldUpdate;
      releaseHeldUpdate();
      if (update !== previous) closeUpdate(update);
      store.markUpToDate(at);
      return;
    }
    const previous = heldUpdate;
    heldUpdate = update;
    if (previous !== update) closeUpdate(previous);
    store.markAvailable({
      version: update.version,
      notes: update.body ?? null,
      at,
    });
    if (notifiedVersion !== update.version) {
      notifiedVersion = update.version;
      // Windows 的 toast 点了只会把应用带到前台（插件 2.3.3 桌面端没有点击回调），
      // 所以这句话必须直接点名"点哪个"，不能说"见状态栏"就完事（#166 ⑤）
      void osNotify(
        "发现新版本",
        `TDSF Terminal Agent ${update.version} 可更新。点窗口右下角的「可更新 ${update.version}」标记即可查看并更新。`,
      );
    }
  } catch (error) {
    if (!isCurrent()) return;
    releaseHeldUpdate();
    store.markError(describeUpdateFailure(error));
  }
}

export function initUpdateCheckOnBoot(): void {
  if (!import.meta.env.PROD) return;
  setTimeout(() => {
    void runUpdateCheck();
  }, BOOT_CHECK_DELAY_MS);
}

export async function downloadHeldUpdate(): Promise<void> {
  if (transferInProgress()) return;
  const update = heldUpdate;
  const store = useUpdateStore.getState();
  if (!update) {
    store.markError("手上没有待安装的更新，请先检查更新。");
    return;
  }
  store.startDownload(null);
  const isCurrent = () =>
    heldUpdate === update &&
    useUpdateStore.getState().phase === "downloading";
  let received = 0;
  try {
    await update.download((event) => {
      if (!isCurrent()) return;
      const s = useUpdateStore.getState();
      if (event.event === "Started") {
        if (typeof event.data.contentLength === "number") {
          s.noteTotalBytes(event.data.contentLength);
        }
      } else if (event.event === "Progress") {
        received += event.data.chunkLength;
        s.noteProgress(received);
      }
    });
    if (isCurrent()) useUpdateStore.getState().markDownloaded();
  } catch (error) {
    if (!isCurrent()) return;
    releaseHeldUpdate();
    useUpdateStore.getState().markError(describeUpdateFailure(error));
  }
}
