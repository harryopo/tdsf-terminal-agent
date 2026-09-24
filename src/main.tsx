/**
 * TDSF Terminal Agent — 应用入口（沿用上游开源项目的启动链架构）
 * -----------------------------------------------------------------------------
 * 上游启动链（开源项目 src/main.tsx）：
 *   1. xterm.css + globals.css
 *   2. USE_CUSTOM_WINDOW_CONTROLS → data-chrome="borderless"
 *   3. invoke("pty_close_all") 清理孤儿 PTY
 *   4. initLaunchDir() 解析启动目录
 *   5. render <App />（应用主壳 = src/app/App.tsx）
 *
 * TDSF：fontsource 字体 + Monaco Editor 本地加载（国内网络不走 CDN）
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
import { ErrorBoundary } from "./components/ErrorBoundary";
import { initLaunchDir } from "./lib/launchDir";
import { USE_CUSTOM_WINDOW_CONTROLS } from "./lib/platform";
import { startSshBootReap } from "./modules/ssh-explorer/lib/sshGenerationReap";

// TDSF: fontsource 字体 (Inter Variable + JetBrains Mono)
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
//
// 2026-09-24 (#125): 根挂载点必须有边界。此前 ErrorBoundary 只包住了侧栏那一格，
// 挂在 App 顶层的弹窗一抛错，React 18 直接把整棵树卸载 ⇒ #root 子节点 0、整窗白屏，
// 用户看到的是"程序卡死"。根这一层是最后一道：任何没被区域边界接住的崩溃，
// 至少要说清"出错了 + 可以重试/重载"，而不是留一块空白。
// #126（2026-09-24）：**启动回收必须在渲染之前触发，不能挂在 React effect 上**。
// Rust 的 SSH 会话注册表活在进程里，而"该收哪几条"是页面这一代的账；渲染挂了（白屏 /
// 模块求值期抛错）时 effect 永远不跑，上一代那条 shell 就一直留在服务器上 ——
// 真机实测：被我故意搞崩的那一代，boot 回收只收了 id=9，id=10 从此无人引用。
// 排在 createRoot 之前是有意的：渲染抛异常会打断后面的语句，而这一步正是
// "渲染都可能挂"时最需要发生的。它内部不阻塞（异步 + App 侧带超时等待），
// 不会把开机变慢；App 的自动连接 await 的是同一个 promise（幂等，不跑第二遍）。
void startSshBootReap();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <ErrorBoundary label="应用">
    <App />
  </ErrorBoundary>,
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

// P5 (2026-09-19): 设置窗点「清空预测历史」→ 只有主窗这份内存里的引擎清得掉
// （设置窗是独立 JS context，它自己那份 suggest-engine 永远是空的）。
// 注册点放在主窗入口而不是终端初始化：用户可能一个终端都没开就去设置里清空。
// 动态 import：不为了一个监听把整条终端注入链拉进 eager 启动包（eager-budget 拦这个）。
void import("./modules/terminal/lib/completionInjection").then((m) => {
  m.initPredictionClearListener();
});
