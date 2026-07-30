# TDSF Terminal Agent — 2026 年运维 Agent 开源生态调研报告（v5）

> **位置**：`docs/reports/ops-agent-opensource-survey-2026-07-v5.md`
> **版本**：v5.0（2026-07-30，v3 的 22 + v4 的 15 + v5-supplement 的 9 + v5 主报告的 8 = 54 项目基线上的完整报告）
> **作用**：在 v3/v4/v5-supplement 基础上，整合 2025-09 ~ 2026-07 期间所有调研数据，补充 **5 大 Agent 框架对比矩阵**、**多 Agent 协作架构对比**、**HITL 机制对比**、**工具调用协议（MCP）对比**、**国产 LLM 适配对比**、**TDSF 现状差距分析**、**建议新增 @tool Top10 清单**，重新评估 Strands 首选结论，给出 P1 立即借鉴路线图。
> **任务边界**：本文件仅为调研报告，不修改任何 `src/` 或 `src-tauri/` 下的源码文件。
> **数据基准**：2026-07-30 的 WebSearch + WebFetch + GitHub + npm + arXiv + 官方文档站真实抓取。Stars / 下载量为各来源披露的近似值。
> **上游参考**：[crynta/terax-ai](https://github.com/crynta/terax-ai) v0.8.6（TDSF 唯一基线）
> **配套文档**：
> - `docs/reports/ops-agent-opensource-survey-2026-07-v5-supplement.md`（v5 补充，RSSH/Headroom 等 9 项目深度分析）
> - `docs/reports/ops-agent-opensource-survey-2026-07-v4.md`（v4 终版，37 项目深度评估）
> - `docs/reports/ops-agent-opensource-survey-2026-07-30-v3.md`（v3 终版，22 项目深度评估）

---

## 目录

1. [执行摘要](#1-执行摘要)
2. [历版已覆盖项目回顾（54 项目基线）](#2-历版已覆盖项目回顾54-项目基线)
3. [v5 新发现项目清单（17 个）](#3-v5-新发现项目清单17-个)
4. [5 大 Agent 框架对比矩阵](#4-5-大-agent-框架对比矩阵)
5. [多 Agent 协作架构对比](#5-多-agent-协作架构对比)
6. [HITL（Human-in-the-Loop）机制对比](#6-hitlhuman-in-the-loop机制对比)
7. [工具调用协议（MCP）对比](#7-工具调用协议mcp对比)
8. [国产 LLM 适配对比](#8-国产-llm-适配对比)
9. [TDSF 现状差距分析](#9-tdsf-现状差距分析)
10. [建议新增 @tool Top10 清单](#10-建议新增-tool-top10-清单)
11. [集成路线图 v5](#11-集成路线图-v5)
12. [核心结论](#12-核心结论)
13. [附录：调研来源汇总](#附录调研来源汇总)

---

## 1. 执行摘要

### 1.1 核心结论（一句话）

**维持历版判断：Strands Agents 仍是 TDSF Terminal Agent 集成运维 agent 能力的首选框架，不替换**。v5 综合调研 54 个项目 + 5 大框架横向对比 + 6 大维度（多 Agent / HITL / MCP / 国产 LLM / 安全 / token 优化）对比，**无任何新项目或新框架颠覆 Strands 首选结论**。v5 最重要的两个发现：(1) **OPENDEV（arxiv 2603.05344）的 schema-level safety**——安全约束从"instruct + intercept"升级为"remove + schema"，是 P1 立即可借鉴的最高价值范式；(2) **RSSH（Tauri 2 + Rust + SQLite + AI）与 TDSF 完全同栈**——是历版调研中同栈最彻底的产品级对标。**Headroom（MCP Server 模式接入，60-95% token 节省）** 是 P1 最高 ROI 的落地项。

### 1.2 v5 新发现项目总览（17 个）

v5 在 v4 的 37 项目基础上，新发现 17 个项目（v5 主报告 8 个 + v5-supplement 9 个），按 TDSF 契合度降序：

| # | 项目 | 契合度 | 价值定位 |
|---|------|:---:|------|
| 1 | **RSSH** | **10/10** | Tauri 2 + Rust + SQLite + AI，与 TDSF **完全同栈**，CLI+GUI 同源 SQLite |
| 2 | **OPENDEV** | **10/10** | schema-level safety + 5 级 compaction + dual-agent（论文借鉴） |
| 3 | **Headroom** | 9/10 | 60-95% token 节省，MCP Server 模式直接接入 |
| 4 | **gotoHuman MCP** | 9/10 | 异步 HITL 审批 MCP 服务，workflow runId 多步骤关联 |
| 5 | **5 MCP SSH 矩阵** | 9/10 | TencentOS 22 工具 / @honwee 14 工具 / AntShell / shaike1 / weidwonder |
| 6 | **DeepSeek-TUI** | 8/10 | 34.8k stars，RLM 并行调度 + 类型化 execpolicy + side-git |
| 7 | **uniTerm** | 8/10 | 4 级 AI 权限管控 + AI 多终端协同 + AI 询问工具 |
| 8 | **AutoAgents** | 8/10 | Rust LLM Pipeline + 可组合中间件（CacheLayer + Guardrails） |
| 9 | **OpAgent**（v4） | 8/10 | 三层安全 + hash-chained 审计链（v4 已覆盖，v5 强化对标） |
| 10 | **Warpgate** | 7/10 | russh 同栈智能堡垒机，教学场景参考 |
| 11 | **DeepAgents** | 7/10 | LangGraph 之上的 Python agent harness（MemoryMiddleware） |
| 12 | **OpenDeRisk** | 7/10 | AI-Native 多 Agent 风险智能系统（5 Agent + K-Engine） |
| 13 | **grok-build** | 6/10 | xAI Rust TUI 编码 Agent，22.2k stars |
| 14 | **open-multi-agent** | 6/10 | TypeScript Goal-First 多智能体编排 |
| 15 | **Spring AI Alibaba HITL** | 5/10 | Java HITL 设计模式参考（EDITED 决策） |
| 16 | **SSH-Client（bean80）** | 5/10 | 国产 Tauri SSH 客户端参考 |
| 17 | **ferrissh** | 4/10 | russh 同栈网络设备自动化库 |

### 1.3 关键发现（v5 新增）

1. **5 大框架格局已定**：Strands（AWS，model-driven）/ LangGraph 1.0（图执行引擎，HITL 一等公民）/ MAF 1.0（微软，合并 AutoGen+SK，唯一原生 MCP+A2A）/ CrewAI 1.14（角色驱动，30k+ stars）/ OpenAI Agents SDK（极简原语）。**AutoGen 已于 2025-10 进入维护模式，微软推荐迁移到 MAF 1.0**。[来源：learn.microsoft.com, blog.csdn.net/m0_69581581]
2. **OPENDEV schema-level safety 是安全范式跃迁**：从"instruct 不要用 write tools"（LLM 可 argue around）升级为"planning agent 的 tool registry 中 write tools 直接缺失"（LLM 不能 call 不存在于 schema 的 tool）。这是 P1 最高价值范式借鉴。[来源：arxiv.org/abs/2603.05344, daita.io]
3. **RSSH 证明 TDSF 技术选型正确**：RSSH 与 TDSF 同为 Tauri 2 + Rust + SQLite + AI + 系统钥匙串 + 跨平台，是历版调研中同栈最彻底的项目。其"CLI + GUI 同源 SQLite + 四道硬墙安全 + asciicast v2 录制 + 加密配置同步"是 TDSF 产品级参考。[来源：rustcc.cn]
4. **Headroom 是 token 优化的最佳落地路径**：v4 的 ANOLISA Token-Less 是 OS 层不可直接集成，Headroom 提供 **MCP Server 模式**（`headroom mcp install`），TDSF sidecar 的 MCPClient 只需注册即可获得 60-95% token 节省，**零 sidecar 代码改动**。生产中位数 4.8% / 平均 11.3%，但 SRE 故障调试场景 92%（与 TDSF `analyze_logs` 同质）。[来源：dev.to, eefocus.com]
5. **MCP 协议 2026-07-28 stateless 化**：GitHub MCP Server 升级支持最新 MCP spec，移除 Redis sessions / 避免深度包检测 / 升级 elicitation / Go SDK。TDSF P2 MCP 改造利好——简化 session 管理。[来源：v5 主报告附录 A.3]
6. **HITL 四种决策动作**：approve（批准）/ edit（编辑参数）/ reject（拒绝）/ respond（代答）。LangGraph 的 `interrupt() + Command(resume=)` + Checkpointer 是"HITL = 可恢复的暂停"的标准实现。gotoHuman MCP Server 将 HITL MCP 化（workflow runId + Webhook）。[来源：cloud.tencent.cn, docs.langchain.com]
7. **多 Agent 协作 4 大模式**：Strands 定义 Agents-as-Tools / Swarm / Graph / Workflow 四模式（AWS 2025-11 官方博客）。MAF 1.0 用 GraphFlow + typed Workflow。CrewAI 用 Crew + Process（sequential/hierarchical）。[来源：aws.amazon.com, learn.microsoft.com]

### 1.4 v5 维持的判断

1. **Strands Agents 首选、PydanticAI 备选**（不变，54 项目 + 5 框架对比均未颠覆）
2. **RSSH 是同栈最彻底的架构对标参考**（v5-supplement 确认）
3. **Headroom 是 P1 token 优化的首选落地中间件**（MCP Server 模式直接接入）
4. **OPENDEV 是 v5 最重要的范式借鉴源**（schema-level safety + 5 级 compaction）
5. **MCP 协议在运维场景已成熟**（5 个独立 MCP SSH Server + gotoHuman + Headroom）
6. **AutoGen 已过时，MAF 1.0 是微软生态新标准**（2026-04-03 GA）

---

## 2. 历版已覆盖项目回顾（54 项目基线）

### 2.1 历版项目清单

| 版本 | 项目数 | 代表项目 | 核心结论 |
|------|:---:|------|------|
| v3 | 22 | Strands / PydanticAI / OpenWorker / TencentOS MCP / SRE Lab Doctor | Strands 首选（9/10） |
| v4 | +15 | AgentSSH / OpAgent / LearnSSH / ANOLISA / Open Interpreter 0.0.26 | 维持 Strands 首选，AgentSSH 同栈 |
| v5-supplement | +9 | RSSH / uniTerm / DeepSeek-TUI / Headroom / Warpgate | RSSH 完全同栈，Headroom token 优化 |
| v5 主报告 | +8 | OPENDEV / gotoHuman / AutoAgents / DeepAgents / OpenDeRisk / grok-build | OPENDEV schema-level safety |
| **合计** | **54** | — | **Strands 首选不变** |

### 2.2 历版核心结论

1. **Strands Agents 是 TDSF 首选**（契合度 9/10，54 项目中无颠覆者）
2. **TDSF 现有 `strands_backend/` 实现质量高**（1400+ 行，8 源文件 + 2 测试文件，P0 已完成）
3. **PydanticAI v2.13.0 为备选**（触发条件：litellm 冲突 / 类型安全 / 原生 HITL / 轻体积）
4. **LangGraph 被 Thoughtworks 2026-04 从 Adopt 降级到 Trial**（TDSF 切换 Strands 有额外支撑）
5. **同栈项目矩阵**：RSSH（Tauri 2 完全同栈 10/10）> AgentSSH（russh 同栈 9/10）> Warpgate（russh 同栈 7/10）> ferrissh（russh 同栈 4/10）

---

## 3. v5 新发现项目清单（17 个）

> 详细的 17 个项目深度分析见 `ops-agent-opensource-survey-2026-07-v5-supplement.md`（RSSH/Headroom/DeepSeek-TUI/uniTerm/Warpgate 等 9 项目）和本节（OPENDEV/gotoHuman/AutoAgents/DeepAgents/OpenDeRisk/grok-build 等 8 项目）。

### 3.1 v5 主报告 8 个新项目

#### 3.1.1 OPENDEV（Rust 终端 native AI agent + schema-level safety）

| 维度 | 数据 | 来源 |
|------|------|------|
| 论文 | arxiv.org/abs/2603.05344v1（2026-03-05） | arxiv.org |
| 核心创新 | (1) schema-level safety (2) 5 级 adaptive compaction（峰值降 54%） (3) dual-agent（plan/execute 分离） (4) lazy tool discovery (5) dual memory (6) event-driven reminders | arxiv.org + daita.io |
| Schema safety | "LLM 可以 argue around permission check，但不能 call 不存在于 schema 的 tool" | daita.io |
| 5 级 compaction | 70% warning → 80% masking → 85% pruning → 90% aggressive → 99% LLM summarization | daita.io |

**核心价值**：v5 最深刻的范式借鉴源——schema-level safety + 5 级 compaction + dual-agent 全部是"纯工程化、可在 sidecar 落地、无需外部中间件"。契合度 **10/10**。

#### 3.1.2 gotoHuman MCP Server（异步 HITL 审批 MCP 服务）

| 维度 | 数据 | 来源 |
|------|------|------|
| npm | @gotohuman/mcp-server 0.2.2 | npmjs.com |
| 3 工具 | list-forms / get-form-schema / request-human-review-with-form | npmjs.com |
| workflow | runId 多步骤关联 + Webhook 异步回调 | npmjs.com |

**核心价值**：HITL 审批 MCP 化的现成参考。契合度 9/10。

#### 3.1.3 AutoAgents（Rust LLM Pipeline + 可组合中间件）

| 维度 | 数据 | 来源 |
|------|------|------|
| GitHub | github.com/liquidos-ai/AutoAgents | cloud.tencent.com |
| API | `PipelineBuilder::new(provider).add_layer(cache).add_layer(guardrails).build()` | cloud.tencent.com |
| Guardrails | RegexPiiRedactionGuard + PromptInjectionGuard + EnforcementPolicy::Block | cloud.tencent.com |

**核心价值**：sidecar 中间件化参考，PipelineBuilder 链式 API 可组合 RiskChecker + LlmAuditor + CacheLayer。契合度 8/10。

#### 3.1.4 DeepAgents（LangGraph agent harness）

| 维度 | 数据 | 来源 |
|------|------|------|
| PyPI | 0.7.0b2（2026-07-24） | pypi.org |
| 核心 | planning tool / filesystem backend / subagent-spawning / MemoryMiddleware | docs.langchain.com |

**核心价值**：MemoryMiddleware（AGENTS.md）+ subagents 设计参考。强依赖 LangGraph（Thoughtworks 降级），仅借鉴设计。契合度 7/10。

#### 3.1.5 OpenDeRisk（AI-Native 多 Agent 风险智能系统）

| 维度 | 数据 | 来源 |
|------|------|------|
| 5 Agent | SRE-Agent / Code-Agent / Data-Agent / Vis-Agent / ReportAgent | gitcode.com |
| K-Engine | RAG 诊断知识持续积累 | gitcode.com |
| 指标 | 故障检测 <1min / 根因定位 89.6% / 误报率 3.2% | gitcode.com |

**核心价值**：多 Agent 协作 + Vis 协议证据链 + K-Engine RAG。契合度 7/10。

#### 3.1.6 grok-build（xAI Rust TUI 编码 Agent）

| 维度 | 数据 | 来源 |
|------|------|------|
| Stars | 22.2k（10 天爆火） | CSDN |
| 架构 | 双层（TUI 事件引擎 + Agent 调度引擎） | CSDN |

**核心价值**：Rust TUI 性能参考。安全未完善（越权 50）。契合度 6/10。

#### 3.1.7 AntShell + 5 个 MCP SSH Server 矩阵

| # | 项目 | 工具数 | 特性 | 来源 |
|---|------|:---:|------|------|
| 1 | TencentOS MCP Server | 22 | 10 大场景 / 零侵入 SSH / eBPF / Streamable HTTP | cloud.tencent.com |
| 2 | @honwee/ssh-mcp-server | 14 | 跳板机 / 连接池 / JSONL 审计 / 一键诊断 | npmjs.com |
| 3 | AntShell | N/A | 原生 MCP / AI 运维四合一 | juejin.cn |
| 4 | shaike1/mcp-server-ssh | N/A | REST API / 密码+密钥 / 文件传输 | cloud.tencent.com |
| 5 | weidwonder/terminal-mcp-server | 1 | stdio+SSE / 会话持久 / 环境变量 | cloud.tencent.com |

**核心价值**：证明 MCP 运维已成熟。TencentOS 22 工具分类法是 TDSF 工具集扩展蓝图。契合度 9/10。

#### 3.1.8 TencentOS MCP Server 22 工具分类法

22 工具覆盖 10 大场景：系统信息(2) / 服务管理(1) / 进程分析(1) / 日志查看(2) / 网络诊断(1) / 防火墙(1) / 性能分析(1) / 软件包(1) / 安全审计(3) / 内核管理(2) + eBPF(4) + 主机管理(3)。

### 3.2 v5-supplement 9 个新项目（摘要）

> 完整分析见 `ops-agent-opensource-survey-2026-07-v5-supplement.md`。

| # | 项目 | 契合度 | 核心价值 |
|---|------|:---:|------|
| 1 | **RSSH** | 10/10 | Tauri 2 + Rust + SQLite + AI 完全同栈，CLI+GUI 同源 SQLite，四道硬墙安全 |
| 2 | **Headroom** | 9/10 | 60-95% token 节省，MCP Server 模式直接接入，CCR 可逆压缩 |
| 3 | **DeepSeek-TUI** | 8/10 | 34.8k stars，RLM 并行调度 1-16 子任务，类型化 execpolicy，side-git 快照 |
| 4 | **uniTerm** | 8/10 | Wails+Go，4 级 AI 权限管控，AI 多终端协同，AI 询问工具 |
| 5 | **Warpgate** | 7/10 | russh 同栈堡垒机，2FA+SSO，会话记录审计，教学场景参考 |
| 6 | **open-multi-agent** | 6/10 | TypeScript Goal-First DAG，10+ provider，MCP 支持 |
| 7 | **Spring AI Alibaba HITL** | 5/10 | Java HITL 设计模式，EDITED 决策，MemorySaver 检查点 |
| 8 | **SSH-Client（bean80）** | 5/10 | 国产 Tauri SSH 客户端，Git 三屏合并 |
| 9 | **ferrissh** | 4/10 | russh 同栈网络设备自动化库 |

---

## 4. 5 大 Agent 框架对比矩阵

> 本节为 v5 新增，对比 2026-07 主流 5 大 Agent 框架，评估 TDSF 集成可行性。

### 4.1 5 大框架核心数据

| 框架 | 维护方 | 最新版本 | Stars | License | 语言 | 设计哲学 |
|------|--------|----------|:---:|---------|------|----------|
| **Strands Agents** | AWS | 1.25+（2026-07） | 增长中 | Apache 2.0 | Python | **Model-driven**（FM 决定步骤） |
| **LangGraph** | LangChain | 1.0 GA（2025-10） | 12.8k+ | MIT | Python/JS | **Graph-driven**（显式状态图） |
| **MAF 1.0** | Microsoft | 1.0 GA（2026-04-03） | 新发布 | MIT | .NET/Python | **Enterprise-driven**（Azure 集成） |
| **CrewAI** | CrewAI Inc | 1.14（2026-05） | 30k+ | MIT | Python | **Role-driven**（角色分工） |
| **OpenAI Agents SDK** | OpenAI | 持续更新 | 8.6k+ | MIT | Python | **Primitive-driven**（极简原语） |

> **注意**：AutoGen 已于 2025-10 进入维护模式，微软官方推荐新项目使用 MAF 1.0。AutoGen 不再作为主流框架对比。[来源：learn.microsoft.com, m.sohu.com]

### 4.2 5 大框架 × 8 维度对比矩阵

| 维度 | Strands | LangGraph 1.0 | MAF 1.0 | CrewAI 1.14 | OpenAI Agents SDK |
|------|:---:|:---:|:---:|:---:|:---:|
| **多 Agent 模式** | ✅ 4 模式（Agents-as-Tools/Swarm/Graph/Workflow） | ✅ StateGraph + 条件路由 | ✅ GraphFlow + typed Workflow | ✅ Crew + Process（seq/hierarchical） | ✅ Handoffs |
| **HITL 原生支持** | ⚠️ callback_handler | ✅ **interrupt() + Command(resume=)** + Checkpointer | ✅ Request-Response API + 检查点 | ⚠️ 人工任务 | ⚠️ Guardrails |
| **MCP 原生支持** | ✅ **MCPClient（stdio + Streamable HTTP）** | ✅ MCP 工具节点（per-node timeout） | ✅ **原生 MCP + A2A**（唯一双原生） | ⚠️ 可插拔（非原生流式） | ✅ 原生 MCP |
| **工具定义** | ✅ **@tool 装饰器** | ✅ ToolNode + BaseTool | ✅ @tool（自动 schema 推断） | ✅ FunctionTool | ✅ function_tool |
| **模型提供商** | ✅ **13+**（Bedrock/Anthropic/OpenAI/LiteLLM/Ollama/DeepSeek/Qwen） | ✅ LangChain 全生态 | ✅ Azure/OpenAI/Anthropic | ✅ 可插拔后端 | ⚠️ OpenAI 优先 |
| **流式输出** | ✅ stream_async | ✅ astream_events | ✅ streaming | ⚠️ 非原生 | ✅ streaming |
| **生产验证** | ✅ **Amazon Q / AWS Glue / VPC Reachability Analyzer** | ✅ Uber 等大厂 | ✅ Azure AI Foundry | ⚠️ 中 | ⚠️ OpenAI 生态 |
| **TDSF 契合度** | **9/10** | 7/10 | 5/10 | 6/10 | 5/10 |

### 4.3 5 大框架多 Agent 协作模式对比

| 框架 | 模式 1 | 模式 2 | 模式 3 | 模式 4 | TDSF 适用性 |
|------|--------|--------|--------|--------|-------------|
| **Strands** | Agents-as-Tools（manager 委托专家） | Swarm（并行头脑风暴） | Graph（专家图） | Workflow（结构化管道） | ✅ 全覆盖 |
| **LangGraph** | StateGraph + 条件路由 | 嵌套子图 | — | — | ✅ 图驱动 |
| **MAF** | GraphFlow（typed edge routing） | GroupChat（RoundRobin/MagenticOne） | Request-Response（HITL） | — | ⚠️ .NET 优先 |
| **CrewAI** | Sequential（顺序执行） | Hierarchical（Manager 统筹） | — | — | ⚠️ 角色驱动 |
| **OpenAI** | Handoffs（智能体转交） | — | — | — | ⚠️ 单层 |

### 4.4 5 大框架 HITL 机制对比

| 框架 | HITL 机制 | 四种决策（approve/edit/reject/respond） | 持久化 | TDSF 借鉴价值 |
|------|-----------|:---:|--------|---------------|
| **LangGraph** | **interrupt() + Command(resume=)** + Checkpointer | ✅ 全支持 | ✅ MemorySaver/SqliteSaver/PostgresSaver | **高**（标准范式） |
| **MAF** | Request-Response API + 检查点 | ✅ | ✅ 检查点恢复 | 中（.NET 栈不同） |
| **Strands** | callback_handler + ApprovalHook | ⚠️ 需自定义 | ⚠️ 需自建 | **高**（TDSF 已用） |
| **CrewAI** | 人工任务 | ⚠️ | ⚠️ | 低 |
| **OpenAI** | Guardrails | ⚠️ | ❌ | 低 |

### 4.5 5 大框架 TDSF 集成可行性评估

| 框架 | 集成方式 | 工作量 | 风险 | 结论 |
|------|----------|:---:|:---:|------|
| **Strands** | `pip install strands-agents` + `@tool` + MCPClient | ✅ 已完成（P0） | 低 | **首选，继续深化** |
| **LangGraph** | Feature Flag 第三后端 | 2-3 人日 | 中（Thoughtworks 降级） | 维持备选 |
| **MAF** | Python SDK 可用，但 .NET 优先 | 3-5 人日 | 高（微软生态绑定） | 不推荐 |
| **CrewAI** | pip install | 2 人日 | 中（角色驱动与 TDSF 工具驱动不匹配） | 不推荐 |
| **OpenAI** | pip install | 1-2 人日 | 高（OpenAI 绑定） | 不推荐 |

**结论**：Strands 首选不变。MAF 1.0 虽然是唯一原生 MCP+A2A 框架，但 .NET 优先 + Azure 绑定，不适合 TDSF（Python sidecar + 桌面 IDE）。LangGraph 维持备选（HITL 一等公民 + Durable Execution），但 Thoughtworks 降级是风险信号。

---

## 5. 多 Agent 协作架构对比

> 本节为 v5 新增，对比主流多 Agent 协作架构，评估 TDSF P2 多 Agent 落地方案。

### 5.1 4 大多 Agent 协作模式（Strands 官方分类）

AWS 2025-11 官方博客定义 4 大模式（Strands SDK 实现）：

| 模式 | 描述 | 适用场景 | TDSF 适用性 |
|------|------|----------|-------------|
| **Agents-as-Tools** | manager agent 把 specialist agent 包装为可调用工具 | 多领域专家协作 | ✅ P2 planner + executor |
| **Swarm** | 并行头脑风暴，多 agent 独立思考后融合 | 创意/分析 | ⚠️ P3 评估 |
| **Graph** | 专家图，节点=agent，边=数据流 | 确定性工作流 | ✅ P2 评估 |
| **Workflow** | 结构化管道，顺序/并行混合 | 流水线 | ⚠️ P3 评估 |

### 5.2 跨框架多 Agent 架构对比

| 架构 | 框架 | 核心抽象 | TDSF 借鉴点 |
|------|------|----------|-------------|
| **StateGraph** | LangGraph | Node + Edge + State | 条件路由 + 检查点 |
| **GraphFlow** | MAF | typed edge + Executor | 类型安全路由 |
| **Crew + Process** | CrewAI | Agent(role) + Task + Crew | 角色分工 |
| **Handoffs** | OpenAI | Agent 转交 | 轻量转交 |
| **Swarm/Graph** | Strands | 预置模板 + 低门槛配置 | **TDSF 首选**（与 @tool 对齐） |
| **Goal-First DAG** | open-multi-agent | coordinator 自动分解 DAG | P3 评估 |
| **5 Agent + K-Engine** | OpenDeRisk | SRE/Code/Data/Vis/Report + RAG | P3 评估 |

### 5.3 OPENDEV dual-agent 架构（TDSF P2 借鉴）

OPENDEV 的 plan/execute 分离是 v5 最重要的多 Agent 范式：

- **planning agent**：restricted tool registry（**无 write tools**），只做规划
- **execution agent**：完整 tools，需审批后激活，负责执行

**TDSF P2 落地**：在 `agents/` 新增 `planner.py` + `executor.py`，planner 通过 task 工具委托给 executor。结合 schema-level safety，planner 看不到 `ssh_command` 等 write tools。

### 5.4 DeepSeek-TUI RLM 并行调度（TDSF P2 借鉴）

RLM（parallel query）：主模型（Pro）调度 1-16 个低成本 Flash 子任务并行执行。与 v4 Open Interpreter harness 切换（串行）和 OpenSquilla SquillaRouter（按难度选一个模型）不同，RLM 是"主模型 + 多个 Flash 子任务并行"。

**TDSF P2 落地**：在 `strands_backend/` 新增 `rlm_query` 工具，批量分析任务（多日志/多服务）成本砍到 1/3。

---

## 6. HITL（Human-in-the-Loop）机制对比

> 本节为 v5 新增，对比主流 HITL 机制，评估 TDSF `needs_you` 升级方案。

### 6.1 HITL 四种决策动作

成熟 HITL 实现将人工介入拆为四种动作（LangGraph/DeepAgents/MAF 均支持）：

| 决策 | 含义 | 典型场景 | TDSF 现状 |
|------|------|----------|-----------|
| **approve** | 原样放行 | 命令没问题，执行 | ✅ needs_you y |
| **edit** | 改参数再放行 | `rm -rf /tmp/*` 改成更安全路径 | ❌ **缺失** |
| **reject** | 不执行，给模型说明 | "别删这个，换个思路" | ✅ needs_you n |
| **respond** | 人直接替工具回结果 | "问用户"类工具 | ❌ **缺失** |

### 6.2 跨框架 HITL 机制对比

| 框架/项目 | HITL 机制 | 持久化 | 异步 | MCP 化 | TDSF 借鉴价值 |
|-----------|-----------|--------|:---:|:---:|---------------|
| **LangGraph** | interrupt() + Command(resume=) | ✅ Checkpointer | ✅ | ❌ | **高**（标准范式） |
| **MAF** | Request-Response API | ✅ 检查点 | ✅ | ❌ | 中 |
| **Strands** | ApprovalHook + callback_handler | ⚠️ 自建 | ⚠️ | ❌ | **高**（TDSF 已用） |
| **gotoHuman MCP** | request-human-review-with-form | ✅ workflow runId | ✅ Webhook | ✅ **MCP** | **高**（MCP 化 HITL） |
| **Spring AI Alibaba** | HumanInTheLoopHook | ✅ MemorySaver | ✅ | ❌ | 中（EDITED 决策） |
| **uniTerm** | 4 级权限 + AI 询问工具 | ⚠️ | ⚠️ | ❌ | **高**（4 级 + 多形态询问） |
| **DeepSeek-TUI** | 类型化 execpolicy（Plan/Agent/Yolo） | ⚠️ | ⚠️ | ❌ | **高**（类型化审批） |
| **OpAgent** | 三层（PolicyGuard + LlmAuditor + Confirm） | ✅ hash-chain | ⚠️ | ❌ | **高**（语义审计） |
| **OPENDEV** | schema-level safety | ⚠️ | ⚠️ | ❌ | **极高**（架构级安全） |
| **TDSF 现有** | RiskChecker 正则 + needs_you（y/N） | ❌ 普通日志 | ❌ 同步 | ❌ | — |

### 6.3 TDSF HITL 升级路线（P1/P2）

1. **P1：4 级权限管控**（uniTerm 借鉴）：免确认/仅高危/写操作/全部确认
2. **P1：类型化 execpolicy**（DeepSeek-TUI 借鉴）：按 tool_kind + args.side_effect + mode 三维路由
3. **P1：schema-level safety**（OPENDEV 借鉴）：planning agent 的 tool registry 中 write tools 直接缺失
4. **P1：EDITED 决策**（Spring AI Alibaba 借鉴）：用户可编辑 agent 提议的命令后再执行
5. **P2：HITL MCP 化**（gotoHuman 借鉴）：workflow runId + Webhook + form schema
6. **P2：LlmAuditor 语义审计**（OpAgent 借鉴）：检测变量间接/混淆/外泄/提权
7. **P2：hash-chained 审计链**（OpAgent 借鉴）：sha256 前后链防篡改

---

## 7. 工具调用协议（MCP）对比

> 本节为 v5 新增，对比 MCP 协议在运维场景的成熟度。

### 7.1 MCP 协议 2026-07 状态

| 维度 | 状态 | 来源 |
|------|------|------|
| 最新 spec | 2026-07-28 stateless 化 | GitHub MCP Server 升级 |
| 传输 | stdio + Streamable HTTP（HTTP+SSE 已废弃） | MCP spec |
| Session 管理 | 移除 Redis sessions，避免深度包检测 | GitHub MCP Server |
| Elicitation | 升级支持（MCP 原生 HITL） | MCP spec |
| Go SDK | 新增 | GitHub MCP Server |

### 7.2 运维 MCP Server 矩阵（7 个）

| # | 项目 | 工具数 | 传输 | 特性 | TDSF 借鉴 |
|---|------|:---:|------|------|-----------|
| 1 | **TencentOS MCP Server** | 22 | Streamable HTTP | 10 大场景 / eBPF / 零侵入 SSH | **工具分类法蓝图** |
| 2 | **@honwee/ssh-mcp-server** | 14 | stdio | 跳板机 / 连接池 / JSONL 审计 | 教学场景参考 |
| 3 | **AntShell** | N/A | 原生 MCP | AI 运维四合一 | 产品形态对标 |
| 4 | **shaike1/mcp-server-ssh** | N/A | REST | 密码+密钥 / 文件传输 | — |
| 5 | **weidwonder/terminal-mcp-server** | 1 | stdio+SSE | 会话持久 / 环境变量 | — |
| 6 | **gotoHuman MCP** | 3 | stdio | HITL 审批 / Webhook | **HITL MCP 化** |
| 7 | **Headroom MCP** | N/A | stdio | token 压缩 / CCR | **token 优化** |

### 7.3 TDSF MCP 改造路径

**现有 5 工具代码结构**（`src-tauri/sidecar/strands_backend/tools/`，约 1600 行）：
- 核心实现：`invoke_*_tool(params, ctx) -> dict`，无 Strands 依赖
- Strands @tool 工厂：`make_*_tool(ctx)`，返回带 ctx 闭包的 @tool 函数
- ToolContext：运行时上下文（rust_bridge / event_bus / session_id）

**关键观察**：dict 入参 + dict 返回，天然适配 MCP tool schema；Strands 弱耦合，核心实现可直接包装为 MCP tool handler。

**改造架构**：新增 `mcp_server/` 模块（server.py / tool_wrappers.py / schemas.py）

**工作量**：700-1080 行（1-2 人日）

**改造优先级**：P2-1 read_remote_file（已可用）→ P2-2 其余 4 工具（依赖 ssh_command Rust 实现）

**改造收益**：外部 MCP Client 可消费 / 工具定义集中化 / 跨 agent 框架复用 / 教学场景价值

---

## 8. 国产 LLM 适配对比

> 本节为 v5 新增，对比国产 LLM 在 agent 场景的适配能力。

### 8.1 国产 LLM 性能对比（2026-07）

| 模型 | 维护方 | 核心优势 | Agent 场景适用性 | Strands 接入方式 |
|------|--------|----------|------------------|------------------|
| **DeepSeek V3/R1** | 深度求索 | 数学/代码推理强，Prefix Cache 优化 | ✅ 编码/调试 agent | LiteLLM |
| **Kimi K2** | 月之暗面 | 长时 agent 任务强，128k+ 上下文 | ✅ 长任务 agent | LiteLLM |
| **GLM-4.6/5.1** | 智谱 AI | 前端开发强，多模态 | ✅ 前端/多模态 agent | LiteLLM |
| **Qwen3** | 阿里 | 超长上下文，工具调用稳定 | ✅ 运维 agent | LiteLLM / Bedrock Marketplace |

### 8.2 国产 LLM agent 框架

| 框架 | 维护方 | 语言 | 特性 | TDSF 关系 |
|------|--------|------|------|-----------|
| **AgentScope** | 阿里 | Python | 多 Agent 协作 + 记忆管理 | 设计参考 |
| **Spring AI Alibaba** | 阿里 | Java | HITL + Graph + Studio | HITL 设计参考 |
| **ANOLISA** | 阿里云 | OS 层 | Token-Less + AgentSight | token 优化参考 |
| **TDSF** | 自研 | Python sidecar | Strands + LiteLLM | **已接入国产 LLM** |

### 8.3 TDSF 国产 LLM 接入现状

TDSF `model_adapter.py` 的 `create_strands_model(config)` 已支持：
- OpenAIModel（GPT 系列）
- AnthropicModel（Claude 系列）
- LiteLLMModel（**DeepSeek / Qwen / Kimi / GLM / Ollama 本地**）

**结论**：TDSF 国产 LLM 适配已完成（P0-C5），通过 LiteLLM 统一接入，无需额外工作。

### 8.4 Reasonix Prefix Cache 优化（DeepSeek 专用）

Reasonix（Go 重写 v1.0）实现 DeepSeek Prefix Cache 优化（128 token 粒度，约 90% 成本折扣，长会话 90%+ 命中率），DeepSeek 官方 API 文档推荐集成。

**TDSF 借鉴**：P2 评估在 sidecar 的 `model_adapter.py` 新增 Prefix Cache 优化层（DeepSeek 教学场景的 token 成本控制）。

---

## 9. TDSF 现状差距分析

> 本节为 v5 新增，系统分析 TDSF 现有实现与 v5 调研发现的能力差距。

### 9.1 TDSF 现有能力（P0 已完成）

| 能力 | 实现位置 | 状态 |
|------|----------|:---:|
| Strands agent 集成 | `strands_backend/adapter.py` | ✅ |
| 5 运维 @tool | `strands_backend/tools/*.py` | ✅ |
| 多模型适配 | `model_adapter.py`（OpenAI/Anthropic/LiteLLM） | ✅ |
| Feature Flag | `TDSF_AGENT_BACKEND=strands\|langgraph` | ✅ |
| SFTP read | `rust_bridge.ipc_invoke("sftp_read")` | ✅ |
| Backend 状态 | `_backend_status` 7 字段 + `sidecar:backend_status` 事件 | ✅ |
| invoke_agent override | `_global_backend_override` 路径 | ✅ |

### 9.2 TDSF 能力差距矩阵（v5 调研揭示）

| 差距维度 | TDSF 现状 | v5 调研发现的最佳实践 | 差距等级 | 借鉴来源 | 落地阶段 |
|----------|-----------|----------------------|:---:|----------|:---:|
| **安全范式** | instruct + intercept（RiskChecker 10 正则） | **schema-level safety**（remove from registry） | **极高** | OPENDEV | P1 |
| **权限管控** | 二态（RiskChecker + needs_you y/N） | **4 级**（免确认/仅高危/写操作/全部） | 高 | uniTerm | P1 |
| **审批类型** | y/N 二选一 | **4 种决策**（approve/edit/reject/respond） | 高 | LangGraph/Spring AI | P1 |
| **语义审计** | ❌ 缺失 | **LlmAuditor**（变量间接/混淆/外泄/提权） | 高 | OpAgent | P1 |
| **token 优化** | ❌ 缺失 | **Headroom MCP Server**（60-95% 节省） | **极高** | Headroom | P1 |
| **context compaction** | ❌ 缺失 | **5 级自适应**（峰值降 54%） | 高 | OPENDEV | P1 |
| **工具参数** | ssh_command 无 explain/side_effect | **explain + side_effect**（read/write/destroy） | 中 | RSSH | P1 |
| **输出脱敏** | ❌ 缺失 | **payload 离机前 token/密码/IP 替换占位符** | 中 | RSSH | P1 |
| **多 Agent** | ❌ 单 agent | **dual-agent**（plan/execute 分离） | 中 | OPENDEV | P2 |
| **并行调度** | ❌ 串行 | **RLM 并行**（1-16 Flash 子任务） | 中 | DeepSeek-TUI | P2 |
| **审计链** | 普通日志 | **hash-chained**（sha256 前后链） | 中 | OpAgent | P2 |
| **会话录制** | ❌ 缺失 | **asciicast v2**（NDJSON，asciinema 兼容） | 中 | RSSH | P1 |
| **MCP 改造** | ❌ 缺失 | **5 工具包装为 MCP Server** | 中 | v5 调研 | P2 |
| **HITL MCP 化** | needs_you 同步事件 | **workflow runId + Webhook + form schema** | 中 | gotoHuman | P2 |
| **side-git 回滚** | ❌ 缺失 | **每轮快照 + /restore** | 低 | DeepSeek-TUI | P2 |
| **多终端协同** | ❌ 单终端 | **#<标签> 指定终端** | 低 | uniTerm | P2 |
| **连接池** | 每次可能重建 | **daemon-pooled**（连接复用） | 低 | AgentSSH | P2 |
| **别名机制** | sshSessionId 传 sidecar | **别名解耦**（凭据不进聊天） | 低 | LearnSSH | P2 |

### 9.3 差距优先级排序（按 ROI）

| 优先级 | 差距 | ROI 理由 |
|:---:|------|----------|
| **P1-1** | Headroom MCP Server 接入 | 零代码改动，60-95% token 节省，最高 ROI |
| **P1-2** | schema-level safety | 架构级安全，从根上杜绝 write tools 误调用 |
| **P1-3** | 5 级 context compaction | 峰值降 54%，长会话从 15-20 轮延长到 30-40 轮 |
| **P1-4** | 4 级权限 + 类型化 execpolicy | 覆盖"中间地带"，教学场景灵活度提升 |
| **P1-5** | ssh_command explain+side_effect | agent 命令意图更清晰，审计更完整 |
| **P1-6** | asciicast v2 会话录制 | 教学回放，asciinema 生态直接消费 |
| **P2-1** | LlmAuditor 语义审计 | 检测变量间接/混淆，填补命令级正则盲区 |
| **P2-2** | hash-chained 审计链 | 防篡改，合规场景 |
| **P2-3** | dual-agent（plan/execute） | 规划与执行分离，安全+效率 |
| **P2-4** | RLM 并行调度 | 批量分析任务成本砍到 1/3 |

---

## 10. 建议新增 @tool Top10 清单

> 本节为 v5 新增，基于 v5 调研发现，给出 TDSF 建议新增的 10 个 @tool。

### 10.1 Top10 新增 @tool 清单

| # | 工具名 | 来源 | 功能 | 优先级 | 预期收益 |
|---|--------|------|------|:---:|----------|
| 1 | **`headroom_compress`** | Headroom | 压缩 context（MCP Server 注入） | **P1** | 60-95% token 节省 |
| 2 | **`headroom_retrieve`** | Headroom | 按需取回压缩前原文（CCR 可逆） | **P1** | 信息不丢失 |
| 3 | **`rlm_query`** | DeepSeek-TUI | 并行调度 1-16 个低成本子任务 | **P2** | 批量分析成本砍 1/3 |
| 4 | **`request_human_review`** | gotoHuman | MCP 化 HITL 审批（form schema + Webhook） | **P2** | 异步审批 + 自定义 UI |
| 5 | **`service_manage`** | TencentOS | 服务管理（start/stop/enable/disable/status） | **P2** | 运维场景覆盖 |
| 6 | **`package_manage`** | TencentOS | 软件包管理（install/remove/list） | **P2** | 运维场景覆盖 |
| 7 | **`firewall_manage`** | TencentOS | 防火墙管理（firewalld/iptables） | **P2** | 安全运维教学 |
| 8 | **`security_audit`** | TencentOS | 安全审计（auditd/SELinux/fail2ban） | **P2** | 安全运维教学 |
| 9 | **`performance_analyze`** | TencentOS | 性能分析（top/sar/perf） | **P2** | 性能调优教学 |
| 10 | **`snapshot_rollback`** | DeepSeek-TUI | side-git 快照 + /restore 回滚 | **P2** | fix_loop 安全网 |

### 10.2 现有 5 工具强化清单

| # | 工具 | 强化项 | 来源 | 优先级 |
|---|------|--------|------|:---:|
| 1 | `ssh_command` | 新增 `explain` + `side_effect` 参数 | RSSH | P1 |
| 2 | `ssh_command` | 新增 `mode`（Plan/Agent/Yolo） | DeepSeek-TUI | P1 |
| 3 | `ssh_command` | 输出脱敏（token/密码/IP 替换占位符） | RSSH | P1 |
| 4 | `read_remote_file` | 包装为 MCP tool handler | v5 调研 | P2 |
| 5 | `analyze_logs` | 启用 Headroom 压缩 | Headroom | P1 |
| 6 | `analyze_logs` | 新增 `compress` 参数（bool） | Headroom | P1 |

### 10.3 工具集扩展路线（5 → 15-20 工具）

参考 TencentOS 22 工具分类法，TDSF 工具集扩展路线：

| 阶段 | 工具数 | 覆盖场景 |
|------|:---:|----------|
| P0（已完成） | 5 | ssh_command / read_remote_file / analyze_logs / inspect_processes / network_diagnose |
| P1（新增） | +3 | headroom_compress / headroom_retrieve / snapshot_rollback |
| P2（新增） | +7 | rlm_query / request_human_review / service_manage / package_manage / firewall_manage / security_audit / performance_analyze |
| **合计** | **15** | 覆盖 TencentOS 10 大场景的 70% |

---

## 11. 集成路线图 v5

### 11.1 P0（已完成）✅

- ✅ Strands 1.50.2 + 5 @tool + model_adapter + Feature Flag
- ✅ sftp_read + _backend_status + invoke_agent override
- ✅ `strands_backend/` 8 文件 1400+ 行

### 11.2 P1（立即执行，v5 新增 6 个范式借鉴）

| 任务 | 来源 | 预期收益 | 工作量 |
|------|------|----------|:---:|
| **P1-1 Headroom MCP Server 接入** | Headroom | 60-95% token 节省 | 0.5 人日 |
| **P1-2 schema-level safety** | OPENDEV | 安全约束从 instruct → remove+schema | 1 人日 |
| **P1-3 5 级 context compaction** | OPENDEV | 峰值 context 降 50%+ | 1-2 人日 |
| **P1-4 4 级权限 + execpolicy** | uniTerm + DeepSeek-TUI | 覆盖中间地带 | 1 人日 |
| **P1-5 ssh_command explain+side_effect+脱敏** | RSSH | 命令意图清晰 + 凭据零暴露 | 0.5 人日 |
| **P1-6 asciicast v2 会话录制** | RSSH | 教学回放 | 0.5 人日 |
| P1-7 stream_async 升级 | v4 | 流式输出 | 0.5 人日 |
| P1-8 终端上下文完善 | v3 | live 传输 | 0.5 人日 |
| P1-9 TencentOS 分类法借鉴 | v4+v5 | 工具集扩展蓝图 | — |

### 11.3 P2（中期执行）

| 任务 | 来源 | 说明 |
|------|------|------|
| **P2-1 RustBridge 双向 JSON-RPC** | v4 | 解锁 4/5 工具，关键阻塞项 |
| **P2-2 5 工具 MCP Server 改造** | v5 | 1-2 人日，收益显著 |
| **P2-3 LlmAuditor 语义审计** | OpAgent | 检测变量间接/混淆/外泄/提权 |
| **P2-4 hash-chained 审计链** | OpAgent | sha256 前后链防篡改 |
| **P2-5 dual-agent（plan/execute）** | OPENDEV | 规划与执行分离 |
| **P2-6 RLM 并行调度** | DeepSeek-TUI | 1-16 Flash 子任务 |
| **P2-7 side-git 快照回滚** | DeepSeek-TUI | fix_loop 安全网 |
| **P2-8 AI 多终端协同 + 多形态询问** | uniTerm | #<标签> + choice/input |
| **P2-9 工具集扩展（5→15）** | TencentOS | 7 个新工具 |
| **P2-10 gotoHuman HITL MCP 化** | gotoHuman | workflow runId + Webhook |

### 11.4 P3（长期）

- MCP server 反向暴露 / A2A 协议 / 沙箱（OpenShell/MXC）
- eBPF 监控 / Aurora 多 agent / Bedrock AgentCore
- Warpgate 教学堡垒机集成 / RSSH 移动端评估
- ANOLISA 内置 Skills 生态 / SLES 16 Agentic OS 教学

### 11.5 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|------|:---:|:---:|------|
| Strands litellm 与 pydantic/chromadb 冲突 | 中 | 高 | 虚拟环境隔离；冲突时切 PydanticAI |
| Headroom Python 3.13+ 与 sidecar 3.11 冲突 | 中 | 中 | 用 Proxy 模式（零代码改动） |
| Headroom 高压缩率导致信息丢失 | 低 | 中 | 只压工具输出，system_prompt 不压；CCR 可逆 |
| RLM 并行增加 API 成本 | 中 | 中 | 只对批量分析启用，Flash 子任务上限 16 |
| 4 级权限破坏现有 needs_you | 中 | 中 | P1 先兼容，P2 完全切换；Level 1 只在沙箱 |
| LlmAuditor 增加 LLM 调用成本 | 高 | 中 | 只对写/破坏操作触发，只读跳过 |
| 22 工具扩展工作量超预期 | 高 | 低 | 分批（P1 先 10 核心，P2 再 12 高级） |
| LangGraph 后端废弃 | 低 | 高 | 保留第三 Feature Flag |

---

## 12. 核心结论

### 12.1 Strands 首选结论再评估

**v5 综合 54 项目 + 5 大框架 + 6 大维度对比，结论不变：Strands Agents 仍是 TDSF 首选。**

**支撑理由**：
1. 54 项目中无任何项目颠覆 Strands 首选（RSSH 是桌面应用非 agent 框架；Headroom 是中间件非框架；OPENDEV 是论文借鉴）
2. TDSF 现有 `strands_backend/` 实现质量高（1400+ 行，9/10 契合度）
3. Strands 不可替代优势：Python SDK 原生 + @tool 装饰器 + MCPClient 原生 + stream_async + Apache 2.0 + 13+ 模型 provider + 4 多 Agent 模式 + AWS 生产验证
4. v5 新发现的"借鉴对象"全部可融入 Strands 体系（Headroom → MCPClient 消费；RSSH → @tool 参数强化；OPENDEV → tool registry 分层；DeepSeek-TUI RLM → @tool 实现）
5. MAF 1.0 虽然是唯一原生 MCP+A2A，但 .NET 优先 + Azure 绑定，不适合 TDSF
6. LangGraph 被 Thoughtworks 降级，维持备选但非首选

### 12.2 是否需要第二套 agent 框架

**不需要**。理由：
1. Strands + LangGraph 双后端 Feature Flag 已足够
2. PydanticAI 作为备选（触发条件未触发）
3. v5 新发现全部通过"借鉴"或"MCP Server 接入"融入 Strands，无需第二套框架
4. 引入第二套框架的代价（2-3 人日重写 + 维护成本）远高于收益

### 12.3 v5 最值得立即借鉴的 3 个范式

1. **OPENDEV schema-level safety**：安全约束从 instruct + intercept → remove + schema（P1，1 人日）
2. **Headroom MCP Server 接入**：60-95% token 节省，零 sidecar 代码改动（P1，0.5 人日）
3. **RSSH ssh_command 参数强化**：explain + side_effect + 输出脱敏（P1，0.5 人日）

### 12.4 一句话总结

> **OPENDEV 的 schema-level safety（通过移除工具而非 instruct 来强制安全约束）+ Headroom 的 MCP Server 模式（60-95% token 节省）+ RSSH 的工具参数强化（explain + side_effect + 脱敏）是 v5 最值得立即借鉴的 3 个范式**——纯工程化在 sidecar 落地，P1 阶段实现安全 + token + 工具三重升级。

---

## 附录：调研来源汇总

### A.1 v5 新增来源（5 大框架对比）

- [AWS Strands Agents 官网](https://www.amazonaws.cn/getting-started/tools-sdks/strands-agents/) — Strands 优势
- [AWS Blog: Multi-agent collaboration patterns](https://aws.amazon.com/blogs/machine-learning/multi-agent-collaboration-patterns-with-strands-agents-and-amazon-nova/) — 4 大模式
- [AWS Blog: Multi-agent social intelligence](https://aws.amazon.com/blogs/machine-learning/multi-agent-social-intelligence-with-strands-agents-and-amazon-bedrock/) — Swarm vs Graph benchmarks
- [Microsoft Learn: MAF 迁移指南](https://learn.microsoft.com/zh-cn/training/modules/get-started-github-copilot/2-examine-ai-assisted-programming-tools) — AutoGen → MAF 1.0
- [Microsoft Learn: AutoGen から MAF への移行](https://learn.microsoft.com/ja-jp/agent-framework/migration-guide/from-autogen/) — 迁移指南
- [CSDN: 2026 年七大 AI Agent 框架生产级深度评测](https://blog.csdn.net/m0_69581581/article/details/162999809) — MAF 1.0 唯一原生 MCP+A2A
- [CSDN: MAF 1.0 GA 深度剖析](https://blog.csdn.net/ZDQ58818/article/details/162445764) — 2026-04-03 GA
- [LangChain Docs: HITL using server API](https://docs.langchain.com/langsmith/add-human-in-the-loop) — interrupt() + Command(resume=)
- [腾讯云: HITL 人在回路 LangGraph/DeepAgents 实现拆解](https://cloud.tencent.cn/developer/article/2697410) — HITL = 可恢复的暂停
- [CSDN: LangGraph v1.0 HITL 实战](https://wayle.blog.csdn.net/article/details/158504542) — interrupt + Checkpointer
- [CSDN: 2026 主流 AI Agent 框架技术选型](https://blog.csdn.net/m0_69581581/article/details/163141907) — 三大流派
- [yuto-lab: 2026 年 AI Agent 框架完全比較](https://yuto-lab.com/blog/ai-agent-framework-comparison-2026/) — 5 框架对比
- [CallSphere: AI Agent Framework Comparison 2026](https://www.callsphere.ai/blog/ai-agent-framework-comparison-2026-langgraph-crewai-autogen-openai) — 4 框架横向
- [CSDN: 主流 Agent 开发框架全解析 2026](https://chunyang.blog.csdn.net/article/details/162844447) — 9 框架

### A.2 v5 新增来源（OPENDEV/gotoHuman/AutoAgents 等）

- [arxiv.org/abs/2603.05344v1](https://arxiv.org/abs/2603.05344v1) — OPENDEV 论文
- [daita.io/en/blog/building_ai_coding_agents_for_the_terminal](https://daita.io/en/blog/building_ai_coding_agents_for_the_terminal) — OPENDEV 深度解析
- [cloud.tencent.com/developer/mcp/server/10577](https://cloud.tencent.com/developer/mcp/server/10577) — gotoHuman MCP Server
- [npmjs.com/package/@gotohuman/mcp-server](https://npmjs.com/package/@gotohuman/mcp-server) — 0.2.2，MIT
- [cloud.tencent.com/developer/article/2645905](https://cloud.tencent.com/developer/article/2645905) — AutoAgents Rust Pipeline
- [docs.langchain.com/oss/python/deepagents/](https://docs.langchain.com/oss/python/deepagents/) — DeepAgents 文档
- [pypi.org/project/deepagents/](https://pypi.org/project/deepagents/) — 0.7.0b2
- [gitcode.com/gh_mirrors/op/OpenDerisk](https://gitcode.com/gh_mirrors/op/OpenDerisk) — OpenDeRisk
- [blog.csdn.net/TunerT_TQ/article/details/163195374](https://blog.csdn.net/TunerT_TQ/article/details/163195374) — grok-build
- [juejin.cn/post/7660702098417713194](https://juejin.cn/post/7660702098417713194) — AntShell
- [cloud.tencent.com/document/product/1397/132403](https://cloud.tencent.com/document/product/1397/132403) — TencentOS MCP Server
- [npmjs.com/package/@honwee/ssh-mcp-server](https://npmjs.com/package/@honwee/ssh-mcp-server) — @honwee 14 工具

### A.3 v5-supplement 来源

完整来源列表见 `ops-agent-opensource-survey-2026-07-v5-supplement.md` 附录 A.1（RSSH/uniTerm/DeepSeek-TUI/Headroom/Warpgate/open-multi-agent/Spring AI Alibaba/SSH-Client/ferrissh）。

### A.4 v3/v4 原有来源

完整来源列表见：
- `ops-agent-opensource-survey-2026-07-v4.md` 附录 A（v4 新增 15 项目来源）
- `ops-agent-opensource-survey-2026-07-30-v3.md` 附录 A（v3 的 22 项目来源）

### A.5 MCP 协议 2026-07 stateless 化

GitHub MCP Server 2026-07-23 升级支持最新 MCP spec（2026-07-28 stateless 化）：移除 Redis sessions / 避免深度包检测 / 升级 elicitation / Go SDK。TDSF P2 MCP 改造利好——简化 session 管理。

### A.6 v5 调研补充发现

| 项目 | GitHub | 简述 |
|------|--------|------|
| NVIDIA OpenShell | github.com/NVIDIA/OpenShell | AI Agent 安全沙箱运行时（Rust，6769 stars） |
| Microsoft MXC | github.com/microsoft/mxc | Rust 跨平台 AI 沙箱（364 stars） |
| herdr | github.com/ogulcancelik/herdr | Rust 终端 Agent 多路复用器（4307 stars） |
| skills-manager | github.com/xingkongliang/skills-manager | Rust+Tauri 技能管理（1923 stars） |
| adk-rust | github.com/zavora-ai/adk-rust | Google ADK Rust 实现（Ollama+mistral.rs+MCP） |

---

> **报告终**
> **版本**：v5.0（2026-07-30，54 项目 + 5 大框架 + 6 大维度对比完整报告）
> **总项目数**：54（v3 的 22 + v4 的 15 + v5-supplement 的 9 + v5 主报告的 8）
> **核心结论**：Strands Agents 首选不变，v5 最值得立即借鉴的 3 个范式：OPENDEV schema-level safety + Headroom MCP Server + RSSH 工具参数强化
> **上游参考**：[crynta/terax-ai](https://github.com/crynta/terax-ai) v0.8.6