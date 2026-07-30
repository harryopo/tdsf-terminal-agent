# TDSF Terminal Agent — 2026 年 7 月运维 Agent 开源生态调研（v2 补充版）

> **位置**：`docs/reports/ops-agent-opensource-survey-2026-07-v2.md`
> **版本**：v2.0（2026-07-30 补充调研，覆盖 v1.0 的 2026-07 上半月数据）
> **作用**：在 v1.0 调研（11 个项目，Strands 首选 + PydanticAI 备选）基础上，补充 2026-07 下半月最新进展，重点核查 Strands/OpenAI Agents SDK/Claude Agent SDK/PydanticAI 的最新版本与 MCP 支持细节、运维 agent 专用框架、MCP 运维场景应用、Tauri 桌面端集成最佳实践，给出基于最新数据的推荐结论。
> **任务边界**：本文件仅为调研报告，不修改任何 `src/` 或 `src-tauri/` 下的源码文件。
> **数据基准**：2026-07-30 的 WebSearch + WebFetch + PyPI + GitHub 真实抓取。Stars/下载量为各来源披露的近似值。
> **上游参考**：[crynta/terax-ai](https://github.com/crynta/terax-ai) v0.8.6（TDSF 唯一基线）
> **配套文档**：
> - `docs/reports/ops-agent-opensource-survey-2026-07.md`（v1.0，11 项目深度评估）
> - `docs/reports/ops-agent-strands-integration-plan.md`（v2.0 深化版集成方案）

---

## 1. 调研摘要

1. **推荐方案维持不变**：Strands Agents 1.48.0 仍是首选，PydanticAI v2.13.0 仍是备选。2026-07 下半月未出现颠覆 v1.0 判断的新框架，但 Strands 的生产验证（Leidos ManagedX 政府级文档处理 2026-04-29、AWS Computer Vision MCP 2026-07-15、Kong AI/MCP Gateway 2026-01-13）和 re:Invent 2025 新增能力（TypeScript SDK + BidiAgent 双向流式 + Steering 边界引导 + 评估）显著强化了其作为首选的支撑。
2. **新增三个高价值发现**：(a) **MCP 规范 2026-07-28 重大版本**（无状态核心 + Tasks 扩展 + MCP Apps 扩展，影响所有 MCP 用户）；(b) **OpenWorker（Andrew Ng, 2026-07-25）与 TDSF 同栈**（Tauri 2 + React 18 + Python 3.10+ FastAPI sidecar + typed risk engine 4 级分类 + prompt-injection posture），是最重要的架构对标参考；(c) **TencentOS MCP Server / ssh-mcp-server** 等运维 MCP server 已成熟，22 工具覆盖 10 大运维场景的范式直接可借鉴。
3. **OpenSRE / OpsAgent / Lerwee Agentic Ops** 三个新出现的运维专用 agent 框架（Public Alpha / 学术+Lenovo 生产 / 国内 CoT 模板），均不作为 TDSF 集成对象（独立产品或未成熟），但其运维工具集设计范式（多信号上下文整合 + 智能终止逻辑 + 风险分级）值得借鉴。
4. **MCP 在运维场景的应用已成熟**：腾讯云、classfang、weidwonder 等多个开源 MCP server 已实现 SSH 命令执行 + SFTP 文件传输 + 命令白名单/黑名单 + 持久会话，与 TDSF 的 SSH/SFTP 运维教学定位高度对齐。**建议 TDSF 在 P2 阶段评估引入 MCP 协议**作为 sidecar JSON-RPC 的标准化补充（非替换）。
5. **集成路径不变**：维持 v1.0 的 `strands_backend/` + `pydanticai_backend/` 三后端 Feature Flag（`strands|pydanticai|langgraph`），2.5 人日落地。新增建议：参考 OpenWorker 的 typed risk engine 4 级分类强化 `tools/risk.py`，参考 TencentOS MCP Server 的 22 工具分类法扩展运维工具集。

---

## 2. 各项目最新进展（2026-07 下半月）

### 2.1 AWS Strands Agents（首选，确认）

| 维度 | 数据 |
|------|------|
| GitHub | https://github.com/strands-agents/sdk-python |
| PyPI 最新 | **1.48.0**（2026-07-17 发布，v1.0 后第 48 个版本） |
| Stars / Forks | 6,704 / 993（PyPI 披露） |
| License | Apache 2.0 |
| Python | >=3.10（含 3.14） |
| 发版频率 | 几乎每周（2025-08-26 1.6.0 → 2026-07-17 1.48.0） |
| 生产验证 | Amazon Q Developer / Amazon Glue / VPC Reachability Analyzer / **Leidos ManagedX 政府级文档处理（2026-04-29）** |
| PyPI extras | a2a / all / anthropic / **bidi / bidi-all / bidi-gemini / bidi-io / bidi-openai** / cedar / gemini / litellm / llamaapi / mistral / ollama / openai / otel / sagemaker / writer |

**re:Invent 2025 新增能力**（2025-12 重要里程碑）：
1. **TypeScript SDK**：与 Python SDK 平行发布，跨语言支持
2. **Bidirectional Streaming（BidiAgent）**：双向流式，专为语音 agent 设计，配合 Nova 2 Sonic 实时语音对话
3. **Steering**：边界引导，约束 agent 在规定范围内行动
4. **Evaluations**：系统化 agent 评估

**2026-07 下半月新进展**：
- **2026-07-15 AWS 博客**：Computer Vision MCP Server + Strands + Bedrock 视觉智能 agent（Agentic Vision）
- **2026-01-13 Kong 博客**：Strands + Kong AI/MCP Gateway + Bedrock 生产级 AI Agent（MCP Gateway 保护 MCP server 消费，OAuth 2.1 + 可观测性）
- **2026-04-29 Leidos 博客**：Strands workflow pattern（确定性顺序 + 显式依赖管理）+ MCP server 简化 AWS 服务连接，政府级生产（医疗/法律/财务文档处理）
- **MLflow 3.4+** 原生支持 Strands 追踪（`mlflow.strands.autolog()`，捕获 prompt/response/latency/token/cost）
- **Bedrock AgentCore** 9 服务集成：运行时/内存/网关/浏览器/代码解释器/身份/可观测性/评估/策略

**核心范式**（确认与 TDSF 兼容）：
```python
from strands import Agent, tool
from strands.tools.mcp import MCPClient
from mcp import stdio_client, StdioServerParameters

@tool
def ssh_command(command: str, explanation: str = "") -> dict:
    """Propose an SSH command for approval."""
    # 与 TDSF tools/*.py 的 invoke_*_tool(params) 范式对齐
    ...

# MCPClient 原生支持（stdio + Streamable HTTP）
mcp_client = MCPClient(lambda: stdio_client(
    StdioServerParameters(command="uvx", args=["awslabs.aws-documentation-mcp-server@latest"])
))
with mcp_client:
    agent = Agent(tools=mcp_client.list_tools_sync())
    response = agent("...")

# BidiAgent（实验性，语音 agent，TDSF 不用但可参考）
from strands.experimental.bidi import BidiAgent
from strands.experimental.bidi.models import BidiNovaSonicModel
```

**与 TDSF 集成适配度评估：5/5 分**
- ✅ Python SDK，与 sidecar 无缝对接
- ✅ `@tool` 装饰器与 `tools/*.py` 的 `invoke_*_tool(params)` 范式对齐
- ✅ MCPClient 原生支持（stdio + Streamable HTTP），可暴露现有 9 个 MCP tools
- ✅ `stream_async` + BidiAgent 双向流式
- ✅ Apache 2.0 与上游 terax-ai 兼容
- ✅ 13+ 模型提供商（含 Ollama 本地、LiteLLM 适配国内 DeepSeek/Qwen）
- ✅ Agents-as-Tools / Handoffs / Swarm / Graph 多 Agent 模式替代 MainAgent 关键词路由
- ⚠️ 依赖 `litellm`（LiteLLMModel 必需），可能与现有 pydantic/chromadb 冲突（需虚拟环境隔离测试）

---

### 2.2 OpenAI Agents SDK Python（备选参考）

| 维度 | 数据 |
|------|------|
| GitHub | https://github.com/openai/openai-agents-python |
| 最新版本 | **v0.17.7**（2026-06-24，SourceForge mirror） |
| Stars | 27,900+ |
| 最新 commit | 2026-07-04（seratch，"chore: update runtime-behavior-probe skill"） |
| License | MIT（开源核心） |

**MCP 支持（4 种传输，v1.0 调研未详细展开）**：
```python
from agents import Agent, HostedMCPTool, MCPServerStdio, MCPServerSse, MCPServerStreamableHttp

# 1. Hosted MCP（OpenAI Responses API 托管，无需本地进程）
agent = Agent(
    name="Assistant",
    tools=[HostedMCPTool(tool_config={
        "type": "mcp",
        "server_label": "deepwiki",
        "server_url": "https://mcp.deepwiki.com/mcp",
        "require_approval": "never",
    })],
)

# 2. Streamable HTTP MCP server
# 3. HTTP with SSE MCP server
# 4. stdio MCP server

# Agent-level MCP 配置
agent = Agent(
    name="Assistant",
    mcp_servers=[server],
    mcp_config={
        "convert_schemas_to_strict": True,  # 转 strict JSON schema
        "failure_error_function": None,     # MCP 工具失败处理
        "include_server_in_tool_names": True,  # 工具名加 server 前缀避免冲突
    },
)
```

**与 TDSF 集成适配度评估：3/5 分**
- ✅ Python SDK，轻量级
- ✅ 4 种 MCP 传输（含 HostedMCPTool 托管模式，减少本地进程管理）
- ⚠️ 偏向 OpenAI 模型优化，国内 OpenAI 兼容端点（DeepSeek/OneAPI）需测试
- ⚠️ v0.17.x 仍是 0.x 版本，API 可能变动
- ⚠️ Sessions 默认 OpenAI 服务端管理

---

### 2.3 Anthropic Claude Agent SDK Python（架构参考）

| 维度 | 数据 |
|------|------|
| GitHub | https://github.com/anthropics/claude-agent-sdk-python |
| PyPI 最新 | **claude-agent-sdk 0.2.128**（2026-07-25 发布） |
| TS 最新 | @anthropic-ai/claude-agent-sdk v0.3.156（2026-07-30 前 10 小时） |
| License | MIT（SDK 代码） + Anthropic Commercial Terms（CLI 二进制） |
| Python | >=3.10 |
| 改名时间 | 2025-09-29（从 Claude Code SDK → Claude Agent SDK） |
| 计费变化 | 2026-06-15 起 Agent SDK + Claude Code GitHub Actions 独立计费 |
| 搜索热度 | 50/月（2025-05）→ 14,800/月（2026-04），增长 50,000% |

**新发现：in-process SDK MCP Server**（无需子进程）：
```python
from claude_agent_sdk import tool, create_sdk_mcp_server, ClaudeAgentOptions, ClaudeSDKClient

@tool("greet", "Greet a user", {"name": str})
async def greet_user(args):
    return {"content": [{"type": "text", "text": f"Hello, {args['name']}!"}]}

# 在进程内创建 MCP server，无需单独子进程
server = create_sdk_mcp_server(name="my-tools", version="1.0.0", tools=[greet_user])

options = ClaudeAgentOptions(
    mcp_servers={"tools": server},
    allowed_tools=["mcp__tools__greet"],
)
async with ClaudeSDKClient(options=options) as client:
    await client.query("Greet Alice")
```

**内置工具集**：Read / Write / Edit / Bash / Grep / Glob / WebSearch / WebFetch / **Monitor**（监听后台脚本输出）/ **AskUserQuestion**

**4 推理后端**：Anthropic API / AWS Bedrock / Google Vertex AI / Microsoft Azure Foundry

**Apple 集成**：2026-02-03 Xcode 26.3 原生集成 Claude Agent SDK（hooks + subagents）

**与 TDSF 集成适配度评估：2/5 分**
- ❌ 计费绑定 Anthropic（2026-06-15 独立计费），国内用户成本可控性差
- ❌ Python 包捆绑 Claude Code CLI 二进制，部署体积大
- ❌ 内置工具集（Read/Write/Edit/Bash/Grep/Glob）是 Claude Code 范式，与 TDSF 的 SSH/SFTP 运维工具集不对齐
- ✅ in-process SDK MCP Server 设计思想可借鉴（减少子进程开销）
- ✅ Apple Xcode 集成证明 hooks + subagents 是生产级 agent harness 设计参考
- **定位**：架构参考，不作为集成对象

---

### 2.4 PydanticAI（轻量级备选，确认）

| 维度 | 数据 |
|------|------|
| GitHub | https://github.com/pydantic/pydantic-ai |
| PyPI 最新 | **v2.13.0**（2026-07-18） |
| Stars | 17,600+（2026-06） |
| 月下载 | 33M+（pydantic-ai-slim，2026-06） |
| License | MIT |
| Python | >=3.10 |
| 团队 | Pydantic 团队原厂（Samuel Colvin / David Montague / Douwe Maan） |
| 融资 | $17.2M（$4.7M seed + $12.5M Series A led by Sequoia，2024-10） |
| v2 beta | v2.0.0b7（2026-06-10） |

**核心能力（v1.0 调研基础上的补充）**：
- **MCP/A2A/UI 三位一体**：原生 MCPToolset + A2A 协议 + UI 事件流
- **Durable Execution**：Temporal / DBOS / Prefect / Restate 集成
- **Pydantic Graph**：图结构控制流（v1.97.0 stable），适用于复杂多步工作流
- **Human-in-the-loop**：工具审批系统（基于参数/历史/偏好条件审批），与 needs_you 语义一致
- **流式结构化输出**：实时 Pydantic 验证
- **Pydantic Evals**：系统化测试
- **版本政策**：v1 不做 breaking changes，v2 发布后 v1 安全修复 6+ 个月

**与 TDSF 集成适配度评估：4/5 分**
- ✅ Python 原生，MIT，类型安全（`Agent[DepsType, OutputType]`）
- ✅ 依赖注入（`RunContext[Deps]`）与 TDSF 的 `event_bus` / `llm_call` 注入范式对齐
- ✅ 原生 MCPToolset 双向（客户端 + 服务端）
- ✅ Human-in-the-loop 工具审批与 needs_you 语义一致
- ✅ Pydantic 团队原厂，与现有 pydantic 依赖同源无冲突
- ✅ 比 Strands 更轻（核心包 `pydantic-ai-slim`，按需 extras）
- ⚠️ 生产验证不如 Strands（主要 Pydantic Logfire 内部）
- ⚠️ `@agent.tool` 绑定具体 agent 实例，与 TDSF 全局 `TOOL_REGISTRY` 范式略有差异

---

### 2.5 新发现：OpenWorker（Andrew Ng, 2026-07-25）⭐⭐⭐ 架构对标

| 维度 | 数据 |
|------|------|
| GitHub | https://github.com/andrewyng/openworker |
| 发布日期 | 2026-07-25 |
| License | MIT |
| 最新 commit | 2026-07-25（rohitprasad15，"Add Meta Model API provider with Muse Spark 1.1"） |
| Commits / Issues / PRs | 59 / 91 / 123 |
| 技术栈 | **Tauri 2（Rust 壳）+ React 18 前端 + Python 3.10+ FastAPI sidecar**（**与 TDSF 完全同栈**！） |
| 引擎 | aisuite（provider-agnostic LLM 库） |
| 默认端口 | 127.0.0.1:8765（FastAPI + Uvicorn） |
| 模型支持 | 30 个 tool-calling 模型（OpenAI GPT-5.6/5.5、Anthropic Claude Fable 5/Opus 4.8、Google Gemini 3.1 Pro/3.6 Flash、Ollama 本地） |
| 集成 | 25+ 托管（GitHub/Slack/Jira/Notion/Google Calendar）+ MCP 支持 |
| 平台 | macOS Apple Silicon（Windows 开发中） |
| 状态 | Open Beta |

**核心架构（与 TDSF 高度对标）**：
- **Desktop Shell**：Tauri 2 原生窗口 + React 18 UI，监督底层 Python server 进程
- **Local Agent Server**：Python 3.10+ FastAPI + Uvicorn，绑定 127.0.0.1:8765
- **Capability and Connector Layer**：本地工具（filesystem/git/ripgrep 搜索/shell）+ 25+ 托管集成 + MCP
- **Model Router**：统一接口，支持 native providers / OpenAI-compatible vendors / local runtimes

**typed risk engine（4 级风险分类，直接可借鉴 TDSF `tools/risk.py`）**：
| 风险级 | 含义 |
|------|------|
| Read | 查看本地数据，无副作用 |
| Write_local | 修改工作区内文件 |
| Exec | 运行 shell 命令 |
| External | 跨机器副作用（发邮件/Slack 等） |

**5 个权限模式**：discuss / plan / interactive（默认）/ auto / custom

**"prompt-injection posture"（关键安全设计）**：内置 ops persona 将所有工具输出和外部数据视为**不受信任输入**而非指令（防 prompt injection）

**与 TDSF 关系**：
- ✅ **同栈同形态**：Tauri 2 + React + Python sidecar + FastAPI（TDSF 用 stdio JSON-RPC，OpenWorker 用 HTTP，可对比）
- ✅ typed risk engine 4 级分类强化 TDSF `tools/risk.py`
- ✅ "prompt-injection posture" 是 TDSF 运维 agent 安全设计的关键补充
- ✅ 5 权限模式与 TDSF 的 needs_you 审批层语义对齐
- ❌ OpenWorker 用 aisuite（轻量），TDSF 已选 Strands（更重但功能强）
- **定位**：**最重要的架构对标参考**（同栈 + 同形态 + 同安全诉求），不作为集成对象但其 typed risk engine + prompt-injection posture 设计直接可借鉴

---

### 2.6 新发现：运维 agent 专用框架（OpenSRE / OpsAgent / Lerwee）

#### 2.6.1 OpenSRE（Tracer-Cloud/opensre）

| 维度 | 数据 |
|------|------|
| GitHub | https://github.com/Tracer-Cloud/opensre |
| 状态 | **Public Alpha** |
| 首推时间 | 2026-05-12（aitoolnet） |
| License | 开源 |
| 部署 | 自托管（Railway / LangGraph）+ Postgres + Redis |
| 工具集成 | 60+（Slack/Grafana/Datadog/Prometheus/K8s/AWS EC2/CloudWatch/Lambda/ECS Fargate/MongoDB/Redis/Kafka/PostgreSQL/GitLab/Jira） |
| 协议 | **MCP + ACP**（Agent Communication Protocol） |
| LLM | Anthropic/OpenAI/Gemini/Ollama/OpenRouter/NVIDIA NIM |
| 月访问 | 12.5K（2026-06） |

**核心能力**：
- **Agentic Investigation Loop**：多步循环，规划查询 → 执行 → 综合证据 → 演进假设 → 结构化报告
- **Multi-Signal Context Assembly**：告警标准化 + 服务拓扑 + 近期部署 + 基准指标 → 统一调查状态
- **Open Reinforcement Learning Environment**：合成 RCA 测试 + 真实 E2E 场景（K8s/AWS EC2/Lambda）
- **Intelligent Termination Logic**：假设置信度评估，边际价值趋于平稳时停止循环（避免 token 浪费）
- **Infrastructure-Native Deployment**：自托管，敏感数据不进第三方黑箱

**与 TDSF 关系**：不作为集成对象（Public Alpha + 面向云原生 SRE），但其"多信号上下文整合 + 智能终止逻辑 + 端到端测试 + 合成事故模拟"是 TDSF 运维 agent 设计参考。

#### 2.6.2 OpsAgent（arXiv:2510.24145, Lenovo 生产）

| 维度 | 数据 |
|------|------|
| 论文 | arXiv:2510.24145v3（2025-10-28 v1，2026-05-12 v3） |
| 作者 | Yu Luo 等（Lenovo + 北京邮电大学） |
| 生产部署 | **Lenovo 生产环境** |
| 基准 | OPENRCA benchmark |

**核心能力**：
- 轻量级、自演化多 agent 系统
- training-free data processor（异构可观测性数据 → 结构化文本）
- 多 agent 协作框架（诊断推理透明可审计）
- **双自演化机制**：内部模型更新 + 外部经验积累
- SOTA 性能 + 可泛化 + 可解释 + 成本高效

**与 TDSF 关系**：学术参考，不作为集成对象。其"双自演化机制"是 TDSF self_evolution 模块的学术验证。

#### 2.6.3 Lerwee Agentic Ops（乐维社区, 2026-07-23）

| 维度 | 数据 |
|------|------|
| 发布 | 2026-07-23（51cto 博客） |
| 模板数 | 30+ CoT 运维模板开源 |
| 覆盖率 | 90% 高频运维场景 |
| 数据打通 | CMDB / 监控 / 日志 / 告警全域 |
| 模型 | 通义千问 / DeepSeek 等主流大模型 |
| 合规 | 等保 / 信创（数据本地 + 端云密文协同） |

**核心能力**：
- CoT 思维链 + 数据占位符自动拉取（CMDB 资产/监控指标/告警/日志）
- 模板沉淀 + 可视化编辑（左右分栏，边写边预览真实数据）
- 场景：低频业务分析 / MySQL 锁等待诊断 / 集群负载巡检 / 操作系统巡检 / 僵尸机分析 / 存储健康检测
- CoT 场景广场（模板打包上传/下载共享）

**与 TDSF 关系**：国内运维场景特化参考。其"CoT 模板沉淀 + 全域数据打通"是 TDSF teach_agent + explore_agent 的运维教学场景参考，但不作为集成对象（独立产品）。

---

## 3. 七维度对比矩阵（更新版）

### 3.1 核心维度对比（含 2026-07 下半月新发现）

| 项目 | Stars | 最新版本 | MCP 支持 | 流式工具调用 | Python sidecar 适配 | 运维场景工具数 | Tauri 集成难度 |
|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Strands Agents** | 6,704 | 1.48.0（2026-07-17） | ✅ MCPClient（stdio + Streamable HTTP） | ✅ stream_async + **BidiAgent 双向流式** | ✅ 原生 Python SDK | 通用框架，需自建 | 低（sidecar 直接 import） |
| **PydanticAI** | 17,600 | v2.13.0（2026-07-18） | ✅ MCPToolset 双向（客户端+服务端） | ✅ 流式结构化输出 | ✅ Python 原生 | 通用框架，需自建 | 低 |
| **OpenAI Agents SDK** | 27,900 | v0.17.7（2026-06-24） | ✅ 4 种传输（Hosted/Streamable HTTP/SSE/stdio） | ✅ token + 中间步骤 | ✅ Python SDK | 通用框架 | 低 |
| **Claude Agent SDK** | N/A | 0.2.128（2026-07-25） | ✅ in-process SDK MCP Server | ✅ async iterator | ⚠️ 捆绑 CLI 二进制 | 内置 Read/Write/Edit/Bash | 中（体积大） |
| **LangGraph** | ~31,200 | v1.2.8（2026-07-06） | ✅ langchain-mcp-adapters v0.2.2 | ✅ token + 步骤 | ✅ Python | 通用框架 | 低（现有后端） |
| **OpenWorker** ⭐新 | N/A | Open Beta（2026-07-25） | ✅ MCP 支持 | ✅ | ✅ Python FastAPI sidecar | 25+ 托管 + 本地工具 | **N/A（同栈对标，不集成）** |
| **OpenSRE** 新 | N/A | Public Alpha | ✅ MCP + ACP | ✅ | ⚠️ 需 Postgres + Redis | **60+ 运维工具** | 高（独立产品） |
| **HolmesGPT** | 2,800 | 最新 commit 2026-05-15 | ✅ MCP | ✅ SSE | ❌ 独立产品 | **50+ toolsets（K8s）** | 高（独立产品） |
| **TencentOS MCP Server** 新 | N/A | 1.0.0（2026-06-02） | ✅ **本身就是 MCP server** | N/A | ✅ Python | **22 工具/10 场景** | 低（MCP server 直接挂） |
| **ssh-mcp-server** 新 | N/A | 2026-06-23 | ✅ **本身就是 MCP server** | N/A | ⚠️ Node.js | 4 工具（SSH/SFTP） | 中（Node.js 子进程） |

### 3.2 运维场景适配度对比（更新版）

| 项目 | 运维场景适配 | SSH 命令执行 | 文件读取 | 日志分析 | 教学引导 | 生产验证 | TDSF 借鉴价值 |
|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Strands Agents** | ⚠️ 通用，需自建 | ✅ 自建 @tool | ✅ 自建 @tool | ✅ 自建 @tool | ✅ system_prompt | ✅ AWS + Leidos 政府 | 高（首选集成） |
| **PydanticAI** | ⚠️ 通用，需自建 | ✅ 自建 @agent.tool | ✅ 自建 | ✅ 自建 | ✅ instructions | ⚠️ Pydantic Logfire | 高（备选） |
| **OpenWorker** ⭐ | ✅ 本地运维导向 | ✅ shell 工具 | ✅ filesystem | ⚠️ ripgrep | ⚠️ 通用 | ⚠️ Open Beta | **极高（同栈架构参考 + risk engine）** |
| **TencentOS MCP Server** 新 | ✅ Linux 运维专用 | ✅ SSH 远程 | ✅ | ✅ journal logs | ❌ 非教学 | ✅ 腾讯云生产 | **极高（22 工具分类法直接借鉴）** |
| **ssh-mcp-server** 新 | ✅ SSH 运维 | ✅ 白名单/黑名单 | ✅ SFTP | ⚠️ 需扩展 | ❌ | ⚠️ 社区 | 高（白名单/黑名单安全设计） |
| **OpenSRE** 新 | ✅ SRE 专用 | ⚠️ K8s 场景 | ⚠️ | ✅ 多信号 | ❌ | ⚠️ Alpha | 中（多信号整合参考） |
| **HolmesGPT** | ✅ 60+ toolsets | ❌ K8s 场景 | ❌ K8s 场景 | ✅ Loki/Grafana | ❌ 非教学 | ✅ Robusta 商业 | 中（工具设计范式参考） |

---

## 4. 推荐方案（基于最新进展）

### 4.1 首选方案：Strands Agents（维持 v1.0 判断，强化支撑）

**理由**（v1.0 基础上新增 2026-07 下半月数据）：

1. **生产验证持续强化**：
   - Leidos ManagedX 政府级文档处理（2026-04-29，workflow pattern + MCP server 简化 AWS 服务连接）
   - AWS Computer Vision MCP Server + Strands + Bedrock（2026-07-15，视觉智能 agent）
   - Kong AI/MCP Gateway + Strands + Bedrock（2026-01-13，生产级 MCP server 消费保护）
2. **re:Invent 2025 新增能力**：TypeScript SDK + BidiAgent 双向流式 + Steering 边界引导 + Evaluations
3. **发版频率极高**：1.0（2025-07-31）→ 1.48.0（2026-07-17），近一年 48 个版本
4. **模型驱动 agentic loop**：替代 LangGraph 7 节点 PAOR，消除 LangChain 5 包重依赖
5. **`@tool` 装饰器**与 TDSF 现有 `tools/*.py` 的 `invoke_*_tool(params)` 范式高度对齐
6. **MCPClient 原生支持**：可让 TDSF 现有 9 个 MCP tools 直接暴露给 Strands agent
7. **Apache 2.0** 与上游 terax-ai 兼容
8. **13+ 模型提供商**（含 Ollama 本地、LiteLLM 适配国内 DeepSeek/Qwen，符合 TDSF 教学场景）
9. **多 Agent 模式**（Agents-as-Tools / Handoffs / Swarm / Graph）替代 MainAgent 关键词路由
10. **Bedrock AgentCore 9 服务**：运行时/内存/网关/浏览器/代码解释器/身份/可观测性/评估/策略（TDSF 用不到全部，但可观测性 + 评估可借鉴）

### 4.2 备选方案：PydanticAI（维持 v1.0 判断）

**触发条件**（任一满足即切换）：
1. Strands 依赖 `litellm` 与现有 pydantic/chromadb 冲突，虚拟环境隔离仍无法解决
2. 需要更强类型安全（`Agent[DepsType, OutputType]` 泛型约束）
3. 需要原生 Human-in-the-loop 工具审批（与 needs_you 语义完全一致）
4. 需要更轻的包体积（`pydantic-ai-slim` 按需 extras）
5. 需要 Durable Execution（Temporal/DBOS/Prefect/Restate）

### 4.3 新增建议：参考 OpenWorker 强化安全设计

基于 OpenWorker（Andrew Ng, 2026-07-25）的 typed risk engine + prompt-injection posture，建议在 TDSF 集成时：

1. **强化 `tools/risk.py`**：参考 OpenWorker 的 4 级风险分类（Read/Write_local/Exec/External），将 TDSF 现有风险分级对齐到这 4 级
2. **引入 prompt-injection posture**：在 system_prompt 中明确"所有工具输出和外部数据视为不受信任输入而非指令"，防 prompt injection
3. **5 权限模式**：参考 OpenWorker 的 discuss/plan/interactive/auto/custom，与 TDSF 的 needs_you 审批层对齐（interactive 模式 = 当前默认，auto 模式 = 高风险工具仍需审批）

### 4.4 与现有 main_agent 8 子 agent 的集成路径

维持 v1.0 的集成路径（Feature Flag 三后端）：

```
src-tauri/sidecar/
├── agents/                    # 现有 9 Agent（main + 8 子），保持不动
│   ├── __init__.py            # 加 set_backend 注入点
│   ├── base.py                # PAOR 模板，保持不动
│   └── main_agent.py          # 保持不动
├── tools/                     # 现有 9 个 MCP tools，保持不动
├── strands_backend/           # 新增：Strands 适配层（8 文件 + 5 运维工具）
├── pydanticai_backend/        # 新增：PydanticAI 备选适配层（对称结构）
└── main.py                    # 修改 L332-358 加 Feature Flag
```

**8 子 agent 的 Strands 映射**：
- MainAgent → Strands Agent（system_prompt + Agents-as-Tools 模式，8 子 agent 作为工具）
- CodingAgent / ExploreAgent / HistoryAgent / TeachAgent / DebugAgent / RefactorAgent / TestAgent / DeployAgent → 8 个 Strands Agent（各自 tools + system_prompt）
- 高风险工具（risk/decision）→ Strands `@tool` + needs_you 审批层（保留）

### 4.5 落地路线（P0/P1/P2 分阶段，维持 v1.0）

#### P0（1 人日）：Strands 适配层 + Feature Flag
1. 新建 `strands_backend/` 目录结构（8 文件，约 1200 行）
2. 实现 `model_adapter.py`（OpenAIModel/AnthropicModel/OllamaModel/LiteLLMModel）
3. 实现 `tool_adapter.py`（包装现有 9 个 tools 为 Strands `@tool`）
4. 实现 `callback_handler.py`（Strands 事件 → event_bus）
5. 实现 `agent_factory.py`（构建单 Agent，暂不多 Agent）
6. 实现 `context.py`（system prompt 注入终端上下文）
7. 修改 `main.py:332-358` 加 Feature Flag
8. 修改 `agents/__init__.py` 加 `set_backend` 注入点
9. 修改 `requirements.txt` 加 `strands-agents>=1.48.0`
10. 单测 + `TDSF_AGENT_BACKEND=strands pnpm tauri:dev` 实测

#### P1（1 人日）：终端上下文 + 5 运维工具 + PydanticAI 备选 + OpenWorker 安全设计
1. 实现 5 个运维工具（ssh_command / read_remote_file / analyze_logs / query_processes / network_diagnose）
2. 修改 `transport.ts:122-145` 把 `live` 传给 `runSidecarStream`
3. 修改 `sidecar-adapter.ts:337-343` 在 `state` 中追加 `live` 字段
4. 修改 `sidecar-adapter.ts:211-276` 补齐 `sidecar:agent_message` 监听
5. **新增：参考 OpenWorker 强化 `tools/risk.py`**（4 级风险分类 + prompt-injection posture）
6. **新增：参考 TencentOS MCP Server 22 工具分类法**扩展运维工具集
7. 新建 `pydanticai_backend/` 对称结构
8. 实测：`TDSF_AGENT_BACKEND=pydanticai` 切换备选后端

#### P2（0.5 人日）：双向 JSON-RPC + 多 Agent + MCP 协议评估
1. 扩展 JSON-RPC 协议支持 Python → Rust 请求（带 id + 等待响应）
2. Rust 侧增加 `ssh.exec_in_session` / `sftp.read_file` / `sftp.write_file` 等 JSON-RPC handler
3. Python 侧 `send_request(method, params)` + 请求-响应匹配 + 超时
4. 实现 `multi_agent.py`（Strands Agents-as-Tools 模式）
5. **新增：评估引入 MCP 协议**（参考 §5 结论，P2 评估，P3 视情况落地）

---

## 5. MCP 在运维场景的应用调研

### 5.1 现成的运维 MCP server（已成熟，可借鉴）

#### 5.1.1 TencentOS MCP Server（腾讯云, 2026-06-02）⭐ 直接对标

| 维度 | 数据 |
|------|------|
| 发布 | 2026-06-02（腾讯云文档） |
| 版本 | 1.0.0 |
| 工具数 | **22 个工具覆盖 10 大运维场景** |
| 设计 | **所有工具只读、零侵入**（SSH 远程执行，目标主机无需安装 Agent） |
| 集成 | CodeBuddy CLI / Cursor / Claude Desktop / OpenClaw / WorkBuddy |
| 传输 | stdio + Streamable HTTP |

**22 工具分类（直接可借鉴 TDSF 运维工具集设计）**：

| 分类 | 工具 | 能力 |
|------|------|------|
| 系统信息 | get_system_info / get_hardware_info | OS 版本/内核/主机名/架构/运行时间/CPU/内存/磁盘 |
| 服务管理 | get_service_info | 运行服务查询 |
| 进程分析 | list_processes | Top N 进程（按 CPU 排序） |
| 日志查看 | get_journal_logs / get_system_messages | systemd journal（时间/优先级/服务/关键词过滤）+ 系统消息日志 |
| 网络诊断 | get_listening_ports | 监听端口查询 |
| 防火墙 | get_iptables_rules | iptables 规则（filter/nat/mangle/raw 四表） |
| 性能分析 | get_perf_overview | CPU/内存/IO/网络四大维度综合 |
| 软件包 | get_package_info | 软件包版本/架构/描述 |
| 安全审计 | get_selinux_status / get_login_history / get_updateinfo_security | SELinux 状态 + AVC 拒绝 + 登录历史 + 安全告警 + 安全更新公告 |
| 内核管理 | get_sysctl_params / list_kernel_modules | 内核参数（前缀过滤）+ 已加载模块 |
| **eBPF 追踪** | get_ebpf_status / ebpf_trace | eBPF 工具状态 + 追踪系统事件（tcp/bio/exec） |
| 网络追踪 | nettrace | 网络数据包路径追踪（基于 eBPF） |
| 性能分析 | perf_prof | 系统性能瓶颈分析（基于 eBPF） |
| 主机管理 | list_managed_hosts | 多主机管理 |

**与 TDSF 对标价值**：
- ✅ **22 工具分类法直接可借鉴**：TDSF 的 5 个运维工具（ssh_command/read_remote_file/analyze_logs/query_processes/network_diagnose）可扩展到 22 工具，覆盖 10 大场景
- ✅ 只读零侵入设计（SSH 远程执行）与 TDSF 的 SSH/SFTP 运维教学定位完全对齐
- ✅ eBPF 追踪是高级运维教学场景的扩展方向
- ❌ TencentOS MCP Server 是腾讯云产品（绑定 TencentOS/OpenCloudOS），TDSF 不直接复用，但工具分类法可借鉴

#### 5.1.2 ssh-mcp-server（classfang, 2026-06-23）⭐ 安全设计参考

| 维度 | 数据 |
|------|------|
| GitHub | https://github.com/classfang/ssh-mcp-server |
| NPM | @fangjunjie/ssh-mcp-server |
| 发布 | 2026-06-23 |
| 工具 | 4 个：execute-command / upload / download / list-servers |
| 认证 | 密码 / 私钥（含 passphrase）/ SSH Agent / 2FA |
| 模式 | exec（默认，支持文件传输）+ shell（跳板机/堡垒机） |
| 安全 | **白名单/黑名单机制**（正则）+ 凭据隔离 |

**安全设计（直接可借鉴 TDSF `tools/risk.py`）**：
```json
// 白名单模式（仅允许只读命令）
"--whitelist", "^ls( .*)?,^cat .*,^df.*,^ps .*,^top.*"

// 黑名单模式（禁止高危命令）
"--blacklist", "^rm .*,^shutdown.*,^reboot.*,^mkfs.*,^dd .*"
```

**与 TDSF 对标价值**：
- ✅ **白名单/黑名单正则机制**强化 TDSF `tools/risk.py` 的命令风险评估
- ✅ 凭据隔离（SSH 凭据完全本地管理，AI 模型无法直接接触）与 TDSF keyring 设计对齐
- ✅ exec + shell 双模式（shell 支持跳板机）是 TDSF SSH 运维教学的高级场景参考

#### 5.1.3 terminal-mcp-server（weidwonder, 2026-07-30）

| 维度 | 数据 |
|------|------|
| GitHub | https://github.com/weidwonder/terminal-mcp-server |
| 发布 | 2026-07-30（最新） |
| 工具 | execute_command |
| 特性 | 本地/远程 SSH 执行 + **持久会话**（默认 20 分钟重用终端环境）+ 环境变量 |
| 传输 | stdio + SSE |

**与 TDSF 对标价值**：持久会话设计是 TDSF SSH 终端 fan-out（sshStore）的 MCP 协议参考。

### 5.2 是否值得引入 MCP 协议

**结论：P2 阶段评估，P3 视情况落地（非替换 sidecar JSON-RPC）**

**引入 MCP 的收益**：
1. **标准化工具发现**：MCP `tools/list` 自动发现，无需硬编码 TOOL_REGISTRY
2. **生态复用**：可直接挂载 TencentOS MCP Server / ssh-mcp-server 等现成运维 MCP server
3. **跨 agent 复用**：写一次 MCP server，Strands/PydanticAI/OpenAI Agents SDK/Claude Agent SDK 都能调用
4. **协议标准化**：JSON-RPC 2.0 + stdio/Streamable HTTP，与 TDSF 现有 sidecar JSON-RPC 同源

**引入 MCP 的成本**：
1. **MCP spec 2026-07-28 重大版本**（无状态核心 + 移除 initialize/session handshake）：v2 stable 2026-07-27 目标已延期，v1.x 仍稳定但 v2 即将落地，需关注迁移
2. **额外进程管理**：MCP server 通常是子进程（stdio）或 HTTP server，增加 sidecar 复杂度
3. **与现有 sidecar JSON-RPC 重叠**：TDSF 已有 stdio JSON-RPC 2.0，MCP 也是 JSON-RPC 2.0，协议层重叠
4. **Python SDK v2 仍是 beta**：mcp 2.0.0b2（2026-07-15），v1.x（1.28.1）稳定但功能少

**推荐策略**：
- **P0/P1**：不引入 MCP，维持 sidecar JSON-RPC + Strands MCPClient（Strands 内部用 MCP 协议连外部 MCP server，但 TDSF 自身工具仍用 `@tool` 装饰器）
- **P2**：评估将 TDSF 的 9 个 MCP tools 暴露为 MCP server（用 mcp v1.x），让 Strands agent 通过 MCPClient 调用，同时支持外部 MCP 客户端（如 Claude Desktop）调用 TDSF 工具
- **P3**：视 MCP spec 2026-07-28 v2 stable 落地情况，评估迁移到 v2（无状态核心 + Tasks 扩展）

### 5.3 MCP spec 2026-07-28 重大更新（影响所有 MCP 用户）

| 维度 | 旧规范 | 2026-07-28 RC |
|------|--------|---------------|
| 会话模型 | 强制 initialize/initialized 握手 | **无状态核心**，无握手，每请求自包含 |
| 能力协商 | initialize 时一次性交换 | 按需 `server/discover` RPC |
| 负载均衡 | 需粘性会话或共享会话存储 | 标准 round-robin 支持 |
| 长任务 | 同步 tool calls 阻塞 | **Tasks 扩展**（taskId + `tasks/get` 轮询 + `tasks/update` 输入） |
| 富 UI | 不支持 | **MCP Apps 扩展**（沙箱 iframe HTML 渲染） |
| 授权 | 基础 OAuth + 动态客户端注册 | **OAuth 2.1 + OIDC 必需** + EMA（Enterprise-Managed Authorization）扩展 |
| 传输 | stdio + Streamable HTTP | stdio + Streamable HTTP（HTTP+SSE 提议废弃） |
| Roots | 核心特性（客户端广播文件系统 roots） | **提议废弃**（改用工具参数传路径） |
| Sampling | 核心特性（server 请求客户端 LLM 补全） | **提议废弃**（server 直接调 LLM API） |
| Logging | 核心特性（协议级日志） | **提议废弃**（用 stderr 或 OpenTelemetry） |
| 废弃策略 | 无正式策略 | **SEP-2596**：12 个月最低废弃窗口 + 公开废弃注册表 |

**对 TDSF 的影响**：
- ✅ 无状态核心对 TDSF 有利（sidecar 本来就是无状态 JSON-RPC）
- ✅ Tasks 扩展适合 TDSF 长时间运维操作（如 SSH 命令执行 + 日志分析）
- ⚠️ MCP Apps 扩展（沙箱 iframe HTML）可能与 TDSF 前端审批卡片重叠
- ⚠️ Roots/Sampling/Logging 废弃对 TDSF 无影响（TDSF 不用这些）
- **建议**：TDSF 若引入 MCP，锁定 mcp v1.x（1.28.1 stable），等 v2 stable 后再评估迁移

---

## 6. 风险与注意事项

### 6.1 依赖冲突风险（P0 前置必测）

| 风险 | 概率 | 影响 | 缓解措施 |
|------|:---:|:---:|----------|
| Strands 依赖 `litellm` 与现有 pydantic/chromadb 冲突 | 中 | 中 | 虚拟环境隔离 + `pip install` 测试 + 切换 PydanticAI 备选 |
| Strands 1.48 API 变更（向后不兼容） | 低（已 1.x 稳定） | 高（适配层需重写） | Feature Flag 回滚 + 适配层隔离 + 锁定版本 `strands-agents>=1.48,<2.0` |
| PydanticAI `@agent.tool` 绑定 agent 实例与全局 TOOL_REGISTRY 不匹配 | 中 | 低 | 适配层 `tool_adapter.py` 动态绑定 + 工厂模式创建 agent |
| Strands 模型不支持 OpenAI 兼容端点（DeepSeek/OneAPI） | 低 | 高（国内用户受影响） | 已确认 `OpenAIModel(base_url=...)` 支持 + LiteLLM 适配 |

**P0 前置测试命令**（不修改源码，仅在 sidecar 虚拟环境测试）：
```bash
# 在 src-tauri/sidecar/ 虚拟环境
pip install strands-agents>=1.48.0 strands-agents-tools>=1.0.0 litellm
pip check  # 验证无依赖冲突
python -c "from strands import Agent; print('strands OK')"
python -c "import pydantic; import chromadb; print('existing deps OK')"
```

### 6.2 Python 版本要求

| 项目 | Python 要求 | TDSF 现状 |
|------|:---:|:---:|
| Strands Agents | >=3.10（含 3.14） | ✅ TDSF sidecar 已用 Python 3.10+ |
| PydanticAI | >=3.10 | ✅ |
| OpenAI Agents SDK | >=3.10 | ✅ |
| Claude Agent SDK | >=3.10 | ✅ |
| MCP Python SDK v2 | >=3.10 | ✅ |

**结论**：所有候选框架 Python 版本要求一致（>=3.10），与 TDSF sidecar 现状兼容，无版本风险。

### 6.3 与现有 BaseAgent 架构的冲突点

| 冲突点 | 严重度 | 缓解措施 |
|--------|:---:|----------|
| Strands 模型驱动 agentic loop vs BaseAgent PAOR 模板方法 | 中 | Strands 后端不复用 BaseAgent，直接用 Strands Agent；LangGraph fallback 时仍用 BaseAgent |
| Strands `@tool` 装饰器 vs `tools/__init__.py` 的 `invoke_tool(name, params)` 统一入口 | 低 | `tool_adapter.py` 包装：`@tool` 函数内部调 `invoke_tool(name, params)` |
| Strands Agent 事件 vs event_bus 事件类型 | 低 | `callback_handler.py` 转换：start→mood=thinking，complete→mood=done，data→agent_message，current_tool_use→tool_call |
| Strands multi-agent vs MainAgent 关键词路由 | 中 | P2 阶段用 Strands Agents-as-Tools 替代 MainAgent 关键词路由，P0/P1 暂用单 Agent |
| needs_you PAOR 协作 vs Strands agentic loop | 低 | needs_you 作为 human-in-the-loop 审批层保留，高风险工具返回 needs-you 请求作为 tool_result |

### 6.4 回滚方案

**Feature Flag 三后端切换**（维持 v1.0）：
```python
# main.py:332-358 改造（伪代码）
backend = os.environ.get("TDSF_AGENT_BACKEND", "langgraph").lower()
if backend == "strands":
    import strands_backend
    strands_backend.configure_strands(event_bus=event_bus.get_global_bus(), llm_call=llm_call)
    agents.set_backend(strands_backend.invoke_strands_agent)
elif backend == "pydanticai":
    import pydanticai_backend
    pydanticai_backend.configure_pydanticai(event_bus=event_bus.get_global_bus(), llm_call=llm_call)
    agents.set_backend(pydanticai_backend.invoke_pydanticai_agent)
else:  # langgraph（默认，保持现状）
    agents.configure_agents(event_bus=event_bus.get_global_bus(), llm_call=llm_call)
```

**回滚条件**：
1. Strands 依赖冲突无法解决 → 切换 `TDSF_AGENT_BACKEND=pydanticai`
2. PydanticAI 也不可行 → 切换 `TDSF_AGENT_BACKEND=langgraph`（回到现状）
3. 适配层引入 bug → 删除 `strands_backend/` 目录，Feature Flag 默认 langgraph

### 6.5 MCP 协议引入风险（P2 评估）

| 风险 | 概率 | 影响 | 缓解措施 |
|------|:---:|:---:|----------|
| MCP spec 2026-07-28 v2 stable 落地后 v1.x 废弃 | 低（12 个月窗口） | 中 | 锁定 mcp v1.x（1.28.1），v2 stable 后再评估迁移 |
| MCP server 子进程管理增加 sidecar 复杂度 | 中 | 中 | P2 优先用 Strands MCPClient 连外部 MCP server，TDSF 自身工具仍用 `@tool` |
| MCP Apps 扩展（沙箱 iframe HTML）与前端审批卡片重叠 | 低 | 低 | TDSF 不启用 MCP Apps，用现有 React 审批卡片 |
| MCP协议层与 sidecar JSON-RPC 重叠 | 中 | 低 | P2 评估，若重叠严重则不引入 MCP，维持 sidecar JSON-RPC |

---

## 7. 结论与下一步

### 7.1 结论

1. **推荐方案维持不变**：Strands Agents 1.48.0 首选 + PydanticAI v2.13.0 备选。2026-07 下半月未出现颠覆 v1.0 判断的新框架。
2. **Strands 生产验证持续强化**：Leidos 政府级 + AWS Computer Vision + Kong AI/MCP Gateway + re:Invent 2025 新增 BidiAgent/Steering/Evaluations。
3. **新增三个高价值架构参考**：
   - **OpenWorker（Andrew Ng, 2026-07-25）**：与 TDSF 同栈（Tauri 2 + React + Python sidecar），typed risk engine 4 级分类 + prompt-injection posture 直接可借鉴
   - **TencentOS MCP Server**：22 工具/10 场景分类法直接可借鉴扩展 TDSF 运维工具集
   - **ssh-mcp-server**：白名单/黑名单正则机制强化 TDSF `tools/risk.py`
4. **运维专用 agent 框架（OpenSRE/OpsAgent/Lerwee）不作为集成对象**，但其多信号上下文整合 + 智能终止逻辑 + CoT 模板沉淀是设计参考。
5. **MCP 协议已成熟但暂不引入**：P0/P1 维持 sidecar JSON-RPC + Strands MCPClient，P2 评估将 TDSF 9 个 MCP tools 暴露为 MCP server，P3 视 MCP spec 2026-07-28 v2 stable 情况迁移。
6. **改造范围可控**：维持 v1.0 的 `strands_backend/` + `pydanticai_backend/` 三后端 Feature Flag，2.5 人日落地。新增建议：P1 参考 OpenWorker 强化 risk engine + prompt-injection posture，参考 TencentOS 22 工具分类法扩展运维工具集。

### 7.2 下一步

1. **P0 前置：依赖冲突预测试**（立即）：在 sidecar 虚拟环境 `pip install strands-agents>=1.48.0 strands-agents-tools>=1.0.0 litellm`，验证与现有 pydantic/chromadb 无冲突；若冲突，直接启用 PydanticAI 备选
2. **P0 实施**（1 人日）：按 §4.5 创建 `strands_backend/` 适配层 + Feature Flag，五绿门禁全过
3. **P1 实施**（1 人日）：5 运维工具 + 终端上下文感知 + PydanticAI 备选 + **OpenWorker 安全设计强化（risk engine 4 级 + prompt-injection posture）** + **TencentOS 22 工具分类法参考扩展运维工具集**
4. **P2 实施**（0.5 人日）：双向 JSON-RPC + 多 Agent + **MCP 协议评估**
5. **配套文档更新**：P0 完成后更新 `docs/dev-state.md` 记录 Strands/PydanticAI 后端激活状态与已知问题

---

## 附录 A：本次调研新增数据来源（2026-07 下半月）

| 项目 | 数据来源 | 抓取时间 | 关键时间戳 |
|------|----------|----------|-----------|
| Strands Agents | PyPI 1.48.0 + AWS 博客 + community.aws + re:Invent 2025 | 2026-07-30 | 1.48.0 = 2026-07-17；Leidos = 2026-04-29；Computer Vision MCP = 2026-07-15；Kong = 2026-01-13；re:Invent = 2025-12 |
| Claude Agent SDK | PyPI 0.2.128 + platform.claude.com + aiwiki.ai + totalum.app | 2026-07-30 | Python 0.2.128 = 2026-07-25；TS v0.3.156 = 2026-07-30；改名 = 2025-09-29；独立计费 = 2026-06-15；Apple Xcode = 2026-02-03 |
| PydanticAI | PyPI v2.13.0 + rywalker.com + 腾讯云 MCP 广场 | 2026-07-30 | v2.13.0 = 2026-07-18；v2.0.0b7 = 2026-06-10；17.6k stars = 2026-06；33M 月下载 = 2026-06 |
| OpenAI Agents SDK | openai.github.io MCP 文档 | 2026-07-30 | v0.17.7 = 2026-06-24；MCP 4 传输文档 |
| MCP Python SDK | PyPI 2.0.0b2 + aaif.io 博客 + loooop.dev | 2026-07-30 | mcp 2.0.0b2 = 2026-07-15；spec 2026-07-28 RC；v1.28.1 stable |
| OpenWorker ⭐新 | GitHub andrewyng/openworker + thenextgentechinsider | 2026-07-30 | 发布 = 2026-07-25；59 commits；Open Beta |
| OpenSRE 新 | aitoolnet + juejin.cn | 2026-07-30 | Public Alpha；首推 = 2026-05-12 |
| OpsAgent 新 | arXiv:2510.24145v3 | 2026-07-30 | v1 = 2025-10-28；v3 = 2026-05-12；Lenovo 生产 |
| Lerwee Agentic Ops 新 | 51cto 博客 | 2026-07-30 | 发布 = 2026-07-23；30+ CoT 模板 |
| TencentOS MCP Server 新 | 腾讯云文档 | 2026-07-30 | 发布 = 2026-06-02；v1.0.0；22 工具 |
| ssh-mcp-server 新 | openeuler.csdn.net | 2026-07-30 | 发布 = 2026-06-23；classfang/ssh-mcp-server |
| terminal-mcp-server 新 | 腾讯云 MCP 广场 | 2026-07-30 | 发布 = 2026-07-30；weidwonder |
| Tauri + Python sidecar | rustify.rs + CSDN + thenextgentechinsider | 2026-07-30 | tauri-ai-starter = 2026-06-11；chayuan-desktop = 2026-05-12；OpenWorker = 2026-07-25 |

---

## 附录 B：与 v1.0 调研文档的对照表

| v1.0 章节 | v2.0（本文件）对应章节 | 差异 |
|-----------|------------------------|------|
| §1 执行摘要 | §1 调研摘要 | 新增 OpenWorker/TencentOS MCP/OpenSRE 三个高价值发现 |
| §4.1 Strands Agents | §2.1 Strands Agents | 新增 re:Invent 2025 BidiAgent/Steering + Leidos/Kong/Computer Vision 生产案例 + MLflow 追踪 |
| §4.2 OpenAI Agents SDK | §2.2 OpenAI Agents SDK | 新增 MCP 4 种传输详细文档（Hosted/Streamable HTTP/SSE/stdio） |
| §4.3 Claude Agent SDK | §2.3 Claude Agent SDK | 新增 in-process SDK MCP Server + Apple Xcode 集成 + 搜索热度 50,000% 增长 |
| §4.7 PydanticAI | §2.4 PydanticAI | 新增融资 $17.2M + MCP/A2A/UI 三位一体 + Durable Execution 细节 |
| 无 | §2.5 OpenWorker ⭐新 | **新增**：Andrew Ng 同栈架构对标 |
| 无 | §2.6 运维专用框架 | **新增**：OpenSRE + OpsAgent + Lerwee |
| §5 七维度对比矩阵 | §3 七维度对比矩阵（更新版） | 新增 OpenWorker/OpenSRE/TencentOS MCP/ssh-mcp-server 4 行 |
| §7 推荐方案 | §4 推荐方案 | 新增 §4.3 OpenWorker 安全设计参考 + §4.4 8 子 agent Strands 映射 |
| 无 | §5 MCP 在运维场景应用 | **新增**：TencentOS 22 工具 + ssh-mcp-server 白名单 + MCP spec 2026-07-28 重大更新 |
| §10 风险评估 | §6 风险与注意事项 | 新增 §6.5 MCP 协议引入风险 |
| §11 实施路线图 | §4.5 落地路线 | P1 新增 OpenWorker 安全设计 + TencentOS 工具分类法参考；P2 新增 MCP 协议评估 |

---

> **最后更新**：2026-07-30 · v2.0（补充版）
> **上游参考**：[crynta/terax-ai](https://github.com/crynta/terax-ai) v0.8.6（TDSF 唯一基线）
> **任务边界**：本文件仅为调研报告，不修改任何 `src/` 或 `src-tauri/` 下的源码文件。
> **配套文档**：
> - `docs/reports/ops-agent-opensource-survey-2026-07.md`（v1.0，11 项目深度评估）
> - `docs/reports/ops-agent-strands-integration-plan.md`（v2.0 深化版集成方案）
