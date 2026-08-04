# TDSF Terminal Agent — 项目交接文档

> **位置**：`docs/HANDOVER.md`
> **作用**：面向新接手 AI / 开发者的全面交接文档，与 `KNOWLEDGE-INDEX.md` 共同构成知识沉淀 L3 层
> **版本**：v1.3（2026-08-04 · 同步 §37.14-37.24：P0-P4 全量工程 + sidecar 打包 + 交互重构 + 黑屏根因修复）
> **接手顺序**：`AGENTS.md` → `CLAUDE.md` → `docs/MULTI-AGENT-WORKFLOW.md` → `docs/dev-state.md` 末尾交接章 → `docs/KNOWLEDGE-INDEX.md` → 本文件
> **上游参考**：https://github.com/crynta/terax-ai

---

## 0. 一句话项目身份

**本项目 = `crynta/terax-ai` v0.8.6 的魔改版**（"站在巨人肩膀上魔改"）。自研的 "tdsf-terminal-agent v4.0.0" 已废弃删除，**严禁**再引入其代码/配置/文档（见 CLAUDE.md §0 铁律 2）。

技术栈：**Tauri 2（Rust 壳）+ React 19 前端 + Python sidecar（AI 引擎）** 的桌面终端 IDE：终端优先、面向 Linux 运维教学，内置 SSH、远程文件资源管理器、代码编辑器、离线选词翻译、AI Agent 面板。

---

## 1. 开发环境配置

### 1.1 必装工具链

| 工具 | 版本 | 用途 | 验证命令 |
|------|------|------|----------|
| Node.js | ≥ 20 LTS | 前端构建 | `node -v` |
| pnpm | ≥ 9 | 包管理（**唯一允许**，禁用 npm/yarn） | `pnpm -v` |
| Rust | stable（含 cargo） | Tauri 壳编译 | `rustc --version` |
| Python | ≥ 3.13 | sidecar AI 引擎 | `python --version` |
| Git | ≥ 2.40 | 版本控制 | `git --version` |

### 1.2 镜像配置（国内网络）

```bash
# npm 镜像
npm config set registry https://registry.npmmirror.com

# pip 清华镜像
pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple

# cargo 镜像（可选，~/.cargo/config.toml）
[source.crates-io]
replace-with = "tuna"
[source.tuna]
registry = "sparse+https://mirrors.tuna.tsinghua.edu.cn/crates.io-index/"
```

### 1.3 首次启动流程

```bash
# 1. 安装前端依赖
pnpm install

# 2. 安装 Python sidecar 依赖（src-tauri/sidecar/requirements.txt）
cd src-tauri/sidecar
pip install -r requirements.txt
cd ../..

# 3. 桌面端开发模式（必须用 tauri:dev，浏览器 dev 无 IPC/PTY/SSH）
pnpm tauri:dev
```

### 1.4 端口约定

| 端口 | 用途 | 配置位置 |
|------|------|----------|
| **9300** | Vite dev server（strictPort） | `vite.config.ts` + `tauri.conf.json` devUrl |
| **9222** | WebView2 CDP 远程调试（排障用） | `tauri.conf.json` additionalBrowserArgs |

### 1.5 必装 VS Code 扩展（推荐）

- `rust-lang.rust-analyzer` — Rust 开发
- `dbaeumer.vscode-eslint` — ESLint
- `esbenp.prettier-vscode` — Prettier
- `hediet.vscode-drawio` — 查看/编辑 `.drawio` 架构图

---

## 2. 代码架构说明

### 2.1 三层架构总览

```
┌──────────────────────────────────────────────────────────┐
│  前端（src/）— React 19 + TypeScript 5 + Tailwind v4     │
│  ├─ app/App.tsx (主壳 ~1600 行)                          │
│  ├─ modules/terminal/ (本地终端 xterm.js)                │
│  ├─ modules/ssh-explorer/ (SSH 终端 + 远程文件树)         │
│  ├─ modules/editor/ (Monaco 编辑器)                      │
│  ├─ modules/explorer/ (本地文件资源管理器)                │
│  ├─ modules/ai/ (AI 面板 + 工具 + agent)                 │
│  ├─ modules/translate/ (离线选词翻译)                    │
│  ├─ modules/theme/ (主题系统 + 16 内置主题)              │
│  └─ store/runtime.tsx (运行时状态)                       │
├──────────────────────────────────────────────────────────┤
│  Rust 壳（src-tauri/src/）— Tauri 2                      │
│  ├─ lib.rs (Tauri 入口 + 命令注册 + sidecar 启动)        │
│  ├─ modules/pty/ (portable-pty 伪终端)                   │
│  ├─ modules/ssh/ (russh 0.61 + sftp + 主机审批)          │
│  ├─ modules/sidecar.rs (Python sidecar 进程管理)         │
│  ├─ modules/fs/ (文件系统 tree/search/grep/watch)        │
│  └─ modules/secrets.rs (keyring 系统密钥库)              │
├──────────────────────────────────────────────────────────┤
│  Python sidecar（src-tauri/sidecar/）— AI 引擎           │
│  ├─ main.py (JSON-RPC 入口 + sidecar 生命周期)           │
│  ├─ agents/ (9 Agent + PAOR 监督循环 + Strands 适配层)   │
│  ├─ strands_backend/ (Strands 1.50.2 适配)               │
│  ├─ core/ (LLM 配置 + 知识库 + 工具注册)                 │
│  └─ event_bus.py (事件总线 + 流式推送)                   │
└──────────────────────────────────────────────────────────┘

通信链路：
  前端 ←→ Rust：Tauri IPC（invoke/listen，105+ 命令）
  Rust ←→ Python：JSON-RPC 2.0 over stdio（stdin/stdout）
  Python → 前端：Tauri emit（sidecar:* 事件前缀）
```

### 2.2 启动链（关键！踩坑最深）

```
src/main.tsx  ← 入口
   ├─ import App from "./app/App"   ← 挂 terax 壳（NOT 旧的 src/App.tsx!）
   ├─ invoke("pty_close_all")       ← 清理孤儿 PTY
   ├─ initLaunchDir()
   ├─ ReactDOM.createRoot(...).render(<App/>)
   └─ setTimeout(getCurrentWindow().show, 50/500)  ← 窗口 visible:false 创建, 首帧后 show()
```

**关键约束**：
- 窗口配置：`tauri.conf.json`（`visible:false`）+ `tauri.windows.conf.json`（`decorations:false` `transparent:true` 无边框透明）
- 权限：`src-tauri/capabilities/default.json` **必须**含 `core:window:allow-show`/`allow-set-focus`/`allow-center`，否则 `show()` 被权限系统拦截、窗口永不可见

### 2.3 关键文件定位

| 模块 | 前端 | Rust | Python |
|------|------|------|--------|
| 终端 | `src/modules/terminal/lib/rendererPool.ts` | `src-tauri/src/modules/pty/` | — |
| SSH | `src/modules/ssh-explorer/`（sshStore.ts / SshTerminalPane.tsx / SshExplorer.tsx / SshConnectDialog.tsx） | `src-tauri/src/modules/ssh/`（client.rs russh / credentials.rs keyring / handler.rs 主机审批） | — |
| 编辑器 | `src/modules/editor/`（Monaco + CodeMirror 远程分支） | `src-tauri/src/modules/fs/` | — |
| AI Agent | `src/modules/ai/`（components/TdsfAgentPanel.tsx / tools/ / agents/registry.ts / lib/composer.tsx） | `src-tauri/src/modules/sidecar.rs` | `src-tauri/sidecar/`（main.py / agents/ / strands_backend/） |
| 翻译 | `src/modules/translate/`（linuxDictionary.ts / programmingDictionary.ts / TranslateTooltip.tsx） | — | — |
| 主题 | `src/modules/theme/`（ThemeProvider.tsx / themes/index.ts 16 主题 / useThemeFileEditing.ts） | — | — |
| 快捷键 | `src/modules/shortcuts/shortcuts.ts`（SHORTCUTS 单一真源） | — | — |

### 2.4 SSH 桥接（前后端契约）

| 桥 | 文件 | 用途 |
|----|------|------|
| SSH invoke | `src/lib/ssh-bridge.ts` | sshConnect / 凭据 / 主机验证事件 |
| SFTP invoke | `src/lib/sftp-bridge.ts` | sftpList / Read / Write / joinRemotePath |
| Sidecar RPC | `src/lib/sidecar-bridge.ts` | invokeRpc / notify / subscribe（封装 JSON-RPC） |

---

## 3. 关键功能实现原理

### 3.1 终端渲染池（rendererPool.ts）

**问题**：xterm.js 实例创建昂贵，频繁切换 tab 会闪烁
**方案**：5 槽位 LRU 池，复用 xterm 实例 + DR（device renderer）复用
**关键点**：
- ResizeObserver 防抖 fit（避免 resize 风暴）
- 主题/字体 hot-reload 不重建实例
- 槽位满时 LRU 淘汰最久未用

### 3.2 SSH 终端集成（SshTerminalPane.tsx + sshStore.ts）

**架构**：
```
Rust russh channel
   ↓ Tauri emit("ssh:data", {sessionId, data})
sshStore.ts (zustand)
   ↓ fan-out: 每个 SshTerminalPane 订阅自己的 sessionId
SshTerminalPane.tsx
   ↓ rendererPool.acquire(host+sessionId) 复用 xterm
xterm.js 渲染
```

**关键决策**：
- `rustSessionId` 实时查询而非缓存（SSH 重连后 rustSessionId 会变）
- 数据 fan-out 在 zustand store 内做，避免每个组件独立 listen
- 终端数据缓冲区溢出修复：`emitTerminalData` 中 `buf = newBuf`（P2-NEW-v3-4）

### 3.3 SSH 文件编辑器集成（EditorStack）

**关键决策（6 条）**：
1. `rustSessionId` 实时查询而非缓存（SSH 重连后变）
2. `path + sessionId` 去重 key（避免本地/远程同名文件撞车）
3. `sftpStat` 秒级 mtime * 1000 转毫秒（与 FileStat.mtime 对齐）
4. `sftpRead/sftpWrite` 不返回 mtime，需额外 `sftpStat` 补
5. 远程文件 binary 检测在前端做（NUL 字节扫描前 8KB）
6. 远程文件跳过 LSP/外部 formatter/`convertFileSrc` 媒体预览

**改动文件**：
- `EditorTab.remote` 字段（types.ts）
- `useDocument` 3 处 fs 调用分流 sftp（readFile/writeFile/statFile）
- `useEditorFileSync` 跳过本地 watch
- `EditorPane` 跳过 LSP/formatter/媒体预览（用 CodeMirror 替代 Monaco）

### 3.4 Strands 后端适配层（strands_backend/）

**架构**：
```
agents/__init__.py invoke_agent()
   ↓ 检测 _global_backend_override
   ├─ 未注入：走 BaseAgent.invoke（LangGraph PAOR 路径）
   └─ 已注入：走 _global_backend_override.invoke（Strands 路径）
strands_backend/adapter.py StrandsAgentAdapter
   ↓ (agent_id, session_id) 缓存 key（P1-NEW-v2-2 修复）
   ↓ update_model + clear_cache（P1-NEW-v3-1 热更新修复）
Strands Agent (strands-agents 1.50.2)
   ↓ callback_handler 转发事件到 event_bus
event_bus.py emit_tool_call / emit_agent_message
   ↓ Tauri emit("sidecar:agent_message")
前端 sidecar-adapter.ts 流式渲染
```

**关键修复历史**：
- `invoke_agent` override 路径：原版直接调 BaseAgent.invoke 忽略 override → 6bc17b7 修复
- 缓存 key：原 `agent_id` → 改 `(agent_id, session_id)`（P1-NEW-v2-2）
- 配置热更新：加 `update_model` + `clear_cache`（P1-NEW-v3-1）
- 线程池退出：`shutdown(wait=False)` + `os._exit(0)`（P1-NEW-v2-6 + P1-NEW-v3-4）

### 3.5 后端可观测性（sidecar.health + BackendPill）

**契约**：`_backend_status` 7 字段
| 字段 | 含义 |
|------|------|
| `backend_type` | "strands" / "langgraph" |
| `backend_activated` | Strands override 是否已注入 |
| `strands_available` | strands-agents 包是否可 import |
| `rust_bridge_active` | Rust SSH 桥是否注入 |
| `llm_configured` | LLM 配置是否就绪 |
| `fallback_reason` | 回退原因（失败时） |
| `activate_time` | 激活时间戳 |

**事件**：`sidecar:backend_status` 三路径推送（成功/失败/langgraph 回退）
**前端**：`BackendPill.tsx` 订阅 + `subscribe then` 检查 cancelled（P1-NEW-v2-4 修复泄漏）

### 3.6 CDP 9222 调试（关键突破）

**正确调用方式**：
```javascript
// CDP Runtime.evaluate 中
const r = await window.__TAURI_INTERNALS__.invoke('ipc_invoke', {
    method: 'sidecar.health',  // JSON-RPC method
    params: {}
});
```

**注意**：
- Tauri 2 注入的是 `window.__TAURI_INTERNALS__.invoke`（非 `__TAURI__.core.invoke`）
- 命令名是 `ipc_invoke`（非 `sidecar_invoke`）
- CDP `Runtime.evaluate` 在浏览器原生 ESM context 中无法 `import` Tauri 模块
- `Input.dispatchMouseEvent` 在 Tauri WebView2 里不等同真实鼠标，用 `el.click()` 才能真触发 React onClick

### 3.7 终端 / Space 架构重构（2026-07-31，阶段 0-5 全部落地）

**背景**：用户反馈 8 项终端/UI 问题（新建 terminal 默认本地 Windows 终端、资源管理器不随 `cd` 刷新、SSH 后终端不显示 hostname、SSH 浮动卡片等）。主规划文档 `docs/reports/terminal-space-refactor-plan.md`，按阶段 0-5 实施。

**阶段划分**：

| 阶段 | 内容 | commit |
|------|------|--------|
| 0 | UI 占位清理：移除 StatusBar SSH 浮动卡片、Header 地址栏 + "Main" 品牌区、AgentStatusPill 占位文字 | 6a89ddc（并入） |
| 1 | Space/SSH 集成：`WorkspaceEnv` 新增 `ssh` 变体；`SpaceCreateDialog` 支持本地/SSH 选择；SSH 连接后当前 Space 升级为 SSH Space；`FileExplorer` 按 Space 传 `sshSession` | 6a89ddc |
| 2 | SSH OSC 7 cwd 同步：`sshStore.setCurrentPath(sessionId, path)` + `handleTerminalCwd` 按 tab 绑定隔离同步远程 cwd → 左侧远程资源管理器自动刷新 | 9ec558e |
| 3 | 本地 OSC 7 cwd 同步：根因 = xterm `OscParser.end()` 短路语义（后注册 handler 返回 `true` 会 break 掉先注册的 handler）+ `registerOsc7TeachTrigger` 永远返回 `true` → 改返回 `false` | ccb1af4 |
| 4 | 容错收尾：`parseOsc7` Windows 盘符大小写归一化（`c:` → `C:`）；FileExplorer root 读取失败静默化（红 → 中性灰） | 14de3c5 |
| 5 | 完整验收回归：本地 + SSH 双链路 CDP 实测 + 五绿门禁 852/852 | 14de3c5 |

**核心架构变更**：

```typescript
// WorkspaceEnv 新增 ssh 变体（src/modules/workspace/env.ts）
type WorkspaceEnv =
  | { kind: "local" }
  | { kind: "wsl"; distro: string }
  | { kind: "ssh"; host: string; user: string; port: number; sessionId: string; label: string };
```

**关键数据流（终端 cd → 资源管理器刷新）**：

```
终端执行 cd /tmp
  → shell 集成脚本发 OSC 7（ESC]7;file://host/path）
  → registerCwdHandler 解析 cwd
  → useTerminalSession 回调 onCwd(leafId, "/tmp")
  → App.handleTerminalCwd
      ├─ setLeafCwd(leafId, "/tmp")                     // 更新 tab.cwd
      └─ (SSH Space) sshStore.setCurrentPath(sessionId, "/tmp")
  → effectiveExplorerRoot 变化
  → FileExplorer rootPath 变化
  → useRemoteFileTree/useFileTree 刷新左侧文件树
```

**阶段 3 根因（重点教训）**：xterm `OscParser` 对同一 OSC ident 支持多 handler，`start()/put()` 全执行，但 `end()` **从后往前遍历、遇第一个返回 `true` 的 handler 即 break**。本地分支注册顺序 cwd handler（先）→ teach trigger（后），teach trigger 永远返回 `true` → cwd handler 的 `end()` 被吞。修复：`registerOsc7TeachTrigger` 改返回 `false`（观察者语义）。

**关键文件**：
- `src/modules/workspace/env.ts`（WorkspaceEnv ssh 变体）
- `src/modules/spaces/components/SpaceCreateDialog.tsx`（本地/SSH Space 创建）
- `src/modules/terminal/lib/osc-handlers.ts`（OSC 7 解析 + 盘符归一化 + teach trigger 短路修复）
- `src/modules/explorer/FileExplorer.tsx`（`sshSession` prop + root 失败静默化）
- `src/modules/tabs/lib/useWorkspaceCwd.ts`（`spaceRoot` 回退）
- `src/app/App.tsx`（Space 切换同步 SSH 会话 + handleTerminalCwd 分流）

**经验沉淀**：
1. **PowerShell cd 失败天然保持 cwd**：`Set-Location` 到不存在路径报错且 `$PWD` 不变——"cd 到不存在目录"不会产生非法 explorerRoot，错误静默化只是防御性兜底
2. **SSH 自动连接只在启动时触发一次**（App 顶层 effect）：断开后需重启 tauri:dev 才能恢复 SSH 场景
3. **Windows 路径大小写归一化只需盘符**：完整路径大小写不能乱改（文件系统真实大小写），盘符是唯一确定大小写不敏感的部分
4. **模块级状态改源码后必须重启 tauri:dev**：vite HMR 会分裂模块实例（`sessions` Map 分叉导致 `writeToSession` 返回 false 的迷惑现象）

### 3.8 跨语言 stdio 编码契约（sidecar 线协议，2026-07-31 重大教训）

**症状**：sidecar 每次启动都在注册早期静默死亡（日志停在 `registered method: status`），AI 面板报 -32000 not_running。

**根因链（三层排查闭环）**：
```
Windows 中文系统 → Python sys.stdout 编码 gbk
  → write_message(ensure_ascii=False) 把含中文路径的日志写 gbk 字节
  → Rust BufReader::lines() 按 UTF-8 严格解析 → InvalidData
  → reader 静默退出（while let Ok(Some(line)) 吞 Err）
  → 误判 EOF → state=Crashed → wait_for_ready 提前返回 Err
  → start() 杀子进程（TerminateProcess，死亡点随机）
  → 子进程死后写 stdout 得 EINVAL（OSError 22 是滞后现象，曾误导为管道问题）
```

**契约（必须遵守）**：
1. **Python sidecar 启动第一件事**：`sys.stdin/stdout/stderr.reconfigure(encoding="utf-8")`（**三通道缺一不可**——stdin 漏配时 Rust 写 UTF-8 请求行、Python 按 gbk 解码，中文 input 被破坏成孤立 surrogate，Strands 请求序列化抛 UnicodeEncodeError，AI 对话间歇性 30s 超时，症状伪装成"LLM 未配置"）
2. **Rust 读子进程输出**：用 `read_until(b'\n')` + `from_utf8_lossy`，**禁用 `BufReader::lines()`**（严格 UTF-8，一行坏编码杀整个 reader）
3. **write_message 容错**：stdout 写失败（OSError/ValueError）不冒泡，去重记录 stderr 一次
4. **Rust start() 并发守卫**：`Starting` 状态跳过并发 start（防双 spawn 句柄错配）；spawn 失败复位 Crashed（防 wedge）

**排查方法论**（区分 kill vs crash）：
- 无 faulthandler dump + 无 Windows WER 事件 + 死亡点随机 = **TerminateProcess（外部杀）**；有 dump = native crash
- **文件探针**（不经管道）是绕开"管道疑云"的关键手段：`sidecar_probe2.log` 逐行标记
- **独立 tokio 小程序复现**（`/tmp/tokio_pipe_test` 同款 spawn 配置）可区分"tokio 通用问题" vs "Tauri 环境特有"

---

## 4. 已知问题及解决方案

### 4.1 已修复的关键 Bug（按严重度）

| Bug ID | 严重度 | 现象 | 根因 | 修复 commit |
|--------|--------|------|------|--------------|
| — | P0 | SSH shell + 远程文件树都不出来 | `request_pty` 的 `terminal_modes` 畸形（TTY_OP_END 带 4 字节值）→ OpenSSH 硬关 TCP | — |
| — | P0 | 窗口不可见 | `capabilities/default.json` 缺 `core:window:allow-show` | — |
| — | P0 | 应用卡死 50 万次/秒 | `useThemeFileEditing` effect 依赖 `availableImages` 自反循环 | — |
| P1-NEW-v2-2 | P1 | Strands 缓存 session 串台 | 缓存 key 仅 agent_id | 642a4d0 |
| P1-NEW-v2-3 | P1 | Strands 工具无 fix-loop 保护 | override 路径绕过 BaseAgent._check_fix_loop | **未修**（backlog P1） |
| P1-NEW-v2-4 | P1 | BackendPill subscribe 泄漏 | then 回调未检查 cancelled | 642a4d0 |
| P1-NEW-v2-5 | P1 | backend_type 未重置 | except 分支漏重置 | 642a4d0 |
| P1-NEW-v2-6 | P1 | 线程池退出卡死 | `shutdown(wait=True)` 无超时 | 642a4d0 |
| P1-NEW-v3-1 | P1 | agent.configure Strands 静默失效 | override 路径未调 update_model | 642a4d0 |
| P1-NEW-v3-2 | P1 | toolCallId 配对错乱 | 按 tool_name 配对，同名工具覆盖 | **未修**（backlog P1） |
| P1-NEW-v3-3 | P1 | SSH 主机审批无超时 | `rx.await` 永久挂起 | 642a4d0 |
| P1-NEW-v3-4 | P1 | 线程池退出仍卡死 | 非 daemon 线程 atexit join | 642a4d0 |
| — | P0 | sidecar 启动即崩（AI 报 not_running） | **gbk 写 stdout → Rust lines() UTF-8 InvalidData → reader 退出 → 误判 EOF → kill 子进程** | 已修（§3.8 契约，后续 commit 含入） |
| — | P1 | SSH 终端划词翻译不显示 | `SshTerminalHost` 未给 TerminalPane 传 ref，getSelection 未注册进 terminalRefs | 已修（§37.20 翻译重构 a2aa150 含入） |
| — | P2 | 翻译开关不持久化 | enabled 默认 false 且无 persist | 已修（§37.20 翻译重构 a2aa150 含入） |

### 4.2 当前 backlog（按优先级，详见 dev-state.md §37.24）

#### P1（影响核心功能，建议优先修复）

1. **P1-NEW-v2-3**：Strands 工具调用无 fix-loop 保护 → 加 `LimitToolCounts` Hook
2. **P1-NEW-v2-4**：Strands 模式下 main_agent PAOR 路由失效 → adapter.invoke 内检测 agent_id=="main"
3. **P1-NEW-v2-7**：exec_command Failure 后浪费 30s 超时 → ChannelMsg::Failure 时 break
4. **P1-NEW-v3-2**：sidecar 流协议 toolCallId 错乱 → 改 FIFO 队列或 Python 端发 tool_call_id
5. **P1-v5-1**：Headroom MCP Server 接入（60-95% token 节省）
6. **P1-v5-2**：OPENDEV schema-level safety
7. **P1-v5-3**：5 级 context compaction
8. **P1-v5-4**：4 级权限 + execpolicy
9. **P1-v5-5**：ssh_command explain+side_effect+脱敏
10. **P1-v5-6**：asciicast v2 会话录制

#### P2（改进建议）

11-20. 详见 dev-state.md §二十四 backlog 列表

### 4.3 常见问题排查

| 现象 | 排查方向 |
|------|----------|
| 窗口不可见 | 检查 `capabilities/default.json` 含 `allow-show`；CDP 截图确认 UI 渲染了没 |
| 应用卡死/CPU 爆高 | CDP 9222 + CPU Profiler，看是否 `flushPassiveEffects ← commitPassiveMountOnFiber` 无限循环 |
| SSH 连不上 | 检查 `terminal_modes` 是否畸形（应为空 `&[]`）；handler.rs 主机审批是否超时 |
| Sidecar 不响应 | `sidecar.health` RPC 查状态；`_backend_status` 7 字段诊断 |
| Strands 工具不执行 | 检查 `_global_backend_override` 是否注入；`invoke_agent` override 路径 |
| 0 字节源文件 | **被污染清空信号**！从 `.bak`/上游 terax/git 历史恢复，勿从零写 |

---

## 5. 开发经验沉淀

### 5.1 防污染红线（CLAUDE.md §3，8 条血泪教训）

1. **0 字节源文件 = 被污染清空的信号**。先从 `.bak`/上游/git 历史恢复，切勿当新文件从零写
2. **禁止 `git checkout/reset/restore` 已跟踪文件**——曾把 terax 的 package.json 退回自研版、丢 65 个依赖
3. **改依赖只用 `pnpm add/remove`**，改完 `pnpm install` 保持 lock 一致；绝不 `git checkout package.json`
4. **useEffect 依赖数组禁止包含"effect 自身 setState 会替换的值"**（50 万次/秒卡死根因）
5. **Context Provider 的 value 用 `useMemo`**，回调用 `useCallback`；顶层 Provider 尤其重要
6. **zustand selector 别返回新引用**（`s => s.arr.filter()` / `s => ({...})`），必要时用 `useShallow`
7. **启动/窗口/无边框/权限问题先比对上游 terax**，不自创
8. **五绿门禁全过才算完成**，且必须 `pnpm tauri:dev` 桌面端实测

### 5.2 诊断方法论（CLAUDE.md §5，卡死/无限渲染照此做）

**现象**：应用卡死、点击无响应、CPU 爆高。几乎都是 React 无限重渲染。

1. **CDP 连 9222**（`curl http://127.0.0.1:9222/json` 拿 webSocketDebuggerUrl）
2. **截图仍可用**（`Page.captureScreenshot` 走合成线程，不受主线程卡死影响）
3. **CPU Profiler**（`Profiler.start/stop`）→ 热点全是 `measure` → useEffect 无限循环
4. **`performance.measure` name 计数**（patch 统计每个组件 render 次数）
5. **无 "Maximum update depth exceeded" 报错** = setState 在 async 微任务里逃过 React 守卫 = 典型"自反依赖"循环
6. **`el.click()`（DOM 层）验证 onClick**：CDP `Input.dispatchMouseEvent` 在 Tauri WebView2 里不等同真实鼠标
7. 运行时受阻时，**派 general-purpose agent 静态通读顶层组件**

**验证修复**：patch `PerformanceObserver` 数 1 秒内 measure 次数，从 50 万降到 **0** 即为治愈

### 5.3 多 agent 协作规范（MULTI-AGENT-WORKFLOW.md 核心）

**A/B/C 三场景分层**：
- **场景 A**（主线串行）：单一 main agent，无 subagent，最简单
- **场景 B**（并行子任务）：main + N 个 subagent，文件锁矩阵隔离
- **场景 C**（主线 + 调研/审查）：main + 1-2 个调研/审查 subagent，互不干扰

**文件锁矩阵**：每个 subagent 必须声明改哪些文件，main agent 协调避免冲突

**接手声明模板**：
```
接手声明：
- 角色：main agent / subagent
- 场景：A / B / C
- 改动文件：<列出>
- 不改动文件：<列出>
- 验证：<五绿门禁 + CDP 实测>
```

### 5.4 CDP 9222 调试技巧

1. **正确调用 Tauri 命令**：`window.__TAURI_INTERNALS__.invoke('ipc_invoke', {method, params})`
2. **截图优先**：`Page.captureScreenshot` 不受主线程卡死影响
3. **DOM 层触发 React**：用 `el.click()` 而非 `Input.dispatchMouseEvent`
4. **纯 Python WebSocket 客户端**：避免依赖 Node.js（`.tdsf-data/cdp_*.py` 归档脚本）
5. **`returnByValue: true` + `awaitPromise: true`**：拿异步结果

### 5.5 Strands 适配层经验

1. **缓存 key 用 `(agent_id, session_id)`**：避免会话串台
2. **`update_model` + `clear_cache`**：配置热更新必走
3. **`invoke_agent` override 路径**：检测 `_global_backend_override` 优先走
4. **线程池 `shutdown(wait=False)` + `os._exit(0)`**：避免 atexit join 卡死
5. **`_backend_status` 7 字段契约**：三路径推送（成功/失败/langgraph）
6. **`agent.configure` 查询模式**：传 `config=null` 仅查询不重配

### 5.6 SSH 文件编辑器经验

1. **`rustSessionId` 实时查询**：SSH 重连后会变，缓存会失效
2. **`path + sessionId` 去重 key**：避免本地/远程同名文件撞车
3. **`sftpStat` mtime * 1000**：秒级转毫秒与 FileStat 对齐
4. **binary 检测在前端**：NUL 字节扫描前 8KB
5. **远程文件跳过 LSP/formatter/媒体预览**：用 CodeMirror 替代 Monaco

### 5.7 五绿门禁（CLAUDE.md §4，完成的唯一标准）

```bash
pnpm typecheck        # tsc -p tsconfig.app.json && tsc -p tsconfig.node.json，0 错误
pnpm lint             # eslint . --max-warnings 0，0 错误 0 警告
pnpm test             # vitest run，当前 832+ 全过
pnpm build:web        # tsc -p app + vite build，成功出 dist
pnpm tauri:dev        # 桌面端实测：窗口可见 + 能点击 + 目标功能真的工作
```

**豁免**只能在 `eslint.config.js` 显式配置并注明理由。禁止散落 `// @ts-ignore`、大段 `eslint-disable`。

**tsconfig 用 per-project `-p`**（incremental 非 composite）——composite 的声明可移植性检查在 pnpm 隔离布局下会误报 TS2742。

### 5.8 记忆保存机制（CLAUDE.md §6）

**4 层知识沉淀体系**（2026-07-30 建立）：

| 层 | 载体 | 作用 | 维护频率 |
|----|------|------|----------|
| **L1 规范层** | AGENTS.md / CLAUDE.md / MULTI-AGENT-WORKFLOW.md | 开发规范 + 防污染红线 + 协作规则 | 重大变更才改 |
| **L2 进度层** | dev-state.md（§<N> 交接章） | 唯一进度记忆源，每次 session 追加 | 每次 session |
| **L3 知识层** | KNOWLEDGE-INDEX.md + HANDOVER.md（本文件） | 文档导航 + 交接文档 + 经验沉淀 | 里程碑更新 |
| **L4 归档层** | docs/reports/ + docs/reports/legacy/ | 审查报告 + 调研报告 + 历史归档 | 产出即归档 |

**强制保存时机**：用户说"保存记忆/接手/今天到此"、完成可运行里程碑、遇到无法自解的阻塞、发现新污染/踩坑

**全绿且可运行的里程碑要立即 git commit 固化**（安全回滚点）

### 5.9 commit 规范

- `fix(<scope>):` 修复 bug
- `feat(<scope>):` 新功能
- `refactor(<scope>):` 重构
- `docs(<scope>):` 文档变更（含 dev-state.md 交接章）
- `docs(reports):` 调研/审查报告

### 5.10 关键 commit 节点（2026-07-30 ~ 2026-07-31）

| commit | 内容 |
|--------|------|
| `14de3c5` | 终端/Space 重构 Phase 4+5（cwd 容错 + 完整验收回归） |
| `ccb1af4` | 终端/Space 重构 Phase 3（本地 OSC 7 cwd 同步，短路根因修复） |
| `9ec558e` | 终端/Space 重构 Phase 2（SSH OSC 7 cwd 同步） |
| `6a89ddc` | 终端/Space 重构 Stage 1（Space 支持 SSH + UI 占位清理） |
| `9ede372` | P1-P4 全面修复（AI 流式 + 深度思考 + Skill 调用 + 主题浅色 + 翻译深浅色） |
| `f65150c` | 产品落地页 |
| `dac90d2` | 删除 TDSFPanelSection 死代码 |
| `64e9694` | 知识沉淀体系 L3 层建立（KNOWLEDGE-INDEX + HANDOVER） |
| `ac8ec99` | dev-state §二十四交接章（v3 修复固化 + CDP 突破） |
| `642a4d0` | v3 修复批次（9 项 P1/P2）+ v2/v3 审查报告 + v5 运维 agent 调研 |
| `d72e1ad` | sidecar 流协议发 reasoning/工具行 part（前端隔离） |
| `bf7e68c` | 恢复上游 AiMiniWindow 替代自研 TdsfAgentPanel |
| `2084bfd` | P1-NEW-1/2/4 修复 + sidecar.rs TDSF_AGENT_BACKEND 默认注入 Strands |
| `229c1cd` | BackendPill 卡 loading 修复 + Critical-2/3 收尾 |
| `8dbed20` | dev-state §十九交接章（P0-E Strands override 修复） |
| `4c5640f` | sidecar.health RPC + backend_status 事件 |
| `6bc17b7` | invoke_agent 优先走 _global_backend_override 路径 |
| **已含入后续 commit** | sidecar GBK/UTF-8 根因修复（§3.8）+ SSH 翻译 handle 注册 + 翻译开关持久化（§36） |
| **已含入后续 commit** | better-harness：CI 脚本修复（check-types→typecheck）/ .gitignore 路径 / 协作契约归档 / Python CI 评估报告（§36.3） |

**2026-08-01 ~ 2026-08-04 关键 commit 节点（§37.14-37.24）**：

| commit | 内容 |
|--------|------|
| `5450309` | dev-state §37.24 交接基线（dev 启动黑屏排查教训） |
| `910285c` | dev-state §37.23 + 打包发布闭环与黑屏根因复盘 |
| `7cb230d` | **sidecar onedir 打包发布闭环 + 黑屏根因修复**（NSIS 402MB + transparent 平台配置清理） |
| `e4952e7` | dev-state §37.22 全量工程推进记录 |
| `69ec9c0` | **P4 单框架收敛**：删除 LangGraph 遗产（graph/ 2184 行 + langgraph/langchain 5 依赖） |
| `b22051b` | **P2-4 决策库**：AI 排障成功自动沉淀案例（md5 去重） |
| `f7bdb02` | T4 稳定化：修复严格类型检查暴露的 8+ 真实错误 |
| `5a78456` | **T3 词库增强**：ECDICT 8.1 万条 + lemma 词形还原 + 模糊兜底 |
| `b59b3a8` | **T2 透明窗口系统性修复**：渲染前即不透明 + 首帧后 show |
| `c76be91` | **T1 简洁终端图标**：修复纯蓝紫单色占位 |
| `a2aa150` | **P2 翻译模块重构**：统一选中浮层（翻译 + Ask TDSF）|
| `f35659f` | **P1-3 hash 审计链**：sha256 前后链 JSONL 落盘 + verify 篡改检测 |
| `4cc840e` | **P1-2 会话证据链**：EvidenceTracker 会话级证据 + 前端折叠区 |
| `139fc21` | **P1-1 HITL 真实审批闭环**：threading.Event 等待-唤醒 + 工具决策分支 |
| `31fa409` | **交互重构**：删除左侧 SSH 面板 + Space 全删 + 欢迎界面内嵌 |

---

## 6. 决策边界

### 6.1 可自行决定

- 代码实现细节、命名、注释、性能优化、bug 修复方式

### 6.2 必须先问用户（AskUserQuestion）

- 删文件/删 git 历史等不可逆操作
- 更换框架/新增重依赖
- 改动功能范围
- UI 设计方向
- "删还是保留"存量代码

---

## 7. 接手 checklist

接手本项目时，按以下顺序操作：

- [ ] 1. 读 `AGENTS.md`（一句话指路）
- [ ] 2. 读 `CLAUDE.md`（规范总纲 + 防污染红线 + 五绿门禁 + 诊断方法论）
- [ ] 3. 读 `docs/MULTI-AGENT-WORKFLOW.md`（多 agent 协作规范）
- [ ] 4. 读 `docs/dev-state.md` 末尾「§<N> 交接指南」（当前是 §37.24）
- [ ] 5. 读 `docs/KNOWLEDGE-INDEX.md`（文档全貌导航）
- [ ] 6. 读本文件（HANDOVER.md）
- [ ] 7. `git status` + `git log --oneline -10` 确认当前代码状态
- [ ] 8. `pnpm install` 安装依赖
- [ ] 9. `pip install -r src-tauri/sidecar/requirements.txt` 安装 Python 依赖
- [ ] 10. `pnpm typecheck && pnpm lint && pnpm test && pnpm build:web` 前四绿验证
- [ ] 11. `pnpm tauri:dev` 桌面端实测（窗口可见 + 本地终端 + SSH 可连）
- [ ] 12. CDP 9222 实测（`curl http://127.0.0.1:9222/json`）验证 sidecar.health
- [ ] 13. 终端/Space 实测：本地终端 `cd` 后左侧资源管理器跟随刷新；SSH Space `cd /tmp` 后远程文件树刷新
- [ ] 14. 按 dev-state.md §37.24 backlog 选任务推进

---

## 8. 运行时状态快照（2026-08-04）

| 项目 | 状态 |
|------|------|
| typecheck / lint / test(**946**) / build:web | ✅ 全绿 |
| pytest（**1281**） | ✅ 全过 |
| cargo check / build | ✅ 通过 |
| sidecar | ✅ **running**（strands 激活 + llm_configured=true + 5 agents + 7 运维工具） |
| AI 对话 | ✅ 已恢复（GBK/UTF-8 根因修复 + LangGraph 死代码删除） |
| 终端/Space 重构 | ✅ 阶段 0-5 全部落地（§3.7） |
| 方案书 P0-P4 | ✅ **全部完成**（P0 多 agent 真集成 / P1 HITL 审批+证据链+审计链 / P2 翻译重构+知识库+决策库 / P4 单框架收敛） |
| sidecar 打包 | ✅ onedir PyInstaller + NSIS 安装包（402MB, v0.1.0），安装冒烟全过 |
| 翻译模块 | ✅ ECDICT 81557 词 + lemma 词形还原 + 统一浮层（翻译 + Ask TDSF） |
| 黑屏根因 | ✅ transparent 平台配置残留已修（§37.23）；dev 启动黑屏根因已修（§37.24） |
| SSH 划词翻译 | ⏳ 代码完成，待 SSH 实测 |
| 最新 commit | `5450309`（docs: dev-state §37.24 交接基线） |
| 交接章 | dev-state §37.24（2026-08-04） |

---

> **最后更新**：2026-08-04 · v1.3 · 同步 §37.14-37.24 全量工程（P0-P4 + sidecar 打包 + 交互重构 + 黑屏修复）。上游参考：https://github.com/crynta/terax-ai
