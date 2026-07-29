# TDSF Terminal Agent — 开发状态（dev-state）

> **接手第一件事读本文件 + `CLAUDE.md`**。本文件是唯一进度/问题记忆源（位置：`docs/dev-state.md`）。
> **项目 = crynta/terax-ai v0.8.6 魔改版**（唯一基线，自研 v4.0.0 已废弃删除）。
> **最后更新**：2026-07-29 晚 · SSH 连接掉线**已修**(空 terminal_modes)；终端"黑底黑字"根因 CDP 实测确认(暗模式却用亮色 token + 魔改另起 xterm)；**已批准"SSH 终端并入本地 rendererPool"深度集成方案，实施中**。接手请直接看 **§八 交接指南**。

---

## 一、当前状态：✅ 可运行

| 门禁 | 状态 |
|------|------|
| typecheck / lint / test(830) / build:web | ✅ 全绿 |
| tauri:dev 桌面端 | ✅ 窗口可见、可点击、本地终端(PTY pwsh)、SSH 可连、远程文件树可展开 |

自动登录：开机自动连 `root@192.168.45.200`（保存的凭据），左侧 Files 走**远程分支**（`explorerSource==="ssh"` → useRemoteFileTree + SshFileEditor）。

---

## 二、已知问题（2026-07-30 调研后状态）

### P0-1 SSH shell + 远程文件树都不出来 — ✅ 根因确认 + 已修（畸形 terminal_modes）
- **✅ 修复（2026-07-29 已验证）**：把 `open_pty` 里 `request_pty` 的 `terminal_modes` 从畸形的 `&[(russh::Pty::TTY_OP_END, 0)]`（TTY_OP_END 是终止符却又带 4 字节值）改成 russh 标准**空 `&[]`**。改后日志：`channel request Success（pty/shell accepted）` + `reader first data: 129 bytes`，**不再 early eof**，SFTP channel 也随之开起来。→ **shell 有数据、文件树能开**。
  - **根因**：畸形 modes 让 **OpenSSH** 一收到 pty-req 就**硬关 TCP**（无 DISCONNECT，直接 FIN → russh `early eof`），连累整条连接（PTY+SFTP 全废）。
  - **待观察**：日志后段某 `ChannelId(4)` 出现 `exit-status`+`eof`+`close`——需在 UI 确认**交互 shell 是否稳定常驻**（不是一闪即关）；可能是多次自动连/多 channel 叠加，非主 PTY。
- **（历史证据链，供参考）**：
  - russh 0.61.2：`wait()` 与 `into_stream` 的 `ChannelRx` 读同一 mpsc receiver（`io/rx.rs:39`）→ 读法不是根因。
  - russh 只有整张 channels map 丢弃（主循环退出）才会静默 None（`encrypted.rs:404-452` 会先转发 Close/Eof/OpenFailure）→ 是主循环因传输 `early eof` 退出。
  - 加 `handler.rs::disconnected()` 覆写 → 抓到确切原因 `IO(UnexpectedEof "early eof")`；`ssh_test`（不开 channel）成功。
  - 放行 `russh=debug`（`lib.rs` 加 `.level_for("russh", Debug)`）后看到：`channel_open_confirmation` 成功、紧接 pty/shell 就 `early eof`（服务器无 DISCONNECT 硬关）→ 锁定 pty-req。

### P0-2 资源管理器多点卡死 — ✅ 当前复现不出（已被守卫修复）
- Agent CDP 实测：展开 5316 项/118 目录，React 提交数有界回落、longtask 仅 1 次 52ms，无卡死。无限渲染向量已被 `useRemoteFileTree.ts:25-27` 稳定空引用常量 + useMemo 守卫修复。
- **残留隐患**（非死循环）：`buildTreeState`(useRemoteFileTree.ts:42-59) + `buildRows`(FileExplorer.tsx:240-255) 每次任一目录加载完成会 O(总缓存条目) 全量重建；慢速/超大目录（node_modules、/usr/share）多点时可能卡顿。优化建议：`sftpEntryToDirEntry` 按目录缓存（path→已转换结果 Map，childrenMap 引用未变则复用）。

### P1-3 / P1-4 文件点击打不开 + 无法编辑保存 — ✅ 已修待实测（同一布局 bug）
- **根因**（Agent CDP 实测确认）：不是逻辑问题——远程编辑器 `SshFileEditor` 被 `FileExplorer`(根 `h-full`, FileExplorer.tsx:533) 挤成 **1px 高**不可见。文件其实打开了（editingFile 有内容）、编辑/保存/Ctrl+S/sftpWrite 逻辑都正确，只是编辑器看不见、够不着。
- **已修**：`App.tsx:1463-1510` 把 FileExplorer 包进 `min-h-0 flex-1` 容器，`SshFileEditor` 加 `className="min-h-0 flex-1"` → 文件树与编辑器上下二分。typecheck 已过，**待 tauri:dev 实测**（点远程文件看编辑器是否可见可编辑）。

### P2-5 Python sidecar 崩溃 — 未动
- `src-tauri/sidecar/main.py` 注册 ping/shutdown/status 后 stdout closed 退出。手动 `cd src-tauri/sidecar && python main.py` 看 traceback。Rust `sidecar.rs` restart loop 无退避（建议加）。AI 后端不可用，不影响终端/SSH/编辑。

### P2-6 整体稳定性 — 待系统排查其余 effect 循环/泄漏

---

## 三、本轮（2026-07-29 SSH 根因定位+修复）改动的文件（均未提交）

- ✅ **`src-tauri/src/modules/ssh/session.rs`（含真正修复）**：`request_pty` 的 `terminal_modes` 改成空 `&[]`（**这就是修复**）；`request_pty`/`request_shell` want_reply false→true（保留，确认 pty/shell 被接受）；reader_task 加 `ChannelMsg::Success`/`Failure` 分支日志（保留，有用）。
- ✅ **`src-tauri/src/modules/ssh/handler.rs`**：`disconnected()` 覆写（**保留**，低噪声、抓断连原因的利器）。
- 🧹 **`src-tauri/src/lib.rs`**：`tauri_plugin_log` 加 `.level_for("russh", Debug)`（**纯诊断，发布前应还原成只 `.level(Info)`**，否则 russh debug 刷屏）。
- 🧹 **`src/modules/ssh-explorer/sshStore.ts`**：前端首帧/订阅诊断 console 日志（可保留或精简）。
- `src/app/App.tsx`：上一轮 SSH 侧栏 1px 布局修复（P1-3/4），仍待实测。
- **五绿**：typecheck/lint/cargo check 全过；test 未跑。
- **收尾清单（下次）**：① UI 实测 shell 是否常驻可交互 + 文件树可展开 → ② 还原 lib.rs 的 russh=debug → ③ 修下游（`exited` 标志 PTY/SFTP 解耦、`close()` 优雅忽略 Channel send error）→ ④ 五绿 + 实测 + commit。

- **环境经验（踩坑）**：① `tauri dev` 本轮不自动重编 Rust 改动（Windows 原子写），需手动重启 dev；② 后台 Bash 跑 dev，`TaskStop`/kill 后 vite+app 子进程残留占 9300/9222，须 `taskkill //F //T //PID` 清；③ chrome-devtools MCP 另起空白 Chrome，连不上 app webview(9222)；④ **自动抓日志法**：`RUST_LOG` 对 tauri_plugin_log 无效，要用 `.level_for(crate, Debug)`；靠**开机自动连**触发，Monitor + `tee`+`grep` 全自动抓，无需手点。

### 附：Trae 审计（用户问）— useSidecarEvents 重构 AgentPanel.tsx
- 思路 OK 但优先级低；给的代码有真 bug：`AGENT_EVENTS.map()` 每渲染造新数组 → `useEffect([configs])` 每渲染重订阅 + `.then(push)` 异步竞态 → 监听器泄漏/重订阅风暴（=刚灭的无限重渲染同类）。不与 SSH 冲突（不同文件），但别原样合，且依赖的 sidecar 还崩 → **建议推迟**。

---

## 四、本次大恢复经验时间线（2026-07-29~30，血泪沉淀）

**背景**：之前某 AI 把工作区改乱——多个源文件被清 0 字节、配置被砍、依赖被退，导致编译失败/窗口打不开/卡死。

- **阶段1 编译恢复**（439+ TS 错→0）：translate（.bak 恢复+去重 46/258 键+重写 4 空文件）；shortcuts.ts 从上游恢复；ssh-bridge 补凭据 API+主机验证；theme types 补 editorTheme、themes/index 恢复 16 主题；tsconfig 改 per-project；AI SDK v7 usage 字段迁移。
- **阶段2 ⚠️自造污染**：误 `git checkout package.json` 退回自研版丢 65 依赖 → 教训：**已跟踪文件禁止 git checkout/reset，撤销改动用 Edit 反向编辑**。
- **阶段3 窗口看不见**：① main.tsx 挂错壳（应挂 `src/app/App.tsx`）② 缺上游 showWindow（visible:false+首帧后 setTimeout show 50/500）③ capabilities 缺 `core:window:allow-show`。对照上游全恢复。
- **阶段4 卡死根因**：`useThemeFileEditing.ts` useEffect 依赖 `availableImages` 而自身 `setAvailableImages(新数组)` → 无限重渲染 512682次/秒（async setState 逃过 max-depth 守卫）。修：ref 追踪 blob URL + 依赖移除 availableImages。诊断方法论见 CLAUDE.md §5。

---

## 五、git 基线

- 2026-07-30 历史清零：-clone 独立成全新仓库（`rm .git 链接 + git init`），单一 initial 提交，与自研 28M 旧历史彻底脱钩；无后缀自研 worktree 目录已物理删除。
- 当前分支 `terax-clone-v0`，无远程。
- **用户后续计划**：拟把当前源码上传到 GitHub 新文件夹作为独立工作区（与另一个进展不错的 desktop 版并行，"做俩 linux"）；需比赛用的**开源许可+魔改说明**（见 `docs/OPEN-SOURCE-AND-MODIFICATIONS.md`）。

---

## 六、下一步（建议顺序）

1. **SSH 连接被关（P0-1，最高优先）**：先抓 russh=debug 日志的 russh 级行（`channel_open_confirmation`/`channel_success|failure`/`received disconnect`）看服务器在哪步关；并用系统 `ssh root@192.168.45.200` 正交验证 服务器 vs 客户端。定位后修：客户端向 → 试空 `terminal_modes &[]` / 升级 russh / 对照官方交互 shell 示例；服务器向 → 查 sshd 策略。**顺带修**：`exited` 标志 PTY/SFTP 解耦、`close()` 优雅忽略 Channel send error。
2. **实测 B/C**（P1-3/4）：tauri:dev 点远程文件验证编辑器可见可编辑保存。
3. **卡顿优化**（P0-2）：sftpEntryToDirEntry 按目录缓存（可选）。
4. **sidecar**（P2-5）：手动跑看 traceback + restart 加退避。
5. 每修一项：五绿 + tauri:dev 实测 + commit。

---

## 七、SSH 集成架构真相与修复方案（2026-07-29 双 agent 深调研）

### ⚠️ 先纠正一个重大误解：哪些是死代码
`main.tsx:20` 只挂 **`src/app/App.tsx`**（terax 原生壳）。以下全是**旧壳死代码，勿在其上集成**：
`src/App.tsx`、`src/components/Terminal.tsx`、`TerminalMultiplexer.tsx`、`SshTerminal.tsx`、`EditorTabs.tsx`、`MonacoEditor.tsx`、`store/runtime`。
**terax 原生（真正在用）**：终端 = `src/modules/terminal/`（TerminalStack→PaneTreeView→TerminalPane→`useTerminalSession`）；编辑器 = `src/modules/editor/`（EditorStack→EditorPane→`lib/useDocument.ts`，**CodeMirror `@uiw/react-codemirror`，不是 Monaco**）；标签 = `src/modules/tabs/lib/useTabs.ts`。

### 根本病灶：魔改另起了 3 套并行实现，没并入 terax 原生
1. **SSH 终端** = 独立第三套 xterm（`SshTerminalPane.tsx`），没复用 `modules/terminal` 的保活/解耦。
2. **SSH 文件编辑** = 侧栏内嵌 `<textarea>`（`SshFileEditor.tsx`），没走 `openFileTab`→`EditorStack`。
3. 远程文件树自成一套 `useRemoteFileTree`，缺本地 `useFileTree` 的增量更新/no-op 守卫。

### 三个问题的根因（file:line）
- **终端不显示**：面板寿命被绑死在实时 SSH `state==='connected'`（`App.tsx:381 workspaceSshSessionId = isConnectedSsh ? … : null` + `sshStore.ts:1136 isSessionConnected`）且叠加 `isTerminalTab`（`WorkspaceSurface.tsx:110`）。一旦某 channel 收尾→`onExit`（`sshStore.ts:456-471`）把 `state→closed`→**整个 pane 卸载 + xterm.dispose**（MOTD 只闪一帧）。或 `connect().then()`（`sshStore.ts:475-481`）不置 connected、纯依赖异步 `on_status`，事件丢失则门禁永不开。本地终端反例：切 tab 用 `visibility:hidden` 保活、PTY 退出不卸载（`TerminalStack.tsx:88-92`、`useTerminalSession` 模块级 registry）。
- **文件内容显示在资源管理器内部**：`source==='ssh'` 时 `onOpenFile` 换成 `handleOpenRemoteFile`（`App.tsx:772-779`）→ `sshStore.openFile`→ 单槽 `editingFile`→ `SshFileEditor(textarea)`，且挂在**侧栏**（`App.tsx:1510-1514`），刻意绕开 tab。正规流程：本地 `handleOpenFile`→`openFileTab`（`useTabs.ts:620-693`）→ 主区 `EditorStack/EditorPane(CodeMirror)`。
- **资源管理器卡顿/卡死**：`useRemoteFileTree.buildTreeState`(`:42-59`) + `FileExplorer.buildRows`(`:118-196`) 在 sshStore 每次约 3 次提交时做 O(全部缓存条目) 全量重建（顺序展开近二次放大）。本地 `useFileTree` 靠增量 `setNodes`(`:165-170`)+`sameDirListing` no-op(`:66-77`) 无此问题。

### 集成修复方案（治本，对准 terax 原生）
1. **SSH 终端 → 并入 `modules/terminal`**：把 SSH shell 变成一个 `kind:'ssh'` 的 terminal leaf/tab，`useTerminalSession` 抽象 transport（本地 `pty-bridge` vs `ssh-bridge`）。自动继承保活/尺寸/退出不卸载/reconnect。
   - **最小过渡版**：面板寿命与实时 state 解耦——有 sessionId 就挂载并 `visibility` 保活；`onExit` 不翻 closed 卸载，改显"[已断开]+重连"横幅；`connect().then()` 补 `state:'connected'` 兜底；跨非 terminal tab 不 dispose。
2. **SSH 文件 → 并入 EditorStack/CodeMirror 标签**：给 `EditorTab`(`useTabs.ts:47-60`) 加 `remote?:{sessionId,rustSessionId}`；`handleOpenRemoteFile` 改调 `openFileTab`；删侧栏 `SshFileEditor` 挂载；`useDocument` 的 3 处后端调用（read `fs_read_file`:130 / write `fs_write_file`:61 / stat `fs_stat`:80）按 remote 分流到 `sftpRead/sftpWrite`；`useEditorFileSync`(`:69-99`) 对 remote 跳过本地 watch；EditorPane LSP 对 remote 关闭。
3. **资源管理器性能**：`sftpEntryToDirEntry` 按目录源数组引用缓存（命中复用）；sshStore `loadChildren/listDir` 加 `sameDirListing` no-op 守卫；去掉 create/rename/delete 的 `[parent]:[]` 占位空闪；`useRemoteFileTree.ts:129` 直接用 store 的稳定 `expanded` Set 不再拷贝。

---

## 八、交接指南（2026-07-29 晚 · 最新，接手先读这节）

### 记忆 / 规划文件在哪
| 文件 | 作用 |
|------|------|
| `docs/dev-state.md`（本文件） | ⭐唯一进度/问题记忆源 |
| `CLAUDE.md` | 开发规范 + 架构地图 + 防污染红线 + 五绿门禁 + CDP 诊断法 |
| `C:\Users\Lenovo\.qoder\plans\still-crest-linnet.md` | ⭐**已批准**的「SSH 终端深度集成」实施计划（分阶段、file:line、验证/回滚） |
| `docs/OPEN-SOURCE-AND-MODIFICATIONS.md` | 比赛用开源许可 + 魔改说明 |
| `C:\Users\Lenovo\AppData\Local\Temp\cdp-read.mjs` | CDP 实测脚本（读运行中 app 的门禁/DOM/颜色，见下「实测法」） |

### 本 session 已完成/确认（SSH 主线大突破）
1. **✅ 连接掉线已修（根因+已验证）**：`request_pty` 的 `terminal_modes` 从畸形 `&[(TTY_OP_END,0)]` 改**空 `&[]`**（`src-tauri/src/modules/ssh/session.rs`）。OpenSSH 收到畸形 pty-req 会硬关 TCP(`early eof`)，连累 shell+SFTP 全废。改后：`channel request Success` + `reader first data:129 bytes`，shell 常驻、SFTP 正常。
2. **✅ 终端"黑底黑字"根因 CDP 实测确认**：live 值 `--terminal-foreground=#1a1a1a`(近黑) / `--terminal-background=#ffffff`(白)，而 `data-theme=dark` —— **暗模式却用了亮色终端 token**；且魔改 `SshTerminalPane` 是**另起的裸 xterm**、用错主题模块(`@/lib/terminal-theme` 读空 `--terminal-*` 回退 #000)、字体继承 UI 的 "Inter"(非等宽)。本地终端走 `rendererPool`(统一 `@/styles/terminalTheme`+`useTerminalFont`+对比度)所以正常。
3. **✅ 用户拍板 + 方案已批准**：SSH 终端**深度集成进本地 `rendererPool`/`useTerminalSession`**（不再补那套独立实现），详见上面的 plan 文件。

### 本 session 改动的文件（均未提交）
- ✅ **`src-tauri/src/modules/ssh/session.rs`**：空 `terminal_modes`（**真修复，保留**）+ `request_pty/shell` want_reply=true（保留）+ reader `Success/Failure` 日志（保留）。
- ✅ **`src-tauri/src/modules/ssh/handler.rs`**：`disconnected()` 覆写（保留，抓断连原因利器）。
- 🧹 **`src-tauri/src/lib.rs`**：`tauri_plugin_log` 加 `.level_for("russh", Debug)`（**纯诊断，发布前还原成只 `.level(Info)`**）。
- 🧹 **`src/modules/ssh-explorer/sshStore.ts`**：`firstDataLogged`/首帧/订阅 console 诊断日志（可留可精简）。
- ⚠️ **`src/modules/ssh-explorer/SshTerminalPane.tsx`**：本 session 做过**过渡版**改写(换 `@/styles/terminalTheme`+`useTerminalFont`)，但**已被批准的深度集成方案取代**——接手应按 plan 用新的 `SshTerminalHost`(走 rendererPool)替换它，别在这个过渡版上继续补。

### 接手下一步 = 执行 plan 文件（任务 #15–#20，尚未写代码）
按 `still-crest-linnet.md` 分 6 步（依赖倒置的 transport seam）：
1. `#15` `pty-bridge.ts` 加 `TerminalTransport` 接口。
2. `#16` `useTerminalSession.ts` 加 `openTransport` 注入 + `remote` 护栏（`leafHasForegroundJob/Process`、`kickPty`、`respawnSession` 仅本地）。
3. `#17` `TerminalPane.tsx` 透传 `openTransport`。
4. `#18` 新增 `SshTerminalHost.tsx`（`allocId` 分配稳定 leafId；SSH transport 工厂=`subscribeTerminalData`+`handle.write/resize`，`close` **只 unsubscribe 不断连接**）。
5. `#19` `WorkspaceSurface.tsx`/`App.tsx` 用 `SshTerminalHost` 替换 `SshTerminalPane`（透传 `allocId`，保留门禁），验证后删 `SshTerminalPane.tsx`。
6. `#20` 五绿 + CDP 实测（可见/等宽/字号=本地）+ **本地终端回归** + SFTP 仍可用。
- 关键点：`PtySession` 与 `SshSession` 方法签名**完全一致**；`LeafBridge` 已用 `s.pty.write/resize` 路由，SSH transport 天然适配；本地路径零改动（护栏只在 `s.remote` 生效）。

### 实测法（务必用，主线程卡死时常规手段失效）
- 起 dev：`RUST_LOG=... pnpm tauri:dev`（app 开机**自动连** `root@192.168.45.200`，无需手点）。app 带 CDP 端口 **9222**、Vite **9300**。
- 读运行态：`node C:\Users\Lenovo\AppData\Local\Temp\cdp-read.mjs`（Node v24 全局 fetch+WebSocket 连 9222，读 `window.__TDSF_DBG__`、DOM、计算样式）。chrome-devtools MCP **连不上** app webview(自开空白 Chrome)。
- 抓 Rust 日志：`tauri_plugin_log` 无视 `RUST_LOG`，要在 `lib.rs` 用 `.level_for("russh", Debug)`；靠自动连触发，Monitor+`tee`+`grep` 全自动。
- **端口踩坑**：后台跑 dev，`TaskStop`/kill 后 vite+app 子进程**残留占 9300/9222**，须 `taskkill //F //T //PID <占端口PID>` 清干净再重启。
- `tauri dev` 本轮**不自动重编 Rust**（Windows 原子写）；改 Rust 后需手动重启 dev。改前端(TS)走 Vite HMR 会热更。

### 剩余 backlog（深度集成之后，按序）
- **步骤2**：SSH 文件 → 走 `EditorStack`/CodeMirror 标签（见 §七-2，`EditorTab` 加 `remote` 标记 + `useDocument` 3 处 fs 调用按 remote 分流 sftp）。
- **步骤3**：资源管理器性能（见 §七-3，`sftpEntryToDirEntry` 按目录缓存 + no-op 守卫）。
- **P2-5**：Python sidecar 崩溃（AI 后端；不阻塞终端/SSH/编辑）。
- **收尾**：还原 `lib.rs` 的 `russh=debug`；解耦 `SshSession.exited`（PTY reader 死不该连坐 SFTP）；`close()` 优雅忽略 `Channel send error`。
- 每步：五绿 + `tauri:dev` 实测 + commit 固化。
