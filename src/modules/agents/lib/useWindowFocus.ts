import { isTauriRuntime } from "@/lib/tauriRuntime";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useEffect, useState } from "react";

export function useWindowFocus(): boolean {
  const [focused, setFocused] = useState(() =>
    typeof document !== "undefined" ? document.hasFocus() : true,
  );

  useEffect(() => {
    // TDSF 魔改: dev 模式 (无 Tauri 运行时) 跳过 focus 监听
    if (!isTauriRuntime()) {
      if (typeof console !== "undefined") {
        console.debug("[useWindowFocus] dev mode, follow document.hasFocus()");
      }
      const onFocus = () => setFocused(true);
      const onBlur = () => setFocused(false);
      window.addEventListener("focus", onFocus);
      window.addEventListener("blur", onBlur);
      return () => {
        window.removeEventListener("focus", onFocus);
        window.removeEventListener("blur", onBlur);
      };
    }
    let alive = true;
    let unlisten: (() => void) | undefined;
    getCurrentWindow()
      .onFocusChanged(({ payload }) => setFocused(payload))
      .then((u) => {
        if (alive) unlisten = u;
        else u();
      })
      .catch(() => {});
    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  return focused;
}
