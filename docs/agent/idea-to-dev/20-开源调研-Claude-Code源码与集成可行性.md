# 开源调研：Claude Code 源码与集成可行性评估

> **调研日期**：2026-07-17
> **调研对象**：Anthropic Claude Code CLI（含 Agent SDK）
> **调研目的**：评估将 Claude Code 编译集成到 `tdsf-linux-desktop`（Electron 30 + React 18 + TS + Mastra）作为 v0.9 Agent 架构备选方案的可行性、合规性、技术路径与替代方案。
> **调研方法**：官方文档抓取（code.claude.com / docs.anthropic.com）+ GitHub/npm 实证检索 + 第三方技术分析文献核对。
> **核心结论**：**不建议"下载源码反编译集成"路径**；推荐"方案 B（官方 Agent SDK 复用）+ 方案 C（架构参考自研）"组合，并以多模型后端策略规避国内可用性风险。

---

## 1. 概述

### 1.1 Claude Code 是什么

| 属性 | 详情 |
|---|---|
| **产品定位** | Anthropic 官方的 **终端原生（terminal-first）Agentic 编码工具**，非 IDE 插件 |
| **首次发布** | 2025 年 5 月（Research Preview）；2025 年下半年 GA；2026 年 7 月当前版本约 v2.1.x 系列 |
| **运行形态** | 用户在终端执行 `claude` 命令进入交互式 REPL，或 `claude -p "prompt"` 非交互模式 |
| **底层模型** | Claude Opus 4.6 / Opus 4.8 / Sonnet 4.6 / Sonnet 5（按场景切换） |
| **GitHub 仓库** | `anthropics/claude-code`，约 119K stars（截至 2026-04-29 验证） |
| **核心能力** | 读/写文件、执行 shell、搜索代码库、Git 工作流、Web 搜索/fetch、子代理编排、MCP 集成、Hooks 自动化 |
| **上下文窗口** | 200K tokens（默认）；1M tokens（Opus 4.6+/Sonnet 5，Beta） |
| **基准表现** | SWE-bench Verified 80.9%（Opus 4.6），复杂调试任务首试成功率 >80% |

### 1.2 与 Cursor / Trae 的定位对比

| 维度 | Claude Code | Cursor | Trae（字节） |
|---|---|---|---|
| **形态** | CLI 进程（Bun runtime） | VS Code Fork（IDE） | VS Code Fork（IDE） |
| **设计哲学** | Agent-first：编码能力嵌入 Agent 运行时 | IDE-first：AI 嵌入编辑器 | IDE-first：对标 Cursor，中文场景优化 |
| **强项** | 跨多文件重构、深度推理、自主多步任务 | Tab 补全、可视化 diff、Composer 多文件编辑 | 中文提示词理解、免费额度、国内网络友好 |
| **弱项** | 终端 UI 有学习曲线；token 成本不可控 | 大型重构易丢上下文 | 复杂工程深度不及 Claude Code |
| **定价** | Claude Pro $20/mo；Max $100-200/mo；API 按量 | Pro $20/mo | 基础能力免费 |
| **典型场景** | "派任务"式自主完成 | "你写它补"式日常编码 | 低成本入门、中文项目 |

**关键差异**：Claude Code 与 Cursor/Trae 不是同一形态产品，**它们解决的是不同范式问题**。Cursor/Trae 是"增强编辑器"，Claude Code 是"能独立干活的 Agent"。在 tdsf-linux-desktop 这类桌面 IDE 中，两者是**互补关系**而非替代关系。

### 1.3 Claude Code 的"开源"真相

> ⚠️ **关键事实**：Anthropic 在营销时称 Claude Code "open source"，但**官方 GitHub 仓库只包含插件示例、Hook 模板、配置文件骨架**（约 279 个文件）。真正的核心引擎是**闭源商业代码**，受 Anthropic Commercial Terms of Service 约束。

- 官方仓库 `anthropics/claude-code` 顶层目录：`.claude-plugin/`、`.claude/commands/`、`examples/`、`plugins/`、`scripts/`
- 语言构成（官方仓库）：Shell 47.1% / Python 29.2% / TypeScript 17.7%
- 真正的核心引擎（QueryEngine、Tool 系统、Coordinator 等）**不在公开仓库中**

---

## 2. 源码获取与 License

### 2.1 官方包与 License

| 项 | 详情 |
|---|---|
| **npm 包名** | `@anthropic-ai/claude-code` |
| **安装** | `npm install -g @anthropic-ai/claude-code`（官方推荐） |
| **License（公开仓库）** | README 声称 MIT-adjacent，但仅限插件示例代码 |
| **License（核心引擎）** | **UNLICENSED** — Anthropic Commercial Terms of Service |
| **package.json 实际字段** | `"license": "UNLICENSEED"`、`"private": true`（来自 v2.1.88 泄露版本） |

### 2.2 2026-03-31 源码泄露事件（技术评估参考）

> ⚠️ **本节仅作技术评估，不构成任何鼓励逆向/重分发行为**。

- **事件**：2026-03-30 Anthropic 发布 Claude Code v2.1.88，构建时意外将 57MB 的 `cli.js.map` source map 文件打包进 npm 包
- **发现者**：安全研究员 Chaofan Shou（@Fried_rice）于 UTC 2026-03-31 08:23 公开
- **影响**：泄露约 **2,016 个 TypeScript 源文件 / 512,000+ 行**，覆盖 QueryEngine、Tool 系统、Coordinator、权限系统、Hooks 全栈
- **官方回应**：Anthropic 确认是"人为失误的打包问题，非安全漏洞"，无客户数据泄露；当天即下架该版本
- **DMCA 行动**：Anthropic 已对 GitHub 上镜像源码的非重写仓库发起 DMCA takedown（参见 `github/dmca/blob/master/2026/03/2026-03-31-anthropic.md`）
- **社区衍生**：`claw-code`（Python 重写，~75K stars）、IPFS 镜像、`sanbuphy/claude-code-source-code`（用于研究，~891 stars）等

**这是 Claude Code 一年内第二次因 source map 泄露源码**，但**源码可见 ≠ 开源**，复制或重分发仍违反许可协议。

### 2.3 反编译/逆向可行性（仅作技术评估）

| 评估项 | 结论 |
|---|---|
| **技术可行性** | 高。npm 包为 Bun bundle 单文件（~25MB），可通过 `npm pack` 获取；如包含 `.map` 可直接还原 TS 源码；即使无 map，esbuild bundle 也可被 de4js / webcrack 反混淆 |
| **法律可行性** | **极低**。Anthropic Commercial Terms of Service 明确禁止反编译、重分发；Anthropic 已主动 DMCA 维权 |
| **维护可行性** | 低。每次官方更新需重新反编译；feature flag 系统（如 `COORDINATOR_MODE`、`KAIROS`、`PROACTIVE`）在公开版本被 `const feature = () => false` 静默禁用，108 个模块缺失 |
| **合规风险** | **极高**。直接复制源码到商业产品将构成著作权侵权，且可能触发 Anthropic 主动法律行动 |

### 2.4 官方 SDK 包（推荐路径）

Anthropic 提供了**官方合法的复用路径** —— Claude Agent SDK（2026 年由原 Claude Code SDK 更名而来）：

| SDK 包 | 语言 | 安装 | 状态 |
|---|---|---|---|
| `@anthropic-ai/claude-agent-sdk` | TypeScript | `npm install @anthropic-ai/claude-agent-sdk` | GA，官方推荐 |
| `claude-agent-sdk` | Python | `pip install claude-agent-sdk` | GA，官方推荐 |
| `@anthropic-ai/claude-code` | TypeScript（CLI 本体） | `npm install -g @anthropic-ai/claude-code` | GA，CLI 运行时 |

**Agent SDK 关键特性**（来自 `code.claude.com/docs/en/agent-sdk`）：
- 提供 `query()` 异步生成器 API，**复用 Claude Code 同样的工具、Agent Loop、上下文管理**
- 内置工具：Read / Write / Edit / Bash / Glob / Grep / WebSearch / WebFetch / AskUserQuestion
- 支持 Hooks（PreToolUse / PostToolUse / Stop / SessionStart 等）
- 支持自定义工具与 MCP 服务器
- TypeScript SDK 自动捆绑平台原生 Claude Code 二进制作为 optional dependency
- 支持多后端认证：Anthropic API、Amazon Bedrock、Claude Platform on AWS、Google Vertex AI、Microsoft Azure Foundry

```typescript
import { query } from "@anthropic-ai/claude-agent-sdk";

for await (const message of query({
  prompt: "Find and fix the bug in auth.ts",
  options: { allowedTools: ["Read", "Edit", "Bash"] }
})) {
  console.log(message);
}
```

**许可证要点**：Agent SDK 允许第三方开发者使用，但**未经 Anthropic 预先批准，不得提供 claude.ai 登录或速率限制给产品终端用户**。必须使用 API Key 认证方式。

---

## 3. 架构详解

### 3.1 技术栈（基于 v2.1.88 泄露源码与官方文档核对）

| 层 | 技术 | 选择动机 |
|---|---|---|
| **运行时** | **Bun** ≥ 1.1.0（非 Node.js） | 启动速度比 Node.js 快 3-4 倍；原生 TS 支持；`feature()` 编译期消除死代码 |
| **语言** | TypeScript（strict mode） | 4,600+ 文件规模下类型安全是刚需 |
| **UI 框架** | React 18 + Ink | 把 React 渲染到终端；完整 hooks/状态管理；启用 React Compiler 优化 |
| **构建工具** | esbuild + Bun bundle | 单文件产物（~25MB `dist/cli.js`） |
| **测试框架** | Vitest | — |
| **包大小** | ~2000 源文件 / 512K+ 行 TypeScript | 生产级规模 |
| **平台分发** | curl 脚本 / Homebrew / WinGet / PowerShell | 平台原生二进制，npm 安装路径已被标记 deprecated |

### 3.2 进程模型与 IPC

**Claude Code 不是 Electron 应用，是单进程 CLI Agent**：

- **主入口**：`src/entrypoints/cli.tsx` → 动态 `import("../main.jsx")`
- **分级快速路径**：`--version` 零模块加载直接返回；其他命令按需懒加载，优化冷启动
- **进程内**：UI（Ink/React）+ Agent Loop（query.ts）+ Tool 执行器都在同一 Bun 进程
- **无渲染进程概念**：终端 UI 与业务逻辑同进程，通过 React state 驱动重渲染
- **子进程**：仅 Bash 工具执行时 spawn 子进程；subagent 通过 `AgentTool` 派生独立 query() 上下文（不一定 fork 进程）
- **Bridge 系统**：`src/bridge/` 提供 IDE 集成协议（VS Code / JetBrains 扩展通过此协议通信），这是为 IDE 集成设计的扩展点

**对 Electron 集成的启示**：Claude Code 的进程模型与 Electron 主/渲染进程模型**不直接对应**。要在 Electron 中复用，需要将 Agent Loop 逻辑作为主进程模块运行，UI 通过 IPC 桥接 —— 这正是 Agent SDK 的设计目标。

### 3.3 工具调用协议

Claude Code 同时支持三种工具调用机制：

1. **Anthropic Function Calling**（原生）：基于 Claude API 的 `tools` 参数和 `tool_use` / `tool_result` 消息块。是主协议。
2. **MCP（Model Context Protocol）**：开放标准，支持外部 MCP server 暴露工具/资源。Claude Code 内置 MCP 客户端，可通过 `claude mcp add` 注册。
3. **自定义工具**：通过 Agent SDK 的 `customTools` 选项或 Hooks 系统注入业务逻辑。

**内置工具分类**（约 40+ 个）：

| 类别 | 工具示例 |
|---|---|
| 文件操作 | Read、Write、Edit、Glob、Grep |
| 执行 | Bash（含沙箱）、KillShell |
| Web | WebSearch、WebFetch |
| 子代理 | Agent（Task）、SendMessage、TaskStop、TeamCreate、TeamDelete |
| 交互 | AskUserQuestion、exit_plan_mode |
| 代码智能 | 代码诊断、跳转定义、查找引用（需 code intelligence 插件） |
| MCP | 动态加载的 MCP server 工具 |
| 内部 | GoalTool、SyntheticOutput、subscribe_pr_activity |

### 3.4 Agent Loop（核心循环模型）

> 学术研究引用：MBZUAI VILA Lab 的《Dive into Claude Code》（arXiv:2604.14228v2）源码级分析

**Claude Code 的核心是一个简单的 while 循环**：

```
while (true) {
  1. 调用模型（callModel）—— 感知 + 决策
  2. 如果模型不再调用工具 → 返回最终响应，循环结束
  3. 执行模型请求的工具（StreamingToolExecutor）—— 行动
  4. 将工具结果加入消息历史 —— 观察
  5. 回到 1
}
```

**官方文档化的三阶段**（`code.claude.com/docs/en/how-claude-code-works`）：
- **Gather context**（收集上下文）
- **Take action**（采取行动）
- **Verify results**（验证结果）

这三阶段是**逻辑分类而非硬编码步骤**，会随任务自然混合：提问可能只需收集上下文；修 Bug 会反复经历三阶段；重构则重点在验证。

**实现细节**（`src/query.ts` ~46K 行，作为 AsyncGenerator）：

- **预处理流水线**（每轮调用模型前）：
  1. `applyToolResultBudget` — 工具结果 token 预算控制
  2. `snipCompact` — 片段级压缩
  3. `microcompact` — 微压缩
  4. `contextCollapse` — 上下文折叠
  5. `autocompact` — 自动压缩（接近 context window 时触发）
- **流式执行**：通过 `StreamingToolExecutor` 并行执行多个 tool_use 块（默认开启 parallel tool use）
- **终止条件**：LLM 返回 `end_turn`、用户中断（Ctrl+C）、达到最大迭代数、上下文耗尽
- **自主性**：循环的终止**不是计数器**，而是 LLM 自主判断"是否还需要调用工具" —— 这是"agentic"的本质

**关于 "Plan-Act-Observe-Reflect"**：
- Claude Code 的核心循环本质是 **Plan-Act-Observe**（无显式 Reflect 阶段）
- "Plan" 隐含在 LLM 的思考过程中（adaptive thinking）
- "Reflect" 部分由 `/goal` 命令提供：通过外部 evaluator 模型检查成功条件，不达标则回到循环
- 高级循环模式由 `/loop`、`/schedule`、`/goal` 等 slash command 提供（turn-based / goal-based / time-based / proactive）

### 3.5 Subagent / Coordinator 模式

> 源码位置：`src/coordinator/coordinatorMode.ts`、`src/tools/AgentTool/`、`src/tools/SendMessageTool/`、`src/tools/TeamCreateTool/`

**Claude Code 支持四层多 Agent 编排体系**：

| 层级 | 机制 | 特征 |
|---|---|---|
| **第一层：Task 委派** | `Agent` 工具（原 `Task`） | 会话内 spawn 子 agent，独立上下文窗口，仅向父汇报摘要 |
| **第二层：Background Agents** | 后台 agent | 可选 `isolation: worktree` 在独立 git 分支工作 |
| **第三层：Agent Teams**（实验性） | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` | 多个 Claude Code 实例组成团队，共享任务列表 + 互相通信，v2.1.178+ |
| **第四层：Coordinator Mode**（隐藏 feature flag） | `feature('COORDINATOR_MODE')` + `CLAUDE_CODE_COORDINATOR_MODE=1` | 编排器禁用文件/Bash 工具，仅通过 Agent/SendMessage/TaskStop 派发工作 |

**Coordinator 模式核心原则**：
- **完全的上下文隔离**：worker 看不到 coordinator 的对话，每个 worker 从零上下文启动
- coordinator 必须写自包含 prompt，包含文件路径、行号、错误信息、"done" 判据
- worker 结果通过 XML `<task-notification>` 作为 user-role 消息回传给 coordinator
- 两级限制：subagent 不能再 spawn subagent，所以"waves"实际是批次

**Worker 工具集**（两种模式）：
- Simple mode（`CLAUDE_CODE_SIMPLE`）：仅 Bash + Read + Edit
- Full mode：所有标准工具 + MCP + Skills，扣除内部专用工具（TeamCreate / TeamDelete / SendMessage / SyntheticOutput）

### 3.6 上下文管理

| 机制 | 实现 | 触发 |
|---|---|---|
| **Context Window** | 200K（默认）/ 1M（Opus 4.6+/Sonnet 5 beta） | 模型层 |
| **Auto-compact** | 5 层 compaction pipeline（applyToolResultBudget → snipCompact → microcompact → contextCollapse → autocompact） | 接近 context window 阈值 |
| **Server-side Compaction** | API beta `compact-2026-01-12`，自动摘要早期上下文 | 默认 150K tokens |
| **Context Editing** | beta `context-management-2025-06-27`，清除旧 tool 结果 / thinking 块（≠ 压缩） | 主动调用 |
| **Memory 持久化** | `~/.claude/projects/<hash>/` + JSONL session logs + CLAUDE.md 层级加载 | 跨会话 |
| **Prompt Caching** | API 层 cache_control，prefix 稳定时缓存命中降本 | 自动 |
| **Task Budgets** | beta `task-budgets-2026-03-13`，给 agent 一个 token 总预算自我节奏 | 主动 |

**记忆层级**：
1. `~/.claude/CLAUDE.md` — 全局
2. `<project>/CLAUDE.md` — 项目级
3. `<project>/<subdir>/CLAUDE.md` — 子目录级（导航时加载）
4. `~/.claude/projects/<hash>/memory/MEMORY.md` — 项目专属记忆
5. JSONL 会话日志 — 完整对话历史

---

## 4. 沙箱机制

> 数据来源：`code.claude.com/docs/en/sandboxing` 官方文档

### 4.1 平台支持矩阵

| 平台 | 支持状态 | 底层技术 |
|---|---|---|
| **macOS** | ✅ 内置，无需安装 | **Seatbelt**（sandbox-exec，内核级沙箱） |
| **Linux** | ✅ 需安装依赖 | **bubblewrap**（bwrap，文件系统隔离）+ **socat**（网络代理中继） |
| **WSL2** | ✅ 需安装依赖 + AppArmor 调整 | 同 Linux；Ubuntu 24.04+ 需为 bwrap 添加 AppArmor profile |
| **Windows 原生** | ❌ **不支持** | 需在 WSL2 中运行 Claude Code |

### 4.2 隔离范围

| 维度 | 默认策略 |
|---|---|
| **文件系统** | 工作目录 + session temp 目录可写；其余只读 |
| **网络** | 白名单制：首次访问新域名弹窗确认；可配置 `allowedDomains` |
| **子进程** | 所有子进程继承沙箱限制 |
| **凭证保护** | `sandbox.credentials.files` 阻止读 `~/.aws/credentials`、`~/.ssh` 等；`envVars` 可 `deny`（移除）或 `mask`（替换为哨兵值，仅对 injectHosts 还原） |
| **TLS 终止** | `network.tlsTerminate` 启用后，代理可见明文以做凭证替换 |

### 4.3 两种沙箱模式

| 模式 | 行为 | 适用场景 |
|---|---|---|
| **Auto-allow**（推荐） | 沙箱内 Bash 命令自动允许，不弹窗 | 减少审批疲劳，提升自主性 |
| **Regular permissions** | 沙箱内命令仍走权限流程 | 谨慎控制场景 |

**即使在 auto-allow 模式下，以下仍然强制弹窗**：
- 显式 `deny` 规则
- `rm`/`rmdir` 针对 `/`、home 目录等关键路径
- 内容级 `ask` 规则（如 `Bash(git push *)`）
- 网络访问非允许域名

### 4.4 逃生舱机制

- 命令在沙箱中失败时，Claude Code 会分析失败原因，可能以 `dangerouslyDisableSandbox: true` 参数重试（在沙箱外执行）
- 可通过 `allowUnsandboxedCommands: false` 禁用此逃生舱（严格沙箱模式）
- `excludedCommands` 显式列出不能进沙箱的命令

### 4.5 对 tdsf-linux-desktop 的启示

- **Linux 原生支持完备**：bubblewrap 是 Linux 桌面环境标准组件，与 Electron 兼容良好
- **Windows 原生不支持**：tdsf-linux-desktop 的 Windows 用户需引导使用 WSL2
- **macOS 免配置**：Seatbelt 内置
- **凭证保护机制**值得借鉴到自研 Agent 架构（见第 8 章）

---

## 5. 四种集成方案对比

### 5.1 方案 A：直接调用 CLI 子进程（spawn `claude` 命令）

**做法**：Electron 主进程通过 `child_process.spawn('claude', ['-p', prompt, '--output-format', 'json'])` 启动子进程，解析 stdout JSON 流。

| 维度 | 评估 |
|---|---|
| **技术可行性** | ✅ 高。CLI 是一等公民，`--output-format json`、`--no-stream` 等 flag 设计为程序化消费 |
| **实现成本** | 🟢 低。1-2 周可跑通 PoC |
| **功能完整度** | 🟡 中。失去 UI 集成深度；需要自行处理流式输出、错误、中断 |
| **用户体验** | 🟡 中。需用户预装 Claude Code CLI 并完成认证 |
| **License 合规** | 🟢 低风险。Claude Code CLI 允许被调用 |
| **依赖耦合** | 🔴 高。强依赖外部 CLI 安装；版本升级可能破坏集成 |
| **国内可用性** | 🔴 阻塞。Claude Code 认证需 claude.ai 登录或海外 API Key，国内用户几乎不可用 |
| **推荐度** | ⭐⭐ 适合早期 PoC，不适合长期产品形态 |

**优点**：
- 零代码侵入，立即可用
- 自动跟随 Claude Code 升级获得新能力
- 无 License 风险

**缺点**：
- 进程间通信开销大，无法细粒度控制 Agent Loop
- 无法注入自定义工具到 Claude Code 内部
- 用户需自行安装 CLI + 认证，门槛高
- 国内访问需用户自行解决网络问题

### 5.2 方案 B：复用官方 Agent SDK（`@anthropic-ai/claude-agent-sdk`）

**做法**：直接 `import { query } from "@anthropic-ai/claude-agent-sdk"`，在 Electron 主进程中以库形式调用，通过 IPC 与渲染进程通信。

| 维度 | 评估 |
|---|---|
| **技术可行性** | ✅ 高。TypeScript SDK，与 Electron 技术栈完全匹配 |
| **实现成本** | 🟡 中。2-4 周完成核心集成；需设计 IPC 协议、UI 适配 |
| **功能完整度** | 🟢 高。复用 Claude Code 同样的工具、Loop、上下文管理 |
| **用户体验** | 🟢 高。应用内集成，无需用户预装 CLI |
| **License 合规** | 🟢 低风险。SDK 官方允许第三方使用 |
| **依赖耦合** | 🟡 中。SDK 跟随 Anthropic 升级；可锁定版本 |
| **国内可用性** | 🟡 中。需提供 ANTHROPIC_API_KEY；可切换 Bedrock/Vertex/Foundry 后端；可用中转 API |
| **扩展性** | 🟢 高。支持 customTools、Hooks、MCP server 注入业务工具 |
| **推荐度** | ⭐⭐⭐⭐⭐ 最推荐 |

**优点**：
- 官方支持路径，长期稳定
- 与 Electron + React + TS 技术栈原生契合
- 可注入自定义工具（如 Linux 运维工具集）和 Hooks
- TypeScript SDK 自带原生 Claude Code 二进制作为 optional dependency
- 支持多后端：API Key、Bedrock、Vertex、Foundry —— **国内用户可走 AWS Bedrock 间接使用 Claude**

**缺点**：
- 仍需 Anthropic API Key 或等价凭证（不能直接复用 claude.ai 订阅）
- Anthropic 明确禁止第三方产品提供 claude.ai 登录给终端用户
- 国内 API 访问需解决网络问题（见第 7 章）
- SDK 自身闭源（但 API 公开稳定）

### 5.3 方案 C：参考架构自研（不集成 Claude Code 代码）

**做法**：不集成任何 Claude Code 代码，而是借鉴其架构设计（Agent Loop、工具协议、上下文管理、沙箱、Coordinator），用 tdsf-linux-desktop 现有 Mastra + Electron 技术栈自研 Agent 层。

| 维度 | 评估 |
|---|---|
| **技术可行性** | ✅ 高。Mastra 已提供 Agent 框架基础 |
| **实现成本** | 🔴 高。8-16 周完整自研；需重建工具系统、上下文管理、权限模型 |
| **功能完整度** | 🟡 可控。按需实现，可针对 Linux 运维场景深度优化 |
| **用户体验** | 🟢 高。完全自主，深度集成到桌面 IDE |
| **License 合规** | 🟢 零风险。不使用任何 Anthropic 代码 |
| **依赖耦合** | 🟢 零耦合。模型后端可自由切换 |
| **国内可用性** | 🟢 高。可直接对接 DeepSeek、通义千问、智谱、MiniMax 等国产模型 |
| **推荐度** | ⭐⭐⭐⭐ 长期最优，但成本高 |

**优点**：
- 完全自主可控
- 可针对 Linux 运维场景深度定制（如内置 SSH、systemd、kubectl 工具）
- 模型后端灵活，规避国内可用性问题
- 无任何 License 风险

**缺点**：
- 重新发明轮子，错过 Claude Code 已验证的工程实践
- Agent Loop 的工程化（错误恢复、成本控制、上下文压缩）极其复杂
- 需要重建整个工具生态

### 5.4 方案 D：源码反编译集成

**做法**：下载 npm 包，通过 source map 或反混淆还原源码，移植核心模块到 tdsf-linux-desktop。

| 维度 | 评估 |
|---|---|
| **技术可行性** | 🟡 中。技术上可还原 TS 源码；但 108 个 feature-gated 模块缺失，需手动补齐；Bun 运行时与 Electron Node.js 不直接兼容 |
| **实现成本** | 🔴 极高。16+ 周；需重写大量 Bun-specific 代码；处理 React+Ink 到 React DOM 的迁移 |
| **功能完整度** | 🟡 中。可移植部分模块，但完整复刻几乎不可能 |
| **用户体验** | 🔴 高风险。法律风险可能迫使产品下架 |
| **License 合规** | 🔴 **极高风险**。违反 Anthropic Commercial Terms of Service；Anthropic 已主动 DMCA 维权 |
| **依赖耦合** | 🔴 极高。每次官方更新需重新反编译同步 |
| **国内可用性** | 🔴 阻塞。仍依赖 Anthropic API |
| **推荐度** | ⭐ **强烈不推荐** |

**优点**：
- 可获得最完整的 Claude Code 能力

**缺点**：
- **法律风险**：直接侵犯 Anthropic 著作权，可能面临 DMCA、诉讼、产品下架
- **技术债**：Bun ↔ Node.js 不兼容；React+Ink ↔ React DOM 不兼容；feature flag 系统缺失
- **维护地狱**：无法跟随官方升级
- **声誉风险**：被 Anthropic 主动维权对产品信誉打击巨大
- **国内仍不可用**：底层仍依赖 Anthropic API

### 5.5 四方案对比总表

| 方案 | 可行性 | 实现成本 | License 合规 | 国内可用性 | 推荐度 |
|---|---|---|---|---|---|
| **A. CLI 子进程** | 🟢 高 | 🟢 低（1-2 周） | 🟢 低风险 | 🔴 阻塞 | ⭐⭐ |
| **B. Agent SDK 复用** | 🟢 高 | 🟡 中（2-4 周） | 🟢 低风险 | 🟡 中（Bedrock/中转） | ⭐⭐⭐⭐⭐ |
| **C. 参考架构自研** | 🟢 高 | 🔴 高（8-16 周） | 🟢 零风险 | 🟢 高（多模型） | ⭐⭐⭐⭐ |
| **D. 源码反编译** | 🟡 中 | 🔴 极高（16+ 周） | 🔴 **极高风险** | 🔴 阻塞 | ⭐ |

---

## 6. License 与合规风险

### 6.1 License 体系

| 组件 | License | 关键限制 |
|---|---|---|
| `anthropics/claude-code` 公开仓库 | MIT-adjacent（仅限插件示例） | 核心引擎不在此仓库 |
| `@anthropic-ai/claude-code` npm 包 | **UNLICENSED**（Anthropic Commercial ToS） | 禁止反编译、重分发、商业再分发 |
| `@anthropic-ai/claude-agent-sdk` | Anthropic 商业条款，允许第三方使用 | 禁止提供 claude.ai 登录给终端用户 |
| `claude-agent-sdk` (Python) | 同上 | 同上 |
| Skills 仓库 `anthropics/skills` | Apache 2.0（多数）/ source-available（文档类 skill） | 文档类 skill 需 Claude Code 订阅 |

### 6.2 反编译/逆向的法律风险

1. **Anthropic Commercial Terms of Service** 明确禁止：
   - 反编译、反向工程、反汇编
   - 修改、创建衍生作品
   - 再分发、销售、商业利用

2. **DMCA 先例已建立**：Anthropic 已对 GitHub 上的源码镜像仓库发起 DMCA takedown，并成功下架多个仓库。仅"clean room AI 重写"（如 `claw-code` Python 移植）目前在灰色地带存活，但**法律地位未在法庭上得到验证**。

3. **中国法律语境**：
   - 《计算机软件保护条例》第二十一条同样禁止反向工程（除 interoperability 目的）
   - 商业产品集成反编译代码会同时面临 Anthropic 主张与中国法律风险
   - 即使用户在境外，Anthropic 仍可通过应用商店投诉、支付通道施压

4. **clean room 重写的法律不确定性**：
   - 传统 clean room 需要两团队隔离数月，成本极高
   - AI 辅助重写（如 `claw-code` 用 OpenAI Codex 重写）**法律地位未经法庭验证**
   - 不能作为商业产品的合规基础

### 6.3 合规结论

> **方案 D（反编译集成）在合规上不可接受**，无论技术可行性如何。
> 方案 A/B/C 均合规，其中方案 B（Agent SDK）是 Anthropic 官方为第三方集成设计的路径。

---

## 7. 国内可用性

### 7.1 Claude API 国内访问现状

| 维度 | 现状 |
|---|---|
| **Anthropic 官方 API** | ❌ 不向中国大陆用户提供服务；IP/设备/支付多重验证 |
| **账号注册** | 需境外手机号 |
| **支付** | 仅境外信用卡/PayPal；Stripe 对国内卡风控极严 |
| **claude.ai 订阅** | 同样不可用；可通过代付服务（如 ClaudeMax.shop）获得，但违反 ToS |
| **AWS Bedrock** | ✅ 可用，AWS 中国代理商支持对公人民币转账购买额度 |
| **Microsoft Azure Foundry** | ✅ 可用，Azure 中国版（21Vianet）有限支持 |
| **Google Vertex AI** | 🟡 部分可用，需 GCP 海外账号 |

### 7.2 国内访问方案对比

| 方案 | 优点 | 缺点 | 合规性 |
|---|---|---|---|
| **AWS Bedrock**（推荐企业级） | 稳定 SLA、可开发票、对公转账 | 接入方式与官方 API 不同需适配；Mantle 客户端是新路径 | ✅ 合规 |
| **自建 Cloudflare Workers 代理** | 全球 CDN、免费额度大、低延迟 | 需自备域名 + API Key | 🟡 灰色，违反 Anthropic 区域限制 |
| **香港 VPS + Nginx 转发** | 完全自控 | 需运维；仍需海外 API Key | 🟡 灰色 |
| **API 中转平台**（ofox.ai、laozhang.ai 等） | 支付宝充值、国内直连 | 比官方贵 10-20%；不稳定；无官方原始 Key | 🔴 高风险 |
| **香港公司账户 + 官方直连** | 长期最稳 | 注册成本 3000-5000 元 | ✅ 合规但门槛高 |
| **切换国产模型** | 完全合规、国内直连、免费额度 | 能力与 Claude 有差距 | ✅ 完全合规 |

### 7.3 多模型后端策略（推荐）

为规避国内可用性问题，建议 tdsf-linux-desktop **不绑定单一模型后端**，支持多模型切换：

| 模型 | 优势 | 国内可用性 |
|---|---|---|
| **Claude（Opus/Sonnet）** | 代码能力顶尖 | 通过 AWS Bedrock 间接可用 |
| **DeepSeek V4 Pro** | 国产、代码能力突出、免费额度 | ✅ 国内直连 |
| **通义千问 Qwen3** | 中文场景强、阿里云生态 | ✅ 国内直连 |
| **智谱 GLM-4.6** | 每天 500 次免费、MiniMax 等 | ✅ 国内直连 |
| **本地 Ollama 模型** | 完全离线、免费 | ✅ 无网络依赖 |

**cc-switch 等开源工具**已经验证了"Claude Code 协议 + 多模型后端"的可行性，可作为参考。

---

## 8. 对 tdsf-linux-desktop v0.9 的最终建议

### 8.1 推荐方案：B + C 组合（官方 SDK 短期落地 + 架构参考长期演进）

```
v0.9（3-4 周交付）        v1.0+（8-16 周演进）
────────────────────────  ──────────────────────────
方案 B：Agent SDK 集成    方案 C：参考架构自研
├── Electron 主进程       ├── Mastra Agent 层
│   引入 SDK             │   原生工具系统
├── IPC 桥接渲染进程      │   自主 Agent Loop
├── 复用 Claude 工具集    ├── Linux 运维专属工具
└── 自定义 Hooks 注入     │   （SSH/systemd/kubectl）
                          ├── 沙箱机制借鉴
                          └── 多模型后端
```

### 8.2 推荐理由

1. **短期快速落地**：方案 B 让 v0.9 在 3-4 周内获得生产级 Agent 能力，复用 Claude Code 已验证的工程实践（Agent Loop、工具协议、上下文管理、沙箱），无需重新发明轮子。
2. **长期自主可控**：v1.0+ 通过方案 C 演进到完全自主架构，可针对 Linux 运维场景深度定制（如内置 SSH 工具、systemd 操作、kubectl 集成、日志分析），并支持多模型后端规避国内可用性风险。
3. **合规零风险**：两方案均不涉及反编译、重分发，完全在 Anthropic 官方允许范围内。
4. **平滑迁移路径**：方案 B 期间积累的工具协议、Hooks、UI 模式可逐步迁移到方案 C 自研架构。

### 8.3 具体实施建议

#### v0.9 阶段（方案 B 落地）

1. **依赖安装**：
   ```bash
   npm install @anthropic-ai/claude-agent-sdk
   ```
   SDK 会自动捆绑平台原生 Claude Code 二进制作为 optional dependency。

2. **Electron 主进程集成**（新增 `src/main/agent/claude-agent.ts`）：
   ```typescript
   import { query, ClaudeAgentOptions } from "@anthropic-ai/claude-agent-sdk";
   import { ipcMain } from "electron";

   ipcMain.handle("agent:run", async (event, prompt: string, options: ClaudeAgentOptions) => {
     const stream = query({
       prompt,
       options: {
         allowedTools: ["Read", "Edit", "Bash", "Glob", "Grep", "WebSearch"],
         permissionMode: "acceptEdits",
         // 注入 Linux 运维自定义工具
         customTools: [...linuxOpsTools],
         // 注入业务 Hooks
         hooks: {
           PostToolUse: [{ matcher: "Bash", hooks: [auditLogHook] }]
         },
         ...options
       }
     });

     for await (const message of stream) {
       event.sender.send("agent:message", message);
     }
   });
   ```

3. **渲染进程 UI 适配**（React 18）：
   - 监听 `agent:message` IPC 事件
   - 渲染流式输出（thinking、tool_use、text）
   - 显示工具调用历史
   - 工具确认弹窗（permission prompt）

4. **认证策略**：
   - 默认引导用户配置 `ANTHROPIC_API_KEY`
   - 提供设置面板支持切换 `CLAUDE_CODE_USE_BEDROCK=1`（走 AWS Bedrock）
   - 国内用户优先引导 Bedrock 路径

5. **Linux 运维工具集**（通过 customTools 注入）：
   ```typescript
   const linuxOpsTools = [
     {
       name: "ssh_execute",
       description: "在远程 Linux 主机执行命令",
       input_schema: {
         type: "object",
         properties: {
           host: { type: "string" },
           command: { type: "string" }
         },
         required: ["host", "command"]
       },
       async execute({ host, command }) {
         // 复用现有 SSH 模块
       }
     },
     // systemctl_status、journalctl_query、kubectl_apply 等
   ];
   ```

6. **沙箱配置**（参考 Claude Code 设计）：
   - 启用 bubblewrap 沙箱（Linux 原生支持）
   - 配置 `sandbox.credentials.files` 保护 `~/.ssh`、`~/.aws/credentials`
   - 设置 `sandbox.network.allowedDomains` 白名单
   - Windows 用户引导 WSL2

#### v1.0+ 阶段（方案 C 演进）

1. **基于 Mastra 构建 Agent 层**：利用 Mastra 已有的 Agent 框架能力，借鉴 Claude Code 的 Agent Loop 设计。

2. **架构参考点**（不复制代码，借鉴设计）：
   - Agent Loop 的"Plan-Act-Observe"循环模型
   - 5 层 compaction pipeline 的上下文管理
   - Coordinator/Worker 多 agent 编排
   - 8 层权限系统 + 沙箱机制
   - Append-only session 存储（JSONL）
   - CLAUDE.md 层级配置加载机制

3. **多模型后端**：
   - 通过 Mastra 的 model provider 抽象支持多后端
   - 默认 DeepSeek V4 Pro（国内免费可用、代码能力强）
   - 可选切换到通义千问、智谱 GLM、Claude（Bedrock）、本地 Ollama
   - UI 提供模型切换面板（参考 cc-switch 设计）

4. **Linux 运维深度优化**：
   - 原生内置工具集（SSH、systemd、kubectl、Docker、Ansible 等）
   - 运维场景专属 prompt 工程
   - 安全审计日志
   - 凭证管理与多主机连接池

### 8.4 关键风险与缓解

| 风险 | 缓解策略 |
|---|---|
| Agent SDK API 可能变更 | 锁定版本；封装抽象层；关注 changelog |
| Anthropic 限制第三方产品形态 | 严格遵守"不提供 claude.ai 登录给终端用户"条款；仅用 API Key |
| 国内用户访问 Claude 困难 | 默认 DeepSeek/通义千问；Claude 作为可选高级后端 |
| Bun 二进制与 Electron 打包冲突 | TypeScript SDK 已处理平台二进制；测试打包流程 |
| v0.9 → v1.0 迁移成本 | 抽象 Agent 接口；工具协议保持兼容；Hooks 系统设计为通用 |

### 8.5 不推荐事项

- ❌ **不推荐方案 D（反编译集成）**：法律风险不可接受，Anthropic 已主动维权
- ❌ **不推荐方案 A 作为长期方案**：用户体验差，依赖外部安装
- ❌ **不推荐绑定单一 Claude 模型**：国内可用性是硬阻塞
- ❌ **不推荐直接 fork 公开仓库**：核心引擎不在公开仓库中，fork 无意义

---

## 9. 参考资料

### 官方文档
- Claude Code 文档首页：https://code.claude.com/docs
- How Claude Code works（Agent Loop）：https://code.claude.com/docs/en/how-claude-code-works
- Sandbox 配置：https://code.claude.com/docs/en/sandboxing
- Agent SDK 概览：https://code.claude.com/docs/en/agent-sdk
- Agent SDK quickstart：https://platform.claude.com/docs/en/agent-sdk/quickstart.md
- Agent Teams（实验性）：https://code.claude.com/docs/en/agent-teams/
- Loop engineering 博客：https://claude.com/blog/getting-started-with-loops

### GitHub 仓库
- 官方仓库：https://github.com/anthropics/claude-code
- Agent SDK demos：https://github.com/anthropics/claude-agent-sdk-demos
- Anthropic DMCA（2026-03-31）：https://github.com/github/dmca/blob/master/2026/03/2026-03-31-anthropic.md

### npm 包
- CLI：https://www.npmjs.com/package/@anthropic-ai/claude-code
- Agent SDK（TS）：https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk
- Agent SDK（Python）：https://pypi.org/project/claude-agent-sdk/

### 第三方分析
- MBZUAI 源码级架构分析（arXiv:2604.14228v2）：https://arxiv.org/pdf/2604.14228v2
- Engineer's Codex 源码泄露深度分析：https://read.engineerscodex.com/p/diving-into-claude-codes-source-code
- NCC Group AI Coding Agent Security 白皮书：https://www.nccgroup.com/media/jtepwx1t/nccgroup_codingagentswhitepaper.pdf
- Claude Code 多 Agent 编排（CSDN 中文）：https://blog.csdn.net/weixin_63132747/article/details/161321696
- Kinto Technologies 沙箱验证（日文）：https://blog.kinto-technologies.com/posts/2026-03-09-claude-code-sandbox/
- Claude Code 内部架构分析（韩文）：https://bits-bytes-nn.github.io/insights/agentic-ai/2026/03/31/claude-code-source-map-leak-analysis.html
- How Claude Code Actually Works：https://howworks.ai/blog/how-claude-code-actually-works
- Multi-Agent Coordinator 源码分析：https://openedclaude.github.io/claude-reviews-claude/chapters/03-coordinator
- DeepWiki Agentic Loop：https://deepwiki.com/claude-code-best/claude-code/2.2-query-engine-and-conversation-loop

### 国内可用性参考
- 国内团队接入 Claude/GPT API 避坑指南：https://juejin.cn/post/7623591391199608895
- Cloudflare 代理 Claude API 部署指南：https://juejin.cn/post/7522358056317042734
- 国内用户免费使用 Claude 方案：https://cj.sina.cn/articles/view/7879848900/1d5acf3c4068031c32

### Claude API 参考（来自 claude-api skill）
- 当前模型：Opus 4.8（`claude-opus-4-8`）、Sonnet 5、Haiku 4.5
- Adaptive thinking：`thinking: {type: "adaptive"}`
- Compaction beta：`compact-2026-01-12`
- Bedrock 客户端：`AnthropicBedrockMantle`（Mantle 路径，推荐）
- Vertex 客户端：`AnthropicVertex`（裸 model ID，无前缀）

---

## 10. 调研总结

| 关键问题 | 结论 |
|---|---|
| Claude Code 是什么 | Anthropic 官方终端原生 Agent，2025-05 发布，119K stars |
| 是否开源 | **否**。公开仓库仅含插件示例，核心引擎闭源 UNLICENSED |
| npm 包可用性 | `@anthropic-ai/claude-code` 可装；`@anthropic-ai/claude-agent-sdk` 为官方集成路径 |
| 反编译可行性 | 技术可行，**法律禁止**，Anthropic 已 DMCA 维权 |
| 技术栈 | Bun + TypeScript + React/Ink，~2000 文件 / 512K 行 |
| 工具调用协议 | Function Calling + MCP + 自定义工具 |
| Agent Loop | Plan-Act-Observe 循环，LLM 自主判断终止 |
| Subagent 模式 | 四层：Task / Background / Agent Teams / Coordinator |
| 上下文管理 | 200K-1M window + 5 层 compaction + 持久化记忆 |
| 沙箱 | macOS Seatbelt / Linux bubblewrap / Windows 不支持 |
| 反编译 License 风险 | **极高**，强烈不推荐 |
| 国内可用性 | 通过 AWS Bedrock 间接可用；或切换国产模型 |
| **最终推荐** | **方案 B（Agent SDK）+ 方案 C（自研演进）组合** |

---

**调研人**：Trae 子代理（基于 claude-code-expert + claude-api skill 与全网调研）
**报告版本**：v1.0
**下次更新触发条件**：Anthropic 发布 Agent SDK 重大版本 / License 变更 / 国内访问方案重大变化
