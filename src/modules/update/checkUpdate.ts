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

/** 下载与安装要用的那个更新对象。攥在这里，不让它进 zustand state（它是个资源句柄）。 */
export function getHeldUpdate(): Update | null {
  return heldUpdate;
}

export function releaseHeldUpdate(): void {
  heldUpdate = null;
}

export async function runUpdateCheck(
  opts: { force?: boolean } = {},
): Promise<void> {
  if (!isTauriRuntime()) return;
  const now = Date.now();
  if (!opts.force && !shouldAutoCheck(now, readLastCheckAt())) return;
  const store = useUpdateStore.getState();
  store.beginCheck();
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    const update = await check({ timeout: CHECK_TIMEOUT_MS });
    const at = Date.now();
    // 查成功才记时刻：失败还写，等于让一次断网把用户挡在外面一整天
    writeLastCheckAt(at);
    if (!update || !update.available) {
      heldUpdate = null;
      store.markUpToDate(at);
      return;
    }
    heldUpdate = update;
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
    heldUpdate = null;
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
  const update = heldUpdate;
  const store = useUpdateStore.getState();
  if (!update) {
    store.markError("手上没有待安装的更新，请先检查更新。");
    return;
  }
  store.startDownload(null);
  let received = 0;
  try {
    await update.download((event) => {
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
    useUpdateStore.getState().markDownloaded();
  } catch (error) {
    heldUpdate = null;
    useUpdateStore.getState().markError(describeUpdateFailure(error));
  }
}
