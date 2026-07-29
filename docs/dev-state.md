# TDSF Terminal Agent — 开发状态（dev-state）

> **接手第一件事读本文件 + `CLAUDE.md`**。本文件是唯一进度/问题记忆源（位置：`docs/dev-state.md`）。
> **项目 = crynta/terax-ai v0.8.6 魔改版**（唯一基线，自研 v4.0.0 已废弃删除）。
> **最后更新**：2026-07-30 · 功能修复阶段（SSH shell 调研中，B/C 布局已修待实测）。

---

## 一、当前状态：✅ 可运行

| 门禁 | 状态 |
|------|------|
| typecheck / lint / test(830) / build:web | ✅ 全绿 |
| tauri:dev 桌面端 | ✅ 窗口可见、可点击、本地终端(PTY pwsh)、SSH 可连、远程文件树可展开 |

自动登录：开机自动连 `root@192.168.45.200`（保存的凭据），左侧 Files 走**远程分支**（`explorerSource==="ssh"` → useRemoteFileTree + SshFileEditor）。

---

## 二、已知问题（2026-07-30 调研后状态）

### P0-1 SSH shell 终端不显示 — 🔬 根因锁定 Rust，修复验证中
- **证据链**：① 前端链路全对（Agent 逐环验证：sessionId 一致、onData→emitTerminalData fan-out、SshTerminalPane 订阅、容器尺寸正常）② Rust `ssh_connect`(mod.rs:223) 调 `open_pty`(258) 成功（无 "open pty failed" error）③ **reader task 启动后立即结束**：日志 `reader task started` 紧接 `reader task done, exit_code=-1`，**无 `reader first data`** → `channel_read.wait()` 首次调用即返回 None/Close，收不到任何 Data。
- **已排除**：`channel.split(self)`（russh 0.61 源码确认只是解构 read_half/write_half，非根因）；前端（全对）。
- **已做**：session.rs 加诊断日志（reader started/first data/Eof/Close/other/None 全提 info 级）；控制变量（request_pty/request_shell want_reply 回 false，terminal_modes 保留非空 `&[(Pty::TTY_OP_END,0)]`）。
- **⏳ 下一步（关键）**：等 tauri 重编译，看新日志 reader done **前**收到什么——
  - 若 `channel.wait() returned None (channel gone)` → channel 的 sender 端提前 drop（Handle 消息循环未路由到该 channel / channel 被提前关）；
  - 若 `other channel msg: Failure/Success` → PTY/shell 请求被服务器拒绝或需处理 reply；
  - 若 `channel closed by peer` → 服务器主动关。
- **参考**：SFTP（工作）走 `open_sftp_channel`（另开 channel + `request_subsystem(want_reply=true)` + `into_stream()`），同一 Handle 工作正常 → Handle 消息循环 OK，差异在 PTY channel 处理方式。可考虑把 PTY 也改成 `into_stream()` + `tokio::io::split`（但会丢 `window_change` resize，需权衡）。

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

## 三、本轮（2026-07-30 功能修复）改动的文件

- `src/app/App.tsx` — SSH 侧栏布局：FileExplorer 包 `min-h-0 flex-1` 容器 + SshFileEditor `min-h-0 flex-1`（修 P1-3/4 编辑器 1px）。
- `src-tauri/src/modules/ssh/session.rs` — PTY 诊断：reader 日志提 info + `first_data` 首包日志；terminal_modes 改非空 `&[(Pty::TTY_OP_END,0)]`；want_reply 控制变量（当前 false）。**尚未定论，可能继续改**。
- 未提交（等 SSH 修好 + 实测 B/C 后一起 commit）。

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

1. **SSH shell**（P0-1）：看重编译后 reader 日志定论断裂点 → 若 channel None/关闭，改用 SFTP 同款 `into_stream()`+`tokio::io::split`（评估 resize 取舍）或排查 Handle→channel 路由。
2. **实测 B/C**（P1-3/4）：tauri:dev 点远程文件验证编辑器可见可编辑保存。
3. **卡顿优化**（P0-2）：sftpEntryToDirEntry 按目录缓存（可选）。
4. **sidecar**（P2-5）：手动跑看 traceback + restart 加退避。
5. 每修一项：五绿 + tauri:dev 实测 + commit。
