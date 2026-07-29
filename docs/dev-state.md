# TDSF Terminal Agent — 开发状态（dev-state）

> **接手第一件事读本文件 + `CLAUDE.md`**。本文件是唯一进度/问题记忆源。
> **项目 = crynta/terax-ai v0.8.6 魔改版**（唯一基线，自研 v4.0.0 已废弃删除）。
> **最后更新**：2026-07-30 · 大恢复完成，应用可运行，进入稳定性/功能修复阶段。

---

## 一、当前状态：✅ 可运行（从"编译不过 + 窗口打不开"完全恢复）

| 门禁 | 状态 |
|------|------|
| typecheck (app+node) | ✅ 0 错误 |
| lint | ✅ 0 错误 0 警告 |
| test (vitest) | ✅ 830/830 |
| build:web | ✅ 成功 |
| tauri:dev 桌面端 | ✅ 窗口可见、可点击、本地终端(PTY pwsh)工作、SSH 可连、文件树可展开 |

**已验证可用**：窗口显示/窗控、欢迎页引导、点击"打开本地终端"→ xterm 终端、SSH 连接、左侧远程文件资源管理器展开。

---

## 二、已知问题（下一阶段待修，按优先级）

### P0 — 影响核心体验
1. **SSH 连接后 shell 终端无法显示**：SSH 能连、files 资源管理器能看能展开，但右侧 SSH shell 终端不出内容。
   - 排查方向：`src/modules/ssh-explorer/SshTerminalPane.tsx`（本次恢复时重写的，用 `sshStore.subscribeTerminalData` 订阅 fan-out 数据 + xterm 渲染）↔ `sshStore.ts` 的 `emitTerminalData`/pendingBuffer 数据流 ↔ Rust `ssh_connect` 的 onData channel。可能是订阅时机/sessionId 传递/数据未 fan-out 到 pane。
2. **资源管理器多点几个文件夹就卡死**：疑似又一处无限重渲染或递归加载/未缓存。
   - 排查方向：`src/modules/explorer/lib/useRemoteFileTree.ts` / `useFileTree.ts` 的展开逻辑、SFTP 递归、effect 依赖（参考本次背景图卡死同类模式：selector 新引用 / effect 自反依赖）。**先用 CLAUDE.md §5 诊断方法论测 measure 频率确认是否又是无限渲染**。

### P1 — IDE 常用功能缺失
3. **资源管理器文件点击无法在新窗口/新标签打开**：点击文件应在编辑器标签打开。
   - 排查方向：`FileExplorer` 的 onFileClick → `openFileTab`（App.tsx）→ tabs 模块 → `src/modules/editor/` Monaco 挂载。
4. **无法编辑保存**：编辑器打开后编辑/保存链路不通。
   - 排查方向：`useEditorFileSync`、Monaco onChange → 本地 `fs` 写 / 远程 `sftpWrite`；保存快捷键 Ctrl+S 绑定。

### P2 — 已知但不阻塞主体
5. **Python sidecar 启动即崩溃** → AI Agent 后端不可用（终端/SSH/编辑不受影响）。
   - 现象：`src-tauri/sidecar/main.py` 注册 ping/shutdown/status 后 stdout closed 退出。Rust `modules/sidecar.rs` 的 restart loop **无退避**（崩溃即重启，虽当前只重启 1 次，但应加退避+最大次数防未来事件洪流）。
   - 排查方向：Python 端 main.py ready 通知/依赖缺失；`cd src-tauri/sidecar && python main.py` 手动跑看 traceback。
6. **整体稳定性欠缺**：需系统排查其余组件是否有同类 effect 循环/内存泄漏。

---

## 三、本次大恢复经验时间线（2026-07-29 ~ 07-30，血泪沉淀）

**背景**：之前某 AI 会话把工作区改乱——多个源文件被清成 0 字节、配置被砍、依赖被退回，导致编译失败、窗口打不开、卡死。以下是恢复全过程与教训。

### 阶段 1：编译恢复（439+ TS 错误 → 0）
- **translate 模块**：`linuxDictionary.ts` 从 `.bak` 恢复（脚本去重 46 键 + 8 连字符键加引号）；`programmingDictionary.ts` 去重 258 键；重写 4 个 0 字节文件（store/tooltip/selection/index）。
- **shortcuts 模块**：0 字节 `shortcuts.ts` **从上游 crynta/terax-ai 恢复** + 加 `terminal.translate`(Ctrl+Shift+T)。
- **ssh 桥接**：`ssh-bridge.ts` 补回凭据 API + 主机验证事件订阅(snake→camel) + `HostApprovalRequest` 改造；`sftp-bridge.ts` 补 `joinRemotePath`；重写 0 字节 `SshTerminalPane.tsx`；`sshStore` 加 `selectActiveSessionCurrentPath`。
- **theme 模块**：`types.ts` 补回 `editorTheme` 字段；`ThemeProvider` 补回 customThemes；`themes/index.ts` 恢复 16 主题注册（曾被砍到 5 个）。
- **tsconfig**：改 per-project `-p` 检查（composite 在 pnpm 隔离布局下误报 TS2742）。
- **AI SDK v7 迁移**：usage 字段 `outputTokenDetails.reasoningTokens` / `inputTokenDetails.cacheReadTokens`。

### 阶段 2：⚠️ 事故 —— AI 自己制造污染（教训）
- 误执行 `git checkout package.json pnpm-lock.yaml` 想撤销自己加的依赖，**把这两个文件退回自研版 HEAD，丢了 terax 的 65 个依赖**。用会话记录的全文恢复 package.json + `pnpm install` 重建 lock。
- **教训**：对已跟踪文件，单文件 `git checkout` 同样是污染。撤销自己的改动必须用 Edit 反向编辑，绝不用 git 回退。

### 阶段 3：启动链修复（窗口"看不见"）
- 对照上游发现三处被污染：① `main.tsx` 挂错壳（应挂 `src/app/App.tsx` terax 壳，而非旧 `src/App.tsx`）② 缺上游的 `showWindow`（窗口 `visible:false` 创建，需前端首帧后 `setTimeout(getCurrentWindow().show, 50/500)`）③ `capabilities/default.json` 被裁成 P0 最小集，缺 `core:window:allow-show` 等 → show() 被权限系统拦截。全部按上游恢复。

### 阶段 4：卡死根因（"点不动"）—— 无限重渲染
- **根因**：`useThemeFileEditing.ts`（App 根组件挂载）的 useEffect 把 `availableImages` 放进依赖数组，而 effect 通过 `refreshImages → setAvailableImages(全新数组)` 每次产生新引用 → effect→setState→重渲染→effect 无限循环。setState 在 async 微任务内执行，**逃过 React max-update-depth 守卫**（无报错），整树每秒重渲染 **512682 次**，主线程占满 → 一切点击无响应。
- **诊断**（主线程卡死，常规手段失效，靠 CDP 逐步逼近）：CPU Profiler 热点全是 `measure` → 调用栈 `flushPassiveEffects←commitPassiveMountOnFiber`（=useEffect 循环）→ measure name 计数发现全树 Radix 重渲染 → 排除 sidecar/ResizeObserver → general-purpose agent 静态通读顶层组件锁定自反依赖。详见 `CLAUDE.md §5`。
- **修复**：用 `createdUrlsRef` 追踪 blob URL，effect 依赖移除 `availableImages`。measure 512682/s → **0/s**，点击恢复。

---

## 四、git 基线（清理后）

- 历史已于 2026-07-30 清理：删除自研 v4.0.0 全部旧提交 + stash 残留，仅保留 terax 魔改版可运行基线。
- 当前分支：`terax-clone-v0`（唯一有效分支）。
- 无远程仓库（纯本地）。

---

## 五、下一步（建议顺序）

1. 修 P0-1 SSH shell 终端不显示（数据流排查）。
2. 修 P0-2 资源管理器多点卡死（先测是否又是无限渲染）。
3. 修 P1-3/4 文件打开 + 编辑保存（IDE 核心）。
4. 修 P2-5 Python sidecar 崩溃（恢复 AI 能力）。
5. 每修一项：五绿 + `tauri:dev` 实测 + commit 固化。
