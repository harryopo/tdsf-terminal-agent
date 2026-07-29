# TDSF Terminal Agent — 2026 年 7 月运维 Agent 开源生态调研

> **位置**：`docs/reports/ops-agent-opensource-survey-2026-07.md`
> **版本**：v1.0（2026-07-30 首次发布）
> **作用**：对 2026 年 7 月时点的主流运维/通用 AI Agent 开源项目做全网真实调研，复核既有 Strands Agents 选型是否仍是最佳，给出首选 + 备选方案、集成方式、5 个核心运维工具的 Python 实现骨架，为 TDSF Terminal Agent 集成运维 agent 提供决策依据。
> **任务边界**：本文件仅为调研/方案文档，不修改任何 `src/` 或 `src-tauri/` 下的源码文件。
> **数据基准**：2026-07-30 的 WebSearch + WebFetch + PyPI + GitHub 页面真实抓取，非记忆编造。Stars/下载量为各来源文章披露的近似值，会随时间变动。
> **上游参考**：[crynta/terax-ai](https://github.com/crynta/terax-ai) v0.8.6（TDSF 唯一基线）

---

## 0. 元信息

| 项 | 值 |
|----|----|
| 调研日期 | 2026-07-30 |
| 调研人 | subagent A（general-purpose） |
| 项目 | TDSF Terminal Agent（crynta/terax-ai v0.8.6 魔改版） |
| 技术栈 | Tauri 2（Rust 壳）+ React 19 前端 + Python sidecar（AI 引擎，已用 needs_you PAOR） |
| 已有 sidecar 路径 | `src-tauri/sidecar/`（含 `main.py` / `event_bus.py` / `agents/base.py` / `agents/main_agent.py` / `risk_engine.py` / `needs_you.py` / 9 个 `tools/*.py`） |
| 既有方案文档 | `docs/reports/ops-agent-strands-integration-plan.md`（v2.0 深化版，推荐 Strands Agents） |
| 本文件结论 | **维持 Strands Agents 首选**，新增 **PydanticAI 为轻量级备选**，详见 §7 |

---

## 1. 执行摘要

### 1.1 核心结论（与既有 v2.0 方案的关系）

1. **Strands Agents 仍是首选**：截至 2026-07-17 已迭代到 **1.48.0**（v2.0 方案撰写时为 1.0），6,704 stars，Apache 2.0，几乎每周发版，AWS 内部 Amazon Q Developer / Glue / VPC Reachability Analyzer 持续生产验证，2026-02 新增 Strands Labs 实验性组织。模型驱动 agentic loop + `@tool` 装饰器 + 原生 MCPClient + `stream_async` 与 TDSF 现有 `tools/*.py` 范式高度对齐，**v2.0 方案的选型判断成立**。
2. **新增 PydanticAI 为轻量级备选**：v2.13.0（2026-07-18），18,670 stars，MIT，Pydantic 团队原厂。`Agent[DepsType, OutputType]` 类型安全、原生 MCPToolset、Human-in-the-loop 工具审批、Durable Execution、月下载 208M+。**当 Strands 依赖过重或与现有 pydantic/chromadb 冲突时**，PydanticAI 是更轻、更类型安全的替代。
3. **AutoGen 已废弃，勿选**：2025-10 Microsoft 将 AutoGen + Semantic Kernel 合并为 Microsoft Agent Framework（MAF 1.0 GA 2026-04-03），AutoGen 进入维护模式（仅安全补丁），新项目应选 MAF 或其他活跃框架。
4. **Goose 是架构对标而非集成对象**：aaif-goose/goose 48.5k stars，Rust + Tauri 桌面端（**与 TDSF 同栈**），AAIF 基金会托管，70+ MCP 扩展。但 Goose 是产品不是 SDK，TDSF 已有 Python sidecar，不直接集成；其"本地优先 + MCP 动态发现 + Rust+Tauri 桌面端"范式是 TDSF 的架构对标参考。
5. **HolmesGPT 是运维工具设计参考**：CNCF Sandbox（2025-10），50+ toolsets，YAML 声明式工具，ReAct agentic loop。其工具设计范式（单一职责 + 清晰 docstring + 风险感知）直接启发 TDSF 的 `ops_*.py` 工具设计，但工具集面向 K8s/云原生，不直接复用。
6. **改造范围可控**：维持 v2.0 方案的 `strands_backend/` sub-package 适配层（约 8 文件 1200 行 + 5 运维工具），Feature Flag `TDSF_AGENT_BACKEND=strands|pydanticai|langgraph` 三后端并行，出问题即时回滚。
7. **needs_you PAOR 模式保留**：Strands/PydanticAI 的 agentic loop 完整覆盖 PAOR 语义（Plan=首次推理隐式规划，Act=tool_use，Observe=tool_result，Reflect=再次推理），`needs_you` 的 needs-you 请求机制作为高风险工具的 human-in-the-loop 审批层保留，不替换。

### 1.2 与既有 v2.0 方案的差异

| 维度 | v2.0 方案（2026-07-30 既有） | 本调研（2026-07-30 复核） |
|------|------------------------------|--------------------------|
| 调研覆盖 | 9 个项目（Strands 1.0 + 8 对标） | **11 个项目**（Strands 1.48 + 10 对标，新增 PydanticAI、Microsoft Agent Framework） |
| Strands 版本 | 1.0（2025-07-31 发布） | **1.48.0**（2026-07-17 发布，近一年迭代 48 个版本） |
| 备选方案 | 无明确备选 | **新增 PydanticAI v2.13.0 为轻量级备选** |
| AutoGen 状态 | 未单独评估 | **明确标记已废弃**（2025-10 进入维护模式，MAF 1.0 GA 2026-04-03） |
| Goose 状态 | 32,300 stars（2026-03） | **48,500 stars**（2026-06），AAIF 正式接管（2026-06-11），最新 commit 2026-07-27 |
| Feature Flag | `strands|langgraph` 双后端 | **`strands|pydanticai|langgraph` 三后端** |
| 工具示例 | 引用配套文档 `ops-agent-tool-examples.md` | **本文件内嵌 5 个核心运维工具 Python 骨架**（§9） |

### 1.3 改造规模预估（维持 v2.0）

| 维度 | 数量 |
|------|------|
| 新增文件 | 8 个（`strands_backend/` 适配层） + 5 个（`strands_backend/tools/ops_*.py`） |
| 修改文件 | 7 个（`requirements.txt` / `agents/__init__.py` / `core/llm_config.py` / `main.py` 注册段 / `transport.ts` / `sidecar-adapter.ts` / `.env.example`） |
| 保留不动 | 全部业务模块（`event_bus` / `tools/risk.py` / `needs_you` / `fix_loop` / `knowledge` / `skills` / `permissions` / `tdsf_loader`） |
| 前端协议改动 | 0（`agent.invoke` 签名不变）；可选扩展 `state.live` 字段（P1） |
| Rust 改动 | 0（JSON-RPC 协议不变）；P2 可选扩展双向 JSON-RPC |
| 预计工时 | P0 一天 + P1 一天 + P2 半天 = 2.5 人日 |

---

## 2. 调研方法与数据来源

### 2.1 调研方法

1. **WebSearch 全网搜索**：每个项目用 2-3 个独立查询交叉验证，覆盖 GitHub repo、PyPI、官方博客、第三方评测；
2. **WebFetch GitHub repo 页面**：直接抓取 repo 首页，确认 stars、最近 commit 时间、commit 数、issues 数；
3. **PyPI Release RSS**：确认发版频率与最新版本时间戳；
4. **本地 sidecar 源码通读**：确认 TDSF 现有 `base.py` PAOR 模板、`needs_you.py` 机制、9 个 `tools/*.py` 范式、`main.py` 注册接入点；
5. **既有方案文档复核**：对照 `ops-agent-strands-integration-plan.md` v2.0，验证其选型判断是否仍成立。

### 2.2 数据来源（真实 URL）

| 项目 | GitHub repo | 数据来源 |
|------|-------------|----------|
| Strands Agents | https://github.com/strands-agents/sdk-python | PyPI 1.48.0（2026-07-17）+ WebFetch repo + AWS Open Source Blog |
| OpenAI Agents SDK | https://github.com/openai/openai-agents-python | WebFetch repo（最新 commit 2026-07-04）+ PyPI v0.17.7 + SourceForge mirror |
| Claude Agent SDK | https://github.com/anthropics/claude-agent-sdk-typescript | npm @anthropic-ai/claude-agent-sdk v0.3.156 + totalum.app 2026 评测 + Novita AI 指南 |
| LangGraph | https://github.com/langchain-ai/langgraph | releases.sh（v1.2.8 2026-07-06）+ chatforest.com 评测 + LangChain 官方文档 |
| AutoGen / MAF | https://github.com/microsoft/autogen | dev.to（维护模式声明）+ dreaming.press（Build 2026）+ Microsoft Learn 迁移指南 |
| CrewAI | https://github.com/crewAIInc/crewAI | gittimes.com（v1.15.6 2026-07-26）+ automationatlas.io + 官方 changelog |
| PydanticAI | https://github.com/pydantic/pydantic-ai | PyPI v2.13.0（2026-07-18）+ chatforest.com 评测 + CSDN 技术详解 |
| HolmesGPT | https://github.com/HolmesGPT/holmesgpt | WebFetch repo（最新 commit 2026-05-15）+ CNCF 博客（2026-01-07）+ cn486.com 评测 |
| OpenHands | https://github.com/All-Hands-AI/OpenHands | yeyulingfeng.com（v1.7.0 2026-05-01）+ theagenttimes.com + toutiao 团队评测 |
| Goose | https://github.com/aaif-goose/goose | WebFetch repo（最新 commit 2026-07-27）+ mr.technology + smzdm AAIF 接管报道 |
| Spug | https://github.com/openspug/spug | gitcode.com 安装指南 + Gitee star 列表 |
| 1Panel | https://github.com/1Panel-dev/1Panel | gitcode.com 教程 + CSDN RSS（3.2 万 stars） |

---

## 3. TDSF 现有架构回顾（决策基线）

> 详细架构地图见 `CLAUDE.md` §2 与 `ops-agent-strands-integration-plan.md` §3，本节仅列决策关键点。

### 3.1 Python Sidecar 启动链

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/main.py` 是 stdio JSON-RPC 2.0 server：

- **L489-496**：安装 `log_capture` handler（必须先于业务模块 import）；
- **L499**：初始化 `MethodDispatcher`（自动注册 `ping` / `shutdown` / `status`）；
- **L502-509**：`register_business_methods(dispatcher)` 注册 15 个业务模块（每个 try/except 包裹）；
- **L512-521**：发送 `ready` 通知（Rust 阻塞等待此信号判定启动成功）；
- **L525-581**：主循环逐行读 stdin，dispatch JSON-RPC；
- **L584-592**：退出时 `needs_you.stop_global_service()` 清理线程。

### 3.2 Agent 模块接入点（Strands/PydanticAI 集成关键）

`main.py:332-358` 是 agents 模块注册段：

```python
import agents
from core.llm_config import make_llm_call
llm_call = make_llm_call()
agents.register_methods(dispatcher)  # 注册 agent.invoke / agent.list / agent.info / agent.configure
agents.configure_agents(event_bus=event_bus.get_global_bus(), llm_call=llm_call)
```

**集成策略**：在此处加 Feature Flag，按 `TDSF_AGENT_BACKEND` 环境变量切换后端，`agent.invoke` 等 4 个 JSON-RPC 方法签名不变。

### 3.3 BaseAgent PAOR 模板（needs_you 协作基线）

`agents/base.py`：

- **L44-59** `LLMCallFunction` Protocol：签名 `(messages: list[dict]) -> str`（OpenAI Chat Completions 兼容）；
- **L62-100** `AgentResult`：返回 dict 含 `observation` / `next_step` / `reflection` / `mood`；
- **L107+** `BaseAgent.invoke(state)` 模板方法：`plan_task` → `select_tool` → `call_tool` → `format_observation` → `reflect_on_result`。

**needs_you 协作**：高风险工具返回 needs-you 请求，`needs_you.py` 通过 event_bus 推送审批事件，前端渲染审批卡片，用户批准后才继续 agentic loop。Strands/PydanticAI 的 agentic loop 完整覆盖 PAOR 语义，`needs_you` 作为 human-in-the-loop 审批层保留。

### 3.4 工具层（9 个 MCP tools）

`tools/__init__.py`：`TOOL_REGISTRY` 9 个工具（risk / confidence / ground / decision / credibility / history / worktree_fanout / rlm_fanout / steer_inject），统一 `invoke_tool(name, params)` 入口，每个工具有 `invoke_*_tool(params) -> dict` + `get_tool_metadata() -> dict`。

**Strands 映射**：`@tool` 装饰器包装现有 `invoke_*_tool`；**PydanticAI 映射**：`@agent.tool` 装饰器 + Pydantic 模型校验入参。

---

## 4. 11 个主流项目深度评估

### 4.1 AWS Strands Agents（首选，确认）

| 维度 | 数据 |
|------|------|
| GitHub | https://github.com/strands-agents/sdk-python |
| PyPI 最新 | **1.48.0**（2026-07-17 发布） |
| Stars / Forks | 6,704 / 993（PyPI 披露） |
| Commits / Issues | 646 commits / 334 issues（WebFetch 2026-07-30） |
| License | Apache 2.0 |
| Python | >=3.10 |
| 发版频率 | 几乎每周（PyPI RSS 显示 1.20-1.48 共 29 个版本，2025-12 至 2026-07） |
| 生产验证 | Amazon Q Developer / Amazon Glue / VPC Reachability Analyzer |
| 2026 新进展 | 2026-02-23 推出 Strands Labs 实验性组织（state-of-the-art agentic AI 实验） |
| 模型支持 | Bedrock / Anthropic / Gemini / LiteLLM / Llama / Ollama / OpenAI / Writer / Mistral / Cohere / SageMaker / Custom |
| 多 Agent | 1.0 四原语：Agents-as-Tools / Handoffs / Swarm / Graph + A2A 协议 |
| MCP | 原生 `MCPClient`（stdio / Streamable HTTP） |
| 流式 | `stream_async` 异步迭代器 + `callback_handler` 事件回调 |
| 工具创建 | `@tool` 装饰器从 docstring + 类型标注自动生成工具描述 |
| 工具热加载 | `load_tools_from_directory=True` 自动监听 `./tools/` 目录变化 |

**核心范式**（AWS 官方）：

```python
from strands import Agent, tool
from strands_tools import calculator

@tool
def word_count(text: str) -> int:
    """Count words in text."""
    return len(text.split())

agent = Agent(tools=[calculator, word_count])
response = agent("How many words are in this sentence?")
```

**与 TDSF 兼容性**：
- ✅ Python SDK，与 `src-tauri/sidecar/` Python sidecar 无缝对接；
- ✅ `@tool` 装饰器与 TDSF 现有 `tools/*.py` 的 `invoke_*_tool(params)` 范式对齐；
- ✅ MCPClient 原生支持，可暴露现有 9 个 MCP tools；
- ✅ `stream_async` 替代当前 dict 切片模拟流式；
- ✅ Apache 2.0 与上游 terax-ai 兼容；
- ⚠️ 依赖 `litellm`（LiteLLMModel 必需），可能与现有 pydantic 版本冲突（需虚拟环境隔离测试）。

### 4.2 OpenAI Agents SDK Python（原 Swarm 继任）

| 维度 | 数据 |
|------|------|
| GitHub | https://github.com/openai/openai-agents-python |
| 最新版本 | **v0.17.7**（2026-06-24，SourceForge mirror） |
| Stars | 27,900+（持续增长） |
| 最新 commit | 2026-07-04（seratch，"chore: update runtime-behavior-probe skill"） |
| Commits / Issues | 1,661 commits / 31 issues（WebFetch 2026-07-30） |
| License | MIT（开源核心） |
| 前身 | OpenAI Swarm（2025-03 archived，用户导向 Agents SDK） |
| 2026-04 更新 | "Next Evolution"：sandbox 执行（E2B/Modal）+ 长周期 harness + subagent 原语 beta |
| 模型支持 | OpenAI 原生 + 100+ 其他 LLM（通过 LiteLLM 适配） |
| 核心原语 | Routines（agent + tools）+ Handoffs（agent 间控制转移）+ Agents-as-Tools |
| MCP | 原生支持 |
| Sessions | 自动对话历史（Redis 会话存储） |
| Guardrails | 输入输出验证 |
| 流式 | token-by-token + 中间步骤流式 |
| Voice / Realtime | 内置语音 + WebSocket realtime |

**与 TDSF 兼容性**：
- ✅ Python SDK，轻量级（无过多冗余依赖）；
- ✅ Handoffs + Agents-as-Tools 多 Agent 模式；
- ⚠️ 偏向 OpenAI 模型优化，国内 OpenAI 兼容端点（DeepSeek/OneAPI）需测试；
- ⚠️ v0.17.x 仍是 0.x 版本，API 可能变动；
- ⚠️ Sessions 默认 OpenAI 服务端管理，TDSF 需用 `result.to_input_list()` 手动控制。

### 4.3 Anthropic Claude Agent SDK（原 Claude Code SDK）

| 维度 | 数据 |
|------|------|
| GitHub (TS) | https://github.com/anthropics/claude-agent-sdk-typescript |
| Python 包 | `claude-agent-sdk`（PyPI）/ `claude-agent-sdk-python`（GitHub） |
| TS 最新 | @anthropic-ai/claude-agent-sdk **v0.3.156**（2026-07-30 前 10 小时发布） |
| Python Stars | 5,700+ |
| 改名时间 | 2025-09（从 Claude Code SDK 改名，信号"不只用于编码"） |
| 计费变化 | 2026-06-15 起 Agent SDK 和 Claude Code GitHub Actions 独立计费 |
| 底层 harness | 与 Claude Code CLI 相同的 agent harness |
| 入口 API | `query()` 返回 async iterator（非手动 tool 循环） |
| 内置工具 | Read / Write / Edit / Bash / Grep / Glob / WebSearch / WebFetch |
| Sessions | 内置 session ID 恢复 |
| Hooks | 生命周期校验/日志/阻断 |
| Subagents | 内置子代理 |
| MCP | 原生支持 |
| 模型后端 | Anthropic API / Amazon Bedrock / Google Vertex AI / Azure AI Foundry |

**与 TDSF 兼容性**：
- ⚠️ **绑定 Anthropic 计费**（2026-06-15 独立计费），国内用户成本可控性差；
- ⚠️ Python 包捆绑 Claude Code CLI 二进制，部署体积大；
- ⚠️ 内置工具集（Read/Write/Edit/Bash/Grep/Glob）是 Claude Code 范式，与 TDSF 的 SSH/SFTP 运维工具集不对齐；
- ✅ harness 设计（agent loop + tool validation + retries + traces）是架构参考；
- ❌ **不推荐作为 TDSF 集成对象**（计费绑定 + 体积大 + 工具集不对齐），但其 harness 设计思想可借鉴。

### 4.4 LangGraph（LangChain 出品，低级编排）

| 维度 | 数据 |
|------|------|
| GitHub | https://github.com/langchain-ai/langgraph |
| 最新版本 | **v1.2.8**（2026-07-06） |
| Stars / Forks | ~31,200 / ~5,300 |
| 月下载 | 34.5M |
| 1.0 GA | 2025-10-22 |
| License | MIT |
| 核心抽象 | `StateGraph`（typed state schema + nodes + edges + reducer） |
| 检查点 | PostgreSQL / MongoDB / In-memory，v1.2 alpha 引入 DeltaChannel 增量存储 |
| 多 Agent | `langgraph-supervisor`（层级编排）+ `langgraph-swarm-py`（P2P handoff） |
| MCP | `langchain-mcp-adapters` v0.2.2（2026-03-16，~3,500 stars） |
| 生产采用 | Uber / LinkedIn / Klarna / Replit / GitLab / J.P. Morgan |
| 设计哲学 | 低级编排框架，"不做复杂编排，把 agent 编排做好" |

**与 TDSF 兼容性**：
- ⚠️ TDSF 现有 sidecar 已用 LangGraph 7 节点 PAOR（v2.0 方案待替换为 Strands）；
- ⚠️ LangChain 5 包重依赖（langgraph + langchain-core + langchain-community + langchain-openai + langchain-anthropic）；
- ✅ 1.0 GA 稳定，生产验证充分；
- ⚠️ 低级编排 = 更多样板代码，与 TDSF "模型驱动 agentic loop 简化"目标相反；
- **定位**：TDSF 现有后端（Feature Flag 默认 `langgraph`），Strands/PydanticAI 稳定后可删除。

### 4.5 Microsoft AutoGen / Agent Framework（AutoGen 已废弃）

| 维度 | 数据 |
|------|------|
| AutoGen GitHub | https://github.com/microsoft/autogen |
| AutoGen 状态 | **维护模式**（2025-10 起，仅安全补丁） |
| MAF 1.0 GA | 2026-04-03（AutoGen + Semantic Kernel 合并） |
| MAF 语言 | Python + .NET |
| Build 2026 新进展 | Agent Harness + Hosted Agents（Foundry）+ CodeAct（~50% 降低延迟，60%+ 减少 token） |
| AutoGen 核心概念 | 已被 MAF 继承（FunctionTool / AssistantAgent / GroupChat / MagenticOneGroupChat） |
| AG2 fork | 社区管理，0.11.2（2026-02），A2A 支持 |

**与 TDSF 兼容性**：
- ❌ **AutoGen 勿选**（已废弃，新项目应选 MAF 或其他活跃框架）；
- ⚠️ MAF 偏向 Azure 生态（Azure AI Foundry 深度集成），TDSF 是本地桌面端，不匹配；
- ⚠️ MAF 多语言 SDK（Python + .NET）一致性是卖点，但 TDSF 只用 Python，无收益；
- **定位**：不作为 TDSF 选型候选，但 MAF 的 Agent Harness 概念（shell/filesystem/approval/context compaction/todo tracking）是 TDSF 运维 agent 设计参考。

### 4.6 CrewAI（角色驱动多 Agent）

| 维度 | 数据 |
|------|------|
| GitHub | https://github.com/crewAIInc/crewAI |
| 最新版本 | **v1.15.6**（2026-07-26） |
| Stars | 56,100（2026-07） |
| License | MIT |
| 创始人 | João Moura（2023 创建） |
| 核心概念 | Agents（角色单元）+ Crews（自主团队）+ Flows（事件驱动状态化编排） |
| 模型后端 | OpenAI / Anthropic / Gemini / Azure / Bedrock 原生 + Ollama / HuggingFace / Mistral / Groq via LiteLLM |
| 企业采用 | 63% Fortune 500（DocuSign / Experian / PepsiCo / IBM / Johnson & Johnson） |
| 开核模式 | 开源框架（MIT）+ 企业版 AMP（托管部署 + 监控仪表盘） |
| 认证开发者 | 100,000+ |
| 已知问题 | 671 open issues（复杂 agent 交互稳定性挑战） |

**与 TDSF 兼容性**：
- ✅ Python 框架，MIT License；
- ✅ Crews + Flows 双引擎（自主 + 可控）；
- ⚠️ 角色驱动（role/goal/backstory）与 TDSF 的 PAOR 工具驱动范式不同，迁移成本高；
- ⚠️ 671 open issues 反映复杂场景稳定性问题；
- ⚠️ 开核模式，企业功能在付费层；
- **定位**：不作为 TDSF 选型候选（角色驱动与工具驱动范式不匹配）。

### 4.7 PydanticAI（轻量级黑马，备选）

| 维度 | 数据 |
|------|------|
| GitHub | https://github.com/pydantic/pydantic-ai |
| PyPI 最新 | **v2.13.0**（2026-07-18） |
| Stars / Forks | 18,670 / 2,392 |
| 月下载 | pydantic-ai-slim 208M+（2026-05） |
| Open issues / PRs | 361 / 134 |
| License | MIT |
| Python | >=3.10 |
| 团队 | Pydantic 团队原厂（Samuel Colvin / David Montague / Douwe Maan） |
| 核心抽象 | `Agent[DepsType, OutputType]`（类型安全泛型） |
| 模型支持 | 30+ 提供商（OpenAI / Anthropic / Gemini / DeepSeek / Grok / Cohere / Mistral / Ollama / LiteLLM / Groq / OpenRouter / 阿里云 / SambaNova 等） |
| MCP | 原生 `MCPToolset`（v1.97.0 统一，backed by fastmcp-slim[client]）— 客户端 + 服务端双向 |
| A2A | 支持 Google A2A 协议（2026-05 捐赠 FastA2A 给 Datalayer） |
| Human-in-the-loop | 内置工具审批系统（基于参数/历史/偏好条件审批） |
| Durable Execution | DBOS / Prefect / Restate 集成 |
| 流式 | 流式结构化输出（持续 Pydantic 验证） |
| 图结构 | `pydantic_graph`（v1.97.0 stable） |
| 可观测性 | Pydantic Logfire 深度集成（OpenTelemetry） |
| Evals | Pydantic Evals 系统化测试 |
| Harness | `pydantic-ai-harness` v0.11.0（2026-07-25，CodeMode/Monty 沙箱/DynamicWorkflow） |
| Monty 沙箱 | Rust 实现 Python 沙箱（mcp-run-python 继任，Hack Monty 安全赏金） |
| Agent Specs | YAML/JSON 声明式 agent 定义（无代码） |

**核心范式**：

```python
from pydantic_ai import Agent, RunContext

agent = Agent(
    'anthropic:claude-sonnet-4-0',
    deps_type=MyDeps,
    output_type=MyOutput,
    instructions='你是一个 Linux 运维教学助手',
)

@agent.tool
def ssh_command(ctx: RunContext[MyDeps], command: str) -> dict:
    """Propose an SSH command for approval."""
    return {"command": command, "require_approval": True}

result = agent.run_sync("查看当前目录文件")
```

**与 TDSF 兼容性**：
- ✅ Python 原生，MIT，类型安全（`Agent[DepsType, OutputType]`）；
- ✅ 依赖注入（`RunContext[Deps]`）与 TDSF 的 `event_bus` / `llm_call` 注入范式对齐；
- ✅ 原生 MCPToolset 双向（客户端 + 服务端），可暴露现有 9 个 MCP tools；
- ✅ Human-in-the-loop 工具审批与 TDSF 的 `needs_you` 机制语义一致；
- ✅ Pydantic 团队原厂，与 TDSF 现有 pydantic 依赖无冲突（同源）；
- ✅ 比 Strands 更轻（核心包 `pydantic-ai-slim`，按需 extras）；
- ⚠️ 2.x 稳定但生态较新（Strands 有 AWS 生产验证，PydanticAI 主要 Pydantic Logfire 内部验证）；
- ⚠️ `@agent.tool` 装饰器绑定具体 agent 实例，与 TDSF 的全局 `TOOL_REGISTRY` 范式略有差异（需适配层）；
- **定位**：**首选备选**，当 Strands 依赖冲突或需要更强类型安全时切换。

### 4.8 HolmesGPT（运维场景对标）

| 维度 | 数据 |
|------|------|
| GitHub | https://github.com/HolmesGPT/holmesgpt（原 https://github.com/robusta-dev/holmesgpt 重定向） |
| Stars | 2,800 |
| CNCF 状态 | Sandbox（2025-10 接收） |
| 共建方 | Robusta.dev + Microsoft |
| 最新 commit | 2026-05-15（aantn + claude，"Simplify jinja2 prompts"） |
| Commits / Issues | 1,403 / 74 |
| Branches / Tags | 481 / 136 |
| 架构层次 | 入口层（FastAPI HTTP + CLI）/ 编排层（ToolCallingLLM）/ 核心引擎（LLM ↔ ToolExecutor ↔ ToolsetManager）/ 插件系统（Toolsets 50+ / Sources / Destinations / Skills / MCP / Transformers）/ 基础设施（Context Window / OAuth / Safeguards） |
| Agentic Loop | `ToolCallingLLM.call_stream()`（max_steps=10，compact_if_necessary 上下文压缩，并发工具执行） |
| Toolsets | 50+（Kubernetes / Prometheus / Grafana / Loki / Datadog / AWS / PostgreSQL / GitHub / Jenkins / ServiceNow / Azure / Datadog / Elastic / OpenSearch / Loki / Coralogix / Instana / Zabbix 等） |
| 工具定义 | YAML 声明式（无需写 Python）：`toolsets: kubernetes/pod_status: tools: - name: get_pod, command: kubectl get pod` |
| Skills | 0.26.0 引入（技能目录 + 工具调用 + 审批/审计） |
| 告警集成 | Alertmanager / PagerDuty 双向 |
| 安装 | `pip install holmesgpt` / `brew install holmesgpt` / Docker |

**与 TDSF 对标价值**：
- ✅ **运维场景 agentic loop 最佳实践**：50+ toolset 的"单一职责 + 清晰 docstring + 风险感知"范式直接启发 TDSF 的 `ops_*.py` 设计；
- ✅ YAML 声明式工具定义适合 TDSF 运维教学场景（非开发者也能定义工具）；
- ✅ Context Window 管理（compact_if_necessary）是长会话运维场景的必备；
- ❌ 工具集面向 K8s/云原生，TDSF 面向单机/SSH Linux 运维教学，不直接复用；
- ❌ 独立产品（FastAPI server），不是 SDK，TDSF 不能直接嵌入；
- **定位**：**运维工具设计参考**，不作为集成对象。

### 4.9 OpenHands（编码平台参考）

| 维度 | 数据 |
|------|------|
| GitHub | https://github.com/All-Hands-AI/OpenHands |
| Stars | 75,000+（2026-06） |
| 最新版本 | **v1.7.0**（2026-05-01） |
| License | MIT / Apache 2.0 |
| 前身 | OpenDevin（2024 中改名） |
| 架构 | 三层：CLI / Software Agent SDK / Cloud / Enterprise |
| 核心 | CodeAct 1.0（写代码 + 执行行动统一） |
| 沙箱 | Docker 容器隔离（主机零污染） |
| SWE-bench | 53%+（Claude 4.5 Sonnet） |
| 模型无关 | Claude / GPT / Gemini / Ollama 10+ 模型 |
| 生产采用 | TikTok / VMware / Amazon / NVIDIA / Google |
| 2026-03 Planning Mode | Beta（先计划再执行） |
| v1.6.0 | K8s 部署 + 多用户 + RBAC |

**与 TDSF 关系**：
- ❌ 定位不同（OpenHands = 自主编码平台，TDSF = 运维教学终端 IDE）；
- ❌ 依赖重（Docker-in-Docker / 特权容器）；
- ✅ 沙箱化执行 + 事件溯源状态模型 + MCP 类型化工具系统是架构参考；
- **定位**：不作为集成对象，沙箱设计是参考。

### 4.10 Goose（架构对标，同 Tauri 栈）

| 维度 | 数据 |
|------|------|
| GitHub | https://github.com/aaif-goose/goose |
| Stars | 48,500（2026-06） |
| 最新 commit | **2026-07-27**（jamadeo，"upgrade to rmcp 2.0"） |
| Commits / Issues / PRs | 5,133 / 223 / 189 |
| License | Apache 2.0 |
| 原始开发方 | Block（Square / Cash App 母公司） |
| 基金会托管 | 2026-06-11 AAIF 正式接管（从 Block/goose 迁至 aaif-goose/goose） |
| 技术栈 | **Rust (58.6%) + TypeScript (33.9%)**，Tauri 桌面端（**与 TDSF 同栈**） |
| 形态 | CLI + Desktop App + API Server 三种 |
| 模型支持 | 15+ 提供商（Anthropic / OpenAI / Google / Ollama / OpenRouter / Azure / Bedrock 等） |
| ACP 协议 | Agent Context Protocol（用现有 Claude/ChatGPT/Gemini 订阅，无需额外 API） |
| MCP 扩展 | 70+（extensions are MCP servers） |
| 最新版本 | v1.30.0（2026-04-08） |
| AAIF 三大核心 | MCP（连接层）+ AGENTS.md（描述层）+ Goose（执行层） |

**与 TDSF 关系**：
- ✅ **同技术栈**（Rust + Tauri 桌面端），架构直接对标；
- ✅ 本地优先 + MCP 动态发现范式印证 TDSF 方向；
- ✅ AAIF 基金会托管，长期维护有保障；
- ❌ Goose 是产品（CLI + Desktop + API），不是 Python SDK，TDSF 已有 Python sidecar；
- ❌ 直接集成会替换 TDSF 整个 AI 层，改造代价过大；
- **定位**：**架构对标参考**，不作为集成对象。TDSF 可借鉴其 MCP 扩展生态 + Tauri 桌面端 agent 交互范式。

### 4.11 中国运维项目（Spug / 1Panel）

#### 4.11.1 Spug

| 维度 | 数据 |
|------|------|
| GitHub | https://github.com/openspug/spug |
| 定位 | 面向中小型企业的轻量级**无 Agent**自动化运维平台 |
| 技术栈 | Python 3.6+ (Django 2.2) + Node 12.14 (React 16.11) + Ant Design |
| 功能 | 主机管理 / 批量执行 / 在线终端 / 文件上传下载 / 应用发布 / 任务计划 / 配置中心 / 监控 / 报警 |
| 数据库 | 默认 SQLite（可改 MySQL/PostgreSQL） |
| AI agent | **无**（纯运维平台，非 AI agent） |

**与 TDSF 关系**：Spug 是传统运维平台，无 AI agent 能力，不作为选型候选。其主机管理 / 批量执行 / 在线终端功能与 TDSF 的 SSH explorer + 终端模块功能重叠，但 TDSF 是桌面端 IDE + AI agent，定位不同。

#### 4.11.2 1Panel

| 维度 | 数据 |
|------|------|
| GitHub | https://github.com/1Panel-dev/1Panel |
| Stars | 32,000+（2026-07） |
| 开发方 | 杭州飞致云 |
| 技术栈 | Go + React |
| 定位 | 现代化开源 Linux 服务器运维**面板**（VPS control panel） |
| AI agent | **原生支持**（Run Ollama models, deploy OpenClaw agents） |
| 核心特性 | 开源免费 / 低资源占用（<30MB）/ 多系统兼容 / Docker 容器化 / 应用商店 200+ / 网站管理 / 数据库可视化 / 防火墙 / 多机管理 / AI 运维 / 自定义仓库 |
| 数据治理 | 时间/数量/空间三维度清理规则 + 智能调度 + 安全保障（引用检查 + 回收站 + 审计日志） |

**与 TDSF 关系**：1Panel 是服务器运维面板（Web GUI），不是 agent 框架，TDSF 是桌面终端 IDE + AI agent。1Panel 的"原生 AI agent 支持"是通过 Ollama + OpenClaw agents 实现的运维面板 AI 化，与 TDSF 的"Python sidecar agent + SSH 运维教学"定位不同。不作为选型候选，但其 AI 运维面板设计是参考。

---

## 5. 七维度对比矩阵

### 5.1 核心维度对比

| 项目 | 本地 Python 集成 | 工具调用 | 流式响应 | 自定义工具 | 包大小/依赖 | 文档/社区/活跃度 | needs_you PAOR 兼容 |
|------|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Strands Agents** | ✅ 原生 Python SDK | ✅ `@tool` 装饰器 | ✅ `stream_async` | ✅ docstring 自动生成 | 中（strands + tools + litellm） | ✅ AWS 官方 + 周发版 + 6.7k stars | ✅ 完全覆盖 PAOR |
| **OpenAI Agents SDK** | ✅ Python SDK | ✅ `@tool` + function tools | ✅ token + 中间步骤 | ✅ | 轻（无冗余依赖） | ✅ 27.9k stars + 0.17.x | ⚠️ Sessions 偏 OpenAI 服务端 |
| **Claude Agent SDK** | ⚠️ Python 包捆绑 CLI 二进制 | ✅ 内置 + MCP | ✅ async iterator | ✅ | 重（CLI 二进制） | ✅ Anthropic 官方 | ❌ 计费绑定 Anthropic |
| **LangGraph** | ✅ Python | ✅ LangChain tools | ✅ token + 步骤 | ✅ | 重（5 包） | ✅ 31.2k stars + 1.2.8 | ⚠️ 低级编排，需手写 PAOR |
| **AutoGen / MAF** | ⚠️ AutoGen 维护模式 | ✅ FunctionTool | ✅ | ✅ | 重 | ⚠️ AutoGen 废弃，MAF 偏 Azure | ❌ 不推荐 |
| **CrewAI** | ✅ Python | ✅ | ✅ | ✅ | 中 | ✅ 56.1k stars | ⚠️ 角色驱动 ≠ 工具驱动 |
| **PydanticAI** | ✅ Python 原生 | ✅ `@agent.tool` + MCP | ✅ 流式结构化 | ✅ Pydantic 校验 | 轻（slim 按需 extras） | ✅ 18.67k stars + 2.13.0 | ✅ 类型安全 + 工具审批对齐 |
| **HolmesGPT** | ❌ 独立产品 | ✅ 50+ toolsets | ✅ SSE | ✅ YAML 声明 | 重（K8s 工具集） | ✅ CNCF Sandbox | ❌ 不可改造 |
| **OpenHands** | ❌ 独立平台 | ✅ CodeAct | ✅ | ✅ | 重（Docker 沙箱） | ✅ 75k stars | ❌ 编码场景 |
| **Goose** | ❌ Rust 产品 | ✅ 70+ MCP | ✅ | ✅ MCP server | N/A（非 Python） | ✅ 48.5k stars + AAIF | ❌ 非 SDK |
| **Spug** | ❌ 运维平台 | ❌ 无 AI | N/A | N/A | N/A | ⚠️ 非 AI | ❌ 无 agent |
| **1Panel** | ❌ Go 面板 | ⚠️ Ollama + OpenClaw | N/A | N/A | N/A | ✅ 3.2 万 stars | ❌ 非 agent 框架 |

### 5.2 运维场景适配度对比

| 项目 | 运维场景适配 | SSH 命令执行 | 文件读取 | 日志分析 | 教学引导 | 生产验证 |
|------|:---:|:---:|:---:|:---:|:---:|:---:|
| **Strands Agents** | ⚠️ 通用框架，需自建工具 | ✅ 自建 @tool | ✅ 自建 @tool | ✅ 自建 @tool | ✅ system_prompt | ✅ AWS 内部多产品 |
| **PydanticAI** | ⚠️ 通用框架，需自建工具 | ✅ 自建 @agent.tool | ✅ 自建 @agent.tool | ✅ 自建 @agent.tool | ✅ instructions | ⚠️ Pydantic Logfire 内部 |
| **HolmesGPT** | ✅ 60+ 运维工具集 | ❌ K8s 场景 | ❌ K8s 场景 | ✅ Loki/Grafana | ❌ 非教学 | ✅ Robusta 商业 |
| **Goose** | ⚠️ 通用 | ✅ MCP 扩展 | ✅ MCP 扩展 | ⚠️ 需扩展 | ⚠️ 通用 | ✅ Block |
| **LangGraph** | ⚠️ 通用，需手写 | ✅ 自建 | ✅ 自建 | ✅ 自建 | ✅ | ✅ Uber/LinkedIn/Klarna |

---

## 6. 与 TDSF 现有架构兼容性分析

### 6.1 LLMCallFunction 签名兼容性

TDSF `agents/base.py` 定义的 `LLMCallFunction` Protocol 签名 `(messages: list[dict]) -> str`（OpenAI Chat Completions 兼容）。

| 项目 | 兼容方式 |
|------|----------|
| Strands | 不复用 `LLMCallFunction`，直接用 Strands `Model` 对象传入 `Agent(model=...)`；LangGraph fallback 时仍用旧 `llm_call` |
| PydanticAI | `Agent('provider:model-name')` 字符串声明模型，不复用 `LLMCallFunction`；但 `deps_type` 可注入 `llm_call` 用于 fallback |
| LangGraph | 现有后端，保持 `langchain_openai.ChatOpenAI` / `langchain_anthropic.ChatAnthropic` |

### 6.2 工具层映射

TDSF `tools/__init__.py` 的 `TOOL_REGISTRY` 9 个工具，每个有 `invoke_*_tool(params) -> dict` + `get_tool_metadata() -> dict`（含 input_schema / output_schema）。

| 项目 | 工具映射方式 |
|------|-------------|
| Strands | `@tool` 装饰器包装 `invoke_*_tool`，从 `get_tool_metadata` 的 input_schema 生成签名；或用 `MCPClient` 把整个 `tools/` 暴露为 MCP server |
| PydanticAI | `@agent.tool` 装饰器，Pydantic 模型校验入参（比 Strands 更严格）；或用 `MCPToolset` 暴露为 MCP server |
| LangGraph | 现有 `langchain_core.tools.Tool` 包装（保持现状） |

### 6.3 事件总线（event_bus）映射

TDSF `event_bus.py` 已注册事件类型：`mood_change` / `tool_call` / `agent_message` / `agent_switch` / `terminal_request` 等。前端 `sidecar-adapter.ts:211-276` 监听 `sidecar:mood_change` / `sidecar:tool_call` / `sidecar:agent_switch`（未监听 `sidecar:agent_message`，v2.0 方案已指出需补齐）。

| 项目 | 事件映射 |
|------|----------|
| Strands | `callback_handler` 接收 `**kwargs` 事件 → 转发到 event_bus（`start`→mood=thinking，`complete`→mood=done，`data`→agent_message，`current_tool_use`→tool_call） |
| PydanticAI | `agent.run_stream()` 返回 async iterator，逐事件转发到 event_bus；Hooks API 在工具调用前后触发回调 |

### 6.4 needs_you PAOR 协作

TDSF `needs_you.py` 实现 needs-you 请求机制：高风险工具返回 needs-you 请求 → event_bus 推送审批事件 → 前端渲染审批卡片 → 用户批准后继续。

| 项目 | needs_you 协作 |
|------|---------------|
| Strands | agentic loop 完整覆盖 PAOR；高风险工具在 `@tool` 函数内返回 needs-you 请求，Strands 模型将其作为 tool_result 继续推理或终止 |
| PydanticAI | **原生 Human-in-the-loop 工具审批**（基于参数/历史/偏好条件审批），与 needs_you 语义一致，可直接复用 |
| LangGraph | 现有 PAOR 7 节点 + needs_you，保持现状 |

### 6.5 JSON-RPC 协议

TDSF Rust → Python 是 request（有 id，等响应）；Python → Rust 只能 notification（无 id）。`agent.invoke` / `agent.list` / `agent.info` / `agent.configure` 四个方法签名不变。

| 项目 | 协议影响 |
|------|----------|
| Strands / PydanticAI / LangGraph | 0 改动（`agent.invoke` 返回值结构一致：`observation` / `mood` / `tokens`） |
| 双向 JSON-RPC 扩展（P2） | 让 Python agent 主动调 Rust SSH/SFTP，所有后端共用 |

---

## 7. 推荐方案

### 7.1 首选：Strands Agents（确认 v2.0 判断）

**理由**（与 v2.0 方案一致，新增 2026-07 数据支撑）：

1. **生产验证持续强化**：2026-02 推出 Strands Labs 实验性组织，Amazon Q Developer / Glue / VPC Reachability Analyzer 持续生产使用；
2. **发版频率极高**：1.0（2025-07-31）→ 1.48.0（2026-07-17），近一年 48 个版本，社区活跃度顶级；
3. **模型驱动 agentic loop**：替代 LangGraph 7 节点 PAOR，消除 LangChain 5 包重依赖；
4. **`@tool` 装饰器**与 TDSF 现有 `tools/*.py` 的 `invoke_*_tool(params)` 范式高度对齐，迁移成本低；
5. **MCPClient 原生支持**：可让 TDSF 现有 9 个 MCP tools 直接暴露给 Strands agent；
6. **Apache 2.0** 与上游 terax-ai 兼容，无 License 阻碍；
7. **`stream_async`** 替代当前 dict 切片模拟流式，真正流式输出；
8. **多 Agent 模式**（Agents-as-Tools / Handoffs / Swarm / Graph）替代 MainAgent 关键词路由。

### 7.2 备选：PydanticAI（轻量级替代）

**触发条件**（任一满足即切换备选）：

1. Strands 依赖 `litellm` 与 TDSF 现有 `pydantic` / `chromadb` 版本冲突，虚拟环境隔离仍无法解决；
2. 需要更强类型安全（`Agent[DepsType, OutputType]` 泛型约束）；
3. 需要原生 Human-in-the-loop 工具审批（与 `needs_you` 语义完全一致，无需自建）；
4. 需要更轻的包体积（`pydantic-ai-slim` 按需 extras）；
5. 已深度使用 Pydantic Logfire 可观测性。

**优势**：
- Pydantic 团队原厂，与 TDSF 现有 pydantic 依赖同源无冲突；
- 208M+ 月下载，18.67k stars，社区活跃；
- 类型安全把整类错误从运行时移到编写时；
- 原生 MCPToolset 双向 + A2A 协议 + Durable Execution + 流式结构化输出。

**劣势**：
- 生产验证不如 Strands（主要 Pydantic Logfire 内部）；
- `@agent.tool` 绑定具体 agent 实例，与 TDSF 全局 `TOOL_REGISTRY` 范式略有差异；
- 2.x 稳定但生态较新。

### 7.3 不推荐及原因

| 项目 | 不推荐原因 |
|------|-----------|
| OpenAI Agents SDK | 0.17.x 仍是 0.x 版本；偏 OpenAI 模型优化；Sessions 偏 OpenAI 服务端 |
| Claude Agent SDK | 计费绑定 Anthropic（2026-06-15 独立计费）；Python 包捆绑 CLI 二进制体积大；工具集不对齐 |
| LangGraph | 低级编排 = 更多样板代码；LangChain 5 包重依赖；与"模型驱动简化"目标相反（仅作为 fallback 后端保留） |
| AutoGen / MAF | AutoGen 已废弃；MAF 偏 Azure 生态，TDSF 是本地桌面端 |
| CrewAI | 角色驱动 ≠ 工具驱动；671 open issues 稳定性问题；开核模式企业功能付费 |
| HolmesGPT | 独立产品非 SDK；工具集面向 K8s 不复用（仅作设计参考） |
| OpenHands | 编码场景非运维；依赖重（Docker 沙箱）（仅作架构参考） |
| Goose | Rust 产品非 Python SDK；直接集成替换整个 AI 层（仅作架构对标） |
| Spug | 无 AI agent（纯运维平台） |
| 1Panel | Go 面板非 agent 框架（仅作 AI 运维面板参考） |

---

## 8. 集成方式与 needs_you PAOR 协作模式

### 8.1 集成方式：sub-package 适配层（三后端 Feature Flag）

维持 v2.0 方案的 `strands_backend/` sub-package，新增 `pydanticai_backend/` 对称结构：

```
src-tauri/sidecar/
├── agents/                    # 现有，保持不动
│   ├── __init__.py            # 加 set_backend 注入点
│   ├── base.py                # PAOR 模板，保持不动
│   └── main_agent.py          # 保持不动
├── tools/                     # 现有 9 个 MCP tools，保持不动
├── strands_backend/           # 新增：Strands 适配层
│   ├── __init__.py
│   ├── agent_factory.py
│   ├── model_adapter.py
│   ├── tool_adapter.py
│   ├── callback_handler.py
│   ├── multi_agent.py
│   ├── context.py
│   ├── risk_hook.py
│   └── tools/
│       ├── ops_ssh_command.py
│       ├── ops_read_remote_file.py
│       ├── ops_analyze_logs.py
│       ├── ops_query_processes.py
│       └── ops_network_diagnose.py
├── pydanticai_backend/        # 新增：PydanticAI 备选适配层（结构与 strands_backend 对称）
│   ├── __init__.py
│   ├── agent_factory.py
│   ├── model_adapter.py
│   ├── tool_adapter.py
│   ├── callback_handler.py
│   ├── context.py
│   └── tools/                 # 复用 strands_backend/tools/ 的运维工具骨架
└── main.py                    # 修改 L332-358 加 Feature Flag
```

### 8.2 Feature Flag 三后端切换

`main.py:332-358` 改造（伪代码，不修改源码仅示意）：

```python
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

### 8.3 needs_you PAOR 协作模式（保留不替换）

| PAOR 阶段 | TDSF 现有（LangGraph） | Strands 后端 | PydanticAI 后端 | needs_you 协作 |
|-----------|------------------------|---------------|------------------|----------------|
| **P**lan | `plan_task` 节点 | 首次推理隐式规划（system_prompt 引导） | 首次推理隐式规划（instructions 引导） | 不涉及 |
| **A**ct | `select_tool` + `call_tool` 节点 | 模型决定调 `@tool`，Strands 执行 | 模型决定调 `@agent.tool`，PydanticAI 执行（含审批） | 高风险工具返回 needs-you 请求 |
| **O**bserve | `format_observation` 节点 | tool_result 自动注入上下文 | tool_result 自动注入上下文（Pydantic 校验） | needs-you 结果作为 tool_result |
| **R**eflect | `reflect_on_result` 节点 | 再次推理（agentic loop 迭代） | 再次推理（run_stream 迭代） | 用户批准后继续 loop |

**关键**：`needs_you` 作为 human-in-the-loop 审批层保留，**不替换**。Strands/PydanticAI 的 agentic loop 在遇到 needs-you 请求时，将其作为 tool_result 返回给模型，模型决定等待批准或终止。PydanticAI 的原生工具审批系统可与 `needs_you` 深度集成（`needs_you` 作为审批策略之一）。

### 8.4 工具映射（5 核心运维工具）

| 运维需求 | 工具名 | Strands 实现 | PydanticAI 实现 | needs_you 集成 |
|----------|--------|--------------|------------------|----------------|
| SSH 命令执行 | `ssh_command` | `@tool` + 风险评估 pre-hook | `@agent.tool` + 原生审批 | 高风险触发 needs-you |
| 远程文件读取 | `read_remote_file` | `@tool` + SFTP bridge | `@agent.tool` + SFTP bridge | 低风险，直接执行 |
| 日志分析 | `analyze_logs` | `@tool` + tail/grep/模式匹配 | `@agent.tool` + 同 | 低风险，直接执行 |
| 进程查询 | `query_processes` | `@tool` + ps/pgrep | `@agent.tool` + 同 | 低风险，直接执行 |
| 网络诊断 | `network_diagnose` | `@tool` + ping/ss/netstat | `@agent.tool` + 同 | 中风险（ping 非破坏，ss 可暴露信息） |
| 教学引导 | system_prompt 注入 | `inject_context_to_prompt` | `instructions` + 动态 deps | 不涉及 |

---

## 9. 5 个核心运维工具代码示例

> 以下为 Strands `@tool` 实现骨架（PydanticAI 仅装饰器与校验不同，结构对称）。完整实现见配套文档 `ops-agent-tool-examples.md`（v2.0 方案已规划）。
> **注意**：本节仅为代码骨架示例，不修改任何源码文件。实际集成时写入 `src-tauri/sidecar/strands_backend/tools/ops_*.py`。

### 9.1 ops_ssh_command.py（SSH 命令建议 + 风险评估）

```python
"""SSH 命令建议工具 — 建议命令模式 + 风险评估 + needs-you 审批

工具不直接执行命令，而是返回"建议命令"给前端，前端渲染 Execute 按钮由用户审批执行。
高风险命令（rm -rf / reboot / dd 等）触发 needs-you 请求。
"""
from __future__ import annotations

import logging
from typing import Any

from strands import tool

logger = logging.getLogger("sidecar.strands_backend.tools.ops_ssh_command")


@tool
def ssh_command(command: str, explanation: str = "") -> dict:
    """Propose an SSH command for the user to approve and execute.

    The command is NOT executed automatically. It is rendered as a card
    in chat with an 'Execute' button. Use this when the answer IS a command
    to run on the connected SSH server.

    Args:
        command (str): The shell command. Single line, no trailing newline.
        explanation (str): Optional one-line note shown beside the command.

    Returns:
        dict: {status, command, explanation, risk_level, require_approval}
    """
    # 风险评估（复用现有 tools/risk.py）
    from tools.risk import invoke_risk_tool
    risk = invoke_risk_tool({"command": command})

    # 高风险：返回 needs-you 请求（不执行）
    if risk.get("require_approval"):
        return {
            "status": "needs_approval",
            "command": command,
            "explanation": explanation,
            "risk": risk,
            "message": f"高风险命令需用户审批：{risk.get('reason', '')}",
        }

    # 低风险：返回建议命令（前端渲染 Execute 按钮）
    return {
        "status": "suggested",
        "command": command,
        "explanation": explanation,
        "risk_level": risk.get("level", "L0"),
    }
```

### 9.2 ops_read_remote_file.py（远程文件读取 via SFTP bridge）

```python
"""远程文件读取工具 — 通过 SFTP bridge 读取远程文件内容

TDSF 现有 src/lib/sftp-bridge.ts 提供 sftpList/sftpRead/sftpWrite。
Python agent 通过 event_bus 推送 read_request，Rust 侧执行 SFTP 后回传内容
（需 P2 双向 JSON-RPC 扩展）。

P0 阶段降级：返回"建议命令"（cat/head/tail）让前端执行。
"""
from __future__ import annotations

import logging
from typing import Any

from strands import tool

logger = logging.getLogger("sidecar.strands_backend.tools.ops_read_remote_file")


@tool
def read_remote_file(path: str, max_lines: int = 200) -> dict:
    """Read a remote file's content via SFTP.

    Args:
        path (str): Absolute path on the remote SSH server.
        max_lines (int): Max lines to read (default 200, prevent token explosion).

    Returns:
        dict: {status, path, content, truncated} or {status: "suggested", command}
    """
    # P0 降级：返回建议命令（前端 Execute 按钮执行）
    # P2 完整：通过 event_bus + 双向 JSON-RPC 直接 SFTP 读取
    return {
        "status": "suggested",
        "command": f"head -n {max_lines} {path}",
        "explanation": f"读取远程文件 {path} 前 {max_lines} 行",
        "path": path,
        "max_lines": max_lines,
    }
```

### 9.3 ops_analyze_logs.py（日志分析：tail + grep + 模式匹配）

```python
"""日志分析工具 — tail + grep + 错误模式匹配

返回建议命令让前端执行，或 P2 阶段直接拉取日志内容分析。
内置常见错误模式（OOM / segfault / connection refused / timeout / disk full）。
"""
from __future__ import annotations

import logging
from typing import Any

from strands import tool

logger = logging.getLogger("sidecar.strands_backend.tools.ops_analyze_logs")

# 常见错误模式（启发式预筛）
ERROR_PATTERNS = [
    "oom", "out of memory", "segfault", "panic",
    "connection refused", "timeout", "timed out",
    "disk full", "no space left", "permission denied",
    "failed", "error", "exception", "traceback",
]


@tool
def analyze_logs(log_path: str, lines: int = 100, pattern: str = "") -> dict:
    """Analyze a remote log file for errors and patterns.

    Args:
        log_path (str): Absolute path to the log file on remote server.
        lines (int): Number of recent lines to analyze (default 100).
        pattern (str): Optional grep pattern to filter (default: auto-detect errors).

    Returns:
        dict: {status, command, explanation, patterns_detected}
    """
    grep_pattern = pattern if pattern else "|".join(ERROR_PATTERNS)
    command = f"tail -n {lines} {log_path} | grep -iE '{grep_pattern}'"

    return {
        "status": "suggested",
        "command": command,
        "explanation": f"分析 {log_path} 最近 {lines} 行中的错误模式",
        "log_path": log_path,
        "lines": lines,
        "patterns_detected": ERROR_PATTERNS if not pattern else [pattern],
    }
```

### 9.4 ops_query_processes.py（进程查询：ps / pgrep）

```python
"""进程查询工具 — ps / pgrep / top 查询进程状态

低风险只读命令，直接返回建议命令。
"""
from __future__ import annotations

import logging
from typing import Any

from strands import tool

logger = logging.getLogger("sidecar.strands_backend.tools.ops_query_processes")


@tool
def query_processes(filter_name: str = "", show_all: bool = False) -> dict:
    """Query running processes on the remote server.

    Args:
        filter_name (str): Optional process name filter (e.g. "nginx", "python").
        show_all (bool): If True, show all processes (ps aux); else top 20 by CPU.

    Returns:
        dict: {status, command, explanation}
    """
    if filter_name:
        command = f"pgrep -af {filter_name}"
        explanation = f"查询名称含 {filter_name} 的进程"
    elif show_all:
        command = "ps aux"
        explanation = "查询所有进程"
    else:
        command = "ps aux --sort=-%cpu | head -n 20"
        explanation = "查询 CPU 占用前 20 的进程"

    return {
        "status": "suggested",
        "command": command,
        "explanation": explanation,
    }
```

### 9.5 ops_network_diagnose.py（网络诊断：ping / ss / netstat / ip）

```python
"""网络诊断工具 — ping / ss / netstat / ip / traceroute

中风险（ss 可暴露监听端口信息），返回建议命令。
"""
from __future__ import annotations

import logging
from typing import Any

from strands import tool

logger = logging.getLogger("sidecar.strands_backend.tools.ops_network_diagnose")


@tool
def network_diagnose(action: str, target: str = "") -> dict:
    """Diagnose network issues on the remote server.

    Args:
        action (str): Diagnosis action. One of:
            - "ping": ping a host (requires target)
            - "ports": show listening ports (ss -tlnp)
            - "connections": show active connections (ss -tan)
            - "routes": show routing table (ip route)
            - "interfaces": show network interfaces (ip addr)
            - "traceroute": trace route to target (requires target)
        target (str): Target host for ping/traceroute.

    Returns:
        dict: {status, command, explanation, risk_level}
    """
    commands = {
        "ping": (f"ping -c 4 {target}", f"ping {target} 4 次", "L1"),
        "ports": ("ss -tlnp", "查看监听端口", "L2"),
        "connections": ("ss -tan", "查看活跃连接", "L1"),
        "routes": ("ip route", "查看路由表", "L1"),
        "interfaces": ("ip addr", "查看网络接口", "L1"),
        "traceroute": (f"traceroute {target}", f"追踪到 {target} 的路由", "L2"),
    }

    if action not in commands:
        return {
            "status": "error",
            "error": f"unknown action: {action}",
            "valid_actions": list(commands.keys()),
        }

    command, explanation, risk_level = commands[action]

    return {
        "status": "suggested",
        "command": command,
        "explanation": explanation,
        "risk_level": risk_level,
    }
```

---

## 10. 风险评估与缓解

| 风险 | 概率 | 影响 | 缓解措施 |
|------|:---:|:---:|----------|
| Strands 1.48 API 变更（向后不兼容） | 低（已 1.x 稳定） | 高（适配层需重写） | Feature Flag 回滚 + 适配层隔离 + 锁定版本 `strands-agents>=1.48,<2.0` |
| Strands 依赖 `litellm` 与现有 pydantic/chromadb 冲突 | 中 | 中 | 虚拟环境隔离 + `pip install` 测试 + 切换 PydanticAI 备选 |
| PydanticAI `@agent.tool` 绑定 agent 实例与全局 TOOL_REGISTRY 不匹配 | 中 | 低 | 适配层 `tool_adapter.py` 动态绑定 + 工厂模式创建 agent |
| Strands 模型不支持 OpenAI 兼容端点（DeepSeek/OneAPI） | 低 | 高（国内用户受影响） | 已确认 `OpenAIModel(base_url=...)` 支持 |
| 双向 JSON-RPC 扩展引入竞态（P2 阶段） | 中 | 高 | 请求-响应匹配 + 超时机制 + 单元测试 |
| 终端上下文注入导致 prompt 过长 | 低 | 低（system prompt 4 行） | 控制注入内容长度，仅关键信息（cwd/activeFile/sshSessionId） |
| 事件监听器泄漏（agent_message） | 中 | 中 | finally 块 unlisten + 单测验证 |
| PydanticAI Monty 沙箱未生产级（仍 hardening） | 低 | 低（TDSF 不用 Monty） | TDSF 不启用 CodeMode/Monty，仅用核心 agent + MCP |
| needs_you 与 PydanticAI 原生审批重复 | 低 | 低 | PydanticAI 后端将 needs_you 作为审批策略之一，不重复 |

---

## 11. 实施路线图

### 11.1 P0（一天，1 人日）：Strands 适配层 + Feature Flag

**目标**：Strands 后端可激活，`agent.invoke` 走 Strands agentic loop，前端零改动。

**任务**：
1. 新建 `strands_backend/` 目录结构（8 文件，约 1200 行）；
2. 实现 `model_adapter.py`（OpenAIModel / AnthropicModel / OllamaModel / LiteLLMModel）；
3. 实现 `tool_adapter.py`（包装现有 9 个 tools 为 Strands `@tool`）；
4. 实现 `callback_handler.py`（Strands 事件 → event_bus）；
5. 实现 `agent_factory.py`（构建单 Agent，暂不多 Agent）；
6. 实现 `context.py`（方案 A：system prompt 注入终端上下文）；
7. 修改 `main.py:332-358` 加 Feature Flag（不破坏现有）；
8. 修改 `agents/__init__.py` 加 `set_backend` 注入点；
9. 修改 `requirements.txt` 加 `strands-agents>=1.48.0` 依赖；
10. 单测：mock Strands Agent 验证 `invoke_strands_agent` 返回值结构；
11. 实测：`TDSF_AGENT_BACKEND=strands pnpm tauri:dev` 验证 agent.invoke 工作。

**验收**：
- `agent.invoke` 返回 `{observation, mood, tokens}`（与 LangGraph 后端一致）；
- 前端 `sidecar-adapter.ts` 切片流式正常；
- `ping` / `shutdown` / `status` 不受影响；
- Feature Flag 切换回 LangGraph 正常。

### 11.2 P1（一天，1 人日）：终端上下文 + 5 运维工具 + PydanticAI 备选

**目标**：满足用户硬约束"AI 能看到当前终端环境" + PydanticAI 备选后端可用。

**任务**：
1. 实现 5 个运维工具（见 §9 代码骨架）；
2. 修改 `transport.ts:122-145` 把 `live` 传给 `runSidecarStream`；
3. 修改 `sidecar-adapter.ts:337-343` 在 `state` 中追加 `live` 字段；
4. 修改 `sidecar-adapter.ts:211-276` 补齐 `sidecar:agent_message` 监听；
5. 实现方案 A 的前端改动 + Python 端 `context.py`；
6. 新建 `pydanticai_backend/` 对称结构（复用 `strands_backend/tools/` 运维工具骨架）；
7. 实测：用户输入"当前目录有什么文件"，agent 能基于 `live.cwd` 回答；
8. 实测：`TDSF_AGENT_BACKEND=pydanticai` 切换备选后端工作。

**验收**：
- agent 能在 system prompt 中看到 `cwd` / `activeFile` / `sshSessionId`；
- `ssh_command` 工具返回建议命令 + 风险评估；
- `sidecar:agent_message` 事件实时推送文本增量；
- PydanticAI 备选后端激活 + agent.invoke 工作。

### 11.3 P2（半天，0.5 人日）：双向 JSON-RPC + 多 Agent

**目标**：Python agent 能直接调 Rust SSH/SFTP，agentic loop 完整闭环。

**任务**：
1. 扩展 JSON-RPC 协议支持 Python → Rust 请求（带 id + 等待响应）；
2. Rust 侧增加 `ssh.exec_in_session` / `sftp.read_file` / `sftp.write_file` 等 JSON-RPC handler；
3. Python 侧 `send_request(method, params)` 函数 + 请求-响应匹配 + 超时；
4. 实现 `multi_agent.py`（Strands Agents-as-Tools 模式）；
5. 实测：agent 调 `ssh_command` 工具直接执行命令并拿结果继续推理。

**验收**：
- agent 调 `ssh_command("ls -la")` 直接拿到远程目录列表；
- 高风险命令触发 needs-you 请求；
- 多 Agent 路由正常（main → coding/teach/debug/...）。

---

## 12. 结论与下一步

### 12.1 结论

1. **Strands Agents 仍是首选**（v2.0 方案判断成立）：1.48.0（2026-07-17），6.7k stars，Apache 2.0，AWS 生产验证，周发版，`@tool` + MCPClient + `stream_async` 与 TDSF 现有架构高度对齐。
2. **PydanticAI 是更优的备选**（v2.0 方案未覆盖）：v2.13.0（2026-07-18），18.67k stars，MIT，Pydantic 团队原厂，类型安全 + 原生 MCPToolset + 原生 Human-in-the-loop 工具审批（与 needs_you 语义一致）+ Durable Execution。当 Strands 依赖冲突时切换。
3. **AutoGen 已废弃**（2025-10 进入维护模式，MAF 1.0 GA 2026-04-03），勿选。
4. **Goose 是架构对标**（同 Rust + Tauri 栈，AAIF 托管，48.5k stars），不作为集成对象。
5. **HolmesGPT 是运维工具设计参考**（CNCF Sandbox，50+ toolsets），不直接复用工具集。
6. **needs_you PAOR 模式保留**：Strands/PydanticAI 的 agentic loop 完整覆盖 PAOR 语义，needs_you 作为 human-in-the-loop 审批层不替换。PydanticAI 的原生工具审批可与 needs_you 深度集成。
7. **改造范围可控**：维持 v2.0 方案的 `strands_backend/` sub-package + Feature Flag，新增 `pydanticai_backend/` 对称结构，三后端并行（`strands|pydanticai|langgraph`），2.5 人日完成。

### 12.2 下一步

1. **P0 实施**（立即）：按 §11.1 创建 `strands_backend/` 适配层 + Feature Flag，五绿门禁全过；
2. **依赖冲突预测试**（P0 前置）：在 sidecar 虚拟环境 `pip install strands-agents>=1.48.0 strands-agents-tools>=1.0.0 litellm`，验证与现有 pydantic/chromadb 无冲突；若冲突，直接启用 PydanticAI 备选；
3. **PydanticAI 备选验证**（P1）：同步实现 `pydanticai_backend/`，确保 Feature Flag 三后端可切换；
4. **终端上下文感知**（P1）：补齐 `transport.ts` 不传 `live` 的缺口（用户硬约束"AI 能看到当前终端环境"）；
5. **双向 JSON-RPC**（P2）：让 Python agent 能直接调 Rust SSH/SFTP，agentic loop 完整闭环；
6. **配套文档更新**：P0 完成后更新 `docs/dev-state.md` 记录 Strands/PydanticAI 后端激活状态与已知问题。

---

## 附录 A：调研数据时间戳汇总

| 项目 | 数据来源 | 抓取时间 | 关键时间戳 |
|------|----------|----------|-----------|
| Strands Agents | PyPI + WebFetch GitHub | 2026-07-30 | PyPI 1.48.0 = 2026-07-17；GitHub 最新 commit = 2026-04-10（WebFetch 缓存，实际应更新） |
| OpenAI Agents SDK | WebFetch GitHub + SourceForge | 2026-07-30 | v0.17.7 = 2026-06-24；GitHub 最新 commit = 2026-07-04 |
| Claude Agent SDK | npm + totalum.app + Novita | 2026-07-30 | TS v0.3.156 = 2026-07-30 前 10 小时；改名 = 2025-09；独立计费 = 2026-06-15 |
| LangGraph | releases.sh + chatforest | 2026-07-30 | v1.2.8 = 2026-07-06；1.0 GA = 2025-10-22 |
| AutoGen / MAF | dev.to + dreaming.press | 2026-07-30 | AutoGen 维护模式 = 2025-10；MAF 1.0 GA = 2026-04-03 |
| CrewAI | gittimes + automationatlas | 2026-07-30 | v1.15.6 = 2026-07-26；56.1k stars = 2026-07 |
| PydanticAI | PyPI + chatforest + CSDN | 2026-07-30 | v2.13.0 = 2026-07-18；18.67k stars = 2026-07 |
| HolmesGPT | WebFetch GitHub + CNCF 博客 | 2026-07-30 | 最新 commit = 2026-05-15；CNCF Sandbox = 2025-10 |
| OpenHands | yeyulingfeng + theagenttimes | 2026-07-30 | v1.7.0 = 2026-05-01；75k stars = 2026-06 |
| Goose | WebFetch GitHub + smzdm | 2026-07-30 | 最新 commit = 2026-07-27；AAIF 接管 = 2026-06-11；48.5k stars = 2026-06 |
| Spug | gitcode + Gitee | 2026-07-30 | 无 AI agent（纯运维平台） |
| 1Panel | gitcode + CSDN RSS | 2026-07-30 | 3.2 万 stars = 2026-07 |

---

## 附录 B：与 v2.0 方案文档的对照表

| v2.0 方案章节 | 本调研对应章节 | 差异 |
|---------------|----------------|------|
| §1 执行摘要 | §1 执行摘要 | 新增 PydanticAI 备选 + AutoGen 废弃声明 |
| §2 开源生态补充调研（9 项目） | §4（11 项目深度评估） | 新增 PydanticAI、Microsoft Agent Framework |
| §3 当前架构分析 | §3 TDSF 现有架构回顾 | 精简（详见 v2.0） |
| §4 Strands 集成方案 | §8 集成方式 + §9 工具示例 | 新增 PydanticAI 对称结构 + 内嵌 5 工具骨架 |
| §5 前端调用链路 | §11.2 P1 任务 | 维持 |
| §6 终端上下文感知方案 | §11.2 P1 任务 | 维持 |
| §7 改造规模与风险评估 | §10 风险评估 | 新增 PydanticAI 相关风险 |
| §8 实施路线图 | §11 实施路线图 | 新增 P1 PydanticAI 备选验证 |
| §9 与 v1.0 差异 | §1.2 与 v2.0 差异 | 本文件相对 v2.0 的增量 |
| §10 配套文档 | §12.2 下一步 | 维持 |

---

> **最后更新**：2026-07-30 · v1.0
> **上游参考**：[crynta/terax-ai](https://github.com/crynta/terax-ai) v0.8.6（TDSF 唯一基线）
> **任务边界**：本文件仅为调研/方案文档，不修改任何 `src/` 或 `src-tauri/` 下的源码文件。
> **配套文档**：
> - `docs/reports/ops-agent-strands-integration-plan.md`（v2.0 深化版，本文件复核其选型）
> - `docs/reports/ops-agent-tool-examples.md`（5 运维工具完整实现，待创建）
> - `docs/reports/ops-agent-opensource-research.md`（基础调研）
> - `docs/reports/ops-agent-deep-research.md`（轻量 agent 框架深度调研）
> - `docs/reports/modded-agent-deep-audit.md`（魔改版 AI Agent 深度可用性审查）
