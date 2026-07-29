# TDSF Terminal Agent — Strands Agents 集成方案（深化版 v2.0）

> **位置**：`docs/reports/ops-agent-strands-integration-plan.md`
> **版本**：v2.0（2026-07-30 深化版，覆盖 v1.0）
> **作用**：在 v1.0 框架性结论之上，给出可落地的 sub-package 目录结构、main.py 集成接入点、前端调用链路、终端上下文感知方案，以及与 2025-2026 主流运维/DevOps agent 开源生态的对比选型。
> **任务边界**：本文件仅为方案文档，不修改任何代码文件。所有源文件引用以 `file:///` 绝对路径给出。
> **上游参考**：
> - Strands Agents 官方文档：<https://strandsagents.com/latest/user-guide/>
> - Strands Agents SDK 源码：<https://github.com/strands-agents/sdk-python>（Apache 2.0）
> - Strands 官方工具集：<https://github.com/strands-agents/tools-python>
> - HolmesGPT（CNCF Sandbox SRE Agent）：<https://github.com/robusta-dev/holmesgpt>
> - Linux Foundation AAIF（MCP/goose/AGENTS.md）公告：<https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation>

---

## 1. 执行摘要

### 1.1 与 v1.0 的关键差异

| 维度 | v1.0（框架性结论） | v2.0（深化版，本文） |
|------|--------------------|----------------------|
| 调研基准 | 仅 Strands 预览版 + 5 个开源项目 | Strands 1.0（2025-07-31 发布）+ 9 个 2025-2026 主流项目实测数据 |
| 目录结构 | 仅描述"8 个新增文件" | 给出完整 `strands_backend/` sub-package 树 + 每个文件职责 + 行数预估 |
| main.py 集成点 | 概念性描述 | 给出 `register_business_methods` 内的确切插入位置 + feature flag 代码示例 |
| 前端调用链路 | "前端零改动" | 指出 `transport.ts` 不传 `live.cwd` / 终端缓冲的缺口 + 3 套终端上下文感知方案 |
| 工具示例 | 无 | 见配套文档 `ops-agent-tool-examples.md`（5 个运维工具完整实现） |
| 协议演进 | "JSON-RPC 协议不变" | 指出 Python → Rust 反向调用的架构缺口 + 双向 JSON-RPC 扩展方案 |
| 风险评估 | "保留 RiskEngine" | 给出 Strands 工具与 RiskEngine 的集成范式（pre-tool hook） |

### 1.2 核心结论（深化后保持）

1. **Strands Agents 1.0 是 TDSF 的最佳选型**：Apache 2.0、AWS 生产验证（Kiro/Amazon Q/Glue）、模型驱动 agentic loop、原生 MCP 集成、`@tool` 装饰器与 TDSF 现有 `tools/*.py` 范式高度对齐。
2. **改造范围可控**：新增 `src-tauri/sidecar/strands_backend/` 适配层（约 8 个文件、1200 行），改造 `agents/__init__.py` 的 `configure_agents` 注入点与 `core/llm_config.py` 的 LLM 客户端，其余模块（`event_bus.py` / `tools/risk.py` / `needs_you` / `fix_loop` / `knowledge` / `skills` / `permissions` / `tdsf_loader`）保持原样。
3. **协议兼容**：`agent.invoke` JSON-RPC 方法签名不变，返回值仍含 `observation` / `mood` / `tokens`，前端 `sidecar-adapter.ts` 切片流式逻辑零改动。
4. **Feature Flag 灰度**：`TDSF_AGENT_BACKEND=langgraph|strands` 环境变量控制后端切换，两套后端可并行存在，出问题即时回滚。
5. **终端上下文感知是必须补的缺口**（用户硬约束"AI 能看到当前终端环境"）：当前 `transport.ts:122-145` 只传 `input` + `messages`，不传 `live.cwd` / `activeFile` / 终端缓冲；本文给出 3 套方案与推荐组合。

### 1.3 改造规模预估（深化后）

| 维度 | 数量 |
|------|------|
| 新增文件 | 8 个（`strands_backend/` 适配层） + 5 个（`strands_backend/tools/ops_*.py` 运维工具） |
| 修改文件 | 7 个（`requirements.txt` / `agents/__init__.py` / `core/llm_config.py` / `main.py` 注册段 / `transport.ts` / `sidecar-adapter.ts` / `.env.example`） |
| 保留不动 | 全部业务模块（`event_bus` / `tools/risk.py` / `needs_you` / `fix_loop` / `knowledge` / `skills` / `permissions` / `tdsf_loader` / `project_service` / `sandbox_proxy` / `squilla_router` / `long_context` / `self_evolution` / `langfuse_client` / `log_capture`） |
| 前端协议改动 | 0（`agent.invoke` 签名不变）；可选扩展 `state.live` 字段（P1） |
| Rust 改动 | 0（JSON-RPC 协议不变）；P2 可选扩展双向 JSON-RPC 让 Python 调 Rust SSH/SFTP |
| 预计工时 | P0 一天（适配层 + feature flag）+ P1 一天（终端上下文 + 5 运维工具）+ P2 半天（双向 JSON-RPC + 多 Agent 模式）= 2.5 人日 |

---

## 2. 2025-2026 开源生态补充调研（真实搜索数据）

> 以下数据来源于 2026-07-30 的真实 WebSearch + WebFetch，非记忆编造。Stars 数为各来源文章披露的近似值，会随时间变动。

### 2.1 Strands Agents（AWS，首选）

| 维度 | 数据 |
|------|------|
| GitHub | <https://github.com/strands-agents/sdk-python> |
| Stars | 2,000+（AWS re:Post 官方博客披露，2025-07-31 1.0 发布时） |
| PyPI 下载 | 150K+（1.0 发布时） |
| License | Apache 2.0 |
| 发布时间线 | 2025-05 预览版 → 2025-07-31 v1.0 |
| 生产验证 | AWS 内部多团队（Kiro / Amazon Q / AWS Glue） |
| 多模型支持 | Anthropic / Meta / OpenAI / Cohere / Mistral / Stability / Writer / Baseten（1.0 新增 5 个合作伙伴 API） |
| 多 Agent 模式 | 1.0 新增 4 原语：Agents-as-Tools / Handoffs / Swarm / Graph + A2A 协议支持 |
| MCP 集成 | 原生 `MCPClient`，支持 stdio / Streamable HTTP 传输 |
| 流式 | `stream_async` 异步迭代器 + `callback_handler` 事件回调 |
| 工具创建 | `@tool` 装饰器从 docstring + 类型标注自动生成工具描述 |

**核心代码范式**（来自 AWS 官方文档）：

```python
from strands import Agent, tool
from strands_tools import calculator, current_time

@tool
def letter_counter(word: str, letter: str) -> int:
    """
    Count occurrences of a specific letter in a word.
    Args:
        word (str): The input word to search in
        letter (str): The specific letter to count
    Returns:
        int: The number of occurrences of the letter in the word
    """
    if not isinstance(word, str) or not isinstance(letter, str):
        return 0
    if len(letter) != 1:
        raise ValueError("The 'letter' parameter must be a single character")
    return word.lower().count(letter.lower())

agent = Agent(tools=[calculator, current_time, letter_counter])
agent("How many letter R's are in the word strawberry?")
```

**MCPClient 范式**：

```python
from mcp import StdioServerParameters, stdio_client
from strands.tools.mcp import MCPClient

stdio_mcp_client = MCPClient(lambda: stdio_client(
    StdioServerParameters(command="uvx", args=["awslabs.aws-documentation-mcp-server@latest"])
))
with stdio_mcp_client:
    tools = stdio_mcp_client.list_tools_sync()
    agent = Agent(tools=tools)
    response = agent("What is Amazon Bedrock pricing model. Be concise.")
```

**流式事件类型**（来自 Strands 官方 stream_async 文档）：

```python
async for event in agent.stream_async(prompt):
    if event.get("init_event_loop"): ...      # 事件循环初始化
    elif event.get("start_event_loop"): ...   # 单轮循环开始
    elif event.get("start"): ...              # 新 cycle
    elif "message" in event: ...               # 新消息（含 role）
    elif event.get("complete"): ...           # cycle 完成
    elif event.get("force_stop"): ...         # 强制停止
    if "current_tool_use" in event: ...       # 当前工具调用
    if "data" in event: ...                   # 文本增量
```

### 2.2 HolmesGPT（CNCF Sandbox SRE Agent，运维场景对标）

| 维度 | 数据 |
|------|------|
| GitHub | <https://github.com/robusta-dev/holmesgpt> |
| Stars | 2,388（2026-05 数据） |
| License | MIT |
| CNCF 状态 | Sandbox（2025-10 接收） |
| 维护方 | Robusta.dev + Microsoft 共建 |
| 工具集 | 60+（Kubernetes / Prometheus / Grafana / Loki / Datadog / AWS / PostgreSQL / GitHub / Jenkins / ServiceNow） |
| 工作模式 | agentic loop（多步推理 + 工具调用迭代） |
| 告警集成 | Alertmanager / PagerDuty 双向 |
| 安装 | `pip install holmesgpt` / `brew install holmesgpt` / Docker |

**与 TDSF 的对标价值**：HolmesGPT 是"运维场景 agentic loop"的最佳实践参考。其 60+ toolset 的设计范式（每个工具单一职责 + 清晰 docstring + 风险感知）直接启发 TDSF 的 `strands_backend/tools/ops_*.py` 设计。但其工具集面向 K8s/云原生，TDSF 面向单机/SSH Linux 运维教学，工具集不直接复用。

### 2.3 OpenHands（自主编码平台）

| 维度 | 数据 |
|------|------|
| GitHub | <https://github.com/All-Hands-AI/OpenHands> |
| Stars | 62k-72k（2026-03 数据，多来源交叉） |
| License | MIT |
| 发布时间线 | 2025-07 V1（Software Agent SDK） |
| 形态 | SDK + CLI + Local GUI + Cloud + Enterprise |
| SWE-bench | 72%（Claude Sonnet 4.5 + extended thinking） |
| 沙箱 | 原生容器化 + RBAC + 审计追踪 |

**与 TDSF 的关系**：OpenHands 是"自主编码 agent 平台"，TDSF 是"运维教学终端 IDE"，定位不同。OpenHands 的沙箱化执行 + 事件溯源状态模型 + MCP 类型化工具系统是架构参考点，但不直接集成（依赖太重）。

### 2.4 Goose（Block 开源，AAIF 基金会托管）

| 维度 | 数据 |
|------|------|
| GitHub | <https://github.com/block/goose> |
| Stars | 32,300（2026-03 数据） |
| License | Apache 2.0 |
| 维护方 | Block（Square / Cash App 母公司） |
| 基金会 | 2025-12-09 捐赠给 Linux Foundation AAIF（与 MCP / AGENTS.md 同批） |
| 形态 | CLI + Desktop（Tauri 框架，与 TDSF 同栈） |
| 工作模式 | 感知-规划-执行-验证闭环 + MCP 工具发现 |

**与 TDSF 的关系**：Goose 同样是 Tauri 桌面端 + MCP 集成，是直接的架构对标。其"本地优先 + MCP 工具动态发现"范式印证 TDSF 的方向。但 Goose 是通用 AI agent 框架，TDSF 是运维教学专用，TDSF 不直接用 Goose（Goose 是产品不是 SDK，且 TDSF 已有 Python sidecar）。

### 2.5 编码 Agent 三巨头（Cline / Roo Code / Continue / Kilo Code）

| 工具 | Stars | License | 状态 | 形态 |
|------|-------|---------|------|------|
| Cline | 58,600 | Apache 2.0 | 活跃 | VS Code 扩展（Plan/Act 模式 + MCP） |
| Roo Code | 22,500 | Apache 2.0 | **2026-05 已归档停更** | VS Code 扩展（Cline fork，多模式） |
| Continue | 31,600 | Apache 2.0 | **被 Cursor 收购** | VS Code + JetBrains（已转向 CI 检查） |
| Kilo Code | 16,200 | Apache 2.0 | 活跃 | VS Code + JetBrains（Cline/Roo fork 整合） |

**与 TDSF 的关系**：这些都是 IDE 扩展形态的编码 agent，与 TDSF 的"终端 IDE + Python sidecar agent"架构不同。它们的 MCP 工具设计 + Plan/Act 模式 + human-in-the-loop 审批范式是 TDSF 的 UI/UX 参考点。

### 2.6 Aider（CLI pair programmer）

| 维度 | 数据 |
|------|------|
| GitHub | <https://github.com/Aider-AI/aider> |
| Stars | 41,200（2026-03 数据） |
| License | Apache 2.0 |
| 形态 | CLI（终端内 pair programmer） |
| SWE-bench | 76.5%（mixed model） |
| 特点 | 自动 git commit + repo mapping + 多模型 |

**与 TDSF 的关系**：Aider 是"终端内编码 agent"的最佳实践，其 git 集成 + repo mapping 范式可借鉴。但 Aider 是 Python CLI 工具，TDSF 已有 Python sidecar，不直接集成。

### 2.7 Devika（已停更）

| 维度 | 数据 |
|------|------|
| GitHub | <https://github.com/stitionai/devika> |
| Stars | 19,014（2025-03 数据） |
| License | MIT |
| 状态 | **已停更**（README 显示 "Checkout Opcode, the second iteration of Devika"），最后提交 2024-09 |
| 形态 | Python 后端 + Svelte 前端（本地 Web UI） |

**结论**：Devika 已停更，不作为选型候选。其多 Agent 协作架构（Planner/Researcher/Coder）是设计参考。

### 2.8 bolt.diy（自托管 AI Web 开发）

| 维度 | 数据 |
|------|------|
| GitHub | <https://github.com/stackblitz-labs/bolt.diy> |
| Stars | 14,200（2025-04 数据） |
| License | MIT |
| 形态 | 浏览器内全栈开发（WebContainers） |
| 维护方 | StackBlitz |

**结论**：bolt.diy 是"浏览器内 Web 开发"专用，与 TDSF 运维场景无关，不作为选型候选。

### 2.9 选型结论：为什么是 Strands Agents

| 评估维度 | Strands Agents | HolmesGPT | OpenHands | Goose | Aider |
|----------|----------------|-----------|-----------|-------|-------|
| 与 TDSF Python sidecar 架构对齐 | ✅ Python SDK，原生嵌入 | ❌ 独立产品 | ❌ 独立平台 | ❌ Rust+Tauri 产品 | ⚠️ Python CLI |
| 运维场景适配 | ⚠️ 通用框架，需自建工具 | ✅ 60+ 运维工具集 | ❌ 编码场景 | ⚠️ 通用 | ❌ 编码场景 |
| 依赖轻量 | ✅ 3 包（strands + tools + litellm） | ❌ 重（K8s/Prom 工具集） | ❌ 重（沙箱+SDK） | ❌ 独立产品 | ✅ 轻 |
| 模型驱动 agentic loop | ✅ 核心特性 | ✅ | ✅ | ✅ | ⚠️ 单轮 |
| MCP 原生支持 | ✅ MCPClient | ✅ | ✅ | ✅ | ❌ |
| 多 Agent 模式 | ✅ 1.0 四原语 | ❌ 单 Agent | ✅ | ⚠️ | ❌ |
| 生产验证 | ✅ AWS 内部多产品 | ✅ Robusta 商业 | ✅ TikTok/Apple/Netflix | ✅ Block | ✅ 社区 |
| License 友好 | ✅ Apache 2.0 | ✅ MIT | ✅ MIT | ✅ Apache 2.0 | ✅ Apache 2.0 |
| **可改造性**（魔改友好度） | ✅ 最优 | ❌ 不可改造 | ⚠️ SDK 可改造 | ❌ 产品不可改造 | ⚠️ CLI 难嵌入 |

**最终选型**：**Strands Agents 1.0** 作为 TDSF 的 agent 编排引擎。理由：
1. Python SDK，与 TDSF 现有 `src-tauri/sidecar/` Python sidecar 架构无缝对接；
2. 模型驱动 agentic loop 替代 LangGraph 7 节点 PAOR，消除 LangChain 5 包重依赖；
3. `@tool` 装饰器与 TDSF 现有 `tools/*.py` 的 `invoke_*_tool(params)` 范式高度对齐，迁移成本低；
4. MCPClient 原生支持，可让 TDSF 现有 9 个 MCP tools 直接暴露给 Strands agent；
5. Apache 2.0 与 TDSF 上游 terax-ai 兼容，无 License 阻碍；
6. AWS 生产验证 + AAIF 生态背书，长期维护有保障。

**HolmesGPT 作为运维工具设计参考**：其 60+ toolset 的"单一职责 + 清晰 docstring + 风险感知"范式直接启发 TDSF 的 `ops_*.py` 工具设计，但工具集本身不直接复用（场景不同）。

---

## 3. 当前架构分析（基于实际源码）

### 3.1 Python Sidecar 启动链

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/main.py` 是 stdio JSON-RPC 2.0 server。启动流程：

1. **L489-496**：安装 `log_capture` handler（必须在业务模块 import 之前，避免早期日志丢失）；
2. **L499**：初始化 `MethodDispatcher`（自动注册 `ping` / `shutdown` / `status` 三个默认方法，见 L204-208）；
3. **L502-509**：调用 `register_business_methods(dispatcher)` 注册 15 个业务模块（每个用 try/except 包裹，单模块失败不阻塞整体启动）；
4. **L512-521**：发送 `ready` 通知（Rust 侧阻塞等待此信号判定启动成功）；
5. **L525-581**：主循环逐行读 stdin，dispatch JSON-RPC 消息；
6. **L584-592**：退出时 `needs_you.stop_global_service()` 清理线程。

### 3.2 业务方法注册（agents 模块的接入点）

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/main.py:332-358` 是 agents 模块注册段：

```python
# T-P1-11: Agent 框架（主 Agent + 4 子 Agent）
try:
    import agents
    from core.llm_config import make_llm_call
    llm_call = make_llm_call()  # 从环境变量 / .tdsf-data/llm_config.json 加载
    if llm_call is not None:
        logger.info("LLM configured, agents will use real LLM")
    else:
        logger.warning("LLM not configured, agents will use mock LLM")

    agents.register_methods(dispatcher)  # 注册 agent.invoke / agent.list / agent.info / agent.configure
    agents.configure_agents(
        event_bus=event_bus.get_global_bus(),
        llm_call=llm_call,
    )
except Exception as e:
    logger.exception(f"failed to register agents: {e}")
```

**这是 Strands 集成的关键接入点**：Strands 后端在此处通过 feature flag 注入，与 LangGraph 后端并行存在。

### 3.3 Agent 注册表与 JSON-RPC 入口

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/agents/__init__.py`：

- **L83-94** `AGENT_REGISTRY`：9 个 Agent（main + coding/explore/history/teach + debug/refactor/test/deploy）；
- **L109-129** `configure_agents(event_bus, llm_call)`：实例化所有 Agent，注入 event_bus + llm_call；
- **L186-198** `register_methods(dispatcher)`：注册 4 个 JSON-RPC 方法（`agent.invoke` / `agent.list` / `agent.info` / `agent.configure`）；
- **L201-203** `_rpc_agent_invoke(name, state)`：JSON-RPC 入口，调 `invoke_agent(name, state) → agent.invoke(state)`。

**Strands 集成策略**：保留 `agent.invoke` / `agent.list` / `agent.info` / `agent.configure` 四个 JSON-RPC 方法签名不变，仅替换 `invoke_agent` 内部实现（LangGraph → Strands）。

### 3.4 BaseAgent PAOR 模板方法

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/agents/base.py`：

- **L44-59** `LLMCallFunction` Protocol：签名 `(messages: list[dict]) -> str`（OpenAI Chat Completions 兼容）；
- **L62-100** `AgentResult` + `to_state_update()`：返回 dict 含 `observation` / `next_step` / `reflection` / `mood`；
- **L107+** `BaseAgent`：模板方法 `invoke(state)` 依次调 `plan_task` → `select_tool` → `call_tool` → `format_observation` → `reflect_on_result`。

**Strands 映射**：Strands 的 `Agent(model, tools, system_prompt, callback_handler)` + agentic loop 完整覆盖 PAOR 语义（Plan=首次推理隐式规划，Act=tool_use，Observe=tool_result，Reflect=再次推理）。

### 3.5 LLM 配置（langchain-openai，待替换）

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/core/llm_config.py`：

- **L163-228** `_make_openai_call(config)`：用 `langchain_openai.ChatOpenAI`，通过 `base_url` 支持 OpenAI / DeepSeek / OneAPI / Ollama 兼容端点；
- **L231-271** `_make_anthropic_call(config)`：用 `langchain_anthropic.ChatAnthropic`；
- **L274-300** `make_llm_call(config)`：工厂方法，未配置时返回 None 触发 mock 降级；
- **L307-319** `reconfigure(config)`：供 `agent.configure` RPC 运行时热切换。

**Strands 替换策略**：用 Strands 的 `OpenAIModel` / `AnthropicModel` / `OllamaModel` / `LiteLLMModel` 替换 langchain 客户端，保留 `LLMCallFunction` 签名兼容（Strands 模型可直接传入 `Agent(model=...)`）。

### 3.6 工具层（9 个 MCP tools + invoke_tool 统一入口）

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/tools/__init__.py`：

- **L82-93** `TOOL_REGISTRY`：9 个工具（risk / confidence / ground / decision / credibility / history / worktree_fanout / rlm_fanout / steer_inject）；
- **L96-114** `invoke_tool(name, params)`：统一调度入口；
- 每个工具有 `invoke_*_tool(params) -> dict` + `get_tool_metadata() -> dict`（含 input_schema / output_schema）。

**Strands 集成策略**：用 Strands `@tool` 装饰器包装现有 `invoke_*_tool` 函数，自动从 docstring 生成工具描述；或用 `MCPClient` 把整个 `tools/` 模块暴露为 MCP server，让 Strands agent 通过 MCP 协议发现工具。

### 3.7 前端 transport.ts 路由与 env block

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src/modules/ai/lib/transport.ts`：

- **L47-52** `LiveSnapshot`：含 `cwd` / `terminalPrivate` / `workspaceRoot` / `activeFile`；
- **L120-145** sidecar 路由分支：`tdsfAgent` 非 null → 调 `runSidecarStream({agentId, messages, input, ...})`；
- **L241-249** `formatEnvBlock(live)`：生成 `<env>...</env>` 块（含 workspace_root / active_terminal_cwd / active_file / active_terminal_mode），注入到最后一条 user 消息；
- **L197-209** `extractLastUserText(messages)`：提取最后一条 user text 作为 `input`。

**关键缺口**：`runSidecarStream` 只传 `{input, messages}` 给 Python `agent.invoke`（见 `sidecar-adapter.ts:337-343`），**不传 `live.cwd` / `live.activeFile` / 终端缓冲**。`formatEnvBlock` 注入的 `<env>` 块虽在 messages 里，但 Python agent 不解析它（BaseAgent.invoke 直接把 input 喂给 LLM，不提取 env 块）。这是用户硬约束"AI 能看到当前终端环境"未满足的根因。

### 3.8 前端 sidecar-adapter.ts 流式适配

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src/modules/ai/lib/sidecar-adapter.ts`：

- **L298-416** `runSidecarStream(opts)`：调 `invoke('ipc_invoke', {method:'agent.invoke', params:{name, state:{input, messages}}})`，30s 超时；
- **L211-276** `registerSidecarListeners`：监听 3 个 Tauri event（`sidecar:mood_change` / `sidecar:tool_call` / `sidecar:agent_switch`），**未监听 `sidecar:agent_message`**（前次审计已指出，Strands 集成时一并补齐）；
- **L182-196** `streamText`：把 dict 切片流式 yield（`STREAM_CHUNK_SIZE=24` 字符，`STREAM_CHUNK_DELAY_MS=8`ms）；
- **L94-119** `AgentInvokeResult`：返回值字段（observation / output / thinking / teaching_content / mood / tokens）。

### 3.9 前端 terminal.ts 工具（Vercel SDK 路径专用）

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src/modules/ai/tools/terminal.ts`：

- **L6-109** `buildTerminalTools(ctx)`：3 个工具（`suggest_command` / `get_terminal_output` / `open_preview`），用 Vercel AI SDK `tool()` 创建；
- **L35-67** `get_terminal_output`：通过 `ctx.getTerminalContext()` 拿终端缓冲尾部；
- **只在 Vercel SDK 路径生效**，Python agent.invoke 路径没有这些工具。

**这是 sidecar 路径"看不到终端"的另一根因**：终端工具只在前端 Vercel SDK 路径注册，Python agent 无法调用。

### 3.10 Rust JSON-RPC 协议层

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/src/modules/ipc.rs`：

- **L42** `DEFAULT_REQUEST_TIMEOUT = 30s`；
- **L52-85** `IPCError` 类型化错误（NotRunning / Timeout / StdinClosed / ProcessError / Json / Io / RemoteError）；
- Rust → Python 是 request（有 id，等响应）；Python → Rust 只能 notification（无 id，不等响应）。

**架构缺口**：Python agent 无法主动调 Rust 执行 SSH 命令 / SFTP 文件操作（因为 JSON-RPC 是单向的）。详见 §6 终端上下文感知方案。

---

## 4. Strands Agents 集成方案（深化版）

### 4.1 sub-package 目录结构

新增 `src-tauri/sidecar/strands_backend/` 适配层：

```
src-tauri/sidecar/strands_backend/
├── __init__.py                    # 模块入口，导出 configure_strands / invoke_strands_agent
├── agent_factory.py                # Strands Agent 工厂（构建 Agent + tools + system_prompt）
├── model_adapter.py                # LLM 模型适配器（替换 core/llm_config.py 的 langchain 客户端）
├── tool_adapter.py                 # 工具适配器（包装现有 9 个 tools/*.py 为 Strands @tool）
├── callback_handler.py            # 事件回调（Strands 事件 → event_bus.publish）
├── multi_agent.py                 # 多 Agent 模式（Agents-as-Tools 替代 MainAgent 路由）
├── context.py                     # 终端上下文感知（解析 <env> 块 + 注入 system prompt）
├── risk_hook.py                   # RiskEngine pre-tool hook（工具调用前自动风险评估）
└── tools/                          # 新增运维工具（与现有 tools/ 平行）
    ├── __init__.py
    ├── ops_ssh_command.py          # SSH 命令建议（风险评估 + 返回建议命令）
    ├── ops_read_remote_file.py     # 远程文件读取（通过 SFTP bridge）
    ├── ops_analyze_logs.py         # 日志分析（tail + grep + 模式匹配）
    ├── ops_query_processes.py      # 进程查询（ps / top / pgrep）
    └── ops_network_diagnose.py    # 网络诊断（ping / ss / netstat / ip）
```

**每个文件的职责与行数预估**：

| 文件 | 职责 | 行数预估 |
|------|------|----------|
| `__init__.py` | 模块入口，导出公共 API | 60 |
| `agent_factory.py` | `create_strands_agent(name, event_bus, llm_call, tools) → Agent` | 180 |
| `model_adapter.py` | `make_strands_model(config) → OpenAIModel / AnthropicModel / OllamaModel / LiteLLMModel` | 150 |
| `tool_adapter.py` | `wrap_existing_tools() → list[Tool]`（包装 9 个现有 tools） | 200 |
| `callback_handler.py` | `TdsfCallbackHandler` 类（Strands 事件 → event_bus） | 180 |
| `multi_agent.py` | `build_main_agent_with_subagents() → Agent`（Agents-as-Tools） | 200 |
| `context.py` | `parse_env_block(messages) → dict` + `inject_context_to_prompt(prompt, ctx) → str` | 120 |
| `risk_hook.py` | `pre_tool_hook(tool_name, params) → dict`（调 RiskEngine） | 100 |
| `tools/ops_ssh_command.py` | SSH 命令建议工具 | 150 |
| `tools/ops_read_remote_file.py` | 远程文件读取工具 | 120 |
| `tools/ops_analyze_logs.py` | 日志分析工具 | 180 |
| `tools/ops_query_processes.py` | 进程查询工具 | 130 |
| `tools/ops_network_diagnose.py` | 网络诊断工具 | 160 |
| **合计** | | **~1930 行** |

### 4.2 与 main.py 的集成接入点（不破坏 ping/shutdown/status）

修改 `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/main.py:332-358` 的 agents 注册段，加入 feature flag：

```python
# T-P1-11: Agent 框架（主 Agent + 4 子 Agent）
try:
    import agents
    from core.llm_config import make_llm_call
    llm_call = make_llm_call()
    if llm_call is not None:
        logger.info("LLM configured, agents will use real LLM")
    else:
        logger.warning("LLM not configured, agents will use mock LLM")

    agents.register_methods(dispatcher)  # 4 个 JSON-RPC 方法签名不变

    # === TDSF Strands 集成：Feature Flag 切换后端 ===
    backend = os.environ.get("TDSF_AGENT_BACKEND", "langgraph").lower()
    if backend == "strands":
        try:
            import strands_backend
            strands_backend.configure_strands(
                event_bus=event_bus.get_global_bus(),
                llm_call=llm_call,
            )
            # 覆盖 invoke_agent 的内部实现为 Strands 后端
            agents.set_backend(strands_backend.invoke_strands_agent)
            logger.info("Strands Agents backend activated (TDSF_AGENT_BACKEND=strands)")
        except Exception as se:
            logger.exception(f"failed to activate Strands backend, fallback to LangGraph: {se}")
            agents.configure_agents(
                event_bus=event_bus.get_global_bus(),
                llm_call=llm_call,
            )
    else:
        # 默认 LangGraph 后端（保持现状）
        agents.configure_agents(
            event_bus=event_bus.get_global_bus(),
            llm_call=llm_call,
        )
    logger.info(f"agents methods registered + configured: {agents.list_agents()}")
except Exception as e:
    logger.exception(f"failed to register agents: {e}")
```

**关键点**：
1. **`ping` / `shutdown` / `status` 完全不受影响**：它们由 `MethodDispatcher._register_defaults()` 在 L204-208 注册，与 `register_business_methods` 隔离；
2. **`agent.invoke` / `agent.list` / `agent.info` / `agent.configure` 签名不变**：前端 `sidecar-adapter.ts` 零改动；
3. **Feature Flag**：`TDSF_AGENT_BACKEND=strands` 切换，默认 `langgraph` 保持现状，出问题即时回滚；
4. **`agents.set_backend` 是新增的注入点**：让 `invoke_agent(name, state)` 内部根据 backend 标志路由到 LangGraph 或 Strands；
5. **Strands 启动失败自动 fallback**：try/except 包裹，失败时回退到 LangGraph 后端，保证启动不阻塞。

### 4.3 模型适配器（替换 langchain-openai）

`strands_backend/model_adapter.py` 草案：

```python
"""Strands 模型适配器 — 替换 core/llm_config.py 的 langchain 客户端

保留 LLMCallFunction 签名兼容（messages: list[dict] -> str），
同时提供 Strands Agent 期望的 Model 对象。
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("sidecar.strands_backend.model_adapter")


def make_strands_model(config) -> Any:
    """根据 LLMConfig 创建 Strands Model 对象

    Args:
        config: core.llm_config.LLMConfig 实例

    Returns:
        Strands Model 实例（OpenAIModel / AnthropicModel / OllamaModel / LiteLLMModel）

    Raises:
        RuntimeError: 依赖未安装或配置无效
    """
    if not config.is_configured:
        raise RuntimeError("LLM not configured (no API Key)")

    provider = config.provider.lower()

    if provider == "anthropic":
        from strands.models import AnthropicModel
        return AnthropicModel(
            model_id=config.model,
            api_key=config.api_key,
        )

    if provider == "ollama":
        from strands.models import OllamaModel
        return OllamaModel(
            model_id=config.model,
            host=config.base_url or "http://localhost:11434",
        )

    # 默认 OpenAI 兼容（覆盖 openai / deepseek / oneapi / 自定义代理）
    from strands.models import OpenAIModel
    kwargs: dict[str, Any] = {
        "model_id": config.model,
        "api_key": config.api_key,
    }
    if config.base_url:
        kwargs["base_url"] = config.base_url
    return OpenAIModel(**kwargs)


def make_llm_call_from_strands_model(model) -> "callable":
    """把 Strands Model 包装成 LLMCallFunction（messages -> str）

    用于兼容旧 BaseAgent.llm_call 签名（Strands 后端不需要，
    但 LangGraph 后端 fallback 时仍用得到）。
    """
    def llm_call(messages: list[dict]) -> str:
        # Strands Model 没有 direct invoke，需通过 Agent 调用
        # 这里只是占位，实际 Strands 后端直接用 Agent(prompt)
        raise NotImplementedError(
            "Strands backend uses Agent(prompt) directly, "
            "LLMCallFunction wrapper is for LangGraph fallback only"
        )
    return llm_call
```

**集成点**：`core/llm_config.py` 不需要修改（保持 langchain 客户端给 LangGraph 后端用）。Strands 后端通过 `make_strands_model(config)` 直接拿到 Strands Model 对象，绕过 langchain。

### 4.4 工具适配器（包装现有 9 个 tools）

`strands_backend/tool_adapter.py` 草案：

```python
"""工具适配器 — 把现有 tools/*.py 包装为 Strands @tool

两种模式：
1. wrap_existing_tools(): 把 9 个 invoke_*_tool 函数包装为 Strands @tool
2. build_mcp_server(): 把整个 tools/ 模块暴露为 MCP server（Strands MCPClient 发现）

推荐模式 1（无需启动额外进程，性能更优）。
"""
from __future__ import annotations

import logging
from typing import Any

from strands import tool

logger = logging.getLogger("sidecar.strands_backend.tool_adapter")


def wrap_existing_tools() -> list:
    """把现有 9 个 tools/*.py 包装为 Strands @tool

    Returns:
        Strands Tool 列表，可直接传入 Agent(tools=[...])
    """
    from tools import TOOL_REGISTRY, get_tool_metadata

    wrapped = []
    for name, invoke_fn in TOOL_REGISTRY.items():
        wrapped.append(_wrap_single_tool(name, invoke_fn, get_tool_metadata(name)))
    logger.info(f"wrapped {len(wrapped)} existing tools for Strands: {list(TOOL_REGISTRY.keys())}")
    return wrapped


def _wrap_single_tool(name: str, invoke_fn, metadata: dict):
    """单个工具的包装器

    从 metadata 提取 input_schema 生成 Strands 兼容的工具签名。
    """
    input_schema = metadata.get("input_schema", {})
    description = metadata.get("description", f"TDSF tool: {name}")

    @tool
    def tdsf_tool(**params: Any) -> dict:
        f"""{description}

        Args:
            params: 工具参数（schema: {input_schema}）

        Returns:
            dict: 工具结果（schema: {metadata.get('output_schema', {})}）
        """
        # 风险评估 pre-hook（见 risk_hook.py）
        from strands_backend.risk_hook import pre_tool_hook
        risk_assessment = pre_tool_hook(name, params)
        if risk_assessment.get("require_approval"):
            # 高风险：返回 needs-you 请求，不执行
            return {
                "status": "needs_approval",
                "risk": risk_assessment,
                "message": f"工具 {name} 触发风险评估：{risk_assessment.get('reason', '')}",
            }

        # 调用原 invoke 函数
        try:
            result = invoke_fn(params)
            return {"status": "success", "data": result}
        except Exception as e:
            logger.exception(f"tool {name} failed: {e}")
            return {"status": "error", "error": str(e)}

    # 重命名函数为工具名（Strands 从 __name__ 提取工具名）
    tdsf_tool.__name__ = name
    return tdsf_tool
```

### 4.5 回调处理器（Strands 事件 → event_bus）

`strands_backend/callback_handler.py` 草案：

```python
"""Strands 回调处理器 — 把 Strands 事件转发到 event_bus

保持现有事件名不变（mood_change / agent_message / tool_call / agent_switch），
前端 sidecar-adapter.ts 的监听器零改动。

Strands 事件类型（来自 stream_async）：
- init_event_loop / start_event_loop / start / message / complete / force_stop
- current_tool_use（含 name + input）
- data（文本增量）
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("sidecar.strands_backend.callback_handler")


class TdsfCallbackHandler:
    """TDSF Strands 回调处理器

    用法:
        handler = TdsfCallbackHandler(event_bus, agent_name="main")
        agent = Agent(callback_handler=handler, ...)
    """

    def __init__(self, event_bus: Any, agent_name: str = "main") -> None:
        self.event_bus = event_bus
        self.agent_name = agent_name
        self._current_tool: str | None = None

    def __call__(self, **kwargs: Any) -> None:
        """Strands callback_handler 协议：接收 **kwargs 事件"""
        try:
            self._handle_event(kwargs)
        except Exception as e:
            logger.exception(f"callback handler error: {e}")

    def _handle_event(self, event: dict) -> None:
        """处理单个 Strands 事件"""
        # 工具调用开始
        if "current_tool_use" in event and event["current_tool_use"].get("name"):
            tool_name = event["current_tool_use"]["name"]
            if tool_name != self._current_tool:
                self._current_tool = tool_name
                self._publish_tool_call(tool_name, event["current_tool_use"].get("input", {}))

        # 文本增量 → agent_message 事件
        if "data" in event and event["data"]:
            self._publish_agent_message(event["data"], msg_type="text")

        # 循环开始 → mood=thinking
        if event.get("start"):
            self._publish_mood_change("thinking")

        # 循环完成 → mood=done
        elif event.get("complete"):
            self._publish_mood_change("done")

    def _publish_mood_change(self, mood: str) -> None:
        if self.event_bus:
            self.event_bus.publish(event_type="mood_change", payload={
                "agent": self.agent_name,
                "mood": mood,
            })

    def _publish_tool_call(self, tool_name: str, tool_input: dict) -> None:
        if self.event_bus:
            self.event_bus.publish(event_type="tool_call", payload={
                "agent": self.agent_name,
                "tool": tool_name,
                "input": tool_input,
            })

    def _publish_agent_message(self, text: str, msg_type: str = "text") -> None:
        if self.event_bus:
            self.event_bus.publish(event_type="agent_message", payload={
                "agent": self.agent_name,
                "type": msg_type,
                "text": text,
            })
```

**关键点**：
1. **事件名与现有对齐**：`mood_change` / `tool_call` / `agent_message` 都是现有 `event_bus.EventType` 已注册的；
2. **前端零改动**：`sidecar-adapter.ts:211-276` 已监听 `sidecar:mood_change` / `sidecar:tool_call` / `sidecar:agent_switch`，仅需补齐 `sidecar:agent_message` 监听（前次审计已指出）；
3. **流式输出**：Strands 的 `data` 事件（文本增量）通过 `agent_message` 推送，前端可实时渲染（替代当前 dict 切片模拟流式）。

### 4.6 多 Agent 模式（Agents-as-Tools 替代 MainAgent 路由）

`strands_backend/multi_agent.py` 草案：

```python
"""Strands 多 Agent 模式 — 替代 MainAgent 的 PAOR + 子 Agent 路由

用 Strands 1.0 的 Agents-as-Tools 模式：
- 8 个子 Agent（coding/explore/history/teach/debug/refactor/test/deploy）作为工具
- main Agent 作为 orchestrator，动态调用子 Agent 工具
- 替代现有 MainAgent._invoke_sub_agent 循环（MAX_SUB_ITER=5 防死循环）

优势:
- Strands 模型自主决定调用哪个子 Agent（基于 system_prompt 引导）
- 子 Agent 之间不互相调用（避免循环）
- 完整对话上下文保留（Strands Sessions 自动维护）
"""
from __future__ import annotations

import logging
from typing import Any

from strands import Agent, tool

logger = logging.getLogger("sidecar.strands_backend.multi_agent")


def build_main_agent_with_subagents(
    model: Any,
    tools: list,
    callback_handler: Any,
    system_prompt: str,
) -> Agent:
    """构建 main Agent + 8 子 Agent（Agents-as-Tools 模式）

    Args:
        model: Strands Model 对象
        tools: 已包装的现有 9 个 tools
        callback_handler: TdsfCallbackHandler 实例
        system_prompt: main Agent 的 system prompt

    Returns:
        Strands Agent 实例（main orchestrator）
    """
    # 8 个子 Agent（每个有专属 system_prompt + 工具子集）
    sub_agents = _build_sub_agents(model, callback_handler)

    # 把子 Agent 包装为 @tool（Agents-as-Tools 模式）
    sub_agent_tools = []
    for name, agent in sub_agents.items():
        sub_agent_tools.append(_make_agent_as_tool(name, agent))

    # main Agent = orchestrator（拥有现有 tools + 子 Agent 工具）
    main_agent = Agent(
        model=model,
        tools=tools + sub_agent_tools,
        system_prompt=system_prompt,
        callback_handler=callback_handler,
        max_parallel_tools=1,  # 串行调用，避免子 Agent 并发竞态
    )
    return main_agent


def _build_sub_agents(model: Any, callback_handler: Any) -> dict[str, Agent]:
    """构建 8 个子 Agent（每个专属 system_prompt）"""
    sub_specs = {
        "coding": "You are a coding specialist...",
        "explore": "You are a code exploration specialist...",
        "history": "You are a history query specialist...",
        "teach": "You are a Linux运维教学 specialist...",
        "debug": "You are a fault diagnosis specialist...",
        "refactor": "You are a code refactor specialist...",
        "test": "You are a test generation specialist...",
        "deploy": "You are a deployment orchestration specialist...",
    }
    return {
        name: Agent(
            model=model,
            system_prompt=prompt,
            callback_handler=callback_handler,
        )
        for name, prompt in sub_specs.items()
    }


def _make_agent_as_tool(name: str, agent: Agent):
    """把子 Agent 包装为 @tool（Strands Agents-as-Tools 模式）"""
    @tool
    def sub_agent_tool(query: str) -> str:
        f"""Delegate to {name} sub-agent.

        Use this when the task requires {name} expertise.

        Args:
            query (str): The task description to delegate to {name} agent.

        Returns:
            str: The {name} agent's response.
        """
        response = agent(query)
        return str(response)

    sub_agent_tool.__name__ = f"{name}_agent"
    return sub_agent_tool
```

**关键点**：
1. **替代 MainAgent._invoke_sub_agent 循环**：Strands 模型自主决定调用哪个子 Agent，不需要关键词路由；
2. **MAX_SUB_ITER 防死循环**：Strands 的 `max_iterations` 参数替代（默认 10，可配置）；
3. **agent_switch 事件**：子 Agent 调用时通过 callback_handler 推送 `agent_switch` 事件，前端 `AgentStatusPill` 实时显示。

### 4.7 Feature Flag 与回滚

`.env.example` 新增：

```bash
# TDSF Agent 后端选择（langgraph | strands）
# langgraph: 默认，使用现有 LangGraph 7 节点 PAOR
# strands: 使用 Strands Agents 1.0 model-driven agentic loop
TDSF_AGENT_BACKEND=langgraph

# Strands Agents 配置（仅 TDSF_AGENT_BACKEND=strands 时生效）
TDSF_STRANDS_MAX_ITERATIONS=10
TDSF_STRANDS_MAX_PARALLEL_TOOLS=1
TDSF_STRANDS_LOAD_TOOLS_FROM_DIRECTORY=false
```

**回滚策略**：
1. 修改 `TDSF_AGENT_BACKEND=langgraph` 重启 sidecar 即可回滚；
2. Strands 后端启动失败时自动 fallback 到 LangGraph（见 §4.2 的 try/except）；
3. 两套后端的 `agent.invoke` 返回值结构一致（`observation` / `mood` / `tokens`），前端无感知。

---

## 5. 前端调用链路（深化版）

### 5.1 现有链路（不变）

```
TdsfAgentPanel.tsx (用户输入)
  → chatRuntime.sendMessage
  → transport.ts: createContextAwareTransport.run
  → transport.ts:120-145  tdsfAgent 非 null → runSidecarStream
  → sidecar-adapter.ts:298  runSidecarStream
  → invoke('ipc_invoke', {method:'agent.invoke', params:{name, state:{input, messages}}})
  → Rust ipc.rs: ipc_invoke → IPCClient.invoke → stdio JSON-RPC
  → Python main.py: MethodDispatcher.dispatch('agent.invoke', {name, state})
  → agents/__init__.py: _rpc_agent_invoke → invoke_agent(name, state)
  → [Strands 后端] strands_backend.invoke_strands_agent(name, state)
  → Strands Agent(state.input) → agentic loop → 返回 dict
  → 前端 sidecar-adapter.ts: 切片流式 yield
  → useChat 渲染
```

### 5.2 事件监听扩展（补齐 sidecar:agent_message）

修改 `file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src/modules/ai/lib/sidecar-adapter.ts:211-276` 的 `registerSidecarListeners`，新增 `sidecar:agent_message` 监听：

```typescript
// 在 registerSidecarListeners 中追加（与 mood_change / tool_call / agent_switch 平行）

// agent 中途消息事件（Strands data 事件转发的文本增量）
// 用于实时显示 agent 推理过程中的中间消息（如 "正在调用 X 工具" / "规划完成"）
if (onMessage) {
  try {
    unlisteners.push(
      await listen<{ text?: string; type?: string }>("sidecar:agent_message", (e) => {
        const p = e.payload;
        if (p?.text) onMessage(p.text, p.type);
      }),
    );
  } catch {
    // 非 Tauri 环境
  }
}
```

**收益**：Strands 的 `data` 事件（文本增量）通过 `agent_message` 实时推送，前端可显示真正的流式输出（替代当前 dict 切片模拟流式）。

### 5.3 终端上下文感知方案（用户硬约束"AI 能看到当前终端环境"）

详见 §6。

---

## 6. 终端上下文感知方案（关键缺口补齐）

### 6.1 现状缺口

**用户硬约束**（来自 user_profile.md）：
- "AI agent 智能性：要求能感知后台 SSH 连接的服务器状态"
- "终端功能：AI 需能看到当前终端环境并执行命令"

**当前实现缺口**：

1. **`transport.ts:122-145` 只传 `input` + `messages`**：不传 `live.cwd` / `live.activeFile` / 终端缓冲；
2. **`formatEnvBlock(live)` 注入的 `<env>` 块 Python 不解析**：BaseAgent.invoke 直接把 input 喂给 LLM，不提取 env 块；
3. **`terminal.ts` 的 3 个工具只在 Vercel SDK 路径生效**：Python agent.invoke 路径没有 `get_terminal_output` 工具；
4. **Python agent 无法主动调 Rust 执行 SSH/SFTP**：JSON-RPC 是单向的（Rust → Python 请求，Python → Rust 只能 notification）。

### 6.2 方案 A：扩展 state 字段（注入 system prompt，P0）

**思路**：前端 `runSidecarStream` 在 `state` 中追加 `live` 字段，Python 端解析后注入 system prompt。

**前端改动**（`sidecar-adapter.ts:337-343`）：

```typescript
// 现状
params: {
  name: pythonName,
  state: { input, messages },
}

// 改造后（追加 live 字段）
params: {
  name: pythonName,
  state: {
    input,
    messages,
    live: {  // 新增：终端上下文快照
      cwd: liveSnapshot.cwd,
      activeFile: liveSnapshot.activeFile,
      workspaceRoot: liveSnapshot.workspaceRoot,
      terminalPrivate: liveSnapshot.terminalPrivate,
      sshSessionId: getActiveSshSessionId(),  // 新增：当前 SSH session id
    },
  },
}
```

**需要 transport.ts 把 `live` 传给 runSidecarStream**（当前 `transport.ts:122-145` 没传）。

**Python 端改动**（`strands_backend/context.py`）：

```python
"""终端上下文感知 — 解析 state.live 注入 system prompt"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("sidecar.strands_backend.context")


def parse_live_context(state: dict) -> dict:
    """从 agent.invoke 的 state 中提取 live 上下文

    Args:
        state: agent.invoke 的 state 参数

    Returns:
        dict: {cwd, activeFile, workspaceRoot, terminalPrivate, sshSessionId}
              缺失字段为 None
    """
    live = state.get("live") or {}
    return {
        "cwd": live.get("cwd"),
        "activeFile": live.get("activeFile"),
        "workspaceRoot": live.get("workspaceRoot"),
        "terminalPrivate": live.get("terminalPrivate", False),
        "sshSessionId": live.get("sshSessionId"),
    }


def inject_context_to_prompt(base_prompt: str, ctx: dict) -> str:
    """把 live 上下文注入 system prompt

    在 base_prompt 末尾追加 <live_context> 块，让 LLM 知道当前终端环境。

    Args:
        base_prompt: 原始 system prompt
        ctx: parse_live_context 返回的上下文字典

    Returns:
        str: 注入上下文后的 system prompt
    """
    lines = []
    if ctx.get("cwd"):
        lines.append(f"当前终端工作目录: {ctx['cwd']}")
    if ctx.get("activeFile"):
        lines.append(f"当前激活文件: {ctx['activeFile']}")
    if ctx.get("workspaceRoot"):
        lines.append(f"工作区根目录: {ctx['workspaceRoot']}")
    if ctx.get("terminalPrivate"):
        lines.append("当前终端处于隐私模式（内容不可见）")
    if ctx.get("sshSessionId"):
        lines.append(f"已连接 SSH 会话: {ctx['sshSessionId']}（可调用 ssh_command 工具执行远程命令）")
    else:
        lines.append("未连接 SSH 会话（本地终端模式）")

    if not lines:
        return base_prompt

    context_block = "<live_context>\n" + "\n".join(lines) + "\n</live_context>"
    return f"{base_prompt}\n\n{context_block}"
```

**Strands Agent 集成**（`strands_backend/agent_factory.py`）：

```python
def create_strands_agent(name, event_bus, llm_call, tools, state):
    """构建 Strands Agent，注入终端上下文"""
    from strands import Agent
    from .context import parse_live_context, inject_context_to_prompt
    from .callback_handler import TdsfCallbackHandler
    from .model_adapter import make_strands_model
    from core.llm_config import load_config

    config = load_config()
    model = make_strands_model(config)

    # 解析终端上下文
    live_ctx = parse_live_context(state)

    # 构建 system prompt（base + TDSF.md + live context）
    base_prompt = _build_base_prompt(name)  # 从 agents/<name>_agent.py 提取
    full_prompt = inject_context_to_prompt(base_prompt, live_ctx)

    handler = TdsfCallbackHandler(event_bus, agent_name=name)

    return Agent(
        model=model,
        tools=tools,
        system_prompt=full_prompt,
        callback_handler=handler,
    )
```

**优势**：
- 前端改动小（`sidecar-adapter.ts` 追加 `live` 字段，`transport.ts` 透传）；
- Python 端解析简单（`state.get("live")`）；
- LLM 能看到 cwd / activeFile / sshSessionId，回答更精准。

**局限**：
- 终端缓冲（最近 N 行输出）不传（数据量大，可能上百 KB）；
- agent 不能主动拉取终端缓冲（只能被动看 system prompt 里的摘要）。

### 6.3 方案 B：新增 Python 端终端工具（agent 主动拉取，P1）

**思路**：在 `strands_backend/tools/` 新增 `ops_get_terminal_output.py` 工具，让 agent 主动调用拉取终端缓冲。

**问题**：Python agent 无法直接访问前端终端缓冲（在 xterm.js 实例里）。

**解决方案**：通过 JSON-RPC 反向调用 Rust，Rust 通过 Tauri event 向前端请求终端缓冲。

**实现路径**（需要扩展双向 JSON-RPC）：

1. Python agent 调 `get_terminal_output` 工具；
2. 工具通过 `event_bus.publish(event_type="terminal_request", payload={"request_id": "...", "lines": 80})` 推送请求；
3. Rust `sidecar.rs` reader_task 收到 notification → emit `sidecar:terminal_request` Tauri event；
4. 前端 `sidecar-adapter.ts` 监听 `sidecar:terminal_request` → 从 xterm buffer 拿数据 → 调 `invoke('ipc_invoke', {method:'terminal.respond', params:{request_id, output}})` 回传；
5. Python 端 `terminal.respond` JSON-RPC 方法把结果存入 `_pending_terminal_requests` dict；
6. `get_terminal_output` 工具从 dict 拿结果返回给 agent。

**复杂度**：高（需要双向 JSON-RPC + 请求-响应匹配 + 超时机制）。

**P1 阶段实现**，P0 阶段先用方案 A 的 system prompt 摘要。

### 6.4 方案 C：通过 Rust Tauri command 直接拉（SSH session 已有 sshStore）

**思路**：agent 调 `ssh_command` 工具时，工具返回"建议命令"给前端，前端 invoke Rust `pty_exec` / `ssh_exec` 执行。

**这是当前 `suggest_command` Vercel SDK 工具的范式**（`terminal.ts:8-33`），迁移到 Python 侧：

```python
# strands_backend/tools/ops_ssh_command.py
from strands import tool

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
        dict: {command, explanation, risk_level, require_approval}
    """
    # 风险评估
    from tools.risk import invoke_risk_tool
    risk = invoke_risk_tool({"command": command})

    # 高风险：返回 needs-you 请求（不执行）
    if risk.get("require_approval"):
        return {
            "status": "needs_approval",
            "command": command,
            "explanation": explanation,
            "risk": risk,
        }

    # 低风险：返回建议命令（前端渲染 Execute 按钮）
    return {
        "status": "suggested",
        "command": command,
        "explanation": explanation,
        "risk_level": risk.get("level", "L0"),
    }
```

**前端渲染**：复用现有 `suggest_command` 卡片 UI，点击后调 Rust `pty_exec` / `ssh_exec`。

**优势**：
- 无需扩展双向 JSON-RPC；
- 风险评估集成（高风险触发 needs-you）；
- human-in-the-loop（用户审批才执行）。

**局限**：
- agent 不能直接拿到执行结果继续推理（需要用户点击 + 下次 `agent.invoke` 传回结果）；
- agentic loop 连续性被打断。

### 6.5 推荐组合方案

| 阶段 | 方案 | 收益 |
|------|------|------|
| **P0** | 方案 A（system prompt 注入）+ 方案 C（建议命令） | agent 能看到 cwd/activeFile/sshSessionId + 风险感知建议命令；无需协议扩展 |
| **P1** | 方案 B（终端缓冲拉取） | agent 能主动调 `get_terminal_output` 拿最近 N 行终端输出；需要双向 JSON-RPC |
| **P2** | 双向 JSON-RPC 完整扩展 | Python agent 能直接调 Rust SSH/SFTP 执行命令并拿结果；agentic loop 完整闭环 |

**P0 阶段已满足用户硬约束**（"AI 能看到当前终端环境"）：通过 system prompt 注入 cwd/activeFile/sshSessionId，agent 知道当前在哪个目录、连了哪台服务器。命令执行通过建议命令模式（human-in-the-loop），符合运维教学场景的安全要求。

---

## 7. 改造规模与风险评估

### 7.1 依赖变更

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/requirements.txt` 修改：

```diff
# 移除（LangGraph 后端，仅在 TDSF_AGENT_BACKEND=langgraph 时需要）
- langgraph>=0.2.0
- langchain-core>=0.3.0
- langchain-community>=0.3.0
- langchain-openai>=0.2.0
- langchain-anthropic>=0.2.0

# 新增（Strands 后端）
+ strands-agents>=1.0.0
+ strands-agents-tools>=1.0.0
+ litellm>=1.0.0  # Strands LiteLLMModel 依赖
```

**注意**：LangGraph 5 包暂时保留（feature flag 双后端并行），P2 阶段确认 Strands 稳定后再删除。

### 7.2 风险评估

| 风险 | 概率 | 影响 | 缓解 |
|------|------|------|------|
| Strands 1.0 API 变更（向后不兼容） | 中 | 高（适配层需重写） | Feature Flag 回滚 + 适配层隔离 |
| Strands 依赖冲突（与现有 pydantic/chromadb） | 低 | 中 | 虚拟环境隔离 + pip install 测试 |
| Strands 模型不支持 OpenAI 兼容端点 | 低 | 高（国内用户受影响） | 已确认 `OpenAIModel(base_url=...)` 支持 |
| 双向 JSON-RPC 扩展引入竞态 | 中 | 高（P2 阶段） | 请求-响应匹配 + 超时机制 + 单元测试 |
| 终端上下文注入导致 prompt 过长 | 低 | 低（system prompt 4 行） | 控制注入内容长度，仅关键信息 |
| 事件监听器泄漏（agent_message） | 中 | 中 | finally 块 unlisten + 单测验证 |

### 7.3 五绿门禁影响

| 门禁 | 影响 |
|------|------|
| `pnpm typecheck` | 0（前端协议不变，无新类型） |
| `pnpm lint` | 0 |
| `pnpm test` | 需新增 Strands 适配层单测（mock Strands Agent） |
| `pnpm build:web` | 0 |
| `pnpm tauri:dev` | 需实测 Strands 后端激活 + agent.invoke 调用 + 事件流 |

---

## 8. 实施路线图

### 8.1 P0（一天，1 人日）：适配层 + Feature Flag

**目标**：Strands 后端可激活，`agent.invoke` 走 Strands agentic loop，前端零改动。

**任务**：
1. 新建 `strands_backend/` 目录结构（8 个文件，约 1200 行）；
2. 实现 `model_adapter.py`（OpenAIModel / AnthropicModel / OllamaModel）；
3. 实现 `tool_adapter.py`（包装现有 9 个 tools 为 Strands @tool）；
4. 实现 `callback_handler.py`（Strands 事件 → event_bus）；
5. 实现 `agent_factory.py`（构建单 Agent，暂不多 Agent）；
6. 实现 `context.py`（方案 A：system prompt 注入）；
7. 修改 `main.py:332-358` 加 feature flag（不破坏现有）；
8. 修改 `agents/__init__.py` 加 `set_backend` 注入点；
9. 修改 `requirements.txt` 加 strands 依赖；
10. 单测：mock Strands Agent 验证 `invoke_strands_agent` 返回值结构；
11. 实测：`TDSF_AGENT_BACKEND=strands pnpm tauri:dev` 验证 agent.invoke 工作。

**验收**：
- `agent.invoke` 返回 `{observation, mood, tokens}`（与 LangGraph 后端一致）；
- 前端 `sidecar-adapter.ts` 切片流式正常；
- `ping` / `shutdown` / `status` 不受影响；
- Feature Flag 切换回 LangGraph 正常。

### 8.2 P1（一天，1 人日）：终端上下文 + 5 运维工具

**目标**：满足用户硬约束"AI 能看到当前终端环境"。

**任务**：
1. 实现 5 个运维工具（见配套文档 `ops-agent-tool-examples.md`）：
   - `ops_ssh_command.py`（建议命令模式 + 风险评估）；
   - `ops_read_remote_file.py`（通过 SFTP bridge 读取）；
   - `ops_analyze_logs.py`（日志分析：tail + grep + 模式匹配）；
   - `ops_query_processes.py`（进程查询：ps/pgrep）；
   - `ops_network_diagnose.py`（网络诊断：ping/ss/netstat）；
2. 修改 `transport.ts:122-145` 把 `live` 传给 `runSidecarStream`；
3. 修改 `sidecar-adapter.ts:337-343` 在 `state` 中追加 `live` 字段；
4. 修改 `sidecar-adapter.ts:211-276` 补齐 `sidecar:agent_message` 监听；
5. 实现方案 A 的前端改动 + Python 端 `context.py`；
6. 实测：用户输入"当前目录有什么文件"，agent 能基于 `live.cwd` 回答。

**验收**：
- agent 能在 system prompt 中看到 `cwd` / `activeFile` / `sshSessionId`；
- `ssh_command` 工具返回建议命令 + 风险评估；
- `sidecar:agent_message` 事件实时推送文本增量。

### 8.3 P2（半天，0.5 人日）：双向 JSON-RPC + 多 Agent

**目标**：Python agent 能直接调 Rust SSH/SFTP，agentic loop 完整闭环。

**任务**：
1. 扩展 JSON-RPC 协议支持 Python → Rust 请求（带 id + 等待响应）；
2. Rust 侧增加 `ssh.exec_in_session` / `sftp.read_file` / `sftp.write_file` 等 JSON-RPC handler；
3. Python 侧 `send_request(method, params)` 函数 + 请求-响应匹配 + 超时；
4. 实现 `multi_agent.py`（Agents-as-Tools 模式）；
5. 实测：agent 调 `ssh_command` 工具直接执行命令并拿结果继续推理。

**验收**：
- agent 调 `ssh_command("ls -la")` 直接拿到远程目录列表；
- 高风险命令触发 needs-you 请求；
- 多 Agent 路由正常（main → coding/teach/debug/...）。

---

## 9. 与现有方案（v1.0）的差异总结

| 维度 | v1.0 | v2.0（本文） |
|------|------|--------------|
| 调研基准 | Strands 预览版 + 5 项目 | Strands 1.0（2025-07-31 发布）+ 9 项目真实数据 |
| 选型依据 | 概念性对比 | 9 维度对比矩阵（含 Stars/License/生产验证） |
| 目录结构 | "8 个新增文件" | 完整 sub-package 树 + 每文件职责 + 行数预估 |
| main.py 集成 | 概念描述 | 确切插入位置（L332-358）+ feature flag 代码 |
| 模型适配 | "用 Strands Model" | `make_strands_model(config)` 完整实现 |
| 工具适配 | "包装现有 tools" | `wrap_existing_tools()` 完整实现 + 风险 pre-hook |
| 回调处理器 | "转发到 event_bus" | `TdsfCallbackHandler` 类完整实现 |
| 多 Agent | "用 Strands 多 Agent" | Agents-as-Tools 模式完整实现 |
| 前端链路 | "前端零改动" | 指出 transport.ts 不传 live 的缺口 + 修复方案 |
| 终端上下文 | 未提及 | 3 套方案（A/B/C）+ 推荐组合 + P0/P1/P2 路线图 |
| 协议演进 | "协议不变" | 指出 Python → Rust 反向调用缺口 + 双向 JSON-RPC 扩展 |
| 工具示例 | 无 | 配套文档 `ops-agent-tool-examples.md`（5 个运维工具） |
| 风险评估 | "保留 RiskEngine" | `risk_hook.py` pre-tool hook 完整实现 |

---

## 10. 配套文档

- **`docs/reports/ops-agent-tool-examples.md`**：5 个核心运维工具的 Python 完整实现（SSH 命令建议 / 远程文件读取 / 日志分析 / 进程查询 / 网络诊断），含 Strands `@tool` 装饰器用法 + RiskEngine 集成 + 与现有 `tools/*.py` 范式对齐。
- **`docs/reports/ops-agent-opensource-research.md`**：基础开源项目调研（Aider/OpenHands/LangGraph/Continue.dev/Shellfirm/destructive_command_guard）。
- **`docs/reports/ops-agent-deep-research.md`**：轻量 agent 框架 + 运维 agent + 终端集成 agent 深度调研。
- **`docs/reports/modded-agent-deep-audit.md`**：魔改版 AI Agent 深度可用性审查（含 mock LLM 告警链路断裂 + 终端上下文感知缺口）。

---

> **最后更新**：2026-07-30 · v2.0 深化版
> **上游参考**：<https://github.com/strands-agents/sdk-python>（Apache 2.0）
> **任务边界**：本文件仅为方案文档，不修改任何代码文件。
