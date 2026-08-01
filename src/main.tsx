/**
 * TDSF Terminal Agent — 应用入口（基于 terax-ai v0.8.6 上游 main.tsx 架构）
 * -----------------------------------------------------------------------------
 * 上游启动链 (crynta/terax-ai src/main.tsx)：
 *   1. xterm.css + globals.css
 *   2. USE_CUSTOM_WINDOW_CONTROLS → data-chrome="borderless"
 *   3. invoke("pty_close_all") 清理孤儿 PTY
 *   4. initLaunchDir() 解析启动目录
 *   5. render <App />（terax 壳 = src/app/App.tsx）
 *   6. setTimeout(showWindow, 50/500) — 窗口 visible:false 创建，
 *      首帧后由前端 show()，避免透明窗影闪烁
 *
 * TDSF 魔改：fontsource 字体 + Monaco Editor 本地加载（国内网络不走 CDN）
 */
import "@xterm/xterm/css/xterm.css";
import "./styles/globals.css";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { initLaunchDir } from "./lib/launchDir";
import { USE_CUSTOM_WINDOW_CONTROLS } from "./lib/platform";

// TDSF 魔改: fontsource 字体 (Inter Variable + JetBrains Mono)
import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/700.css";

// TDSF 魔改: Monaco Editor 本地加载 (避免 CDN, 国内网络不可靠)
import { loader } from "@monaco-editor/react";
import * as monaco from "monaco-editor";

loader.config({ monaco });

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
}

// 上游启动链: 清理上次会话遗留的孤儿 PTY (非 Tauri 环境静默失败)
await invoke("pty_close_all").catch(() => {});
await initLaunchDir();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);

// 上游窗口显示逻辑: visible:false 创建 → 首帧后 show()
// T2 透明窗口修复: 原 setTimeout(50/500ms) 在 React 首帧渲染前 show——
// App 初始化重（sidecar/workspace boot）时首帧可能 >500ms，窗口显示时
// WebView 未绘制 → 透明。改为：
//   1. 双 requestAnimationFrame：首帧真正绘制后再 show（标准做法）
//   2. 2s 兜底：极端慢机器保证最终显示
//   3. 窗口级 backgroundColor 已兜底（tauri.conf）——渲染前即不透明
const showWindow = () => {
  getCurrentWindow()
    .show()
    .catch((e) => console.error("window.show failed:", e));
};
requestAnimationFrame(() => requestAnimationFrame(showWindow));
setTimeout(showWindow, 2000);
