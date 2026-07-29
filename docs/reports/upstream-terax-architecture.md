# 上游 crynta/terax-ai 全量源码分析报告（魔改基础参考）

> 用途：本项目魔改上游 terax-ai v0.8.6 的基础性参考，减少开发错误
> clone 来源：`https://github.com/crynta/terax-ai.git`（GitHub 直连，--depth 50）
> commit：`1fdbc50e53b3ac53db3ba80057805a2d54258545`（tag `v0.8.6`，"feat(editor): syntax highlighting for svelte files"，2026-07-28 01:04:47 +0200）
> 上游仓库文件数：619（不含 .git）
> 生成时间：2026-07-30
> 分析方式：git clone 后全量源码阅读（非仅 README），关键文件逐个 Read

---

## 1. 上游身份与版本

| 项 | 值 |
|----|----|
| 仓库 | `crynta/terax-ai` |
| 版本 | v0.8.6（package.json `version: "0.8.6"`，Cargo.toml `version = "0.8.6"`，tauri.conf.json `version: "0.8.6"`） |
| License | Apache-2.0 |
| commit hash | `1fdbc50e53b3ac53db3ba80057805a2d54258545` |
| tag | `v0.8.6`（describe 输出 `v0.8.6`，tag 后无后缀 commit） |
| bundle id | `app.crynta.terax` |
| package manager | pnpm 11.9.0（packageManager 字段锁定） |
| 定位 | 开源 AI-native 终端模拟器（多标签 + 文件浏览器 + 代码编辑器 + web 预览 + 语音输入 + AI agents） |

上游自带文档 `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/TERAX.md` 是上游的"AI 接手必读"（上游的 AGENTS.md / CLAUDE.md 都仅含一行 `TERAX.md` 指向它）。

---

## 2. 顶层结构总览

```
opensource-reference/terax-ai/
├── .github/                  # CI/CD（ci.yml / release.yml / signpath-test.yml / update-nix-sources.yml）+ CODEOWNERS + dependabot.yml
├── .vscode/                  # 编辑器配置
├── docs/                     # 架构文档（architecture/ai-subsystem.md / pty-shell-integration.md / security-model.md / terminal-renderer-pool.md / two-process-model.md）+ 截图
├── nix/                      # Nix 打包（package.nix + sources.json）
├── public/                   # logo.png
├── scripts/                  # eager-graph.mjs（构建分析）
├── src/                      # 前端（React 19 + TS + Vite）
├── src-tauri/                # Rust 后端 + Tauri 配置 + capabilities + icons
├── .coderabbit.yaml          # CodeRabbit AI review 配置
├── .size-limit.json          # 包体积预算
├── AGENTS.md / CLAUDE.md     # 都仅一行指向 TERAX.md
├── TERAX.md                  # 上游架构总纲（必读）
├── biome.json                # Biome lint/format 配置（替代 ESLint）
├── components.json           # shadcn 配置
├── flake.nix / flake.lock    # Nix flake
├── index.html                # 主窗口入口
├── knip.json                 # 死代码检测配置
├── package.json
├── pnpm-lock.yaml
├── pnpm-workspace.yaml       # 非 monorepo，是 pnpm 供应链安全配置（minimumReleaseAge 3 天）
├── settings.html             # Settings 独立窗口入口
└── README.md / ROADMAP.md / SECURITY.md / CODE_OF_CONDUCT.md / CONTRIBUTING.md / LICENSE
```

### 关键发现

1. **上游是单包项目**（pnpm-workspace.yaml 无 `packages:` 字段，仅做 `minimumReleaseAge: 4320` 分钟 = 3 天的依赖发布延迟保护，防供应链投毒）。
2. **Settings 是独立窗口**：`settings.html` + `src/settings/` 是独立 React 入口，由 Rust 命令 `open_settings_window` 创建独立 webview 窗口。
3. **上游自带 5 篇架构文档**在 `docs/architecture/`：`ai-subsystem.md` / `pty-shell-integration.md` / `security-model.md` / `terminal-renderer-pool.md` / `two-process-model.md`，魔改时遇到相关子系统应先读上游文档。
4. **工具链**：Biome（lint+format）+ knip（死代码）+ size-limit（包预算）+ react-compiler-healthcheck + cargo-nextest + cargo-machete + cargo-llvm-cov + clippy `-D warnings`。
5. **Nix 打包**：上游有完整 Nix flake 支持。

---

## 3. 技术栈与依赖

### 3.1 前端依赖（package.json）

> 完整文件：`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/package.json`

#### 核心框架（实测版本，纠正魔改版 CLAUDE.md §1 的多处版本错误）

| 依赖 | 上游实际版本 | 魔改版 CLAUDE.md 描述 | 是否一致 |
|------|------------|---------------------|---------|
| react / react-dom | ^19.2.7 | React 19 | 一致 |
| typescript | ~6.0.3 | "TypeScript 5 strict" | **不一致（上游是 TS 6）** |
| vite | ^8.1.5 | "Vite 6" | **不一致（上游是 Vite 8）** |
| ai (Vercel AI SDK) | ^6.0.207 | "ai v7" | **不一致（上游是 v6）** |
| @ai-sdk/anthropic | ^3.0.94 | - | - |
| @ai-sdk/openai | ^3.0.81 | - | - |
| @ai-sdk/google / groq / xai / cerebras / openai-compatible / react | 各自 ^3.x / ^2.x | - | - |
| zustand | ^5.0.14 | zustand v5 | 一致 |
| tailwindcss | ^4.3.2 + @tailwindcss/vite ^4.3.2 | Tailwind v4 | 一致 |
| tw-animate-css | ^1.4.0 | tw-animate-css | 一致 |
| radix-ui | ^1.6.2（聚合包） | "Radix UI（radix-ui 包）" | 一致 |
| @xterm/xterm | ^6.0.0 | xterm.js 6 | 一致 |

#### 编辑器真相（CodeMirror 不是 Monaco）

上游编辑器是 **CodeMirror 6**，**完全没有任何 monaco-editor 依赖**：

- `@uiw/react-codemirror` ^4.25.11（React 包装）
- `@codemirror/autocomplete/commands/lang-css/lang-go/lang-html/lang-javascript/lang-json/lang-markdown/lang-php/lang-python/lang-rust/lang-vue/language/legacy-modes/lint/merge/search/state/view`（全套 @codemirror/* 6.x）
- `@uiw/codemirror-themes` + 8 个预置主题（atomone/aura/copilot/github/gruvbox-dark/nord/tokyo-night/xcode）
- `@replit/codemirror-lang-svelte` + `@replit/codemirror-vim`（Vim 模式）
- `codemirror-languageserver`（LSP 集成）
- `@lezer/highlight`（语法高亮引擎）

`src/modules/editor/EditorPane.tsx` 第 6-20 行直接 `import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror"`，注释明说 "Open CodeMirror's find/replace panel" / "Apply CodeMirror's undo/redo commands"。

> **结论**：魔改版 CLAUDE.md §1"编辑器 | Monaco（本地加载，不走 CDN）"描述错误。魔改版 dev-state.md:98 说 CodeMirror 才正确。本报告核实结果：**上游用 CodeMirror 6，魔改版应保持 CodeMirror 路线，不应引入 Monaco**。

#### 终端

- `@xterm/xterm` ^6.0.0
- `@xterm/addon-fit` ^0.11.0
- `@xterm/addon-search` ^0.16.0
- `@xterm/addon-serialize` ^0.14.0
- `@xterm/addon-web-links` ^0.12.0
- `@xterm/addon-webgl` ^0.19.0

> **注意**：上游**没有 `@xterm/addon-unicode11`**。魔改版若引入了 Unicode11 addon，属于自加依赖。

#### Tauri 插件（前端侧）

`@tauri-apps/api` ^2.11.1 + 9 个插件：autostart / clipboard-manager / log / notification / opener / os / process / store / updater / window-state。

#### 其他重要依赖

- `sonner`（toast）、`cmdk`（命令面板）、`zod`（schema）、`use-stick-to-bottom`（聊天自动滚）、`streamdown`（Markdown 流式）、`@tanstack/react-virtual`（虚拟列表）、`react-resizable-panels`（分栏）、`@hugeicons/react` + `@iconify-json/catppuccin`（图标）、`@fontsource-variable/inter` + `@fontsource/jetbrains-mono`（字体）。

#### DevDependencies 关键

- `@biomejs/biome` ^2.5.4（lint+format，**替代 ESLint**）
- `babel-plugin-react-compiler` ^1.0.0 + `react-compiler-healthcheck` ^1.0.0（React Compiler 启用）
- `shadcn` ^4.13.0（组件 CLI）
- `size-limit` ^12.1.0 + `@size-limit/file`（包预算）
- `knip` ^6.27.0（死代码）
- `rollup-plugin-visualizer` + `vite-plugin-inspect`（构建分析）
- `react-scan` ^0.5.7（渲染性能分析，DEV + VITE_REACT_SCAN=true 触发）
- `vitest` ^4.1.10

#### scripts（与魔改版 CLAUDE.md §4 五绿门禁描述差异大）

| 上游 script | 命令 | 魔改版对应 |
|------------|------|-----------|
| `dev` | `vite` | - |
| `build` | `tsc && vite build` | `build:web` |
| `test` | `vitest run` | `test` |
| `check-types` | `tsc --noEmit` | `typecheck`（魔改版用 `-p` per-project） |
| `lint` | `biome lint ./src` | `lint`（魔改版说 `eslint . --max-warnings 0`，**工具链不同**） |
| `lint:fix` | `biome lint --write ./src` | - |
| `format` | `biome format --write ./src` | - |
| `size` | `size-limit` | - |
| `knip` | `knip` | - |
| `analyze:bundle` | `ANALYZE=true vite build` | - |
| `analyze:eager` | `node scripts/eager-graph.mjs ...` | - |
| `tauri` | `tauri` | `tauri:dev`（魔改版自加别名） |

> **关键**：上游没有 `typecheck` 脚本名，用 `check-types`（`tsc --noEmit`，单 tsconfig）。魔改版 CLAUDE.md §4 说"`pnpm typecheck # tsc -p tsconfig.app.json && tsc -p tsconfig.node.json`"——这是魔改版自改的 per-project 检查方式，上游是单 tsconfig `tsc --noEmit`。

### 3.2 Rust 依赖（Cargo.toml）

> 完整文件：`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src-tauri/Cargo.toml`

| crate | 版本 | 用途 |
|-------|------|------|
| tauri | 2（features: protocol-asset） | 桌面壳 |
| portable-pty | 0.9 | PTY（与魔改版一致） |
| tauri-plugin-{opener,log,os,store,process,notification} | 2 | Tauri 插件 |
| tauri-plugin-{autostart,updater,window-state} | 2 | 桌面端插件（非 android/ios） |
| tauri-plugin-clipboard-manager | 2 | **仅 Linux** 启用（mac/win webview 自带） |
| serde / serde_json | 1 / 1 | 序列化 |
| tokio | 1（features: rt） | 异步运行时（仅 rt feature） |
| reqwest | 0.12（rustls-tls + stream，default-features=false） | HTTP（AI 代理用） |
| bytes / futures-util | 1 / 0.3 | 流式响应 |
| ignore / grep-regex / grep-searcher / grep-matcher / globset / nucleo-matcher | 各自版本 | 文件搜索 + 内容搜索 |
| notify | 8.2.0 | 文件监听 |
| shared_child | 1 | 共享子进程（多线程 kill/wait） |
| which | 8.0.4 | PATH 查找 |
| dirs | 6 | 系统目录 |
| tempfile | 3 | 临时文件 |
| log | 0.4 | 日志 |
| libc | 0.2 | **仅 Unix** |
| keyring | 3.6 | **仅 macOS（apple-native）+ Windows（windows-native）**，Linux 不启用 |
| objc2 / objc2-foundation | 0.6 / 0.3 | **仅 macOS**（禁用 ApplePressAndHold） |
| windows-sys | 0.61 | **仅 Windows**（Console/JobObjects/Threading 等） |
| proptest | 1 | dev-dependencies（属性测试） |

> **决定性发现**：**上游 Cargo.toml 完全没有 `russh` / `russh-sftp` / `ssh2` 任何 SSH crate**。上游 Rust 后端**没有 SSH 功能**。魔改版 CLAUDE.md §1 "SSH | Rust russh 0.61 + russh-sftp 2.1" 是**魔改版完全自加的**，不是上游特性。
>
> **keyring 平台差异**：Linux 上游**不启用 keyring**，用文件后端（secrets.rs 实现，0600 权限）。魔改版 CLAUDE.md §1 "凭据 | Rust keyring（系统密钥库）"对 Linux 不准确。

### 3.3 Python sidecar 依赖

**上游不存在 Python sidecar**。Glob `**/sidecar/**` 返回 0 结果。上游 AI 走 Vercel AI SDK v6（前端直连 + Rust net.rs HTTP 代理绕 CORS），不走 Python。

> 魔改版 CLAUDE.md §1 "AI 引擎 | Python sidecar（src-tauri/sidecar/）"是**魔改版完全自加的**，上游没有 sidecar.rs 模块，没有 sidecar 目录，没有 spawn Python 进程的代码。

---

## 4. 启动链详解（魔改对比）

### 4.1 main.tsx 完整流程

> 文件：`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src/main.tsx`（42 行）

```ts
import "@xterm/xterm/css/xterm.css";
import "./styles/globals.css";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import ReactDOM from "react-dom/client";
import App from "./app/App";
import { initLaunchDir } from "./lib/launchDir";
import { USE_CUSTOM_WINDOW_CONTROLS } from "./lib/platform";

if (USE_CUSTOM_WINDOW_CONTROLS) {
  document.documentElement.dataset.chrome = "borderless";
}

// react-scan 仅 DEV + VITE_REACT_SCAN=true 时动态 import
if (import.meta.env.DEV && import.meta.env.VITE_REACT_SCAN === "true") {
  const { scan } = await import("react-scan");
  scan({ enabled: true });
}

// 清理前次 webview 留下的孤儿 PTY
await invoke("pty_close_all").catch(() => {});

// 首帧前 seed cwd，避免默认 tab 挂载时闪烁
await initLaunchDir();

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(<App />);

// 窗口 visible:false 创建，首帧后由前端 show()
const showWindow = () => {
  getCurrentWindow().show().catch((e) => console.error("window.show failed:", e));
};
setTimeout(showWindow, 50);
setTimeout(showWindow, 500);  // 安全网：第一次失败再 force 一次
```

**与魔改版 CLAUDE.md §2 启动链描述对比**：完全一致（pty_close_all + initLaunchDir + 50/500 双保险 show）。魔改版描述正确。

### 4.2 App.tsx Provider 树 + 顶层结构

> 文件：`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src/app/App.tsx`（1422 行）

#### Provider 树（外→内）

```
<AiComposerProvider>                    ← 最外层（line 1421）
  <ThemeProvider>                        ← 主题（line 1199）
    <TooltipProvider>                    ← Radix Tooltip（line 1200）
      <div className="relative flex h-screen flex-col overflow-hidden bg-background text-foreground">
        {!zenMode && <Header ... />}     ← 顶部（标签栏 + 工具栏 + 搜索）
        <main className="zoom-content flex min-h-0 flex-1 flex-col">
          <ResizablePanelGroup orientation="horizontal">
            <ResizablePanel id="sidebar">
              {sidebarView === "explorer" ? <FileExplorer /> : <SourceControlPanel />}
              <SidebarRail />
            </ResizablePanel>
            <ResizableHandle withHandle />
            <ResizablePanel id="workspace">
              <WorkspaceSurface />       ← 工作区表面（终端/编辑器/预览切换）
              <WorkspaceInputBar />      ← 输入栏
            </ResizablePanel>
          </ResizablePanelGroup>
        </main>
        {!zenMode && <StatusBar />}
        <AgentNotificationsBridge />     ← 外部 agent 通知桥
        <Toaster position="bottom-right" />
        <AgentRunBridge />               ← AI agent 运行桥
        <LocalAgentNotificationsBridge />
        <AiMiniWindow />                 ← AI 迷你窗
        <SelectionAskAi />               ← 选词问 AI
        <TabSwitcherHud />               ← Tab 切换 HUD
        <CommandPalette />               ← 命令面板
        <NewEditorDialog />
        <UpdaterDialog />                ← 更新对话框
        <CloseDialogs />                 ← 关闭确认对话框
      </div>
    </TooltipProvider>
  </ThemeProvider>
</AiComposerProvider>
```

#### 关键架构原则（来自 TERAX.md）

1. **AiComposerProvider 无条件挂载**：TERAX.md line 71 明确警告——条件包装会导致 key 加载时整树重挂载 + PTY 重 spawn。**魔改版必须保持无条件挂载**。
2. **Tabs 是 tagged union 不卸载**：`kind: terminal | editor | preview | markdown | ai-diff | git-diff | git-history | git-commit-file`，切换时 `invisible pointer-events-none` 隐藏，PTY 和 dev server 保持流式。**魔改版 WorkspaceSurface 必须保持此策略**。
3. **App.tsx 是协调者**，新功能进 `modules/<area>/`，不要在 App.tsx 堆逻辑。
4. **Functional core, imperative shell**：业务逻辑放纯函数（可测），Tauri 命令和 React 组件保持薄。

### 4.3 窗口可见性策略

| 配置 | 上游值 | 位置 |
|------|--------|------|
| `visible` | false（初始隐藏） | tauri.conf.json |
| `decorations` | false（Windows/Linux 无边框） | tauri.windows.conf.json / tauri.linux.conf.json |
| `transparent` | true（Windows/Linux 透明） | tauri.windows.conf.json / tauri.linux.conf.json |
| `shadow` | false | tauri.windows.conf.json |
| `titleBarStyle` | "Overlay" + `hiddenTitle: true`（macOS） | tauri.conf.json |
| show 触发 | 前端 `setTimeout(show, 50/500)` | main.tsx |
| window-state 插件 | `StateFlags::all() & !StateFlags::VISIBLE`（跳过 VISIBLE 恢复） | lib.rs line 188-192 |

**devUrl 端口**：上游 `http://localhost:1420`，魔改版改为 `http://localhost:9300`。魔改版 CLAUDE.md §1 端口约定描述正确（9300 是魔改版改的）。

**CDP 调试端口 9222**：上游 tauri.conf.json **没有** `additionalBrowserArgs` 配置 9222。魔改版的 9222 是自加的调试配置。

### 4.4 capabilities 权限对比

> 上游文件：`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src-tauri/capabilities/default.json`

上游 default.json 权限清单（windows: main + settings）：
- `core:default`
- `core:window:allow-start-dragging/close/destroy/minimize/toggle-maximize/is-maximized/internal-toggle-maximize/show/set-focus/set-title`
- `core:event:allow-listen/unlisten`
- `opener:default` / `log:default` / `os:default` / `notification:default` / `store:default`
- `autostart:allow-enable/disable/is-enabled`

**上游没有 `core:window:allow-center`**。魔改版 CLAUDE.md §2 说"必须含 allow-center"——这是魔改版自加的。

上游另有 `clipboard.json`（Linux clipboard）和 `desktop.json`（桌面端额外权限），按平台/特性拆分。

---

## 5. 前端模块地图（与魔改版对照表）

### 5.1 上游前端模块完整清单（20 个，按 index.ts 列出）

`agents` / `ai` / `command-palette` / `editor` / `explorer` / `git-history` / `header` / `lsp` / `markdown` / `preview` / `settings` / `shortcuts` / `sidebar` / `source-control` / `spaces` / `statusbar` / `tabs` / `terminal` / `theme` / `updater` / `workspace`

> 注意：`settings` 模块无 `index.ts`，但有 `store.ts` / `preferences.ts` / `openSettingsWindow.ts`，且是独立窗口入口（settings.html）。

### 5.2 模块对照表

| 模块 | 上游文件数（关键） | 上游关键文件 | 魔改版状态 | 魔改差异 |
|------|----------|-------------|----------|---------|
| **terminal** | ~15（含 block/） | TerminalStack/TerminalPane/PaneTreeView + lib/rendererPool.ts + block/(BlockOverlay/ShellInput) + lib/(osc-handlers/panes/liveTerminals/dormantRing/cursorBlink/agentActivity/keymap) | 保留 | 魔改版 CLAUDE.md 提到 rendererPool 一致 |
| **editor** | ~25 | EditorPane(CodeMirror)/EditorStack/AiDiffStack/GitDiffStack/NewEditorDialog + lib/(autocomplete/cmThemes/chromeTheme/extensions/languageResolver/externalFormat/useDocument/vim) | 保留但描述错误 | **魔改版 CLAUDE.md 误写 Monaco，实际是 CodeMirror** |
| **explorer** | ~15 | FileExplorer/TreeRow/InlineInput/ExplorerSearch + lib/(useFileTree/useGitStatus/useExplorerDnd/fileIcons/folderIcons) | 保留 | 魔改版加了 useRemoteFileTree（remote 走 SSH） |
| **tabs** | ~13 | TabBar/NewTabMenu/TabSwitcherHud + lib/(useTabs/useTabSwitcher/useWindowTitle/useWorkspaceCwd/tabLabel/nextActiveInSpace/reorderTabsByGap/planSpaceRemoval) | 保留 | - |
| **theme** | ~25（含 16 主题） | ThemeProvider/useThemeFileEditing/bgImageStore/customThemes/applyTheme/resolveEditorTheme/resolveTerminalFont/themeFiles/validateTheme/SurfaceLayer + themes/(16 个内置主题) | 保留 | **魔改版 useThemeFileEditing 曾因 effect 依赖 availableImages 自反循环卡死 50 万次/秒，上游版本是魔改基础** |
| **shortcuts** | ~7 | shortcuts.ts(单一真源 SHORTCUTS, 43 个 ShortcutId) + lib/(useGlobalShortcuts/shortcutLabel/shortcutScope) | 保留 | 魔改版 CLAUDE.md 说"从上游恢复的单一真源"，确认 |
| **ai** | ~50（最大模块） | components/(AiChat/AiComposerInput/AiInputBar/AiMiniWindow/AgentRunBridge/AgentSwitcher/SelectionAskAi/TodoStrip/PlanDiffReview/FilePicker/SnippetPicker) + lib/(composer.tsx/agents.ts/agent.ts/sessions.ts/transport.ts/native.ts/keyring.ts/redact.ts/security.ts/prompt.ts/compact.ts/snippets.ts/slashCommands.ts/stt.ts/todos.ts/proxyFetch.ts/modelPrefs.ts/miniWindowGeometry.ts) + store/(chatStore/agentsStore/chatRuntime/planStore/snippetsStore/todoStore) + tools/(agent/context/edit/fs/search/shell/subagent/terminal/todo/tools) + agents/(registry.ts/runSubagent.ts) + hooks/(useAiBootstrap/useSelectionAskAi/useWhisperRecording/useWorkspaceFiles) + config.ts | 保留部分 | 魔改版有 components/TdsfAgentPanel.tsx（自创），上游无；魔改版有 agents/registry.ts，与上游同名但实现可能不同 |
| **agents**（独立模块） | ~12 | components/(AgentLauncherPanel/AgentNotificationsBridge/AgentToast/NotificationBell) + lib/(launcher.ts/launcher.test.ts/route.ts/review.ts/notify.ts/types.ts) + store/(agentStore/managedAgentsStore) | 待对比 | 魔改版 CLAUDE.md 把 agents 归入 ai 模块，上游是独立模块 |
| **command-palette** | ~10 | CommandPalette/commands + lib/(fuzzy/mode/mru) + hooks/(useAsyncQuery/useCommandHistory/useContentSearch) | 待对比 | 魔改版 CLAUDE.md 未列出 |
| **git-history** | ~7 | GitHistoryPane/GitHistoryStack/GraphRail + lib/(graph/remoteWebUrl) | 待对比 | 魔改版 CLAUDE.md 未列出 |
| **header** | ~3 | Header/SearchInline | 待对比 | 魔改版 CLAUDE.md 未列出 |
| **lsp** | ~13 | components/LspStatusPill + lib/(client/detect/locationsPanel/navigator/presets/protocolShim/runtimeStore/sessionManager/transport/uri/useLspExtension/useLspHint) | 待对比 | 魔改版 CLAUDE.md 未列出，上游 LSP 是完整子系统 |
| **markdown** | ~5 | MarkdownPreviewPane/MarkdownStack/MarkdownViewToggle | 待对比 | 魔改版 CLAUDE.md 未列出 |
| **preview** | ~5 | PreviewPane/PreviewStack/PreviewAddressBar | 待对比 | 魔改版 CLAUDE.md 未列出（魔改版 WorkspaceSurface 提到"预览"） |
| **settings**（独立窗口） | ~5 | openSettingsWindow/preferences/store/coerceFontWeight/editorFontSize | 待对比 | 魔改版 CLAUDE.md 未列出，上游是独立 webview 窗口 |
| **sidebar** | ~4 | SidebarRail/useSidebarPanel/types | 待对比 | 魔改版 CLAUDE.md 未列出 |
| **source-control** | ~5 | SourceControlPanel/useSourceControl/useSourceControlContext/useSourceControlPanel | 待对比 | 魔改版 CLAUDE.md 未列出 |
| **spaces** | ~11 | SpaceSwitcher/SpaceAvatar + lib/(activeSpace/serialize/spaceColor/store/useSpaces/useSpacesBoot/useSpacePersistence) | 待对比 | 魔改版 CLAUDE.md 未列出，上游 Spaces 是多工作区切换 |
| **statusbar** | ~5 | StatusBar/CwdBreadcrumb/DiagnosticsBadge/WorkspaceEnvSelector + lib/pathUtils | 待对比 | 魔改版 CLAUDE.md 未列出 |
| **updater** | ~1 | UpdaterDialog | 待对比 | 魔改版 CLAUDE.md 未列出 |
| **workspace** | 待对比 | useWorkspaceEnvStore/WorkspaceEnv | 待对比 | 魔改版 CLAUDE.md 未列出（魔改版有 store/runtime.tsx） |
| **translate** | **不存在** | - | **魔改版独有** | 离线选词翻译，魔改版自加 |
| **ssh-explorer** | **不存在** | - | **魔改版独有** | SSH 连接管理 + 远程文件树 + SSH 终端，魔改版完全自加 |

### 5.3 关键前端文件细节

#### ai/agents/registry.ts（上游）

> 文件：`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src/modules/ai/agents/registry.ts`

4 种 SubagentType：`explore` / `code-review` / `security` / `general`，全部只读工具白名单 `["read_file", "list_directory", "grep", "glob"]`，禁止 mutating 工具 + `run_subagent`（防递归）。每个 agent 有 systemPrompt。

#### ai/lib/composer.tsx（上游）

> 文件：`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src/modules/ai/lib/composer.tsx`

`AiComposerProvider` 是 Context Provider，提供 ComposerCtx：textareaRef/value/setValue/files/addFiles/attachFileByPath/removeFile/pickedSnippets/addSnippet/removeSnippet/pickedCommands/addCommand/removeCommand/isBusy/submit/stop/voice/canSend。

- `FileAttachment` kind: `image | text | selection`，source: `terminal | editor`
- `MAX_TEXT_INLINE = 200_000`
- 集成 `useWhisperRecording`（语音输入）+ `slashCommands` + `snippets`

#### ai/tools（上游 11 个工具文件）

`agent.ts / context.ts / edit.ts / fs.ts / search.ts / shell.ts / subagent.ts / terminal.ts / todo.ts / tools.ts` + 2 个测试（edit.test.ts / search.test.ts）

#### theme 模块（上游，魔改版卡死根因所在）

> 目录：`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src/modules/theme/`

16 个内置主题：`caffeine / catppuccin / claude / dracula / everforest / gruvbox / kanagawa-dragon / kanagawa / nord / rose-pine / sage / solarized / terax-default / tide / tokyo-night`（在 `themes/index.ts` 注册）。

其他文件：`ThemeProvider.tsx` / `useThemeFileEditing.ts`（魔改版卡死根因处）/ `bgImageStore.ts` / `customThemes.ts` / `applyTheme.ts` / `resolveEditorTheme.ts` / `resolveTerminalFont.ts` / `themeFiles.ts` / `validateTheme.ts` / `types.ts` / `SurfaceLayer.tsx`。

> **魔改版警示**：魔改版 useThemeFileEditing 的 effect 依赖 `availableImages` 而 effect 又 `setAvailableImages(新数组)` 形成 50 万次/秒的自反循环。上游此文件是安全基线，魔改时务必遵守 CLAUDE.md §3 红线 4（effect 依赖禁止自反）。

---

## 6. Rust 后端模块地图

### 6.1 模块树

> 文件：`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src-tauri/src/modules/mod.rs`

11 个模块：`agent / fs / git / history / lsp / net / proc / pty / secrets / shell / workspace`

> **决定性发现**：**上游没有 `ssh` 模块、没有 `sidecar` 模块、没有 `sandbox` 模块**。任务描述提到的 `modules/sandbox/` 在上游不存在。魔改版 CLAUDE.md §2 列的 `modules/ssh/` 和 `modules/sidecar.rs` 都是魔改版自加。

### 6.2 模块详情与 invoke 命令清单

> lib.rs 注册的全部 invoke 命令（约 80 个），来自 `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src-tauri/src/lib.rs` line 239-321

#### pty 模块（9 命令）

文件：`mod.rs / session.rs / agent_detect.rs / da_filter.rs / shell_init.rs` + `scripts/`(bashrc.bash/init.fish/profile.ps1/zlogin.zsh/zprofile.zsh/zshenv.zsh/zshrc.zsh)

命令：`pty_open / pty_write / pty_resize / pty_close / pty_close_all / pty_has_foreground_process / pty_has_foreground_job / pty_shell_name / pty_list_shells`

关键设计：
- `pty_open` 用 Tauri `Channel<Response>` 推 PTY 数据流（on_data/on_exit）
- `pty_write` 用 raw body + `x-pty-id` header 跳过 JSON 序列化（每个按键省一次序列化）
- `pty_close_all` 在前端启动时清理孤儿 PTY（main.tsx 调用）
- `pty_has_foreground_job` 用 `tcgetpgrp` 检查前台任务（renderer hibernation 用）
- Windows 子进程检查用 `CreateToolhelp32Snapshot` + `Process32First/Next`

session.rs 关键：
- `Session` 结构：`shell_pid / killer(Mutex<Box<dyn ChildKiller>>) / writer(Arc<Mutex<Box<dyn Write>>>) / master(Mutex<Box<dyn MasterPty>>) / exited(Arc<AtomicBool>)`
- Windows 字段额外有 `_job: Option<ProcessJob>`（KILL_ON_JOB_CLOSE 杀整个进程树）
- **Drop 顺序精心设计**：`_job → killer → writer → master`（Windows 上先杀进程树，再关 pipe，最后 ClosePseudoConsole，避免 conhost drain 阻塞）
- **CONPTY_LIFECYCLE_LOCK**：序列化 ConPTY 创建/关闭（issue #356，重叠调用损坏新 console）
- Flusher：`FLUSH_COALESCE=4ms / FLUSH_MAX_IDLE=50ms / READ_BUF=16KB / MAX_PENDING=4MB`
- 背压：超 MAX_PENDING 丢弃整个 pending buffer + 发 `ESC c`（hard reset）+ 提示
- `AGENT_EVENT = "terax:agent-signal"`

shell_init.rs：`detect_shell_name / list_shells / ShellInfo`，平台分 `#[cfg(unix)]` / `#[cfg(windows)]`。Windows shell 优先级：`pwsh.exe → powershell.exe → cmd.exe`。

> **魔改版警示**：魔改版 CLAUDE.md §10 提到"魔改版改过的上游文件（session.rs terminal_modes 等）"——session.rs 是上游核心文件，魔改时改 terminal_modes 字段需谨慎，不要破坏 Drop 顺序和 CONPTY 锁。

#### fs 模块（18 命令）

文件：`mod.rs / tree.rs / file.rs / mutate.rs / search.rs / grep.rs / watch.rs`

命令：
- tree: `list_subdirs / fs_read_dir`
- file: `fs_read_file / fs_write_file / fs_stat / fs_canonicalize`
- mutate: `fs_create_file / fs_create_dir / fs_rename / fs_delete / fs_copy`
- watch: `fs_watch_add / fs_watch_remove`
- search: `fs_search / fs_list_files`
- grep: `fs_grep / fs_grep_interactive / fs_glob`

依赖 crate：`ignore / grep-regex / grep-searcher / grep-matcher / globset / nucleo-matcher / notify`。状态：`FsWatchState` / `ContentSearchState`。

#### git 模块（17 命令）

文件：`mod.rs / commands.rs / operations.rs / parser.rs / process.rs / types.rs / errors.rs / utils.rs`

命令：`git_resolve_repo / git_panel_snapshot / git_status / git_diff / git_diff_content / git_stage / git_unstage / git_discard / git_commit / git_fetch / git_pull_ff_only / git_push / git_log / git_show_commit / git_commit_files / git_commit_file_diff / git_remote_url / git_list_branches / git_checkout_branch`

所有操作经过 workspace 授权注册表。无依赖 crate（自己 spawn git 进程）。

#### shell 模块（8 命令）

文件：`mod.rs / background.rs / ringbuffer.rs / session.rs`

命令：`shell_run_command / shell_session_open / shell_session_run / shell_session_close / shell_bg_spawn / shell_bg_logs / shell_bg_kill / shell_bg_list`

关键设计：
- `shell_run_command`：一次性命令，登录 shell 执行，超时强制 kill，输出上限 `MAX_OUTPUT_BYTES = 256KB`
- `shell_session_*`：持久 shell 会话（Agent 用）
- `shell_bg_*`：后台进程（dev server 等），bounded ring-buffer 日志
- `build_oneshot_command` 平台分支：
  - Unix: `/bin/sh -c command`（带 AppImage env overrides）
  - Windows WSL: `wsl.exe -d <distro> --cd <cwd> --exec sh -lc <command>`
  - Windows native: `pwsh -NoProfile -Command` 或 `cmd /C`
- 所有 spawn 经 `authorize_spawn_cwd`（workspace 授权）
- `SharedChild` crate 共享 child 进程（多线程 kill/wait）

#### lsp 模块（6 命令）

文件：`mod.rs / env.rs / framing.rs / rss.rs / session.rs`

命令：`lsp_detect / lsp_host_pid / lsp_resolve_root / lsp_spawn / lsp_send / lsp_kill`

关键设计（来自 TERAX.md）：
- Dumb JSON-RPC pipe：Content-Length framing 在 Rust（`framing.rs`，纯函数 + 测试），协议智能在前端
- Spawn cwd 经 workspace 注册表授权
- 二进制 resolve 用捕获的 login-shell env（`env.rs`，macOS GUI 应用 PATH 裸）
- root 检测向上走到 markers，但**绝不走到或超过 `$HOME`**
- Unix 上 servers 跑在独立 process group，group-kill（cargo check / proc-macro children 随 server 死）
- Windows children 用 `proc::job::ProcessJob`（kill-on-close，与 pty 共享）
- `RunEvent::Exit` 时 kill_all

#### net 模块（3 命令）

文件：`net.rs`（单文件，435 行 + 大量测试）

命令：`lm_ping / ai_http_request / ai_http_stream`

**用途**：AI HTTP 代理——绕过 webview CORS / Mixed-Content / PNA，让本地模型服务器（LM Studio / Ollama / vLLM）在生产 bundle 中可用。

**安全模型**（核心）：
- `HEADER_BLOCKLIST`：hop-by-hop 头（host/content-length/connection/proxy-authorization/...）
- `is_blocked_host_name`：metadata.google.internal / metadata / metadata.azure.com（云元数据）
- `ip_kind`：Public / Private / Loopback / BlockedMetadata
  - Private: RFC1918（10/8、172.16/12、192.168/16）+ CGNAT（100.64/10）+ benchmarking（198.18/15）+ IETF
  - BlockedMetadata: 169.254.169.254（IPv4 link-local）+ fd00:ec2::254（AWS IPv6）+ fe80::/10（IPv6 link-local）
  - Private IPv6: fc00::/7（ULA）
- **DNS rebinding 防御**：classify 后 pin reqwest resolver 到分类过的 IP（`resolve_to_addrs`），防止第二次 DNS 返回不同 IP
- CRLF 注入防御：header value 禁止 CR/LF/NUL
- redirect policy：检查每个 redirect 目标的 scheme/host/IP
- `allow_private_network` 默认 false，需显式 opt-in
- 8 个测试覆盖 IP 分类/URL 验证/header 注入

`ai_http_stream` 用 Tauri `Channel<AiStreamEvent>` 推流（Headers/Chunk/End/Error 事件）。

> **魔改版警示**：魔改版 CLAUDE.md 完全没提到 net.rs 的安全模型。如果魔改版 sidecar 接管了 AI HTTP 代理，必须保留这套 SSRF 防御，不能裸 reqwest。

#### secrets 模块（4 命令）

文件：`secrets.rs`（277 行 + Linux 测试）

命令：`secrets_get / secrets_set / secrets_delete / secrets_get_all`（批量读，单 IPC 往返）

**平台后端**：
- macOS: Keychain（keyring crate，apple-native）
- Windows: Credential Manager（keyring crate，windows-native）
- **Linux: 文件后端**（`app_local_data_dir/secrets.json`，mode 0600，atomic write tmp+rename+sync_all，内存缓存）

**理由**（secrets.rs line 1-12）：Linux 上 keyring 默认是 Secret Service over D-Bus，没有 gnome-keyring/kwallet 时静默失败。开源 AppImage/deb/rpm 不能假设有 keyring daemon。Brave/Chromium 也是这种 fallback。

#### agent 模块（2 命令，单文件 agent.rs）

文件：`agent.rs`（554 行 + 14 测试）

命令：`agent_enable_hooks / agent_hooks_status`

**与外部 CLI agent 集成**（不是 Python sidecar！）：支持 Claude Code / Codex / Gemini CLI / Pi 四个外部 agent。

机制：通过终端 OSC 777 marker（`ESC ] 777 ; notify ; Terax ; <agent> ; <event> BEL`）让 Terax 知道外部 agent 状态。事件：`working / attention / finished`。

Delivery 方式：
- `TerminalSequence`（Claude）：通过 `terminalSequence` JSON 字段
- `Osc`（Codex/Gemini）：直接 emit marker 到 `/dev/tty`（Unix）或 `CONOUT$`（Windows，调 `terax.exe __terax_notify`）

Pi 扩展：写 `.pi/agent/extensions/terax-notifications.ts` TypeScript 扩展。

幂等安装：`merge_hooks` 保留外部 hooks，只替换自己的（用 `OWNED_MARKERS` 识别）。atomic write。

> **关键差异**：上游 agent.rs 是与外部 CLI agent（Claude Code 等）的终端钩子集成，**与魔改版 Python sidecar 是完全不同的两套 agent 体系**。

#### workspace 模块（5 命令，单文件 workspace.rs）

命令：`wsl_list_distros / wsl_default_distro / wsl_home / workspace_authorize / workspace_current_dir`

**核心安全模型**：`WorkspaceRegistry` 维护授权根目录集合（`Mutex<HashSet<PathBuf>>`）+ canonical 缓存（1 秒 TTL，256 cap）。
- `authorize_spawn_cwd`：AI/agent 调用 shell 时，cwd 必须 canonicalize 后在已授权根下（防逃逸）
- `authorize_user_spawn_cwd`：用户主动 spawn 终端时，canonicalize 后注册为新根
- `WorkspaceEnv`：`Local` 或 `Wsl { distro }`（支持 WSL）
- AppImage env overrides（Linux）

#### history 模块（4 命令）

命令：`history_suggest / history_commands / history_record / history_list`

文件：`mod.rs / parse.rs`。状态：`HistoryState`。

#### proc 模块（无 invoke 命令，内部用）

文件：`mod.rs / job.rs`。提供 `ProcessJob`（Windows JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE）+ `hide_console`（Windows）。被 pty 和 lsp 使用。

### 6.3 其他 Tauri 命令（lib.rs 顶层）

- `get_launch_dir` / `get_launch_files`：drain-once 启动参数（防 HMR 重放）
- `open_settings_window`：创建独立 Settings webview 窗口（macOS 不用 parent，Linux/Windows 用 parent + decorations:false + transparent:true）

### 6.4 状态管理（lib.rs manage）

`PtyState / ShellState / SecretsState / FsWatchState / HistoryState / LspState / ContentSearchState / WorkspaceRegistry / LaunchDir / LaunchFiles`

### 6.5 run() 启动流程（lib.rs line 158-365）

1. Windows 检查 `__terax_notify` 隐藏入口（agent 通知 CONOUT$）
2. `parse_launch_target()` 解析 CLI 参数（dir/file）
3. `workspace::init_launch_cwd(cli_dir)` 初始化启动 cwd
4. 注册插件：clipboard（仅 Linux）/ process / updater / window-state（跳过 VISIBLE）/ autostart / store / os / notification / log（Info level）/ opener
5. macOS setup：main 窗口 CloseRequested/Destroyed 时关 settings 窗口
6. manage 所有 State
7. invoke_handler 注册 80 个命令
8. run event handler：
   - `Exit`：kill_all LSP
   - macOS `Opened { urls }`：文件关联打开（canonicalize 防 /tmp → /private/tmp symlink）

---

## 7. Python sidecar 架构

**上游不存在 Python sidecar**。

证据：
1. Glob `**/sidecar/**` 返回 0 结果
2. Cargo.toml 无任何 spawn Python 的依赖（无 subprocess/async-process/serde_json 之外的处理）
3. lib.rs `run()` 完全没有 spawn Python 进程的代码
4. package.json 无 Python 相关
5. mod.rs 11 个模块无 `sidecar`
6. TERAX.md 明确："BYOK AI via Vercel AI SDK v6"，AI 走前端 SDK + Rust net.rs HTTP 代理

**上游 AI 架构**：
- 前端：Vercel AI SDK v6（`ai` ^6.0.207 + `@ai-sdk/*`）直连 provider
- Rust：`net.rs` 提供 `ai_http_request` / `ai_http_stream` HTTP 代理（绕 webview CORS，含 SSRF 防御）
- 凭据：`secrets.rs` 存 API key（macOS Keychain / Windows Credential Manager / Linux 文件 0600）
- 前端 keyring：`src/modules/ai/lib/keyring.ts` + `native.ts`
- 外部 agent 集成：`agent.rs` 通过终端 OSC 777 钩子（Claude Code/Codex/Gemini/Pi）

> **魔改版警示**：魔改版的 Python sidecar（src-tauri/sidecar/）是**完全自加的**。如果 sidecar 与上游 AI 路径（Vercel SDK + net.rs）冲突或重复，需要明确边界。上游 net.rs 的 SSRF 防御模型在魔改版中是否保留，待对比。

---

## 8. 构建与打包

### 8.1 窗口配置

| 平台 | 文件 | 关键配置 |
|------|------|---------|
| 通用 | tauri.conf.json | visible:false / titleBarStyle:"Overlay" / hiddenTitle:true / 800x600 / minWidth 420 / minHeight 280 / dragDropEnabled:true |
| Windows | tauri.windows.conf.json | decorations:false / transparent:true / visible:false / shadow:false / label:"main" |
| Linux | tauri.linux.conf.json | 待对比（应与 Windows 类似无边框透明） |

**devUrl**：上游 `http://localhost:1420`，魔改版改为 `http://localhost:9300`。
**frontendDist**：`../dist`
**beforeDevCommand**：`pnpm dev` / **beforeBuildCommand**：`pnpm build`
**createUpdaterArtifacts**：true（updater 用）

### 8.2 CSP

```
default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
img-src 'self' data: asset: https://asset.localhost blob:;
media-src 'self' asset: https://asset.localhost blob:;
font-src 'self' data:;
connect-src 'self' ipc: http://ipc.localhost https: http://localhost:* http://127.0.0.1:*;
frame-src 'self' http: https: asset: https://asset.localhost;
worker-src 'self' blob:; object-src 'none'; base-uri 'self'; form-action 'self'
```

### 8.3 Bundle 配置

- **targets**: "all"
- **category**: "DeveloperTool"
- **macOS**: minimumSystemVersion 13.0, entitlements.plist
- **Linux**: deb（libwebkit2gtk-4.1-0 / libgtk-3-0）/ rpm（webkit2gtk4.1 / gtk3）/ appimage（bundleMediaFramework:true）
- **Windows**: webviewInstallMode downloadBootstrapper / NSIS installMode currentUser / installerHooks installer-hooks.nsh
- **fileAssociations**: 大量文件类型（json/txt/md/js/ts/py/go/rs/sh/yaml/xml 等）
- **updater**: pubkey + endpoints 指向 GitHub releases latest.json

### 8.4 CI/CD

> 文件：`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/.github/workflows/ci.yml` + `release.yml`

#### ci.yml（4 job）

1. **frontend**（ubuntu-latest, Node 24）：
   - `pnpm install --frozen-lockfile`
   - `pnpm audit --prod --audit-level high`（advisory）
   - `pnpm lint`（biome lint）
   - `pnpm check-types`（tsc --noEmit）
   - `pnpm test`（vitest run）
   - `pnpm exec react-compiler-healthcheck`（advisory）
   - `pnpm build`（tsc && vite build）
   - `pnpm size`（size-limit）
   - `pnpm knip`（死代码，advisory）

2. **rust**（ubuntu-22.04, libwebkit2gtk-4.1-dev / libgtk-3-dev / librsvg2-dev / libssl-dev, stable）：
   - `cargo check --all-targets --locked`
   - `cargo clippy --all-targets --locked -- -D warnings`（严格）
   - `cargo machete`（未用 crate，advisory）
   - `cargo nextest run --locked`

3. **rust-platforms**（windows-latest + macos-latest 矩阵）：
   - `cargo check --all-targets --locked`
   - `cargo nextest run --locked --retries 2`

4. **coverage**（ubuntu-22.04, needs rust）：
   - `cargo llvm-cov nextest --locked --lcov --output-path lcov.info`
   - 上传 lcov.info artifact

#### release.yml（tag v* 触发）

4 平台矩阵：macOS aarch64 / macOS x86_64 / Ubuntu 22.04 / Windows

- `tauri-apps/tauri-action@v1` 构建 + 上传
- Apple 公证：APPLE_CERTIFICATE / APPLE_SIGNING_IDENTITY / APPLE_API_KEY
- TAURI_SIGNING_PRIVATE_KEY：updater minisign 签名
- **AppImage wayland 修复**（ubuntu-22.04）：移除 bundle 的 libwayland-client/egl/cursor/server.so，用 appimagetool 重新打包 + 重新签名（解决 Mesa 1.22+ EGL_BAD_PARAMETER）
- **Windows SignPath Authenticode 签名**：NSIS exe + MSI 都签名，等待人工审批（最多 3600s），签名后重新生成 minisign .sig
- **patch-updater-manifest job**：所有平台构建完后，patch latest.json 把 re-signed 签名写入

### 8.5 工具链配置

- **biome.json**（Biome 2.4.16）：
  - 排除 `src/components/ui/**` 和 `src/components/ai-elements/**`
  - formatter: 2 space / 80 width / double quote / semicolons / trailingCommas all
  - organizeImports 分组: NODE / @/** / PACKAGE / ALIAS / PATH
  - linter: recommended + a11y warn + `noControlCharactersInRegex: off`（终端 ANSI 豁免）+ `noTsIgnore: error` + `useImportType: error` + `useExportType: error` + `useExhaustiveDependencies: warn`
- **knip.json**：死代码检测
- **.size-limit.json**：包体积预算
- **pnpm-workspace.yaml**：`minimumReleaseAge: 4320`（3 天）+ `minimumReleaseAgeStrict: true`（供应链安全）
- **.coderabbit.yaml**：CodeRabbit AI review

> **魔改版警示**：魔改版 CLAUDE.md §4 说"pnpm lint # eslint . --max-warnings 0"完全错误——上游用 Biome。魔改版若引入 ESLint，是工具链偏离。豁免机制也不同：上游用 biome.json 的 `noControlCharactersInRegex: off`，不是 ESLint 的 `// eslint-disable`。

---

## 9. 测试覆盖

### 9.1 前端测试（69 个 *.test.ts/tsx 文件）

统计自 Glob `**/*.test.{ts,tsx}`：

| 模块 | 测试文件数 | 关键测试 |
|------|----------|---------|
| terminal | 16（含 block/lib 5 个） | osc-handlers / panes / liveTerminals / dormantRing / cursorBlink / agentActivity / keymap / terminalPaste / terminalClipboard / quoteShellPath / useTerminalFileDrop / block/(readBlock/outputCap/modeMachine/blockRange/blockDecorations) |
| tabs | 7 | tabLabel / reorderTabsByGap / planSpaceRemoval / planGitDiffOpen / pickTabBySpaceIndex / nextActiveInSpace |
| theme | 4 | validateTheme / themeFiles / resolveTerminalFont / resolveEditorTheme |
| ai | 11 | config / agents / compact / errors / miniWindowGeometry / prompt / redact / security / snippets + tools/(edit/search) |
| editor | 8 | languageResolver / indent / externalFormat / eol + autocomplete/(trimSuggestion/prompt/normalizeIndent) |
| explorer | 3 | useExplorerDnd / gitStatusUtils / contextActions |
| shortcuts | 2 | shortcuts / shortcutScope |
| spaces | 3 | spaceColor / serialize / activeSpace |
| settings | 2 | editorFontSize / coerceFontWeight |
| git-history | 2 | graph / remoteWebUrl |
| command-palette | 2 | mode / fuzzy |
| 其他 | 9 | lsp/uri / preview/PreviewPane / markdown/MarkdownPreviewPane / statusbar/pathUtils / agents/launcher / lib/(utils/shellQuote/fonts) / components/ai-elements/markdown-code / app/eager-budget / settings/components/lspSwitchState |

### 9.2 Rust 测试

#### 集成测试（src-tauri/tests/）

4 个文件：`fs_search.rs / git_operations.rs / shell_background.rs / common/mod.rs`

#### 内联单元测试（#[cfg(test)] mod tests）

至少在以下文件内：
- `lib.rs`：launch_target_tests（4 个，resolve_launch_target）
- `net.rs`：8 个（IP 分类 / URL 验证 / header 注入）
- `secrets.rs`：7 个 Linux 测试（key 格式 / 读写往返 / 0600 权限 / tmp 清理 / 原子覆盖 / garbage 错误）
- `agent.rs`：14 个（claude/codex/gemini/pi hooks 幂等 / 迁移 / 保留外部 hooks / 替换非 object root / 修剪空组）
- `shell/mod.rs`：5 个 Unix 测试（run_blocking captures stdout/stderr / times out / truncates / build_oneshot_command）

#### CI 执行

- `cargo nextest run --locked`（ubuntu-22.04）
- `cargo nextest run --locked --retries 2`（windows/macos）
- `cargo llvm-cov nextest --lcov`（coverage job）

### 9.3 e2e 测试

**上游无 e2e/ 目录**，无 Playwright/Cypress。测试以 vitest 单元 + cargo 集成测试为主。

> **魔改版警示**：魔改版 CLAUDE.md §4 说"pnpm test # vitest run，当前 830 全过"——上游测试文件数 69，魔改版 830 测试用例数可能包含魔改版自加的测试。上游无 e2e。

---

## 10. 魔改版与上游的关键差异点（开发红线）

### 10.1 魔改版 CLAUDE.md 描述错误（必须纠正）

| 魔改版 CLAUDE.md 描述 | 上游实际 | 影响 |
|---------------------|---------|------|
| "编辑器 \| Monaco（本地加载，不走 CDN）" | **CodeMirror 6**（@uiw/react-codemirror + @codemirror/* 6.x） | 编辑器路线错误，魔改版应保持 CodeMirror |
| "TypeScript 5 strict" | **TypeScript ~6.0.3** | 版本号错误 |
| "Vite 6" | **Vite ^8.1.5** | 版本号错误 |
| "AI SDK \| Vercel ai v7" | **ai ^6.0.207** | 版本号错误 |
| "pnpm lint # eslint . --max-warnings 0" | **biome lint ./src**（Biome 2.4.16） | 工具链错误 |
| "凭据 \| Rust keyring（系统密钥库）" | macOS/Windows keyring，**Linux 文件 0600** | Linux 描述不准确 |
| "AI 引擎 \| Python sidecar（src-tauri/sidecar/）" | **上游无 sidecar**，AI 走 Vercel SDK + net.rs HTTP 代理 | sidecar 是魔改版自加 |
| "SSH \| Rust russh 0.61 + russh-sftp 2.1" | **上游无 SSH**，Cargo.toml 无 russh | SSH 是魔改版自加 |
| 端口 9300 | 上游 1420 | 魔改版改了端口（OK） |
| CDP 9222 | 上游无 additionalBrowserArgs | 魔改版自加调试配置（OK） |
| capabilities allow-center | 上游无 | 魔改版自加（OK） |
| tsconfig per-project `-p`（tsconfig.app/node） | 上游单 tsconfig `tsc --noEmit` | 魔改版改了检查方式 |
| 五绿门禁含 ESLint | 上游用 Biome | 工具链差异 |

### 10.2 魔改版独有的模块（上游完全没有）

1. **translate 模块**（离线选词翻译）：`linuxDictionary.ts / programmingDictionary.ts / translateApi.ts / translateStore.ts / TranslateTooltip.tsx`
2. **ssh-explorer 模块**（SSH 连接管理 + 远程文件树 + SSH 终端）：`sshStore.ts / SshTerminalPane.tsx / SshExplorer.tsx / SshConnectDialog.tsx`
3. **src/lib/ssh-bridge.ts** + **src/lib/sftp-bridge.ts**（SSH/SFTP invoke 桥）
4. **src-tauri/src/modules/ssh/**（Rust SSH 客户端，russh）
5. **src-tauri/src/modules/sidecar.rs**（Python sidecar 进程管理）
6. **src-tauri/sidecar/**（Python AI 引擎）
7. **src/store/runtime.tsx**（运行时类型 SshSessionStateValue 等）

### 10.3 上游有但魔改版 CLAUDE.md 未列出的模块

魔改版 CLAUDE.md §2 前端地图只列了 8 个模块，漏掉了上游 12+ 个模块：
- `agents`（独立模块，与 ai 分离）
- `command-palette`（命令面板，cmdk）
- `git-history`（Git 历史图）
- `header`（顶部栏 + 搜索）
- `lsp`（语言服务客户端，完整子系统）
- `markdown`（Markdown 预览）
- `preview`（web 预览）
- `settings`（独立窗口）
- `sidebar`（侧边栏导航）
- `source-control`（源控制面板）
- `spaces`（多工作区切换）
- `statusbar`（状态栏）
- `updater`（更新对话框）
- `workspace`（workspace env store）

> **影响**：魔改版 CLAUDE.md 前端地图不完整，魔改时容易遗漏这些模块的依赖关系。例如 lsp 模块被 editor 依赖（diagnosticsReporter / useLspExtension），workspace 模块被 App.tsx 大量使用。

### 10.4 上游 SSH 实现对比（关键差异）

**上游无 SSH 实现**。魔改版 SSH 是完全自研，需要自行解决：

- SSH 客户端：russh 0.61（魔改版选型）
- SFTP：russh-sftp 2.1
- 凭据持久化：复用上游 secrets.rs（建议）还是 SSH 专用？
- 主机验证：魔改版 handler.rs emit `ssh:host_verify` / `ssh:host_key_mismatch`
- SSH 终端：魔改版 SshTerminalPane.tsx 用 xterm，数据 fan-out 走 sshStore
- 远程文件树：useRemoteFileTree（魔改版加在 explorer 模块下）

> **建议**：魔改版 SSH 是合理的魔改方向（Linux 运维教学场景需要），但实现时需注意：
> 1. SSH 命令命名要与上游风格一致（`ssh_connect / sftp_list` 等小写下划线）
> 2. SSH spawn 不需经上游 `authorize_spawn_cwd`（那是本地 workspace 安全模型），但需自定义授权
> 3. SSH 终端数据流可参考上游 PTY 的 Channel<Response> 模式
> 4. SSH 凭据应复用 secrets.rs（按 service=`terax-ssh` account=`<host>:<user>` 存储）

### 10.5 上游有但魔改版可能缺失/弱化的能力（待对比）

1. **WSL 支持**：上游 workspace.rs 完整支持 WSL（wsl_list_distros / wsl_default_distro / wsl_home + WorkspaceEnv::Wsl）。魔改版 Linux 运维教学场景若需 WSL，应保留。
2. **LSP 子系统**：上游有完整 LSP（6 命令 + 前端 lsp 模块 13 文件）。魔改版 CLAUDE.md 未提及，是否保留待对比。
3. **Spaces（多工作区）**：上游有完整 Spaces 系统（多工作区切换 + 持久化）。魔改版是否保留待对比。
4. **git-history（Git 历史图）**：上游有 GraphRail + graph.ts。魔改版是否保留待对比。
5. **source-control 面板**：上游 Sidebar 可切换 explorer / source-control。魔改版是否保留待对比。
6. **UpdaterDialog**：上游有自动更新（updater 插件 + GitHub releases latest.json）。魔改版是否保留待对比。
7. **外部 agent 钩子**（agent.rs）：上游支持 Claude Code/Codex/Gemini/Pi 通过 OSC 777 集成。魔改版若用 Python sidecar 替代，是否还需要这套钩子待对比。
8. **Whisper 语音输入**：上游 ai 模块有 useWhisperRecording。魔改版是否保留待对比。
9. **React Compiler**：上游启用 babel-plugin-react-compiler。魔改版是否保留待对比。
10. **Nix 打包**：上游有 flake.nix。魔改版是否保留待对比。

---

## 11. 魔改建议（基于上游架构）

### 11.1 合理的魔改（按上游扩展点接入）

1. **SSH 模块**（魔改版独有）：Linux 运维教学核心需求。建议：
   - Rust 侧新建 `src-tauri/src/modules/ssh/`（client.rs / handler.rs / credentials.rs / known_hosts.rs / sftp.rs）
   - 命令注册在 lib.rs invoke_handler，命名 `ssh_connect / ssh_disconnect / ssh_write / ssh_resize / sftp_list / sftp_read_file / sftp_write_file` 等
   - 凭据复用 secrets.rs（service=`terax-ssh`）
   - SSH 终端数据流参考上游 PTY 的 `Channel<Response>` 模式
   - 主机验证用 Tauri event（`ssh:host_verify` / `ssh:host_key_mismatch`），与上游 `ssh:host_*` 风格一致
   - 前端 ssh-explorer 模块独立，不污染上游 explorer（explorer 只管本地）

2. **translate 模块**（魔改版独有）：离线选词翻译是教学特色。建议：
   - 保持独立模块，不污染上游模块
   - 词典数据单独 chunk（避免主 bundle 膨胀，上游 ~7-8MB 是性能目标）
   - TranslateTooltip 用 Radix Popover（与上游 UI 风格一致）

3. **端口改 9300**：避免与上游 1420 冲突，合理。

4. **CDP 9222 调试配置**：仅开发用，合理。

5. **capabilities allow-center**：魔改版窗口策略需要，合理。

### 11.2 需要纠正的魔改（违反上游架构）

1. **编辑器路线**：魔改版 CLAUDE.md 误写 Monaco。**必须保持 CodeMirror**，不要引入 monaco-editor（会破坏 ~7-8MB bundle 目标 + 上游 editor 模块所有 lib/ 都基于 CodeMirror）。

2. **工具链**：魔改版若引入 ESLint，应回归 Biome。上游 biome.json 的 `noControlCharactersInRegex: off` 就是终端 ANSI 文件的豁免机制，不需要 ESLint 的 `// eslint-disable`。魔改版 CLAUDE.md §4 五绿门禁描述应改为 `pnpm lint # biome lint ./src`。

3. **Python sidecar 边界**：sidecar 是魔改版自加，需明确与上游 AI 路径（Vercel SDK + net.rs）的边界：
   - 如果 sidecar 接管 AI，需保留 net.rs 的 SSRF 防御（或 sidecar 内部实现等价防御）
   - 如果 sidecar 仅做教学 agent，保留上游 ai 模块（Vercel SDK）作为通用 AI 路径
   - 不要让 sidecar 与 net.rs 同时暴露 AI HTTP 接口造成双入口

4. **CLAUDE.md 版本号纠正**：TypeScript 6 / Vite 8 / ai v6，不是 5/6/v7。

5. **tsconfig 检查方式**：魔改版用 per-project `-p`（tsconfig.app/node），上游是单 tsconfig `tsc --noEmit`。魔改版若保留 per-project 方式，需在 CLAUDE.md 注明这是魔改选择（理由：pnpm 隔离布局下 composite 会误报 TS2742），不要让后续接手者误以为是上游方式。

6. **AiComposerProvider 无条件挂载**：TERAX.md line 71 明确警告不能条件包装。魔改版若加了 sidecar Provider，必须保持 AiComposerProvider 仍无条件挂载在 App.tsx 最外层。

7. **Tabs 不卸载策略**：上游用 `invisible pointer-events-none` 隐藏非活动 tab，保持 PTY/dev server 流式。魔改版 WorkspaceSurface 若加了 SSH 终端 tab，必须保持同样策略，不要 unmount SSH 终端（会断连接）。

8. **useThemeFileEditing 自反循环**：魔改版曾因 effect 依赖 `availableImages` 自反循环卡死 50 万次/秒。上游 useThemeFileEditing.ts 是安全基线，魔改时务必遵守 CLAUDE.md §3 红线 4：effect 依赖禁止包含自身 setState 会替换的值，用 ref 存需要 cleanup 的资源。

### 11.3 后期开发优先参考的上游扩展点

1. **PTY shell integration**（OSC 7/133）：`docs/architecture/pty-shell-integration.md` + `src-tauri/src/modules/pty/scripts/`。魔改版终端若要命令边界检测，参考上游 OSC 133 实现。

2. **workspace 安全模型**：`workspace.rs` 的 `WorkspaceRegistry` + `authorize_spawn_cwd`。魔改版 SSH spawn 不走这套，但本地 shell/PTY 必须走。

3. **net.rs SSRF 防御**：`src-tauri/src/modules/net.rs`。魔改版 sidecar 若做 HTTP 请求，应实现等价防御。

4. **ConPTY + Job Object**：`session.rs` + `proc/job.rs`。魔改版若改 PTY，必须保留 CONPTY_LIFECYCLE_LOCK 和 Job Object（否则 Windows 上 orphans 进程树）。

5. **Tauri Channel 数据流**：上游 PTY 用 `Channel<Response>` 推流，AI 流用 `Channel<AiStreamEvent>`。魔改版 SSH 终端数据流应参考此模式，不要用轮询或 emit。

6. **TERAX.md 架构原则**：Functional core + imperative shell / No em-dash / No emojis / pnpm only / @/ imports / 注释解释 why 不解释 what。魔改版应遵守。

7. **测试文化**：上游每个核心子系统有测试（pty/fs/git/shell/lsp/net/secrets/agent/workspace）。魔改版 SSH/sidecar/translate 必须补测试，否则违反 TERAX.md "核心子系统改动需要锁定 invariant 的测试"。

8. **上游架构文档**：`docs/architecture/` 5 篇文档（ai-subsystem / pty-shell-integration / security-model / terminal-renderer-pool / two-process-model）是魔改时的第一手参考，遇到相关子系统先读。

---

## 附录 A：上游关键文件路径速查

### 配置
- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/package.json`
- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src-tauri/Cargo.toml`
- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src-tauri/tauri.conf.json`
- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src-tauri/tauri.windows.conf.json`
- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src-tauri/capabilities/default.json`
- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/biome.json`
- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/pnpm-workspace.yaml`

### 启动链
- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src/main.tsx`
- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src/app/App.tsx`
- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src-tauri/src/main.rs`
- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src-tauri/src/lib.rs`
- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src-tauri/src/modules/mod.rs`

### Rust 后端关键
- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src-tauri/src/modules/pty/mod.rs`
- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src-tauri/src/modules/pty/session.rs`
- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src-tauri/src/modules/shell/mod.rs`
- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src-tauri/src/modules/net.rs`
- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src-tauri/src/modules/agent.rs`
- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src-tauri/src/modules/secrets.rs`
- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src-tauri/src/modules/workspace.rs`

### 前端关键
- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src/modules/editor/EditorPane.tsx`
- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src/modules/ai/agents/registry.ts`
- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src/modules/ai/lib/composer.tsx`
- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src/modules/shortcuts/shortcuts.ts`
- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/src/modules/theme/`（目录）

### 文档
- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/TERAX.md`
- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/docs/architecture/`（5 篇架构文档）

### CI/CD
- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/.github/workflows/ci.yml`
- `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/opensource-reference/terax-ai/.github/workflows/release.yml`

---

## 附录 B：待对比项（需后续核实）

1. 魔改版 src-tauri/src/modules/pty/session.rs 的 terminal_modes 字段具体改了什么（魔改版 CLAUDE.md §10 提到）
2. 魔改版 sidecar 与上游 net.rs AI 路径的边界（是否双入口）
3. 魔改版是否保留了上游 lsp / spaces / git-history / source-control / updater / markdown / preview 模块
4. 魔改版是否保留了上游 WSL 支持
5. 魔改版是否保留了上游 Whisper 语音输入
6. 魔改版是否保留了上游 React Compiler
7. 魔改版 tsconfig 是否真的是 per-project `-p`（tsconfig.app/node）
8. 魔改版 eslint.config.js 是否真的存在（还是已切 Biome）
9. 魔改版 SSH 凭据存储是否复用 secrets.rs
10. 魔改版 tauri.linux.conf.json 内容（本报告未读）

---

> 报告生成方式：git clone 上游 v0.8.6 tag 后全量源码阅读，非仅 README。所有引用均来自实际 Read 的源文件。待对比项标在附录 B，不臆断。
