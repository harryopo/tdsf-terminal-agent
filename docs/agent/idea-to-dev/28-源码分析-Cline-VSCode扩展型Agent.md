# 源码分析报告：Cline（VS Code 扩展型 Agent，Apache-2.0）

> 分析时间：2026-07-19
> 源码版本：HEAD（--depth 1 clone）
> 分析目的：为 tdsf-linux-desktop v0.9.2 Agent 架构设计提供借鉴
> 分析师：资深源码分析师（基于真实源码阅读，非仅文档判断）

---

## 0. 摘要

### 0.1 项目基本信息

| 项目 | 信息 |
|------|------|
| 仓库名 | cline/cline |
| License | **Apache-2.0** ✅（与 tdsf-linux-desktop 兼容，可借鉴代码与设计） |
| 安装量 | 5M+（VS Code Marketplace） |
| 主要语言 | TypeScript（Bun workspace monorepo） |
| 运行时 | Bun 1.3.13 / Node.js ≥22 |
| 包管理 | bun@1.3.13 |
| 主要模块 | VS Code Extension / CLI / Cline Hub / SDK / Kanban / JetBrains |
| 文档系统 | docs/（基于 .mdx，docs.json 配置） |
| 协议 | Protobuf v3 + gRPC over WebSocket（webview↔extension host） |

### 0.2 核心架构特点

1. **分层 SDK 架构**：`@cline/shared` → `@cline/llms` → `@cline/agents` → `@cline/core`，单向依赖、严格边界
2. **Hub-Spoke 多进程架构**：Hub 协调器 + Spoke worker + Client（CLI/VSCode/Hub），会话独立于 UI 进程
3. **plan-and-act 双模式**：通过 `mode` 字段（plan/act）切换，Plan 模式只读、Act 模式可执行
4. **Protobuf 协议层**：18+ `.proto` 文件定义 webview ↔ extension host 通信契约
5. **MCP 一等公民**：McpHub 统一管理 MCP Server 进程，工具动态注入
6. **50+ Provider 适配**：Anthropic/OpenAI/Bedrock/Vertex/OpenRouter/Ollama/LM Studio/DeepSeek/Qwen/Gemini/Cerebras/Groq 等开箱即用
7. **Checkpointing via 影子 Git**：独立 git 仓库做快照，主仓库历史不被污染
8. **多形态分发**：同一 Agent Core，输出 CLI（TUI）/ VS Code Extension / Cline Hub（Web）/ JetBrains Plugin / ACP（Neovim/Zed）

### 0.3 对 tdsf-linux-desktop 的关键借鉴价值

| 价值点 | 说明 |
|--------|------|
| ⭐⭐⭐⭐⭐ plan-and-act 架构 | 直接可借鉴：模式切换 + Plan 模式只读 + Act 模式带审批 |
| ⭐⭐⭐⭐⭐ 工具系统设计 | createTool + ToolPolicy + autoApprove + Zod schema |
| ⭐⭐⭐⭐⭐ BYOK Provider 工厂 | 50+ Provider 的 enum + ModelInfo 数据结构 |
| ⭐⭐⭐⭐⭐ MCP 集成 | McpHub 模式：进程管理 + 工具发现 + 配置文件监听 |
| ⭐⭐⭐⭐ Checkpointing | 影子 git 仓库思路，可用于 tdsf 运维回滚 |
| ⭐⭐⭐⭐ Skills 系统 | SKILL.md + 渐进加载（metadata→instructions→resources） |
| ⭐⭐⭐⭐ Hooks 机制 | 用户自定义脚本钩子（preTool/postTool 等） |
| ⭐⭐⭐ Protobuf 协议 | Electron 主进程↔渲染进程可用 protobuf 替代 ad-hoc IPC |
| ⭐⭐⭐ Auto-compact | 上下文压缩策略，长会话必备 |
| ⭐⭐ Subagents / Multi-agent Teams | 运维场景多代理协调参考 |

### 0.4 借鉴清单速览（详见 §14）

- **P0**：plan-and-act 双模式、工具系统（createTool + ToolPolicy）、MCP 集成、BYOK Provider 工厂、人工审批闸门（强制）
- **P1**：Checkpointing（运维回滚）、Skills 渐进加载、.clinerules 规则文件、Auto-compact
- **P2**：Hub-Spoke 多进程、Protobuf 协议、Subagents 并行研究
- **不建议借鉴**：JetBrains 适配、ACP 协议、Kanban Web 多 agent 调度（运维场景过重）

---

## 1. 项目概览

### 1.1 基本信息

Cline 是 Apache-2.0 开源的 AI 编程 agent，5M+ VS Code 安装量，提供：
- **VS Code 扩展**：Editor 内 AI 编程助手（5M+ 安装）
- **JetBrains 插件**：IntelliJ/PyCharm/WebStorm/GoLand 同体验
- **CLI**：`npm i -g cline`，TUI 交互 + headless JSON 输出，CI/CD 友好
- **Cline Hub**：Web 多 agent 任务面板，每张卡独立 worktree + auto-commit + 依赖链
- **SDK**：`@cline/sdk` Node.js 程序化 API，第三方集成
- **Kanban**：Web 多 agent 并行任务板（独立仓库 `cline/kanban`）

详见 [README.md](file:///d:/ai/linux教学一体/opensource-reference/cline/README.md)。

### 1.2 目录结构

```
cline/
├── apps/                           # 应用层
│   ├── cli/                        # CLI（TUI + headless）
│   │   ├── src/
│   │   │   ├── acp/                # Agent Communication Protocol（Neovim/Zed）
│   │   │   ├── commands/           # commander 子命令
│   │   │   ├── connectors/         # Slack/Telegram/Discord/Linear/WhatsApp
│   │   │   ├── runtime/            # run-agent.ts / tool-policies.ts / tools.ts
│   │   │   ├── session/            # 会话生命周期
│   │   │   ├── tui/                # OpenTUI 终端 UI
│   │   │   ├── wizards/            # 交互式向导（mcp/connect/schedule）
│   │   │   ├── main.ts             # 入口
│   │   │   └── index.ts
│   │   └── package.json
│   ├── cline-hub/                  # Web 多 agent 调度面板
│   │   └── src/
│   │       ├── server/
│   │       │   ├── hub.ts          # Hub 核心（attachHub/syncHubClientsAndSessions）
│   │       │   ├── sessions.ts     # 会话管理
│   │       │   ├── mcp.ts
│   │       │   └── state.ts
│   │       └── webview/            # React Web UI
│   ├── examples/                   # SDK 示例（cli-agent/multi-agent/quickstart/vscode/menubar/desktop-app）
│   ├── vscode/                     # VS Code 扩展主体（WIP 迁移到 apps/）
│   │   ├── proto/                  # Protobuf 协议定义
│   │   │   ├── cline/              # 18 个 cline.* proto
│   │   │   └── host/               # 5 个 host.* proto（diff/env/testing/window/workspace）
│   │   ├── src/
│   │   │   ├── core/               # 核心逻辑（api/hooks/locks/mentions/storage/webview/workspace）
│   │   │   ├── sdk/                # SDK 适配层（SdkController/auth-service/bedrock-config/sdk-compaction/sdk-telemetry/session-host/task-proxy/workspace-root）
│   │   │   ├── services/
│   │   │   │   ├── mcp/McpHub.ts   # ← MCP 集成核心
│   │   │   │   ├── auth/
│   │   │   │   └── temp/
│   │   │   ├── shared/             # 跨进程共享（api.ts/tools.ts/skills.ts/mcp.ts/cline-rules.ts）
│   │   │   ├── utils/              # 工具函数（cli-detector/env/envExpansion/fs/fs-info/git/git-worktree/mcpAuth/model-utils/path/powershell/retry/shell/storage/time）
│   │   │   ├── extension.ts        # ← VS Code 扩展入口
│   │   │   ├── config.ts           # ClineEndpoint 单例
│   │   │   ├── registry.ts         # 命令/视图注册表
│   │   │   └── common.ts           # 跨平台初始化
│   │   ├── webview-ui/             # React Webview UI（Vite）
│   │   └── package.json
│   ├── vscode-rollout/             # 灰度发布
│   └── biome.json                  # Biome 代码规范（替代 ESLint+Prettier）
├── sdk/                            # SDK 工作区（@cline/* 包）
│   ├── packages/
│   │   ├── shared/                 # @cline/shared - 类型、schemas、hooks、extension 契约
│   │   ├── llms/                   # @cline/llms - Provider 适配、模型目录、gateway
│   │   ├── agents/                 # @cline/agents - AgentRuntime 无状态循环
│   │   └── core/                   # @cline/core - ClineCore 编排层（sessions/hub/cron/extensions/storage/telemetry）
│   ├── ARCHITECTURE.md             # SDK 架构权威文档
│   └── AGENTS.md                   # SDK 开发参考
├── docs/                           # 公开文档（.mdx）
│   ├── core-workflows/             # plan-and-act.mdx / checkpoints.mdx
│   ├── features/                   # subagents/auto-approve/auto-compact
│   ├── mcp/                        # mcp-overview.mdx
│   ├── sdk/                        # SDK 文档（architecture/guides/reference）
│   ├── customization/              # hooks/skills/plugins/cline-rules
│   ├── provider-config/            # anthropic/deepseek/openai/openrouter/qwen
│   └── cline-overview.mdx
├── evals/                          # 评估系统（contract/smoke/e2e 三层金字塔）
│   └── ARCHITECTURE.md
├── assets/                         # 图标
├── .clinerules/                    # Cline 自举规则文件（network/storage/sdk-migration 等）
├── .cline/skills/                  # Cline 自举 skill
├── package.json                    # Bun workspace 根
├── LICENSE                         # Apache-2.0
└── README.md
```

### 1.3 技术栈（依赖清单）

来自 [package.json](file:///d:/ai/linux教学一体/opensource-reference/cline/package.json)：

**核心运行时**：
- `bun@1.3.13`（workspace 包管理）
- `node >=22`
- `typescript ^5.9.3`
- `@biomejs/biome 2.4.5`（lint+format，统一替代 eslint+prettier）
- `vitest ^4.0.18`（单测）
- `husky ^9.1.7` + `lint-staged ^16.3.2`（pre-commit）
- `nanoid ^5.1.7`

**关键依赖**（从源码 import 推断）：
- `@anthropic-ai/sdk`、`openai`、`@google/genai`（多 Provider SDK）
- `@modelcontextprotocol/sdk`（MCP 官方 SDK）
- `protobufjs 7.5.8`（强制 override 版本，proto 序列化）
- `chokidar`（文件监听，McpHub 用）
- `fast-deep-equal`（连接 fingerprint 比对）
- `reconnecting-eventsource`（SSE 自动重连）
- `zod`（schema 校验，MCP settings、tool inputSchema）
- `commander`（CLI 子命令解析）
- `pino`（CLI 日志）
- `execa`（子进程封装，packages/execa.ts）
- `better-sqlite3`（trustedDependencies，cron/sessions 存储）
- `@agentclientProtocol/sdk`（ACP，对接 Neovim/Zed）
- `diff 8.0.4`（强制版本，diff 计算）

### 1.4 License 合规性

**Apache-2.0 ✅**，[LICENSE](file:///d:/ai/linux教学一体/opensource-reference/cline/LICENSE) 第 189 行 `Copyright 2026 Cline Bot Inc.`，与 tdsf-linux-desktop（假设同为宽松 License）兼容：

- ✅ 允许商业使用、修改、分发、再授权
- ✅ 允许作为闭源衍生产品的一部分
- ⚠️ 必须保留版权声明、专利声明、变更说明
- ⚠️ 不授予商标权（不能直接用 "Cline" 名号）

**借鉴策略**：
- 设计模式、API 形状、架构分层 → 完全可借鉴
- 大段源码直接复制 → 需在文件头注明 "Modified from Cline, Copyright 2026 Cline Bot Inc., Apache-2.0"
- 协议定义（proto）→ 可参考但建议重新设计

---

## 2. 整体架构图（文字版）

```
┌─────────────────────────────────────────────────────────────────────┐
│                       客户端层（Clients）                            │
├─────────────────────────────────────────────────────────────────────┤
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌──────────────┐  │
│  │ VS Code    │  │ CLI (TUI)  │  │ Cline Hub  │  │ JetBrains   │  │
│  │ Extension  │  │ OpenTUI    │  │ Web UI     │  │ Plugin      │  │
│  │ (React     │  │ (Bun)      │  │ (React)    │  │             │  │
│  │  Webview)  │  │            │  │            │  │             │  │
│  └─────┬──────┘  └─────┬──────┘  └─────┬──────┘  └──────┬──────┘  │
│        │                │                │                │         │
│        │ gRPC over      │ SDK            │ WebSocket      │ SDK     │
│        │ Webview postMessage │           │                │         │
└────────┼────────────────┼────────────────┼────────────────┼─────────┘
         │                │                │                │
         ▼                ▼                ▼                ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  @cline/core（编排层 / SDK）                         │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  ClineCore（主入口）                                            │ │
│  │  ├── RuntimeHost（local / hub / remote 三态）                  │ │
│  │  ├── SessionLifecycle                                          │ │
│  │  ├── SettingsService（文件 watcher + 状态机）                  │ │
│  │  ├── CronService（cron/event/one-off 自动化）                  │ │
│  │  ├── Telemetry（OpenTelemetry）                                │ │
│  │  ├── Plugin Loader（sandbox 化）                               │ │
│  │  ├── Compaction（basic / agentic）                             │ │
│  │  └── Extensions（rules/skills/workflows/agents/hooks watcher） │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────┬───────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│              @cline/agents（无状态 Agent 循环）                      │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  AgentRuntime                                                    │ │
│  │  ├── run / continue / abort / subscribe / restore / snapshot    │ │
│  │  ├── iteration loop（beforeModel→callModel→afterModel→          │ │
│  │  │                     beforeTool→execTool→afterTool）          │ │
│  │  ├── HookBag（beforeRun/afterRun/beforeModel/afterModel/        │ │
│  │  │           beforeTool/afterTool/onEvent）                     │ │
│  │  ├── Tool Registry（Map<name, AgentTool>）                     │ │
│  │  └── Completion Policy（lifecycle.completesRun）                │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────┬───────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│           @cline/llms（Provider 适配层）                             │
│  ┌────────────────────────────────────────────────────────────────┐ │
│  │  DefaultGateway / createGateway                                  │ │
│  │  ├── 50+ Provider handlers（Anthropic/OpenAI/Gemini/Bedrock/    │ │
│  │  │   Vertex/OpenRouter/Ollama/LM Studio/DeepSeek/Qwen/          │ │
│  │  │   Cerebras/Groq/Vercel AI Gateway/...）                      │ │
│  │  ├── Model Catalogs（bundled + live refresh）                   │ │
│  │  └── AI SDK backed execution                                    │ │
│  └────────────────────────────────────────────────────────────────┘ │
└─────────────────────────┬───────────────────────────────────────────┘
                          │
                          ▼
┌─────────────────────────────────────────────────────────────────────┐
│        @cline/shared（基础契约 / 零运行时依赖）                      │
│  Types, Schemas, Path helpers, HookEngine, ExtensionRegistry,        │
│  PromptParsers, BasicLogger, RemoteConfig schemas                    │
└─────────────────────────────────────────────────────────────────────┘

                          ╔═══════════════════════════════════════╗
                          ║       外部进程 / 系统                 ║
                          ╠═══════════════════════════════════════╣
                          ║  ┌─────────────────────────────────┐  ║
                          ║  │ MCP Servers (STDIO / HTTP/SSE)  │  ║
                          ║  │ - 通过 McpHub 启动/管理         │  ║
                          ║  │ - chokidar 监听配置文件变更     │  ║
                          ║  └─────────────────────────────────┘  ║
                          ║  ┌─────────────────────────────────┐  ║
                          ║  │ Hub Daemon (singleton)          │  ║
                          ║  │ - 127.0.0.1:25463 默认端口      │  ║
                          ║  │ - 持有 auth token (constant-time)║ ║
                          ║  │ - ~/.cline/locks/hub/owners/    │  ║
                          ║  └─────────────────────────────────┘  ║
                          ║  ┌─────────────────────────────────┐  ║
                          ║  │ Spoke Worker (per-session)      │  ║
                          ║  │ - 执行 Agent loop               │  ║
                          ║  │ - Process isolation from Hub    │  ║
                          ║  └─────────────────────────────────┘  ║
                          ║  ┌─────────────────────────────────┐  ║
                          ║  │ Connectors (Telegram/Slack/...) │  ║
                          ║  │ - 长连接，转发到 Hub            │  ║
                          ║  └─────────────────────────────────┘  ║
                          ╚═══════════════════════════════════════╝

                          ┌─────────────────────────────────────┐
                          │   存储层（File + SQLite）           │
                          ├─────────────────────────────────────┤
                          │ ~/.cline/                           │
                          │  ├── data/sessions/sessions.db      │ ← SQLite 索引
                          │  ├── data/sessions/[id].json        │ ← 权威会话记录
                          │  ├── data/teams/[team-name]/        │ ← task-board/mailbox/mission-log
                          │  ├── data/db/cron.db                │ ← 自动化任务队列
                          │  ├── data/plugins/_installed/       │ ← npm/git/remote/local
                          │  ├── mcp.json                       │ ← MCP 配置
                          │  ├── endpoints.json                 │ ← on-premise 端点
                          │  ├── skills/                        │ ← 全局 skills
                          │  ├── cron/                          │ ← 自动化 spec + reports
                          │  ├── locks/hub/owners/              │ ← Hub 发现锁
                          │  └── logs/hub-daemon.log            │ ← Hub 日志
                          │                                     │
                          │ <workspace>/                        │
                          │  ├── .cline/skills/                 │ ← 项目 skills
                          │  ├── .cline/plugins/                │ ← 项目 plugins
                          │  ├── .cline/cron/                   │ ← 项目 cron
                          │  ├── .clinerules/                   │ ← 规则文件
                          │  └── .clineignore                   │ ← 忽略规则
                          └─────────────────────────────────────┘
```

**关键通信路径**：
1. **Webview ↔ Extension Host**：Protobuf 二进制 over `postMessage`（VS Code Webview）或 gRPC（其他宿主）
2. **Client ↔ Hub**：WebSocket，`cline.*` 命令 + `cline.*` 事件流
3. **Hub ↔ Spoke**：Hub 内部进程通信，Spoke 执行 Agent loop
4. **Agent ↔ MCP Server**：STDIO / Streamable HTTP / SSE，由 McpHub 持有连接
5. **Agent ↔ Provider**：HTTPS，由 `@cline/llms` gateway 路由

---

## 3. plan-and-act 架构深度分析（核心）

### 3.1 Plan 模式实现

**核心定义**：见 [docs/core-workflows/plan-and-act.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/core-workflows/plan-and-act.mdx)

**Plan 模式约束**：
- ✅ 可用：`read_file` / `list_files` / `search_files` / `list_code_definition_names` / 只读 `execute_command` / `use_skill` / `ask_followup_question` / `web_fetch` / `web_search`
- ❌ 禁用：`write_to_file` / `replace_in_file` / `apply_patch` / 写入 `execute_command` / `browser_action` / MCP 写工具

**实现位置**：
- 模式枚举：[apps/vscode/src/shared/storage/types.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/shared/storage/types.ts) `Mode = "plan" | "act"`
- 模式切换 RPC：[apps/vscode/proto/cline/state.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/state.proto) `rpc togglePlanActModeProto(TogglePlanActModeRequest) returns (Boolean)`
- 工具开关：[sdk/packages/core/src/extensions/tools/definitions.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/core/src/extensions/tools/definitions.ts) 根据 `context.metadata.mode` 过滤工具

**Plan 模式专用工具**（[apps/vscode/src/shared/tools.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/shared/tools.ts)）：
```typescript
PLAN_MODE = "plan_mode_respond",  // Plan 模式专属响应
ACT_MODE = "act_mode_respond",    // Act 模式专属响应
```

**Plan 模式响应数据**（推断自 proto）：
- 用户在 Plan 模式下，Agent 输出只能用 `plan_mode_respond` 工具
- 输出包含：分析、计划、风险、所需文件列表

### 3.2 Act 模式实现

**Act 模式约束**：
- ✅ 可用：所有工具（含写文件、执行命令）
- ✅ 默认开启人工审批闸门（除 `ask_followup_question` / `web_fetch` 等只读工具 autoApprove）

**实现位置**：
- [apps/cli/src/runtime/run-agent.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cli/src/runtime/run-agent.ts) `config.mode === "act"` 时启用全部工具
- 模式由会话级别配置：[apps/cline-hub/src/server/sessions.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cline-hub/src/server/sessions.ts) 第 95 行 `const mode = options?.mode === "plan" ? "plan" : "act";`

### 3.3 Plan ↔ Act 切换机制

**核心机制**：
1. **会话级别配置**：`StartSessionInput.config.mode` 在会话启动时确定，存储于 `sessionMetadata.mode`
2. **切换通过 RPC**：`togglePlanActModeProto` 触发会话重建（[SdkController](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/sdk/SdkController.ts) 的 `SdkSessionRebuildScheduler`）
3. **历史保留**：切换时 conversation history 完整保留，Agent 上下文不丢失
4. **独立模型配置**：`plan_mode_api_model_id` 和 `act_mode_api_model_id` 可分别配置（见 [state.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/state.proto) 第 160-300 行）
5. **独立 thinking budget**：`plan_mode_thinking_budget_tokens` / `plan_mode_reasoning_effort` 独立配置

**配置示例**（来自 docs）：
| 用例 | Plan Mode | Act Mode |
|------|-----------|----------|
| 成本优化 | GLM 4.6（强推理） | Grok Code Fast（快） |
| 最高质量 | Claude Opus | Claude Sonnet |
| 速度优先 | Gemini 3 Flash | Cerebras |

### 3.4 借鉴建议：tdsf-linux-desktop 如何实现 plan-and-act

**核心建议**：
1. **会话级别 mode 字段**：在 `AgentSession` 类型中加 `mode: 'plan' | 'act'`，会话启动时确定
2. **工具白名单/黑名单**：Plan 模式工具黑名单 = `[write_file, replace_in_file, apply_patch, execute_command(writable), browser_action, mcp_write_*]`
3. **UI 切换按钮**：参考 Cline 的 togglePlanActModeProto，加 RPC `agent.toggleMode`
4. **独立 Provider 配置**：Plan/Act 模式可分别配置 modelId/providerId（运维场景：Plan 用 Qwen-Max 思考，Act 用 Qwen-Turbo 快速执行）
5. **强制审批闸门**：tdsf-linux-desktop 必须保持硬约束 —— Plan 模式只读，Act 模式每步人工审批（与硬约束 "运维 Agent 每步执行必须有人工审批闸门" 一致）

**关键代码模板**：
```typescript
type AgentMode = 'plan' | 'act'

interface AgentSessionConfig {
  mode: AgentMode
  planMode: { providerId: string; modelId: string; thinkingBudget?: number }
  actMode: { providerId: string; modelId: string; thinkingBudget?: number }
  // 工具策略，按模式过滤
  toolPolicies: Record<string, ToolPolicy>
}

function filterToolsByMode(tools: AgentTool[], mode: AgentMode): AgentTool[] {
  const PLAN_DISABLED = new Set(['write_to_file', 'replace_in_file', 'apply_patch', 'execute_command', 'browser_action'])
  return mode === 'plan' ? tools.filter(t => !PLAN_DISABLED.has(t.name)) : tools
}
```

---

## 4. 工具系统分析

### 4.1 工具清单（src/shared/tools.ts）

**完整工具枚举**（[apps/vscode/src/shared/tools.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/shared/tools.ts)）：

```typescript
export enum ClineDefaultTool {
  ASK = "ask_followup_question",       // 反问澄清
  ATTEMPT = "attempt_completion",       // 完成任务（含最终输出）
  BASH = "execute_command",             // 执行 shell 命令
  FILE_EDIT = "replace_in_file",        // 增量编辑文件（SEARCH/REPLACE 块）
  FILE_READ = "read_file",              // 读文件
  FILE_NEW = "write_to_file",           // 新建/覆写文件
  SEARCH = "search_files",              // regex 搜索文件内容
  LIST_FILES = "list_files",            // 列目录
  LIST_CODE_DEF = "list_code_definition_names", // 列类/函数/方法定义
  BROWSER = "browser_action",           // Puppeteer 浏览器操作
  MCP_USE = "use_mcp_tool",             // 调用 MCP 工具
  MCP_ACCESS = "access_mcp_resource",   // 访问 MCP 资源
  MCP_DOCS = "load_mcp_documentation",  // 加载 MCP 文档
  NEW_TASK = "new_task",                // 子任务委派
  PLAN_MODE = "plan_mode_respond",      // Plan 模式响应
  ACT_MODE = "act_mode_respond",        // Act 模式响应
  TODO = "focus_chain",                 // todo 列表管理
  WEB_FETCH = "web_fetch",              // 抓取网页
  WEB_SEARCH = "web_search",            // 网页搜索
  CONDENSE = "condense",                // 上下文压缩
  SUMMARIZE_TASK = "summarize_task",    // 任务总结
  REPORT_BUG = "report_bug",            // 报告 bug
  NEW_RULE = "new_rule",                // 创建规则文件
  APPLY_PATCH = "apply_patch",          // 应用 patch（统一 diff）
  USE_SKILL = "use_skill",              // 触发 skill
  USE_SUBAGENTS = "use_subagents",      // 启动 subagents 并行研究
}
```

**SDK 层工具**（[sdk/packages/core/src/extensions/tools/definitions.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/core/src/extensions/tools/definitions.ts)）使用 `createTool` 工厂：

```typescript
import { createTool, zodToJsonSchema, validateWithZod } from "@cline/shared"

const readFileTool = createTool({
  name: "read_files",
  description: "Read one or more files...",
  inputSchema: ReadFilesInputSchema,  // Zod schema → JSON Schema
  async execute(input, context) {
    return { content: await fs.readFile(input.path, 'utf-8') }
  },
  timeoutMs: 30000,  // 默认
  retryable: true,   // 默认
  maxRetries: 3,     // 默认
})
```

### 4.2 工具调用协议（tool_use API）

**协议**（[docs/sdk/reference/tools-api.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/sdk/reference/tools-api.mdx)）：

```typescript
interface AgentTool<TInput, TOutput> {
  name: string
  description: string
  inputSchema: Record<string, unknown>  // JSON Schema 或 Zod
  execute: (input: TInput, context: AgentToolContext, onChange?: (update) => void) => Promise<TOutput>
  timeoutMs?: number      // 默认 30000
  retryable?: boolean     // 默认 true
  maxRetries?: number     // 默认 3
  lifecycle?: { completesRun?: boolean }  // 完成标志
}

interface AgentToolContext {
  agentId: string
  conversationId: string
  sessionId: string
  runId: string
  toolCallId: string
  iteration: number
  abortSignal?: AbortSignal
  metadata?: Record<string, unknown>  // mode/source/cwd 等
}

interface ToolCallRecord {
  id: string
  name: string
  input: unknown
  output: unknown
  error?: string
  durationMs: number
  startedAt: Date
  endedAt: Date
}
```

**多 Provider tool 适配**（[apps/vscode/src/shared/tools.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/shared/tools.ts) 第 1-5 行）：
```typescript
import { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/index"
import { FunctionDeclaration as GoogleTool } from "@google/genai"
import { ChatCompletionTool as OpenAITool } from "openai/resources/chat/completions"
type ClineTool = OpenAITool | AnthropicTool | GoogleTool
```

同一工具定义自动适配 3 大 Provider 的 tool schema 格式。

### 4.3 工具权限控制（auto-approve）

**权限矩阵**（[docs/features/auto-approve.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/features/auto-approve.mdx)）：

| 设置 | 允许 |
|------|------|
| Read project files | 读、列、搜工作区内 |
| Read all files | 读工作区外（需 base 开启） |
| Edit project files | 创建/编辑工作区内 |
| Edit all files | 编辑工作区外（需 base 开启） |
| Execute safe commands | 安全命令（模型判定） |
| Execute all commands | 危险命令（需 base 开启） |
| Use the browser | Puppeteer 浏览器 |
| Use MCP servers | MCP 工具和资源 |
| Enable notifications | OS 通知 |

**ToolPolicy 数据结构**（[docs/sdk/reference/tools-api.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/sdk/reference/tools-api.mdx)）：
```typescript
interface ToolPolicy {
  enabled?: boolean       // 工具是否启用
  autoApprove?: boolean   // 是否自动批准（不需用户确认）
}
// 未列出的工具默认 enabled: true, autoApprove: true
```

**CLI 安全工具白名单**（[apps/cli/src/runtime/tool-policies.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cli/src/runtime/tool-policies.ts)）：
```typescript
const SAFE_AUTO_APPROVE_TOOL_NAMES = [
  "ask_followup_question",
  "ask_question",
  "fetch_web_content",
  "read_files",
  "search_codebase",
  "skills",
  "submit_and_exit",
]
```
这些工具默认 autoApprove，其他工具需要用户确认。

### 4.4 工具结果格式（tool_result）

**AgentMessagePart 类型**（推断自 [agent-runtime.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/agents/src/agent-runtime.ts) 第 360-376 行）：
```typescript
type AgentMessagePart =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "file"; content: string }  // base64 或路径
  | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
  | { type: "tool-result"; toolCallId: string; output: unknown; isError?: boolean }
```

工具结果通过 `tool-result` 消息附加到对话历史，模型在下一轮看到结果继续推理。

### 4.5 借鉴建议：tdsf-linux-desktop 的工具系统设计

**P0 必须借鉴**：
1. **createTool 工厂模式**：统一工具接口（name/description/inputSchema/execute/timeoutMs/retryable/maxRetries/lifecycle）
2. **Zod schema → JSON Schema**：用 Zod 定义入参，运行时校验 + 自动转 JSON Schema 给模型
3. **ToolPolicy 二级控制**：`enabled`（工具是否暴露给模型）+ `autoApprove`（是否跳过审批）
4. **安全工具白名单**：运维场景白名单应更严格 —— 只允许 `ask_question` / `read_file` / `web_fetch` 自动批准，所有写操作必须人工审批

**运维场景工具清单建议**：
```typescript
// 必备工具（P0）
- read_file              // 读配置/日志
- list_files             // 列目录
- search_files           // grep 日志
- execute_command        // 执行运维命令（强制审批）
- write_to_file          // 修改配置文件（强制审批 + diff 预览）
- replace_in_file        // 增量编辑（SEARCH/REPLACE 块）
- ask_followup_question  // 澄清需求
- attempt_completion     // 任务完成报告
- use_mcp_tool           // 调用 MCP（如监控、CMDB）
- web_fetch              // 抓文档
- use_skill              // 触发运维 skill（nginx/mysql/docker 等）

// 运维特有工具（P0）
- sftp_upload            // 文件上传（基于 SftpManager）
- sftp_download          // 文件下载
- service_control        // systemctl start/stop/restart
- package_manage         // apt/yum/dnf install
- log_tail               // tail -f 实时日志
- port_check             // 端口检查
- process_list           // ps 进程列表
- firewall_rule          // 防火墙规则
- cron_manage            // crontab 管理
```

**关键代码模板**：
```typescript
const executeCommandTool = createTool({
  name: 'execute_command',
  description: 'Execute a shell command on the remote server via SFTP/SSH',
  inputSchema: z.object({
    command: z.string().describe('The shell command to execute'),
    cwd: z.string().optional().describe('Working directory'),
    timeout: z.number().optional().default(30000).describe('Timeout in ms'),
  }),
  async execute(input, context) {
    // 强制审批：运维硬约束
    const approval = await requestHumanApproval({
      command: input.command,
      riskLevel: assessRisk(input.command),  // rm/mkfs/dd → high
      cwd: input.cwd,
    })
    if (!approval.approved) {
      return { error: 'User rejected', reason: approval.reason }
    }
    // 通过 SftpManager 执行
    const result = await sftpManager.execute(input.command, input.cwd)
    return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code }
  },
  lifecycle: { completesRun: false },
  timeoutMs: 30000,
  retryable: false,  // 运维命令不可重试
})
```

---

## 5. MCP 集成

### 5.1 McpHub 实现（src/services/mcp/McpHub.ts）

**核心文件**：[apps/vscode/src/services/mcp/McpHub.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/services/mcp/McpHub.ts)

**关键能力**：

1. **三种传输协议**：
   - `STDIO`：本地子进程，低延迟
   - `Streamable HTTP`（推荐）：远程端点，支持多客户端
   - `SSE`（legacy）：旧版兼容

2. **配置文件监听**（chokidar）：
   - 配置文件路径：`~/.cline/` 下 `cline_mcp_settings.json`
   - 监听策略：`awaitWriteFinish.stabilityThreshold: 100ms`，`atomic: true`
   - **指纹防抖**（[McpHub.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/services/mcp/McpHub.ts) 第 62-83 行 `lastConnectionFingerprint`）：基于内容（非写入者）的指纹，避免自身写入触发重连循环
   - 支持 OAuth token 变更感知

3. **进程管理**：
   - `connections: McpConnection[]` 数组持有所有 MCP 连接
   - `isConnecting` 标志避免并发连接
   - 每个连接有独立 `McpOAuthManager`
   - 服务器短 ID（`c` + 5 字符 nanoid）避免 tool name 过长

4. **Schema 校验**（Zod）：
   - `BaseConfigSchema` / `ServerConfigSchema` / `McpSettingsSchema`
   - 校验失败时显示友好错误（按 server 名分组 issues）

5. **配置示例**：
```json
{
  "mcpServers": {
    "local-server": {
      "command": "node",
      "args": ["/path/to/server.js"],
      "env": { "API_KEY": "your_api_key" },
      "disabled": false,
      "autoApprove": []
    },
    "remote-server": {
      "type": "streamableHttp",
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer your-token" },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

6. **环境变量展开**：`${env:VAR_NAME}` 语法在 URL/headers/env 中自动展开（[utils/envExpansion.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/utils/envExpansion.ts)）

### 5.2 MCP 协议适配

**Proto 定义**（[apps/vscode/proto/cline/mcp.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/mcp.proto)）：
```protobuf
service McpService {
  rpc toggleMcpServer(ToggleMcpServerRequest) returns (McpServers);
  rpc updateMcpTimeout(UpdateMcpTimeoutRequest) returns (McpServers);
  rpc addRemoteMcpServer(AddRemoteMcpServerRequest) returns (McpServers);
  rpc restartMcpServer(StringRequest) returns (McpServers);
  rpc deleteMcpServer(StringRequest) returns (McpServers);
  rpc toggleToolAutoApprove(ToggleToolAutoApproveRequest) returns (McpServers);
  rpc openMcpSettings(EmptyRequest) returns (Empty);
  rpc authenticateMcpServer(StringRequest) returns (Empty);
  rpc getLatestMcpServers(Empty) returns (McpServers);
  rpc subscribeToMcpServers(EmptyRequest) returns (stream McpServers);
}

message McpServer {
  string name = 1;
  string config = 2;
  McpServerStatus status = 3;        // DISCONNECTED / CONNECTED / CONNECTING
  optional string error = 4;
  repeated McpTool tools = 5;
  repeated McpResource resources = 6;
  repeated McpResourceTemplate resource_templates = 7;
  optional bool disabled = 8;
  optional int32 timeout = 9;
  optional bool oauth_required = 10;
  optional string oauth_auth_status = 11;
  repeated McpPrompt prompts = 12;
}
```

**工具调用桥接**：Agent 通过 `use_mcp_tool` 工具调用 MCP server 暴露的工具，McpHub 路由到对应连接。

### 5.3 借鉴建议：tdsf-linux-desktop 的 MCP 集成方式

**P0 必须借鉴**：
1. **McpHub 单例模式**：全局一个 McpHub 管理所有 MCP 连接，避免连接泄漏
2. **配置文件 + chokidar 监听**：用户可在 `~/.tdsf/mcp.json` 编辑配置，UI 实时反映
3. **指纹防抖**：避免自身写入触发重连循环（Cline 用 `lastConnectionFingerprint` 解决）
4. **三种传输协议**：STDIO（本地）/ Streamable HTTP（远程）/ SSE（legacy）
5. **OAuth 支持**：远程 MCP server 可走 OAuth
6. **工具发现动态注入**：McpHub 发现新工具 → 通知 Agent 重建会话工具列表

**运维场景 MCP 应用**：
```json
{
  "mcpServers": {
    "prometheus": {
      "type": "streamableHttp",
      "url": "http://prometheus:9090/mcp",
      "autoApprove": ["query_metrics", "list_alerts"]
    },
    "ansible": {
      "command": "python",
      "args": ["-m", "ansible_mcp_server"],
      "autoApprove": []  // 所有操作需审批
    },
    "kubernetes": {
      "command": "kubectl-mcp",
      "args": ["--kubeconfig", "${env:KUBECONFIG}"],
      "autoApprove": ["get_pods", "describe_pod"]
    }
  }
}
```

**关键实现细节**：
```typescript
class TdsfMcpHub {
  private connections: McpConnection[] = []
  private lastFingerprint?: string
  
  // 文件监听用 chokidar
  private watcher = chokidar.watch(configPath, {
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 100 },
    atomic: true,
  })
  
  // 工具列表变化通知 Agent 重建
  private toolListChangeCallback?: () => void
  
  async callTool(serverName: string, toolName: string, input: unknown) {
    const conn = this.connections.find(c => c.server.name === serverName)
    if (!conn) throw new Error(`MCP server ${serverName} not connected`)
    
    // 检查 autoApprove
    const isAuto = conn.server.autoApprove?.includes(toolName)
    if (!isAuto) {
      // 运维场景：所有 MCP 工具调用必须人工审批（硬约束）
      await requestHumanApproval({ serverName, toolName, input })
    }
    
    return conn.client.callTool(toolName, input)
  }
}
```

---

## 6. VS Code 扩展机制

### 6.1 Extension 入口（src/extension.ts）

**核心文件**：[apps/vscode/src/extension.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/extension.ts)

**activate() 流程**（第 67-564 行）：

1. **HostProvider 初始化**（setupHostProvider）：
   - 注册 Webview/DiffView/EditPreview/CommentReview 工厂
   - 注入 `vscodeHostBridgeClient`（gRPC client）
   - 配置 `getCallbackUrl`（OAuth 回调）和 `getBinaryLocation`（ripgrep 二进制）

2. **遗留存储清理**（cleanupLegacyVSCodeStorage）：
   - `cleanupOldApiKey` / `migrateCustomInstructionsToGlobalRules` / `migrateTaskHistoryToFile` 等
   - 一次性迁移，从 VSCode 原生 storage → 共享文件存储（~/.cline/data/）

3. **导出 VSCode storage 到共享文件**（exportVSCodeStorageToSharedFiles）：
   - 让所有平台（VSCode/CLI/JetBrains）统一从 `~/.cline/data/` 读取

4. **公共初始化**（initialize）：
   - 注册跨平台服务（CLI/VSCode 共用）

5. **VSCode 专属服务注册**：
   - `HookDiscoveryCache`（hooks 文件监听 + 缓存）
   - `WebviewProvider` 注册（`vscode.window.registerWebviewViewProvider`，`retainContextWhenHidden: true`）
   - DiffView/EditPreview 内容提供者（`TextDocumentContentProvider`）
   - URI Handler（`vscode://` 协议，OAuth 回调）
   - Terminal 命令（`addSelectedTerminalOutputToChat`）
   - CodeActionProvider（Add/Explain/Improve/Fix with Cline）
   - Jupyter Notebook 命令
   - Walkthrough 命令
   - Git Commit Message 生成器
   - Secrets 监听（跨窗口登录同步）

**命令清单**（[registry.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/registry.ts) 的 `ExtensionRegistryInfo.commands`）：
- PlusButton / McpButton / MarketplaceButton / SettingsButton / HistoryButton / AccountButton / WorktreesButton
- AddToChat / FixWithCline / ExplainCode / ImproveCode / FocusChatInput
- JupyterGenerateCell / JupyterExplainCell / JupyterImproveCell
- Walkthrough / GenerateCommit / AbortCommit / TerminalOutput

### 6.2 Webview 通信（proto 协议）

**Proto 文件清单**（18 个 cline.* + 5 个 host.* = 23 个）：

**cline/** 目录：
| Proto | 职责 |
|-------|------|
| [account.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/account.proto) | 账户管理 |
| [browser.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/browser.proto) | 浏览器操作 |
| [checkpoints.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/checkpoints.proto) | 检查点 |
| [commands.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/commands.proto) | 命令 |
| [common.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/common.proto) | 公共类型（Empty/EmptyRequest/Metadata/String/StringRequest/Int64/Boolean...） |
| [file.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/file.proto) | 文件操作 |
| [hooks.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/hooks.proto) | Hooks |
| [marketplace.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/marketplace.proto) | 插件市场 |
| [mcp.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/mcp.proto) | MCP 管理 |
| [models.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/models.proto) | 模型列表 |
| [oca_account.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/oca_account.proto) | OCA 账户 |
| [remote_config.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/remote_config.proto) | 远程配置 |
| [slash.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/slash.proto) | Slash 命令 |
| [state.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/state.proto) | **状态管理 + Plan/Act 切换 + AutoApproval + Secrets + Settings** |
| [task.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/task.proto) | **任务管理 + 历史记录 + 反馈** |
| [ui.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/ui.proto) | UI 交互 |
| [web.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/web.proto) | Web 浏览器 |
| [worktree.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/worktree.proto) | Git worktree |

**host/** 目录：
| Proto | 职责 |
|-------|------|
| [diff.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/host/diff.proto) | Diff 视图 |
| [env.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/host/env.proto) | 环境信息 |
| [testing.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/host/testing.proto) | 测试 |
| [window.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/host/window.proto) | **窗口/编辑器/通知/对话框/文件选择** |
| [workspace.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/host/workspace.proto) | 工作区 |

**核心 RPC 示例**（[task.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/task.proto)）：
```protobuf
service TaskService {
  rpc cancelTask(EmptyRequest) returns (Empty);
  rpc cancelQueuedPrompt(StringRequest) returns (Empty);
  rpc cancelBackgroundCommand(EmptyRequest) returns (Empty);
  rpc proceedWhileRunningCommand(EmptyRequest) returns (Empty);
  rpc clearTask(EmptyRequest) returns (Empty);
  rpc getTotalTasksSize(EmptyRequest) returns (Int64);
  rpc deleteTasksWithIds(StringArrayRequest) returns (Empty);
  rpc newTask(NewTaskRequest) returns (String);
  rpc showTaskWithId(StringRequest) returns (TaskResponse);
  rpc exportTaskWithId(StringRequest) returns (Empty);
  rpc toggleTaskFavorite(TaskFavoriteRequest) returns (Empty);
  rpc getTaskHistory(GetTaskHistoryRequest) returns (TaskHistoryArray);
  rpc askResponse(AskResponseRequest) returns (Empty);
  rpc editMessageAndRegenerate(EditMessageAndRegenerateRequest) returns (Empty);
  rpc taskFeedback(StringRequest) returns (Empty);
  rpc executeQuickWin(ExecuteQuickWinRequest) returns (Empty);
  rpc deleteAllTaskHistory(EmptyRequest) returns (DeleteAllTaskHistoryCount);
}
```

**通信机制**：
- **VSCode**：通过 webview `postMessage` 传输 protobuf 二进制
- **其他宿主**：通过 gRPC over WebSocket（[hosts/vscode/hostbridge/client/host-grpc-client.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/hosts/vscode/hostbridge/client/host-grpc-client.ts)）

**Protobuf vs JSON 选择**：
- ✅ Protobuf 优势：二进制紧凑（节省 30-50% 带宽）、强类型、跨语言、字段向后兼容
- ❌ JSON 优势：调试友好、生态成熟
- Cline 选择 protobuf 的原因：webview ↔ extension host 频繁通信（流式 token、tool 调用），二进制能显著降低开销；同时复用 gRPC 工具链（descriptor_set.pb 用于反射）

### 6.3 文件系统接入（workspace.fs）

**接入方式**：
- VSCode 原生 `vscode.workspace.fs` API
- 抽象到 `HostProvider.workspace` 接口
- 工具实现：[utils/fs.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/utils/fs.ts) 提供 `fileExistsAtPath` / `isDirectory` / `readFile` 等
- 多根工作区支持：[core/workspace/WorkspaceRootManager](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/core/workspace/) （`WorkspaceRoot` 数组）
- 多根 mention 搜索：[core/mentions/index.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/core/mentions/index.ts) 第 150-170 行 `Promise.all(workspaceRoots.map(...))` 并行搜索

### 6.4 Terminal 接入（window.createTerminal）

**接入方式**：
- VSCode 原生 `vscode.window.createTerminal` / `window.onDidWriteTerminalData`
- 抽象到 `HostProvider.terminal` / [hosts/vscode/terminal/VscodeTerminalManager](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/hosts/vscode/terminal/VscodeTerminalManager.ts)
- 终端复用：`updateTerminalReuseEnabled` RPC 控制
- 终端连接超时：`updateTerminalConnectionTimeout` RPC
- 终端输出捕获：`TerminalOutput` 命令通过 `workbench.action.terminal.copySelection` 拷贝到剪贴板再读回（第 220-260 行）
- 后台命令模式：`proceedWhileRunningCommand` 让命令继续运行，Agent 拿到部分输出 + 日志路径

### 6.5 Editor 接入（TextDocument / TextEditor）

**接入方式**：
- `vscode.window.activeTextEditor` / `visibleTextEditors` / `vscode.workspace.openTextDocument`
- 通过 [host/window.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/host/window.proto) 的 `WindowService` 抽象：
  - `showTextDocument` / `openFile` / `getOpenTabs` / `getVisibleTabs` / `getActiveEditor`
- Diff 视图：`TextDocumentContentProvider` + 自定义 URI scheme（`DIFF_VIEW_URI_SCHEME`）
- Edit Preview：`EDIT_PREVIEW_URI_SCHEME` 模拟流式编辑动画
- CodeActionProvider：注册 `QuickFix` / `RefactorExtract` / `RefactorRewrite` kind，提供 Add/Explain/Improve/Fix with Cline

### 6.6 借鉴建议：tdsf-linux-desktop 用 @monaco-editor/react + IPC 模拟 VS Code 扩展机制

**P0 必须借鉴**：
1. **HostProvider 抽象**：将 IDE 能力（workspace/window/terminal/editor）抽象为接口，多宿主共用 Agent Core
2. **Diff 视图机制**：用 Monaco DiffEditor 实现文件变更预览，左只读右可编辑
3. **CodeActionProvider 思路**：Monaco editor action 提供 "Explain/Improve/Fix with Agent" 右键菜单
4. **Terminal 集成**：用 xterm.js + SftpManager.exec 模拟，保留 `proceedWhileRunningCommand`（运维场景常见 —— 长跑命令如 `tail -f`）
5. **多根工作区**：运维场景天然多服务器，可借鉴 `WorkspaceRoot[]` 设计

**tdsf-linux-desktop 实施建议**：
```typescript
// Electron 主进程侧（main）
class TdsfHostProvider {
  workspace = {
    async readFile(path: string) { return sftpManager.readFile(path) },
    async writeFile(path: string, content: string) { /* 强制审批 */ },
    async listFiles(dir: string) { return sftpManager.readdir(dir) },
    async openInFileExplorerPanel(path: string) { /* IPC to renderer */ },
  }
  
  window = {
    async showMessage({ type, message, options }) { /* IPC 弹窗 */ },
    async showInputBox({ title, prompt }) { /* IPC 输入框 */ },
    async showOpenDialogue({ canSelectMany }) { /* IPC 文件选择 */ },
  }
  
  terminal = {
    async createTerminal(opts) { /* 创建 xterm.js 实例 */ },
    async sendText(terminal, text) { /* SFTP exec */ },
  }
  
  editor = {
    async showTextDocument(path, options) { /* IPC 打开 Monaco */ },
    async getActiveEditor() { /* 当前 Monaco tab */ },
    async getOpenTabs() { /* Monaco tab 列表 */ },
  }
}

// 渲染进程侧（renderer）通过 IPC 接收 HostProvider 调用
// 协议可用 JSON（开发期）或 Protobuf（性能瓶颈时）
```

---

## 7. Context Management

### 7.1 @mention 系统（src/core/mentions/）

**核心文件**：[apps/vscode/src/core/mentions/index.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/core/mentions/index.ts)

**支持的 mention 类型**（第 67-92 行）：

| Mention 语法 | 含义 | 注入内容 |
|--------------|------|----------|
| `@/path/to/file` | 工作区内文件 | `<file_content path="...">` |
| `@/path/to/folder/` | 工作区内目录（尾斜杠） | `<folder_content path="...">` |
| `@http://url` | 网页 URL | `<url_content url="...">` markdown |
| `@problems` | 工作区诊断 | `Workspace Problems (see below...)` |
| `@terminal` | 终端输出 | `Terminal Output (see below...)` |
| `@git-changes` | git 工作区变更 | `Working directory changes` |
| `@[commit-hash]` | git commit | `Git commit '...'` |

**多根工作区搜索**（第 150-200 行）：
- 多个工作区时，并行 `Promise.all(workspaceRoots.map(...))` 搜索
- 命中 1 个：附加单条 `<file_content path="..." workspace="...">`
- 命中多个：每个 workspace 独立 `<file_content>` 标签
- 全部未命中：错误信息列出搜索过的 workspace 名

**安全保护**（第 117-119 行）：
- 跳过 `@/`（裸斜杠），避免扫描整个项目根目录导致上下文爆炸
- 提示：如需根目录扩展，应显式语法（如 `@root`）+ 严格大小/.clineignore 限制

**FileContextTracker**（第 191 行）：
- 每次文件 mention 时调用 `fileContextTracker.trackFileContext(mentionPath, "file_mentioned")`
- 用于追踪 Agent 上下文中的文件来源（mentioned / read / edited）

### 7.2 file context 注入

**注入流程**（[core/mentions/index.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/core/mentions/index.ts) `parseMentions`）：
1. 正则匹配 `mentionRegexGlobal` 提取所有 mention
2. 占位替换：`@/file` → `'file' (see below for file content)`
3. 收集 unique mentions
4. 并行获取内容（URL 走 UrlContentFetcher/Puppeteer，文件走 fs.readFile）
5. 附加到 parsedText 末尾：`<file_content path="...">...</file_content>`

**支持的特殊内容**：
- 二进制文件检测（`isbinaryfile` 库）
- 大文件截断（`MAX_READ_OUTPUT_CHARS`）
- 文件夹列出（含 `.clineignore` 过滤）
- Git commit 信息（`getCommitInfo` / `getWorkingState`）

### 7.3 .clinerules 规则系统

**核心文件**：[apps/vscode/src/shared/cline-rules.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/shared/cline-rules.ts)
```typescript
export type ClineRulesToggles = Record<string, boolean> // filepath -> enabled/disabled
```

**规则类型**（[docs/customization/cline-rules.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/customization/cline-rules.mdx)）：

| 规则类型 | 位置 | 自动检测 |
|---------|------|---------|
| Cline Rules | `.clinerules/` | ✅ |
| Cursor Rules | `.cursorrules` | ✅ |
| Windsurf Rules | `.windsurfrules` | ✅ |
| AGENTS.md | `AGENTS.md` / `~/.agents/AGENTS.md` | ✅ 跨工具标准 |

**存储位置**：
- 工作区：`.clinerules/*.md`（版本控制共享）
- 全局：`Documents/Cline/Rules/`（个人偏好）

**条件规则**（YAML frontmatter）：
```yaml
---
paths:
  - "src/components/**"
  - "src/hooks/**"
---
# React Component Guidelines
- Use functional components with React hooks
```

- 当用户编辑匹配 `paths` glob 的文件时，规则自动激活
- 评估依据：用户消息中的文件路径 + 打开的 tab + 可见文件 + 已编辑文件 + 待编辑文件
- 无 frontmatter → 始终激活
- 空 `paths: []` → 永不激活（临时禁用）
- YAML 解析失败 → fail open（规则激活但显示原始内容辅助调试）

### 7.4 Auto-compact 机制

**核心实现**：[sdk/packages/core/src/extensions/context/compaction.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/core/src/extensions/context/compaction.ts)

**两种策略**：
1. **basic**：基于规则的截断（保留最近 N tokens + 工具结果摘要）
2. **agentic**：用 LLM 生成结构化摘要（保留技术细节、代码变更、决策）

**触发条件**：
- `COMPACTION_TRIGGER_RATIO`（默认 0.8）：当请求 token 数 ≥ maxInputTokens × ratio 时触发
- 自动选择 `LONG_CONVERSATION_TARGET_RATIO = 0.5`（长对话目标压缩到 50%）

**核心数据流**（[extensions/context/compaction.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/core/src/extensions/context/compaction.ts) 第 33-57 行 `ContextPipelinePrepareTurn`）：
1. `prepareTurn` 钩子在每次模型调用前触发
2. 估算 messages token（`estimateRequestInputTokens`）
3. 若超阈值，调用 `runBasicCompaction` 或 `runAgenticCompaction`
4. 返回新的 messages + systemPrompt，Agent 用投影后的对话继续

**保留策略**：
- `DEFAULT_PRESERVE_RECENT_TOKENS`：保留最近的 token 数（默认值）
- 工具结果可被摘要替代（`summarizeToolResults` 统计 tool result 字符数）
- 压缩状态独立存储：`${sessionId}.compaction.json`（与权威 transcript 分离）

**会话恢复**（[sdk/packages/core/src/session/models/session-compaction.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/core/src/session/models/session-compaction.ts)）：
- resume 时加载 canonical transcript（用于历史/调试）
- 若存在 compaction state，验证 hash 后复用
- 失败 fallback：best-effort 重做 compaction

### 7.5 借鉴建议：tdsf-linux-desktop 的 @命令 8 类注入借鉴

**tdsf 运维场景 8 类 @ 命令建议**：

| @ 命令 | 含义 | 实现 |
|--------|------|------|
| `@/path/to/file` | 远程文件内容 | sftpManager.readFile |
| `@/path/to/folder/` | 远程目录列表 | sftpManager.readdir |
| `@log:/var/log/nginx/access.log` | 远程日志（tail 默认 200 行） | sftpManager.tail |
| `@service:nginx` | 服务状态 | systemctl status nginx |
| `@process:python` | 进程列表 | ps aux \| grep python |
| `@port:8080` | 端口占用 | netstat / ss |
| `@disk:/` | 磁盘使用 | df -h / |
| `@metric:cpu` | 监控指标 | Prometheus MCP 查询 |

**实现模板**：
```typescript
const mentionParsers: Record<string, (arg: string) => Promise<string>> = {
  '/': parseFileMention,
  'log:': parseLogMention,
  'service:': parseServiceMention,
  'process:': parseProcessMention,
  'port:': parsePortMention,
  'disk:': parseDiskMention,
  'metric:': parseMetricMention,
}

async function parseMentions(text: string, ctx: AgentContext): Promise<string> {
  const mentions = extractMentions(text)
  let enriched = text
  for (const mention of mentions) {
    const [type, arg] = matchMentionType(mention)
    const parser = mentionParsers[type]
    if (parser) {
      const content = await parser(arg)
      enriched += `\n\n<${type}_content ${type}="${arg}">\n${content}\n</${type}_content>`
    }
  }
  return enriched
}
```

---

## 8. Checkpointing / Undo 机制

### 8.1 实现原理

**核心文档**：[docs/core-workflows/checkpoints.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/core-workflows/checkpoints.mdx)

**机制**：影子 Git 仓库（shadow git repository）
- 独立于项目主 git 仓库
- 每次工具调用后（文件编辑/命令执行），自动 commit 当前文件快照
- 主仓库历史不被污染

**优势**：
- ✅ 主 Git 历史保持干净
- ✅ 捕获所有文件（含 .gitignore 排除的）
- ✅ 可独立回滚到任意检查点
- ✅ 持久化跨编辑器会话

### 8.2 数据结构

**核心实现**：[sdk/packages/core/src/session/checkpoint-restore.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/core/src/session/checkpoint-restore.ts)

```typescript
interface CheckpointEntry {
  ref: string         // git ref（commit hash 或 stash ref）
  createdAt: number   // 创建时间戳
  runCount: number    // 第几个 user run（用于对齐消息）
  kind?: "stash" | "commit"
}

interface CheckpointMetadata {
  latest: CheckpointEntry
  history: CheckpointEntry[]
}

// 存储于 session.metadata.checkpoint
interface SessionRecord {
  metadata: {
    checkpoint?: CheckpointMetadata
  }
}
```

**关键函数**：
- `readSessionCheckpointHistory(session)`：从 session.metadata 读取检查点历史
- `findCheckpointForRun(history, runCount)`：找到 ≤ runCount 的最新检查点
- `trimMessagesToCheckpoint(messages, runCount)`：截断消息到检查点
- `createCheckpointRestorePlan({ session, checkpointRunCount, cwd })`：构建恢复计划

### 8.3 三种恢复选项

| 选项 | 行为 | 适用场景 |
|------|------|----------|
| Restore Files | 仅回滚文件到快照 | 代码改坏但对话有价值 |
| Restore Task Only | 仅删除后续消息，不动文件 | 想换 prompt 但保留代码 |
| Restore Files & Task | 文件 + 消息全回滚 | 完全重置到检查点 |

### 8.4 借鉴建议：tdsf-linux-desktop 的回滚机制

**P1 建议借鉴**：
1. **影子 git 仓库**：运维场景对配置文件修改频繁，每次 Agent 改动前自动快照
2. **runCount 对齐消息**：用户消息编号 + 检查点编号对齐，便于"回到第 N 次对话"
3. **三种恢复选项**：运维场景必备 —— 文件改坏 / 想换指令 / 完全重置
4. **bash 操作的回滚**：Cline 只回滚文件，不回滚 bash 命令。运维场景需扩展 —— 记录 `systemctl stop nginx` 的反向操作 `systemctl start nginx`，提示用户回滚命令

**tdsf 实施建议**：
```typescript
class TdsfCheckpointManager {
  private shadowGit = path.join(os.homedir(), '.tdsf', 'checkpoints', workspaceId)
  
  async snapshot(runCount: number, description: string): Promise<CheckpointEntry> {
    // 1. 影子 git add + commit
    await this.execGit(['add', '-A'])
    const ref = await this.execGit(['commit', '-m', `run-${runCount}: ${description}`])
    
    // 2. 记录到 session metadata
    const entry = { ref, createdAt: Date.now(), runCount, kind: 'commit' as const }
    session.metadata.checkpoint.history.push(entry)
    await this.persistSession(session)
    return entry
  }
  
  async restore(checkpoint: CheckpointEntry, mode: 'files' | 'task' | 'both') {
    if (mode === 'files' || mode === 'both') {
      await this.execGit(['checkout', checkpoint.ref, '--', '.'])
    }
    if (mode === 'task' || mode === 'both') {
      // 截断消息历史
      session.messages = trimMessagesToCheckpoint(session.messages, checkpoint.runCount)
    }
  }
  
  // 运维扩展：记录反向命令
  async recordReverseCommand(forward: string, reverse: string) {
    session.metadata.reverseCommands.push({ forward, reverse, ts: Date.now() })
  }
}
```

---

## 9. Subagents 系统

### 9.1 Subagent 定义格式

**核心文档**：[docs/features/subagents.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/features/subagents.mdx)

**特性**：
- 实验性功能，默认启用
- 通过 `use_subagents` 工具触发
- 每个 subagent 独立 prompt + context window + token budget
- 并行运行，独立计费（token + cost 跟踪到任务总成本）

**工具白名单**（read-only 研究代理）：
| 工具 | 用途 |
|------|------|
| `read_file` | 读文件 |
| `list_files` | 列目录 |
| `search_files` | regex 搜索 |
| `list_code_definition_names` | 列类/函数/方法 |
| `execute_command` | 只读命令（`ls`/`grep`/`git log`/`git diff`） |
| `use_skill` | 加载 skill |

**禁止**：写文件 / browser / MCP / 嵌套 subagent

**返回**：聚焦"主 Agent 下一步应读哪些文件路径"

### 9.2 调度机制

**SDK 层实现**：[sdk/packages/core/src/extensions/tools/team/](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/core/src/extensions/tools/team/)
- `delegated-agent.ts` - 委派代理
- `multi-agent.ts` - 多代理协调
- `spawn-agent-tool.ts` - spawn 工具
- `subagent-prompts.ts` - 子代理 prompt 模板
- `team-tools.ts` - 团队工具集
- `configured-agent-config.ts` / `configured-agent-tool.ts` - 配置化代理

**Multi-Agent Teams**（更高层级，[docs/sdk/guides/multi-agent-teams.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/sdk/guides/multi-agent-teams.mdx)）：

| 特性 | Sub-Agents | Teams |
|------|-----------|-------|
| 启用 | `enableSpawnAgent: true` | `enableAgentTeams: true` |
| 持久化 | 仅会话内 | 跨会话 |
| 协调 | 父子 | peer-to-peer + 任务板 |
| 共享状态 | 无 | task-board.json / mailbox.json / mission-log.json |
| 适用 | 一次性委派 | 复杂多会话项目 |

**Teams 工具**：
| 工具 | 描述 |
|------|------|
| `team_spawn_teammate` | 创建新代理（指定角色 + 任务） |
| `team_delegate_task` | 委派任务给已有 teammate |
| `team_check_status` | 检查委派任务状态 |
| `team_get_result` | 获取已完成任务结果 |

**Teams 持久化**：
```
~/.cline/data/teams/[team-name]/
  task-board.json      # 当前任务和状态
  mailbox.json         # 代理间消息
  mission-log.json     # 团队活动历史
```

### 9.3 借鉴建议：对比 tdsf-linux-desktop 的 .claude/agents/ 模式

**P2 可选借鉴**：
- 运维场景多代理协调有价值，例如：1 个 Coordinator + 多个 Specialist（nginx-expert / mysql-expert / docker-expert）
- 但 tdsf-linux-desktop 已有 `.claude/agents/` 模式（Claude Code 风格），需评估是否引入 Teams 持久化机制

**建议**：
1. **优先用 Subagents**（轻量）：并行查多台服务器日志、并行检查多个服务状态
2. **暂不引入 Teams**：运维场景通常是单会话内任务，Teams 的跨会话持久化收益不大
3. **如需引入**：参考 Cline 的 `~/.cline/data/teams/` 目录结构，运维场景可扩展为 `~/.tdsf/teams/[incident-id]/` 关联 incident

---

## 10. Skills / Plugins / Hooks

### 10.1 Skills 系统

**核心文档**：[docs/customization/skills.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/customization/skills.mdx)
**核心代码**：[apps/vscode/src/shared/skills.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/shared/skills.ts)

**渐进加载**（核心设计）：

| 层级 | 加载时机 | Token 成本 | 内容 |
|------|----------|-----------|------|
| Metadata | 启动时（始终） | ~100 tokens/skill | YAML frontmatter 的 `name` + `description` |
| Instructions | skill 触发时 | <5k tokens | SKILL.md body |
| Resources | 按需 | 无限 | docs/ / templates/ / scripts/ 引用文件 |

**目录结构**：
```
my-skill/
├── SKILL.md          # 必需：主指令
├── docs/             # 可选：扩展文档
├── templates/        # 可选：配置模板
└── scripts/          # 可选：工具脚本
```

**SKILL.md 格式**：
```markdown
---
name: my-skill
description: Brief description. Use when [trigger phrases].
---

# My Skill

## Steps
1. First, do this
2. Then do that
3. For advanced usage, see [advanced.md](docs/advanced.md)
```

**存储位置**：
- 项目级：`.cline/skills/` / `.clinerules/skills/` / `.claude/skills/` / `.agents/skills/`
- 全局级：`~/.cline/skills/`（macOS/Linux） / `C:\Users\USERNAME\.cline\skills\`（Windows）
- 冲突时全局优先

**触发方式**：
1. **自动触发**：用户消息匹配 description 时，Agent 调用 `use_skill` 工具
2. **Slash 命令**：输入 `/skill-name` 显式触发
3. **UI 切换**：每个 skill 有 toggle，可禁用而不删除

**SkillMetadata 类型**（[shared/skills.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/shared/skills.ts)）：
```typescript
interface SkillMetadata {
  name: string
  description: string
  path: string
  source: "global" | "project"
}
interface SkillContent extends SkillMetadata {
  instructions: string
}
```

### 10.2 Plugins 系统

**核心文档**：[docs/customization/plugins.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/customization/plugins.mdx)

**注意**：Plugins 仅适用于 Cline SDK / CLI / Kanban，**不适用于 VSCode 和 JetBrains Extension**。

**Plugin Manifest**（package.json `cline` 字段）：
```json
{
  "name": "my-cline-plugin",
  "cline": {
    "plugins": [
      { "paths": ["./index.ts"], "capabilities": ["tools", "hooks"] }
    ]
  },
  "peerDependencies": {
    "@cline/sdk": "*"
  },
  "peerDependenciesMeta": {
    "@cline/sdk": { "optional": true }
  }
}
```

**安装来源**：
1. File URL（`https://github.com/owner/repo/blob/main/plugins/my-plugin.ts`）
2. Git Repository（`https://github.com/owner/repo.git@v1.2.0`）
3. npm Package（`npm:@scope/my-plugin`）
4. Local Path（`./my-plugin`）

**安装目录**：
```
~/.cline/plugins/_installed/
  npm/      # npm 源
  git/      # git 源
  remote/   # file URL 源
  local/    # 本地源
```

**Host-Provided Dependencies**：
- `@cline/sdk` / `@cline/core` / `@cline/agents` / `@cline/llms` / `@cline/shared` 由宿主提供
- 安装时自动从 plugin 依赖中剥离 `@cline/*`

**Plugin Sandbox**：[sdk/packages/core/src/extensions/plugin/plugin-sandbox.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/core/src/extensions/plugin/plugin-sandbox.ts) 沙箱化执行

**Plugin 示例**（typescript-lsp-plugin，添加 `goto_definition` 工具）：
```typescript
import { AgentPlugin } from "@cline/sdk"

const plugin: AgentPlugin = {
  async setup({ agentId, systemPrompt }) {
    return {
      tools: [{
        name: "goto_definition",
        description: "Resolve TypeScript symbol definitions.",
        inputSchema: { /* ... */ },
        async execute(input) {
          // Use TypeScript Language Service API
          return { location: "..." }
        },
      }],
      hooks: { /* ... */ },
    }
  },
}
export default plugin
```

### 10.3 Hooks 机制

**核心代码**：
- VSCode 层：[apps/vscode/src/core/hooks/](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/core/hooks/) + [apps/vscode/src/sdk/hooks-adapter.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/sdk/hooks-adapter.ts)
- SDK 层：[sdk/packages/core/src/hooks/](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/core/src/hooks/)（`hook-extension.ts` / `hook-file-config.ts` / `hook-file-hooks.ts` / `subprocess-runner.ts` / `checkpoint-hooks.ts`）

**Hook 阶段**（推断自 [agent-runtime.ts HookBag](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/agents/src/agent-runtime.ts) 第 221-229 行）：
- `beforeRun` / `afterRun` - Agent 运行前后
- `beforeModel` / `afterModel` - 模型调用前后
- `beforeTool` / `afterTool` - 工具执行前后
- `onEvent` - 任意事件

**HookEngine**（[sdk/packages/shared/src/hooks/](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/shared/src/hooks/)）：
- 用户可写 `.clinerules/hooks/` 目录下的脚本
- 通过 `subprocess-runner.ts` 在子进程执行
- 返回值可影响 Agent 行为（如 beforeTool 返回 `skip` 跳过执行）

**Checkpoint hooks**：[sdk/packages/core/src/hooks/checkpoint-hooks.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/core/src/hooks/checkpoint-hooks.ts) 通过 hook 自动触发检查点

### 10.4 借鉴建议：对比 tdsf-linux-desktop 的 Skill 工作流

**P1 强烈建议借鉴 Skills**：
- 渐进加载机制完美适合运维场景：
  - 启动时只加载 nginx/mysql/docker 等的 description（~100 tokens × 20 = 2k tokens）
  - 用户问 nginx 问题时才加载完整 nginx skill（<5k tokens）
  - 需要具体配置时才读 `docs/nginx-tuning.md`

**运维 Skill 示例**：
```markdown
---
name: nginx-troubleshoot
description: Troubleshoot Nginx issues. Use when debugging 502/504 errors, configuration problems, performance issues, or SSL certificate errors with Nginx.
---

# Nginx Troubleshooting

## Initial Assessment
1. Check Nginx status: `systemctl status nginx`
2. Test config syntax: `nginx -t`
3. Check error log: `tail -100 /var/log/nginx/error.log`
4. Check access log for patterns: `tail -100 /var/log/nginx/access.log`

## Common Issues

### 502 Bad Gateway
- Upstream service down → check `ps aux | grep <upstream>`
- Firewall blocking → `iptables -L -n`
- See [upstream-debug.md](docs/upstream-debug.md) for advanced

### 504 Gateway Timeout
- Increase `proxy_read_timeout` in nginx.conf
- Check upstream response time
```

**Hooks 借鉴建议**：
- `beforeTool` hook 可用于运维审计：记录每次命令执行到审计日志
- `afterTool` hook 可用于自动验证：执行 `systemctl restart nginx` 后自动 `curl -I localhost` 验证

**Plugins 借鉴建议**：
- 当前阶段不引入 Plugin 系统（tdsf-linux-desktop 优先稳定核心功能）
- 后期可参考 Cline plugin manifest 格式，让第三方扩展运维工具

---

## 11. BYOK + 本地模型支持

### 11.1 Provider 适配层（src/shared/api.ts）

**核心文件**：[apps/vscode/src/shared/api.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/shared/api.ts)

**ApiProvider 枚举**（50+ Provider，第 4-53 行）：
```typescript
export type ApiProvider =
  | "anthropic"
  | "claude-code"
  | "openrouter"
  | "bedrock"
  | "vertex"
  | "openai"
  | "ollama"
  | "lmstudio"
  | "gemini"
  | "openai-native"
  | "openai-codex"
  | "requesty"
  | "together"
  | "deepseek"
  | "qwen"
  | "qwen-code"
  | "doubao"
  | "mistral"
  | "vscode-lm"
  | "cline"
  | "cline-pass"
  | "litellm"
  | "moonshot"
  | "nebius"
  | "fireworks"
  | "asksage"
  | "xai"
  | "sambanova"
  | "cerebras"
  | "sapaicore"
  | "groq"
  | "poolside"
  | "huggingface"
  | "huawei-cloud-maas"
  | "dify"
  | "baseten"
  | "vercel-ai-gateway"
  | "v0"
  | "zai"
  | "zai-coding-plan"
  | "oca"
  | "aihubmix"
  | "minimax"
  | "hicap"
  | "nousResearch"
  | "wandb"
  | "xiaomi"
  | "tencent-tokenhub"

export const DEFAULT_API_PROVIDER = "openrouter" as ApiProvider
```

### 11.2 支持的 Provider 清单

**国际主流**：
- Anthropic（Claude Opus/Sonnet/Haiku）
- OpenAI（GPT 系列）
- Google Gemini
- AWS Bedrock
- Azure / GCP Vertex
- OpenRouter（200+ 模型聚合）
- Vercel AI Gateway（多 Provider 网关）

**国内主流**：
- DeepSeek
- Qwen（阿里通义，china/international 双 region）
- Doubao（字节豆包）
- Moonshot（月之暗面）
- ZAI（智谱）
- MiniMax
- HICAP
- AIHubMix
- Xiaomi（小米）
- Tencent TokenHub（腾讯）
- Huawei Cloud MaaS（华为云）

**本地模型**：
- Ollama（`ollama_base_url`）
- LM Studio（`lm_studio_base_url`）

**推理加速**：
- Cerebras / Groq / SambaNova / Fireworks / Nebius / Baseten / HuggingFace

**企业/特殊**：
- LiteLLM（自建网关）
- VSCode-LM（VS Code 内置 LM API）
- SAP AI Core
- Cline（自家 usage-billing）
- ClinePass（$9.99/月订阅）
- OCA / v0 / Poolside / Wandb / Asksage / Dify / NousResearch

**OAuth Provider**：
- Codex（ChatGPT Plus/Pro 订阅 OAuth）
- Qwen-Code（OAuth path）
- Cline Account

### 11.3 模型路由策略

**ModelInfo 数据结构**（[api.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/shared/api.ts) 第 70-99 行）：
```typescript
interface ModelInfo {
  name?: string
  maxTokens?: number
  contextWindow?: number
  supportsImages?: boolean
  supportsPromptCache: boolean
  supportsReasoning?: boolean
  inputPrice?: number             // 每 1M tokens 价格（美元）
  outputPrice?: number
  thinkingConfig?: {
    maxBudget?: number
    outputPrice?: number
    outputPriceTiers?: PriceTier[]  // 分层定价
    geminiThinkingLevel?: "low" | "high"
    supportsThinkingLevel?: boolean
  }
  supportsGlobalEndpoint?: boolean
  cacheWritesPrice?: number
  cacheReadsPrice?: number
  description?: string
  tiers?: {                       // 上下文窗口分层定价
    contextWindow: number
    inputPrice?: number
    outputPrice?: number
    cacheWritesPrice?: number
    cacheReadsPrice?: number
  }[]
  temperature?: number
  apiFormat?: ApiFormat
}
```

**Plan/Act 模式独立配置**（[state.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/state.proto) 第 160-300 行）：
- 每个 Provider 都有 `plan_mode_<provider>_model_id` 和 `act_mode_<provider>_model_id` 字段
- 支持 Plan/Act 模式分别配置不同模型

**Gateway 模式**（[sdk/packages/llms/](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/llms/)）：
- `DefaultGateway` / `createGateway` 统一 Provider 入口
- `createHandler` / `createHandlerAsync` Provider handler 工厂
- `getAllProviders` / `getModelsForProvider` catalog helpers
- `registerProvider` / `registerModel` 运行时扩展
- 基于 AI SDK backed execution

### 11.4 借鉴建议：对比 tdsf-linux-desktop 的 Provider 工厂模式

**P0 必须借鉴**：
1. **ApiProvider 联合类型**：用 TS 字面量联合类型而非 enum，便于扩展
2. **ModelInfo 完整数据结构**：包含 contextWindow / supportsImages / supportsReasoning / 价格 / cache 价格 / 分层定价
3. **Provider 工厂 + Gateway 路由**：统一入口，避免每个 Provider 单独适配
4. **Plan/Act 独立配置**：同一会话切换模式时可换模型

**tdsf-linux-desktop 优先 Provider 清单**（基于硬约束"本地优先，默认 Ollama / 国内 Provider"）：

| 优先级 | Provider | 用途 |
|--------|----------|------|
| P0 | **Ollama** | 默认本地 Provider，零配置开箱即用 |
| P0 | **Qwen**（通义） | 国内首选，china region |
| P0 | **DeepSeek** | 国内高性价比 |
| P0 | **Moonshot** | 国内长上下文 |
| P0 | **ZAI**（智谱 GLM） | 国内开源 |
| P1 | OpenRouter | 国际聚合（200+ 模型） |
| P1 | Anthropic | Claude（高质量 Plan） |
| P1 | OpenAI | GPT 系列 |
| P1 | LM Studio | 本地模型替代 |
| P2 | Bedrock / Vertex | 企业云 |
| P2 | Vercel AI Gateway | 多 Provider 网关 |

**关键代码模板**：
```typescript
type TdsfProvider = 
  | 'ollama' | 'qwen' | 'deepseek' | 'moonshot' | 'zai'  // 国内/本地优先
  | 'openrouter' | 'anthropic' | 'openai' | 'lmstudio'   // 国际
  | 'bedrock' | 'vertex' | 'vercel-ai-gateway'           // 云

interface TdsfModelInfo {
  id: string
  name: string
  contextWindow: number
  supportsReasoning: boolean
  supportsImages: boolean
  inputPrice?: number  // CNY per 1M tokens
  outputPrice?: number
  isLocal: boolean     // 本地模型标志
  region?: 'china' | 'international'
}

class TdsfProviderGateway {
  private handlers = new Map<TdsfProvider, ProviderHandler>()
  
  registerProvider(id: TdsfProvider, handler: ProviderHandler) {
    this.handlers.set(id, handler)
  }
  
  async chat(provider: TdsfProvider, model: string, messages: Message[]) {
    const handler = this.handlers.get(provider)
    if (!handler) throw new Error(`Provider ${provider} not registered`)
    
    // 所有网络请求必须 UI 可见（硬约束）
    emitNetworkEvent({ provider, model, messages: messages.length, timestamp: Date.now() })
    
    return handler.chat(model, messages)
  }
}

// 默认 Provider 工厂
function createDefaultProvider(): TdsfProvider {
  if (process.env.TDSF_DEFAULT_PROVIDER) return process.env.TDSF_DEFAULT_PROVIDER as TdsfProvider
  if (isOllamaAvailable()) return 'ollama'  // 本地优先
  return 'qwen'  // 国内默认
}
```

---

## 12. CLI / Hub / SDK 多形态

### 12.1 CLI（apps/cli）- TUI 适配

**核心文件**：
- [apps/cli/src/main.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cli/src/main.ts) - 入口
- [apps/cli/src/runtime/run-agent.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cli/src/runtime/run-agent.ts) - agent 运行时
- [apps/cli/src/runtime/tool-policies.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cli/src/runtime/tool-policies.ts) - 工具策略
- [apps/cli/src/runtime/tools.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cli/src/runtime/tools.ts) - 工具目录
- [apps/cli/src/tui/](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cli/src/tui/) - OpenTUI 终端 UI

**关键特性**：
1. **OpenTUI**：基于 [OpenTUI](https://github.com/cline/opentui) 的 React-like 终端 UI 框架
2. **headless 模式**：`cline --json "..."` 输出 JSON 行流，CI/CD 友好
3. **交互模式**：TUI chat 界面，支持历史记录/补全/粘贴图片
4. **yolo 模式**：`config.mode === "yolo"` 强制 local backend + 自动审批所有工具
5. **sandbox 模式**：`config.sandbox === true` 隔离状态目录
6. **CLI 命令**：auth/config/connect/dashboard/doctor/help/history/hook/hub/kanban/mcp/plugin/schedule/skill/update

**关键代码**（[run-agent.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cli/src/runtime/run-agent.ts) 第 163-178 行）：
```typescript
const isYoloMode = config.mode === "yolo"
const toolExecutors = {
  askQuestion: askQuestionInTerminal,
  submit: submitAndExitInTerminal,
}
const sessionManager = await createCliCore({
  capabilities: {
    toolExecutors,
    requestToolApproval,  // 终端弹窗审批
  },
  forceLocalBackend: isYoloMode || config.sandbox === true,
  logger: config.logger,
  cwd: config.cwd,
  workspaceRoot: config.workspaceRoot,
  toolPolicies: config.toolPolicies,
})
```

### 12.2 Hub（apps/cline-hub）- 多 agent 调度

**核心文件**：
- [apps/cline-hub/src/server/hub.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cline-hub/src/server/hub.ts) - Hub 核心
- [apps/cline-hub/src/server/sessions.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cline-hub/src/server/sessions.ts) - 会话管理
- [apps/cline-hub/src/server/mcp.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cline-hub/src/server/mcp.ts) - MCP 集成
- [apps/cline-hub/src/server/state.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cline-hub/src/server/state.ts) - 状态

**关键代码**（[hub.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cline-hub/src/server/hub.ts) 第 92-119 行 `attachHub`）：
```typescript
export async function attachHub(ctx: HubContext): Promise<void> {
  const hub = await ensureDetachedHubServer(workspaceRoot)
  ctx.hubUrl = hub.url
  ctx.hubAuthToken = hub.authToken

  ctx.cline = await ClineCore.create({
    clientName: "cline-hub",
    backendMode: "hub",
    capabilities: {
      requestToolApproval: (request) =>
        requestToolApprovalFromWebview(ctx, request),
    },
    hub: {
      endpoint: ctx.hubUrl,
      authToken: ctx.hubAuthToken,
      clientType: "cline-hub-chat",
      displayName: "Cline Hub Chat",
      workspaceRoot,
    },
  })

  ctx.uiClient = new HubUIClient({
    address: ctx.hubUrl,
    authToken: ctx.hubAuthToken,
    clientType: "cline-hub-server",
    displayName: "Cline Hub Server",
  })
  await ctx.uiClient.connect()
  // 监听 onNotify / onClientRegistered / onClientDisconnected / onSessionCreated / onSessionUpdated
}
```

**Hub 监听事件**：
- `onNotify` - 通知
- `onClientRegistered` / `onClientDisconnected` - 客户端连接/断开
- `onSessionCreated` / `onSessionUpdated` - 会话创建/更新

### 12.3 SDK - 第三方集成

**核心入口**：[sdk/packages/core/src/ClineCore.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/core/src/ClineCore.ts)

**ClineCore API**：
```typescript
class ClineCore {
  static async create(options: ClineCoreOptions): Promise<ClineCore>
  
  // 会话管理
  start(input: StartSessionInput | ClineCoreStartInput): Promise<StartSessionResult>
  
  // 自动化
  readonly automation: ClineCoreAutomationApi  // cron / event / one-off
  
  // 设置
  readonly settings: ClineCoreSettingsApi
  
  // 待处理提示
  readonly pendingPrompts: PendingPromptsServiceApi
  
  // Feature flags
  readonly featureFlags: FeatureFlagsService
  
  // 订阅事件
  subscribe(listener: (event: CoreSessionEvent) => void): () => void
  
  // 检查点
  compareCheckpointToWorkspace(input: CompareCheckpointInput): Promise<CompareCheckpointResult>
  restoreCheckpoint(input: RestoreInput): Promise<RestoreResult>
  
  // 历史记录
  listHistory(options: ClineCoreListHistoryOptions): Promise<SessionHistoryRecord[]>
}
```

**使用示例**：
```typescript
import { ClineCore } from "@cline/sdk"

const cline = await ClineCore.create({ clientName: "my-app" })

const session = await cline.start({
  prompt: "Plan and implement user authentication",
  config: {
    providerId: "anthropic",
    modelId: "claude-sonnet-4-6",
    apiKey: process.env.ANTHROPIC_API_KEY,
    cwd: "/path/to/project",
    workspaceRoot: "/path/to/project",
    enableTools: true,
    enableSpawnAgent: true,
    enableAgentTeams: true,
    teamName: "auth-sprint",
    mode: "plan",
  },
})

session.subscribe((event) => {
  console.log("Session event:", event)
})
```

### 12.4 借鉴建议：tdsf-linux-desktop 是否需要 CLI / Hub 形态

**P2 可选借鉴**：

| 形态 | tdsf-linux-desktop 是否需要 | 理由 |
|------|---------------------------|------|
| CLI | ❌ 不需要 | tdsf 已是 Electron 桌面应用，无需 CLI 形态 |
| Hub | ⚠️ 后期可考虑 | 运维场景"多服务器并行管理"有 Hub 需求，但优先单机版 |
| SDK | ✅ 内部 SDK 必需 | tdsf 应有自己的 `@tdsf/agent-core` 内部包，便于复用 |

**建议**：
1. **借鉴 SDK 分层架构**（P0）：`@tdsf/shared` → `@tdsf/llms` → `@tdsf/agents` → `@tdsf/core`
2. **暂不实现 CLI / Hub**：运维桌面应用形态已足够
3. **未来扩展**：若做 SaaS 多租户运维平台，可参考 Cline Hub 架构

---

## 13. 关键文件清单（带路径引用）

### 13.1 项目根文档
- [README.md](file:///d:/ai/linux教学一体/opensource-reference/cline/README.md)
- [LICENSE](file:///d:/ai/linux教学一体/opensource-reference/cline/LICENSE)（Apache-2.0）
- [package.json](file:///d:/ai/linux教学一体/opensource-reference/cline/package.json)
- [evals/ARCHITECTURE.md](file:///d:/ai/linux教学一体/opensource-reference/cline/evals/ARCHITECTURE.md)

### 13.2 核心架构文档
- [docs/cline-overview.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/cline-overview.mdx)
- [docs/core-workflows/plan-and-act.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/core-workflows/plan-and-act.mdx) ⭐
- [docs/core-workflows/checkpoints.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/core-workflows/checkpoints.mdx)
- [docs/features/subagents.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/features/subagents.mdx)
- [docs/features/auto-approve.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/features/auto-approve.mdx)
- [docs/features/auto-compact.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/features/auto-compact.mdx)
- [docs/mcp/mcp-overview.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/mcp/mcp-overview.mdx)
- [docs/sdk/architecture/overview.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/sdk/architecture/overview.mdx)
- [docs/sdk/architecture/hub-spoke.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/sdk/architecture/hub-spoke.mdx)
- [docs/sdk/guides/building-an-agent.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/sdk/guides/building-an-agent.mdx)
- [docs/sdk/guides/multi-agent-teams.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/sdk/guides/multi-agent-teams.mdx)
- [docs/sdk/reference/tools-api.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/sdk/reference/tools-api.mdx)
- [docs/sdk/reference/agent.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/sdk/reference/agent.mdx)
- [docs/customization/hooks.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/customization/hooks.mdx)
- [docs/customization/skills.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/customization/skills.mdx)
- [docs/customization/plugins.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/customization/plugins.mdx)
- [docs/customization/cline-rules.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/customization/cline-rules.mdx)
- [sdk/ARCHITECTURE.md](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/ARCHITECTURE.md) ⭐
- [sdk/AGENTS.md](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/AGENTS.md)

### 13.3 VS Code 扩展主体
- [apps/vscode/src/extension.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/extension.ts) ⭐ activate 入口
- [apps/vscode/src/config.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/config.ts) ClineEndpoint 单例
- [apps/vscode/src/registry.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/registry.ts)
- [apps/vscode/src/common.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/common.ts)
- [apps/vscode/src/shared/tools.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/shared/tools.ts) ⭐ 工具枚举
- [apps/vscode/src/shared/api.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/shared/api.ts) ⭐ Provider 清单
- [apps/vscode/src/shared/skills.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/shared/skills.ts)
- [apps/vscode/src/shared/mcp.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/shared/mcp.ts)
- [apps/vscode/src/shared/cline-rules.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/shared/cline-rules.ts)
- [apps/vscode/src/core/mentions/index.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/core/mentions/index.ts) ⭐
- [apps/vscode/src/core/storage/disk.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/core/storage/disk.ts) ⭐ 存储路径
- [apps/vscode/src/services/mcp/McpHub.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/services/mcp/McpHub.ts) ⭐⭐⭐ MCP 核心
- [apps/vscode/src/sdk/SdkController.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/sdk/SdkController.ts) ⭐ SDK 适配层
- [apps/vscode/src/sdk/auth-service.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/sdk/auth-service.ts)
- [apps/vscode/src/sdk/sdk-compaction.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/sdk/sdk-compaction.ts)
- [apps/vscode/src/sdk/session-host.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/sdk/session-host.ts)
- [apps/vscode/src/sdk/task-proxy.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/sdk/task-proxy.ts)
- [apps/vscode/src/utils/](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/utils/)（cli-detector/env/envExpansion/fs/fs-info/git/git-worktree/mcpAuth/model-utils/path/powershell/retry/shell/storage/time）

### 13.4 协议层
- [apps/vscode/proto/cline/](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/) 18 个 cline.* proto
  - [task.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/task.proto)
  - [state.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/state.proto) ⭐
  - [mcp.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/mcp.proto)
  - [common.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/common.proto)
  - [account.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/account.proto)
  - [browser.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/browser.proto)
  - [file.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/file.proto)
  - [hooks.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/hooks.proto)
  - [models.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/models.proto)
  - [slash.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/slash.proto)
  - [ui.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/ui.proto)
  - [web.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/web.proto)
  - [checkpoints.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/checkpoints.proto)
  - [commands.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/commands.proto)
  - [marketplace.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/marketplace.proto)
  - [oca_account.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/oca_account.proto)
  - [remote_config.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/remote_config.proto)
  - [worktree.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/worktree.proto)
- [apps/vscode/proto/host/](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/host/) 5 个 host.* proto
  - [window.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/host/window.proto) ⭐
  - [diff.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/host/diff.proto)
  - [env.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/host/env.proto)
  - [testing.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/host/testing.proto)
  - [workspace.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/host/workspace.proto)

### 13.5 CLI 版本
- [apps/cli/src/index.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cli/src/index.ts)
- [apps/cli/src/main.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cli/src/main.ts) ⭐
- [apps/cli/src/runtime/run-agent.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cli/src/runtime/run-agent.ts) ⭐
- [apps/cli/src/runtime/tool-policies.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cli/src/runtime/tool-policies.ts) ⭐
- [apps/cli/src/runtime/tools.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cli/src/runtime/tools.ts)
- [apps/cli/src/acp/index.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cli/src/acp/index.ts) ACP
- [apps/cli/src/commands/](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cli/src/commands/)（auth/config/connect/dashboard/doctor/help/history/hook/hub/kanban/mcp/plugin/program/schedule/skill/update）

### 13.6 Cline Hub
- [apps/cline-hub/src/server/hub.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cline-hub/src/server/hub.ts) ⭐
- [apps/cline-hub/src/server/sessions.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cline-hub/src/server/sessions.ts)
- [apps/cline-hub/src/server/mcp.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cline-hub/src/server/mcp.ts)
- [apps/cline-hub/src/server/state.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cline-hub/src/server/state.ts)

### 13.7 SDK 源码
- [sdk/AGENTS.md](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/AGENTS.md)
- [sdk/ARCHITECTURE.md](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/ARCHITECTURE.md) ⭐⭐⭐
- [sdk/packages/shared/](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/shared/)
- [sdk/packages/llms/](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/llms/)
- [sdk/packages/agents/src/agent-runtime.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/agents/src/agent-runtime.ts) ⭐⭐⭐ Agent 循环
- [sdk/packages/core/src/ClineCore.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/core/src/ClineCore.ts) ⭐⭐⭐ 主入口
- [sdk/packages/core/src/extensions/tools/definitions.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/core/src/extensions/tools/definitions.ts) ⭐ 工具定义
- [sdk/packages/core/src/extensions/context/compaction.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/core/src/extensions/context/compaction.ts) ⭐ 压缩
- [sdk/packages/core/src/extensions/mcp/manager.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/core/src/extensions/mcp/manager.ts)
- [sdk/packages/core/src/extensions/plugin/plugin-sandbox.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/core/src/extensions/plugin/plugin-sandbox.ts)
- [sdk/packages/core/src/extensions/tools/team/](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/core/src/extensions/tools/team/) 多代理
- [sdk/packages/core/src/session/checkpoint-restore.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/core/src/session/checkpoint-restore.ts) ⭐ 检查点
- [sdk/packages/core/src/hooks/](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/core/src/hooks/) hooks
- [sdk/packages/core/src/hub/](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/core/src/hub/) hub
- [sdk/packages/core/src/cron/](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/core/src/cron/) 自动化

---

## 14. 借鉴清单（对 tdsf-linux-desktop 的具体建议）

### 14.1 P0 优先级（必须借鉴）

| # | 借鉴项 | 实现位置参考 | tdsf 落地建议 |
|---|--------|-------------|--------------|
| 1 | **plan-and-act 双模式** | [docs/core-workflows/plan-and-act.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/core-workflows/plan-and-act.mdx) | 会话级 `mode: 'plan' \| 'act'` 字段，Plan 模式工具黑名单，独立模型配置 |
| 2 | **createTool 工厂** | [docs/sdk/reference/tools-api.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/sdk/reference/tools-api.mdx) | 统一工具接口（name/description/inputSchema/execute/timeoutMs/retryable/lifecycle） |
| 3 | **ToolPolicy 二级控制** | 同上 | `enabled` + `autoApprove` 分离，安全工具白名单 |
| 4 | **MCP 集成（McpHub 模式）** | [apps/vscode/src/services/mcp/McpHub.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/services/mcp/McpHub.ts) | 单例 McpHub + chokidar 监听 + 指纹防抖 + 三协议 |
| 5 | **BYOK Provider 工厂** | [apps/vscode/src/shared/api.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/shared/api.ts) | ApiProvider 联合类型 + ModelInfo + Gateway 路由，本地优先（Ollama/Qwen/DeepSeek） |
| 6 | **人工审批闸门** | [apps/cli/src/runtime/tool-policies.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cli/src/runtime/tool-policies.ts) | 运维场景所有写操作必须审批（硬约束） |
| 7 | **SDK 分层架构** | [sdk/ARCHITECTURE.md](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/ARCHITECTURE.md) | `@tdsf/shared` → `@tdsf/llms` → `@tdsf/agents` → `@tdsf/core` 单向依赖 |
| 8 | **AgentRuntime API** | [sdk/packages/agents/src/agent-runtime.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/agents/src/agent-runtime.ts) | run/continue/abort/subscribe/restore/snapshot 六个核心方法 |
| 9 | **HookBag 7 钩子** | 同上 第 221-229 行 | beforeRun/afterRun/beforeModel/afterModel/beforeTool/afterTool/onEvent |
| 10 | **Completion Policy** | 同上 第 535-553 行 | `lifecycle.completesRun: true` 标记完成工具，避免 maxIterations 截断 |

### 14.2 P1 优先级（建议借鉴）

| # | 借鉴项 | 实现位置参考 | tdsf 落地建议 |
|---|--------|-------------|--------------|
| 11 | **Checkpointing（影子 git）** | [sdk/packages/core/src/session/checkpoint-restore.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/core/src/session/checkpoint-restore.ts) | 运维配置回滚 + 反向命令记录 |
| 12 | **Skills 渐进加载** | [docs/customization/skills.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/customization/skills.mdx) | 启动时 metadata → 触发时 instructions → 按需 resources |
| 13 | **.clinerules 规则文件** | [docs/customization/cline-rules.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/customization/cline-rules.mdx) | `.tdsf/rules/` + 全局 + YAML frontmatter 条件激活 |
| 14 | **Auto-compact 上下文压缩** | [sdk/packages/core/src/extensions/context/compaction.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/core/src/extensions/context/compaction.ts) | basic + agentic 双策略，长运维任务必备 |
| 15 | **@mention 多类型注入** | [apps/vscode/src/core/mentions/index.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/core/mentions/index.ts) | tdsf 8 类：file/folder/log/service/process/port/disk/metric |
| 16 | **HostProvider 抽象** | [apps/vscode/src/extension.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/extension.ts) setupHostProvider | workspace/window/terminal/editor 接口化 |
| 17 | **Safe Auto-Approve 白名单** | [apps/cli/src/runtime/tool-policies.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cli/src/runtime/tool-policies.ts) | tdsf 只允许 ask_question/read_file/web_fetch/use_skill 自动批准 |
| 18 | **环境变量展开** | [apps/vscode/src/utils/envExpansion.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/utils/envExpansion.ts) | `${env:VAR_NAME}` 在 mcp.json/配置文件中展开 |
| 19 | **多根工作区** | [apps/vscode/src/core/workspace/WorkspaceRootManager](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/core/workspace/) | 运维场景天然多服务器 |
| 20 | **网络请求 UI 可见** | （推断） | 与硬约束一致：所有 Provider 调用 + MCP 调用 + Web Fetch 都在 UI 显示 |

### 14.3 P2 优先级（可选借鉴）

| # | 借鉴项 | 实现位置参考 | tdsf 落地建议 |
|---|--------|-------------|--------------|
| 21 | **Subagents 并行研究** | [docs/features/subagents.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/features/subagents.mdx) | 并行查多台服务器日志 |
| 22 | **Protobuf 协议** | [apps/vscode/proto/](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/) | Electron 主↔渲染进程通信优化（初期可用 JSON） |
| 23 | **Hub-Spoke 多进程** | [docs/sdk/architecture/hub-spoke.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/sdk/architecture/hub-spoke.mdx) | 未来 SaaS 多租户运维平台 |
| 24 | **ACP 协议** | [apps/cli/src/acp/index.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cli/src/acp/index.ts) | 对接 Neovim/Zed 编辑器（运维场景需求低） |
| 25 | **Cron 自动化** | [sdk/packages/core/src/cron/](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/core/src/cron/) | 定时巡检任务（每日健康检查） |
| 26 | **Connectors 集成** | [apps/cli/src/connectors/](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cli/src/connectors/) | 钉钉/企业微信告警通知 |
| 27 | **Plugin 系统** | [docs/customization/plugins.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/customization/plugins.mdx) | 第三方扩展运维工具（后期） |
| 28 | **Multi-Agent Teams** | [docs/sdk/guides/multi-agent-teams.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/sdk/guides/multi-agent-teams.mdx) | 多专家协调（nginx-expert + mysql-expert） |

### 14.4 不建议借鉴的部分（说明原因）

| # | 项目 | 原因 |
|---|------|------|
| 1 | **JetBrains Plugin 适配** | Cline 自己也未开源，且 tdsf 已是 Electron 跨平台 |
| 2 | **VS Code Marketplace 发布** | tdsf 是独立桌面应用，不需要走 VSCode Marketplace |
| 3 | **ClinePass 订阅** | tdsf 是 BYOK 模式，不涉及自家计费 |
| 4 | **Kanban Web 多 agent 板** | 运维场景过重，单机桌面应用足够 |
| 5 | **OpenTUI 终端 UI** | tdsf 已有 React + AntD UI，无需 TUI |
| 6 | **ACP 协议** | Neovim/Zed 用户群与运维场景重叠度低 |
| 7 | **`.cursorrules` / `.windsurfrules` 兼容** | tdsf 是独立生态，无需兼容其他 IDE 规则 |
| 8 | **Remote Config 远程下发** | 企业级特性，tdsf 优先本地优先 |

---

## 15. 风险与注意事项

### 15.1 License 合规

- ✅ **Apache-2.0 完全兼容**：tdsf-linux-desktop 可放心借鉴设计、API 形状、架构分层
- ⚠️ **直接复制源码**：必须在文件头注明 "Modified from Cline, Copyright 2026 Cline Bot Inc., Apache-2.0"
- ⚠️ **商标规避**：不要在产品名/品牌中使用 "Cline" 字样
- ⚠️ **NOTICE 文件**：若分发二进制，建议在 NOTICE 中列出 Cline 借鉴声明

### 15.2 安全风险

| 风险点 | Cline 做法 | tdsf 建议 |
|--------|-----------|----------|
| 命令执行 | `requires_approval` 标志 + 用户审批 | ✅ 强制审批所有命令（运维硬约束） |
| 文件写入 | diff 预览 + 用户审批 | ✅ 强制 diff 预览 + 审批 |
| MCP 调用 | autoApprove 白名单 | ✅ 所有 MCP 调用必须审批（运维场景） |
| 网络请求 | 默认不显示 | ✅ 所有网络请求 UI 可见（硬约束） |
| Provider Key | 存储于 VSCode SecretStorage | ✅ 用 Electron safeStorage / keytar |
| Plugin 沙箱 | subprocess + sandbox | ⚠️ tdsf 暂不引入 Plugin 系统 |
| Hub 认证 | constant-time token 比对 + 文件权限 600 | ✅ 若做 Hub，照搬此设计 |
| OAuth 回调 | `vscode://` URI handler | ⚠️ Electron 用 `app.on('open-url')` 替代 |

### 15.3 维护成本

| 模块 | 复杂度 | tdsf 维护成本 |
|------|--------|--------------|
| plan-and-act | 中 | 低（mode 字段 + 工具过滤） |
| 工具系统 | 中 | 中（需实现运维专属工具） |
| MCP 集成 | 高 | 高（chokidar + 多协议 + OAuth） |
| Provider 工厂 | 低 | 低（联合类型 + Gateway） |
| Checkpointing | 中 | 中（影子 git + 反向命令扩展） |
| Skills | 低 | 低（文件监听 + 渐进加载） |
| Hooks | 中 | 中（subprocess 执行用户脚本） |
| Auto-compact | 高 | 中（用 LLM 摘要，复用 Provider） |
| Subagents | 高 | 中（运维并行查询场景） |
| Protobuf | 高 | 高（需维护 proto + 生成代码） |
| Hub-Spoke | 极高 | 不建议（运维单机足够） |
| Cron 自动化 | 中 | 中（定时巡检有用） |
| Connectors | 中 | 中（钉钉/企业微信集成） |
| Plugin 系统 | 极高 | 不建议初期引入 |

### 15.4 实施路线建议

**Phase 1（v0.9.3）**：
- ✅ P0 借鉴项 #1-#6（plan-and-act / createTool / ToolPolicy / McpHub / BYOK / 审批）
- ✅ P1 借鉴项 #15（@mention 8 类）

**Phase 2（v0.9.4）**：
- ✅ P0 借鉴项 #7-#10（SDK 分层 / AgentRuntime / HookBag / Completion）
- ✅ P1 借鉴项 #11-#14（Checkpoint / Skills / Rules / Auto-compact）

**Phase 3（v1.0）**：
- ✅ P1 借鉴项 #16-#20（HostProvider / Safe Auto-Approve / envExpansion / 多根 / 网络可见）
- ✅ P2 借鉴项 #21（Subagents）

**Phase 4（v1.1+）**：
- ⚠️ P2 借鉴项 #22-#28（按需评估）

---

## 16. 参考资料

### 16.1 Cline 官方文档
- [Cline 文档主页](https://docs.cline.bot)
- [Plan & Act Deep Dive 视频](https://youtu.be/b7o6URFPp64)
- [Cline Rules Explained 视频](https://youtu.be/xQwsy2vkK5M)
- [Cline Discord](https://discord.gg/cline)
- [Cline Reddit](https://www.reddit.com/r/cline/)

### 16.2 关键源码文件
- [README.md](file:///d:/ai/linux教学一体/opensource-reference/cline/README.md)
- [LICENSE](file:///d:/ai/linux教学一体/opensource-reference/cline/LICENSE)
- [sdk/ARCHITECTURE.md](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/ARCHITECTURE.md)
- [apps/vscode/src/extension.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/extension.ts)
- [apps/vscode/src/shared/tools.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/shared/tools.ts)
- [apps/vscode/src/shared/api.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/shared/api.ts)
- [apps/vscode/src/services/mcp/McpHub.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/services/mcp/McpHub.ts)
- [apps/vscode/src/core/mentions/index.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/core/mentions/index.ts)
- [apps/vscode/src/core/storage/disk.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/core/storage/disk.ts)
- [apps/vscode/src/sdk/SdkController.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/src/sdk/SdkController.ts)
- [sdk/packages/core/src/ClineCore.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/core/src/ClineCore.ts)
- [sdk/packages/agents/src/agent-runtime.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/agents/src/agent-runtime.ts)
- [sdk/packages/core/src/extensions/tools/definitions.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/core/src/extensions/tools/definitions.ts)
- [sdk/packages/core/src/extensions/context/compaction.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/core/src/extensions/context/compaction.ts)
- [sdk/packages/core/src/session/checkpoint-restore.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/sdk/packages/core/src/session/checkpoint-restore.ts)
- [apps/cli/src/runtime/run-agent.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cli/src/runtime/run-agent.ts)
- [apps/cli/src/runtime/tool-policies.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cli/src/runtime/tool-policies.ts)
- [apps/cline-hub/src/server/hub.ts](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/cline-hub/src/server/hub.ts)
- [apps/vscode/proto/cline/task.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/task.proto)
- [apps/vscode/proto/cline/state.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/state.proto)
- [apps/vscode/proto/cline/mcp.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/cline/mcp.proto)
- [apps/vscode/proto/host/window.proto](file:///d:/ai/linux教学一体/opensource-reference/cline/apps/vscode/proto/host/window.proto)

### 16.3 关键文档
- [docs/core-workflows/plan-and-act.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/core-workflows/plan-and-act.mdx)
- [docs/core-workflows/checkpoints.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/core-workflows/checkpoints.mdx)
- [docs/features/subagents.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/features/subagents.mdx)
- [docs/features/auto-approve.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/features/auto-approve.mdx)
- [docs/features/auto-compact.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/features/auto-compact.mdx)
- [docs/mcp/mcp-overview.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/mcp/mcp-overview.mdx)
- [docs/sdk/architecture/overview.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/sdk/architecture/overview.mdx)
- [docs/sdk/architecture/hub-spoke.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/sdk/architecture/hub-spoke.mdx)
- [docs/sdk/guides/building-an-agent.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/sdk/guides/building-an-agent.mdx)
- [docs/sdk/guides/multi-agent-teams.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/sdk/guides/multi-agent-teams.mdx)
- [docs/sdk/reference/tools-api.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/sdk/reference/tools-api.mdx)
- [docs/sdk/reference/agent.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/sdk/reference/agent.mdx)
- [docs/customization/hooks.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/customization/hooks.mdx)
- [docs/customization/skills.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/customization/skills.mdx)
- [docs/customization/plugins.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/customization/plugins.mdx)
- [docs/customization/cline-rules.mdx](file:///d:/ai/linux教学一体/opensource-reference/cline/docs/customization/cline-rules.mdx)

### 16.4 诚实声明

**已真实阅读的文件**：
- ✅ 所有上述"关键文件"中列出的文件
- ✅ 18 个 cline.* proto + 5 个 host.* proto
- ✅ sdk/ARCHITECTURE.md（完整阅读）
- ✅ sdk/AGENTS.md（完整阅读）
- ✅ docs/ 下 18+ .mdx 文档
- ✅ apps/vscode/src/extension.ts（完整阅读 718 行）
- ✅ apps/vscode/src/shared/tools.ts（完整阅读 41 行）
- ✅ apps/vscode/src/shared/api.ts（前 226 行）
- ✅ apps/vscode/src/shared/skills.ts（完整 17 行）
- ✅ apps/vscode/src/shared/cline-rules.ts（完整 1 行）
- ✅ apps/vscode/src/services/mcp/McpHub.ts（前 300 行）
- ✅ apps/vscode/src/core/mentions/index.ts（前 200 行）
- ✅ apps/vscode/src/core/storage/disk.ts（前 150 行）
- ✅ apps/vscode/src/sdk/SdkController.ts（前 200 行）
- ✅ apps/vscode/src/config.ts（完整 349 行）
- ✅ sdk/packages/core/src/ClineCore.ts（前 300 行）
- ✅ sdk/packages/agents/src/agent-runtime.ts（前 600 行核心区）
- ✅ sdk/packages/core/src/extensions/tools/definitions.ts（前 200 行）
- ✅ sdk/packages/core/src/extensions/context/compaction.ts（前 150 行）
- ✅ sdk/packages/core/src/session/checkpoint-restore.ts（前 150 行）
- ✅ apps/cli/src/main.ts（前 200 行）
- ✅ apps/cli/src/runtime/run-agent.ts（前 200 行）
- ✅ apps/cli/src/runtime/tool-policies.ts（完整 95 行）
- ✅ apps/cli/src/runtime/tools.ts（完整 17 行）
- ✅ apps/cli/src/acp/index.ts（完整 23 行）
- ✅ apps/cline-hub/src/server/hub.ts（前 200 行）
- ✅ apps/cline-hub/src/server/sessions.ts（前 150 行）

**未深入阅读（诚实声明）**：
- ⚠️ apps/vscode/src/utils/ 下多数工具函数（仅扫目录）
- ⚠️ apps/vscode/src/sdk/ 下其他 Sdk*Coordinator（仅 SdkController 主类）
- ⚠️ sdk/packages/agents/ 的完整 1000+ 行实现（仅前 600 行核心循环）
- ⚠️ sdk/packages/core/src/cron/ 自动化细节
- ⚠️ sdk/packages/core/src/hub/ Hub 服务端实现细节
- ⚠️ sdk/packages/shared/src/hooks/ HookEngine 实现细节
- ⚠️ apps/cli/src/tui/ OpenTUI 终端 UI 实现
- ⚠️ apps/cline-hub/src/webview/ React Web UI
- ⚠️ apps/examples/ 示例代码（仅 docs 引用）
- ⚠️ evals/ 评估系统实现
- ⚠️ .changeset/ .kanban/ .codex/ 等配置目录
- ⚠️ apps/vscode-rollout/ 灰度发布
- ⚠️ apps/vscode/webview-ui/ React Webview 完整代码

**分析置信度**：
- 架构层面：⭐⭐⭐⭐⭐（基于 ARCHITECTURE.md + 源码交叉验证）
- API 设计：⭐⭐⭐⭐⭐（基于 docs + 源码类型定义）
- 实现细节：⭐⭐⭐⭐（部分模块仅看入口，未深入全部实现）
- 借鉴建议：⭐⭐⭐⭐⭐（与 tdsf 硬约束对照明确）

---

**报告完成时间**：2026-07-19
**分析师**：资深源码分析师
**报告版本**：v1.0
**字数估算**：约 25,000 字（含代码块）
**章节数**：16 章 + 0 摘要
**关键借鉴清单**：P0 × 10 + P1 × 10 + P2 × 8 + 不建议 × 8 = 36 项
