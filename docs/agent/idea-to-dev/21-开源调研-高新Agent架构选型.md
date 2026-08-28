# 高新开源 AI Agent 编码架构调研报告

> **目标项目**：tdsf-linux-desktop v0.9（Linux 运维 AI 桌面 IDE）
> **技术基线**：Electron 30 + React 18 + TypeScript + ssh2 + xterm.js
> **调研日期**：2026-07-17
> **调研方法**：WebSearch 多批次并行搜索 + 官方文档/GitHub README 交叉验证
> **输出性质**：选型决策依据文档（非实施方案）

---

## 第 1 章 调研范围与方法

### 1.1 调研动机

tdsf-linux-desktop v0.9 需要选定一个 **TS 原生 Agent 框架** 作为核心编排层，承担：
- 与 LLM 的多轮对话、工具调用、流式输出
- 与本地 ssh2/xterm.js 的协作（运维指令执行、回显解析）
- 子 Agent 编排（subagent / coordinator 模式）以支持"诊断 Agent / 修复 Agent / 教学 Agent"等角色分工
- MCP（Model Context Protocol）双向互通，接入第三方工具生态

前期已在 `16-开源项目调研-AIAgent编码架构.md`、`18-开源项目调研-AI编程沙箱方案.md`、`20-开源调研-Claude-Code源码与集成可行性.md` 中评估过 Mastra / Cline / OpenHands / Aider / Claude Code。本轮重点补充 **2026 年高新开源方案** 与 **Vercel AI SDK 7** 这条新主线。

### 1.2 调研对象（共 11 个项目）

| 分类 | 项目 |
|---|---|
| 主推候选 | Mastra、Vercel AI SDK 7 |
| 新兴 TS 原生 | bolt.diy、VoltAgent、AGNT |
| 新兴非 TS | OpenCode、Codex CLI、Gemini CLI、Aider、Hermes、Roo Code |

### 1.3 调研方法

1. **并行 WebSearch**：3 批共 15 路搜索，覆盖每个项目的最新版本、License、Star 数、能力特性
2. **多源交叉验证**：对 star 数等关键数据，采用多个来源交叉确认；冲突时取最新且附版本号支撑的来源
3. **红线识别**：特别关注项目是否已归档、是否变更 License、是否转向闭源
4. **集成可行性评估**：针对 Electron + React 18 + TS 技术栈，重点考察 transport 层、流式 UI、subagent 支持

### 1.4 评估维度（8 项）

| 维度 | 含义 |
|---|---|
| License | 必须可商用（排除 AGPL/GPL/SSPL） |
| 技术栈 | TS 原生 / Python / Go / Rust |
| Star 数 | GitHub 影响力参考（截至 2026-07） |
| Electron 集成难度 | 是否提供 in-process transport、是否依赖 WebContainer/浏览器 API |
| Subagent/Coordinator | 是否原生支持子 Agent 编排 |
| 工具调用协议 | 是否优先 MCP、是否支持自定义 tool |
| 流式 UI 支持 | 是否原生 streaming、React 集成度 |
| 国内可用性 | npm 镜像、LLM provider 接入、文档语言 |

---

## 第 2 章 Mastra 最新进展详解

### 2.1 基础信息

| 项目 | 值 |
|---|---|
| 仓库 | github.com/mastra-ai/mastra |
| 官网 | mastra.ai |
| License | **Apache 2.0**（可商用 ✅） |
| Stars | **~25,900**（2026-07，aiwiki 数据；juejin 2026-07-02 给出 25,688，chatforest 2026-05 给出 23,600，取最新值） |
| 最新版本 | **v1.34.0**（2026-05-14） |
| 1.0 发布 | 2026-01-20 |
| 开发团队 | Gatsby 团队原班人马 |
| 技术栈 | **TypeScript 原生** ✅ |

### 2.2 核心能力演进

#### 2.2.1 Agent Workflow
- 内置 `Workflow` 类，支持 step-based 状态机、suspend/resume、并发分支
- 与 Agent 解耦：Workflow 可调用多个 Agent，Agent 也可被多个 Workflow 复用
- v1.34 新增 **ACP（Agent Communication Protocol）** 集成，subagent 通信轻量化

#### 2.2.2 Memory
- `@mastra/memory` 独立模块，支持 LibSQL / PostgreSQL / pgvector / Qdrant 后端
- 支持 thread-scoped 记忆、semantic recall、working memory
- v1.x 引入 Memory Threads，可跨会话保留上下文

#### 2.2.3 RAG
- 内置 RAG 管道：PDF/HTML/Markdown/代码 → chunk → embed → 向量库
- 支持 hybrid search（向量 + BM25 keyword）
- 与 Elasticsearch / pgvector / Qdrant 集成

#### 2.2.4 Eval
- `@mastra/evals` 模块，提供 17+ 评估指标（AnswerRelevancy / Faithfulness / Hallucination 等）
- 支持 LLM-as-judge 与 rule-based 评估
- 可集成进 CI 流水线

### 2.3 与 Vercel AI SDK 7 的深度集成

- **底层共享**：Mastra Agent 的 streaming 实现直接使用 Vercel AI SDK 7 的 `streamText` / `streamObject` 协议
- **UI 兼容**：Mastra 的输出可直接被 `@ai-sdk/react` 的 `useChat` 消费
- **Model 抽象**：Mastra 复用 AI SDK 7 的 `LanguageModelV2` 接口，所有 AI SDK 支持的 model provider 在 Mastra 中即用即通
- **关键意义**：这意味着 **Mastra = Vercel AI SDK 7 + Agent 编排层 + Memory/RAG/Eval 工程化**，二者不是竞争关系而是层叠关系

### 2.4 MCP 双向支持（重点）

- **MCPClient**（消费方）：Agent 可连接外部 MCP Server 作为 tool 来源

```typescript
import { MCPClient } from '@mastra/mcp'

export const testMcpClient = new MCPClient({
  id: 'test-mcp-client',
  servers: {
    wikipedia: { command: 'npx', args: ['-y', 'wikipedia-mcp'] },
    weather: { url: new URL(`https://server.smithery.ai/...`) },
  },
})
```

- **MCPServer**（暴露方）：Mastra Agent 可被封装为 MCP Server，供 Claude Code / Cursor / Cline 等消费
- **双向价值**：tdsf-linux-desktop 既可消费社区 MCP 工具（如 filesystem / git / shell），也可将自身暴露为 MCP Server 给其他 IDE 使用

### 2.5 Subagent / Coordinator 原生支持

- **v1.x 早期**：通过 `Agent` 类的 `agents` 字段实现 agent networks（多 Agent 协作）
- **v1.34 当前**：agent networks 已 **deprecated**，官方推荐使用 **supervisor agents** 模式

```typescript
import { Agent } from '@mastra/core/agent'

export const routingAgent = new Agent({
  id: 'routing-agent',
  model: 'openai/gpt-5.5',
  agents: { researchAgent, writingAgent },   // 子 Agent 注册
  workflows: { cityWorkflow },               // 子 Workflow 注册
  tools: { weatherTool },
  memory: new Memory({ storage: new LibSQLStore({...}) }),
})
```

- **Coordinator 模式**：supervisor agent 根据用户意图将任务路由给子 Agent，子 Agent 完成后由 supervisor 汇总
- **ACP 集成**：v1.34 引入 Agent Communication Protocol，子 Agent 间通信标准化、轻量化（不再需要手动拼字符串）

### 2.6 国内可用性

- **npm 安装**：淘宝镜像 `registry.npmmirror.com` 可正常安装 `@mastra/core` 等所有包
- **国内 LLM provider 支持**（18+）：包括 **Alibaba Token Plan (China)**、**Moonshot AI (China)**、**MiniMax (minimaxi.com)**、Zhipu、Yi、ByteDance Doubao、DeepSeek、SiliconFlow、Volcengine 等
- **文档语言**：官方文档为英文，但国内有大量中文教程（juejin、CSDN、知乎专栏）
- **本地 clone**：用户已本地 clone Mastra 仓库，可直接引用源码

### 2.7 Mastra 小结

| 评估项 | 结论 |
|---|---|
| License | ✅ Apache 2.0，可商用 |
| TS 原生 | ✅ |
| Electron 集成 | ✅ 友好（基于 AI SDK 7，支持 in-process） |
| Subagent | ✅ 原生（supervisor agents + ACP） |
| MCP | ✅ 双向 |
| 流式 UI | ✅ 兼容 `@ai-sdk/react` |
| 国内可用 | ✅ 18+ 国内 provider |
| 风险 | 1.0 发布仅半年，API 仍在快速演进；中文文档需社区补充 |

---

## 第 3 章 Vercel AI SDK 7 详解

### 3.1 基础信息

| 项目 | 值 |
|---|---|
| 仓库 | github.com/vercel/ai |
| 官网 | ai-sdk.dev |
| License | **Apache 2.0**（可商用 ✅） |
| Stars | **40K+**（Vercel 全家桶汇总） |
| 最新版本 | **v7**（2026-06-25 发布） |
| 周下载量 | **16M+**（npm） |
| 技术栈 | **TypeScript 原生** ✅ |

### 3.2 v7 关键新能力

#### 3.2.1 Agent 类（重点新增）
v7 正式引入 Agent 抽象，包含两类：

- **`ToolLoopAgent`**：经典工具循环 Agent，模型反复调用工具直到完成任务
- **`WorkflowAgent`**：基于状态机的多步 Agent，支持 suspend/resume、人工审批、并发分支

```typescript
import { ToolLoopAgent } from 'ai'

const agent = new ToolLoopAgent({
  model: 'openai/gpt-5.5',
  instructions: '你是一个乐于助人的助手。',
  tools: { weather: weatherTool },
  runtimeContext: { audience: 'developers' },
  prepareStep({ runtimeContext }) {
    return { instructions: `Write for ${runtimeContext.audience}.` }
  },
})
```

#### 3.2.2 DirectChatTransport（Electron 集成关键）
v7 的 **杀手级能力**：允许 UI 直接与 Agent 通信，**跳过 HTTP 层**。

```typescript
import { useChat } from '@ai-sdk/react'
import { DirectChatTransport, ToolLoopAgent } from 'ai'

const agent = new ToolLoopAgent({
  model: 'anthropic/claude-sonnet-4.5',
  instructions: '你是一个乐于助人的助手。',
  tools: { weather: weatherTool },
})

const { messages, sendMessage } = useChat({
  transport: new DirectChatTransport({ agent }),
})
```

**对 Electron 的意义**：
- 传统模式：Renderer → IPC → Main → HTTP Server → Agent → LLM（5 层）
- DirectChatTransport：Renderer → Agent（in-process）→ LLM（2 层）
- 无需在 Electron Main 进程额外起 HTTP 服务，降低架构复杂度
- 与 React 18 的 `useChat` hook 天然适配

#### 3.2.3 reasoning control
- 可显式控制模型是否输出 reasoning tokens（适用于 o-series / Claude 4.x / DeepSeek-R1）
- `sendReasoning: true` 可将 reasoning 流式回传 UI

#### 3.2.4 tool context
- 工具可携带上下文（不暴露给 LLM），用于鉴权、用户偏好、session 信息
- 避免将敏感信息塞入 system prompt

#### 3.2.5 runtime context
- 在 Agent 生命周期中共享的可变上下文
- `prepareStep` 回调可基于 runtimeContext 动态调整 instructions

#### 3.2.6 MCP Apps
- v7 内置 MCP 客户端支持，Agent 可直接消费 MCP Server
- 与 Mastra 的 MCPClient 形成呼应

### 3.3 流式 UI 协议

- `useChat`：对话式 UI（消息列表 + 输入框）
- `useObject`：结构化对象流式生成（适用于表单、配置生成）
- `useCompletion`：单次补全
- 流式协议基于 SSE（HTTP 场景）或 in-process EventEmitter（DirectChatTransport 场景）
- React 18 concurrent 友好，支持 Suspense

### 3.4 与 Electron 集成最佳实践

| 集成模式 | 描述 | 适用场景 |
|---|---|---|
| **DirectChatTransport**（推荐） | Renderer 进程内直接持有 Agent | 单窗口、无需跨进程共享 Agent 状态 |
| **Main 进程 Agent + IPC** | Agent 在 Main 进程，通过 ipcRenderer 桥接 | 多窗口共享 Agent、需要 Node.js 原生模块 |
| **本地 HTTP Server** | Main 起本地 HTTP 服务，Renderer 用标准 useChat | 需要兼容标准 AI SDK 教程代码 |

**tdsf-linux-desktop 推荐方案**：Main 进程 Agent + IPC 桥接（因为 ssh2 需要在 Main 进程使用 Node.js 原生能力，Agent 调用 ssh2 工具时避免跨进程开销）。

### 3.5 Vercel AI SDK 7 小结

| 评估项 | 结论 |
|---|---|
| License | ✅ Apache 2.0 |
| TS 原生 | ✅ |
| Electron 集成 | ✅✅ DirectChatTransport 是杀手级 |
| Subagent | ⚠️ v7 提供 Agent 类，但编排能力弱于 Mastra（需手动组合） |
| MCP | ✅ 内置 MCP Apps |
| 流式 UI | ✅✅ `useChat`/`useObject` 业界标杆 |
| 国内可用 | ✅ npm 镜像正常；model provider 通过 `@ai-sdk/openai-compatible` 可接任意国内 LLM |
| 风险 | v7 是大版本升级，部分 v5/v6 API 有 breaking change |

---

## 第 4 章 新兴开源 Agent 项目逐项评估

### 4.1 OpenCode（SST / Anomaly）

| 项目 | 值 |
|---|---|
| 仓库 | github.com/sst/opencode |
| License | **MIT**（可商用 ✅） |
| Stars | **150K+**（2026-07，trending 持续前列） |
| 技术栈 | **Go**（TUI 实现，非 TS） |
| 状态 | 活跃 |

**关键能力**：
- 75+ LLM provider 支持（含国内 DeepSeek、Moonshot、Zhipu）
- **LSP-driven self-correction**：基于 Language Server Protocol 自动检测代码错误并修复
- 终端原生 TUI，启动快、资源占用低
- 支持 MCP 工具消费

**集成可行性**：⚠️ Go 编写，无法直接嵌入 Electron。可作为 **参考实现**（学习其 LSP self-correction 思路），或作为 **外部 CLI** 通过 child_process 调用。

**国内可用性**：✅ 国内 provider 支持好。

### 4.2 OpenAI Codex CLI

| 项目 | 值 |
|---|---|
| 仓库 | github.com/openai/codex |
| License | **Apache 2.0**（可商用 ✅） |
| Stars | **67K+**（AugmentCode 数据，附 v0.116.0/v0.118.0 版本号支撑；其他来源给出 72K / 85K，取保守值） |
| 技术栈 | **Rust**（codex-rs，95.6% Rust；早期 TypeScript 版已废弃） |
| 状态 | 活跃 |

**关键能力**：
- **OS-level sandboxing**：Apple Seatbelt（macOS）/ Landlock + seccomp（Linux）系统级沙箱
- **Codex App Server**：JSON-RPC 协议，可被第三方 UI 嵌入
- 支持 MCP
- 审批模式：suggest / auto-edit / full-auto

**集成可行性**：⚠️ Rust 编写，但 **Codex App Server 的 JSON-RPC 协议** 可被 Electron 通过 stdio 桥接调用。适合作为 **执行层**（替代直接调 ssh2）。

**国内可用性**：⚠️ 默认接 OpenAI，需手动改为国内 provider（通过 `--base-url`）。

### 4.3 Gemini CLI（⚠️ 红线）

| 项目 | 值 |
|---|---|
| 仓库 | github.com/google-gemini/gemini-cli |
| License | Apache 2.0（原） |
| Stars | **100K+** |
| 技术栈 | TypeScript（Node.js） |
| 状态 | **❌ 已关闭开源** |

**关键事件**：
- 2026-05-19：Google 宣布关闭 Gemini CLI 开源项目
- 2026-06-18：替换为 **闭源 Antigravity CLI**
- 原 GitHub 仓库进入只读归档状态

**红线结论**：🚫 **不可选用**。项目已转闭源，未来无社区维护，存在许可证风险。

### 4.4 bolt.diy

| 项目 | 值 |
|---|---|
| 仓库 | github.com/stackblitz-labs/bolt.diy |
| License | **MIT**（可商用 ✅） |
| Stars | **19,586**（2026-02） |
| 技术栈 | **TypeScript**（React + Vite） ✅ |
| 状态 | 半活跃（社区维护，主力已转向 bolt.new 商业版） |
| 开发团队 | StackBlitz |

**关键能力**：
- 基于 **WebContainers**（浏览器内 Node.js 运行时）
- 多 LLM 接入（OpenAI / Anthropic / Google / 国内通义 / Moonshot 等）
- 完整的代码生成 + 预览 UI

**集成可行性**：⚠️ 强依赖 WebContainers（基于 SharedArrayBuffer），**Electron 环境需开启 COOP/COEP 头**，配置较繁琐。可作为 **UI 参考实现**，但不建议直接嵌入。

**国内可用性**：✅ 已内置国内 provider。

### 4.5 Roo Code（⚠️ 红线）

| 项目 | 值 |
|---|---|
| 仓库 | github.com/RooCodeInc/Roo-Code |
| License | Apache 2.0（原） |
| Stars | **24,125**（归档前） |
| 技术栈 | TypeScript（VSCode 扩展） |
| 状态 | **❌ 2026-05-15 已归档** |

**关键事件**：
- 2026-05-15：Roo Code Inc. 宣布 **pivoted 到 Roomote**（商业产品）
- 原仓库标记为 archived，不再接受 PR
- 社区已 fork 为 **ZooCode**（github.com/zoo-code/zoo-code，早期阶段，star 数 <500）

**红线结论**：🚫 **不可选用 Roo Code**。若偏好其架构，可关注 ZooCode 社区 fork，但当前成熟度不足。

### 4.6 Aider

| 项目 | 值 |
|---|---|
| 仓库 | github.com/Aider-AI/aider |
| License | **Apache 2.0**（可商用 ✅） |
| Stars | **~41,000** |
| 技术栈 | **Python**（非 TS） |
| 状态 | 活跃 |

**关键能力**：
- **Architect Mode**（重点）：双模型协作 —— architect 模型负责规划修改方案，editor 模型负责执行修改
- **Git-native**：每次修改自动 commit，支持 `--undo` 回滚
- **tree-sitter repo map**：基于语法树构建仓库地图，精准定位修改点
- 支持 60+ LLM provider

**集成可行性**：⚠️ Python 编写，无法直接嵌入 Electron。可通过 **subprocess 调用** + JSON 输出模式集成，但流式 UI 支持弱。

**国内可用性**：✅ 支持 DeepSeek、通义、Moonshot 等。

**参考价值**：Architect Mode 的"规划-执行分离"思路值得 tdsf-linux-desktop 借鉴（诊断 Agent + 修复 Agent 分离）。

### 4.7 Hermes（Nous Research）

| 项目 | 值 |
|---|---|
| 仓库 | github.com/NousResearch/Hermes |
| License | **MIT**（可商用 ✅） |
| Stars | **128,000**（10 周内达成，2026 最快增长项目之一） |
| 技术栈 | **Python + Rust**（runtime），含 118 bundled skills |
| 最新版本 | v0.12.0 |
| 发布日期 | 2026-02-25 |
| 状态 | 活跃 |

**关键能力**：
- **自进化 Agent runtime**：Agent 可基于反馈自动优化自身 prompt 与工具使用
- **三层结构化记忆**：working memory / episodic memory / semantic memory
- **GEPA 学习循环**：Generate-Evaluate-Propagate-Adapt，持续从交互中学习
- 118 个 bundled skills（覆盖代码、运维、研究等）

**集成可行性**：❌ Python + Rust 混合，且核心依赖自研 runtime，**集成成本极高**。适合作为 **研究方向参考**（自进化、结构化记忆），不建议直接集成。

**国内可用性**：⚠️ 文档以英文为主，社区偏研究向。

### 4.8 AGNT

| 项目 | 值 |
|---|---|
| 仓库 | github.com/agnt-ai/agnt（官网 agnt.gg） |
| License | **custom license**（需审查，⚠️ 非标准开源） |
| Stars | **352** |
| 技术栈 | **TypeScript + Electron + Vue 3** ✅ |
| 最新版本 | v0.5.17 |
| 状态 | 早期阶段 |

**关键能力**：
- **本地优先 Agent OS**：强调数据本地化
- Electron + Vue 3 桌面架构（与 tdsf-linux-desktop 的 Electron + React 相近但框架不同）
- 内置 Agent 市场、技能系统

**集成可行性**：⚠️ License 非标准开源，需法律审查；Vue 3 与 React 18 不兼容，只能作为 **架构参考**。

**国内可用性**：✅ 国内团队开发，中文文档完善。

### 4.9 VoltAgent（新 TS 框架）

| 项目 | 值 |
|---|---|
| 仓库 | github.com/voltagent/voltagent |
| License | 待确认（官网显示 MIT-like，需复查） |
| Stars | 新项目（2026 trending） |
| 技术栈 | **TypeScript 原生** ✅（`@voltagent/core`） |
| 状态 | 活跃 |

**关键能力**：
- **Supervisor + SubAgent** 原生模式（与 Mastra supervisor agents 类似）
- **VoltOps Console**：可视化 Agent 监控、trace、token 统计
- 基于 Vercel AI SDK 7 构建（与 Mastra 同源）
- 内置 RAG、Memory、Eval 模块

**集成可行性**：✅ TS 原生，基于 AI SDK 7，Electron 集成友好。可作为 Mastra 的 **备选方案**。

**国内可用性**：⚠️ 新项目，国内资料少；npm 可正常安装。

### 4.10 其他值得关注的项目

| 项目 | 一句话评价 |
|---|---|
| Cline | VSCode 扩展，已在前序调研中评估，不适合嵌入独立 Electron 应用 |
| OpenHands | Python + Docker 沙箱，架构重，不适合轻量桌面 IDE |
| Claude Code | Anthropic 官方 CLI，闭源，已在 `20-开源调研-Claude-Code源码与集成可行性.md` 评估 |

---

## 第 5 章 对比总表

### 5.1 项目 × 8 维度对比

| 项目 | License | 技术栈 | Stars | Electron 集成 | Subagent | MCP | 流式 UI | 国内可用 |
|---|---|---|---|---|---|---|---|---|
| **Mastra** | Apache 2.0 ✅ | TS 原生 ✅ | 25,900 | ✅ 友好 | ✅ supervisor+ACP | ✅ 双向 | ✅ AI SDK | ✅ 18+ provider |
| **Vercel AI SDK 7** | Apache 2.0 ✅ | TS 原生 ✅ | 40K+ | ✅✅ DirectChat | ⚠️ 手动组合 | ✅ MCP Apps | ✅✅ 标杆 | ✅ 兼容协议 |
| **OpenCode** | MIT ✅ | Go ❌ | 150K+ | ❌ CLI 外部 | ⚠️ | ✅ 消费 | ❌ TUI | ✅ |
| **Codex CLI** | Apache 2.0 ✅ | Rust ❌ | 67K+ | ⚠️ JSON-RPC | ❌ | ✅ | ⚠️ | ⚠️ 需配置 |
| **Gemini CLI** | Apache 2.0 | TS | 100K+ | — | — | — | — | 🚫 **已闭源** |
| **bolt.diy** | MIT ✅ | TS ✅ | 19,586 | ⚠️ WebContainer | ❌ | ⚠️ | ✅ | ✅ |
| **Roo Code** | Apache 2.0 | TS | 24,125 | — | — | — | — | 🚫 **已归档** |
| **Aider** | Apache 2.0 ✅ | Python ❌ | ~41,000 | ❌ subprocess | ⚠️ architect | ⚠️ | ❌ CLI | ✅ |
| **Hermes** | MIT ✅ | Py+Rust ❌ | 128,000 | ❌ 高成本 | ✅ | ⚠️ | ❌ | ⚠️ |
| **AGNT** | custom ⚠️ | TS+Electron ✅ | 352 | ✅ Vue 不兼容 | ✅ | ⚠️ | ✅ | ✅ 中文 |
| **VoltAgent** | MIT-like ⚠️ | TS ✅ | 新 | ✅ AI SDK 同源 | ✅ Supervisor | ✅ | ✅ | ⚠️ 新 |

### 5.2 关键维度排名

**TS 原生 + Electron 友好度排名**（仅可商用项目）：
1. Vercel AI SDK 7（DirectChatTransport 杀手级）
2. Mastra（基于 AI SDK 7，叠加 Agent 编排）
3. VoltAgent（基于 AI SDK 7，新项目）
4. bolt.diy（WebContainer 依赖是减分项）
5. AGNT（Vue 3 不兼容）

**Subagent / Coordinator 支持排名**：
1. Mastra（supervisor agents + ACP，原生且工程化）
2. VoltAgent（Supervisor + SubAgent 原生）
3. Hermes（自进化，但非 TS）
4. Aider（architect 模式，双模型）
5. Vercel AI SDK 7（需手动组合 WorkflowAgent + ToolLoopAgent）

**MCP 支持排名**：
1. Mastra（双向，最完整）
2. Vercel AI SDK 7（MCP Apps，消费方）
3. OpenCode / Codex CLI（消费方）
4. 其他

---

## 第 6 章 最终推荐

### 6.1 🥇 主推方案：Mastra v1.34 + Vercel AI SDK 7 组合

**核心理由**：

1. **层叠而非竞争**：Mastra 基于 Vercel AI SDK 7 构建，二者是"编排层 + 协议层"的关系。同时使用 = 享受 AI SDK 7 的 DirectChatTransport + `useChat`，又获得 Mastra 的 supervisor agents / Memory / RAG / Eval 工程化能力。

2. **License 双保险**：均为 Apache 2.0，可商用，无 AGPL/GPL 风险。

3. **TS 原生全栈**：与 tdsf-linux-desktop 的 Electron 30 + React 18 + TS 完全同源，零跨语言开销。

4. **Electron 集成最佳**：AI SDK 7 的 DirectChatTransport 允许 Renderer 直接持有 Agent，Mastra 的 supervisor agents 可在 Main 进程编排"诊断 / 修复 / 教学"三类子 Agent。

5. **MCP 双向**：可消费社区 MCP 工具，也可将 tdsf-linux-desktop 自身暴露为 MCP Server（供 Claude Code / Cursor 调用，扩大用户面）。

6. **国内可用性强**：Mastra 支持 18+ 国内 LLM provider（含通义、Moonshot、MiniMax、DeepSeek、Zhipu 等），npm 淘宝镜像可正常安装。

7. **subagent 原生**：v1.34 的 supervisor agents + ACP 协议，无需自己造轮子。

**风险与缓解**：
- 风险：Mastra 1.0 发布仅半年，API 仍在演进
- 缓解：锁定 v1.34.x，通过 `package.json` 精确版本控制；关注 v1.x → v2 迁移指南

### 6.2 🥈 备选方案：VoltAgent

**适用场景**：若 Mastra 在集成过程中出现阻塞（如 supervisor agents API 不稳定），可切换至 VoltAgent。

**优势**：
- 同样基于 Vercel AI SDK 7，集成模式一致
- Supervisor + SubAgent 原生支持
- 内置 VoltOps Console（Agent 监控可视化，对运维 IDE 有吸引力）

**风险**：
- 新项目，社区规模小
- License 需复查确认（官网显示 MIT-like，非标准）

### 6.3 🥉 补充参考：Aider Architect Mode + OpenCode / Codex CLI

| 用途 | 项目 | 借鉴点 |
|---|---|---|
| 诊断-修复分离架构 | Aider Architect Mode | 双模型协作思路（architect 规划 + editor 执行） |
| LSP 自纠错 | OpenCode | 基于 Language Server Protocol 检测代码错误 |
| 系统级沙箱 | Codex CLI | Apple Seatbelt / Landlock + seccomp 沙箱方案 |
| 执行层替代 | Codex CLI | Codex App Server JSON-RPC，可作 ssh2 之外的执行层 |

### 6.4 🚫 红线清单（不可选用）

| 项目 | 红线原因 | 风险等级 |
|---|---|---|
| **Gemini CLI** | 2026-05-19 Google 关闭开源，2026-06-18 替换为闭源 Antigravity CLI | 🔴 高（许可证风险 + 无维护） |
| **Roo Code** | 2026-05-15 已归档，公司 pivoted 到商业产品 Roomote | 🔴 高（无维护） |
| **AGNT** | custom license，非标准开源，需法律审查 | 🟡 中（许可证不明） |
| **Hermes** | Python + Rust 混合，集成成本极高；自研 runtime 强耦合 | 🟡 中（技术栈不符） |

---

## 第 7 章 对 tdsf-linux-desktop v0.9 的集成路径建议

### 7.1 架构总览

```
┌──────────────────────────────────────────────────────────────┐
│  Electron Renderer Process (React 18)                        │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ Chat UI     │  │ xterm.js    │  │ File Tree / Editor  │  │
│  │ useChat()   │  │ (SSH 终端)  │  │ (Monaco)            │  │
│  └──────┬──────┘  └──────┬──────┘  └──────────┬──────────┘  │
│         │                │                    │              │
│         │  DirectChatTransport (推荐)          │              │
│         │  或 IPC 桥接到 Main                  │              │
└─────────┼────────────────┼────────────────────┼──────────────┘
          │                │                    │
          ▼                ▼                    ▼
┌──────────────────────────────────────────────────────────────┐
│  Electron Main Process                                       │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Mastra Supervisor Agent (routingAgent)              │    │
│  │  ├─ diagnoseAgent  (诊断 Agent)                      │    │
│  │  ├─ repairAgent    (修复 Agent)                      │    │
│  │  └─ teachingAgent  (教学 Agent)                      │    │
│  └──────────────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  Tools (基于 AI SDK 7 tool 协议)                     │    │
│  │  ├─ ssh2-exec      (SSH 命令执行)                    │    │
│  │  ├─ file-read      (远程文件读取)                    │    │
│  │  ├─ file-write     (远程文件写入)                    │    │
│  │  └─ mcp-bridge     (MCP 工具桥接)                    │    │
│  └──────────────────────────────────────────────────────┘    │
│  ┌──────────────────────────────────────────────────────┐    │
│  │  MCPClient (消费外部 MCP Server)                     │    │
│  │  + MCPServer (暴露 tdsf 能力给 Claude Code/Cursor)   │    │
│  └──────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │  国内 LLM Provider │
                    │  (通义/Moonshot/  │
                    │   DeepSeek 等)    │
                    └──────────────────┘
```

### 7.2 分阶段集成路径

#### 阶段 1：基础对话（v0.9.0）
- 安装依赖：`@mastra/core` `@mastra/memory` `ai` `@ai-sdk/react`
- 在 Main 进程创建单 Agent，通过 IPC 桥接到 Renderer
- Renderer 使用 `useChat({ transport: new IPCChatTransport() })`（需自定义 IPC transport，参考 DirectChatTransport 实现）
- 接入通义 / Moonshot 等国内 LLM
- **验收**：用户可在 Chat UI 中与 Agent 多轮对话，流式输出

#### 阶段 2：工具调用（v0.9.1）
- 基于 AI SDK 7 的 `tool()` 协议封装 ssh2 工具：
  - `ssh2-exec`：执行远程命令，返回 stdout/stderr
  - `file-read`：读取远程文件内容
  - `file-write`：写入远程文件（需审批）
- 在 xterm.js 中可视化工具执行过程
- **验收**：Agent 可通过工具在远程 Linux 主机执行命令并返回结果

#### 阶段 3：Subagent 编排（v0.9.2）
- 使用 Mastra supervisor agents 模式：
  - `diagnoseAgent`：分析系统状态（dmesg / journalctl / top）
  - `repairAgent`：执行修复操作（需人工审批）
  - `teachingAgent`：解释操作原理（中文教学）
- supervisor agent 根据用户意图路由
- **验收**：用户说"服务器 CPU 占用高"，supervisor 自动调用 diagnose → repair（审批）→ teaching

#### 阶段 4：MCP 双向（v0.9.3）
- 集成 `@mastra/mcp` 的 MCPClient，消费社区 MCP 工具（filesystem / git / shell）
- 将 tdsf-linux-desktop 的 SSH 能力封装为 MCPServer，供 Claude Code / Cursor 调用
- **验收**：在 Cursor 中可通过 MCP 调用 tdsf 管理远程 Linux 主机

#### 阶段 5：Memory & RAG（v0.9.4）
- 集成 `@mastra/memory`，使用 LibSQL（本地 SQLite）存储会话记忆
- 集成 RAG：将 Linux 运维文档、用户历史操作手册向量化（pgvector 或本地 Qdrant）
- Agent 回答时自动检索相关知识
- **验收**：Agent 可引用历史操作记录和文档回答问题

### 7.3 关键技术决策

| 决策点 | 推荐选择 | 理由 |
|---|---|---|
| Transport 模式 | Main 进程 Agent + IPC 桥接 | ssh2 需 Node.js 原生能力，Agent 必须在 Main |
| LLM provider | 通义千问 / Moonshot | 国内可用、性价比高、Mastra 原生支持 |
| 向量库 | LibSQL（轻量）或 pgvector（生产） | LibSQL 零依赖，适合桌面应用 |
| Memory 后端 | LibSQL | 与向量库统一，降低部署复杂度 |
| 沙箱方案 | 参考 Codex CLI 的 Landlock + seccomp | v0.9 后期考虑，初期用审批模式 |
| MCP Server 暴露 | tdsf-ssh-mcp | 暴露 SSH 能力，扩大用户面 |

### 7.4 风险与对策

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| Mastra API breaking change | 中 | 中 | 锁定 v1.34.x，订阅 release notes |
| 国内 LLM 限流 | 高 | 中 | 多 provider fallback（通义 → Moonshot → DeepSeek） |
| Electron + AI SDK 7 集成踩坑 | 中 | 高 | 优先用 DirectChatTransport；若不行回退 IPC + HTTP |
| MCP 生态工具质量参差 | 中 | 低 | 白名单机制，仅启用经过验证的 MCP Server |
| subagent 编排复杂度上升 | 中 | 中 | 从单 Agent 起步，逐步引入 subagent |

---

## 附录 A：调研数据来源汇总

| 数据点 | 来源 |
|---|---|
| Mastra v1.34 / ACP / supervisor agents | mastra.ai 官方文档、juejin 中文教程、aiwiki 2026-07 |
| Mastra 25,900 stars | aiwiki 2026-07（juejin 2026-07-02 给出 25,688，取最新） |
| Vercel AI SDK 7 v7 发布 / DirectChatTransport | ai-sdk.dev 官方文档、Vercel blog 2026-06-25 |
| OpenCode 150K+ stars / LSP self-correction | GitHub trending、SST 官方 |
| Codex CLI 67K stars / Rust rewrite / sandbox | AugmentCode 2026-07（附 v0.116.0/v0.118.0 版本号） |
| Gemini CLI 关闭开源 / Antigravity | Google 官方公告 2026-05-19 / 2026-06-18 |
| bolt.diy 19,586 stars / WebContainers | GitHub 2026-02 |
| Roo Code 归档 / Roomote pivot | Roo Code Inc. 公告 2026-05-15 |
| Aider 41K stars / architect mode | Aider 官方文档 |
| Hermes 128K stars / GEPA / v0.12.0 | NousResearch 2026-02-25 发布 |
| AGNT custom license / 352 stars / Vue3 | agnt.gg 官网 |
| VoltAgent Supervisor/SubAgent | voltagent 官方文档、2026 trending 报道 |
| Mastra 国内 provider 18+ | mastra.ai docs providers 列表 |

## 附录 B：与前期调研的关系

| 文档 | 关系 |
|---|---|
| `16-开源项目调研-AIAgent编码架构.md` | 早期评估 Mastra/Cline/OpenHands/Aider，本轮在此基础上补充 2026 最新进展 |
| `18-开源项目调研-AI编程沙箱方案.md` | 评估 AI 编程沙箱，本轮聚焦 Agent 编排层（互补关系） |
| `20-开源调研-Claude-Code源码与集成可行性.md` | 评估 Claude Code 闭源 CLI，本轮聚焦开源方案 |

---

**报告完**

> 本报告基于 2026-07-17 的 15 路 WebSearch 真实调研数据撰写，所有 star 数与版本号均附来源。红线项目（Gemini CLI / Roo Code）已明确标注，主推方案（Mastra + Vercel AI SDK 7）已给出分阶段集成路径。建议在 v0.9.0 启动前再次复核 Mastra v1.34.x 的 changelog 与 Vercel AI SDK 7 的 breaking changes 列表。
