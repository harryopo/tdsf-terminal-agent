# 运维 Agent 深度调研报告（轻量级框架 + 运维专项 + 终端集成型）

> **位置**：`d:\ai\linux教学一体\tdsf-terminal-agent-clone\docs\reports\ops-agent-deep-research.md`
> **目的**：为 TDSF Terminal Agent 的运维 agent 集成提供轻量级框架选型 + 运维领域对标 + 终端集成模式参考
> **调研日期**：2026-07-30
> **调研方法**：WebSearch + WebFetch 抓官方文档/GitHub README 验证关键事实
> **上游基线**：[crynta/terax-ai v0.8.6](https://github.com/crynta/terax-ai)
> **与已有报告关系**：深化补充 [`ops-agent-opensource-research.md`](./ops-agent-opensource-research.md)（该报告已覆盖 Aider/OpenHands/LangGraph/Continue.dev/Shellfirm/dcg），本文聚焦轻量级框架与运维/终端集成型，不重复命令拦截器内容

---

## 一、执行摘要

本报告调研了 12 个项目，覆盖三大方向：**轻量级 Agent 框架**（6 个）、**运维领域专项 Agent**（3 个）、**终端集成型 Agent**（3 个）。核心结论：

1. **Strands Agents（AWS）是 TDSF 的首选框架**：Apache 2.0、几行代码定义 agent、模型驱动 + 内置 agentic loop、AWS 生产验证（Amazon Q Developer/Glue/VPC Reachability Analyzer）、内置 MCP 支持、模型无关（LiteLLM/Ollama/Bedrock）。与 TDSF"轻量、教学、Python sidecar"约束完美契合。

2. **Pydantic AI 是次选**：MIT、17.6k stars、类型安全、**deferred tools with conditional approval gating** 天然对接 RiskEngine（高危命令 → 需用户确认）。Pydantic Graph 可替代 LangGraph。

3. **smolagents 是第三选择**：Apache 2.0、HuggingFace 出品、~1000 行核心代码、CodeAgent（动作=Python 代码）减少 30% 步骤、多层安全（AST 分析 + 沙箱）。

4. **OpenAI Swarm 已被 Agents SDK 取代**（2025-03）。Agents SDK 的 Guardrails 机制（input/output/tool 三层验证 + tripwire）与 TDSF RiskEngine 是同一思路，可作为 Strands 的备选。

5. **微软 Intelligent Terminal（2026-06 发布）是 TDSF 的对标产品**：基于 Windows Terminal fork、agent pane（侧边栏整合 AI）、context-aware（看 shell 上下文）、automatic error detection（命令失败自动检测）、ACP（Agent Client Protocol）兼容。TDSF 应借鉴其"agent pane + 上下文感知 + 错误自动检测"模式。

6. **HolmesGPT（CNCF Sandbox，Robusta + Microsoft 共建）是运维领域最佳参考**：50+ toolsets、双向告警集成、agentic loop 查询多数据源、Operator mode 24/7 监控。其 toolset 架构可直接借鉴用于 TDSF Linux 运维 toolset。

7. **教学型 Linux 运维 agent 无成熟开源项目**（多为商业 GPT/在线平台），TDSF 有差异化机会。

8. **TDSF sidecar 当前用 LangGraph 全家桶**（langgraph + langchain-core/community/openai/anthropic + chromadb），与用户"避免 LangChain 重框架"约束冲突。Strands/Pydantic AI 都比 LangGraph 轻 5-10 倍。

**一句话推荐**：用 Strands Agents 替换 LangGraph 作为 sidecar 主框架，P0 步骤是 ① requirements.txt 替换依赖 ② 新增 `sidecar/strands_tools/` 暴露 SSH/SFTP/RiskEngine ③ 包装 `StrandsAgent` 类 ④ main.py 注册新方法 ⑤ TdsfAgentPanel 适配流式响应。

---

## 二、调研方法论

### 2.1 候选项目识别

按用户要求，分三个方向 WebSearch 识别候选：

| 方向 | 调研关键词 | 候选项目 |
|------|-----------|----------|
| 轻量级 Agent 框架 | `Strands Agents AWS` / `Pydantic AI framework` / `OpenAI Swarm` / `smolagents HuggingFace` / `Atomic Agents` | Strands Agents、Pydantic AI、OpenAI Swarm、OpenAI Agents SDK、smolagents、Atomic Agents |
| 运维领域专项 | `SRE agent kubernetes opensource` / `Linux command teaching tutor AI` | HolmesGPT、K8sGPT、Aurora、Datadog Bits AI（商业）、Observe AI SRE（商业） |
| 终端集成型 | `terminal integrated AI agent context aware CWD` | Microsoft Intelligent Terminal、Warp、JetBrains AI Assistant、Gemini CLI |

### 2.2 深度分析项目筛选

从候选中按"对 TDSF 运维教学 agent 集成价值最高"筛选 12 个项目做深度分析（详见第四/五/六章）。

### 2.3 关键事实验证方式

- **Strands Agents**：抓 [GitHub README](https://github.com/strands-agents/sdk-python)、[官方文档](https://strandsagents.com/)、[AWS Compute Blog](https://aws.amazon.com/blogs/compute/effectively-building-ai-agents-on-aws-serverless/)
- **Pydantic AI**：抓 [Pydantic AI 文档](https://ai.pydantic.dev/)、[rywalker.com 调研](https://rywalker.com/research/pydantic-ai)、[Martin Fowler 文章](https://martinfowler.com/articles/build-own-coding-agent.html)
- **OpenAI Swarm/Agents SDK**：抓 [OpenAI Agents SDK 文档](https://openai.github.io/openai-agents-python/)、[aiwiki.ai 综述](https://aiwiki.ai/wiki/openai_agents_sdk/raw)、[respan.ai 迁移指南](https://www.respan.ai/articles/openai-agents-sdk-vs-swarm)
- **smolagents**：抓 [smolagents.org](https://smolagents.org/)、[腾讯云 MCP 广场](https://cloud.tencent.com/developer/mcp/server/11592)
- **HolmesGPT**：抓 [PyPI holmesgpt](https://pypi.org/project/holmesgpt/)
- **Intelligent Terminal**：抓 [Microsoft DevBlogs](https://devblogs.microsoft.com/commandline/announcing-intelligent-terminal-version-0-1/)

---

## 三、候选项目总览矩阵

| 项目 | License | Stars（2026-07） | 语言 | 框架依赖 | 工具调用 | 终端集成 | 运维场景适配 | 集成难度 | TDSF 契合度 |
|------|---------|------|------|---------|---------|---------|------------|---------|-----------|
| [Strands Agents](https://github.com/strands-agents/sdk-python) | Apache 2.0 | ~9k | Python/TS | 极轻（`pip install strands-agents`） | ✅ 内置 MCP + strands_tools | 内置 shell/file 工具 | 中（多 cloud 工具） | 低 | ★★★★★ |
| [Pydantic AI](https://github.com/pydantic/pydantic-ai) | MIT | 17.6k+ | Python | 轻（`pydantic-ai-slim` 可选） | ✅ `@agent.tool` + MCP | 无原生 | 中（deferred tools 对接 RiskEngine） | 低 | ★★★★★ |
| [OpenAI Swarm](https://github.com/openai/swarm) | MIT（实验） | 20k+（已废弃） | Python | 极轻（~1000 行） | ✅ functions | 无 | 低（教学原型） | 低 | ★★（不建议生产） |
| [OpenAI Agents SDK](https://github.com/openai/openai-agents-python) | MIT | 26.4k+ | Python/TS | 轻 | ✅ `@function_tool` + MCP + hosted tools | LocalShellTool | 中（Guardrails 对接 RiskEngine） | 低 | ★★★★ |
| [smolagents](https://github.com/huggingface/smolagents) | Apache 2.0 | ~11k | Python | 极轻（~1000 行核心） | ✅ CodeAgent + ToolCallingAgent + MCP | 无原生 | 中（沙箱执行） | 低 | ★★★★ |
| [Atomic Agents](https://github.com/BrainBlend-AI/atomic-agents) | Apache 2.0 | 较少 | Python | 轻（基于 Instructor+Pydantic） | ✅ `@tool` 装饰器 | 无 | 低 | 低 | ★★★ |
| [LangGraph](https://github.com/langchain-ai/langgraph)（TDSF 已用） | MIT | ~24.7k | Python | **重**（langchain 全家桶） | ✅ | 无 | 中 | 高（已用，重） | ★★（与"避免重框架"冲突） |
| [HolmesGPT](https://github.com/robusta-dev/holmesgpt) | Apache 2.0 | 2.8k+ | Python | 中 | ✅ 50+ toolsets | 无 | **高**（SRE 专项） | 中 | ★★★★（参考价值） |
| [K8sGPT](https://github.com/k8sgpt-ai/k8sgpt) | Apache 2.0 | 8k+ | **Go** | 中 | ✅ analyzers | 无 | 高（K8s 专项） | **高**（Go，与 Python sidecar 不匹配） | ★★（参考价值） |
| [Aurora](https://github.com/Arvo-AI/aurora) | Apache 2.0 | 369 | Python（LangGraph） | 重 | ✅ 22+ 工具 | 无 | 高（跨云 SRE） | 中 | ★★（参考价值） |
| [Microsoft Intelligent Terminal](https://github.com/microsoft/terminal) | MIT（推测） | 新 | C++（Win Terminal fork） | N/A | ACP 协议 | **高**（agent pane + 上下文） | N/A | N/A | ★★★★★（**对标产品**） |
| [Warp](https://www.warp.dev/) | 闭源 | N/A | Rust | N/A | ✅ Agent Mode | 高 | N/A | N/A | ★★★★（对标产品） |

---

## 四、轻量级 Agent 框架深度分析

### 4.1 Strands Agents（AWS）— ⭐ TDSF 首选

**仓库**：[strands-agents/sdk-python](https://github.com/strands-agents/sdk-python) · **License**：Apache 2.0 · **语言**：Python 3.10+ / TypeScript · **开源日期**：2025-05-16

#### 4.1.1 项目定位

> A model-driven approach to building AI agents in just a few lines of code. — [官方文档](https://strandsagents.com/)

Strands Agents 是 AWS 开源的代码优先（code-first）Agent SDK，采用**模型驱动**范式：开发者只定义"模型 + 工具 + 提示词"三要素，框架自动完成 agent loop、工具编排、上下文管理。已在 Amazon Q Developer、Amazon Glue、VPC Reachability Analyzer 等 AWS 生产产品中使用。

#### 4.1.2 核心架构

**最小可用代码**（[GitHub README](https://github.com/strands-agents/sdk-python)）：

```python
from strands import Agent
from strands_tools import calculator

agent = Agent(tools=[calculator])
agent("What is the square root of 1764")
```

**关键设计**：
- **模型驱动 + Agentic Loop**：LLM 自身负责规划/工具调用/反思，框架只做循环编排（不同于 LangGraph 的图编排）
- **模型无关**：Amazon Bedrock、Anthropic、Gemini、LiteLLM、Llama、Ollama、OpenAI、Writer、自定义 provider
- **内置 MCP**：原生支持 Model Context Protocol，可接入数千个预构建工具
- **多 agent 系统**：支持子 agent 编排、autonomous agents、streaming
- **生产可观测性**：OpenTelemetry 内置
- **多部署形态**：本地、Lambda、ECS、Bedrock AgentCore Runtime

#### 4.1.3 内置工具生态

`strands-agents-tools` 包提供：
- **文件操作**：read/write/list/move/copy
- **系统命令**：shell execution
- **网络请求**：HTTP fetch
- **代码执行**：Python interpreter
- **数学计算**：calculator
- **图像处理**：image manipulation
- **AWS 服务**：与 Bedrock/S3/Lambda 等无缝对接

#### 4.1.4 多 Agent 协作

支持通过预置模板、简化配置构建多智能体系统，实现工作流编排、关系网络构建和集群协同。这与 TDSF 现有 8 子 agent 架构（coding/debug/deploy/explore/history/refactor/teach/test）高度契合。

#### 4.1.5 对 TDSF 的参考价值

| 价值点 | 说明 | 采纳建议 |
|--------|------|---------|
| 极简 API | `Agent(tools=[...])("question")` 一行起 | **首选**：教学场景下学生易理解 |
| 模型驱动 | 无需画图，LLM 自规划 | 替代 LangGraph 的 PAOR 7 节点图 |
| 内置 shell/file 工具 | strands_tools 已有 | 直接复用，省去自写 SSH/SFTP 工具的样板 |
| MCP 原生 | 内置支持 | 暴露 RiskEngine 为 MCP 工具，agent 可主动查询命令风险 |
| AWS 生产验证 | Amazon Q Developer 等 | 工业级可靠性背书 |
| 模型无关 | LiteLLM/Ollama/Bedrock | 教学场景可用本地 Ollama 离线模型 |
| 轻量依赖 | `pip install strands-agents` | 比 LangGraph 全家桶轻 5-10 倍 |

**结论**：Strands Agents 是本次调研中**与 TDSF 约束契合度最高的框架**——轻量、Python、模型驱动、内置运维相关工具、教学友好。

---

### 4.2 Pydantic AI — ⭐ TDSF 次选

**仓库**：[pydantic/pydantic-ai](https://github.com/pydantic/pydantic-ai) · **License**：MIT · **Stars**：17.6k+（2026-06）· **下载量**：33M+/月 · **v1 GA**：2025-09 · **v2 beta**：2026-06

#### 4.2.1 项目定位

Pydantic AI 是 Pydantic 团队（Pydantic 库月下载量 1B+）出品的 Agent 框架，号称"FastAPI 一样的开发体验"：定义 typed output schema，框架自动验证 LLM 响应，验证失败时自动让模型自修正。

#### 4.2.2 核心架构

**最小可用代码**（[文档](https://ai.pydantic.dev/)）：

```python
from pydantic import BaseModel
from pydantic_ai import Agent, RunContext

class WeatherReport(BaseModel):
    temperature: float
    conditions: str

weather_agent = Agent(
    'openai:gpt-4o',
    output_type=WeatherReport,
    system_prompt='你是天气查询助手'
)

result = weather_agent.run_sync('查询北京今天天气')
print(result.output.temperature)  # 类型安全，IDE 自动补全
```

#### 4.2.3 五大核心组件

| 组件 | 作用 | 示例 |
|------|------|------|
| **Agent** | LLM 交互生命周期封装 | `Agent(model, output_type, deps_type)` |
| **模型集成** | 20+ provider 统一接口 + FallbackModel 故障转移 | OpenAI/Anthropic/Gemini/Bedrock/Ollama 等 |
| **工具系统** | `@agent.tool`（带依赖注入）/ `@agent.tool_plain`（无 ctx） | 通过 `RunContext[Deps]` 注入运行时依赖 |
| **结构化输出** | Pydantic 模型验证 + 自反射修正 | 验证失败时自动让 LLM 重试 |
| **Pydantic Graph** | 图执行引擎 | 可替代 LangGraph 构建复杂工作流 |

#### 4.2.4 关键高级特性

- **Durable Execution**：原生 Temporal/DBOS/Prefect/Restate 集成，支持 fault-tolerant agents
- **MCP & A2A**：Model Context Protocol（工具/数据）+ Agent2Agent（agent 间通信）
- **Deferred Tools with Conditional Approval Gating**：⭐ **Human-in-the-loop 机制**——关键操作可配置为"延迟执行 + 需用户批准"
- **Evals**：内置评估框架（LLM judges、custom evaluators、online evaluation）
- **Streaming**：流式结构化输出 + 实时验证
- **Logfire 可观测性**：OpenTelemetry-based，免费 Personal tier

#### 4.2.5 对 TDSF 的参考价值

| 价值点 | 说明 | 采纳建议 |
|--------|------|---------|
| **类型安全** | Pydantic 模型输出验证 + 自反射修正 | 教学场景能给学生**结构化反馈**（如"命令解释 + 风险等级 + 替代方案"对象） |
| **Deferred Tools** | 延迟执行 + 需用户批准 | ⭐ **天然对接 RiskEngine**：高危命令工具声明为 deferred，调用时暂停等用户确认 |
| **依赖注入** | `RunContext[Deps]` 注入 SSH session、cwd 等 | 工具函数能拿到终端上下文，无需全局状态 |
| **Pydantic Graph** | 图执行引擎 | 可替代 LangGraph 构建类似 PAOR 的工作流 |
| **MCP 原生** | 内置 MCP 支持 | 暴露 RiskEngine 为 MCP 工具 |
| **20+ 模型 provider** | OpenAI/Anthropic/Gemini/Ollama 等 | 教学场景可用本地 Ollama |
| **版本策略** | v1 不再有 breaking change，v2 并行 beta | 生产稳定性有保障 |

**结论**：Pydantic AI 的 **deferred tools 机制**是与 TDSF RiskEngine 协同的最佳匹配——高危命令工具声明为 deferred，agent 调用时自动暂停等用户确认，与现有"L3+ 命令前端拦截"逻辑无缝衔接。

---

### 4.3 OpenAI Swarm + Agents SDK — Swarm 已废弃，Agents SDK 是生产版

#### 4.3.1 Swarm（已废弃）

**仓库**：[openai/swarm](https://github.com/openai/swarm) · **License**：MIT（实验）· **状态**：⚠️ **已被 Agents SDK 取代**（README 已重定向）

Swarm 是 OpenAI 2024-10 发布的实验性教学框架，~1000 行代码，引入两个核心抽象：
- **Routines**：agent = system prompt + tools
- **Handoffs**：工具返回 Agent 对象即转移控制权

**关键限制**（[respan.ai 迁移指南](https://www.respan.ai/articles/openai-agents-sdk-vs-swarm)）：
- 无错误处理/重试/持久化
- 无 tracing
- 无 guardrails
- 客户端运行、调用间无状态
- 同步 only，async 会 hang
- README 明确声明"not for production"

#### 4.3.2 OpenAI Agents SDK（生产版继承者）

**仓库**：[openai/openai-agents-python](https://github.com/openai/openai-agents-python) · **License**：MIT · **Stars**：26.4k+（2026-05）· **首发**：2025-03-11

Agents SDK 保留 Swarm 的 routines + handoffs 核心，加入生产层：

**四核心原语**：
1. **Agents**：LLM + instructions + tools + handoffs + output_type + guardrails
2. **Handoffs**：agent 间任务委派（manager 模式 / handoff 模式）
3. **Guardrails**：⭐ **input/output/tool 三层验证 + tripwire 中断**（与 TDSF RiskEngine 同一思路）
4. **Tracing**：内置追踪（agent/generation/function/guardrail/handoff/sandbox span）

**2026-04 "Next Evolution" 新增**：
- **Sandbox Agents**（beta）：Manifest 描述工作区 + 9 个后端（Unix local/Docker + 7 hosted：Blaxel/Cloudflare/Daytona/E2B/Modal/Runloop/Vercel）
- **Long-Horizon Harness**：复杂多步任务的持久状态编排
- **Subagents**（beta）：parent agent spawn 子 agent，并行执行
- **Code mode**（规划中）：Codex-style 代码生成与执行

**关键特性**：
- `@function_tool` 装饰器自动生成 schema + Pydantic 验证
- Sessions（SQLite/MongoDB/Redis 持久化）
- Human-in-the-loop：`needsApproval` 工具配置
- 100+ LLM via LiteLLM
- MCP 一等公民（hosted/HTTP/Stdio 三种 server）
- Hosted tools：web search、file search、code interpreter、computer use、image generation、**LocalShellTool**
- `apply_patch` 文件编辑工具（sandbox harness）

#### 4.3.3 对 TDSF 的参考价值

| 价值点 | 说明 | 采纳建议 |
|--------|------|---------|
| **Guardrails 三层验证** | input/output/tool + tripwire | ⭐ **直接对接 RiskEngine**：tool guardrail 在 SSH 命令工具调用前检查风险 |
| LocalShellTool | 内置 shell 执行工具 | 参考 API 设计 |
| Sessions 持久化 | SQLite/MongoDB/Redis | 补充 TDSF 缺失的会话状态持久化 |
| Sandbox Agents | Manifest + 9 后端 | 教学场景可用 UnixLocalSandboxClient 隔离学生操作 |
| Human-in-the-loop | `needsApproval` | 与 Pydantic AI deferred tools 等价 |

**结论**：Swarm 不建议使用（已废弃）。Agents SDK 的 Guardrails 机制是 Strands/Pydantic AI 之外的最佳备选——若 TDSF 倾向"OpenAI 生态优先"，Agents SDK 是合理选择。

---

### 4.4 smolagents（HuggingFace）— ⭐ TDSF 第三选择

**仓库**：[huggingface/smolagents](https://github.com/huggingface/smolagents) · **License**：Apache 2.0 · **核心代码**：~1000 行（`agents.py`）

#### 4.4.1 项目定位

> Agents that think in code! — [smolagents.org](https://smolagents.org/)

HuggingFace 出品的极简 agent 库，核心创新是 **CodeAgent**：动作是 Python 代码（不是 JSON），减少 30% 步骤和 LLM 调用。

#### 4.4.2 两种 Agent 类型

- **CodeAgent**：LLM 写 Python 代码片段作为动作
  ```python
  # 传统 JSON 工具调用
  {"name": "web_search", "arguments": {"query": "HuggingFace"}}
  
  # smolagents CodeAgent
  results = web_search("HuggingFace")
  for result in results:
      print(f"Result: {result}")
  ```
- **ToolCallingAgent**：传统 JSON 工具调用（兼容现有 LLM tool use API）

#### 4.4.3 关键特性

| 特性 | 说明 |
|------|------|
| **简洁性** | 核心代码 ~1000 行，抽象最小化 |
| **代码即动作** | 支持循环/条件/变量赋值，表达力强 |
| **安全执行** | AST 静态分析 + 导入限制 + E2B/Docker 沙箱 + 输出限制 |
| **模型无关** | HF InferenceClient/LiteLLM/OpenAI Server/Azure/Bedrock/Transformers（本地） |
| **模态无关** | 文本/视觉/视频/音频 |
| **工具无关** | MCP/LangChain/Hub Space 都可作为工具 |
| **Hub 集成** | `agent.push_to_hub("m-ric/my_agent")` 分享/拉取 |

#### 4.4.4 对 TDSF 的参考价值

| 价值点 | 说明 | 采纳建议 |
|--------|------|---------|
| **CodeAgent 透明性** | 动作是 Python 代码，学生能看到"agent 怎么思考" | 教学场景极佳（展示推理过程） |
| **多层安全** | AST 分析 + 导入限制 + 沙箱 | 与 RiskEngine 协同：CodeAgent 执行前调用 RiskEngine.check() |
| **Hub 分享** | 学生/老师可分享学习 agent | 教学社区建设 |
| **极简核心** | ~1000 行可通读 | 教学场景下"框架本身可教学" |
| **模型无关** | 本地 Transformers/Ollama | 离线教学场景 |

**风险**：CodeAgent 执行 Python 代码，沙箱必须严谨；教学场景需限制可执行代码范围（如禁用 `os.system` 直接调用，强制走 RiskEngine 审核的 wrapper）。

---

### 4.5 Atomic Agents — 模块化备选

**仓库**：[BrainBlend-AI/atomic-agents](https://github.com/BrainBlend-AI/atomic-agents) · **License**：Apache 2.0 · **v2.0**：2025-09

#### 4.5.1 项目定位

受"原子设计"启发的模块化 agent 框架，每个组件（工具/agent/context provider）单一职责、可复用。基于 Instructor + Pydantic。

#### 4.5.2 核心特性

- **Atomic Assembler CLI**：下载/管理工具和 agent
- **类型安全**：基于 Pydantic schema
- **可预测性**：清晰输入输出 schema，行为一致
- **可控制性**：每个独立步骤可微调（system prompt 到工具层面）
- **多模型兼容**：OpenAI/Anthropic/Gemini/Ollama（通过 Instructor）

#### 4.5.3 对 TDSF 的参考价值

Atomic Agents 的"原子化组件 + 可预测"理念适合教学场景（每个组件可单独教学），但生态规模和工业验证弱于 Strands/Pydantic AI。**仅作为备选参考**，不作为主推。

---

### 4.6 LangGraph（TDSF 已用）— 重框架，建议替换

**仓库**：[langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) · **License**：MIT · **v1.0 GA**：2025-10

已有报告 [`ops-agent-opensource-research.md`](./ops-agent-opensource-research.md) 第四章已充分分析 LangGraph。本次仅补充：

**TDSF sidecar 现状**（[`requirements.txt`](../../src-tauri/sidecar/requirements.txt)）：
```text
langgraph>=0.2.0
langchain-core>=0.3.0
langchain-community>=0.3.0
langchain-openai>=0.2.0
langchain-anthropic>=0.2.0
pydantic>=2.0
chromadb>=0.5.0
```

**问题**：
1. **重依赖**：5 个 langchain 包 + chromadb，与用户"避免 LangChain 重框架"约束冲突
2. **sidecar 当前崩溃**（[dev-state.md](../dev-state.md) P2-5）：`main.py` 注册 ping/shutdown/status 后 stdout closed 退出，实际未运行
3. **PAOR 7 节点图过度设计**：supervisor/plan/act/observe/reflect/tool_call/permission_check 7 节点对教学场景过重

**建议**：sidecar 重做时评估替换为 Strands Agents 或 Pydantic AI。若坚持用 LangGraph，至少精简为 `langgraph + langchain-core`（去掉 community/openai/anthropic，用 LiteLLM 统一接口）。

---

## 五、运维领域专项 Agent 深度分析

### 5.1 HolmesGPT — ⭐ CNCF SRE Agent，最佳运维参考

**仓库**：[robusta-dev/holmesgpt](https://github.com/robusta-dev/holmesgpt) · **License**：Apache 2.0 · **Stars**：2.8k+（2026-07）· **Status**：CNCF Sandbox · **共建**：Robusta + Microsoft

#### 5.1.1 项目定位

> Open-source AI agent for investigating production incidents and finding root causes. Works with any stack — Kubernetes, VMs, cloud providers, databases, and SaaS platforms. — [PyPI](https://pypi.org/project/holmesgpt/)

#### 5.1.2 核心架构

**Agentic Loop**：查询多个数据源 → 综合推理 → 输出根因 + 修复建议。

**50+ 内置 Toolsets**（按类别）：
- **容器编排**：Kubernetes、OpenShift、Helm、Crossplane、ArgoCD
- **云平台**：AWS、Azure、GCP、AKS、Azure SQL、MongoDB Atlas
- **数据库**：PostgreSQL、MySQL、MongoDB、MariaDB、ClickHouse、SQL Server、SQLite
- **可观测性**：Prometheus、Grafana、Datadog、NewRelic、Coralogix、Elasticsearch、OpenSearch、Loki、Tempo、VictoriaLogs、VictoriaMetrics、Splunk
- **消息队列**：Kafka、RabbitMQ
- **CI/CD**：Jenkins、GitLab、GitHub
- **运维平台**：ServiceNow、PagerDuty、OpsGenie、AlertManager（双向告警集成）
- **知识库**：Confluence、Slab、Internet（公共 runbook）
- **容器运行时**：Docker
- **工作流编排**：Prefect

#### 5.1.3 关键特性

| 特性 | 说明 |
|------|------|
| **Operator Mode** | 24/7 后台监控，主动发现问题，Slack 推送修复建议，可开 PR 自动修复 |
| **Petabyte-scale 数据** | 服务端过滤 + JSON tree 遍历 + tool output transformer，大 payload 不进 context window |
| **Memory-safe execution** | per-tool 内存限制 + 流式写盘 + 自动 output budget，防 OOM |
| **双向告警集成** | 从 AlertManager/PagerDuty/OpsGenie/Jira 拉告警，回写调查结论 |
| **任何 LLM** | OpenAI/Anthropic/Azure/Bedrock/Gemini 等 |
| **不要求 K8s** | 适配 VM/裸机/云服务/容器 |

#### 5.1.4 对 TDSF 的参考价值

| 价值点 | 说明 | 采纳建议 |
|--------|------|---------|
| **Toolset 架构** | 50+ toolset 按类别组织 | ⭐ 借鉴：为 TDSF 新增 Linux 运维 toolset（systemd/journalctl/network/stats/ssh-remote） |
| **Agentic Loop** | 查询多数据源 → 推理 → 输出 | 与 Strands Agents 的 agent loop 等价 |
| **Memory-safe** | per-tool 内存限制 | 教学场景下防止学生操作 OOM |
| **双向告警集成** | 拉告警 + 回写结论 | 教学场景可简化为"问题 → 解释 → 修复建议" |
| **自定义 Playbook** | Python ~200 行覆盖标准工具集未覆盖场景 | 教学场景下老师可写教学 playbook |

**结论**：HolmesGPT 不是要直接集成（它是 SRE 工具，TDSF 是教学工具），但其 **toolset 架构 + agentic loop + memory-safe 执行** 三项设计值得深度借鉴。建议 TDSF 参考 HolmesGPT 的 toolset 组织方式构建 Linux 运维教学 toolset。

---

### 5.2 K8sGPT — K8s 专项，Go 语言不匹配

**仓库**：[k8sgpt-ai/k8sgpt](https://github.com/k8sgpt-ai/k8sgpt) · **License**：Apache 2.0 · **Stars**：8k+ · **Status**：CNCF Sandbox

#### 5.2.1 项目定位

专为 Kubernetes 故障诊断设计的 AI 助手。CLI + Operator 双模式。

#### 5.2.2 关键特性

- **内置分析器**：PodAnalyzer、ServiceAnalyzer、DeploymentAnalyzer 等，基于 SRE 经验编码
- **多模型支持**：OpenAI/Azure/Gemini/Ollama/LocalAI/Bedrock/IBM Watsonx
- **匿名化扫描**：敏感信息发送 AI 前脱敏，返回后还原
- **自动修复**：Mutation CR + 回滚机制
- **MCP server** 支持
- **Operator 模式**：集群内持续监控，结果存为 K8s CR

#### 5.2.3 对 TDSF 的参考价值

K8sGPT 是 **Go 语言**项目，与 TDSF 的 Python sidecar 不匹配，无法直接集成。但其 **analyzer 架构**（按资源类型分类的诊断器）值得借鉴——TDSF 可参考为 Linux 运维场景设计类似 analyzer（如 ProcessAnalyzer、NetworkAnalyzer、SystemdAnalyzer）。

---

### 5.3 Aurora — 跨云多 Agent SRE（LangGraph 实现）

**仓库**：[Arvo-AI/aurora](https://github.com/Arvo-AI/aurora) · **License**：Apache 2.0 · **Stars**：369（2026-01 开源）

#### 5.3.1 项目定位

用 LangGraph 编排多 agent 协作的跨云 SRE 工具，支持 AWS/Azure/GCP/K8s，集成 22+ 工具，知识图谱（Memgraph）维护基础设施依赖。

#### 5.3.2 对 TDSF 的参考价值

Aurora 验证了"LangGraph 多 agent + 知识图谱"的可行性，但：
1. 用 LangGraph（与"避免重框架"冲突）
2. 面向生产 SRE（非教学）
3. 较新（369 stars），生态弱

**仅作为"LangGraph 多 agent 在 SRE 场景应用"的参考案例**，不建议直接集成。

---

## 六、终端集成型 Agent 深度分析

### 6.1 Microsoft Intelligent Terminal — ⭐⭐ TDSF 对标产品

**仓库**：[microsoft/terminal](https://github.com/microsoft/terminal)（Intelligent Terminal 是 fork）· **发布**：2026-06-02（Build 2026 宣布）· **License**：MIT（推测）

#### 6.1.1 项目定位

> An open-source experimental fork of Windows Terminal with native agent integration. — [Microsoft DevBlogs](https://devblogs.microsoft.com/commandline/announcing-intelligent-terminal-version-0-1/)

微软 2026-06 发布的 Intelligent Terminal 0.1 是 TDSF 的**直接对标产品**——基于 Windows Terminal fork，原生集成 AI agent。

#### 6.1.2 核心特性（与 TDSF 高度重合）

| 特性 | 说明 | TDSF 对应 |
|------|------|-----------|
| **Agent Pane** | 侧边栏整合 AI agent，看 shell 上下文 | TdsfAgentPanel.tsx |
| **Context-aware** | agent 始终持有 shell 输出上下文 | OSC 133/7 shell integration 已暴露 cwd/命令 |
| **Automatic Error Detection** | 命令失败自动检测，灯亮提示，点击加载错误上下文 | TDSF 可新增：监控 PTY 输出的 exit code + stderr |
| **ACP 兼容** | Agent Client Protocol，支持任何 ACP agent | TDSF 可考虑对接 ACP 标准 |
| **Agent Management** | 多 agent 会话管理面板 | TDSF 的 agents/registry.ts |
| **Command Palette 入口** | `? + prompt` 注入活动 pane 上下文启动 agent | TDSF 可新增快捷键入口 |
| **可配置 agent** | 默认 GitHub Copilot CLI，支持自定义/local agent | TDSF 的 BYOA adapters（aider/claude/codex 等） |

#### 6.1.3 对 TDSF 的关键启示

1. **Agent Pane 模式**：TDSF 的 TdsfAgentPanel 应强化为"持久 docked pane"，而非临时弹窗
2. **错误自动检测**：TDSF 应监控 PTY exit code，失败时自动在 agent pane 加载错误上下文（学生不用复制粘贴）
3. **ACP 协议**：TDSF 可评估对接 [Agent Client Protocol](https://agentclientprotocol.com/)，让任何 ACP 兼容 agent（如 Claude Code）能接入
4. **Command Palette 入口**：TDSF 可加 `Ctrl+Shift+?` 快捷键，注入当前终端上下文启动 agent

**结论**：Intelligent Terminal 是 TDSF 的"未来形态"参考。TDSF 作为 Linux 运维教学工具，可借鉴其 UX 模式，但聚焦 Linux/SSH 场景（Intelligent Terminal 是本地 Windows Terminal）。

---

### 6.2 Warp — 闭源商业对标

**官网**：[warp.dev](https://www.warp.dev/) · **状态**：闭源 · **Windows 版**：2025-02

#### 6.2.1 核心特性

- **Agent Mode**：自然语言导航终端，debug 错误、修复代码、总结日志
- **深度上下文**：使用 saved commands + codebase context + 当前 shell + 过去操作
- **自动执行命令**：agent 可直接执行命令，无需用户离开流程
- **语音调用**：支持语音触发 Agent Mode
- **Rust + GPU 渲染**：性能极快
- **Blocks 模式**：输入输出按 block 组织，可导航/过滤/分享
- **Warp Drive**：保存 Workflow/Notebook，团队分享

#### 6.2.2 对 TDSF 的参考价值

Warp 是闭源商业产品，无法直接集成。但其 **"saved commands + codebase context + shell + 历史"四源上下文**模式值得借鉴——TDSF 可构建类似的"终端上下文聚合器"喂给 agent。

---

### 6.3 JetBrains AI Assistant + Gemini CLI — 辅助参考

#### JetBrains AI Assistant 终端命令生成
- 考虑 shell 类型 + 当前目录 + 之前命令输出
- 自然语言 → 命令 → Enter 执行
- 已废弃（实验性 New Terminal）

#### Gemini CLI
- Apache 2.0 开源
- 1M token context window
- MCP 支持
- Google Search 集成
- 系统管理场景

**对 TDSF 的参考价值**：JetBrains 的"shell + cwd + 历史输出"上下文模型与 TDSF OSC 133/7 已暴露的信息一致，验证了 TDSF 上下文采集方向正确。Gemini CLI 的 MCP 支持进一步证明 MCP 已成为 agent 工具调用的事实标准。

---

## 七、Top 3 推荐方案

### 🥇 方案 A（首选）：Strands Agents

**推荐理由**：
1. **最轻量**：`pip install strands-agents strands-agents-tools`，无 langchain 全家桶
2. **教学友好**：`Agent(tools=[...])("question")` 一行起，学生易理解
3. **模型驱动**：LLM 自规划，无需画图，比 LangGraph PAOR 7 节点图更轻
4. **内置运维工具**：strands_tools 已有 shell/file 工具，省去自写样板
5. **AWS 生产验证**：Amazon Q Developer 等工业级背书
6. **模型无关**：LiteLLM/Ollama/Bedrock，教学场景可用本地 Ollama 离线
7. **MCP 原生**：暴露 RiskEngine 为 MCP 工具，agent 主动查询命令风险
8. **Apache 2.0**：无商业限制

**集成路径**：sub-package（`sidecar/strands_agents_base/` 新增，与现有 `graph/` 并存或替换）

**工具调用机制**：
```python
# 伪代码示意
from strands import Agent
from sidecar.strands_tools.ssh import ssh_execute  # 暴露 SSH 命令执行
from sidecar.strands_tools.sftp import sftp_read, sftp_write
from sidecar.strands_tools.risk import check_risk  # RiskEngine MCP 工具

teach_agent = Agent(
    system_prompt="你是 Linux 运维教学助手，解释每条命令...",
    tools=[ssh_execute, sftp_read, sftp_write, check_risk],
    model=ollama_model  # 教学场景用本地模型
)
response = teach_agent("解释 systemctl status nginx 的输出")
```

**上下文感知**：在 system prompt 或 tool 参数中注入 OSC 133/7 解析的 cwd/最近命令：
```python
def ssh_execute(command: str, ctx: RunContext) -> str:
    cwd = ctx.deps.get("cwd")  # 从 OSC 7 解析
    recent_commands = ctx.deps.get("recent_commands")  # 从 OSC 133 解析
    # RiskEngine 前置检查
    risk = check_risk(command)
    if risk.level >= "L3":
        return f"⚠️ 高危命令需用户确认: {risk.reason}"
    return ssh_session.run(command, cwd=cwd)
```

**与现有 RiskEngine 协同**：
- 工具调用前置回调：在 `ssh_execute` 工具内调用现有 `src/lib/risk-engine/rules.ts`（通过 JSON-RPC 桥到 Rust）
- MCP 暴露：将 RiskEngine 暴露为 MCP server，agent 可主动调用 `check_command` / `suggest_alternative` / `explain_risk`（参考已有报告 6.3 节方案 H）

**改动文件预估**：
| 文件 | 改动类型 | 说明 |
|------|---------|------|
| `src-tauri/sidecar/requirements.txt` | 修改 | 移除 langchain-*，新增 `strands-agents`、`strands-agents-tools` |
| `src-tauri/sidecar/strands_agents_base/__init__.py` | 新增 | Strands Agent 包装层 |
| `src-tauri/sidecar/strands_agents_base/tools/ssh.py` | 新增 | SSH 命令执行工具（含 RiskEngine 前置检查） |
| `src-tauri/sidecar/strands_agents_base/tools/sftp.py` | 新增 | SFTP 文件读写工具 |
| `src-tauri/sidecar/strands_agents_base/tools/risk.py` | 新增 | RiskEngine MCP 工具 |
| `src-tauri/sidecar/strands_agents_base/tools/teach.py` | 新增 | 教学专用工具（命令解释、知识点扩展） |
| `src-tauri/sidecar/agents/*.py` | 修改 | 8 个子 agent 迁移为 Strands Agent |
| `src-tauri/sidecar/main.py` | 修改 | 注册新 JSON-RPC 方法 `agent.run` |
| `src/modules/ai/TdsfAgentPanel.tsx` | 修改 | 适配流式响应 |
| `src/modules/ai/lib/composer.tsx` | 修改 | AiComposerProvider 适配 |

**风险**：
- Strands 相对年轻（2025-05 开源），生态还在成长
- 现有 sidecar 已写大量代码（PAOR 图、技能市场、知识库等），完全替换成本高
- **缓解**：分阶段迁移，先新增 Strands agent 与现有 LangGraph 并存，验证后再逐步替换

---

### 🥈 方案 B（次选）：Pydantic AI

**推荐理由**：
1. **类型安全**：Pydantic 模型输出验证 + 自反射修正，教学场景能给学生结构化反馈
2. **Deferred Tools**：⭐ **天然对接 RiskEngine**——高危命令工具声明为 deferred，调用时暂停等用户确认
3. **依赖注入**：`RunContext[Deps]` 注入 SSH session、cwd 等，无需全局状态
4. **Pydantic Graph**：可替代 LangGraph 构建类似 PAOR 的工作流
5. **Pydantic 团队背书**：1B+ 月下载量的 Pydantic 库团队，工业级稳定性
6. **版本策略**：v1 不再有 breaking change，v2 并行 beta
7. **MIT 协议**：无商业限制

**集成路径**：替换 `sidecar/graph/` 下的 LangGraph 实现

**工具调用机制**：
```python
# 伪代码示意
from pydantic_ai import Agent, RunContext
from pydantic import BaseModel

class TeachOutput(BaseModel):
    command_explanation: str
    risk_level: str
    alternative: str | None
    knowledge_points: list[str]

@dataclass
class TeachDeps:
    ssh_session: SshSession
    cwd: str
    recent_commands: list[str]

teach_agent = Agent(
    'ollama:qwen2.5',
    deps_type=TeachDeps,
    output_type=TeachOutput,
    system_prompt="你是 Linux 运维教学助手..."
)

@teach_agent.tool
async def ssh_execute(ctx: RunContext[TeachDeps], command: str) -> str:
    """执行 SSH 命令（高危命令需用户确认）"""
    risk = await check_risk(command)
    if risk.level >= "L3":
        # Deferred tool: 暂停等用户确认
        raise DeferredToolError("高危命令需用户确认", command, risk)
    return await ctx.deps.ssh_session.run(command)
```

**上下文感知**：通过 `deps_type` 注入 `TeachDeps`（含 cwd、recent_commands）

**与现有 RiskEngine 协同**：
- Deferred tools：高危命令工具声明为 deferred，agent 调用时自动暂停
- Output guardrails：输出前验证 `risk_level` 字段与 RiskEngine 结果一致

**改动文件预估**：与方案 A 类似，但工具实现用 Pydantic AI 装饰器，graph/ 目录重写为 Pydantic Graph

**风险**：
- 替换 LangGraph 成本中等（需重写 PAOR 图）
- Deferred tools 是 v1+ 特性，需确认与本地 Ollama 模型兼容性

---

### 🥉 方案 C（第三）：smolagents

**推荐理由**：
1. **CodeAgent 透明性**：动作是 Python 代码，学生能看到"agent 怎么思考"，教学价值高
2. **极简核心**：~1000 行可通读，框架本身可教学
3. **多层安全**：AST 分析 + 导入限制 + 沙箱，与 RiskEngine 协同
4. **Hub 集成**：学生/老师可分享学习 agent
5. **模型无关**：本地 Transformers/Ollama
6. **HuggingFace 出品**：生态背书

**集成路径**：sub-package（`sidecar/smolagents_base/` 新增）

**工具调用机制**：
```python
from smolagents import CodeAgent, Tool

class RiskCheckedShellTool(Tool):
    name = "ssh_execute"
    description = "执行 SSH 命令（自动 RiskEngine 检查）"
    inputs = {"command": {"type": "string", "description": "要执行的命令"}}
    output_type = "string"
    
    def forward(self, command: str) -> str:
        risk = check_risk(command)
        if risk.level >= "L3":
            return f"⚠️ 高危命令被拦截: {risk.reason}. 替代方案: {risk.alternative}"
        return ssh_session.run(command)

agent = CodeAgent(
    tools=[RiskCheckedShellTool()],
    model=OllamaModel("qwen2.5-coder"),
    system_prompt="你是 Linux 运维教学助手..."
)
```

**风险**：
- CodeAgent 执行 Python 代码，沙箱必须严谨
- 教学场景需限制可执行代码范围（如禁用 `os.system` 直接调用，强制走 RiskEngine 审核的 wrapper）
- CodeAgent 对模型代码生成能力要求高，本地小模型可能效果不稳定

---

## 八、TDSF 项目集成建议

### 8.1 集成路线图（P0/P1/P2/P3）

| 优先级 | 方案 | 价值 | 工作量 | 风险 | 时机 |
|--------|------|------|--------|------|------|
| **P0** | 用 Strands Agents 构建 sidecar 新 agent 层 | 高 | 中（5-7 天） | 低 | sidecar 修复后立即 |
| **P0** | 暴露 RiskEngine 为 MCP 工具 | 高 | 中（3-5 天） | 低 | 与 P0 并行 |
| **P1** | 迁移 8 子 agent 到 Strands | 中 | 高（10-15 天） | 中 | P0 验证后 |
| **P1** | 借鉴 HolmesGPT toolset 架构，新增 Linux 运维 toolset | 中 | 中（5-7 天） | 低 | P1 同期 |
| **P2** | 借鉴 Intelligent Terminal，强化 TdsfAgentPanel 上下文感知 | 中 | 中（5-7 天） | 低 | P1 后 |
| **P2** | 评估对接 ACP 协议 | 中 | 中（5-7 天） | 中 | P2 |
| **P3** | 移除 LangGraph（如 Strands 验证成功） | 中 | 高（5-7 天） | 中 | P1 后 3 个月 |

### 8.2 P0 方案具体集成步骤

**前置条件**：先修复 sidecar 崩溃（[dev-state.md](../dev-state.md) P2-5：手动跑 `python main.py` 看 traceback + restart 加退避）

#### 步骤 1：替换依赖（1 天）

修改 `src-tauri/sidecar/requirements.txt`：
```text
# 移除（如确认不再用 LangGraph）
# langgraph>=0.2.0
# langchain-core>=0.3.0
# langchain-community>=0.3.0
# langchain-openai>=0.2.0
# langchain-anthropic>=0.2.0

# 新增
strands-agents>=0.1.0
strands-agents-tools>=0.1.0
litellm>=1.0  # 统一 LLM 接口

# 保留
pydantic>=2.0
# chromadb>=0.5.0  # 视是否还需要向量检索决定
```

**注意**：分两步走更稳妥——先**新增** Strands 依赖（不删 langchain），让两套并存验证，再逐步迁移。完全替换是 P3。

#### 步骤 2：创建 Strands 工具适配层（2 天）

新增 `src-tauri/sidecar/strands_agents_base/__init__.py`：

```python
from strands import Agent
from .tools.ssh import ssh_execute
from .tools.sftp import sftp_read, sftp_write, sftp_list
from .tools.risk import check_risk, suggest_alternative, explain_risk
from .tools.teach import explain_command, expand_knowledge

def create_teach_agent(model_provider: str = "ollama"):
    """创建教学 agent"""
    return Agent(
        system_prompt="""你是 Linux 运维教学助手。对于每条命令：
1. 解释命令作用
2. 评估风险等级（safe/low/medium/high/deny）
3. 给出安全替代方案（如有）
4. 扩展相关知识点""",
        tools=[ssh_execute, sftp_read, sftp_write, sftp_list,
               check_risk, suggest_alternative, explain_risk,
               explain_command, expand_knowledge],
        model=model_provider
    )
```

新增 `src-tauri/sidecar/strands_agents_base/tools/ssh.py`：

```python
from strands import tool
from typing import Any

@tool
async def ssh_execute(command: str, session_id: str) -> dict:
    """在远程 SSH 会话中执行命令（自动 RiskEngine 检查）
    
    Args:
        command: 要执行的 shell 命令
        session_id: SSH 会话 ID
    
    Returns:
        {"stdout": "...", "stderr": "...", "exit_code": 0, "risk_blocked": False}
    """
    # 1. RiskEngine 前置检查（通过 JSON-RPC 调用前端 risk-engine）
    risk = await _check_risk_via_jsonrpc(command)
    if risk["level"] in ("deny", "high"):
        return {
            "stdout": "",
            "stderr": f"⚠️ 命令被 RiskEngine 拦截: {risk['reason']}",
            "exit_code": -1,
            "risk_blocked": True,
            "alternative": risk.get("alternative")
        }
    
    # 2. 调用 Rust SSH 模块执行命令
    result = await _ssh_run_via_jsonrpc(session_id, command)
    return {
        "stdout": result["stdout"],
        "stderr": result["stderr"],
        "exit_code": result["exit_code"],
        "risk_blocked": False
    }
```

#### 步骤 3：包装 StrandsAgent 类（1 天）

新增 `src-tauri/sidecar/strands_agents_base/agent_wrapper.py`：

```python
from strands import Agent
from typing import AsyncIterator

class StrandsAgentWrapper:
    """TDSF Strands Agent 包装，对接现有 JSON-RPC 协议"""
    
    def __init__(self, agent_type: str = "teach"):
        self.agent = self._build_agent(agent_type)
    
    def _build_agent(self, agent_type: str) -> Agent:
        builders = {
            "teach": self._build_teach,
            "debug": self._build_debug,
            "deploy": self._build_deploy,
            "explore": self._build_explore,
            # ... 8 子 agent
        }
        return builders[agent_type]()
    
    async def run_stream(self, prompt: str, context: dict) -> AsyncIterator[dict]:
        """流式运行 agent，返回 JSON-RPC 兼容的事件流
        
        context 含: cwd, recent_commands, ssh_session_id, etc.
        """
        # 注入终端上下文到 system prompt
        enriched_prompt = self._enrich_with_context(prompt, context)
        
        async for event in self.agent.stream_async(enriched_prompt):
            yield {
                "type": "agent_event",
                "data": event
            }
```

#### 步骤 4：main.py 注册新方法（1 天）

修改 `src-tauri/sidecar/main.py`，在现有 JSON-RPC 方法注册处新增：

```python
# 现有：register_method("ping", ping_handler)
# 现有：register_method("shutdown", shutdown_handler)
# 新增：
register_method("agent.run", agent_run_handler)
register_method("agent.list", agent_list_handler)
register_method("agent.cancel", agent_cancel_handler)

async def agent_run_handler(params: dict) -> dict:
    """运行 agent
    
    params: {
        "agent_type": "teach" | "debug" | "deploy" | ...,
        "prompt": "用户问题",
        "context": {
            "cwd": "/home/user",
            "recent_commands": ["ls -la", "cd /tmp"],
            "ssh_session_id": "xxx"
        },
        "stream": true
    }
    """
    agent = StrandsAgentWrapper(params["agent_type"])
    
    if params.get("stream"):
        # 流式：通过 notification 推送事件
        async for event in agent.run_stream(params["prompt"], params["context"]):
            send_notification("agent.event", event)
        return {"status": "completed"}
    else:
        result = await agent.run(params["prompt"], params["context"])
        return {"result": result}
```

#### 步骤 5：TdsfAgentPanel 适配流式响应（1-2 天）

修改 `src/modules/ai/components/TdsfAgentPanel.tsx`：

```typescript
// 新增：订阅 agent.event 通知
useEffect(() => {
  const unsubscribe = subscribeSidecarEvent("agent.event", (event) => {
    setMessages(prev => [...prev, parseAgentEvent(event)]);
  });
  return unsubscribe;
}, []);

// 新增：发送 agent.run 请求时附带终端上下文
const runAgent = async (prompt: string) => {
  const context = {
    cwd: getCurrentCwd(),  // 从 OSC 7 解析
    recent_commands: getRecentCommands(),  // 从 OSC 133 解析
    ssh_session_id: getActiveSshSessionId()
  };
  
  await invokeSidecar("agent.run", {
    agent_type: selectedAgent,
    prompt,
    context,
    stream: true
  });
};
```

### 8.3 与现有 TdsfAgentPanel 的对接点

| 对接点 | 现有位置 | Strands 适配 |
|--------|---------|-------------|
| Agent 注册 | `src/modules/ai/agents/registry.ts` | 新增 strands-* agent 类型 |
| 工具定义 | `src/modules/ai/tools/` | 通过 MCP 暴露给 Strands（统一） |
| 流式渲染 | `src/modules/ai/lib/composer.tsx` | 适配 `agent.event` 通知 |
| Agent 面板 | `src/modules/ai/components/TdsfAgentPanel.tsx` | 注入终端上下文（cwd/最近命令） |
| 终端上下文 | OSC 133/7 shell integration | 已暴露，agent.run 调用时附带 |
| RiskEngine | `src/lib/risk-engine/rules.ts` | 通过 JSON-RPC 桥给 sidecar 工具 |

### 8.4 测试用例建议

#### 单元测试（sidecar 端）
```python
# test_strands_agent.py
async def test_teach_agent_explains_command():
    agent = StrandsAgentWrapper("teach")
    result = await agent.run("解释 ls -la", context={"cwd": "/tmp"})
    assert "ls" in result["explanation"]
    assert result["risk_level"] == "safe"

async def test_risk_engine_blocks_dangerous_command():
    agent = StrandsAgentWrapper("teach")
    result = await agent.run("执行 rm -rf /", context={"cwd": "/"})
    assert result["risk_blocked"] is True
    assert "alternative" in result

async def test_ssh_tool_executes_on_remote():
    agent = StrandsAgentWrapper("teach")
    result = await agent.run("查看远程 nginx 状态", 
                              context={"ssh_session_id": "test-session"})
    assert "active" in result["stdout"] or "inactive" in result["stdout"]
```

#### 集成测试（前端 + sidecar）
```typescript
// TdsfAgentPanel.test.tsx
test('agent receives terminal context', async () => {
  // 模拟 OSC 7 设置 cwd
  window.__TDSF_DBG__?.setCwd('/home/user');
  
  // 触发 agent
  await runAgent('解释当前目录');
  
  // 验证 sidecar 收到的 context 含 cwd
  expect(lastSidecarCall.params.context.cwd).toBe('/home/user');
});

test('high-risk command triggers user confirmation', async () => {
  const consoleSpy = jest.spyOn(console, 'warn');
  await runAgent('执行 rm -rf /');
  expect(consoleSpy).toHaveBeenCalledWith(
    expect.stringContaining('高危命令被拦截')
  );
});
```

#### 五绿门禁
- `pnpm typecheck`：0 错误（新增 TypeScript 类型）
- `pnpm lint`：0 警告
- `pnpm test`：830+ 测试全过 + 新增 strands agent 测试
- `pnpm build:web`：成功
- `pnpm tauri:dev`：实测 agent 能解释命令、RiskEngine 拦截高危命令、终端上下文正确传递

---

## 九、已有调研复用

### 9.1 已有报告覆盖（不重复）

[`ops-agent-opensource-research.md`](./ops-agent-opensource-research.md) 已充分分析：

| 项目 | 已有报告章节 | 本次是否重复 |
|------|------------|------------|
| Aider | 4.1 | 否（本次不涉及） |
| OpenHands (agent-canvas) | 4.2 | 否（本次不涉及） |
| LangGraph | 4.3 | 补充（4.6 节，仅说明 TDSF 现状问题） |
| Continue.dev | 4.4 | 否（已停止维护，本次不涉及） |
| Shellfirm | 4.5 | 否（命令拦截器，本次仅在 RiskEngine 协同时提及） |
| destructive_command_guard | 4.6 | 否（命令拦截器，同上） |

### 9.2 本次深化补充

| 方向 | 已有报告 | 本次新增 |
|------|---------|---------|
| 轻量级框架 | 仅 LangGraph | Strands、Pydantic AI、Swarm、Agents SDK、smolagents、Atomic Agents |
| 运维专项 | 无 | HolmesGPT、K8sGPT、Aurora |
| 终端集成型 | 无 | Microsoft Intelligent Terminal、Warp、JetBrains、Gemini CLI |
| 命令拦截器 | Shellfirm、dcg 充分分析 | 不重复，仅在 RiskEngine 协同时引用 |

### 9.3 与已有报告的协同

已有报告的 P0 方案（规则 YAML 外置 + 安全替代建议）与本次 P0 方案（Strands Agents 集成）**互补不冲突**：
- 已有报告 P0：升级 RiskEngine 本身（YAML 规则、安全替代）
- 本次 P0：升级 agent 框架（Strands 替换 LangGraph）
- 协同点：Strands 工具调用 RiskEngine，RiskEngine 升级后 agent 自动受益

建议合并执行：先完成已有报告 P0（规则升级，3-5 天），再执行本次 P0（Strands 集成，5-7 天）。

---

## 十、关键发现

### 发现 1：TDSF sidecar 当前依赖与"避免重框架"约束冲突

TDSF sidecar [`requirements.txt`](../../src-tauri/sidecar/requirements.txt) 当前依赖 5 个 langchain 包 + chromadb，与用户"避免 LangChain 全家桶太重"约束直接冲突。Strands Agents（`pip install strands-agents strands-agents-tools`）或 Pydantic AI（`pip install pydantic-ai-slim`）都比 LangGraph 轻 5-10 倍。

**且 sidecar 当前崩溃**（[dev-state.md](../dev-state.md) P2-5），正是评估替换方案的好时机——如果 sidecar 还没跑起来，现在换框架成本最低。

### 发现 2：Strands Agents 与 TDSF 约束契合度最高

Strands Agents 在以下维度与 TDSF 约束完美契合：
- **轻量**：Apache 2.0、`pip install` 即用
- **教学友好**：几行代码定义 agent，学生易理解
- **Python sidecar**：原生 Python
- **模型无关**：教学场景可用本地 Ollama 离线
- **内置运维工具**：strands_tools 已有 shell/file
- **MCP 原生**：暴露 RiskEngine 为 MCP 工具
- **AWS 生产验证**：工业级可靠性

### 发现 3：Pydantic AI 的 Deferred Tools 是 RiskEngine 协同的最佳机制

Pydantic AI 的 **deferred tools with conditional approval gating** 机制——工具声明为 deferred，调用时暂停等用户批准——与 TDSF RiskEngine 的"L3+ 命令前端拦截 → 用户确认"逻辑是同一思路。若选 Pydantic AI，可天然对接，无需自写权限检查层。

OpenAI Agents SDK 的 Guardrails（input/output/tool 三层验证 + tripwire）是等效机制，可作为 Strands 的备选。

### 发现 4：微软 Intelligent Terminal 是 TDSF 的直接对标产品

微软 2026-06 发布的 Intelligent Terminal（基于 Windows Terminal fork）与 TDSF 的产品形态高度重合：终端 + AI agent 集成。其 **agent pane + 上下文感知 + 错误自动检测** 三大模式值得 TDSF 借鉴。TDSF 的差异化在于：
- **Linux 运维教学**定位（Intelligent Terminal 是通用开发者工具）
- **SSH 远程**场景（Intelligent Terminal 是本地 Windows）
- **中文**界面（Intelligent Terminal 是英文）

### 发现 5：HolmesGPT 的 Toolset 架构是运维 agent 最佳实践

HolmesGPT 的 50+ toolset 按类别组织（容器/云/数据库/可观测性/CI-CD/消息队列等）的架构，比 TDSF 现有的 8 子 agent（按职能分）更细粒度、更可组合。建议 TDSF 参考：
- 保留 8 子 agent（按职能：teach/debug/deploy/...）
- 新增 toolset 层（按资源类型：systemd/network/file/process/journal/...）
- agent 通过组合 toolset 实现职能

### 发现 6：教学型 Linux 运维 agent 无成熟开源项目

调研发现，"Linux 命令教学 AI"领域多为：
- 商业 GPT（如 Linux Shell Tuteur、Linux command dic）
- 在线平台（如 LabEx、Teachguin）
- 平台内嵌 agent（如 Trae Linux 命令助手）

**无成熟开源项目**。TDSF 作为"开源 + 桌面 + SSH + 教学型"的 Linux 运维 agent，有显著差异化机会。

### 发现 7：MCP 已成为 agent 工具调用的事实标准

本次调研的所有主流框架（Strands、Pydantic AI、OpenAI Agents SDK、smolagents、HolmesGPT、K8sGPT、Gemini CLI）均原生支持 MCP。已有报告 6.3 节方案 H（暴露 RiskEngine 为 MCP 工具）是正确方向，应优先实施——这样所有 MCP 兼容框架都能直接调用 TDSF RiskEngine。

---

## 十一、附录

### 11.1 调研项目链接清单

#### 轻量级框架
- [Strands Agents 官方文档](https://strandsagents.com/)
- [Strands Agents Python SDK](https://github.com/strands-agents/sdk-python)
- [Strands Agents TypeScript SDK](https://github.com/strands-agents/sdk-typescript)
- [Strands Agents Tools](https://github.com/strands-agents/tools)
- [Strands Agents Samples](https://github.com/strands-agents/samples)
- [AWS Compute Blog: Building AI agents on AWS Serverless](https://aws.amazon.com/blogs/compute/effectively-building-ai-agents-on-aws-serverless/)
- [Pydantic AI 官方文档](https://ai.pydantic.dev/)
- [Pydantic AI GitHub](https://github.com/pydantic/pydantic-ai)
- [Pydantic AI 调研](https://rywalker.com/research/pydantic-ai)
- [Martin Fowler: Building your own CLI Coding Agent with Pydantic-AI](https://martinfowler.com/articles/build-own-coding-agent.html)
- [OpenAI Swarm GitHub](https://github.com/openai/swarm)（已废弃）
- [OpenAI Agents SDK 文档](https://openai.github.io/openai-agents-python/)
- [OpenAI Agents SDK GitHub](https://github.com/openai/openai-agents-python)
- [OpenAI Agents SDK vs Swarm 迁移指南](https://www.respan.ai/articles/openai-agents-sdk-vs-swarm)
- [OpenAI Agents SDK 综述](https://aiwiki.ai/wiki/openai_agents_sdk/raw)
- [smolagents 官方文档](https://smolagents.org/)
- [smolagents GitHub](https://github.com/huggingface/smolagents)
- [Atomic Agents GitHub](https://github.com/BrainBlend-AI/atomic-agents)

#### 运维专项
- [HolmesGPT PyPI](https://pypi.org/project/holmesgpt/)
- [HolmesGPT 文档](https://docs.robusta.dev/master/holmesgpt.html)
- [K8sGPT 官网](https://k8sgpt.ai/)
- [K8sGPT GitHub](https://github.com/k8sgpt-ai/k8sgpt)
- [Aurora GitHub](https://github.com/Arvo-AI/aurora)
- [Datadog Bits AI SRE](https://www.datadoghq.com/blog/bits-ai-sre/)
- [Observe AI SRE](https://dailyaibrief.com/news/observe-launches-ai-sre-o11yai-agents-BEj5IvfY)

#### 终端集成型
- [Microsoft Intelligent Terminal 发布博客](https://devblogs.microsoft.com/commandline/announcing-intelligent-terminal-version-0-1/)
- [Intelligent Terminal Microsoft Store](https://apps.microsoft.com/store/detail/microsoft-intelligentterminal)
- [Warp 官网](https://www.warp.dev/)
- [Warp Windows 发布](https://www.warp.dev/blog/launching-warp-on-windows)
- [JetBrains AI Assistant 终端命令生成](https://www.jetbrains.com/help/ai-assistant/generate-terminal-commands.html)
- [Gemini CLI](https://geminicli.online/)

### 11.2 TDSF 现有架构关键文件

| 文件 | 说明 |
|------|------|
| [`src-tauri/sidecar/requirements.txt`](../../src-tauri/sidecar/requirements.txt) | 当前依赖（langchain 全家桶，待替换） |
| [`src-tauri/sidecar/main.py`](../../src-tauri/sidecar/main.py) | JSON-RPC 入口（注册 ping/shutdown/status） |
| `src-tauri/sidecar/agents/*.py` | 8 子 agent（coding/debug/deploy/explore/history/refactor/teach/test） |
| `src-tauri/sidecar/graph/graph.py` | LangGraph PAOR 7 节点图 |
| `src-tauri/sidecar/byoa/adapters/` | BYOA 适配器（aider/claude/codex/continue/cursor） |
| `src-tauri/sidecar/skills/builtin/` | 内置技能（docker-management/linux-ops/python-debug/selinux-baseline/ssh-troubleshoot） |
| `src/modules/ai/components/TdsfAgentPanel.tsx` | 前端 Agent 面板 |
| `src/modules/ai/agents/registry.ts` | Agent 注册 |
| `src/modules/ai/tools/` | 前端工具定义 |
| `src/modules/ai/lib/composer.tsx` | AiComposerProvider |
| `src/lib/risk-engine/rules.ts` | RiskEngine 规则（16 条 TS 正则） |

### 11.3 验证总结

| 验证项 | 结果 |
|--------|------|
| 调研的候选项目数 | 12 个（6 轻量级 + 3 运维专项 + 3 终端集成型） |
| 实际抓取官方文档/README 验证 | Strands、Pydantic AI、OpenAI Agents SDK、HolmesGPT、Intelligent Terminal 均抓官方源 |
| 报告文件路径 | `d:\ai\linux教学一体\tdsf-terminal-agent-clone\docs\reports\ops-agent-deep-research.md` |
| Top 3 推荐 | Strands Agents（首选）/ Pydantic AI（次选）/ smolagents（第三） |
| 关键发现 1 | TDSF sidecar 当前 langchain 全家桶与"避免重框架"约束冲突 |
| 关键发现 2 | Strands Agents 与 TDSF 约束契合度最高（轻量/教学/Python/模型无关/MCP） |
| 关键发现 3 | Pydantic AI deferred tools 是 RiskEngine 协同的最佳机制 |
| 关键发现 4 | 微软 Intelligent Terminal 是 TDSF 直接对标产品 |
| 关键发现 5 | HolmesGPT toolset 架构是运维 agent 最佳实践 |
| 关键发现 6 | 教学型 Linux 运维 agent 无成熟开源项目，TDSF 有差异化机会 |
| 关键发现 7 | MCP 已成为 agent 工具调用事实标准 |

---

## 十二、一句话推荐 + P0 集成步骤

### 一句话推荐

**用 Strands Agents 替换 LangGraph 作为 sidecar 主框架**——它是本次调研中与 TDSF"轻量 + 教学 + Python + 模型无关 + MCP 原生"约束契合度最高的框架，AWS 生产验证，Apache 2.0，几行代码定义 agent。

### P0 集成步骤（5-7 天）

1. **第 1 天**：修改 `src-tauri/sidecar/requirements.txt`，新增 `strands-agents`、`strands-agents-tools`、`litellm`（暂不删 langchain，并存验证）
2. **第 2-3 天**：新增 `src-tauri/sidecar/strands_agents_base/`：
   - `tools/ssh.py`：SSH 命令执行工具（含 RiskEngine 前置检查）
   - `tools/sftp.py`：SFTP 文件读写工具
   - `tools/risk.py`：RiskEngine MCP 工具（check_risk / suggest_alternative / explain_risk）
   - `tools/teach.py`：教学专用工具（命令解释、知识点扩展）
3. **第 4 天**：新增 `strands_agents_base/agent_wrapper.py`：包装 `StrandsAgent` 类，对接现有 JSON-RPC 协议，注入终端上下文（cwd/最近命令）
4. **第 5 天**：修改 `src-tauri/sidecar/main.py`：注册 `agent.run` / `agent.list` / `agent.cancel` JSON-RPC 方法
5. **第 6-7 天**：修改 `src/modules/ai/components/TdsfAgentPanel.tsx` + `lib/composer.tsx`：适配 `agent.event` 流式通知，发送 agent.run 时附带终端上下文（OSC 133/7 解析的 cwd/最近命令）

**验证**：五绿门禁全过 + `pnpm tauri:dev` 实测——agent 能解释命令、RiskEngine 拦截高危命令、终端上下文正确传递、本地 Ollama 模型可用。

---

> **最后更新**：2026-07-30
> **调研人**：TDSF Terminal Agent 子 agent
> **上游基线**：[crynta/terax-ai v0.8.6](https://github.com/crynta/terax-ai)
> **关联报告**：[`ops-agent-opensource-research.md`](./ops-agent-opensource-research.md)（命令拦截器与 Aider/LangGraph 等分析）
