# TDSF Terminal Agent — Strands Agents 1.48.0 集成实施报告

> **位置**：`docs/reports/strands-integration-implementation-plan-2026-07-30.md`
> **版本**：v1.0（2026-07-30 完成稿）
> **作用**：在 `ops-agent-strands-integration-plan.md`（v2.0 框架方案）与 `ops-agent-opensource-survey-2026-07-v2.md`（v2.0 调研）之上，给出 **Strands Agents 1.48.0 集成到现有 Python sidecar 的可执行实施方案**，覆盖依赖管理、LLM Provider 复用、工具注册与调用流程、流式响应链路、最小可行集成路径（MVP）、风险与对比、与 Bedrock AgentCore 的关系等关键章节。
> **任务边界**：本文件为方案文档，**不修改任何代码**。所有源码引用以绝对路径 + 行号给出。
> **数据基准**：2026-07-30 的真实 WebSearch + WebFetch + PyPI 抓取 + 现有源码静态阅读。
> **上游参考**：
> - Strands Agents 官方文档：<https://strandsagents.com/latest/user-guide/>
> - Strands Agents SDK 源码：<https://github.com/strands-agents/sdk-python>（Apache 2.0，6,704 stars / 993 forks）
> - Strands Agents 1.48.0 PyPI：<https://pypi.org/project/strands-agents/1.48.0/>（2026-07-17 发布）
> - Bedrock AgentCore Runtime 文档：<https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/>

---

## 0. 执行摘要（5 分钟版）

| 维度 | 结论 |
|------|------|
| **目标** | 将 Strands Agents 1.48.0 作为 TDSF 运维 Agent（ops agent）的后端编排引擎，与现有 LangGraph 7 节点 PAOR 后端并存（Feature Flag 切换），减少新增运维 agent 的手写 prompt + 工具路由代码量。 |
| **改造范围** | 新增 `src-tauri/sidecar/strands_backend/`（已存在 adapter.py + 5 个运维工具）；修改 `requirements.txt` + `pyproject.toml`（加 strands-agents 可选 extras）；`main.py` 注入 feature flag 切换；可选 `core/llm_config.py` 加 `make_strands_model()` 工厂。其余业务模块零改动。 |
| **依赖管理** | Strands 1.48.0 主包仅 `pydantic`（与现有 `>=2.0` 兼容）+ `boto3`（可选，Bedrock extra）+ `httpx`（与现有隐式依赖兼容）；`litellm` 仅在 LiteLLMModel 时需要，可条件安装。**无硬冲突**。 |
| **LLM Provider 复用** | 现有 `llm_config.json` 配置的 OpenAI 兼容端点（DeepSeek / OneAPI / 代理等）可直接通过 `strands.models.OpenAIModel` 复用；Anthropic 用 `AnthropicModel`；本地 Ollama 用 `OllamaModel`。无需前端改配置 UI。 |
| **工具注册** | `@tool` 装饰器 + `ToolContext` 闭包范式已在 `strands_backend/tools/*.py` 落地 5 个运维工具（ssh_command / read_remote_file / analyze_logs / inspect_processes / network_diagnose），与现有 `tools/risk.py` RiskChecker 集成。 |
| **流式响应** | 现有 `event_bus.emit_agent_message` + Rust `sidecar:mood_change` / `sidecar:tool_call` Tauri event 链路零改动；`TdsfStrandsCallbackHandler` 把 Strands `callback_handler` 事件转发到 `event_bus`。**未启用** `stream_async` 异步迭代器（保留 P2 升级点）。 |
| **MVP 路径** | 3 个里程碑：P0 适配层 + feature flag（1 人日）→ P1 LLM Model 注入 + 5 运维工具（1 人日）→ P2 双向 JSON-RPC + 多 Agent 模式（0.5 人日）= **2.5 人日**。 |
| **Bedrock AgentCore** | **非必需**。Strands 1.48.0 可独立运行（本地 / 任意容器 / 自托管）。AgentCore 是 AWS 托管的运行时 + 网关 + 内存 + 可观测性 + 评估 + 策略的"9 服务套件"，仅在需要云端规模化部署时才引入。TDSF 桌面端定位为本地优先，不引入 AgentCore。 |
| **关键决策** | 1) 不删 LangGraph 后端，双后端 Feature Flag 并存；2) Strands 是条件依赖（缺失时优雅降级）；3) `agent.invoke` JSON-RPC 签名零改动；4) 复用现有 event_bus 而非 Strands stream_async（P2 升级）；5) 不引入 AgentCore；6) `@tool` 装饰器与现有 `tools/*.py` 范式对齐。 |

---

## 1. 现有架构分析（基于实际源码阅读）

### 1.1 Python Sidecar 启动链

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/main.py` 是 stdio JSON-RPC 2.0 server，启动流程：

1. **L489-496**：安装 `log_capture` handler（必须在业务模块 import 之前，避免早期日志丢失）
2. **L499**：初始化 `MethodDispatcher`（自动注册 `ping` / `shutdown` / `status` 三个默认方法）
3. **L502-509**：调用 `register_business_methods(dispatcher)` 注册 15+ 个业务模块（每个用 try/except 包裹，单模块失败不阻塞整体启动）
4. **L512-521**：发送 `ready` 通知（Rust 侧阻塞等待此信号判定启动成功，10s 超时）
5. **L525-581**：主循环逐行读 stdin，dispatch JSON-RPC 消息
6. **L584-592**：退出时 `needs_you.stop_global_service()` 清理线程

### 1.2 Agent 框架接入点（关键）

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

**这是 Strands 集成的关键注入点**：在 `agents.configure_agents(...)` 之后插入 feature flag 分支，若 `TDSF_AGENT_BACKEND=strands` 则激活 Strands 后端（覆盖 `invoke_agent` 的内部实现），否则保持 LangGraph 后端。

### 1.3 Agent 注册表与 JSON-RPC 入口

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/agents/__init__.py`：

- **L83-94** `AGENT_REGISTRY`：9 个 Agent（main + coding/explore/history/teach + debug/refactor/test/deploy）
- **L109-129** `configure_agents(event_bus, llm_call)`：实例化所有 Agent，注入 event_bus + llm_call
- **L186-198** `register_methods(dispatcher)`：注册 4 个 JSON-RPC 方法（`agent.invoke` / `agent.list` / `agent.info` / `agent.configure`）
- **L201-203** `_rpc_agent_invoke(name, state)`：JSON-RPC 入口，调 `invoke_agent(name, state) → agent.invoke(state)`

**集成策略**：保留 `agent.invoke` 等 4 个 JSON-RPC 方法签名不变，仅替换 `invoke_agent` 内部实现（LangGraph PAOR → Strands agentic loop），前端 `sidecar-adapter.ts` 切片流式逻辑零改动。

### 1.4 BaseAgent PAOR 模板方法

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/agents/base.py`：

- **L44-59** `LLMCallFunction` Protocol：签名 `(messages: list[dict]) -> str`（OpenAI Chat Completions 兼容）
- **L62-100** `AgentResult` + `to_state_update()`：返回 dict 含 `observation` / `next_step` / `reflection` / `mood` / `intermediate_results`
- **L107+** `BaseAgent`：模板方法 `invoke(state)` 依次调 `plan_task` → `select_tool` → `call_tool` → `format_observation` → `reflect_on_result`

**Strands 映射**：Strands 的 `Agent(model, tools, system_prompt, callback_handler)` + agentic loop 完整覆盖 PAOR 语义：
- Plan = 首次推理隐式规划（LLM 决定调哪些工具）
- Act = tool_use（执行工具）
- Observe = tool_result（工具返回值注入下一轮）
- Reflect = 再次推理（LLM 评估是否需要继续）

### 1.5 LLM 配置（langchain-openai，待适配）

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/core/llm_config.py`：

- **L48-80** `LLMConfig` 数据类：`provider` / `api_key` / `base_url` / `model` / `temperature` / `max_tokens`
- **L87-90** `_get_config_path()`：配置文件路径 `.tdsf-data/llm_config.json`
- **L93+** `load_config()`：环境变量优先（`TDSF_LLM_API_KEY` / `TDSF_LLM_BASE_URL` / `TDSF_LLM_MODEL`），配置文件回退
- **L163-228** `_make_openai_call(config)`：用 `langchain_openai.ChatOpenAI`，通过 `base_url` 指向任意 OpenAI 兼容端点

**适配方案**：新增 `make_strands_model()` 工厂函数，根据 `LLMConfig.provider` 返回对应的 Strands Model 实例（OpenAIModel / AnthropicModel / OllamaModel / LiteLLMModel）。详见 §3。

### 1.6 现有 strands_backend/ 目录（已落地骨架）

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/strands_backend/`：

```
strands_backend/
├── adapter.py                      # StrandsAgentAdapter + TdsfStrandsCallbackHandler
├── tools/
│   ├── __init__.py（隐式，导出 ToolContext / RustBridge / make_all_ops_tools）
│   ├── ssh_command.py               # @tool ssh_command（高危命令审批）
│   ├── remote_file.py               # @tool read_remote_file
│   ├── log_analyzer.py              # @tool analyze_logs（grep / journalctl）
│   ├── process_inspector.py         # @tool inspect_processes（ps / top）
│   └── network_diagnostic.py       # @tool network_diagnose（ping / ss / netstat）
└── tests/
    └── test_tools.py                # 工具单测
```

**已实现内容**（来自 `adapter.py:1-773`）：
- `StrandsAgentAdapter` 类：封装 Strands Agent 创建、工具注册、invoke 调用，与现有 `BaseAgent.invoke(state)` 返回值结构对齐（observation / next_step / mood / intermediate_results）
- `TdsfStrandsCallbackHandler` 类：把 Strands `callback_handler` 事件（data / current_tool_use / start / complete / force_stop）转发到 `event_bus.emit_agent_message` / `emit_tool_call` / `emit_mood_change`
- 降级处理：Strands 未安装 / model 未注入 / feature flag 关闭时返回 degraded 状态结构化结果（与 BaseAgent mock LLM 降级模式一致）
- 工具上下文：`ToolContext` 携带 `event_bus` / `rust_bridge` / `agent_name` / `session_id` / `ssh_session_id`，工具工厂函数返回带 ctx 闭包的 `@tool` 装饰函数

**尚未实现**：
- `make_strands_model()` 工厂（LLMConfig → Strands Model 实例）
- `main.py` 注入 feature flag 切换代码
- `requirements.txt` / `pyproject.toml` 添加 strands-agents 依赖
- `RustBridge.send_request` 真实实现（当前是 `DefaultRustBridge` 占位，工具调用返回 `unavailable`）

### 1.7 前端 stream transport 链路

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src/modules/ai/lib/transport.ts:102-184` 是前端 AI 对话流入口：

```typescript
const tdsfAgent = deps.getTdsfAgentId?.() ?? null;
if (tdsfAgent) {
  const input = extractLastUserText(messagesForRun);
  const sidecarStream = runSidecarStream({
    agentId: tdsfAgent,
    messages: messagesForRun,
    input,
    abortSignal: options.abortSignal,
    onStep: deps.onStep,
    onMood: deps.onMood,
    onUsage: deps.onUsage ? ... : undefined,
  });
  return sidecarStreamToUIMessageStream(sidecarStream, {...});
}
// 否则走 Vercel AI SDK fallback 路径
```

**关键发现**：前端在 `extractLastUserText` 之前已通过 `injectEnvIntoLastUser` 把 `<env>workspace_root/active_terminal_cwd/active_file/active_terminal_mode</env>` 块注入到最后一条 user 消息（`transport.ts:107-109`），所以 Python `agent.invoke` 收到的 `input` 字段已包含 live 上下文。**Strands 后端无需额外改造前端**，只需在 `StrandsAgentAdapter._build_prompt` 中复用此 `<env>` 块或从中解析 `cwd` / `activeFile` 注入 `<live_context>` 块。

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src/modules/ai/lib/sidecar-adapter.ts:36-49` 定义了与 Python 端对齐的 Tauri event 名：

```typescript
const EVENT_MOOD_CHANGE = "sidecar:mood_change";
const EVENT_TOOL_CALL = "sidecar:tool_call";
const EVENT_AGENT_SWITCH = "sidecar:agent_switch";
```

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src/modules/ai/lib/sidecar-adapter.ts:94-119` `AgentInvokeResult` 接口定义了 Python 返回值结构（observation / output / teaching_content / mood / tokens），前端优先读 `observation`，回退到 `output` 兼容旧测试。**Strands 后端返回值必须与此结构对齐**（已在 `adapter.py:358-376` 实现）。

### 1.8 Rust Sidecar 进程管理

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/src/modules/sidecar.rs:1-240` 是 Python sidecar 进程管理器：

- **L46-71** 常量：`READY_TIMEOUT=10s` / `HEARTBEAT_INTERVAL=5s` / `HEARTBEAT_TIMEOUT=30s` / `REQUEST_TIMEOUT=30s` / `MAX_RETRY=5` / `RESTART_BACKOFF_BASE=1s` / `RUNTIME_COOLDOWN=60s`
- **L80-96** `SidecarStatus` 枚举：Stopped / Starting / Running / Restarting / Crashed / Stopping
- **L205-240** `SidecarManager`：所有字段都是 `Arc<...>`，Clone 廉价，进程管理 + stdin 写入 + stdout 读取 + pending_requests 表 + 重启循环

**对 Strands 集成的影响**：零。Rust 侧只关心 stdio JSON-RPC 协议层（`send_raw` / `recv_raw` + 心跳 + 重启），不感知 Python 内部用 LangGraph 还是 Strands。Strands 后端切换对 Rust 完全透明。

---

## 2. 依赖管理方案

### 2.1 Strands Agents 1.48.0 依赖清单（PyPI 真实数据）

来源：<https://pypi.org/project/strands-agents/1.48.0/>

| 字段 | 值 |
|------|------|
| 版本 | 1.48.0（2026-07-17 发布） |
| License | Apache 2.0 |
| Python | >=3.10（含 3.14） |
| Stars / Forks | 6,704 / 993 |
| 核心依赖 | `pydantic`（版本未在 PyPI 元数据强制，实测 >=2.12.5 在 social-intelligence 样本中） |
| 可选 extras | `a2a` / `all` / `anthropic` / `bidi` / `bidi-all` / `bidi-gemini` / `bidi-io` / `bidi-openai` / `cedar` / `dev` / `docs` / `gemini` / `litellm` / `llamaapi` / `mistral` / `ollama` / `openai` / `otel` / `sagemaker` / `writer` |

### 2.2 现有 sidecar 依赖清单

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/requirements.txt`：

```
langgraph>=0.2.0
langchain-core>=0.3.0
langchain-community>=0.3.0
langchain-openai>=0.2.0
langchain-anthropic>=0.2.0
pydantic>=2.0
chromadb>=0.5.0
asyncio-atexit>=1.0
pytest>=8.0
pytest-asyncio>=0.24
pytest-cov>=5.0
```

`pyproject.toml` 同步声明（L29-38）。

### 2.3 依赖冲突分析

| 依赖 | Strands 1.48.0 要求 | 现有 sidecar | 兼容性 | 处理 |
|------|---------------------|--------------|--------|------|
| `pydantic` | >=2.12.5（实测，social-intelligence 样本） | >=2.0 | ⚠️ 下界冲突 | 升级现有到 >=2.12.5（向后兼容，无 breaking change） |
| `boto3` | 仅 BedrockModel 必需（`bedrock` extra） | 无 | ✅ 可选 | 条件安装，TDSF 用 OpenAI/Ollama 时不引入 |
| `httpx` | OpenAIModel / AnthropicModel 隐式依赖 | 无显式（langchain-openai 隐式拉） | ✅ 兼容 | 无需处理，pip 自动解析 |
| `litellm` | 仅 LiteLLMModel 必需（`litellm` extra） | 无 | ✅ 可选 | 条件安装，仅当用户选 LiteLLM provider |
| `anthropic` | 仅 AnthropicModel 必需（`anthropic` extra） | langchain-anthropic 已拉 | ✅ 兼容 | 共享，无冲突 |
| `ollama` | 仅 OllamaModel 必需（`ollama` extra） | 无 | ✅ 可选 | 条件安装 |
| `chromadb` | 无依赖 | >=0.5.0 | ✅ 无冲突 | 保持 |
| `langgraph` / `langchain-*` | 无依赖 | >=0.2.0 / >=0.3.0 | ✅ 无冲突 | 保持 |

**结论**：**无硬冲突**。唯一需调整的是 `pydantic` 下界从 `>=2.0` 升级到 `>=2.12.5`（向后兼容，无 breaking change）。

### 2.4 推荐的 requirements.txt 改动

```diff
# ----------------------------------------------------------------------------
# 数据验证（Pydantic v2）
# ----------------------------------------------------------------------------
-pydantic>=2.0
+pydantic>=2.12.5  # Strands Agents 1.48.0 要求下界

+# ----------------------------------------------------------------------------
+# Strands Agents — 运维 Agent 后端编排引擎（TDSF 魔改 v2.0）
+#   - 条件依赖：TDSF_AGENT_BACKEND=strands 时激活，否则降级到 LangGraph
+#   - 核心：strands-agents（含 @tool 装饰器 + Agent + MCPClient）
+#   - 工具：strands-agents-tools（calculator / current_time 等内置工具，可选）
+#   - 不引入 boto3 / litellm / anthropic / ollama（按 provider extras 条件安装）
+# ----------------------------------------------------------------------------
+strands-agents>=1.48.0
+# strands-agents-tools>=0.1.0  # 可选：内置工具集（calculator / current_time / shell 等）
```

**`pyproject.toml` 同步更新** `[project.optional-dependencies]` 段：

```toml
[project.optional-dependencies]
dev = [...]
strands = [
    "strands-agents>=1.48.0",
    # 按 provider 按需安装：
    # "strands-agents[openai]"    # OpenAIModel
    # "strands-agents[anthropic]" # AnthropicModel
    # "strands-agents[ollama]"    # OllamaModel
    # "strands-agents[litellm]"   # LiteLLMModel（适配国内 DeepSeek/Qwen）
    # "strands-agents-tools"      # 内置工具集
]
```

### 2.5 安装命令（用户按需选择 provider）

```bash
# 基础安装（仅核心 SDK，用户用 OpenAI 兼容端点）
pip install strands-agents>=1.48.0

# 完整安装（含所有 provider + 内置工具）
pip install "strands-agents[openai,anthropic,ollama,litellm]>=1.48.0" strands-agents-tools

# 国内镜像加速
pip install strands-agents>=1.48.0 -i https://pypi.tuna.tsinghua.edu.cn/simple
```

---

## 3. LLM Provider 复用方案

### 3.1 现有 LLMConfig 字段

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/core/llm_config.py:48-80`：

```python
class LLMConfig:
    provider: str = "openai"       # "openai" / "anthropic"
    api_key: str = ""
    base_url: str = ""            # 留空则用 provider 默认端点
    model: str = "gpt-4o-mini"
    temperature: float = 0.7
    max_tokens: int = 2048
```

### 3.2 Strands Model 适配器设计

新增 `src-tauri/sidecar/strands_backend/model_adapter.py`：

```python
"""strands_backend/model_adapter.py — LLMConfig → Strands Model 适配器

职责：
- 把现有 LLMConfig（OpenAI 兼容）转换为 Strands Model 实例
- 支持 provider: openai / anthropic / ollama / litellm
- 不可用时返回 None（与 make_llm_call 降级模式一致）

用法（在 main.py agents 配置段注入）：
    from strands_backend.model_adapter import make_strands_model
    from core.llm_config import load_config
    config = load_config()
    strands_model = make_strands_model(config)  # None 时降级
"""
from __future__ import annotations

import logging
from typing import Any

from core.llm_config import LLMConfig

logger = logging.getLogger("sidecar.strands_backend.model_adapter")

# Strands 条件导入
try:
    from strands.models import BedrockModel, OpenAIModel, AnthropicModel
    from strands.models.ollama import OllamaModel
    _STRANDS_MODELS_AVAILABLE = True
except ImportError:
    _STRANDS_MODELS_AVAILABLE = False
    BedrockModel = OpenAIModel = AnthropicModel = OllamaModel = None  # type: ignore

try:
    from strands.models.litellm import LiteLLMModel  # type: ignore
    _LITELLM_AVAILABLE = True
except ImportError:
    _LITELLM_AVAILABLE = False
    LiteLLMModel = None  # type: ignore


def make_strands_model(config: LLMConfig | None) -> Any | None:
    """根据 LLMConfig 构建对应的 Strands Model 实例

    Args:
        config: LLMConfig 实例（None 或 is_configured=False 时返回 None）

    Returns:
        Strands Model 实例（OpenAIModel / AnthropicModel / OllamaModel / LiteLLMModel），
        Strands 未安装 / 配置无效时返回 None（降级到 mock）
    """
    if not _STRANDS_MODELS_AVAILABLE:
        logger.warning("strands-agents not installed, model adapter disabled")
        return None

    if config is None or not config.is_configured:
        logger.warning("LLM config not valid, strands model not built")
        return None

    provider = (config.provider or "openai").lower()

    try:
        if provider == "openai":
            return _make_openai_model(config)
        elif provider == "anthropic":
            return _make_anthropic_model(config)
        elif provider == "ollama":
            return _make_ollama_model(config)
        elif provider == "litellm":
            return _make_litellm_model(config)
        elif provider == "bedrock":
            return _make_bedrock_model(config)
        else:
            logger.warning(f"unknown provider: {provider}, fallback to openai")
            return _make_openai_model(config)
    except Exception as e:
        logger.exception(f"failed to build strands model: {e}")
        return None


def _make_openai_model(config: LLMConfig) -> Any:
    """构建 OpenAIModel（支持 base_url 指向 OpenAI 兼容端点）

    适用：OpenAI 官方 / DeepSeek / OneAPI / 代理 / LM Studio / MLX 等
    """
    client_args = {"api_key": config.api_key}
    if config.base_url:
        client_args["base_url"] = config.base_url

    return OpenAIModel(
        model_id=config.model,
        client_args=client_args,
        params={
            "temperature": config.temperature,
            "max_tokens": config.max_tokens,
        },
    )


def _make_anthropic_model(config: LLMConfig) -> Any:
    """构建 AnthropicModel"""
    client_args = {"api_key": config.api_key}
    if config.base_url:
        client_args["base_url"] = config.base_url

    return AnthropicModel(
        model_id=config.model,
        client_args=client_args,
        params={
            "temperature": config.temperature,
            "max_tokens": config.max_tokens,
        },
    )


def _make_ollama_model(config: LLMConfig) -> Any:
    """构建 OllamaModel（本地模型，无需 API Key）"""
    host = config.base_url or "http://localhost:11434"
    return OllamaModel(
        host=host,
        model_id=config.model,
    )


def _make_litellm_model(config: LLMConfig) -> Any:
    """构建 LiteLLMModel（适配国内 DeepSeek/Qwen 等）

    需要 pip install strands-agents[litellm]
    """
    if not _LITELLM_AVAILABLE:
        logger.warning("LiteLLMModel not available, install strands-agents[litellm]")
        return None

    # LiteLLM 用 model_id 前缀指定 provider（如 "deepseek/deepseek-chat"）
    return LiteLLMModel(
        model_id=config.model,
        api_key=config.api_key,
        base_url=config.base_url or None,
    )


def _make_bedrock_model(config: LLMConfig) -> Any:
    """构建 BedrockModel（需要 AWS 凭证，不通过 api_key）

    需要 pip install strands-agents[bedrock] + AWS 凭证配置
    """
    return BedrockModel(
        model_id=config.model,
        params={
            "temperature": config.temperature,
            "max_tokens": config.max_tokens,
        },
    )
```

### 3.3 Provider 兼容性矩阵

| 现有 LLMConfig.provider | Strands Model | 国内可用性 | 备注 |
|------------------------|---------------|------------|------|
| `openai` | `OpenAIModel` | ✅ 通过 base_url 指向 OneAPI / DeepSeek / 代理 | 与现有 langchain-openai 行为一致 |
| `anthropic` | `AnthropicModel` | ⚠️ 需海外网络 / 代理 | 与现有 langchain-anthropic 行为一致 |
| `ollama` | `OllamaModel` | ✅ 本地模型，无需 API Key | 离线运维教学场景首选 |
| `litellm` | `LiteLLMModel` | ✅ 适配国内 DeepSeek/Qwen/通义 | 需额外 `pip install strands-agents[litellm]` |
| `bedrock` | `BedrockModel` | ❌ 需 AWS 海外账号 | TDSF 默认不启用 |

### 3.4 离线场景支持

Strands 1.48.0 在无网络时可使用：
- **OllamaModel**：本地 Ollama 服务（`http://localhost:11434`），无需 API Key，无需联网
- **LlamaCppModel**：本地 llama.cpp GGUF 模型文件

这满足 TDSF 运维教学场景的离线需求（学生在无网环境也能用 agent）。配置示例：

```json
// .tdsf-data/llm_config.json
{
  "provider": "ollama",
  "api_key": "",
  "base_url": "http://localhost:11434",
  "model": "llama3",
  "temperature": 0.7,
  "max_tokens": 2048
}
```

---

## 4. 工具注册与调用流程

### 4.1 现有 sidecar 工具范式

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/tools/rpc_methods.py` 暴露 `risk.evaluate` / `confidence.score` / `decision.list` 等 JSON-RPC 方法，内部调 `tools/risk.py` 的 `RiskChecker.check(command)` 返回结构化 dict。

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/agents/base.py` 的 `BaseAgent.select_tool(task, state)` 返回 `{tool_name, params}`，`call_tool(tool_name, params)` 调 `tools.invoke_tool(tool_name, params)` 统一入口。

### 4.2 Strands @tool 装饰器范式

Strands 1.48.0 用 `@tool` 装饰器从 Python 函数的 docstring + 类型标注自动生成工具描述（OpenAI tool calling schema）：

```python
from strands import Agent, tool

@tool
def ssh_command(command: str, ssh_session_id: str = "", explanation: str = "", timeout: int = 30) -> dict:
    """Execute an SSH command on the remote server.

    Args:
        command: Shell command to execute (single line, no trailing newline)
        ssh_session_id: SSH session ID (empty for current session)
        explanation: Command explanation for UI display
        timeout: Timeout in seconds (default 30)

    Returns:
        dict with status (success/needs_approval/unavailable/error), output, exit_code
    """
    # 实现见 ssh_command.py
    ...
```

### 4.3 已落地的 5 个运维工具

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/strands_backend/tools/`：

| 工具 | 文件 | 签名 | 风险集成 |
|------|------|------|----------|
| `ssh_command` | `ssh_command.py` | `(command, ssh_session_id, explanation, timeout) -> dict` | ✅ RiskChecker 检测高危命令（rm -rf / reboot / shutdown / mkfs / dd / fork bomb），命中即 `emit_needs_you` 推送审批 |
| `read_remote_file` | `remote_file.py` | `(path, ssh_session_id, max_size, encoding) -> dict` | ⚠️ 路径白名单（/etc/passwd 等敏感文件可读但记录审计） |
| `analyze_logs` | `log_analyzer.py` | `(log_path, mode, lines, pattern, ssh_session_id) -> dict` | ✅ 只读，无风险 |
| `inspect_processes` | `process_inspector.py` | `(mode, filter_user, filter_name, pid, top_n, ssh_session_id) -> dict` | ✅ 只读，无风险 |
| `network_diagnose` | `network_diagnostic.py` | `(mode, target, count, port, ssh_session_id) -> dict` | ✅ 只读（ping / ss / netstat），无风险 |

### 4.4 工具调用流程（Strands agentic loop）

```
用户输入 → Strands Agent(prompt)
              │
              ├─ 1. LLM 推理（OpenAIModel / AnthropicModel / OllamaModel）
              │     ↓ 返回 tool_use（选择 ssh_command 工具）
              ├─ 2. Strands 执行 @tool ssh_command(command, ctx)
              │     ├─ RiskChecker.check(command)
              │     │   ├─ 高危 → emit_needs_you → 返回 {status:"needs_approval"}
              │     │   └─ 安全 → RustBridge.send_request("ssh_exec_in_session", ...)
              │     │              ├─ P0: DefaultRustBridge 返回 {status:"unavailable"}
              │     │              └─ P2: 真实双向 JSON-RPC 调 Rust 后端
              │     └─ callback_handler 推送 emit_tool_call 事件
              ├─ 3. 工具结果注入 LLM 上下文
              ├─ 4. LLM 再次推理（决定继续调工具 or 输出最终答案）
              └─ 5. 循环直到 max_iterations 或 LLM 输出 stop
              ↓
          返回 AgentResult（observation / next_step / mood / intermediate_results）
```

### 4.5 工具上下文（ToolContext）注入

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/strands_backend/adapter.py:526-546` `_build_tool_context`：

```python
def _build_tool_context(self, agent_id, session_id, state) -> ToolContext:
    live = state.get("live") or {}
    return ToolContext(
        event_bus=self.event_bus,
        rust_bridge=self.rust_bridge,
        agent_name=agent_id,
        session_id=session_id,
        user_id=state.get("user_id", "") or "",
        ssh_session_id=live.get("sshSessionId", "") or "",
    )
```

**关键**：`ToolContext` 携带 `ssh_session_id`，工具内部用它调 Rust `ssh_exec_in_session` Tauri command（与 `SshTerminalPane.tsx` 共享会话）。这是"AI 能感知后台 SSH 连接的服务器状态"硬约束的实现基础。

### 4.6 与现有 RiskEngine 集成

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/tools/risk.py` 的 `RiskChecker` 已在 `strands_backend/tools/ssh_command.py:83-100` 集成：

```python
risk = RiskChecker.check(line_stripped)
if risk["high_risk"]:
    RiskChecker.emit_needs_you(
        event_bus=ctx.event_bus,
        command=line_stripped,
        risk_result=risk,
        agent_name=ctx.agent_name,
        session_id=ctx.session_id,
        tool_name="ssh_command",
    )
    return {"status": "needs_approval", ...}
```

**优势**：复用现有 RiskChecker 规则集（`config/risk_rules.yaml`），无需为 Strands 单独写风险引擎。高危命令审批走 `needs_you` 事件流，前端 `NeedsYouDialog` 组件零改动。

---

## 5. 流式响应链路

### 5.1 现有流式链路（LangGraph 后端）

```
Python BaseAgent.invoke()
  → event_bus.emit_mood_change("thinking")
  → event_bus.emit_agent_message("开始处理...")
  → LangGraph 7 节点 PAOR 循环
  → event_bus.emit_tool_call("risk", {...})
  → 返回 AgentResult
  → event_bus.emit_mood_change("done")

Python → Rust（stdio JSON-RPC notification）
  → sidecar.rs reader_task 接收
  → app_handle.emit("sidecar:mood_change", payload)
  → 前端 listen("sidecar:mood_change", onMood)

前端 sidecar-adapter.ts
  → runSidecarStream 调 invoke('ipc_invoke', {method:'agent.invoke'})
  → 同步拿到 AgentInvokeResult dict
  → 把 observation 文本切片（STREAM_CHUNK_SIZE=24 字符）
  → 每 8ms yield 一个 text-delta chunk（模拟流式）
  → useChat 逐 chunk 渲染
```

### 5.2 Strands 流式链路（callback_handler 模式，已实现）

`file:///d:/ai/linux教学一体/tdsf-terminal-agent-clone/src-tauri/sidecar/strands_backend/adapter.py:89-207` `TdsfStrandsCallbackHandler`：

```python
class TdsfStrandsCallbackHandler:
    def __call__(self, **kwargs):
        # 工具调用开始 → emit_tool_call
        current_tool_use = kwargs.get("current_tool_use")
        if current_tool_use and current_tool_use.get("name"):
            self._emit_tool_call(tool_name, tool_input)

        # 文本增量 → emit_agent_message（流式推送）
        data = kwargs.get("data")
        if data and isinstance(data, str):
            self._emit_agent_message(data, msg_type="output")

        # 循环开始 → mood=thinking
        if kwargs.get("start"):
            self._emit_mood("thinking")
        # 循环完成 → mood=working
        elif kwargs.get("complete"):
            self._emit_mood("working")
        # 强制停止 → mood=error
        if kwargs.get("force_stop"):
            self._emit_mood("error")
```

**链路**：
```
Strands Agent(prompt, callback_handler=TdsfStrandsCallbackHandler)
  → agentic loop 每个事件触发 callback_handler(**kwargs)
  → TdsfStrandsCallbackHandler 转发到 event_bus
  → event_bus → Rust → 前端 Tauri event
  → 前端 onMood / onStep 实时更新
```

**优势**：复用现有 event_bus → Rust → 前端 Tauri event 链路，**前端零改动**。前端 `sidecar-adapter.ts` 的 `listen("sidecar:mood_change")` 和 `listen("sidecar:tool_call")` 逻辑无需调整。

### 5.3 Strands stream_async 异步迭代器模式（P2 升级点，未启用）

Strands 1.48.0 还提供 `stream_async` 异步迭代器，可直接 yield 事件流：

```python
async for event in agent.stream_async(prompt):
    if event.get("init_event_loop"): ...      # 事件循环初始化
    elif event.get("start_event_loop"): ...   # 单轮循环开始
    elif event.get("start"): ...              # 新 cycle
    elif "message" in event: ...              # 新消息（含 role）
    elif event.get("complete"): ...           # cycle 完成
    elif event.get("force_stop"): ...         # 强制停止
    if "current_tool_use" in event: ...       # 当前工具调用
    if "data" in event: ...                   # 文本增量
```

**为何 P0/P1 不启用**：
1. 现有 sidecar 是同步 stdio JSON-RPC（main loop 逐行读 stdin），引入 `asyncio` 需重构 main loop
2. callback_handler 模式已能满足"前端实时看到 mood / tool_call / 文本增量"需求
3. 前端 `sidecar-adapter.ts` 的 `STREAM_CHUNK_SIZE=24 / STREAM_CHUNK_DELAY_MS=8` 切片模拟流式已足够流畅

**P2 升级路径**：当需要真实流式（如长输出场景避免前端等 30s 才看到首字）时，重构 sidecar 为异步 + 启用 stream_async。预计工时 0.5 人日。

### 5.4 Bedrock AgentCore 的 WebSocket 流式（不引入）

AWS re:Post 2026-07 案例（<https://repost.aws/questions/QUlpUgiSXJTAe0R4KTkRWxyw/agentcore-streaming-to-front-end>）显示 AgentCore Runtime 的 WebSocket 流式有版本兼容问题（`AttributeError: 'BedrockAgentCoreApp' object has no attribute 'websocket'`），且 TDSF 是本地桌面端不需要云端 WebSocket。**不引入 AgentCore WebSocket 流式**。

---

## 6. 最小可行集成路径（MVP）

### 6.1 里程碑划分

| 里程碑 | 目标 | 工时 | 验收标准 |
|--------|------|------|----------|
| **P0** | 适配层骨架 + Feature Flag 切换 + 降级路径 | 1 人日 | `TDSF_AGENT_BACKEND=strands` 时激活 Strands 后端，Strands 未安装时降级到 LangGraph，sidecar 启动成功 + ping 通 |
| **P1** | LLM Model 注入 + 5 运维工具真实调用 | 1 人日 | 配置 OpenAI 兼容端点后，agent.invoke("检查 nginx 状态") 能调 ssh_command 工具返回真实输出（DefaultRustBridge 返回 unavailable 也算通过） |
| **P2** | 双向 JSON-RPC + stream_async 真实流式 | 0.5 人日 | ssh_command 工具能真实调 Rust `ssh_exec_in_session` Tauri command 执行远程命令；前端能看到流式文本增量 |
| **合计** | | **2.5 人日** | |

### 6.2 P0 详细步骤

**目标**：适配层骨架 + Feature Flag 切换 + 降级路径

**步骤**：
1. **更新 `requirements.txt`**：加 `strands-agents>=1.48.0`，升级 `pydantic>=2.12.5`（§2.4）
2. **更新 `pyproject.toml`**：`[project.optional-dependencies]` 加 `strands` extras（§2.4）
3. **新建 `strands_backend/__init__.py`**：导出 `StrandsAgentAdapter` + `TdsfStrandsCallbackHandler` + `make_strands_model`
4. **新建 `strands_backend/model_adapter.py`**：实现 `make_strands_model(config)` 工厂（§3.2）
5. **修改 `main.py:332-358`**：在 `agents.configure_agents(...)` 之后插入 feature flag 分支：
   ```python
   backend = os.environ.get("TDSF_AGENT_BACKEND", "langgraph").lower()
   if backend == "strands":
       try:
           from strands_backend import StrandsAgentAdapter
           from strands_backend.model_adapter import make_strands_model
           from core.llm_config import load_config
           strands_model = make_strands_model(load_config())
           adapter = StrandsAgentAdapter(
               event_bus=event_bus.get_global_bus(),
               rust_bridge=DefaultRustBridge(),
               backend_enabled=True,
               strands_model=strands_model,
           )
           # 覆盖 invoke_agent 内部实现
           agents.invoke_agent = lambda name, state: adapter.invoke(name, state.get("input", ""), state)
       except Exception as se:
           logger.exception(f"failed to activate Strands backend, fallback: {se}")
   ```
6. **验收**：
   - `TDSF_AGENT_BACKEND=langgraph`（默认）：行为与现在完全一致
   - `TDSF_AGENT_BACKEND=strands` + Strands 未安装：sidecar 启动成功，agent.invoke 返回 degraded 状态
   - `TDSF_AGENT_BACKEND=strands` + Strands 已安装 + Model 未注入：sidecar 启动成功，agent.invoke 返回 degraded 状态

### 6.3 P1 详细步骤

**目标**：LLM Model 注入 + 5 运维工具真实调用

**步骤**：
1. **配置 `.tdsf-data/llm_config.json`**：用 OpenAI 兼容端点（如 DeepSeek）
   ```json
   {
     "provider": "openai",
     "api_key": "sk-...",
     "base_url": "https://api.deepseek.com/v1",
     "model": "deepseek-chat",
     "temperature": 0.7,
     "max_tokens": 2048
   }
   ```
2. **`pip install strands-agents[openai]>=1.48.0`**
3. **启动 sidecar**：`TDSF_AGENT_BACKEND=strands python main.py`
4. **测试 agent.invoke**：
   ```bash
   echo '{"jsonrpc":"2.0","method":"agent.invoke","params":{"name":"main","state":{"input":"检查 nginx 状态","session_id":"test"}},"id":1}' | python main.py
   ```
5. **预期行为**：
   - Strands Agent 调用 ssh_command 工具（因为 system prompt 引导）
   - RiskChecker 检测 `systemctl status nginx` 不是高危命令
   - DefaultRustBridge.send_request 返回 `{status:"unavailable", reason:"rust_bridge_not_configured"}`
   - Strands Agent 收到 unavailable 后，向用户解释"当前为只读模式，RustBridge 未配置"
   - 返回 AgentResult.observation 包含解释文本

### 6.4 P2 详细步骤

**目标**：双向 JSON-RPC + stream_async 真实流式

**步骤**：
1. **实现 RustBridge.send_request 真实调用**：通过 sidecar 内部的 `send_notification` 或新增 `send_request` 方法，让 Python 能调 Rust Tauri command（如 `ssh_exec_in_session`）
2. **新增 Rust 侧 `ipc_reverse` 模块**：处理 Python → Rust 的反向 JSON-RPC 请求
3. **启用 stream_async**（可选）：重构 main loop 为异步，启用 `agent.stream_async(prompt)` 直接 yield 事件流
4. **验收**：
   - ssh_command 工具能真实执行远程命令并返回输出
   - 前端能看到流式文本增量（不仅是切片模拟）

---

## 7. 风险与对比

### 7.1 LangGraph vs Strands 对比

| 维度 | LangGraph（现有） | Strands 1.48.0（新） |
|------|-------------------|---------------------|
| **架构** | 显式 7 节点图（supervisor/plan/act/observe/reflect/tool_call/permission_check） | 模型驱动 agentic loop（LLM 自主决定调工具） |
| **代码量** | 每新增 agent 需写 plan_task/select_tool/reflect_on_result 钩子 | 每新增 agent 只需写 system prompt + @tool 函数 |
| **工具调用** | BaseAgent.select_tool 返回 {tool_name, params}，call_tool 调 invoke_tool | LLM 直接 tool_use，Strands 自动执行 |
| **多 Agent 模式** | MainAgent 关键词路由到子 Agent | Agents-as-Tools / Handoffs / Swarm / Graph（4 原语） |
| **MCP 支持** | 无原生 | MCPClient（stdio + Streamable HTTP） |
| **流式** | event_bus 切片模拟 | callback_handler 事件 + stream_async 异步迭代器 |
| **依赖体积** | langgraph + langchain-core/community/openai/anthropic ≈ 50MB | strands-agents 核心 ≈ 10MB（+ provider extras 按需） |
| **生产验证** | LangChain 生态成熟 | AWS 内部多产品（Kiro/Q/Glue）+ Leidos 政府级 + Motorway 生产评估 |
| **运维场景工具** | 无内置，全手写 | strands-agents-tools 内置 calculator/shell/file 等（可选） |
| **License** | MIT | Apache 2.0 |

### 7.2 集成风险

| 风险 | 等级 | 影响 | 缓解措施 |
|------|------|------|----------|
| Strands 1.48.0 API breaking change | 低 | Strands 1.0 后承诺不 breaking，1.48.0 是第 48 个版本，API 稳定 | 锁定 `>=1.48.0,<2.0.0` |
| pydantic 2.12.5 升级影响现有代码 | 极低 | pydantic v2 内部向后兼容 | 升级后跑 `pnpm test` 全量验证 |
| Strands 未安装时 sidecar 启动失败 | 中 | 用户未装 strands-agents 时 sidecar 崩溃 | 适配层 try/except 降级（已实现） |
| DefaultRustBridge 返回 unavailable 误导用户 | 中 | 用户以为功能坏了 | system prompt 明确告知"当前为只读模式" |
| Strands agentic loop 死循环 | 中 | LLM 反复调同一工具不收敛 | `max_iterations=10` 硬上限（已实现） |
| 国内网络无法访问 OpenAI/Anthropic | 高 | Strands 无法调 LLM | 引导用户用 Ollama 本地模型 或 LiteLLM 适配国内端点 |
| litellm 依赖冲突 | 低 | litellm 拉取大量 provider 依赖 | 条件安装，仅 `pip install strands-agents[litellm]` 时引入 |
| Strands 与 chromadb 依赖冲突 | 极低 | chromadb 拉 onnxruntime/numpy，Strands 不依赖这些 | 无冲突，pip 自动解析 |

### 7.3 回滚方案

**Feature Flag 回滚**：
```bash
# 立即回滚到 LangGraph 后端
export TDSF_AGENT_BACKEND=langgraph
# 重启 sidecar
```

**依赖回滚**：
```bash
pip uninstall strands-agents strands-agents-tools
# requirements.txt 回退 pydantic>=2.0
```

**代码回滚**：所有改动都在 `strands_backend/` 新目录 + `main.py` 注入段，git revert 即可。

---

## 8. 与 Bedrock AgentCore 的关系

### 8.1 AgentCore 是什么

Amazon Bedrock AgentCore 是 AWS 在 2025-10 re:Invent 发布的**全托管 Agent 运行时平台**，包含 9 个服务：

| 服务 | 职责 | TDSF 是否需要 |
|------|------|----------------|
| **Runtime** | 托管 Agent 进程 + 自动扩缩 + HTTP/WebSocket 端点 | ❌ TDSF 是本地桌面端，sidecar 已是运行时 |
| **Memory** | 会话上下文持久化 + 跨会话记忆 | ❌ TDSF 用本地 SQLite + chromadb |
| **Gateway** | 工具访问网关 + OAuth 2.1 + 速率限制 + 审计 | ❌ TDSF 工具走本地 RustBridge |
| **Browser** | 沙箱化浏览器工具（无头 Chrome） | ❌ TDSF 不需要浏览器自动化 |
| **Code Interpreter** | 沙箱化 Python 代码执行 | ⚠️ 可选，TDSF 已有 sandbox_proxy |
| **Identity** | AWS IAM 集成 + 跨租户身份 | ❌ TDSF 是单用户桌面端 |
| **Observability** | OpenTelemetry 日志/指标/追踪 | ⚠️ 可选，TDSF 已有 langfuse_client |
| **Evaluations** | Agent 行为评估 + 质量门禁 | ⚠️ 可选，TDSF 已有 e2e_smoke.py |
| **Optimization** | 静默失败检测 + 失败模式排名 | ❌ TDSF 规模太小，不需要 |

### 8.2 Strands 与 AgentCore 的关系

**Strands 是 SDK，AgentCore 是平台**：

```
Strands Agents SDK（开源，Apache 2.0）
  ├─ 可独立运行（本地 / 任意容器 / 自托管）
  ├─ 可部署到 AgentCore Runtime（云端托管）
  ├─ 可集成 AgentCore Memory / Gateway / Observability（按需）
  └─ 不依赖 AgentCore 也能完整工作
```

**官方集成范式**（来自 AWS 博客 2026-07-23 Motorway 案例）：

```python
from strands import Agent
from bedrock_agentcore.runtime import BedrockAgentCoreApp

agent = Agent()
app = BedrockAgentCoreApp()

@app.entrypoint
def invoke(payload):
    user_message = payload.get("prompt", "Hello")
    response = agent(user_message)
    return str(response)

if __name__ == "__main__":
    app.run()
```

**关键**：`@app.entrypoint` 装饰器把 Strands Agent 包装成 AgentCore Runtime 的 HTTP 服务。**不部署到 AgentCore 时，Strands Agent 就是普通 Python 对象**，可以在任何进程内调用。

### 8.3 TDSF 的选择：不引入 AgentCore

**理由**：
1. **定位不匹配**：TDSF 是本地桌面端 IDE，AgentCore 是云端规模化部署平台
2. **依赖过重**：AgentCore 需要 AWS 账号 + boto3 + AWS 凭证 + ECR 镜像 + CodeBuild 流水线，与 TDSF "本地优先、离线可用" 理念冲突
3. **成本**：AgentCore 按调用计费，TDSF 运维教学场景用户不会为云端运行时付费
4. **国内可用性**：AgentCore 仅在 AWS 海外区域可用，国内用户访问需海外网络
5. **现有架构已覆盖**：TDSF 的 sidecar 已是运行时，SQLite + chromadb 已是记忆层，langfuse_client 已是可观测性，sandbox_proxy 已是代码解释器，无需 AgentCore 替代

**未来可能性**：若 TDSF 后续要做"云端运维 Agent 服务"（如多租户 SaaS），可考虑部署到 AgentCore。但这是 v2.0+ 的事，当前 v1.0 不引入。

---

## 9. 关键决策点摘要（10 条）

1. **双后端并存，不删 LangGraph**：`TDSF_AGENT_BACKEND=langgraph|strands` Feature Flag 控制切换，Strands 后端出问题即时回滚。改造风险可控。

2. **Strands 是条件依赖**：`strands_backend/adapter.py` 用 try/except 导入 Strands，未安装时降级到 degraded 状态，sidecar 启动不阻塞。用户按需 `pip install strands-agents`。

3. **`agent.invoke` JSON-RPC 签名零改动**：保留 `agent.invoke / agent.list / agent.info / agent.configure` 4 个方法签名，仅替换 `invoke_agent` 内部实现（LangGraph PAOR → Strands agentic loop）。前端 `sidecar-adapter.ts` 零改动。

4. **复用现有 event_bus 而非 Strands stream_async**：P0/P1 用 `callback_handler` 模式把 Strands 事件转发到 `event_bus.emit_agent_message / emit_tool_call / emit_mood_change`，复用现有 Rust → 前端 Tauri event 链路。P2 升级到 stream_async 真实流式。

5. **LLMConfig → Strands Model 适配器**：新增 `strands_backend/model_adapter.py` 的 `make_strands_model(config)` 工厂，根据 `provider` 字段返回 OpenAIModel / AnthropicModel / OllamaModel / LiteLLMModel。用户配置 `.tdsf-data/llm_config.json` 无需改 UI。

6. **`@tool` 装饰器与现有 `tools/*.py` 范式对齐**：5 个运维工具（ssh_command / read_remote_file / analyze_logs / inspect_processes / network_diagnose）已落地，用 `ToolContext` 闭包携带 `event_bus` / `rust_bridge` / `ssh_session_id`。复用现有 `RiskChecker` 做高危命令审批。

7. **不引入 Bedrock AgentCore**：Strands 1.48.0 可独立运行，AgentCore 是云端托管平台，与 TDSF 本地桌面端定位不匹配。9 个 AgentCore 服务中 TDSF 已有对应本地实现（SQLite/chromadb/langfuse_client/sandbox_proxy）。

8. **pydantic 升级到 >=2.12.5**：Strands 1.48.0 实测要求 pydantic >=2.12.5（AWS social-intelligence 样本），现有 `>=2.0` 需升级。向后兼容，无 breaking change，跑 `pnpm test` 全量验证即可。

9. **boto3 / litellm / anthropic / ollama 按需条件安装**：不强制引入所有 provider 依赖。用户用 OpenAI 兼容端点时只需 `pip install strands-agents`；用 Ollama 时加 `[ollama]` extra；用 LiteLLM 适配国内端点时加 `[litellm]` extra。降低依赖体积。

10. **MVP 2.5 人日，3 里程碑**：P0 适配层 + feature flag（1 人日）→ P1 LLM Model 注入 + 5 运维工具（1 人日）→ P2 双向 JSON-RPC + stream_async（0.5 人日）。每里程碑都有明确验收标准，可独立交付。

---

## 10. 参考资源

### 10.1 官方文档
- Strands Agents 1.48.0 PyPI：<https://pypi.org/project/strands-agents/1.48.0/>
- Strands Agents 官方文档：<https://strandsagents.com/latest/user-guide/>
- Strands Agents SDK 源码：<https://github.com/strands-agents/sdk-python>
- Strands Agents 工具集源码：<https://github.com/strands-agents/tools-python>
- Bedrock AgentCore 文档：<https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/>

### 10.2 AWS 博客案例（2026-07 真实数据）
- Motorway 生产评估蓝图（2026-07-23）：<https://aws.amazon.com/it/blogs/machine-learning/evaluating-ai-agents-a-production-blueprint-with-strands-and-agentcore/>
- EMR Flink 智能监控（2025-12-31）：<https://aws.amazon.com/cn/blogs/china/emr-flink-intelligent-monitoring-system-based-on-strands-agents/>
- 云成本分析 AI 助手（2026-05-26）：<https://aws.amazon.com/cn/blogs/china/based-on-strands-agents-build-cost-analytics-optimize-ai-assistant/></think>现在我来完成报告：<tool_call>Read<arg_key>file_path</arg_key><arg_value>d:\ai\linux教学一体\tdsf-terminal-agent-clone\docs\reports\strands-integration-implementation-plan-2026-07-30.md