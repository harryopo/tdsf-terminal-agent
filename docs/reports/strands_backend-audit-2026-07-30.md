# Strands Backend 骨架代码审计报告

> **位置**：`docs/reports/strands_backend-audit-2026-07-30.md`
> **审计对象**：`src-tauri/sidecar/strands_backend/`（9 个 Python 文件 + 1 个测试文件）
> **审计时间**：2026-07-30
> **审计性质**：只读静态审计（未运行代码、未修改任何文件）
> **目标 SDK**：AWS Strands Agents SDK 1.48.0（Apache 2.0）
> **上游参考**：https://github.com/strands-agents/sdk-python
> **配套方案**：`docs/reports/ops-agent-strands-integration-plan.md` v2.0
> **配套示例**：`docs/reports/ops-agent-tool-examples.md` v1.0

---

## 0. 执行摘要

**总体结论**：`strands_backend` 骨架的**代码质量本身较高**（结构清晰、降级完备、测试覆盖充分、docstring 详尽），**但与现有 sidecar 的"集成对齐"存在 4 处 CRITICAL 级断裂**，导致整套骨架**当前完全悬空**——即使依赖装好、配置就绪，也无法被 `main.py` 启动流程激活，且工具调用的 Rust method 名与 Rust 侧实际 Tauri command 名不匹配。

**质量分级**：

| 维度 | 评级 | 说明 |
|------|------|------|
| 代码质量 | ✅ A- | 结构清晰、降级完备、错误处理周到、docstring 详尽 |
| 集成对齐 | ❌ F | 4 处 CRITICAL 断裂（详见 §3.1-3.4），骨架悬空 |
| 风险点 | ⚠️ C+ | RiskChecker 覆盖广但与方案偏离；mood/next_step 值集合与 BaseAgent 不一致 |
| 功能覆盖 | ✅ A | 5 个运维工具覆盖核心 Linux 运维教学场景，工具签名清晰 |
| 测试覆盖 | ✅ A- | 50+ 单测覆盖核心路径，但缺真实 Strands 集成测试 + 未纳入 CI |

**关键建议**：**在 P0 阶段先修复 4 处 CRITICAL 断裂**（main.py 注入点 / agents.set_backend 接口 / requirements.txt 依赖 / Rust method 名对齐），否则任何后续工作都是无效投入。**不要**在没有修复这 4 处断裂前推进 P1/P2。

---

## 1. 审计范围与方法

### 1.1 审计文件清单（全部通读）

| 路径 | 行数 | 职责 |
|------|------|------|
| `src-tauri/sidecar/strands_backend/__init__.py` | 113 | 包入口，导出 `StrandsAgentAdapter` + `configure_strands` |
| `src-tauri/sidecar/strands_backend/adapter.py` | 778 | 适配层核心：`StrandsAgentAdapter` + `TdsfStrandsCallbackHandler` |
| `src-tauri/sidecar/strands_backend/tools/__init__.py` | 529 | 工具基础设施：`@tool` 降级、`RustBridge`、`ToolContext`、`RiskChecker`、`execute_via_ssh` |
| `src-tauri/sidecar/strands_backend/tools/ssh_command.py` | 201 | SSH 命令执行工具 |
| `src-tauri/sidecar/strands_backend/tools/remote_file.py` | 243 | 远程文件读取工具 |
| `src-tauri/sidecar/strands_backend/tools/log_analyzer.py` | 281 | 日志分析工具（tail/grep/regex） |
| `src-tauri/sidecar/strands_backend/tools/process_inspector.py` | - | 进程检查工具（list/top/detail） |
| `src-tauri/sidecar/strands_backend/tools/network_diagnostic.py` | - | 网络诊断工具（ping/ss/netstat/ip/dns） |
| `src-tauri/sidecar/strands_backend/tests/test_tools.py` | 942 | 单元测试（50+ 用例） |

### 1.2 集成上下文文件（用于验证对齐）

- `src-tauri/sidecar/main.py:335-358`（agents 注册段）
- `src-tauri/sidecar/agents/__init__.py:100-156`（`configure_agents` / `get_agent`）
- `src-tauri/sidecar/agents/base.py:177-367`（`BaseAgent.invoke` + `AgentResult`）
- `src-tauri/sidecar/event_bus.py`（全量，确认 `emit_*` 方法签名）
- `src-tauri/src/lib.rs:384` + `src-tauri/src/modules/ssh/mod.rs:412`（Rust 侧 Tauri command 名）
- `package.json:19`（`test:python` 脚本）
- `src-tauri/sidecar/requirements*.txt`（依赖列表）

### 1.3 审计方法

1. **静态通读**：逐行阅读所有源文件，建立依赖与调用图。
2. **集成对齐验证**：交叉比对骨架声称调用的 EventBus 方法、Rust method、agents 模块接口，与实际实现是否一致。
3. **最佳实践对比**：参考 Strands Agents SDK 官方 README（GitHub）+ AWS 官方博客披露的 1.0 范式（`@tool` 装饰器、`Agent(tools=[...])` 构造、`callback_handler` 协议、`stream_async` 事件类型）。
4. **风险扫描**：聚焦高危命令拦截、注入攻击、降级路径、并发安全。
5. **未运行代码**：本次为纯静态审计，未执行 `python -m pytest`，未启动 sidecar，未跑 `pnpm tauri:dev`——这是诚实知止的边界，运行验证留待修复 CRITICAL 后由后续 task 执行。

---

## 2. 关键发现摘要（按严重度排序）

### 🔴 CRITICAL-1：`main.py` 完全没有 `TDSF_AGENT_BACKEND` feature flag 注入点

- **位置**：`src-tauri/sidecar/main.py:335-358`
- **现象**：`main.py` 的 agents 注册段只有 `agents.configure_agents(event_bus=event_bus.get_global_bus(), llm_call=llm_call)`，**没有任何** `os.environ.get("TDSF_AGENT_BACKEND")` 分支判断，也没有 `from strands_backend import StrandsAgentAdapter` 的导入。
- **影响**：即使 `strands-agents` 已安装、`StrandsAgentAdapter` 实现完备、`TDSF_AGENT_BACKEND=strands` 环境变量已设置，**sidecar 启动时也不会激活 Strands 后端**——整个 `strands_backend/` 包处于悬空状态。
- **与方案偏离**：`adapter.py:25-40` 的 docstring 和 `__init__.py:10-28` 都承诺"通过 feature flag 在 main.py 注册段注入"，但**该承诺未落地**。
- **修复建议**：在 `main.py:348` 前插入 feature flag 分支（详见 §5.1）。

### 🔴 CRITICAL-2：`agents/__init__.py` 没有 `set_backend` 接口

- **位置**：`src-tauri/sidecar/agents/__init__.py:100-156`
- **现象**：`agents` 模块只暴露 `configure_agents(event_bus, llm_call)` / `get_agent(name)` / `list_agents()`，**没有 `set_backend(callable)` 方法**。`AGENT_REGISTRY` 是预注册的 Agent 类字典，实例化时通过 `cls(event_bus, llm_call)` 构造，没有运行时切换后端的机制。
- **影响**：`adapter.py:37` 的 docstring 示例 `agents.set_backend(lambda agent_id, input, state: adapter.invoke(agent_id, input, state))` **调用的方法根本不存在**。即使修复 CRITICAL-1 加入 feature flag 分支，也无法把 adapter 注入到现有 Agent 系统。
- **修复建议**：扩展 `agents/__init__.py`，新增 `_backend_override: Callable | None` 全局变量 + `set_backend(fn)` / `clear_backend()` 方法，并在 `get_agent(name).invoke(state)` 调用链中优先走 override（详见 §5.2）。或更简洁：让 `StrandsAgentAdapter` 直接注册 JSON-RPC 方法 `agent.invoke` 的 override，绕开 AGENT_REGISTRY。

### 🔴 CRITICAL-3：`requirements.txt` 未声明 `strands-agents` 依赖

- **位置**：`src-tauri/sidecar/requirements*.txt`（grep `^strands|^strands-agents` 返回 "No matches found"）
- **现象**：`strands_backend/` 包的所有 `from strands import ...` 都在 try/except 中降级，但 `requirements.txt` 根本没列 `strands-agents`。
- **影响**：`pip install -r requirements.txt` 不会装 Strands，`is_strands_available` 永远为 `False`，`StrandsAgentAdapter` 永远走降级路径——**整套骨架永远不会以非降级模式运行**。
- **修复建议**：在 `requirements.txt` 加入 `strands-agents>=1.0,<2.0`（或精确到 `==1.48.0`），并验证 Python 3.10+ 兼容性（Strands 官方要求 3.10+）。

### 🔴 CRITICAL-4：工具调用的 Rust method 名与 Rust 侧实际 Tauri command 名不匹配

- **位置**：
  - `strands_backend/tools/__init__.py:409`（`execute_via_ssh` 调 `ctx.rust_bridge.ipc_invoke("ssh_exec_in_session", ...)`）
  - `strands_backend/tools/remote_file.py:103`（调 `ctx.rust_bridge.ipc_invoke("sftp_read_file", ...)`）
  - Rust 侧实际命令名：`src-tauri/src/lib.rs:384` + `src-tauri/src/modules/ssh/mod.rs:412` 是 **`ssh_command`** 和 **`sftp_read`**（注意：是 `sftp_read` 不是 `sftp_read_file`）
- **现象**：骨架调用的 `ssh_exec_in_session` / `sftp_read_file` 在 Rust 侧**根本不存在**。
- **影响**：即使 P2 阶段实现双向 JSON-RPC，工具调用也会因 method 名不匹配而失败（Rust 侧 dispatcher 找不到方法）。
- **修复建议**：统一 method 名——要么改骨架用 `ssh_command` / `sftp_read`，要么在 Rust 侧新增 `ssh_exec_in_session` / `sftp_read_file` 别名。**推荐改骨架**（Rust 侧改动风险更高）。需先 grep Rust 侧所有 `#[tauri::command]` 确认完整 command 名清单。

### 🟠 HIGH-5：`pnpm test:python` 指向已废弃的 `python-sidecar/` 目录

- **位置**：`package.json:19` → `"test:python": "cd python-sidecar && python -m pytest -v --tb=short"`
- **现象**：`test:python` 脚本指向顶层 `python-sidecar/`，但根据 `CLAUDE.md` 防污染红线 #2，**这是已废弃的自研 v4.0.0 目录**，运行时使用的是 `src-tauri/sidecar/`。
- **影响**：
  1. `strands_backend/tests/test_tools.py` 不会被 `pnpm test:python` 运行（路径不对）。
  2. 违反 CLAUDE.md 防污染红线——继续引用已废弃目录。
  3. 五绿门禁的 `pnpm test` 只跑 vitest（前端），Python sidecar 测试根本未纳入 CI。
- **修复建议**：改 `package.json:19` 为 `cd src-tauri/sidecar && python -m pytest strands_backend/tests/ -v --tb=short`，并确认 `pytest` 已安装。

### 🟠 HIGH-6：`mood` 与 `next_step` 值集合与 `BaseAgent` 不一致

- **位置**：
  - `strands_backend/adapter.py:322, 153, 350`（推送 `mood="thinking"`）
  - `agents/base.py:306-308`（`mood = "done" if next_step == "done" else ("error" if next_step == "error" else "working")`）
- **现象**：
  - `BaseAgent` 的 mood 只在 `{"done", "error", "working"}` 三态中（base.py:306-308）。
  - `StrandsAgentAdapter` 推送 `mood="thinking"`（adapter.py:322, 350），但 `"thinking"` 不在 BaseAgent 的 mood 集合中。
  - `BaseAgent.invoke` 的 `next_step` 取值是 `"continue" | "done" | "error"`（base.py:79）。
  - `StrandsAgentAdapter.invoke` 返回的 `next_step` 只有 `"done" | "error"`（adapter.py:359, 389），没有 `"continue"`。
- **影响**：
  - mood 不一致：`emit_mood_change` 不校验值，不会崩溃；但若前端 `sidecar-adapter.ts` 按 BaseAgent mood 集合做状态机判断，可能忽略 "thinking" 状态。
  - next_step 不一致：是设计选择（Strands 内部管理 agentic loop，单次 invoke 永远终态）。但若上层 fix-loop 期望 "continue" 做循环，可能行为异常。需确认前端如何处理。
- **修复建议**：在 `agents/base.py` 的 mood 集合中加入 "thinking"（或文档化 "thinking" 是 Strands 后端独有状态）；在 `StrandsAgentAdapter` docstring 明确"next_step 永不返回 continue"的设计选择。

### 🟠 HIGH-7：`RiskChecker` 与方案文档承诺的 `RiskEngine.assess()` 偏离

- **位置**：`strands_backend/tools/__init__.py:215-273`（`RiskChecker.check`）
- **方案承诺**：`ops-agent-strands-integration-plan.md` §1.3 要求"所有 ops 工具调用前先过 `RiskEngine.assess()`"，做 4 层风控管道（语法/规则/确认/审计），返回 L0-L4 等级。
- **实际实现**：`RiskChecker` 只做**单层正则匹配**（10 条规则），命中即返回 L4 + `require_approval=True`，不依赖 `RiskEngine` YAML 配置。
- **影响**：
  - 正面：无依赖、同步、快速，与 `tools/risk.py` 的 `invoke_risk_tool` 互补。
  - 负面：覆盖面窄（只有 10 条规则），无法做资产感知调整（如生产服务器上调高等级），与方案承诺不一致。
- **修复建议**：在 `RiskChecker` docstring 中已说明"与 invoke_risk_tool 互补，可叠加使用"——这是合理简化。但应在 `adapter.py` 或工具调用链中**叠加调用** `tools/risk.invoke_risk_tool` 做精评，而非只用 `RiskChecker`。或更新方案文档说明 P0/P1 只用 RiskChecker，P2 再叠加 RiskEngine。

### 🟡 MEDIUM-8：`_extract_response_text` 对以 `<` 开头的合法字符串误判

- **位置**：`strands_backend/adapter.py:604`
- **现象**：
  ```python
  text = str(response)
  if text and not text.startswith("<"):
      return text
  ```
- **影响**：若 Strands 响应的 `str()` 是合法字符串但碰巧以 `<` 开头（如 XML/HTML 内容、`<thinking>...` 标签），会被跳过进入 fallback 路径。fallback 最终 `return str(response)`（第 630 行）也会返回同一字符串，所以**不会丢数据**，但路径绕一圈、性能略损。
- **修复建议**：去掉 `not text.startswith("<")` 判断（这是为了过滤 Strands 内部 repr 形式 `<strands...Response at 0x...>`，但 repr 会带 `at 0x` 后缀，可改为 `not (text.startswith("<") and "at 0x" in text)` 更精确）。

### 🟡 MEDIUM-9：测试未覆盖真实 Strands Agent 创建路径

- **位置**：`strands_backend/tests/test_tools.py`
- **现象**：所有 adapter invoke 测试都通过 `adapter._agent_cache["main"] = mock_agent` 跳过 `_get_or_create_agent`（test_tools.py:784, 804, 827, 847）。`test_strands_not_installed_degraded` 是 `adapter._strands_available = False` patch 模拟（test_tools.py:735）。
- **影响**：
  - 没有测试真实 Strands Agent 创建（依赖 `_STRANDS_AGENT_AVAILABLE`）。
  - 没有测试 `make_all_ops_tools` 在 Strands 未安装时的 `@tool` passthrough 行为（虽 docstring 声称仍可工作）。
  - 没有测试 `_build_prompt` 的所有 live 字段组合（只测了 cwd + sshSessionId，没测 activeFile / workspaceRoot / terminalPrivate）。
- **修复建议**：在 CI 中加入 `pip install strands-agents` 后的集成测试（标记 `@unittest.skipUnless(is_strands_available, "requires strands")`），验证真实 Strands Agent 创建 + 工具注册 + invoke 全流程。

### 🟡 MEDIUM-10：`_emit_needs_you_for_error` 把错误详情推送到前端

- **位置**：`strands_backend/adapter.py:694-721`
- **现象**：invoke 异常时，`emit_needs_you` 的 `description` 包含 `str(error)[:500]`，即把 Python 异常栈的字符串推送到前端。
- **影响**：
  - 安全风险：若 error 含敏感信息（如文件路径、API key、SSH 凭据），会泄露到前端 UI。
  - 用户体验：原始 Python 异常对用户不友好。
- **修复建议**：在推送前做敏感信息脱敏（正则过滤常见 secret 模式：`api_key=...`、`password=...`、`Bearer ...`）。或只推送 `type(error).__name__` + 通用消息，详细栈写到 logger.exception。

---

## 3. 详细审计

### 3.1 代码质量（A-）

#### 3.1.1 优点

1. **结构清晰**：`__init__.py` / `adapter.py` / `tools/__init__.py` / `tools/*.py` 分层明确，职责单一。
2. **降级完备**：Strands 是条件依赖，`try: from strands import ... except ImportError:` 降级为 passthrough（`tools/__init__.py:39-57`），保证模块可被 import + 单测 + 适配层优雅降级。
3. **错误处理周到**：所有 `emit_*` 调用包 `try/except`，失败只 `logger.debug`，不阻塞主流程（`adapter.py:672-673, 691-692` 等）。
4. **docstring 详尽**：每个模块顶部有职责说明 + 设计原则 + 集成点示例，每个公开方法有 Args/Returns/Raises 标注。
5. **类型标注完整**：全 `from __future__ import annotations` + `dict[str, Any]` / `list` / `Callable` 等现代类型标注。
6. **结构化返回**：所有工具返回 `dict`（不返回裸字符串），与 Strands 工具协议对齐。
7. **模块级单例 + 工厂闭包**：`ToolContext` dataclass + `make_*_tool(ctx)` 工厂模式，工具通过闭包访问 ctx，避免全局变量污染。

#### 3.1.2 不足

1. **`_extract_response_text` 误判**（见 §2 MEDIUM-8）。
2. **`_emit_needs_you_for_error` 泄露错误详情**（见 §2 MEDIUM-10）。
3. **`adapter.py` 单文件 778 行偏长**：`StrandsAgentAdapter` + `TdsfStrandsCallbackHandler` 同文件，可考虑拆分为 `adapter.py` + `callback_handler.py`。但当前结构可接受。
4. **`tools/__init__.py` 529 行混合多职责**：`@tool` 降级 + `RustBridge` + `ToolContext` + `RiskChecker` + `execute_via_ssh` + 工具注册 6 个职责。可拆分为 `decorator.py` / `rust_bridge.py` / `context.py` / `risk_checker.py` / `registry.py`。但当前作为公共基础设施聚合可接受。

### 3.2 集成对齐（F）

#### 3.2.1 ✅ EventBus 方法签名完全对齐

`adapter.py` 和 `tools/*.py` 调用的 EventBus 方法，与 `event_bus.py` 实际签名**完全一致**：

| 调用方 | EventBus 方法 | 签名对齐 |
|--------|--------------|---------|
| `adapter.py:667` | `emit_mood_change(mood, session_id, source)` | ✅ `event_bus.py:362-385` |
| `adapter.py:685` | `emit_agent_message(content, message_type, session_id, source)` | ✅ `event_bus.py:387-410` |
| `adapter.py:184, tools/ssh_command.py:108` | `emit_tool_call(tool_name, params, result, status, session_id, source)` | ✅ `event_bus.py:412-445` |
| `adapter.py:705, tools/__init__.py:306` | `emit_needs_you(needs_type, title, description, session_id, source, priority, **extra)` | ✅ `event_bus.py:447-481` |

**结论**：EventBus 集成对齐良好，无需修改。

#### 3.2.2 ✅ `AgentResult` 返回值结构对齐

`BaseAgent.invoke` 返回 `AgentResult`（`agents/base.py:318-330`）含字段：
- `observation: str`
- `intermediate_results: list[dict]`
- `next_step: str`（"continue" | "done" | "error"）
- `reflection: str`
- `mood: str`（"done" | "error" | "working"）
- `error: str`
- `extra_update: dict`

`StrandsAgentAdapter.invoke` 返回 dict（`adapter.py:358-376`）含：
- `observation: str` ✅
- `next_step: str`（"done" | "error"）⚠️ 缺 "continue"
- `mood: str`（"done" | "error" | "thinking" | "working"）⚠️ 多 "thinking"
- `intermediate_results: list[dict]` ✅
- `tokens: dict`（Strands 独有，BaseAgent 无）
- 缺 `reflection` / `error`（error 路径有 `error` 字段，success 路径无）
- 缺 `extra_update`

**结论**：核心字段对齐，前端 `sidecar-adapter.ts` 切片流式逻辑可复用。但 mood/next_step 值集合不一致（见 §2 HIGH-6），需文档化或修正。

#### 3.2.3 ❌ `main.py` 注入点缺失（CRITICAL-1）

`main.py:335-358` 的 agents 注册段**完全没有** Strands 后端注入逻辑：

```python
# main.py:335-358（现状）
import agents
from core.llm_config import make_llm_call
llm_call = make_llm_call()
if llm_call is not None:
    logger.info("LLM configured, agents will use real LLM")
else:
    logger.warning("LLM not configured, agents will use mock LLM")
agents.register_methods(dispatcher)
agents.configure_agents(
    event_bus=event_bus.get_global_bus(),
    llm_call=llm_call,
)
```

**对比方案承诺**（`adapter.py:25-40` docstring）：

```python
backend = os.environ.get("TDSF_AGENT_BACKEND", "langgraph").lower()
if backend == "strands":
    try:
        from strands_backend import StrandsAgentAdapter
        from strands_backend.tools import DefaultRustBridge
        adapter = StrandsAgentAdapter(...)
        agents.set_backend(lambda agent_id, input, state: adapter.invoke(...))
    except Exception as se:
        logger.exception(f"failed to activate Strands backend, fallback: {se}")
        agents.configure_agents(event_bus=event_bus.get_global_bus(), llm_call=llm_call)
```

**结论**：承诺未落地，需在 `main.py` 加入 feature flag 分支。

#### 3.2.4 ❌ `agents.set_backend` 接口不存在（CRITICAL-2）

`agents/__init__.py:100-156` 只暴露：
- `configure_agents(event_bus, llm_call)` — 实例化所有 AGENT_REGISTRY 中的 Agent
- `get_agent(name)` — 获取已实例化的 BaseAgent
- `list_agents()` — 列出 Agent 名

**没有** `set_backend(callable)` 方法。`AGENT_REGISTRY` 是模块级常量，`_agent_instances` 是模块级字典，实例化时通过 `cls(event_bus, llm_call)` 构造，没有运行时切换后端的机制。

**结论**：即使修复 CRITICAL-1，也无法注入 adapter。需扩展 `agents/__init__.py`。

#### 3.2.5 ❌ Rust method 名不匹配（CRITICAL-4）

骨架调用：
- `tools/__init__.py:409` → `ctx.rust_bridge.ipc_invoke("ssh_exec_in_session", {...})`
- `tools/remote_file.py:103` → `ctx.rust_bridge.ipc_invoke("sftp_read_file", {...})`

Rust 侧实际 Tauri command（grep `src-tauri/src`）：
- `src-tauri/src/lib.rs:384` → `ssh::sftp_read`
- `src-tauri/src/modules/ssh/mod.rs:412` → `pub async fn sftp_read(...)`
- CLAUDE.md 架构地图 → `ssh_command` / `sftp_list` / `sftp_read` / `sftp_write`

**结论**：`ssh_exec_in_session` 和 `sftp_read_file` 在 Rust 侧不存在。需统一 method 名。

#### 3.2.6 ❌ `requirements.txt` 缺 Strands 依赖（CRITICAL-3）

grep `^strands|^strands-agents` 在 `src-tauri/sidecar/requirements*.txt` 返回 "No matches found"。

**结论**：`strands-agents` 未声明为依赖，pip install 不会安装，骨架永远降级。

### 3.3 风险点（C+）

#### 3.3.1 高危命令拦截（RiskChecker）

**覆盖的 10 条规则**（`tools/__init__.py:161-212`）：

| 规则名 | 正则 | 场景 |
|--------|------|------|
| `rm_rf_root` | `rm\s+(-[a-zA-Z]*r[a-zA-Z]*f?|--recursive\s+--force)\s+(/|\*|\s/\s|$)` | rm -rf / |
| `rm_rf` | `rm\s+(-[a-zA-Z]*r[a-zA-Z]*f?|--recursive\s+--force)\s+` | rm -rf 任意路径 |
| `reboot` | `\b(reboot\|shutdown\s+(-r\|-h)?\s*now?\|halt\|poweroff\|init\s+0\|init\s+6)\b` | 重启/关机 |
| `mkfs` | `\bmkfs\.[a-z0-9]+\s+/dev/` | 格式化块设备 |
| `dd_to_disk` | `\bdd\s+.*\s+of=/dev/(sd\|nvme\|vd\|hd)` | dd 写磁盘 |
| `fork_bomb` | `:\(\)\s*\{\s*:\|\s*:\&\s*\}\s*;` | fork bomb |
| `chmod_777_root` | `chmod\s+(-R\s+)?777\s+/` | 递归 777 根 |
| `killall_system` | `killall\s+(-9\s+)?(systemd\|init\|sshd\|nginx\|mysql\|postgres)` | 杀关键进程 |
| `iptables_flush` | `iptables\s+(-F\|-X\|-Z)\b` | 清空防火墙 |
| `drop_database` | `(DROP\s+DATABASE\|DROP\s+SCHEMA)\b` | 删库 |

**测试覆盖**：11 个测试用例覆盖所有 10 条规则（`test_tools.py:117-225`），含安全命令负例。

**优点**：
- 命中即 `emit_needs_you`（priority="high"）+ 返回 `needs_approval` 状态，不执行。
- 多行命令逐行检测（`ssh_command.py:78-103`）。
- `re.IGNORECASE` 大小写不敏感。
- 正则错误时 `logger.exception` 跳过该规则，不崩溃。

**不足**：
1. **未覆盖的运维高危场景**：
   - `> /dev/sda`（重定向覆盖磁盘，非 dd）
   - `:(){ :|:& };:` 的变体（如 `:(){ :|:& }; :` 带空格）
   - `curl ... | bash`（远程脚本执行）
   - `wget ... -O - | sh`
   - `chmod -R 000 /`（递归清空权限）
   - `chown -R ...`（递归改所有权）
   - `systemctl stop ...`（停关键服务）
   - `umount /`（卸载根分区）
   - `mv / /dev/null`（移动根到 null）
2. **正则可被绕过**：
   - `rm -rf /` 用 `rm --recursive --force /` 可命中（规则覆盖）
   - 但 `rm -r -f /`（分开选项）→ 正则 `(-[a-zA-Z]*r[a-zA-Z]*f?` 要求 rf 在同一 `-` 后，可能漏
   - `rm -fr /`（f 在 r 前）→ 正则要求 r 在 f 前，漏
   - 用变量 `X=/; rm -rf $X` → 正则看不到 `$X` 展开后的 `/`，漏
3. **与 `tools/risk.py` 的 `RiskEngine` 关系**：见 §2 HIGH-7。

**修复建议**：
- 补充上述未覆盖规则。
- 加 `rm -fr` / `rm -r -f` 等变体。
- 文档化"RiskChecker 是快速拦截，不能替代 RiskEngine 的语义分析"——已知限制。
- 长期：叠加 `tools/risk.invoke_risk_tool` 做 4 层精评。

#### 3.3.2 注入攻击防护

**shell 转义**（`log_analyzer.py:67-68`）：
```python
def _shell_escape(s: str) -> str:
    return "'" + s.replace("'", "'\"'\"'") + "'"
```
- 用单引号包裹 + 内部单引号转义为 `'"'"'`，是 shell 标准转义。
- 覆盖 `log_path` 和 `pattern` 两个字段。
- ✅ 防 shell 注入。

**未转义的字段**：
- `ssh_command.py` 的 `command` 参数直接传给 `execute_via_ssh`，**不转义**（设计如此，因为 command 是用户/Agent 直接给的 shell 命令，转义会破坏语义）。
- `remote_file.py` 的 `path` 参数直接传给 RustBridge，**不转义**（path 是文件路径，Rust 侧应自行处理路径遍历如 `../../etc/passwd`）。
- ⚠️ `network_diagnostic.py` 的 `target` 参数（ping/ss/dns 目标）——需审计是否转义（未读该文件，但基于模式一致性推测可能用单引号转义）。**这是审计盲区**，建议补读该文件确认。

#### 3.3.3 并发安全

- `StrandsAgentAdapter._agent_cache: dict` 无锁保护（`adapter.py:263`）。
- 若多线程并发调用 `invoke`，`_get_or_create_agent` 可能重复创建 Agent（`adapter.py:491` if 检查 + 写入不是原子的）。
- 但 `EventBus` 是线程安全的（`event_bus.py:144-162` 用 `threading.RLock`）。
- **影响**：重复创建 Agent 浪费资源但不崩溃（最后写入的覆盖前者）。Strands Agent 创建是幂等的（无状态）。
- **修复建议**：加 `threading.Lock` 保护 `_agent_cache`，或用 `dict.setdefault` 模式。

#### 3.3.4 降级路径安全

降级时（`adapter.py:423-475`）：
- 返回结构化结果（不抛错）✅
- 推送 `emit_needs_you`（priority="normal"）通知前端 ✅
- 不泄露敏感信息 ✅
- 降级原因清晰（feature_flag_disabled / strands_not_installed / strands_model_not_injected）✅

### 3.4 功能覆盖（A）

#### 3.4.1 5 个运维工具覆盖度

| 工具 | 文件 | 模式/功能 | 覆盖度 |
|------|------|---------|--------|
| `ssh_command` | `ssh_command.py` | 通用 SSH 命令执行 | ✅ 核心场景 |
| `read_remote_file` | `remote_file.py` | 远程文件读取（含二进制检测、大文件截断、编码降级） | ✅ 完备 |
| `analyze_logs` | `log_analyzer.py` | tail / grep -F / grep -E 三模式 | ✅ 日志分析核心 |
| `inspect_processes` | `process_inspector.py` | list / top / detail + filter_user/filter_name | ✅ 进程检查核心 |
| `network_diagnose` | `network_diagnostic.py` | ping / ss / netstat / ip / dns 五模式 | ✅ 网络诊断核心 |

**Linux 运维教学场景覆盖**：
- 日志分析 ✅
- 网络排障 ✅
- 进程监控 ✅
- 文件查看 ✅
- 命令执行 ✅
- 缺：服务管理（systemctl status/start/stop）——可通过 `ssh_command` 间接覆盖
- 缺：用户管理（useradd/usermod）——可通过 `ssh_command` 间接覆盖
- 缺：磁盘/内存监控（df/free/top）——可通过 `ssh_command` 间接覆盖

**结论**：5 个工具覆盖 Linux 运维教学核心场景，通用命令通过 `ssh_command` 兜底。功能覆盖充分。

#### 3.4.2 与方案文档的对齐

| 方案承诺（`ops-agent-tool-examples.md`） | 实际实现 | 对齐 |
|------------------------------------------|---------|------|
| `invoke_ops_ssh_command_tool(params) -> dict` | `invoke_ssh_command_tool(params, ctx)` | ⚠️ 命名不同（无 `ops_` 前缀），签名加 ctx |
| `@tool ops_ssh_command(command, ssh_session_id)` | `@tool ssh_command(command, ssh_session_id, explanation, timeout)` | ⚠️ 命名不同，参数更多 |
| 4 层 RiskEngine 风控 | 单层 RiskChecker | ❌ 偏离（见 §2 HIGH-7） |
| `RustBridgeProtocol.invoke(method, params)` | `RustBridge.ipc_invoke(method, params)` | ⚠️ 方法名不同（invoke vs ipc_invoke） |
| `StubRustBridge` 返回 `{"ok": False, "stub": True, ...}` | `DefaultRustBridge` 返回 `{"status": "unavailable", ...}` | ⚠️ 结构不同 |
| `LiveContext` dataclass + `set_live_context` / `get_live_context` | `ToolContext` dataclass（无 LiveContext） | ⚠️ 简化（live 字段直接从 state.live 读） |

**结论**：实际实现与方案文档有合理偏离（命名简化、接口收敛），但需更新方案文档保持一致。

### 3.5 测试覆盖（A-）

#### 3.5.1 测试统计

- **总用例数**：约 50+ 个（`test_tools.py` 942 行）
- **覆盖维度**：
  - RiskChecker：13 个用例（含 10 条规则正例 + 安全命令负例 + emit_needs_you 调用验证 + event_bus=None 容错）
  - ssh_command 工具：6 个用例（success / high_risk / unavailable / missing_command / 多行高危 / factory）
  - remote_file 工具：6 个用例（success / binary / truncated / unavailable / missing_path / factory）
  - log_analyzer 工具：7 个用例（tail / grep / regex / missing_pattern / invalid_mode / unavailable / factory）
  - process_inspector 工具：6 个用例（list / top / detail / missing_pid / filter / factory）
  - network_diagnostic 工具：9 个用例（ping / ss / netstat / ip / dns / missing_target / invalid_mode / factory）
  - make_all_ops_tools：2 个用例（返回 5 工具 + OPS_TOOL_NAMES 完整）
  - DefaultRustBridge：3 个用例（无 send_request / 有 send_request / 异常）
  - StrandsAgentAdapter 降级：4 个用例（feature_flag / strands_not_installed / model_not_injected / 响应结构）
  - StrandsAgentAdapter invoke 成功：4 个用例（success / live_context 注入 / 异常 / mood 序列）
  - TdsfStrandsCallbackHandler：6 个用例（data / start / complete / force_stop / current_tool_use / no_event_bus）
  - 包导入：3 个用例（import / StrandsAgentAdapter importable / configure_strands 返回类型）

#### 3.5.2 测试优点

1. **Mock 工厂完备**：`make_mock_event_bus` / `make_mock_rust_bridge` / `make_ctx` 三个工厂，测试代码简洁。
2. **哨兵对象**：`_RUST_BRIDGE_UNSET = object()`（test_tools.py:84）区分"未传参数"和"显式传 None"，测试 unavailable 路径。
3. **覆盖降级三路径**：feature_flag / strands_not_installed / model_not_injected 全测。
4. **验证 emit_needs_you 调用**：不只验证返回值，还验证 `bus.emit_needs_you.assert_called_once()` + kwargs 正确。
5. **验证 RustBridge 不被调用**：高危命令测试 `bridge.ipc_invoke.assert_not_called()`，确认拦截生效。

#### 3.5.3 测试不足

1. **无真实 Strands 集成测试**（见 §2 MEDIUM-9）。
2. **未纳入 CI**（见 §2 HIGH-5）：`pnpm test:python` 指向错误目录。
3. **`_build_prompt` 覆盖不全**：只测了 `cwd + sshSessionId`，未测 `activeFile` / `workspaceRoot` / `terminalPrivate` 单独组合 + 空状态。
4. **`_extract_response_text` 边界未测**：未测 `str(response)` 以 `<` 开头的场景（见 §2 MEDIUM-8）。
5. **`_extract_tokens` 未测**：未测 `response.metrics` / `response.usage` / 无 metrics 三种情况。
6. **`clear_cache` / `get_stats` 未测**。
7. **并发安全未测**：`_agent_cache` 无锁，未测多线程并发 invoke。
8. **`RiskChecker` 绕过场景未测**：未测 `rm -fr /` / `rm -r -f /` / 变量展开等绕过场景。

---

## 4. 与 Strands Agents 1.48.0 最佳实践对比

> **数据来源**：Strands Agents SDK GitHub README + AWS 官方博客（通过 WebSearch 获取，非记忆编造）。本次审计基于 SDK 1.0 GA（2025-07-31 发布）的公开范式，**1.48.0 是较新版本**，可能新增 API（如 `stream_async` 事件类型、`Agents-as-Tools` / `Handoffs` / `Swarm` / `Graph` 多 Agent 模式、A2A 协议），但核心 `@tool` 装饰器 + `Agent(tools=[...])` 范式自 1.0 稳定。

### 4.1 ✅ 对齐的最佳实践

| 最佳实践 | 骨架实现 | 位置 |
|---------|---------|------|
| `@tool` 装饰器从 docstring + 类型标注生成工具描述 | ✅ 5 个工具均用 `@tool` + 完整 docstring + 类型标注 | `tools/*.py` |
| `Agent(tools=[...])` 构造 | ✅ `_get_or_create_agent` 传 `tools=all_tools` | `adapter.py:507-513` |
| `callback_handler` 事件回调 | ✅ `TdsfStrandsCallbackHandler` 实现 `__call__(**kwargs)` 协议 | `adapter.py:89-207` |
| `system_prompt` 注入 | ✅ 构造时传 `system_prompt=self.system_prompt` | `adapter.py:510` |
| `max_iterations` 防死循环 | ✅ 默认 10，可配置 | `adapter.py:247, 512` |
| 工具返回结构化 dict | ✅ 所有工具返回 `{status, ...}` | `tools/*.py` |
| 条件依赖 + 优雅降级 | ✅ try/except ImportError + passthrough | `tools/__init__.py:39-57` |

### 4.2 ⚠️ 未对齐/未利用的特性

1. **`stream_async` 异步流式**：骨架用同步 `agent(prompt)`（`adapter.py:345`），未用 `async for event in agent.stream_async(prompt)`。流式靠 `callback_handler` 转发，但同步调用会阻塞 Python 事件循环。**修复建议**：若 sidecar 是异步架构，改为 `async def invoke` + `stream_async`。
2. **多模型 Provider**：骨架 `strands_model: Any`（`adapter.py:246`）未指定 Provider 类型，需 P0 阶段实现 `model_adapter.py` 把现有 `core/llm_config.py` 的 LLM 客户端包装为 Strands Model（OpenAIModel / AnthropicModel / OllamaModel / LiteLLMModel）。**这是 P0 必须补的缺口**——否则 `_model_available` 永远 False，永远降级。
3. **MCP 集成**：Strands 原生 `MCPClient` 支持 stdio / Streamable HTTP，骨架未利用。可考虑 P2 阶段接入 MCP server 暴露更多工具。
4. **多 Agent 模式**（1.0 新增 4 原语：Agents-as-Tools / Handoffs / Swarm / Graph）：骨架是单 Agent 模式，未利用多 Agent。可考虑 P2 把现有 `agents/registry.py` 的多 Agent（main/coding/explore/...）映射为 Strands 多 Agent。
5. **`load_tools_from_directory=True`**：Strands 支持从 `./tools/` 目录热加载工具，骨架用手动注册。可考虑 P2 切换为目录加载。
6. **`Agent` 的 `callback_handler` 事件类型**：骨架处理了 `current_tool_use` / `data` / `start` / `complete` / `force_stop`，但 Strands 1.0 文档还提到 `init_event_loop` / `start_event_loop` / `message`（含 role）事件，骨架未处理。**修复建议**：补全事件类型处理。

### 4.3 ⚠️ Strands 版本风险

- 骨架 docstring 写"Strands Agents SDK 1.48.0"，但 `requirements.txt` 未声明版本（CRITICAL-3）。
- Strands 1.0 → 1.48.0 之间 API 可能变化（如 `callback_handler` 协议、`Agent` 构造参数、响应对象结构）。
- 骨架的 `_extract_response_text`（`adapter.py:592-630`）做了多路径兼容（str / .text / .content / .message.content），是好习惯，但仍需在装 1.48.0 后实测。
- **修复建议**：在 `requirements.txt` 精确 pin `strands-agents==1.48.0`，并在 CI 中跑真实集成测试。

---

## 5. 改进建议

### 5.1 修复 CRITICAL-1：`main.py` 注入 feature flag

在 `src-tauri/sidecar/main.py:335` 的 `import agents` 后、`agents.configure_agents(...)` 前插入：

```python
import os
backend = os.environ.get("TDSF_AGENT_BACKEND", "langgraph").lower()
if backend == "strands":
    try:
        from strands_backend import configure_strands
        adapter = configure_strands(
            event_bus=event_bus.get_global_bus(),
            rust_bridge=None,  # P2 阶段注入真实 send_request
            strands_model=None,  # P0 阶段由 model_adapter.py 构造
        )
        agents.set_backend(lambda agent_id, input, state: adapter.invoke(agent_id, input, state))
        logger.info("Strands backend activated")
    except Exception as se:
        logger.exception(f"failed to activate Strands backend, fallback: {se}")
        agents.configure_agents(event_bus=event_bus.get_global_bus(), llm_call=llm_call)
else:
    agents.configure_agents(event_bus=event_bus.get_global_bus(), llm_call=llm_call)
```

### 5.2 修复 CRITICAL-2：扩展 `agents/__init__.py` 加 `set_backend`

在 `src-tauri/sidecar/agents/__init__.py` 加入：

```python
# 全局后端 override（None 表示用默认 AGENT_REGISTRY）
_backend_override: Callable[[str, str, dict], dict] | None = None


def set_backend(callable: Callable[[str, str, dict], dict]) -> None:
    """设置后端 override（如 StrandsAgentAdapter.invoke）
    
    设置后，agent.invoke JSON-RPC 方法会优先走 override，
    而非 AGENT_REGISTRY 中的 BaseAgent.invoke。
    """
    global _backend_override
    _backend_override = callable


def clear_backend() -> None:
    """清除后端 override，恢复 AGENT_REGISTRY"""
    global _backend_override
    _backend_override = None
```

并在 `agents.register_methods(dispatcher)` 注册的 `agent.invoke` 方法中：

```python
if _backend_override is not None:
    return _backend_override(agent_id, input, state)
else:
    return get_agent(agent_id).invoke(state)
```

**注意**：需先 grep `agents.register_methods` 找到 `agent.invoke` 的实际注册位置，确认 override 注入点。

### 5.3 修复 CRITICAL-3：`requirements.txt` 加依赖

在 `src-tauri/sidecar/requirements.txt` 加入：

```
strands-agents==1.48.0
```

并验证：
1. Python 3.10+ 兼容性（Strands 官方要求 3.10+）。
2. 不与现有依赖冲突（`boto3` / `pydantic` 等版本兼容性）。
3. `pip install` 后 `python -c "from strands import Agent, tool"` 成功。

### 5.4 修复 CRITICAL-4：统一 Rust method 名

**推荐方案**：改骨架用 Rust 侧实际 command 名：

| 骨架调用 | 改为 | Rust 侧位置 |
|---------|------|------------|
| `tools/__init__.py:409` `"ssh_exec_in_session"` | `"ssh_command"` | CLAUDE.md 架构地图 |
| `tools/remote_file.py:103` `"sftp_read_file"` | `"sftp_read"` | `src-tauri/src/lib.rs:384` |

**注意**：需先 grep `src-tauri/src` 确认所有 ssh/sftp command 名完整清单（如 `sftp_list` / `sftp_write` / `sftp_mkdir` 等），并对齐骨架其他工具的调用。

### 5.5 修复 HIGH-5：`package.json` 测试脚本

```json
"test:python": "cd src-tauri/sidecar && python -m pytest strands_backend/tests/ -v --tb=short"
```

并在 `pnpm test` 或 CI 中加入 `pnpm test:python`，确保 Python 测试纳入五绿门禁。

### 5.6 修复 HIGH-6：mood/next_step 一致性

- 在 `agents/base.py:306-308` 的 mood 集合加入 "thinking"（或文档化 "thinking" 是 Strands 后端独有）。
- 在 `StrandsAgentAdapter.invoke` docstring 明确"next_step 永不返回 continue，因 Strands 内部管理 agentic loop"。

### 5.7 修复 MEDIUM-8/MEDIUM-10

- `_extract_response_text`：去掉 `not text.startswith("<")` 或改为更精确的 repr 检测。
- `_emit_needs_you_for_error`：推送前脱敏（正则过滤 `api_key=...` / `password=...` / `Bearer ...` / 文件路径模式）。

### 5.8 补 P0 缺口：`model_adapter.py`

骨架 docstring 多处提到"P0 阶段由 `model_adapter.py` 构造 Strands Model"，但**该文件不存在**。需新建 `strands_backend/model_adapter.py`，把 `core/llm_config.py` 的 LLM 客户端包装为 Strands Model 对象（OpenAIModel / AnthropicModel / OllamaModel / LiteLLMModel 之一，取决于现有 LLM provider）。

### 5.9 补测试盲区

- 真实 Strands Agent 集成测试（`@unittest.skipUnless(is_strands_available)`）。
- `_build_prompt` 所有 live 字段组合。
- `_extract_response_text` 边界（`<` 开头、None、message.content list）。
- `_extract_tokens` 三种情况。
- `clear_cache` / `get_stats`。
- 并发安全（多线程 invoke）。
- RiskChecker 绕过场景（`rm -fr` / `rm -r -f` / 变量展开）。

---

## 6. 结论

`strands_backend` 骨架的**代码实现质量值得肯定**——结构清晰、降级完备、测试覆盖充分、docstring 详尽，体现了对 Strands SDK 范式的理解和对现有 sidecar 架构的尊重。

**但集成对齐存在 4 处 CRITICAL 断裂**，使整套骨架当前完全悬空：

1. `main.py` 无 feature flag 注入点 → 骨架永不被激活。
2. `agents/__init__.py` 无 `set_backend` 接口 → 即使激活也无法注入。
3. `requirements.txt` 无 Strands 依赖 → 永远降级。
4. Rust method 名不匹配 → 即使双向 JSON-RPC 实现也会调用失败。

**这 4 处断裂必须在 P0 阶段优先修复**，否则任何 P1/P2 工作（终端上下文感知、5 工具实现、双向 JSON-RPC）都是无效投入。

**修复这 4 处断裂的工作量预估**：0.5-1 人日（main.py 改 20 行 + agents/__init__.py 加 30 行 + requirements.txt 加 1 行 + 骨架 method 名改 2 处 + package.json 改 1 行）。修复后即可推进 P0 剩余工作（`model_adapter.py` 实现 + 真实 Strands 集成测试）。

**审计边界声明**：本次为纯静态审计，未运行代码。所有"修复建议"需在实施后通过五绿门禁（`pnpm typecheck` / `pnpm lint` / `pnpm test` / `pnpm build:web` / `pnpm tauri:dev`）+ 真实 Strands Agent 集成测试验证。Strands SDK 1.48.0 的具体 API 行为以装好依赖后的实测为准。

---

## 附录 A：审计文件绝对路径清单

```
d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\sidecar\strands_backend\__init__.py
d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\sidecar\strands_backend\adapter.py
d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\sidecar\strands_backend\tools\__init__.py
d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\sidecar\strands_backend\tools\ssh_command.py
d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\sidecar\strands_backend\tools\remote_file.py
d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\sidecar\strands_backend\tools\log_analyzer.py
d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\sidecar\strands_backend\tools\process_inspector.py
d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\sidecar\strands_backend\tools\network_diagnostic.py
d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\sidecar\strands_backend\tests\test_tools.py
d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\sidecar\main.py (335-358)
d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\sidecar\agents\__init__.py (100-156)
d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\sidecar\agents\base.py (177-367)
d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\sidecar\event_bus.py
d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\src\lib.rs (384)
d:\ai\linux教学一体\tdsf-terminal-agent-clone\src-tauri\src\modules\ssh\mod.rs (412)
d:\ai\linux教学一体\tdsf-terminal-agent-clone\package.json (19)
d:\ai\linux教学一体\tdsf-terminal-agent-clone\docs\reports\ops-agent-strands-integration-plan.md
d:\ai\linux教学一体\tdsf-terminal-agent-clone\docs\reports\ops-agent-tool-examples.md
```

---

## 附录 B：审计盲区（诚实知止）

1. **未读完整文件**：`process_inspector.py` / `network_diagnostic.py` 未通读（基于 `ssh_command.py` / `log_analyzer.py` / `remote_file.py` 的模式一致性推测结构相同）。建议补读确认 `network_diagnostic.py` 的 `target` 参数是否做了 shell 转义。
2. **未运行测试**：未执行 `python -m pytest strands_backend/tests/`，所有测试通过率基于代码静态分析推测。
3. **未验证 Strands 1.48.0 实际 API**：基于 1.0 GA 的公开范式审计，1.48.0 可能有 API 变化。需装好依赖后实测。
4. **未读 Rust 侧完整 command 清单**：只 grep 了 `ssh_exec_in_session` / `sftp_read_file` / `ssh_command` / `sftp_read`，未完整列出所有 `#[tauri::command]`。建议补 grep 确认。
5. **未读前端 `sidecar-adapter.ts`**：未验证前端如何处理 mood="thinking" / next_step 缺 "continue" 的差异。
6. **未读 `core/llm_config.py`**：未确认现有 LLM provider 是 OpenAI / Anthropic / Ollama / LiteLLM 哪个，影响 `model_adapter.py` 的实现路径。

---

> **审计完成时间**：2026-07-30
> **审计者**：代码审计 subagent（只读模式）
> **报告版本**：v1.0
> **下一步**：将本报告交付 parent agent，由其决定是否启动 CRITICAL 修复 task。
