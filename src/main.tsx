/**
 * TDSF Terminal Agent — 应用入口（基于 terax-ai v0.8.6 上游 main.tsx 架构）
 * -----------------------------------------------------------------------------
 * 上游启动链 (crynta/terax-ai src/main.tsx)：
 *   1. xterm.css + globals.css
 *   2. USE_CUSTOM_WINDOW_CONTROLS → data-chrome="borderless"
 *   3. invoke("pty_close_all") 清理孤儿 PTY
 *   4. initLaunchDir() 解析启动目录
 *   5. render <App />（terax 壳 = src/app/App.tsx）
 *
 * TDSF 魔改：fontsource 字体 + Monaco Editor 本地加载（国内网络不走 CDN）
 *
 * TDSF 永久修复 (2026-08-09): 窗口可见性不再由前端 JS 控制。
 * 上游用 visible:false + setTimeout(show) 来避免 borderless 透明窗口的闪烁，
 * 但这让 HMR 页面重载后窗口可能永远不可见（show 时机竞态）。
 * 现在 tauri.conf.json 已改为 visible:true，窗口启动即不可见改为直接可见，
 * 配合 backgroundColor:"#1a1a1a" 确保 CSS 加载前不闪白屏。
 * 前端只负责 setFocus（确保窗口在前台），不再负责 show。
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

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
}

// 稳定性修复 (2026-08-15): 先渲染 UI，再异步初始化。
// 之前用顶层 await 串行等待 invoke + initLaunchDir 完成后才 render，
// 若 IPC 在 WebView2 冷启动时挂起（不 reject 只 hang），render 永远不执行 = 黑屏。
// 现在 render 立即同步执行，IPC 初始化在后台异步完成，互不阻塞。
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <App />,
);

// 异步初始化（不阻塞渲染）：清理上次会话遗留的孤儿 PTY + 解析启动目录。
// 非阻塞设计：即使某项 IPC 挂起，UI 也已渲染，不会黑屏。
invoke("pty_close_all").catch(() => {});
initLaunchDir().catch(() => {});

// 窗口已在 tauri.conf.json 中以 visible:true 启动，无需前端 show()。
// 此处只做 setFocus 确保窗口在前台（不涉及可见性控制）。
getCurrentWindow()
  .setFocus()
  .catch(() => {});
