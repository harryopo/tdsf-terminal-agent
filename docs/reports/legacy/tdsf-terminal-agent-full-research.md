# TDSF 终端 Agent 全面深度调研报告

> 调研时间：2026-07-25
> 调研范围：Grok Build / Claude Code(泄露源码) / Codex CLI / Aider / Cline / jcode / OpenCode / OpenSquilla / Hermes / uniTerm / terax-ai / Mistral Vibe / oh-my-pi / DeepSeek-TUI
> 目标：为 TDSF 运维终端 Agent 找到所有可集成的技术资产

---

## 目录

1. [Grok Build — 84 万行 Rust 的极速入门](#1-grok-build)
2. [Claude Code 泄露源码 — 51 万行的 Agent 教科书](#2-claude-code)
3. [Codex CLI — OpenAI 的 95K Stars Rust 终端 Agent](#3-codex-cli)
4. [Aider — 42K Stars 的模型无关终端 Agent](#4-aider)
5. [Cline — 63K Stars 的 VS Code Agent 王者](#5-cline)
6. [jcode — 14ms 首帧的极限优化](#6-jcode)
7. [OpenCode — 100K+ Stars 终端编程标准](#7-opencode)
8. [OpenSquilla — 本地模型路由器的正确形态](#8-opensquilla)
9. [Hermes Agent — KEPA 自进化引擎](#9-hermes-agent)
10. [uniTerm — 5.9MB 20+ 协议全覆盖](#10-uniterm)
11. [terax-ai — Tauri 2 的轻薄奇迹](#11-terax-ai)
12. [补充项目（Mistral Vibe / oh-my-pi / DeepSeek-TUI）](#12-补充项目)
13. [TDSF 终端 Agent IDE 界面设计](#13-tdsf-终端-agent-ide)
14. [全项目可集成资产汇总矩阵](#14-资产矩阵)
15. [落地路线图](#15-路线图)

---

## 1. Grok Build — 84 万行 Rust 的标杆

### 1.1 基本信息

| 属性 | 值 |
|------|-----|
| 仓库 | [xai-org/grok-build](https://github.com/xai-org/grok-build) |
| 许可证 | Apache 2.0 |
| 语言 | Rust（844,530 行，仅 3% 第三方代码） |
| 开源时间 | 2026-07-15 |
| 定位 | 终端全屏 TUI 编程 Agent |
| 安装方式 | `irm https://x.ai/cli/install.ps1 | iex`(Windows) |

### 1.2 核心架构（Monorepo 分层）

```
grok-build/
├── crates/codegen/
│   ├── xai-grok-pager-bin/     # 组合根，构建二进制
│   ├── xai-grok-pager/         # TUI：滚动区、输入提示、弹窗、渲染
│   ├── xai-grok-shell/         # Agent 运行时（Leader/stdio/headless）
│   ├── xai-grok-tools/         # 工具实现：Bash/Edit/Grep/Write 等
│   ├── xai-grok-workspace/     # 文件系统、Git、执行检查点
│   └── ...                     # 配置/MCP/Markdown/沙箱等
├── crates/common/              # 共享底层 crate
├── crates/build/               # 构建工具
├── third_party/                # 内置上游代码（Mermaid 图表栈）
└── xai-acp-lib/                # ACP 协议（Agent Communication Protocol）
```

**关键架构决策**：
- TUI 完全基于 **ratatui + crossterm**，无 WebView 依赖
- 输入框自研：`xai-ratatui-textarea` 和 `xai-ratatui-inline`
- tokio 并发处理输入、模型流式返回、工具执行、界面刷新
- **三种运行模式**：全屏 TUI / 无头 CLI（CI 用）/ ACP 协议嵌入 IDE

### 1.3 TDSF 可集成的资产

| 资产 | 来源模块 | TDSF 应用 |
|------|---------|----------|
| **ratatui + crossterm TUI 方案** | `xai-grok-pager` | TDSF 终端 Agent 的 TUI 框架选型参考 |
| **三种运行模式（TUI/Headless/ACP）** | `xai-grok-shell` | 运维场景：交互式 TUI + CI 脚本 + IDE 集成 |
| **ACP 协议（Agent Communication Protocol）** | `xai-acp-lib` | TDSF Agent 间的通信协议参考 |
| **检查点（Checkpoint）机制** | `xai-grok-workspace` | 高危运维操作前的快照，支持回滚 |
| **工具移植自 OpenCode/Codex** | `xai-grok-tools` | 直接参考成熟的工具接口设计 |
| **MCP 一等公民支持** | MCP crate | 与 TDSF 现有 25 个 MCP 工具无缝对接 |

### 1.4 Grok Build 的 Rust 终端 UI 创新

```
TUI 三层组件体系：
┌────────────────────────────────────────┐
│  Ratatui (通用 TUI 库)                  │  ← 基础渲染 + 布局 + 组件
│  ├── 提供：Layout/Widget/Backend       │
├────────────────────────────────────────┤
│  Grok 自研扩展                          │
│  ├── xai-ratatui-textarea    (输入框)   │  ← 多行输入、语法高亮
│  ├── xai-ratatui-inline       (内联)    │  ← 内联建议、Diff 预览
│  └── xai-grok-pager-render   (渲染)    │  ← 滚动记录、Markdown+代码高亮
├────────────────────────────────────────┤
│  Grok 业务层                            │
│  ├── 工具调用卡片渲染                    │
│  ├── 文件 Diff 预览                     │
│  ├── 状态栏 + 进度条                    │
│  └── 权限审批弹窗                       │
└────────────────────────────────────────┘
```

---

## 2. Claude Code 泄露源码 — 51 万行 Agent 教科书

### 2.1 泄露事件概要

| 属性 | 值 |
|------|-----|
| 泄露时间 | 2026-03-31 |
| 泄露方式 | npm 包中意外打包 `cli.js.map`（source map） |
| 源码规模 | 1,903 文件 / 513,704 行（TS 55%, TSX 23%, 注释 16%） |
| 镜像仓库 | Kuberwastaken/claude-code（完整 TS 源码） |
| 技术栈 | TypeScript + Node.js + React Ink（终端 React 渲染） |

### 2.2 六阶段启动流程（极简设计与安全边界）

```
Phase 0: 模块加载前的并行 I/O
  ● 利用 import 加载 ~135ms 窗口 → 并行执行 MDM/钥匙串预取
  ● 节省 ~65ms 启动时间

Phase 1: main() 入口
  ● main() → 安全设置 → 协议处理(cc://) → loadSettings → run()

Phase 2: Commander 预动作
  ● 加载 MDM 设置 + 钥匙串 → init() → 安全环境变量
  ● CA 证书加载（TLS 握手前）
  ● API 预连接（TCP+TLS 100-200ms）

Phase 3: 主命令处理
  ● 工具权限初始化 → MCP 配置 → 会话恢复
  ● 信任对话框 → 延迟预取 → launchRepl() 或 runHeadless()

关键安全设计：**信任前/后安全边界**
  - 信任前：只应用"安全"环境变量，不执行 Git 命令
  - 信任后：完整初始化，应用全部配置
```

### 2.3 四层权限管道（TDSF 安全架构的金标准）

```
auto 模式四层决策（由快到慢）：

Layer 1: 规则匹配（最快）
  └─ 字符串/正则匹配已知危险操作

Layer 2: Bash 分类器
  └─ 识别 22+ 种危险操作：rm -rf / force push / chmod 777 / dd / mkfs

Layer 3: Transcript 分类器
  └─ 分析上下文：这条命令在什么场景下被调用？

Layer 4: 独立 Claude Sonnet API 调用（温度=0，确保确定性）
  └─ 最慢但最准确，只在前面都"不确定"时调用
```

### 2.4 上下文管理（Prompt 装配框架）

```
多源动态拼装 System Prompt:
  ├── CLAUDE.md（向上递归收集）
  ├── MEMORY.md（索引导入）
  ├── git status（memoized 缓存）
  ├── MCP 指令（增量注入）
  └── 当前项目结构

延迟工具披露：
  先只发工具名 → 真正调用时通过 ToolSearch 加载完整 schema

消息压缩：
  Token 达 95% 时自动压缩早期工具调用结果
  支持嵌套压缩（压缩过的内容还能再压）

上下文窗口：默认 200K（支持 1M），输出 8K（可 retry 至 64K）
```

### 2.5 双层状态架构

```
Layer 1: Bootstrap State（进程级单例）
  ● 模块级 STATE 对象，~80 字段
  ● getter/setter 导出
  ● 涵盖：成本追踪、会话标识、遥测、模型配置、安全标志

Layer 2: AppState Store（UI 级状态）
  ● 34 行代码的自定义极简 Store 实现
  ● 基于 Set<Listener> 的观察者模式
  ● setState 使用 Object.is 比较避免无意义重渲染
```

### 2.6 泄露源码中的隐藏资产

| 隐藏功能 | 说明 | TDSF 参考 |
|---------|------|----------|
| **Kairos（持久化助手）** | 四阶段记忆整合：定向→收集→整合→修剪 | TDSF 的经验沉淀机制 |
| **Ultraplan** | Opus 4.6 模型最长达 30 分钟深度规划 | 复杂故障排查的规划模式 |
| **多 Agent 协调模式** | 并行启动多个 Agent 实例分工 | 多服务器并行运维 |
| **Buddy（电子宠物）** | ASCII 终端宠物 | 体验参考（非必要） |
| **35 个特性标志** | 大量功能通过 feature flag 控制 | 灰度发布机制的参考 |
| **120+ 隐藏环境变量** | 深度可配置 | TDSF 配置体系参考 |

### 2.7 TDSF 可直接复制的工程实践

| 实践 | 价值 |
|------|------|
| 模块加载窗口期利用并行 I/O 节省 65ms | 任何启动优化都该考虑 |
| 四层权限管道（规则→Bash分类→Transcript→LLM） | 安全架构的黄金标准 |
| 双层状态（Bootstrap/AppState）防止过早初始化 | 架构解耦 |
| 延迟工具披露（先发名字，用时加载 schema） | 减少 prompt token |
| 消息压缩（95% 阈值自动触发） | 长会话必备 |
| 信任前/后安全边界 | 供应链安全 |

---

## 3. Codex CLI — OpenAI 的 95K Stars Rust 终端 Agent

### 3.1 基本信息

| 属性 | 值 |
|------|-----|
| 仓库 | [openai/codex](https://github.com/openai/codex) |
| 许可证 | Apache 2.0 |
| 语言 | Rust（96%） |
| Stars | 95,000+ |
| 版本 | v0.142.5（2026-07） |
| 安装 | `npm i -g @openai/codex` / `brew install --cask codex` |
| 上下文窗口 | 默认 272K，可扩展到 1M token |

### 3.2 五产品表面（多端一体）

这是 Codex CLI 最独特的设计——一个 Agent，五个入口：

```
┌────────────────────────────────────────────────────┐
│              Codex Agent 核心（Rust）               │
├────────────────────────────────────────────────────┤
│  桌面 App    CLI 工具    IDE 插件   云端沙箱   移动端  │
│  (Desktop)  (Terminal)  (VS Code/  (Codex   (ChatGPT│
│                         JetBrains/  Cloud)  Mobile) │
│                         Cursor/                     │
│                         Windsurf)                   │
└────────────────────────────────────────────────────┘
```

### 3.3 OS 级沙箱（唯一的内核级安全）

**所有主流 Agent 中唯一在内核层做沙箱的：**

| 平台 | 沙箱机制 | 权限策略 |
|------|---------|----------|
| macOS | Apple Seatbelt（sandbox-exec） | 自定义策略文件 |
| Linux | Landlock + seccomp | 内核级拦截 |
| Windows | Windows Sandbox | 隔离执行 |

三种模式：
- **Read-only（suggest）**：只读，不能修改
- **Workspace-write（默认）**：项目目录内可写，**网络被封**
- **Full access（danger）**：无限制

### 3.4 关键架构决策

```
分层架构：

┌─────────────────────────────────────┐
│           用户层 (Terminal)           │
├─────────────────────────────────────┤
│         CLI 交互层                    │
│  命令解析(clap) │ 会话管理 │ 输出渲染  │
├─────────────────────────────────────┤
│        Agent 引擎层 (Rust)            │
│  tokio 异步 │ reqwest HTTP │ notify   │
├─────────────────────────────────────┤
│        沙箱安全层                     │
│  Seatbelt │ Landlock+seccomp │ WASM │
└─────────────────────────────────────┘
```

**Token 消耗优势**：Codex 每任务消耗的 token 比 Claude Code 少 3-4 倍。

### 3.5 TDSF 可集成

| 资产 | 应用 |
|------|------|
| **OS 级沙箱安全模型** | TDSF 执行高风险命令时的隔离执行环境 |
| **多表面架构** | TDSF 的 TUI/CLI/Web/移动端共享 Agent 核心 |
| **Landlock+Bubblewrap** | 高危命令隔离执行（如 rm/sudo） |
| **config.toml 配置体系** | 参考 1M token 上下文窗口配置方式 |
| **CI/CD 集成模式（codex exec）** | TDSF 自动化巡检的 CI 模式 |

---

## 4. Aider — 42K Stars 的模型无关终端 Agent

### 4.1 基本信息

| 属性 | 值 |
|------|-----|
| 仓库 | [Aider-AI/aider](https://github.com/Aider-AI/aider) |
| Stars | 42,000+ |
| 语言 | Python |
| 安装量 | PyPI 570 万+ |
| 周处理 Token | 150 亿 |
| 创始人 | Paul Gauthier（单人 96.3% 贡献） |
| 特点 | **88% 代码由 Aider 自己编写** |

### 4.2 编辑格式系统（核心创新）

Aider 的本质创新不是"又一个 Agent"，而是 **10+ 种编辑格式的精确匹配引擎**：

```
不同的 LLM 擅长的"输出格式"不同 → Aider 为每个模型匹配最佳格式

编辑格式矩阵：
┌───────────────┬──────────────────┬──────────────────┐
│ 格式          │ 原理             │ 适用模型          │
├───────────────┼──────────────────┼──────────────────┤
│ whole         │ 输出完整文件      │ 小文件 + 强模型   │
│ editblock     │ search-replace 块 │ Claude 系列      │
│ udiff         │ unified diff     │ 对 diff 训练多的  │
│ architect     │ 强模型规划+快执行  │ 降本组合         │
│ patch         │ 标准 patch       │ 通用             │
└───────────────┴──────────────────┴──────────────────┘
```

### 4.3 Repo Map（仓库地图）

Aider 用 tree-sitter 解析整个代码库，生成“结构摘要”而非发送完整文件：

```
全量代码 → tree-sitter 解析 → 提取类/函数/方法签名 → 图排名算法
→ 只把最相关的标识符注入 LLM 上下文
```

**效果**：在 4 万行代码库中，找到修改一个函数所需要的全部上下文，但不超 token 预算。

### 4.4 Architect/Editor 双模型模式

```
Architect（架构师）→ 设计修改方案（用强模型）
Editor（编辑者）  → 执行代码编辑（用便宜模型）
                   → Token 成本下降 50-70%
```

### 4.5 TDSF 可集成

| 资产 | 应用 |
|------|------|
| **Repo Map 代码库映射** | Unix 命令/配置文件的结构化理解，找出依赖关系 |
| **编辑格式匹配** | 运维命令建议时，根据 LLM 能力选择最佳输出格式 |
| **Architect/Editor 双模** | 复杂故障排查：先规划（强模型）+ 执行（便宜模型） |
| **Git 原生工作流** | 每个运维操作自动 commit，支持 revert |
| **BYOK 模型不锁定** | 参考其模型无关设计，TDSF 不绑定单一厂商 |
| **树形上下文管理** | 运维知识库的结构化上下文注入 |

---

## 5. Cline — 63K Stars 的 VS Code Agent 王者

### 5.1 基本信息

| 属性 | 值 |
|------|-----|
| 仓库 | [cline/cline](https://github.com/cline/cline) |
| Stars | 63,000+ |
| 安装量 | 500 万+ |
| 许可证 | Apache 2.0 |
| 语言 | TypeScript |
| 平台 | VS Code / JetBrains / Cursor / Windsurf / Zed / Neovim / CLI（预览）|
| 供应商 | 30+ LLM 供应商 |

### 5.2 Plan/Act 双轨制（核心差异化）

```
Plan 模式（只读）：
  └─ 扫描项目上下文 → 生成完整操作计划 → 用户逐项审查 → 手动调整
  
Act 模式（执行）：
  └─ 按批准的计划逐步执行 → 每步需确认 → 支持中途干预和回滚
```

**为什么这对 TDSF 重要**：Plan 模式 = TDSF 的安全审查模式。运维命令先规划、审批，再执行。

### 5.3 智能引用系统（@指令）

```
@file       → 引用文件内容
@folder     → 引用目录结构
@problems   → 引用工作区错误列表，AI 自动修复
@url        → 读取在线文档
@git        → 引用 Git 差异/提交记录
@terminal   → 引用终端输出
```

**TDSF 映射**：`@ssh:prod-web-01` 引用远程服务器状态，`@log:/var/log/nginx` 引用日志。

### 5.4 MCP 生态

Cline 是 MCP 协议的最大推动者之一，内置 MCP Marketplace：
- 社区贡献的 MCP 服务器可按需安装
- 支持 STDIO 和 Streamable HTTP 两种传输
- 30+ LLM 供应商可通过 MCP 统一接入

### 5.5 TDSF 可集成

| 资产 | 应用 |
|------|------|
| **Plan/Act 双轨制** | TDSF 的 ops(执行)/review(审查) 模式 |
| **@指令引用系统** | TDSF 的 `@ssh` / `@log` / `@knowledge` 引用 |
| **MCP Marketplace** | 社区贡献运维 MCP 工具的分发机制 |
| **Checkpoints 快照** | 高危运维操作前的 git 快照，支持回滚 |
| **30+ 供应商支持** | TDSF 不绑定单一模型厂商 |
| **规则系统** | `.tdsf/rules/` 目录的项目级运维规范 |

---

## 6. jcode — 14ms 首帧的极限优化

### 6.1 核心性能数据

| 指标 | jcode | Claude Code | 倍数 |
|------|-------|-------------|------|
| 首帧 | **14ms** | 3436ms | **245x** |
| 首输入 | **48ms** | 3512ms | **72x** |
| 单会话内存 | **27.8MB** | 386MB | **14x** |
| 每加一会话 | **+9.9MB** | +212MB | **21x** |
| 10会话总计 | **117MB** | 2300MB | **20x** |

### 6.2 五项极致优化技术

#### (1) 内存分配器优化
```rust
#[global_allocator]
static GLOBAL: jemallocator::Jemalloc = jemallocator::Jemalloc;
// decay + arena 调优，碎片减少 ~30%
```

#### (2) 启动路径三分裂
```
serve: 先起 provider + server（核心就绪即可）
connect: TUI client 只加载 startup stub
延时: 完整 transcript + heavy vectors 延迟加载
```

#### (3) Tool 系统 OnceLock 单次初始化
```
base tools 初始化一次 → 全局复用
session tools 只补自己的
Tool definitions 按 name 排序（减少 prompt cache 波动）
```

#### (4) Provider Split Prompt
```
静态 system prompt 和动态上下文独立
→ 静态前缀更易命中 KV Cache → 低延迟 + 低成本
```

#### (5) Mermaid 渲染器（零依赖 Rust，1800x 加速）
```
传统: Mermaid DSL → Puppeteer(Chrome) → SVG → 位图 (~1.8s, 200MB)
jcode: Mermaid DSL → nom 解析器 → dagre-rs 布局 → 直接渲染终端 (<1ms, 5MB)
```

### 6.3 Memory Sidecar 异步（创新架构）

```
当前 turn → 用上一轮的 pending memory
后台线程 → 异步准备下一轮的 memory context
不阻塞对话响应
```

### 6.4 Swarm 多 Agent 协作

```
Message Bus (tokio::broadcast)
  ├── DM（点对点）
  ├── Broadcast（广播）
  └── Channel（分组）

Merge Strategy：
  ● Vote（多数决）
  ● Defer（指定 Agent 决策）
  ● Sequential（串行执行）
```

### 6.5 TDSF 可集成清单

| 技术 | TDSF 应用 |
|------|----------|
| Append-Only Context + KV Cache | 运维 system prompt 固定 → 预计算 KV Cache |
| Memory Graph（petgraph DiGraph） | 故障溯源 → 命令因果链追踪 |
| Swarm 多 Agent | 诊断→方案→执行→验证 4 Agent 流水线 |
| Memory Sidecar 异步 | Agent 不阻塞等待记忆检索 |
| mermaid-rs-renderer | 终端内渲染架构图/流程图 |

---

## 7. OpenCode — 100K+ Stars 终端编程标准

### 7.1 核心信息

| 属性 | 值 |
|------|-----|
| 仓库 | [sst/opencode](https://github.com/sst/opencode) |
| Stars | 100K+（2026 年达 163,000+） |
| 许可证 | MIT |
| 技术栈 | Bun + TypeScript + SolidJS + OpenTUI |
| 架构 | Client/Server 解耦 |
| 模型 | 75+ Provider，不绑定单一厂商 |
| 月活 | 750 万用户 |

### 7.2 C/S 解耦架构

```
┌──────────────────────────────────────────┐
│         OpenCode Clients                  │
│  ┌─────────┐ ┌─────────┐ ┌──────────┐    │
│  │ TUI     │ │ Desktop │ │ Mobile   │    │
│  │(OpenTUI)│ │ (App)   │ │ (Remote) │    │
│  └────┬────┘ └────┬────┘ └────┬─────┘    │
│       └────────────┼──────────┘          │
│                    │ HTTP/WSS             │
│          ┌─────────▼──────────┐          │
│          │  OpenCode Server   │          │
│          │  (Bun + Hono)      │          │
│          │  + Drizzle + SQLite│          │
│          └─────────┬──────────┘          │
│                    │                     │
│    ┌───────────────┼──────────────┐      │
│    │ Agent Engine  │ LSP Manager  │      │
│    │ (build/plan/  │ (per-lang)   │      │
│    │  configure)   │              │      │
│    └───────────────┴──────────────┘      │
└──────────────────────────────────────────┘
```

### 7.3 三种 Agent 模式

| 模式 | 权限 | 场景 |
|------|------|------|
| **build** | 完全读写 | 功能开发、Bug 修复 |
| **plan** | 只读 | 代码分析、架构规划 |
| **configure** | 配置文件读写 | 环境配置 |

**TDSF 映射**：ops(执行) / review(审查) / teach(教学)

### 7.4 TDSF 可集成

| 资产 | 用途 |
|------|------|
| C/S 解耦架构 | TDSF Server 独立部署，多端接入 |
| 75+ Provider 兼容 | TDSF 不绑定单一模型 |
| Drizzle + SQLite | TDSF 数据持久化参考 |
| LSP + tree-sitter | Bash 脚本的语义理解 |
| 3 模式 Agent | TDSF 的 ops/review/teach 模式 |

---

## 8. OpenSquilla — 本地模型路由器的正确形态

### 8.1 核心资产

**SquillaRouter（本地模型路由器）**

```
请求 Pipeline：
  ├── 特征提取（query_length, complexity_score, domain_tags）
  ├── LightGBM 分类器（100 trees, max_depth=6, <1ms, 2MB ONNX）
  │   └── 分类: chat/code/shell/search
  │   └── 难度: easy/medium/hard
  │   └── 置信度: 0.0-1.0
  └── Ensemble Router
      ├── confidence > 0.9 → 直接路由
      ├── confidence 0.6-0.9 → Top-3 并行投票
      └── confidence < 0.6 → 级联回退（小→大模型）
```

### 8.2 微内核多入口架构

```
9 个入口（CLI/Web/飞书/微信/钉钉/Telegram/Slack）→ 共享同一个 Agent Loop
内核 = Agent 循环 + Tool 注册 + Memory + 模型路由
外围 = 各入口 Adapter
```

**对 TDSF 的启示**：多入口架构天然适配（TUI / Web / 飞书教学 / API）

### 8.3 TDSF 可集成

- SquillaRouter（模型路由降本）
- 微内核多入口模式
- 分层沙箱（Level 0-3）

---

## 9. Hermes Agent — KEPA 自进化引擎

### 9.1 核心机制：KEPA 反向传播

```
每 10 次工具调用 → 触发后台审查：

Step 1: 结果评分（success=1.0 / partial=0.5 / failure=0.0）

Step 2: 反向归因（因果链追踪）
  如果 T5 失败 → T5 的输入是否来自 T4 的错误输出？
              → Agent 的推理是否有逻辑漏洞？
              → System Prompt 是否提供误导信息？

Step 3: 知识更新（类梯度下降）
  K_new = K_old + η × (Expected - Actual)
  其中 η = 0.3（学习率）

Step 4: 验证
  用修正后的知识重新执行 → 通过则持久化 → 失败则降低 η 重新归因
```

### 9.2 四维记忆架构

| 维度 | 内容 | 存储 | 检索 |
|------|------|------|------|
| D1 情景记忆 | 具体任务执行记录（时间线） | SQLite + 时间戳 | 时间倒序 + 关键词 |
| D2 语义记忆 | 概念/知识图谱 | 向量数据库 | 向量相似度 + 图扩展 |
| D3 程序记忆 | SKILL.md 的可复用工作流 | Markdown 文件 | 任务类型匹配 |
| D4 工作记忆 | 当前任务上下文窗口 | RAM（不持久化） | 最近 N 轮 |

### 9.3 自动 Skill 创建

```
触发条件：Agent 执行某类任务 ≥3 次
→ 提取共性步骤 → 参数化变量 → 生成 SKILL.md
→ dry-run 验证 → 注册到 Skill 库
```

### 9.4 TDSF 集成

- **KEPA**：TDSF 运维后的自动经验沉淀
- **四维记忆**：TDSF 的知识管理架构
- **自动 Skill**：用户重复操作 3 次 → 自动生成运维 Skill

---

## 10. uniTerm — 5.9MB 20+ 协议全覆盖

### 10.1 基本信息

| 属性 | 值 |
|------|-----|
| 技术栈 | Wails v2 + Go + Vue3 |
| 包体积 | **5.9 MB** |
| 协议 | SSH/Telnet/Mosh/SFTP/RDP/VNC/MySQL/PostgreSQL/Redis/MongoDB/Docker/K8s/Serial 等 20+ |
| AI 权限 | 4 级（只读/沙箱/确认/自动） |

### 10.2 Transport 接口抽象（TDSF 最值得借鉴）

```go
type Transport interface {
    Connect(ctx context.Context) (Session, error)
    Read(p []byte) (n int, err error)
    Write(p []byte) (n int, err error)
    Close() error
    Resize(rows, cols int) error
}
```

**新增协议只需实现 Transport 接口，UI 层零改动。**

### 10.3 AI Agent 循环

```
PLAN → EXECUTE → OBSERVE → ITERATE
  │        │          │          │
  │ 自然语言→ │ 实时流式  │ stdout+   │ 成功→总结
  │ 命令序列  │ 超时控制  │ stderr+   │ 失败→回到PLAN
  │ 风险评估  │ 错误检测  │ 系统状态  │ 部分→调整
```

### 10.4 4 级 AI 权限管控

| 级别 | 允许 | 禁止 | 场景 |
|------|------|------|------|
| 只读 | ls/cat/grep/df/top | 任何写操作 | 新手学习 |
| 沙箱 | 读配置 + /tmp 写入 | sudo/系统修改 | 日常运维 |
| 确认 | 所有命令 | sudo/rm 需确认 | 经验运维 |
| 自动 | 所有命令（全量审计） | - | CI/CD |

---

## 11. terax-ai — Tauri 2 的轻薄奇迹

### 11.1 包体积优化秘诀

```toml
[profile.release]
opt-level = "z"       # 体积优先
lto = true            # 链接时优化
codegen-units = 1     # 单代码生成单元
panic = "abort"       # 移除 panic hook 开销
strip = true          # 去除调试符号
```

- 复制 WebView2 节 100MB
- SVG 替代 PNG 图标
- tokio 仅用子 crate
- 前端 Tree-Shaking + ESM 动态导入

### 11.2 TDSF 可用

- `@xterm/addon-webgl`：大日志渲染 10x 提升
- keyring 密钥管理
- PTY 缓冲区批处理策略

---

## 12. 补充项目

### 12.1 Mistral Vibe

- Mistral 官方终端 Agent，支持远程代理模式
- Cloud Sandbox 并行多任务
- VS Code 插件 + CLI 双端
- Skills 转 /commands，子代理分工
- **参考价值**：远程任务委派、子代理模式、Slash Command 系统

### 12.2 oh-my-pi

- 五层架构（TUI → Agent Runtime → 工具系统 → 模型供应商 → Native）
- LSP + Debugger + 浏览器 + GitHub 全集成
- 多模型供应商（75+）
- **参考价值**：五层架构设计、TUI 工具卡片渲染模式

### 12.3 DeepSeek-TUI

- Rust + ratatui，极轻量
- 终端原生全键盘操作
- 多轮上下文 + Markdown 渲染 + 代码高亮
- **参考价值**：面向远程 SSH 环境的轻量设计

---

## 13. TDSF 终端 Agent IDE 界面设计

### 13.1 设计原则

1. **终端优先** — 不离开命令行完成所有运维操作
2. **SSH 原生** — 终端就是 SSH 的家，AI 在侧栏辅助
3. **Markdown 载体** — 知识库、教程、Skill 全部 .md 文件
4. **分屏布局** — 左侧终端，右侧 AI Agent
5. **全键盘操作** — 参考 Grok Build / DeepSeek-TUI 的全键盘设计

### 13.2 界面布局

```
┌──────────────────────────────────────────────────────────────┐
│  TDSF Terminal Agent                                    ╳   │
├──────────────────────────────────────────────────────────────┤
│  Tab: [ssh:prod-web-01] [ssh:db-master] [knowledge] [+]     │
├───────────────────────────┬──────────────────────────────────┤
│                           │                                  │
│                           │  ┌────────────────────────────┐  │
│                           │  │  TDSF Agent (ops 模式)     │  │
│                           │  │                            │  │
│                           │  │  User: 帮我排查一下         │  │
│                           │  │  /var/log 磁盘满了         │  │
│                           │  │                            │  │
│  ┌─────────────────────┐  │  │  Agent: 已通过 SSH 执行：  │  │
│  │  SSH: prod-web-01   │  │  │  df -h → /var/log 95%     │  │
│  │                     │  │  │  du -sh /var/log/* →      │  │
│  │  user@prod-web-01:~ │  │  │  nginx/access.log 8.2G    │  │
│  │  $ df -h            │  │  │                            │  │
│  │  Filesystem  Use%   │  │  │  建议操作：               │  │
│  │  /dev/sda1   95%    │  │  │  1. logrotate 强制轮转    │  │
│  │  $ _                │  │  │  2. 清理 30 天前日志      │  │
│  │                     │  │  │  [执行] [审查] [修改]     │  │
│  │                     │  │  └────────────────────────────┘  │
│  │                     │  │                                  │
│  │                     │  │  ┌────────────────────────────┐  │
│  │                     │  │  │  知识库匹配（自动注入）    │  │
│  │                     │  │  │  📄 磁盘清理-标准流程.md   │  │
│  │                     │  │  │  📄 nginx-日志管理.md      │  │
│  │                     │  │  └────────────────────────────┘  │
│  │                     │  │                                  │
│  │                     │  │  ┌────────────────────────────┐  │
│  │                     │  │  │  风险评估                  │  │
│  │                     │  │  │  ⚠️  logrotate 命令风险：低 │  │
│  │                     │  │  │  ⚠️  rm 命令需要确认       │  │
│  │                     │  │  └────────────────────────────┘  │
│  └─────────────────────┘  │                                  │
│                           │                                  │
├───────────────────────────┴──────────────────────────────────┤
│  Status: ● prod-web-01 | CPU:12% MEM:45% DISK:95%⚠️       │
│  Model: deepseek-v3  | Tokens: 1,234/200K  |  Ctrl+O:Mode │
│  [^O]切换模式 [^K]知识库 [^S]Skill [^R]审查 [^Q]退出       │
└──────────────────────────────────────────────────────────────┘
```

### 13.3 快捷键设计

| 快捷键 | 功能 |
|--------|------|
| `Ctrl+O` | 切换 Agent 模式（ops/review/teach） |
| `Ctrl+K` | 打开知识库搜索 |
| `Ctrl+S` | 打开 Skill 面板 |
| `Ctrl+R` | 触发安全审查 |
| `Ctrl+T` | 新建 SSH Tab |
| `Ctrl+W` | 关闭当前 Tab |
| `Ctrl+J/K` | 切换 Tab |
| `Ctrl+H/L` | 调整分屏比例 |
| `Ctrl+Q` | 退出 |

### 13.4 三种视图模式

**模式 1：默认分屏（SSH + Agent）**
```
左 60%                         右 40%
┌──────────────┐              ┌──────────────┐
│   SSH 终端    │              │   AI Agent   │
│              │              │   对话区      │
│              │              │              │
│              │              │   知识卡      │
│              │              │   风险卡      │
└──────────────┘              └──────────────┘
```

**模式 2：全屏 SSH（纯终端）**
```
全屏
┌─────────────────────────────────────────┐
│            SSH 终端                      │
│           AI 内联建议以浮动提示展示        │
└─────────────────────────────────────────┘
```

**模式 3：全屏 Agent（研究/学习）**
```
全屏
┌─────────────────────────────────────────┐
│           AI Agent 对话                  │
│           知识库 / 教程 / Skill 面板      │
└─────────────────────────────────────────┘
```

### 13.5 TUI 技术栈建议

| 方案 | 语言 | 优势 | 劣势 |
|------|------|------|------|
| **ratatui + crossterm** | Rust | Grok/jcode 在用，性能极致 | 需要 Rust 技能 |
| **Bubble Tea** | Go | uniTerm 在用，Elm 架构 | 项目文档较少 |
| **Ink** | TypeScript | Claude Code 在用，React 开发者友好 | 依赖 Node.js |
| **OpenTUI** | TypeScript/SolidJS | OpenCode 在用，响应式精确 | 生态较新 |

**TDSF 推荐**：Ink（TypeScript）— 最大化复用现有 TS 代码 + React 技能

---

## 14. 全项目可集成资产汇总矩阵

| 资产 | 来源 | 优先级 | 改动量 | 收益 |
|------|------|--------|--------|------|
| KV Cache 热保持 | jcode | P0 | 小 | AI 延迟 -50% |
| OS 级沙箱（内核安全） | Codex CLI | P0 | 中 | 安全性翻倍 |
| 四层权限管道 | Claude Code | P0 | 中 | 安全性翻倍 |
| Transport 接口抽象 | uniTerm | P0 | 中 | 协议扩展成本 -80% |
| Plan/Act 双轨制 | Cline | P0 | 中 | 运维安全审查 |
| Repo Map 代码库映射 | Aider | P0 | 中 | 代码理解精准 |
| 自动 SKILL.md 生成 | Hermes | P0 | 中 | 知识自动化 |
| @智能引用系统 | Cline | P1 | 小 | 运维引用便捷 |
| 编辑格式匹配引擎 | Aider | P1 | 小 | 输出质量提升 |
| Architect/Editor 双模 | Aider | P1 | 小 | 降本 50-70% |
| 4 级 AI 权限 | uniTerm | P1 | 小 | 安全分级 |
| KEPA 反向传播 | Hermes | P1 | 大 | Agent 自优化 |
| 模型路由器 | OpenSquilla | P1 | 中 | API 成本 -60% |
| Swarm 多 Agent | jcode | P1 | 大 | 多机并行运维 |
| Memory Graph | jcode | P1 | 大 | 故障溯源 +30% |
| 五产品表面架构 | Codex CLI | P2 | 大 | 多端共享核心 |
| C/S 解耦架构 | OpenCode | P2 | 大 | 多端复用 |
| 上下文压缩 | Claude Code | P2 | 中 | 长会话稳定 |
| mermaid-rs-renderer | jcode | P2 | 中 | 流程图加速 1800x |
| MCP Marketplace | Cline | P2 | 中 | 社区生态 |
| 六阶段启动 | Claude Code | P2 | 中 | 启动 -50ms |
| 三种运行模式 | Grok Build | P2 | 大 | CI + IDE 支持 |
| ACP 协议 | Grok Build | P3 | 大 | Agent 间通信标准 |
| 延迟工具披露 | Claude Code | P3 | 小 | Token 节省 |
| Tauri 2 包体积 | terax-ai | P3 | 大 | 包 -90% |

---

## 15. 落地路线图

### Phase 0：技术验证（1 周）

```
[ ] Clone + 编译运行 Grok Build，体验 TUI
[ ] Clone + 编译运行 jcode，验证性能
[ ] Clone + 编译运行 OpenCode，理解 C/S 架构
[ ] 确定 TDSF 技术栈（Ink vs ratatui vs Bubble Tea）
[ ] 新建 tdsf-terminal-agent/ 目录
```

### Phase 1：最小原型（2 周）

```
[ ] 搭建 TUI 框架（推荐 Ink + React）
[ ] 迁移 SSH 连接管理器（去 IPC 化）
[ ] 迁移 Risk Engine
[ ] 迁移 Decision Engine
[ ] 实现 SSH 终端 + 侧栏 Agent 对话
[ ] 验证性能：启动时间 <1s，内存 <150MB
```

### Phase 2：核心能力（2 周）

```
[ ] 集成 KV Cache 预计算（jcode 方案）
[ ] 集成四层权限管道（Claude Code 方案）
[ ] 集成 4 级 AI 权限（uniTerm 方案）
[ ] 集成 KEPA 自动 Skill 生成（Hermes 方案）
[ ] Transport 接口重构 SSH 层（uniTerm 方案）
[ ] 知识库 Markdown 化
[ ] 教程系统重构
```

### Phase 3：生态集成（1 周）

```
[ ] MCP Tools 对接（现有 25 个直接复用）
[ ] Skills 目录规范（兼容 Claude Code/OpenCode/jcode）
[ ] 多入口支持（TUI / CLI / Web）
[ ] 打包发布
```

### Phase 4：持续优化（长期）

```
[ ] 模型路由器（OpenSquilla 方案 → 降本）
[ ] Swarm 多 Agent（jcode 方案 → 多机运维）
[ ] Memory Graph（jcode 方案 → 故障溯源）
[ ] C/S 解耦（OpenCode 方案 → 多端）
[ ] mermaid-rs-renderer（jcode → 架构图）
```

---

## 附录：参考链接汇总

| 项目 | 地址 |
|------|------|
| Grok Build | https://github.com/xai-org/grok-build |
| Claude Code 泄露分析 | https://github.com/instructkr/claude-code |
| Codex CLI | https://github.com/openai/codex |
| Aider | https://github.com/Aider-AI/aider |
| Cline | https://github.com/cline/cline |
| jcode | https://github.com/1jehuang/jcode |
| OpenCode | https://github.com/sst/opencode |
| OpenSquilla | https://github.com/opensquilla/opensquilla |
| Hermes Agent | https://github.com/NousResearch/hermes-agent |
| uniTerm | https://github.com/ys-ll/uniterm |
| terax-ai | https://github.com/crynta/terax-ai |
| Mistral Vibe | https://mistral.ai/news/vibe-agent |
| oh-my-pi | https://github.com/nicholasxuu/oh-my-pi |
| DeepSeek-TUI | GitHub trending 2025-05 |

---

> 报告生成时间：2026-07-25
> 后续更新请参考项目根目录 `reports/` 文件夹
