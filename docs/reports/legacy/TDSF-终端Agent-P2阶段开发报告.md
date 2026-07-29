# TDSF 终端 Agent v4.0 — P2 阶段开发报告

> 阶段: **P2 集成层（前端 AgentPanel 集成 + SSH + side-git + Docker 沙箱 + 资源管理器 + 终端能力强化）**
> 日期: 2026-07-26
> 状态: **6 绿门禁全过 + cargo test 179/179 + E2E 9/9，P2 集成层验收通过**（13/13 task 完成）
> 测试: **919 测试全部通过**（前端 Vitest 120 + Python Pytest 611 + Rust cargo 179 + E2E Playwright 9）
> 对齐度: 36.14% → **51.81%**（+15.67%，P2 13/13 完成）
> 下一步: P3 知识库 + Skills 系统（10 项 task，SQLite FTS5 + ChromaDB + 18 领域 Skills）

---

## 1. P2 阶段目标

P0 + P1-A + P1-B 已完成终端 Agent 的基座与"AI 大脑"，P2 阶段需要把"大脑"接到"手脚"：前端打通 AgentPanel 真实事件流、SSH 远程会话、影子版本控制、Docker 沙箱隔离、资源管理器、终端能力强化（主题/补全/分屏）以及 4 接口切面文档与 Fix-loop 强制停手机制。

P2 拆分为 4 个批次：

1. **P2-A 前端集成验证 P1-B**（2 项 task）：替换 AgentPanel mock 数据为 sidecar-bridge 真实事件订阅，Playwright E2E 验证 nginx 故障排查完整链路
2. **P2-B SSH + 资源管理器**（4 项 task）：russh 0.61 集成 + TOFU + keepalive + SSH 多标签 + SFTP 文件树 + Monaco Editor 嵌入
3. **P2-C 隔离 + 版本控制 + 终端能力**（5 项 task）：side-git 影子仓库 + Docker 沙箱 + 200+ 主题 + 终端补全 + cmux-tui 分屏
4. **P2-D 验收**（2 项 task）：4 接口切面文档 + Fix-loop max_retry=3 + P2 阶段验收

---

## 2. 实施清单（13 项 task 全部完成）

### 2.1 P2-A 前端集成验证 P1-B（2 项 task）

#### T-P2-01: 前端 AgentPanel 接入 sidecar-bridge（替换 mock 数据）

- 移除 AgentPanel 中所有 mock 数据（静态 mood/tokens/messages）
- 接入 `src/lib/sidecar-bridge.ts` 的 `invoke('ipc_invoke', { method: 'agent.invoke', params: { input } })`
- 接入 4 类事件订阅：
  - `subscribe('sidecar:mood_change', cb)` 实时更新 mood 状态
  - `subscribe('sidecar:agent_message', cb)` 流式显示 Agent 输出
  - `subscribe('sidecar:tool_call', cb)` 显示工具调用卡（risk/decision/confidence 等）
  - `subscribe('sidecar:needs_you', cb)` 显示 needs-you 通知
- 扩展 `src/store/runtime.tsx`：新增 `agentMessages` / `toolCalls` / `currentSessionId` 3 域状态 + 5 个 reducer action
- 实现 AgentPanel 输入框交互：Enter 提交 / Shift+Enter 换行 / thinking 状态切换 / 错误回退
- 实现工具调用卡：折叠展开 / 时间戳 / 状态指示（running/success/error）
- 实现 needs-you 通知卡：4 类型（approval/error/question/handoff）+ 对应按钮

#### T-P2-02: E2E 测试（nginx 故障排查完整链路验证）

- 集成 Playwright + 配置 `playwright.config.ts`（baseURL=http://127.0.0.1:9000, reuseExistingServer=true）
- 编写 `e2e/nginx-failure.spec.ts`，9 个测试用例全部通过：
  - 用例 1：用户输入 "nginx 启动失败" → mood 流转 idle → thinking → working → done
  - 用例 2：L3 风险审批流程（needs-you 卡 + 批准/拒绝按钮）
  - 用例 3：Agent 错误处理（mood 切换到 error + 错误信息展示）
  - 用例 4-9：字数计数 / 清空对话 / 关闭面板 / 工具卡折叠 / needs-you 卡片等
- 添加 `pnpm test:e2e` 脚本到 package.json

### 2.2 P2-B SSH + 资源管理器（4 项 task）

#### T-P2-03: russh SSH 集成 + TOFU + keepalive

- 添加 `russh = { version = "0.61", default-features = false, features = ["ring"] }`（禁用 aws-lc-rs，使用 ring backend 解决 Windows MSVC 编译问题）
- 创建 `src-tauri/src/modules/ssh/` 模块（5 文件）：
  - `mod.rs`：模块导出 + SshState 全局会话注册表 + 6 个 Tauri 命令（connect/write/resize/disconnect/status/approve_host）
  - `client.rs`：SSH 客户端（russh 异步 + password/publickey 双认证 + RSA hash 算法协商 `best_supported_rsa_hash`）
  - `handler.rs`：russh::client::Handler 实现（check_server_key 回调 + TOFU + 主机指纹 SHA256 计算）
  - `known_hosts.rs`：已知主机管理（TOFU + 用户确认 + 文件持久化 `~/.tdsf/known_hosts` + KeyMismatch 检测）
  - `session.rs`：SSH 会话（PTY 交互 + reader task + 9 态状态机 + ChannelReadHalf/WriteHalf 拆分）
- keepalive 配置：`keepalive_interval=15s` + `keepalive_max=3` + `inactivity_timeout=30s`
- check_server_key 回调使用 oneshot channel 异步等待前端 approval
- 升级 `rust-version = "1.85"` 以支持 russh 0.61 async fn in trait
- 14 个 SSH 单元测试全部通过（known_hosts 6 + session 5 + client 3）

#### T-P2-04: SSH 多标签 + 状态点

- 创建 5 个组件：
  - `src/components/SshTabs.tsx`：多 tab 管理（新增/切换/关闭），使用 frontendKey 作为 React key
  - `src/components/SshStatusDot.tsx`：9 状态有限状态机（与 Rust SshSessionState 枚举对齐）+ 颜色编码（透明/黄/绿/红/灰 + 脉冲动画 + ? / ! 图标）+ hover 详情气泡
  - `src/components/SshTerminal.tsx`：xterm + FitAddon + WebglAddon + Unicode11Addon + WebLinksAddon + TOFU 主机指纹确认弹窗
  - `src/components/SshConnectDialog.tsx`：SSH 连接配置弹窗（host/port/user + 密码/公钥认证切换 + ESC 关闭 + 表单验证）
  - `src/lib/ssh-bridge.ts`：6 个命令封装 + 2 个事件订阅接口 + camelCase ↔ snake_case 命名转换
- **frontendKey 持久标识机制**：`ssh-${Date.now()}-${random}` 解决 Rust session_id 动态变化导致 React 组件重新挂载问题
- xterm 复用：SSH 终端切换通过 `display:none` 复用 xterm 实例（保留 scrollback + 连接状态），切换时 `fit.fit()` 重新适配尺寸
- TOFU 弹窗：订阅 `ssh:approve-host` 事件，支持首次连接 + 密钥变化警告两种场景
- 集成到 `App.tsx` + `LeftSidebar.tsx`：根据 `activeSshFrontendKey` 切换显示 local Terminal 或 SshTerminal，LeftSidebar 动态读取 `state.sshSessions` 渲染 Hosts 列表
- SSH 会话管理 5 个 reducer actions（add/update/remove/set-active/clear）

#### T-P2-05: 文件树 + SFTP

- 添加 `russh-sftp` 依赖，基于 `channel.subsystem("sftp")` 实现 SFTP 子系统
- 创建 `src-tauri/src/modules/ssh/sftp.rs`：
  - `sftp_list(path)` 列目录
  - `sftp_download(path)` 下载文件
  - `sftp_upload(path, content)` 上传文件
  - `sftp_mkdir(path)` 创建目录
  - `sftp_remove(path)` 删除文件
- 创建 `src/components/Explorer.tsx`：
  - 文件树（虚拟滚动 + 懒加载子目录）
  - 右键菜单（新建/删除/重命名/上传/下载）
  - 拖拽上传（HTML5 drag-and-drop API）
  - 中文文件名支持（UTF-8 + GBK 兜底）
- 创建 `src/lib/sftp-bridge.ts`：5 个 SFTP 命令封装
- 集成到 LeftSidebar：文件树面板与 SSH 会话面板并列

#### T-P2-06: Monaco Editor 嵌入

- 安装 `@monaco-editor/react 4.7` + `vite-plugin-monaco-editor`
- 配置 `vite.config.ts`：集成 `vite-plugin-monaco-editor`，配置 worker 路径（`asset:` 协议）解决 Vite 6 + pnpm 嵌套路径 worker 导入问题
- 创建 `src/components/MonacoEditor.tsx`：
  - Editor 封装（受控/非受控双模式）
  - 支持 200+ 语言语法高亮（自动语言检测 + 手动指定）
  - Ctrl+S 保存（触发 SFTP 上传）
  - 多 tab 文件管理（●未保存状态指示）
- 集成到 Explorer：双击文件树节点 → 打开 Monaco Editor，多文件 tab 切换

### 2.3 P2-C 隔离 + 版本控制 + 终端能力（5 项 task）

#### T-P2-07: side-git 影子仓库（DEC-V321-02）

- 添加 `git2 = "0.19"` 依赖
- 创建 `src-tauri/src/modules/side_git.rs`：
  - `SideGitManager` struct
  - `init_shadow_repo(path)` 初始化 `.tdsf-shadow/git/` bare 仓库
  - `auto_stash(path)` 自动 stash 当前工作区
  - `auto_commit(path, message)` 自动 commit 到影子仓库
  - `rollback(path)` 回滚（`git reset --hard HEAD~1`）
  - `track_change(path, action)` 追踪变更到 `.tdsf-shadow/log/`
- 集成到 Python Sidecar：Agent 调用 Edit/Write 工具前自动 stash + 工具后自动 commit + 失败时自动 rollback
- 注册 Tauri 命令：`side_git_init` / `side_git_status` / `side_git_rollback`
- 7 个单元测试全部通过

#### T-P2-08: Docker 沙箱基础（bollard）

- 添加 `bollard = "0.22"` + `bollard-stubs = "0.22"` 依赖
- 创建 `src-tauri/src/modules/sandbox/` 模块（4 文件）：
  - `mod.rs`：模块导出
  - `manager.rs`：`SandboxManager`（容器生命周期：create/start/stop/remove）
  - `config.rs`：沙箱配置（Alpine 3.20 + cap_drop ALL + read_only_rootfs + seccomp + non-root user + 512MB 内存 + 1 CPU + 256 进程）
  - `exec.rs`：容器内命令执行（`bollard::exec::create_exec` + `start_exec`）
- Docker Desktop 检测：
  - Windows：通过 Named Pipe `\\.\pipe\docker_engine` 检测
  - Linux/macOS：通过 Unix socket `/var/run/docker.sock` 检测
  - 未安装时友好提示
- 集成到 Python Sidecar：新增 `sandbox.execute` JSON-RPC 方法，Agent 在沙箱内执行 L3+ 风险命令
- 创建 `src/lib/sandbox-bridge.ts`
- 单元测试 + 集成测试（Docker Desktop 未安装时跳过集成测试，单元测试必过）

#### T-P2-09: 200+ 终端主题集成（tabby）

- 从 tabby GitHub 收集 200+ 主题 JSON 包
- 转换为 TDSF 主题格式（CSS 变量驱动），新增 `src/modules/theme/themes/` 200+ 主题文件
- 主题预览面板（在设置中）：每个主题缩略图 + 实时切换
- 主题切换实时生效（通过 ThemeProvider 注入 CSS 变量）
- 自定义主题导入：用户可导入 tabby 主题 JSON，自动转换为 TDSF 格式

#### T-P2-10: 终端补全（Trie + Frecency）

- 创建 `src/lib/completion.ts`：
  - Trie 树数据结构（命令前缀树，O(prefix) 查询）
  - Frecency 排序算法（最近 + 最常用加权，参考 zoxide）
- 集成 shell history：
  - 解析 bash/zsh/fish/powershell history 文件
  - 实时更新 Trie 树（命令执行后追加）
- 集成到 Terminal：
  - Tab 键触发补全（前缀匹配 + Frecency 排序）
  - Shift+Tab 反向补全
  - 补全弹窗 UI（最高 10 条 + 高亮匹配前缀）

#### T-P2-11: cmux-tui JSON-lines 子集（10 命令）

- 创建 `src/lib/cmux-protocol.ts`：
  - JSON-lines 协议解析（每行一个 JSON 命令）
  - 10 命令定义：`split-v` / `split-h` / `focus-next` / `focus-prev` / `close` / `rename` / `scroll-up` / `scroll-down` / `select-tab` / `new-tab`
- 创建 `src/components/MultiPlex.tsx`：
  - tmux 风格分屏（CSS Grid 布局）
  - pane 管理（新增/切换/关闭/重命名）
- 集成到 Terminal：命令行输入 `:split-v` 等触发分屏，pane 状态显示

### 2.4 P2-D 验收（2 项 task）

#### T-P2-12: 4 接口切面文档 + Fix-loop max_retry=3

- 编写 4 接口切面文档（DEC-V32-05）：
  - `docs/api/frontend-rust.md`：前端 ↔ Rust Tauri 命令（invoke + listen 双向，6 类命令清单）
  - `docs/api/rust-python.md`：Rust ↔ Python stdio JSON-RPC（请求/响应/通知三态 + 错误码）
  - `docs/api/python-mcp.md`：Python ↔ MCP tools（6 工具元数据 + invoke_tool 协议）
  - `docs/api/python-langgraph.md`：Python ↔ LangGraph（7 节点 + StateGraph + 条件路由）
- 实现 Fix-loop max_retry=3（DEC-V321-11）：
  - 在 Python Sidecar 实现 `fix_loop.py`（634 行）重试计数器
  - 同一操作 max_retry=3，超限强制停手
  - 通过 needs-you 通知用户（handoff 类型 + 错误上下文）
  - 752 行单元测试覆盖（边界 case + 重试 + 停手 + 通知）

#### T-P2-13: P2 阶段验收

- 6 绿门禁 + cargo test + E2E 全程验证（详见第 4 节）
- 更新 `docs/dev-state.md`：当前阶段切换到 P3，已完成 task 增加 P2 13 项，下一步 task 切换到 T-P3-01
- 更新 `project_memory.md`：新增"【P2 完成记录 2026-07-26】"段落
- 编写 P2 阶段报告（本文件）

---

## 3. 关键架构决策

### 3.1 russh 0.61 选型（替代 ssh2-rs）

| 维度 | russh 0.61 | ssh2-rs |
|------|-----------|---------|
| 异步模型 | 原生 tokio 异步 | 同步阻塞（需 spawn_blocking） |
| keepalive | 内置（`keepalive_interval` + `keepalive_max`） | 需手动实现 |
| 生产背书 | tabby 终端在用 | - |
| Windows 兼容 | 零配置（ring backend） | 依赖 libssh2 动态库 |
| MSVC 编译 | ring 预编译 crypto backend | aws-lc-rs 需 CMake + nasm |

**关键决策**：禁用默认 features（`default-features = false`）+ 启用 `ring` feature，绕过 aws-lc-rs 在 Windows MSVC 上的编译依赖问题。升级 `rust-version = "1.85"` 以支持 russh 0.61 的 async fn in trait。

### 3.2 资源管理器方案 D（Monaco Editor + 文件树 + SFTP）

不嵌入 code-server/Theia（重 ~200MB + 启动慢 + Electron 冲突），而是用 Monaco Editor + 文件树 + SFTP 组合实现：

| 组件 | 选型 | 理由 |
|------|------|------|
| 编辑器 | `@monaco-editor/react 4.7` | VSCode 同款 + 200+ 语言 + 体积可控（按需加载 worker） |
| 文件树 | 自研 Explorer.tsx | 虚拟滚动 + 懒加载 + 中文文件名兼容 |
| SFTP | `russh-sftp` + `channel.subsystem("sftp")` | 复用 russh 连接，无需额外 SSH 通道 |

### 3.3 bollard Docker SDK（替代 docker CLI 子进程）

| 维度 | bollard 0.22 | docker CLI 子进程 |
|------|-------------|------------------|
| Rust 原生 | ✅ 异步 tokio | ❌ 需 spawn + 解析 stdout |
| Windows 支持 | ✅ Named Pipe `\\.\pipe\docker_engine` | ✅ 但需 PATH 配置 |
| API 完整 | ✅ create/exec/inspect/stop/remove | ⚠️ 文本解析易错 |
| 错误处理 | ✅ 强类型 `bollard::errors::Error` | ❌ 退出码 + stderr 字符串 |

### 3.4 frontendKey 持久标识机制

**问题**：Rust 侧 `session_id` 在 SSH 连接建立前为空，连接成功后才生成 UUID。如果直接用 session_id 作为 React key，会导致 SshTerminal 组件在连接建立前后重新挂载，丢失 xterm scrollback 和事件订阅。

**方案**：在前端生成 `frontendKey = ssh-${Date.now()}-${random}`，作为 React key 跨 session_id 变化保持挂载稳定性。Rust 侧通过 `update_session_id(frontend_key, session_id)` 关联两者。

**收益**：xterm 实例复用 + scrollback 保留 + 事件订阅不丢失 + 状态切换平滑。

### 3.5 vite-plugin-monaco-editor（解决 Vite 6 + pnpm worker 导入问题）

**问题**：Vite 6 + pnpm 嵌套 node_modules 路径下，Monaco Editor 的 worker 文件（`editor.worker.js` / `ts.worker.js` / `json.worker.js` 等）无法通过默认 `new Worker(new URL(...))` 导入，报错 `Failed to fetch module worker`。

**方案**：使用 `vite-plugin-monaco-editor` 插件，通过 `asset:` 协议将 worker 文件作为静态资源打包，避免 Vite 的模块解析机制。

### 3.6 build.rs ComCtl32 v6 manifest 统一管理

**问题**：Windows 测试二进制运行时崩溃，报 `STATUS_ENTRYPOINT_NOT_FOUND`，根因是 tauri-build 默认只为 cdylib 添加 manifest，测试二进制（`cargo test --lib` 编译的 .exe）未启用 ComCtl32 v6，导致 Common Controls v5/v6 混用。

**方案**：创建 `build.rs`，通过 `cargo:rustc-link-arg=/MANIFESTINPUT` 为所有目标（主 bin + 测试 + cdylib）添加 manifest，同时使用 `WindowsAttributes::new_without_app_manifest()` 禁用 tauri-build 默认 manifest，避免重复。

---

## 4. 6 绿门禁验证（P2 完成后）

| # | 门禁 | 命令 | 状态 | 备注 |
|---|------|------|------|------|
| 1 | typecheck:node | `pnpm typecheck:node` | ✅ | 0 错误 |
| 2 | typecheck:web | `pnpm typecheck:web` | ✅ | 0 错误 |
| 3 | lint | `pnpm lint` | ✅ | 0 警告（含 xterm addon + theme provider 豁免） |
| 4 | test | `pnpm test` | ✅ | **120/120 通过**（Vitest，P2 新增 SSH/Explorer/Monaco/补全/cmux 等测试） |
| 5 | build:web | `pnpm build:web` | ✅ | CSS 65.90kB / JS 712.40kB |
| 6 | test:python | `pnpm test:python` | ✅ | **611/611 通过**（Pytest，含 P2 新增 fix_loop 测试 752 行） |

**额外门禁**：
- `cargo test --lib`：✅ **179/179 通过**（含 SSH 14 + side-git 7 + sandbox 等 P2 新增测试）
- `pnpm test:e2e`：✅ **9/9 通过**（Playwright，nginx 故障排查完整链路）

**测试覆盖汇总**：前端 120 + Python 611 + Rust 179 + E2E 9 = **919 测试全部通过**

---

## 5. 关键问题与修复

| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| 1 | russh 0.61 API 变更（`best_supported_rsa_hash` / `check_known_hosts_path`） | 0.50 → 0.61 重构了 keys 模块和 Handler trait | 适配新 API：使用 `russh::keys::check_known_hosts_path` + `best_supported_rsa_hash` 协商 + `async fn in trait`（需 rust 1.85+） |
| 2 | russh 0.61 aws-lc-rs Windows MSVC 编译失败 | aws-lc-rs 依赖 CMake + nasm，Windows MSVC 工具链不完整 | 禁用默认 features（`default-features = false`）+ 启用 `ring` feature（ring 提供预编译 crypto backend） |
| 3 | Windows 测试二进制 STATUS_ENTRYPOINT_NOT_FOUND 崩溃 | tauri-build 默认 manifest 只覆盖 cdylib，测试 .exe 未启用 ComCtl32 v6 | 创建 `build.rs`，通过 `cargo:rustc-link-arg=/MANIFESTINPUT` 为所有目标添加 manifest，同时 `WindowsAttributes::new_without_app_manifest()` 禁用 tauri-build 默认 manifest 避免重复 |
| 4 | Vite 6 + pnpm 嵌套路径下 Monaco worker 导入失败 | `new Worker(new URL(...))` 在 pnpm 嵌套 node_modules 路径下无法解析 | 使用 `vite-plugin-monaco-editor`，通过 `asset:` 协议将 worker 作为静态资源打包 |
| 5 | xterm 点击事件被 SshTabs 容器拦截 | SshTabs 父容器 `onClick` 冒泡捕获导致 xterm 内部点击失效 | 在 xterm 容器上 `e.stopPropagation()` + 调整 SshTabs 事件委托边界 |
| 6 | bollard 0.22 API 不兼容（`create_exec` 返回类型变更） | bollard 0.21 → 0.22 重构了 exec 模块，返回 `CreateExecResults` 而非裸 ID | 适配新 API：从 `CreateExecResults` 提取 id + 使用 `start_exec` 流式读取 |
| 7 | frontendKey 缺失导致 React 组件重新挂载 | Rust session_id 在连接建立前为空，连接成功后生成 UUID，作为 React key 触发 remount | 引入 frontendKey 持久标识（`ssh-${Date.now()}-${random}`），作为 React key 跨 id 变化保持挂载 |
| 8 | SshTerminal xterm 实例切换时尺寸错乱 | `display:none` → `display:block` 切换后 xterm 内部 canvas 尺寸未刷新 | 切换时调用 `fit.fit()` 重新适配尺寸 + `term.refresh(0, term.rows - 1)` 重绘 |
| 9 | side-git 在裸仓库上 `git reset --hard` 失败 | bare 仓库无工作区，`reset --hard` 不适用 | 改用 `git update-ref` 直接操作 HEAD 引用 + 重建工作区 |
| 10 | Docker 沙箱 read_only_rootfs 与 /tmp 冲突 | Alpine 3.20 部分程序需要写 /tmp，read_only_rootfs 阻止 | 挂载 tmpfs 到 /tmp（`--tmpfs /tmp:rw,size=64m`） |
| 11 | Playwright E2E 在 CI 模式下 webServer 启动超时 | `pnpm dev` 首次启动需要预构建依赖，超过 60s 默认超时 | 调整 `playwright.config.ts` 的 `webServer.timeout` 到 120s + `reuseExistingServer: true` |
| 12 | Fix-loop 在 LangGraph 节点重试时未正确计数 | `fix_loop.py` 计数器存在 thread-local，PAOR 循环跨节点时丢失 | 改为基于 session_id + tool_name 的全局计数器（`_retry_counter: dict[tuple[str, str], int]`） |

---

## 6. 用户确认的决策

### 6.1 P2 启动前确认（2026-07-26 AskUserQuestion + 技术调研）

| 决策项 | 用户选择 | 调研报告 | 落地实现 |
|--------|----------|---------|----------|
| SSH 客户端库 | **russh 0.61**（纯 Rust + tokio 异步 + ring backend） | `reports/P2-SSH技术调研报告.md` | T-P2-03 + T-P2-04 + T-P2-05 |
| 资源管理器方案 | **方案 D：Monaco Editor + 文件树 + SFTP** | `reports/P2-资源管理器技术调研报告.md` | T-P2-05 + T-P2-06 |
| Docker 沙箱库 | **bollard 0.22**（Alpine 3.20 + cap_drop ALL + read_only_rootfs） | `reports/P2-Docker沙箱技术调研报告.md` | T-P2-08 |

### 6.2 P2 阶段技术细节决策

| 决策项 | 选择 | 理由 |
|--------|------|------|
| russh crypto backend | ring（禁用 aws-lc-rs） | 解决 Windows MSVC 编译，ring 提供预编译 backend |
| SSH 多 tab 标识 | frontendKey（前端生成） | 跨 Rust session_id 变化保持 React 组件挂载稳定 |
| Monaco worker 打包 | vite-plugin-monaco-editor | 解决 Vite 6 + pnpm 嵌套路径 worker 导入 |
| Windows manifest | build.rs 统一管理 | 解决测试二进制 STATUS_ENTRYPOINT_NOT_FOUND 崩溃 |
| Docker rootfs | read_only + tmpfs /tmp | 安全隔离 + 兼容 Alpine 程序写 /tmp 需求 |

---

## 7. 方案书对齐度

### 7.1 对齐度提升

| 阶段 | 方案书 task 数 | 已完成 task 数 | 对齐度 | 提升 |
|------|---------------|---------------|--------|------|
| P0 基座 | 13 | 13 | 100% | - |
| P1-A 终端 | 3 | 3 | 100% | - |
| P1-B Agent | 12 | 12 | 100% | +11.58%（T-P1-11.6 + T-P1-12.2 在 P2 完成） |
| P2 集成 | 13 | 13 | **100%** | **+15.67%**（从 23.08% → 100%） |
| P3 前端+知识库 | 10 | 0 | 0% | - |
| P4 多 Agent | 12 | 0 | 0% | - |
| P5 高级 AI | 8 | 0 | 0% | - |
| P6 教学交付 | 6 | 0 | 0% | - |
| P7 评审验收 | 6 | 0 | 0% | - |
| **总计** | **83** | **43** | **51.81%** | **+15.67%（从 36.14% → 51.81%）** |

### 7.2 P2 阶段对齐度评估

- **13/13 task 全部完成**（100%），无任何放行项
- **6 绿门禁 + cargo test 179 + E2E 9 全过**，919 测试零失败
- **3 项技术调研决策全部落地实现**：russh 0.61 + 方案 D 资源管理器 + bollard 0.22
- **架构完整性**：前端集成 + SSH 远程 + SFTP 文件管理 + Monaco 编辑 + side-git 影子仓库 + Docker 沙箱 + 200+ 主题 + 终端补全 + cmux 分屏 + 4 接口切面文档 + Fix-loop 强制停手

---

## 8. 测试覆盖明细

### 8.1 前端测试（120 个，Vitest）

| 测试文件 | 测试数 | 覆盖范围 |
|---------|-------|---------|
| `ThemePreview.test.tsx` | 5 | 主题预览组件（P0） |
| `SshTabs.test.tsx` | 12 | SSH 多 tab + frontendKey + 状态点（P2 新增） |
| `SshStatusDot.test.tsx` | 9 | 9 状态有限状态机 + 颜色编码（P2 新增） |
| `SshConnectDialog.test.tsx` | 8 | SSH 连接弹窗 + 表单验证（P2 新增） |
| `Explorer.test.tsx` | 15 | 文件树 + 拖拽 + 右键菜单（P2 新增） |
| `MonacoEditor.test.tsx` | 10 | Monaco Editor + 多 tab + Ctrl+S（P2 新增） |
| `completion.test.ts` | 18 | Trie 树 + Frecency 排序 + shell history 解析（P2 新增） |
| `cmux-protocol.test.ts` | 14 | 10 命令 + JSON-lines 解析（P2 新增） |
| `MultiPlex.test.tsx` | 11 | tmux 分屏 + pane 管理（P2 新增） |
| `sidecar-bridge.test.ts` | 9 | invoke + subscribe + 错误码对齐（P2 新增） |
| `sandbox-bridge.test.ts` | 9 | Docker 沙箱桥接（P2 新增） |

### 8.2 Python 测试（611 个，Pytest）

| 测试文件 | 测试数 | 覆盖范围 |
|---------|-------|---------|
| `test_agents.py` | 86 | 5 Agent + 注册表 + PAOR 循环（P1-B） |
| `test_tools.py` | 38 | 6 工具集成 + 注册表（P1-B） |
| `test_graph.py` | 95 | 7 节点 + 条件路由（P1-B） |
| `test_project_service.py` | 40 | SQLite WAL + 5 表 CRUD（P1-B） |
| `test_permissions.py` | 35 | 4 档 × 3 mode 融合矩阵（P1-B） |
| `test_tdsf_loader.py` | 45 | 双层级加载 + watcher（P1-B） |
| `test_risk_engine.py` | 30 | 4 层风控管道 + L0-L4（P1-B） |
| `test_event_bus.py` | 30 | publish/subscribe + 6 事件（P1-B） |
| `test_decision_engine.py` | 28 | LangGraph 决策树（P1-B） |
| `test_needs_you.py` | 28 | 4 类型 + 优先级 + 超时（P1-B） |
| `test_confidence.py` | 25 | D-S + PCR5 证据融合（P1-B） |
| `test_jsonrpc.py` | 25 | JSON-RPC 2.0 协议（P1-B） |
| `test_fix_loop.py` | 48 | max_retry=3 + 强制停手 + needs-you 通知（P2 新增，752 行） |
| 其他 | 58 | 边界 case + 集成测试 |

### 8.3 Rust 测试（179 个，cargo test --lib）

| 模块 | 测试数 | 覆盖范围 |
|------|-------|---------|
| `modules/ssh/` | 14 | known_hosts 6 + session 5 + client 3（P2 新增） |
| `modules/side_git.rs` | 7 | init/stash/commit/rollback/track（P2 新增） |
| `modules/sandbox/` | 12 | 容器生命周期 + exec + 配置（P2 新增） |
| `modules/pty.rs` | 28 | PTY 引擎（P0/P1-A） |
| `modules/sidecar.rs` | 22 | Sidecar 进程管理（P1-B） |
| `modules/ipc.rs` | 18 | IPC client（P1-B） |
| 其他模块 | 78 | fs/proc/workspace/agent/net/secrets 等 |

### 8.4 E2E 测试（9 个，Playwright）

| 测试用例 | 覆盖范围 |
|---------|---------|
| 用例 1 | nginx 故障排查完整链路（mood 流转 + 工具调用 + Agent 输出） |
| 用例 2 | L3 风险审批流程（needs-you + 批准/拒绝） |
| 用例 3 | Agent 错误处理（mood → error + 错误信息） |
| 用例 4-9 | 字数计数 / 清空对话 / 关闭面板 / 工具卡折叠 / needs-you 卡片等 |

---

## 9. 下一步规划

### 9.1 P3 知识库 + Skills 系统（10 项 task）

| Task ID | 任务 | 依赖 |
|---------|------|------|
| T-P3-01 | SQLite FTS5 全文索引 + 索引服务 | 无 |
| T-P3-02 | ChromaDB 向量检索 + 嵌入模型 | T-P3-01 |
| T-P3-03 | 知识库 UI（搜索/浏览/导入） | T-P3-01 + T-P3-02 |
| T-P3-04 | SKILL.md 标准格式解析器（DEC-V321-13） | 无 |
| T-P3-05 | 18 领域预置 Skills 包（DEC-V321-12） | T-P3-04 |
| T-P3-06 | Skills 三者结合集成（claude-skills + skills.sh + 自研） | T-P3-04 + T-P3-05 |
| T-P3-07 | Skills 执行沙箱（与 P2 Docker 沙箱复用） | T-P3-06 |
| T-P3-08 | 知识库 + Skills 联动（Agent 调用 Skills 时检索知识库） | T-P3-03 + T-P3-06 |
| T-P3-09 | 工作区多项目切换 | 无 |
| T-P3-10 | P3 阶段验收 + 报告 | 全部 |

### 9.2 P3 启动条件

- 用户审批 P3 知识库 + Skills 系统 spec（待建立 `.trae/specs/p3-knowledge-skills/`）
- 优先级：T-P3-01 SQLite FTS5（基础设施）+ T-P3-04 SKILL.md 解析器（独立可并行）先行
- 然后并行：T-P3-02 ChromaDB + T-P3-05 18 领域 Skills 包

### 9.3 方案书对齐目标

- P3 完成后对齐度预计 **63.86%**（53/83）
- P4 完成后对齐度预计 **78.31%**（65/83）
- P5 完成后对齐度预计 **87.95%**（73/83）

---

## 10. 验收结论

✅ **P2 阶段验收通过**

- **6 绿门禁全过**（typecheck:node/web + lint + test 120 + build:web + test:python 611）
- **cargo test 179/179 + E2E 9/9 全过**，919 测试零失败
- **13/13 task 全部完成**（100%），无任何放行项
- **方案书对齐度提升 15.67%**（36.14% → 51.81%）
- **3 项技术调研决策全部落地实现**：russh 0.61 + 方案 D 资源管理器 + bollard 0.22
- **4 接口切面文档归档 + Fix-loop max_retry=3 强制停手机制落地**

**AI 接手协议**：下一会话 AI 接手时，按 `project_memory.md` 中的"7 步流程"执行，优先读 `docs/dev-state.md` 获取当前进度（P2 ✅ → P3 ⏳），再读 P3 知识库 + Skills 系统 spec 启动 T-P3-01（SQLite FTS5 + 索引）。
