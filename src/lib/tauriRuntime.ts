// TDSF 魔改 (P5 浏览器降级): Tauri runtime 检测
// -----------------------------------------------------------------------------
// 在 pnpm dev (纯浏览器) 模式下, @tauri-apps/api 的 invoke / listen / getCurrentWindow
// 都会因为 `window.__TAURI_INTERNALS__` 不存在而抛 TypeError, 整个 app 渲染不出来。
// 解决: 提供 isTauriRuntime() 检测, 关键 Tauri 调用前先 guard, dev 模式降级为 noop。

/** 是否运行在 Tauri 桌面运行时中 (生产模式) */
export function isTauriRuntime(): boolean {
  if (typeof window === "undefined") return false;
  // Tauri 2.x 在 webview window 上挂 __TAURI_INTERNALS__ 标识
  return "__TAURI_INTERNALS__" in window;
}

/** Tauri 调用兜底包装: 运行时不存在时静默 noop, 不抛错 */
export async function safeTauriInvoke<T = unknown>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T | null> {
  if (!isTauriRuntime()) {
    if (typeof console !== "undefined") {
      console.debug(`[safeTauri] dev mode, skip invoke('${cmd}')`);
    }
    return null;
  }
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke<T>(cmd, args);
}
