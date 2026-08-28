# 开源调研报告：Web IDE / SSH 文件管理 / 编辑器集成方案

> **调研目的**：为 `tdsf-linux-desktop`（Electron 30 + React 18 + Ant Design 5 + xterm.js + ssh2）桌面端选型可内嵌的 Web IDE、SSH 远程文件管理、Monaco/CodeMirror 编辑器、xterm+SFTP 一体化方案。
> **调研日期**：2026-07-17
> **数据来源**：GitHub 官方 API（gh CLI）+ 各项目仓库元数据
> **Star 数据截至**：2026-07-17

---

## 0. 现有项目基线（tdsf-linux-desktop）

| 项目 | 路径 | License | 已实现能力 |
|------|------|---------|-----------|
| tdsf-linux-desktop | `d:\ai\linux教学一体\tdsf-linux-desktop\` | MIT | Electron 30 + React 18 + TS 5.4 + Vite 5 + Ant Design 5 + xterm.js 5.5 + ssh2 1.15 + better-sqlite3 + Zustand + electron-store |

**已具备的能力（评估集成的基准）**：
- `SshConnectionManager`：连接管理、交互式 Shell、exec、resize
- `SftpManager`：list / upload / download / delete / rename / chmod
- IPC 三层架构：`ssh:connect/disconnect/exec`、`ssh:shell:start/write/resize`、`sftp:list/upload/download/delete/rename/chmod`
- 终端数据推送：`mainWindow.webContents.send('terminal:data', sessionId, data)`
- contextBridge + contextIsolation + sandbox 安全三原则已就位
- 已有 `@xterm/addon-fit`、`addon-search`、`addon-web-links`、`addon-webgl`

**当前缺口**（本次调研要补的能力）：
1. ❌ 无代码编辑器（不能在桌面端直接编辑远程文件）
2. ❌ 无文件树 UI（只有 SFTP list 接口，无树形组件）
3. ❌ 无大文件流式读写（SFTP 全量上传/下载）
4. ❌ 无 IDE 级体验（无语法高亮、无 LSP、无多 Tab）

---

## 1. Web-based IDE 开源方案（重点）

### 1.1 对比总表

| 项目 | Star | License | 主语言 | 核心定位 | Electron 集成 | 集成难度 |
|------|------|---------|--------|---------|--------------|---------|
| **code-server** | 78,438 | MIT | TypeScript | VS Code in browser | ⚠️ 重（独立服务） | 🔴 高 |
| **Eclipse Theia** | 21,598 | EPL-2.0 | TypeScript | Cloud & Desktop IDE 框架 | ✅ 原生支持（Electron 是其官方壳） | 🟡 中 |
| **OpenVSCode Server** | 6,114 | MIT | TypeScript | 远程 VS Code | ⚠️ 重（独立服务） | 🔴 高 |
| **Coder** | 13,857 | AGPL-3.0 | Go | 开发环境管控平台 | ❌ 不适合（AGPL+服务端） | 🔴 极高 |
| **judge0** | 4,315 | GPL-3.0 | HTML/Rails | 代码执行沙箱 | ❌ 不适合（GPL+独立服务） | 🔴 极高 |

### 1.2 逐项详评

#### 1.2.1 code-server（Coder）
- **仓库**：https://github.com/coder/code-server
- **Star**：78,438 ⭐（Web IDE 类目 Top 1）
- **核心能力**：把 VS Code 完整跑在浏览器里，支持所有 VS Code 扩展、远程开发、SSH 连接远程主机
- **技术栈**：TypeScript + Node.js + VS Code fork
- **许可证**：MIT（友好）
- **是否适合 Electron 内嵌**：⚠️ 可以但很重
  - **方式 A（webview 加载）**：本地启动 code-server 进程（默认 8080 端口），Electron BrowserView/`<webview>` 加载 `http://localhost:8080`。优点：零改动获得完整 VS Code 体验。缺点：进程外、IPC 桥复杂、内存翻倍（Electron 自身 200MB + code-server 300MB+）、文件系统隔离
  - **方式 B（嵌入 Monaco）**：放弃 code-server 整体，只取其 Monaco + 文件服务思想，自研
- **集成难度**：🔴 高（需起独立 Node 服务，跨进程通信、文件系统映射、端口管理）
- **优劣对比**：
  - ✅ 生态最成熟，VS Code 插件全兼容
  - ✅ MIT 友好
  - ❌ 进程模型与 Electron 三层架构冲突（code-server 自带 server/client 双层）
  - ❌ 300MB+ 包体增量，对桌面应用过重
  - ❌ 与 TDSF 已有的 ssh2/SftpManager 重复，会导致两套 SSH 栈并存

#### 1.2.2 Eclipse Theia ⭐ 推荐
- **仓库**：https://github.com/eclipse-theia/theia
- **Star**：21,598 ⭐
- **核心能力**：IDE 框架（不是成品），可组装出 VS Code-like 体验，**官方支持 Electron 桌面壳**（Theia Electron 模板）
- **技术栈**：TypeScript + InversifyJS DI + Monaco Editor + VS Code Extension API 兼容
- **许可证**：EPL-2.0（商业友好，比 GPL 宽松，但比 MIT 严格，需保留版权声明）
- **是否适合 Electron 内嵌**：✅ **原生设计**
  - Theia 本身就把 Electron 作为一等公民，提供 `@theia/electron` 包
  - 可以替换 Theia 的后端服务为 TDSF 现有 ssh2/SftpManager
- **集成难度**：🟡 中（需学习 Theia 模块化/DI 体系，但官方模板可起步）
- **优劣对比**：
  - ✅ 架构上天然支持桌面端
  - ✅ 兼容 VS Code Extension API（能用大量现成插件）
  - ✅ Monaco 内嵌，无需自研编辑器
  - ⚠️ EPL-2.0 要求修改后开源（仅对分发有效，内部使用不受限）
  - ⚠️ 学习曲线陡（InversifyJS DI + 模块系统）
  - ❌ 重构现有 TDSF renderer 为 Theia 工作量大

#### 1.2.3 OpenVSCode Server（Gitpod）
- **仓库**：https://github.com/gitpod-io/openvscode-server
- **Star**：6,114 ⭐
- **核心能力**：上游 VS Code 的纯远程版本，跑在服务器上通过浏览器访问
- **技术栈**：TypeScript + VS Code 上游 fork
- **许可证**：MIT
- **是否适合 Electron 内嵌**：⚠️ 不推荐
  - 定位是"远程服务器 + 浏览器"，不是桌面
  - 与 code-server 同样的进程外问题，且 Gitpod 维护策略可能脱离社区需求
- **集成难度**：🔴 高
- **优劣对比**：
  - ✅ 上游 VS Code 同步最紧（比 code-server 更"原汁原味"）
  - ❌ 文档和社区比 code-server 弱
  - ❌ 同样 300MB+ 增量

#### 1.2.4 Coder（v2 workspace 平台）
- **仓库**：https://github.com/coder/coder
- **Star**：13,857 ⭐
- **核心能力**：开发环境编排平台（不直接是 IDE），管理 workspace 生命周期
- **技术栈**：Go + Terraform + PostgreSQL
- **许可证**：⚠️ **AGPL-3.0**（强 copyleft，TDSF 不能复制代码）
- **是否适合 Electron 内嵌**：❌ 不适合
  - Go 后端 + 独立部署模式，与桌面端架构完全不匹配
  - AGPL-3.0 红线（TDSF AGENTS.md 已明文不复制 AGPL 代码）
- **集成难度**：🔴 极高
- **优劣对比**：
  - ✅ 企业级 workspace 管理思路优秀
  - ❌ License 红线
  - ❌ 与桌面端单机定位完全错位

#### 1.2.5 judge0
- **仓库**：https://github.com/judge0/judge0
- **Star**：4,315 ⭐
- **核心能力**：在线代码执行沙箱（50+ 语言），REST API 提交代码并返回执行结果
- **技术栈**：Ruby on Rails + PostgreSQL + Redis + Docker isolate
- **许可证**：⚠️ **GPL-3.0**
- **是否适合 Electron 内嵌**：❌ 不适合
  - 是代码执行系统，不是 IDE，定位不同
  - GPL-3.0 红线
  - 需要 Docker + Redis 依赖，桌面端负担不起
- **集成难度**：🔴 极高
- **优劣对比**：
  - ✅ 如果做"学生提交代码→自动评分"功能可作后端
  - ❌ 不能直接做 IDE 用
  - ❌ License 红线 + 依赖栈过重

### 1.3 小结：Web IDE 选型建议

**最值得集成的 2 个**：
1. 🥇 **Eclipse Theia**（如果走"完整 IDE 体验"路线）—— 架构契合度高，但需重构 renderer
2. 🥈 **code-server（webview 加载模式）**（如果走"快速获得 VS Code 体验"路线）—— 集成简单但代价是 300MB 包体

**实际建议**：TDSF 已有 Ant Design 5 + xterm.js 完整界面，**不建议整体替换为 Theia/code-server**。应走"自研轻量编辑器"路线（见第 3 节 Monaco/CodeMirror），保留 TDSF UI 一致性。

---

## 2. SSH 远程文件管理开源方案

### 2.1 对比总表

| 项目 | Star | License | 主语言 | 核心定位 | Electron 集成 | 集成难度 |
|------|------|---------|--------|---------|--------------|---------|
| **sshfs** | 7,561 | GPL-2.0 | C | FUSE 挂载为本地盘 | ❌ 不适合（GPL+系统依赖） | 🔴 极高 |
| **filebrowser** | 35,572 | Apache-2.0 | Go | Web 文件管理器 | ⚠️ webview 加载 | 🟡 中 |
| **WinSCP / FileZilla** | - | GPL | C++ | 桌面 GUI 协议层 | ❌ 不可嵌入 | 🔴 极高 |
| **Tabby** | 73,316 | MIT | TypeScript | Electron 终端 + SFTP | ✅ **同栈可借鉴** | 🟢 低 |
| **Wave Terminal** | 21,705 | Apache-2.0 | Go+TS | AI 终端 + 文件管理 | ✅ 可借鉴架构 | 🟡 中 |
| **Warp** | 63,284 | AGPL-3.0 | Rust | Agentic 终端 | ❌ License 红线 | 🔴 极高 |
| **itops-agent-platform** | 730 | Other | TypeScript | ITOps Agent 平台 | ⚠️ 思路可借鉴 | 🟡 中 |
| **electerm** | 14,510 | MIT | JavaScript | Electron SSH/SFTP 客户端 | ✅ **同栈可借鉴** | 🟢 低 |
| **ssh2 (mscdex)** | 5,806 | MIT | JavaScript | Node.js SSH2 客户端 | ✅ **TDSF 已用** | 🟢 已集成 |
| **node-ssh (steelbrain)** | 1,001 | MIT | TypeScript | ssh2 的 Promise 封装 | ✅ 可选 | 🟢 低 |
| **nterm-ng** | - | - | Python | FastAPI 终端服务器 | ❌ 不同语言栈 | 🔴 高 |

### 2.2 逐项详评

#### 2.2.1 sshfs（libfuse）
- **仓库**：https://github.com/libfuse/sshfs
- **Star**：7,561 ⭐
- **核心能力**：通过 SFTP 把远程目录挂载为本地文件系统（FUSE）
- **技术栈**：C + FUSE + libssh
- **许可证**：⚠️ **GPL-2.0**（强 copyleft）
- **是否适合 Electron 集成**：❌ 不适合
  - Linux 专属（Windows 需 WinFsp + 额外驱动）
  - GPL-2.0 红线
  - 系统级挂载权限要求高，桌面应用分发困难
- **集成难度**：🔴 极高
- **优劣对比**：
  - ✅ 用户体验最自然（远程文件像本地文件）
  - ❌ 跨平台噩梦
  - ❌ License 红线
  - ❌ 与 TDSF 已有 ssh2 重复

#### 2.2.2 filebrowser
- **仓库**：https://github.com/filebrowser/filebrowser
- **Star**：35,572 ⭐
- **核心能力**：Web 端文件管理器，支持上传/下载/分享/用户管理
- **技术栈**：Go + Vue.js
- **许可证**：Apache-2.0（友好）
- **是否适合 Electron 集成**：⚠️ 可行但不优
  - 方式：本地起 filebrowser 二进制（5MB+），Electron webview 加载 `http://localhost:port`
  - 但 filebrowser 操作的是本地文件，要管理远程文件需先 sshfs 挂载，回到 2.2.1 的死路
- **集成难度**：🟡 中
- **优劣对比**：
  - ✅ UI 美观成熟
  - ✅ Apache-2.0 友好
  - ❌ 只能管本地文件，远程文件需挂载
  - ❌ Go 二进制分发对 Electron 应用是异物

#### 2.2.3 WinSCP / FileZilla（协议层）
- **仓库**：无 GitHub 仓库（闭源/独立项目）
- **核心能力**：Windows GUI SFTP/SCP 客户端
- **技术栈**：C++ / Pascal
- **许可证**：GPL
- **是否适合 Electron 集成**：❌ 不可嵌入
  - 不能作为库引用，只能作为外部进程调用
- **集成难度**：🔴 极高
- **优劣对比**：
  - ✅ 协议实现稳定可参考
  - ❌ 无法嵌入 Electron UI
  - ❌ GPL 限制

#### 2.2.4 Tabby ⭐ 强烈推荐借鉴
- **仓库**：https://github.com/Eugeny/tabby
- **本地路径**：`d:\ai\linux教学一体\opensource-reference\tabby\`（已 clone）
- **Star**：73,316 ⭐（终端类目 Top 1）
- **核心能力**：Electron + TypeScript 终端，集成 SSH/SFTP/Serial，支持插件
- **技术栈**：**与 TDSF 完全一致** —— Electron + TypeScript + Angular（renderer）+ ssh2 + node-pty
- **许可证**：MIT（可自由借鉴代码）
- **是否适合 Electron 集成**：✅ **完美契合**
  - TDSF AGENTS.md 已将其列为"可自由借鉴"的开源参考
  - 已 clone 在本地 `opensource-reference/tabby/`
- **集成难度**：🟢 低（直接借鉴 SFTP 文件树组件 + SSH 连接池实现）
- **优劣对比**：
  - ✅ **同技术栈**（Electron + ssh2 + TS），代码可几乎直接移植
  - ✅ MIT 友好
  - ✅ 已有成熟的 SFTP 文件树 UI、传输队列、跳板机实现
  - ✅ TDSF 已有 `opensource-reference/tabby/` 本地参考
  - ⚠️ Tabby 用 Angular，TDSF 用 React，UI 组件需重写（但 service 层可复用）
  - ⚠️ Tabby 是终端为本，文件管理为辅；TDSF 需求是双向均衡

#### 2.2.5 Wave Terminal
- **仓库**：https://github.com/wavetermdev/waveterm
- **Star**：21,705 ⭐
- **核心能力**：开源 AI 集成终端，支持 SSH 远程、内嵌 Markdown/代码预览
- **技术栈**：Go（后端）+ React/TypeScript（前端）+ Electron
- **许可证**：Apache-2.0（友好）
- **是否适合 Electron 集成**：✅ 可借鉴架构
  - Wave 把终端块（block）化为可平铺的工作区，TDSF 可借鉴其布局思想
- **集成难度**：🟡 中（前端 React 可借鉴，后端 Go 不可直接复用）
- **优劣对比**：
  - ✅ Apache-2.0 + React 前端
  - ✅ "Block 化工作区"思想新颖，适合教学场景
  - ⚠️ Go 后端不可移植
  - ⚠️ 文档相对薄弱

#### 2.2.6 Warp
- **仓库**：https://github.com/warpdotdev/warp
- **Star**：63,284 ⭐
- **核心能力**：Agentic 开发环境，AI 原生终端
- **技术栈**：Rust（不可移植到 TDSF Node.js 栈）
- **许可证**：⚠️ **AGPL-3.0**（红线）
- **是否适合 Electron 集成**：❌ 不适合
- **集成难度**：🔴 极高
- **优劣对比**：
  - ✅ AI 终端设计思想值得学习
  - ❌ Rust 栈无法移植
  - ❌ AGPL-3.0 红线（TDSF AGENTS.md 已明文拒绝）

#### 2.2.7 itops-agent-platform
- **仓库**：https://github.com/qinshihu/itops-agent-platform
- **本地路径**：`d:\ai\linux教学一体\opensource-reference\itops-agent-platform\`（已 clone）
- **Star**：730 ⭐
- **核心能力**：企业级 ITOps 多 Agent 自动化平台，告警自动修复闭环
- **技术栈**：TypeScript
- **许可证**：Other（需查 LICENSE 文件）
- **是否适合 Electron 集成**：⚠️ 思路可借鉴，代码不可直接复用
  - TDSF AGENTS.md 已列为"可自由借鉴"参考
  - 它是 Web 后端平台，与桌面端架构不同
- **集成难度**：🟡 中
- **优劣对比**：
  - ✅ Agent 工作流编排思路优秀
  - ✅ 国产项目，国内文档友好
  - ❌ 不是文件管理工具，本节相关度低

#### 2.2.8 electerm ⭐ 推荐
- **仓库**：https://github.com/electerm/electerm
- **Star**：14,510 ⭐
- **核心能力**：Electron 终端/SSH/SFTP/FTP/Telnet/Serial/RDP/VNC 多协议客户端
- **技术栈**：**Electron + JavaScript + ssh2**（与 TDSF 完全同栈，仅 JS vs TS 差异）
- **许可证**：MIT
- **是否适合 Electron 集成**：✅ 完美契合
- **集成难度**：🟢 低
- **优劣对比**：
  - ✅ 同 Electron + ssh2 技术栈，几乎可直接借鉴
  - ✅ MIT 友好
  - ✅ 多协议支持广（甚至含 RDP/VNC）
  - ⚠️ JS 写的，移植到 TS 需补类型
  - ⚠️ UI 风格与 Ant Design 不一致

#### 2.2.9 ssh2 (mscdex) ✅ 已集成
- **仓库**：https://github.com/mscdex/ssh2
- **Star**：5,806 ⭐
- **核心能力**：纯 JS 实现的 SSH2 客户端和服务端，支持 SFTP、exec、shell、端口转发、跳板机
- **技术栈**：JavaScript（C++ 可选加速）
- **许可证**：MIT
- **是否适合 Electron 集成**：✅ **TDSF 已用**（package.json 中 `"ssh2": "^1.15.0"`）
- **集成难度**：🟢 已完成
- **优劣对比**：
  - ✅ TDSF 已有完整 SshConnectionManager + SftpManager
  - ✅ Node.js 生态唯一成熟的 SSH 库
  - ⚠️ 文档略简，部分高级特性需查源码
  - ⚠️ 作者维护节奏近年放缓

#### 2.2.10 node-ssh (steelbrain)
- **仓库**：https://github.com/steelbrain/node-ssh
- **Star**：1,001 ⭐
- **核心能力**：ssh2 的 Promise 化封装，API 更友好
- **技术栈**：TypeScript
- **许可证**：MIT
- **是否适合 Electron 集成**：✅ 可选（TDSF 已自封装，无需替换）
- **集成难度**：🟢 低
- **优劣对比**：
  - ✅ Promise API 比 ssh2 原生回调更现代
  - ✅ TS 类型完整
  - ❌ 功能子集，不如 ssh2 完整（无端口转发、跳板机）
  - ❌ TDSF 已自研 Promise 化封装，重复

#### 2.2.11 nterm-ng（本地参考）
- **本地路径**：`d:\ai\linux教学一体\opensource-reference\nterm-ng\nterm\`
- **核心能力**：FastAPI + WebSocket 的终端服务器，含 SSH 会话管理、ParseBroker 命令解析、Vault 凭证管理
- **技术栈**：Python + FastAPI + WebSocket
- **许可证**：未知（本地参考）
- **是否适合 Electron 集成**：❌ 不同语言栈
- **集成难度**：🔴 高
- **优劣对比**：
  - ✅ 命令解析、Session Tree、Vault 思路值得借鉴
  - ❌ Python 不能直接嵌入 Electron 主进程
  - ❌ 若移植需重写为 TS

### 2.3 小结：SSH 文件管理选型建议

**最值得集成的 2 个**：
1. 🥇 **Tabby**（同栈 MIT，已本地 clone）—— 直接借鉴 SFTP 文件树 + 传输队列 service 层
2. 🥈 **electerm**（同栈 MIT）—— 借鉴多协议客户端架构

**Node.js/TypeScript 的 SSH SFTP 文件树实现**：
- ✅ **Tabby 的 `tabby-terminal` + `tabby-sftp` 插件** —— 用 TypeScript + ssh2 + Angular 写的文件树，UI 层需重写为 React，service 层可移植
- ✅ **electerm 的 SFTP 模块** —— 用 JS + ssh2 写的完整 SFTP 客户端，可参考协议层
- ✅ **TDSF 自研**（推荐）—— 已有 SftpManager，只需补 React 文件树 UI（用 Ant Design Tree 组件即可）

---

## 3. Monaco Editor / CodeMirror 6 集成

### 3.1 对比总表

| 项目 | Star | License | 主语言 | 核心定位 | Electron 集成 | 集成难度 |
|------|------|---------|--------|---------|--------------|---------|
| **monaco-editor** | 46,372 | MIT | JavaScript | 浏览器代码编辑器（VS Code 同款） | ✅ 推荐 | 🟢 低 |
| **CodeMirror 5** | 27,246 | MIT | JavaScript | 旧版浏览器编辑器（legacy） | ⚠️ 不推荐 | 🟡 中 |
| **CodeMirror 6** | (in cm5 repo) | MIT | TypeScript | 新版模块化编辑器 | ✅ 可选 | 🟡 中 |
| **@monaco-editor/react (suren-atoyan)** | 4,722 | MIT | TypeScript | Monaco 的 React 封装（推荐） | ✅ **完美** | 🟢 极低 |
| **react-monaco-editor** | 4,202 | MIT | TypeScript | Monaco 的 React 封装（旧） | ✅ 可用 | 🟢 低 |
| **@uiw/react-codemirror** | 2,233 | MIT | TypeScript | CodeMirror 6 的 React 封装 | ✅ 可选 | 🟢 低 |
| **codemirror-languageserver** | 258 | BSD-3 | TypeScript | CM6 接 LSP | ✅ 可选 | 🟡 中 |

### 3.2 逐项详评

#### 3.2.1 monaco-editor ⭐ 强烈推荐
- **仓库**：https://github.com/microsoft/monaco-editor
- **Star**：46,372 ⭐
- **核心能力**：VS Code 同款编辑器内核，语法高亮、IntelliSense、多光标、Minimap、断点、Diff 等
- **技术栈**：JavaScript + AMD loader（也提供 ESM）
- **许可证**：MIT
- **是否适合 Electron 集成**：✅ 完美（Electron renderer 直接 `npm i monaco-editor` 即可）
- **集成难度**：🟢 低
- **优劣对比**：
  - ✅ 与 VS Code 同源，体验最熟悉
  - ✅ 100+ 语言语法支持
  - ✅ MIT
  - ✅ Web Worker 多线程语法分析
  - ⚠️ 包体较大（核心 ~3MB gzip）
  - ⚠️ AMD loader 与 Vite 集成需 `monaco-editor-webpack-loader` 或 `vite-plugin-monaco-editor`

#### 3.2.2 @monaco-editor/react (suren-atoyan) ⭐ 强烈推荐
- **仓库**：https://github.com/suren-atoyan/monaco-react
- **Star**：4,722 ⭐（React Monaco 封装中 Star 最高）
- **核心能力**：Monaco Editor 的 React 组件封装，支持懒加载、主题切换、多实例
- **技术栈**：TypeScript + React
- **许可证**：MIT
- **是否适合 Electron 集成**：✅ **完美契合 TDSF React 栈**
- **集成难度**：🟢 极低（`pnpm add @monaco-editor/react` 即可）
- **优劣对比**：
  - ✅ API 简洁：`<Editor height="100%" language="bash" value={code} onChange={setCode} />`
  - ✅ 内置 loader，无需手动配 Vite
  - ✅ TS 类型完整
  - ✅ 与 Ant Design Layout 完美共存
  - ⚠️ 高级特性（如自定义 language registration）需直接操作 monaco instance

#### 3.2.3 CodeMirror 6
- **仓库**：https://github.com/codemirror/codemirror （已合并到 v6 主线，旧 v5 在 codemirror/codemirror5）
- **Star**：27,246 ⭐（cm5+cm6 合计）
- **核心能力**：模块化、可扩展、移动端友好的代码编辑器
- **技术栈**：TypeScript（@codemirror/* 多包架构）
- **许可证**：MIT
- **是否适合 Electron 集成**：✅ 可选
- **集成难度**：🟡 中（API 学习曲线比 Monaco 陡）
- **优劣对比**：
  - ✅ 包体小（按需引入，最小 ~80KB）
  - ✅ 模块化，自定义能力强
  - ✅ 移动端体验优于 Monaco
  - ❌ 开箱即用功能少于 Monaco（无 IntelliSense、无 Minimap）
  - ❌ 语法高亮覆盖语言少于 Monaco

#### 3.2.4 @uiw/react-codemirror
- **仓库**：https://github.com/uiwjs/react-codemirror
- **Star**：2,233 ⭐
- **核心能力**：CodeMirror 6 的 React 封装，预置常用扩展
- **技术栈**：TypeScript + React
- **许可证**：MIT
- **是否适合 Electron 集成**：✅ 可选
- **集成难度**：🟢 低
- **优劣对比**：
  - ✅ React 友好
  - ✅ 文档示例丰富
  - ⚠️ 功能上不如 Monaco "开箱即用"

### 3.3 远程文件读写流（避免全量同步）最佳实践

TDSF 现状：`SftpManager.download(remotePath, localPath)` 全量下载到本地临时文件，编辑后 `upload` 全量上传。**问题**：
- 大文件（如 `/var/log/messages` 几百 MB）全量传输慢
- 编辑期间本地副本与远程不一致
- 无法实时协同

**推荐方案：分块流式 + 虚拟文档**：

1. **小文件（< 1MB）**：保持现有 `sftp:download` + `sftp:upload` 全量模式，编辑后整文件回写
2. **大文件（≥ 1MB）**：
   - 用 ssh2 的 `sftp.createReadStream(remotePath, { start, end })` 分块读取
   - Monaco 注册 `TextModel` 为自定义 `TextFileService`，按需 load chunk
   - 编辑后用 `sftp.createWriteStream` 分块写入
3. **日志类只读文件**：用 `tail -f` 模式（ssh2 shell + stream），实时追加到 Monaco 末尾

**技术细节**：
- Monaco 提供 `monaco.editor.createModel(value, language, uri)`，可替换 `value` 为 Promise
- 参考 VS Code Remote SSH 的实现：`vscode-remote://ssh-remote+host/path/to/file` URI scheme
- TDSF 可定义 `tdsf-ssh://sessionId/path/to/file` URI，由 IPC handler 解析为 SFTP 操作

**最佳实践参考项目**：
- VS Code Remote SSH 扩展（闭源，但架构公开）：`remoteAuthority` + virtual file system provider
- Theia 文件系统：`@theia/filesystem/lib/common/filesystem` 的 `FileResource` 模式

---

## 4. xterm.js + SFTP 一体化方案

### 4.1 已打通的开源 IDE 对比

| 项目 | Star | 终端 | 文件树 | 是否打通 | 借鉴价值 |
|------|------|------|--------|---------|---------|
| **Tabby** | 73,316 | node-pty + xterm | SFTP | ✅ 已打通 | 🟢 极高 |
| **Wave Terminal** | 21,705 | xterm.js | 内置 SSH | ✅ 已打通（Block 化） | 🟡 中 |
| **Warp** | 63,284 | 自研 | 内置 | ✅ 已打通 | ❌ Rust+AGPL |
| **electerm** | 14,510 | xterm.js | SFTP | ✅ 已打通 | 🟢 高 |
| **VS Code** | 187,611 | xterm.js | Remote SSH | ✅ 已打通 | 🟡 架构参考 |
| **code-server** | 78,438 | xterm.js | Remote SSH | ✅ 已打通 | 🟡 架构参考 |

### 4.2 逐项详评

#### 4.2.1 Tabby（终端 + 文件管理一体）⭐⭐⭐ 首选借鉴
- **仓库**：https://github.com/Eugeny/tabby
- **本地路径**：`d:\ai\linux教学一体\opensource-reference\tabby\`
- **核心架构**：
  - `app/lib/pty.ts` —— 终端 PTY 管理
  - `tabby-sftp` 插件 —— SFTP 文件管理（独立的 npm 包）
  - `tabby-terminal` —— 终端 UI 与交互
- **打通方式**：右键终端会话 → "Open SFTP"，自动用同一 SSH 连接打开文件浏览器
- **可借鉴点**：
  - **连接复用**：终端和 SFTP 共享同一 ssh2 Client 实例（TDSF 已通过 `SshConnectionManager` 实现）
  - **传输队列**：`tabby-sftp` 的 `FileTransfer` 抽象，支持进度、取消、并发控制
  - **拖拽上传**：从 OS 文件管理器拖到 Tabby 自动上传
- **集成难度**：🟢 低（service 层可移植，UI 层需 React 重写）

#### 4.2.2 Wave Terminal（Block 化工作区）
- **仓库**：https://github.com/wavetermdev/waveterm
- **核心架构**：每个终端/文件/网页都是一个 "Block"，可平铺排列
- **可借鉴点**：
  - **Block 模型**：教学场景下，可让学生把"命令终端 + 输出 + 教学笔记"并列展示
  - **AI 集成**：Wave 内置 AI 命令补全，与 TDSF 的 LLM 集成思路契合
- **集成难度**：🟡 中（前端 React 可参考，后端 Go 不可移植）

#### 4.2.3 electerm（轻量一体化）⭐ 借鉴
- **仓库**：https://github.com/electerm/electerm
- **核心架构**：单 Electron 进程，xterm + SFTP 同一窗口 split view
- **可借鉴点**：
  - **左右分屏**：左终端右文件管理器，TDSF 可用 Ant Design `Layout.Sider` 实现
  - **快捷键打通**：终端中 `Ctrl+Click` 路径 → 文件管理器跳转

#### 4.2.4 VS Code / code-server（架构参考）
- **仓库**：https://github.com/microsoft/vscode
- **核心架构**：Remote SSH 扩展 + xterm.js + Virtual File System
- **可借鉴点**：
  - **Remote Authority**：`vscode-remote://ssh-remote+host/path` URI scheme
  - **File System Provider**：注册 `vscode.FileSystemProvider` API，所有文件操作走 SFTP
  - **TDSF 适配**：自定义 `tdsf-ssh://sessionId/path` URI，IPC handler 解析

### 4.3 TDSF 推荐架构（基于调研结论）

```
┌─────────────────────────────────────────────────────────┐
│              TDSF Linux Desktop (Electron)              │
├─────────────────────────────────────────────────────────┤
│  Renderer (React 18 + Ant Design 5)                     │
│  ┌──────────┬──────────────────────┬─────────────────┐  │
│  │ 文件树    │ Monaco Editor       │ xterm.js 终端    │  │
│  │ (Antd    │ (@monaco-editor/    │ (已集成)         │  │
│  │  Tree)   │  react)             │                 │  │
│  └────┬─────┴──────────┬──────────┴────────┬────────┘  │
│       │ IPC: sftp:*    │ IPC: editor:*      │ IPC: ssh:* │
├───────┴────────────────┴────────────────────┴───────────┤
│  Main Process (Node.js)                                 │
│  ┌──────────────────────────────────────────────────┐   │
│  │ SshConnectionManager (已有)                       │   │
│  │   ↳ ssh2 Client (复用同一连接)                    │   │
│  │ SftpManager (已有，需扩展 stream API)             │   │
│  │ EditorService (新增，调度 sftp + Monaco)          │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

---

## 5. 重点推荐方案（最终结论）

### 🥇 推荐 1：自研轻量 IDE，借鉴 Tabby service 层

**集成路径**：
1. **文件树 UI**：用 Ant Design `Tree` 组件 + TDSF 现有 `sftp:list` IPC 通道，懒加载子目录
2. **代码编辑器**：`pnpm add @monaco-editor/react`，封装 `<RemoteEditor sessionId path />` 组件
3. **远程文件读写**：
   - 小文件：复用 `sftp:download/upload`，写入 OS 临时目录后喂给 Monaco
   - 大文件：扩展 `SftpManager`，新增 `readStream(remotePath, start, end)` 和 `writeStream(remotePath)` 方法
4. **终端打通**：右键文件树节点 → "在终端中打开"，自动 `cd $(dirname)` 到对应会话
5. **借鉴 Tabby**：参考 `opensource-reference/tabby/tabby-sftp/` 的传输队列实现，移植到 TS service 层

**预期收益**：
- 6-8 周完成 v1
- 包体增量 < 5MB（仅 Monaco）
- 与 TDSF 现有 Ant Design + xterm.js UI 一致

**风险**：
- 自研文件树需处理边界场景（权限错误、symlink、超大目录）

### 🥈 推荐 2：借鉴 electerm 的 split view 设计

**集成路径**：
1. Ant Design `Layout.Sider` 做左文件树，`Layout.Content` 嵌 Monaco + xterm 上下分屏
2. 复用 TDSF `SshConnectionManager` 单例，文件树和终端共享同一 ssh2 Client
3. 借鉴 electerm 的"Ctrl+Click 路径跳转"交互

**预期收益**：
- 1-2 周完成 MVP（仅 UI 层）
- 用户体验与 FinalShell / electerm 一致

### 🥉 推荐 3（备选）：Theia Electron 模板（仅在需要完整 IDE 时）

**集成路径**：
1. 用 `@theia/electron` 模板新建 TDSF-Theia 子项目
2. Theia 后端 service 替换为 TDSF ssh2/SftpManager
3. Theia 前端嵌入 TDSF 决策卡片 / LLM 面板

**预期收益**：
- 一次性获得 VS Code 级 IDE 体验 + 插件生态
- EPL-2.0 友好

**风险**：
- 学习曲线陡（InversifyJS DI + Theia 模块系统）
- 与现有 Ant Design UI 风格冲突，需二次定制
- 工作量 12+ 周

---

## 6. License 合规矩阵

| 项目 | License | TDSF 集成方式 | 合规性 |
|------|---------|--------------|--------|
| code-server | MIT | webview 加载 / 思想借鉴 | ✅ 自由 |
| Theia | EPL-2.0 | 模板新建子项目 | ✅ 需保留版权声明 |
| OpenVSCode Server | MIT | webview 加载 | ✅ 自由 |
| Coder | AGPL-3.0 | ❌ 红线 | ❌ 不可用 |
| judge0 | GPL-3.0 | ❌ 红线 | ❌ 不可用 |
| filebrowser | Apache-2.0 | webview 加载 | ✅ 需保留 NOTICE |
| Tabby | MIT | 代码直接借鉴 | ✅ 自由 |
| Wave Terminal | Apache-2.0 | 思路借鉴 | ✅ 需保留 NOTICE |
| Warp | AGPL-3.0 | ❌ 红线 | ❌ 不可用 |
| electerm | MIT | 代码借鉴 | ✅ 自由 |
| ssh2 | MIT | TDSF 已用 | ✅ 自由 |
| node-ssh | MIT | 可选 | ✅ 自由 |
| monaco-editor | MIT | 直接依赖 | ✅ 自由 |
| @monaco-editor/react | MIT | 直接依赖 | ✅ 自由 |
| CodeMirror 6 | MIT | 可选 | ✅ 自由 |
| @uiw/react-codemirror | MIT | 可选 | ✅ 自由 |

**TDSF AGENTS.md 红线声明**：
- ❌ **AGPL-3.0 项目（Coder / Warp / databuff）**：只借鉴架构思想，绝不复制代码
- ❌ **GPL-3.0 项目（judge0）**：不可用
- ❌ **GPL-2.0 项目（sshfs）**：不可用
- ✅ **MIT / Apache-2.0 / EPL-2.0**：可用，需保留版权声明

---

## 7. 行动清单（Next Steps）

| 优先级 | 任务 | 预计工作量 | 依赖 |
|--------|------|----------|------|
| P0 | `pnpm add @monaco-editor/react monaco-editor` | 0.5 天 | 无 |
| P0 | 实现 `<RemoteEditor sessionId path />` React 组件 | 2 天 | P0-1 |
| P0 | 用 Ant Design Tree 实现 `<RemoteFileTree sessionId />` | 2 天 | 无 |
| P1 | 扩展 `SftpManager` 新增 `readStream/writeStream` | 2 天 | 无 |
| P1 | 文件树 → 编辑器 → 终端三者联动（右键菜单） | 1 天 | P0 全部 |
| P1 | 大文件分块流式读写 | 3 天 | P1-1 |
| P2 | 借鉴 Tabby 传输队列，实现上传/下载进度条 | 3 天 | P1-2 |
| P2 | 拖拽上传（OS → 文件树） | 2 天 | P1-1 |
| P3 | tail -f 模式实时日志查看 | 2 天 | P1-1 |

**总计**：v1 MVP 约 6-8 天（P0+P1 核心），完整版约 17-20 天。

---

## 8. 附录：数据获取方式

```bash
# GitHub 仓库元数据
gh repo view coder/code-server --json name,url,stargazerCount,description,licenseInfo,primaryLanguage

# GitHub 搜索
gh search repos "wave terminal" --limit 5 --json fullName,url,stargazersCount,description,license,language

# 本地参考项目
d:\ai\linux教学一体\opensource-reference\tabby\
d:\ai\linux教学一体\opensource-reference\nterm-ng\
d:\ai\linux教学一体\opensource-reference\itops-agent-platform\
d:\ai\linux教学一体\opensource-reference\databuff\
d:\ai\linux教学一体\opensource-reference\cube-shell\
```

**调研工具**：agent-reach skill + gh CLI 2.93.0
**调研耗时**：约 30 分钟（含 13 个仓库元数据 + 5 次搜索 + 3 个本地文件核对）
