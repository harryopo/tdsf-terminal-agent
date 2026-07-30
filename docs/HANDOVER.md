# TDSF Terminal Agent — 项目交接文档

> **位置**：`docs/HANDOVER.md`
> **作用**：面向新接手 AI / 开发者的全面交接文档，与 `KNOWLEDGE-INDEX.md` 共同构成知识沉淀 L3 层
> **版本**：v1.0（2026-07-30 · 知识沉淀体系建立）
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

### 4.2 当前 backlog（按优先级，详见 dev-state.md §二十四）

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

### 5.10 关键 commit 节点（2026-07-30）

| commit | 内容 |
|--------|------|
| `ac8ec99` | dev-state §二十四交接章（v3 修复固化 + CDP 突破） |
| `642a4d0` | v3 修复批次（9 项 P1/P2）+ v2/v3 审查报告 + v5 运维 agent 调研 |
| `d72e1ad` | sidecar 流协议发 reasoning/工具行 part（前端隔离） |
| `bf7e68c` | 恢复上游 AiMiniWindow 替代自研 TdsfAgentPanel |
| `2084bfd` | P1-NEW-1/2/4 修复 + sidecar.rs TDSF_AGENT_BACKEND 默认注入 Strands |
| `229c1cd` | BackendPill 卡 loading 修复 + Critical-2/3 收尾 |
| `8dbed20` | dev-state §十九交接章（P0-E Strands override 修复） |
| `4c5640f` | sidecar.health RPC + backend_status 事件 |
| `6bc17b7` | invoke_agent 优先走 _global_backend_override 路径 |

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
- [ ] 4. 读 `docs/dev-state.md` 末尾「§<N> 交接指南」（当前是 §二十四）
- [ ] 5. 读 `docs/KNOWLEDGE-INDEX.md`（文档全貌导航）
- [ ] 6. 读本文件（HANDOVER.md）
- [ ] 7. `git status` + `git log --oneline -10` 确认当前代码状态
- [ ] 8. `pnpm install` 安装依赖
- [ ] 9. `pip install -r src-tauri/sidecar/requirements.txt` 安装 Python 依赖
- [ ] 10. `pnpm typecheck && pnpm lint && pnpm test && pnpm build:web` 前四绿验证
- [ ] 11. `pnpm tauri:dev` 桌面端实测（窗口可见 + 本地终端 + SSH 可连）
- [ ] 12. CDP 9222 实测（`curl http://127.0.0.1:9222/json`）验证 sidecar.health
- [ ] 13. 按 dev-state.md §二十四 backlog 选任务推进

---

## 8. 运行时状态快照（2026-07-30）

| 项目 | 状态 |
|------|------|
| typecheck / lint / test(832+) / build:web | ✅ 全绿 |
| pytest（176+） | ✅ 全过 |
| tauri:dev 桌面端 | ✅ 窗口可见 + 本地终端 + SSH 可连 + 远程文件树 |
| CDP 9222 实测 | ✅ sidecar.health 返回 backend_activated=true + strands_available=true + agents_count=9 |
| Strands 后端 | ✅ TDSF_AGENT_BACKEND=strands 已激活 |
| 最新 commit | `ac8ec99`（dev-state §二十四） |
| v3 修复 commit | `642a4d0`（9 项 P1/P2，16 文件 / 4459 insertions） |

---

> **最后更新**：2026-07-30 · v1.0 · 知识沉淀体系建立。上游参考：https://github.com/crynta/terax-ai
