// TDSF 魔改 2026-07-28: 必须最先导入 tauriMock, 在所有 @tauri-apps/api 模块加载前
// 注入 __TAURI_INTERNALS__ stub. 否则 dev 浏览器模式会因为找不到 Tauri runtime
// 抛 "Cannot read properties of undefined (reading 'invoke')" 错误, 整个 Settings 渲染不出.
import "../lib/tauriMock";

import "../styles/globals.css";

import { USE_CUSTOM_WINDOW_CONTROLS } from "@/lib/platform";
import { isTauriRuntime } from "@/lib/tauriRuntime";
import { ThemeProvider } from "@/modules/theme";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactDOM from "react-dom/client";
import { SettingsApp } from "./SettingsApp";

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
}

ReactDOM.createRoot(
  document.getElementById("settings-root") as HTMLElement,
).render(
  <ThemeProvider>
    <SettingsApp />
  </ThemeProvider>,
);

// TDSF 魔改: dev 模式 (无 Tauri 运行时) 跳过 show window 调用
if (isTauriRuntime()) {
  const showWindow = () => {
    getCurrentWindow()
      .show()
      .catch((e) => console.error("settings show failed:", e));
  };
  setTimeout(showWindow, 50);
  setTimeout(showWindow, 500);
}
