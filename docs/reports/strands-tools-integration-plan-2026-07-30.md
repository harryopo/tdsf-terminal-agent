# Strands Agents Tools 0.8.5 集成实施方案

> **位置**：`docs/reports/strands-tools-integration-plan-2026-07-30.md`
> **任务**：基于 [`docs/reports/ops-agent-research-2026-07-30.md`](ops-agent-research-2026-07-30.md) §5 P0 路线图，深入审查 `strands-agents-tools 0.8.5` 实际包，给出精准实施方案。
> **场景**：A（纯调研 + 写报告，不动源代码）
> **日期**：2026-07-30
> **作者**：subagent-A
> **上游依赖**：Strands 1.50.2 已集成（dev-state §十五 P0-E 阶段 A 完成，DeepSeek LLM 端到端 4/4 测试全过）

---

## 执行摘要

本报告对 `strands-agents-tools 0.8.5`（2026-07-22 发布）进行 PyPI 实际抓包验证 + 现有 TDSF Strands 集成代码审查，给出 P0 阶段三项任务的精准实施方案：

1. **PyPI 验证结论**：License = Apache-2.0（与 TDSF 兼容）；Python ≥ 3.10（与 sidecar 3.13 兼容）；4 个 P0 工具（`shell` / `http_request` / `journal` / `editor`）API 签名已确认；**修正 ops-agent 报告 §4.1 的一处错误**：报告列出的 extras `use_browser` 实际不存在，正确的是 `local-chromium-browser` 和 `agent-core-browser`（共 14 个 extras）。
2. **现有代码审查结论**：`strands_backend/` 已具备完整的工具注入框架（`ToolContext` / `RustBridge` / `RiskChecker` / `make_all_ops_tools`），`ssh_command` 工具内嵌的 `RiskChecker` 已实现 10 条高危命令正则 + `emit_needs_you` 审批事件。**ApprovalHook 应作为"第二层护栏"在 `HookProvider` 层拦截，与工具内嵌 `RiskChecker` 互补**（Hook 拦截敏感工具调用 + 工具内 RiskChecker 拦截命令级高危），不重复实现。
3. **工程量重估**：实际代码审查后，ApprovalHook 因需双向事件等待机制（Hook 阻塞 agent loop → 前端弹窗 → 用户响应回传），比 ops-agent §5.2 估算的 1.5 人日复杂，调整为 **2.0 人日**；LimitToolCounts 简单（0.5 人日不变）；4 工具注入因 `editor` 有 `command` 子参数（view/edit/create/str_replace 等）需额外 wrapper，从 0.5 → 0.75 人日。**P0 小计从 2.5 → 3.25 人日**。
4. **风险新增一项**：`AiToolApproval.tsx` 当前 `onRespond(approved: boolean)` 仅支持 approve/deny，**不支持 trust 模式**（本会话不再询问）。ApprovalHook 协议需扩展 trust 字段，前端需新增"Trust this session"按钮。

报告包含可直接 copy 的 Python 伪代码（ApprovalHook / LimitToolCounts 完整实现）+ JSON schema（事件 payload）+ 6 步实施清单（每步可独立验证 + 五绿过）。

---

## 1. PyPI 实际抓包验证

### 1.1 包基本信息

| 维度 | 实际数据（PyPI 抓取） |
|------|---------------------|
| PyPI 地址 | https://pypi.org/project/strands-agents-tools/ |
| 当前版本 | **0.8.5**（2026-07-22 发布，与 ops-agent 报告一致） |
| License | **Apache-2.0**（OSI Approved :: Apache Software License，AWS 出品） |
| Python 要求 | **>=3.10**（与 TDSF sidecar Python 3.13 兼容 ✓） |
| GitHub | https://github.com/strands-agents/tools（1137 stars / 323 forks / 84 open issues / 79 open PRs） |
| Maintainer | strands-agents（PyPI 用户） |
| Development Status | 4 - Beta |
| OS Support | OS Independent |
| Python 版本支持 | 3.10 / 3.11 / 3.12 / 3.13 / 3.14 |

### 1.2 extras 完整列表（14 个，**修正 ops-agent 报告 §4.1 错误**）

ops-agent 报告 §4.1 列出的 extras 包含 `use_browser`，但 **PyPI 实际主页显示的 14 个 extras 中没有 `use_browser`**。实际正确列表：

| Extra | 用途 | TDSF 是否引入 |
|-------|------|--------------|
| `a2a-client` | Agent-to-Agent 协议客户端 | 否（P3） |
| `agent-core-browser` | AWS Bedrock Agent Core 浏览器 | 否 |
| `agent-core-code-interpreter` | AWS Bedrock Agent Core 代码解释器 | 否 |
| `build` | 构建工具 | 否（仅开发） |
| `dev` | 开发工具 | 否（仅开发） |
| `diagram` | AWS 云图 / UML 图 | 否 |
| `docs` | 文档构建 | 否（仅开发） |
| `elasticsearch-memory` | Elasticsearch 记忆后端 | 否 |
| `local-chromium-browser` | 本地 Chromium 浏览器（替代 use_browser） | 否 |
| `mem0-memory` | Mem0 跨会话记忆 | P2 阶段考虑 |
| `mongodb-memory` | MongoDB Atlas 记忆后端 | 否 |
| `rss` | RSS 订阅 | 否 |
| `twelvelabs` | TwelveLabs 视频理解 | 否 |
| `use-computer` | 桌面自动化 | 否 |

**TDSF P0 阶段决策**：仅安装核心包 `pip install strands-agents-tools>=0.8.5`，**不带任何 extras**（避免 mem0 / browser-use 等链式依赖污染 sidecar）。

### 1.3 4 个 P0 工具 API 签名验证

从 PyPI 主页 Tools Overview 表（共 40+ 工具）确认 4 个 P0 工具的实际签名：

#### 1.3.1 `shell`（带 * 标注，本地 shell 执行）

```python
agent.tool.shell(command="ls -la")
```

| 字段 | 类型 | 说明 |
|------|------|------|
| 参数 | `command: str` | 待执行的 shell 命令 |
| 返回 | `dict` | Strands 工具标准返回（含 stdout / stderr / exit_code） |
| 异常 | `ShellExecutionError` | 命令执行失败时抛出（可被 Hook 捕获） |
| * 标注 | — | 表示该工具可能需要本地 shell 权限（TDSF sidecar 运行在用户机器，已有 shell 权限） |

**TDSF 集成注意**：`shell` 工具在本地 sidecar 进程执行命令，**不通过 SSH**。与现有 `ssh_command` 工具互补（ssh_command 走 RustBridge → 远程服务器；shell 走本地 subprocess）。ApprovalHook 必须拦截 `shell` 工具的高危命令（rm -rf / reboot / shutdown 等），与 `RiskChecker` 复用同一份正则规则。

#### 1.3.2 `http_request`

```python
agent.tool.http_request(method="GET", url="https://api.example.com/data")
```

| 字段 | 类型 | 说明 |
|------|------|------|
| 参数 | `method: str`, `url: str`, 可选 `headers: dict`, `body: str` | HTTP 方法 + URL + 头 + 体 |
| 返回 | `dict` | `{status_code, headers, body}` |
| 异常 | `HttpRequestError` | 网络错误 / 超时 |

**TDSF 集成注意**：ApprovalHook 拦截 `http_request` 的 `POST` / `PUT` / `DELETE` / `PATCH` 方法（写操作），`GET` 不拦截（只读）。

#### 1.3.3 `journal`

```python
agent.tool.journal(action="write", content="Today's progress notes")
```

| 字段 | 类型 | 说明 |
|------|------|------|
| 参数 | `action: str`（write / read / list / clear）, `content: str` | 动作 + 内容 |
| 返回 | `dict` | `{status, entry_id?, entries?}` |
| 异常 | `JournalError` | 文件 IO 错误 |

**TDSF 集成注意**：`journal` 是结构化运维日志，跨轮持久化。**ApprovalHook 不拦截 journal**（写日志是安全操作）。

#### 1.3.4 `editor`（最复杂，有 `command` 子参数）

```python
agent.tool.editor(command="view", path="path/to/file.py")
```

| 字段 | 类型 | 说明 |
|------|------|------|
| 参数 | `command: str`（view / str_replace / create / insert / undo_edit）, `path: str`, 可选 `old_string`, `new_string`, `file_text`, `insert_line`, `new_str` | 命令 + 路径 + 编辑参数 |
| 返回 | `dict` | `{status, content? / diff?}` |
| 异常 | `EditorError` | 文件不存在 / 编辑冲突 |

**TDSF 集成注意**：`editor` 的 `command` 子参数决定了风险等级：
- `view`：只读，不拦截
- `str_replace` / `create` / `insert`：写操作，ApprovalHook 拦截
- `undo_edit`：撤销，拦截（可能丢失用户手动修改）

**与现有 AiToolApproval.tsx 对齐**：前端 `TOOL_META` 已有 `write_file` / `edit` / `multi_edit` / `create_directory` 映射，但**没有 `editor`**。需要在 ApprovalHook 协议中新增 `editor` 工具的 meta（label: "Edit file (Strands)"，icon: FileEditIcon）。

---

## 2. 现有代码审查

### 2.1 Strands 集成架构总览

```
src-tauri/sidecar/
├── strands_backend/
│   ├── __init__.py            # 模块导出
│   ├── adapter.py             # StrandsAgentAdapter + TdsfStrandsCallbackHandler
│   ├── model_adapter.py       # LLMConfig → Strands Model（P0-C5 完成）
│   ├── tools/
│   │   ├── __init__.py         # @tool / RustBridge / ToolContext / RiskChecker / execute_via_ssh / make_all_ops_tools
│   │   ├── ssh_command.py     # SSH 命令执行（内嵌 RiskChecker 审批）
│   │   ├── remote_file.py     # 远程文件读
│   │   ├── log_analyzer.py    # 日志分析（tail/grep/regex）
│   │   ├── process_inspector.py # 进程检查（list/top/detail）
│   │   └── network_diagnostic.py # 网络诊断（ping/ss/netstat/ip/dns）
│   └── tests/
│       └── test_tools.py      # unittest + MagicMock 模式
├── event_bus.py               # EventBus（emit_needs_you / emit_tool_call / emit_mood_change 等）
└── requirements.txt           # strands-agents>=1.0,<2.0（P0-C3 已加）
```

### 2.2 关键代码审查结论

#### 2.2.1 `adapter.py` — StrandsAgentAdapter

**关键发现**：`_get_or_create_agent()` 方法（第 481-528 行）创建 Strands Agent 时，**已注释掉 `max_iterations` 参数**（Strands 1.50.2 移除），注释明确说明用 `LimitToolCounts` hook 替代：

```python
agent = _StrandsAgent(  # type: ignore[misc]
    model=self.strands_model,
    tools=all_tools,
    system_prompt=self.system_prompt,
    callback_handler=handler,
    # max_iterations=self.max_iterations,  # Strands 1.50.2 已移除
)
```

**集成点**：实施 LimitToolCounts 时，需在此处注入 `hooks=[limit_tool_counts_hook]`。`StrandsAgentAdapter.__init__` 已有 `max_iterations: int = 10` 字段，LimitToolCounts 可直接复用此值作为默认上限。

**Agent 缓存机制**：`_agent_cache: dict[str, Any]` 按 `agent_id` 缓存 Agent 实例。**LimitToolCounts Hook 应按 agent_id 实例化**（每个 Agent 独立计数器），避免全局计数导致一个 Agent 耗尽配额影响其他 Agent。

#### 2.2.2 `tools/__init__.py` — RiskChecker（已实现的内部审批）

**关键发现**：`RiskChecker` 已实现 10 条高危命令正则（`rm_rf_root` / `rm_rf` / `reboot` / `mkfs` / `dd_to_disk` / `fork_bomb` / `chmod_777_root` / `killall_system` / `iptables_flush` / `drop_database`），命中时通过 `emit_needs_you` 推送审批事件。

**ApprovalHook 设计决策**：ApprovalHook **不重复实现命令级检测**（已有 RiskChecker），而是在 **工具调用层**拦截敏感工具（`shell` / `editor` 写操作 / `http_request` 写方法）。两层护栏互补：
- **第一层（HookProvider 层）**：ApprovalHook 拦截敏感工具调用，弹窗审批
- **第二层（工具内部）**：RiskChecker 拦截命令级高危（rm -rf / reboot 等）

**复用策略**：ApprovalHook 内部可调用 `RiskChecker.check(command)` 对 `shell` 工具的 `command` 参数做命令级检测，命中高危时直接复用 `RiskChecker.emit_needs_you` 推送审批（与现有 ssh_command 模式一致）。

#### 2.2.3 `event_bus.py` — emit_needs_you 签名

```python
def emit_needs_you(
    self,
    needs_type: str,          # approval / error / question / handoff
    title: str,
    description: str,
    session_id: str | None = None,
    source: str | None = None,
    priority: str = "normal", # high / normal / low
    **extra: Any,             # 任意附加字段（command / risk_level / matched_rules / tool_name 等）
) -> int:
```

**关键发现**：`**extra` 参数已支持任意附加字段，ApprovalHook 可直接传递 `tool_name` / `command` / `risk_level` / `approval_id` / `timeout` 等字段，无需修改 event_bus.py。

#### 2.2.4 `AiToolApproval.tsx` — 前端审批组件

**关键发现**：
- `onRespond: (approved: boolean) => void` — 当前仅支持 approve/deny，**不支持 trust**
- `TOOL_META` 映射表已有 `write_file` / `edit` / `multi_edit` / `create_directory` / `bash_run` / `bash_background`，**缺 `shell` / `editor` / `http_request`**
- `part.approval.id` 是审批 ID（用于关联请求与响应）

**协议扩展需求**：
1. `onRespond` 签名扩展为 `(response: "approve" | "deny" | "trust") => void`
2. `TOOL_META` 新增 `shell` / `editor` / `http_request` 三项
3. UI 新增 "Trust this session" 按钮（amber 色，与 Approve 区分）

#### 2.2.5 `test_tools.py` — 测试模式

测试使用 `unittest + MagicMock`，工厂函数：
- `make_mock_event_bus()` — 记录所有 emit_* 调用
- `make_mock_rust_bridge(response)` — 模拟 ipc_invoke 返回值
- `make_ctx(event_bus, rust_bridge, agent_name, session_id, ssh_session_id)` — 构建测试上下文

**ApprovalHook / LimitToolCounts 测试对齐**：使用同一套 mock 工厂，新增 `make_mock_hook_registry()` 验证 hook 注册 + 回调触发。

---

## 3. ApprovalHook 设计（HITL 高危命令审批）

### 3.1 设计原则

1. **两层护栏互补**：ApprovalHook 拦截工具级敏感调用，工具内 RiskChecker 拦截命令级高危（不重复）。
2. **阻塞 agent loop**：Hook 回调内通过 `threading.Event` 阻塞，等待前端响应（超时默认 deny）。
3. **trust 模式**：用户选 trust 后，本会话内该工具不再弹窗（内存中维护 trusted_tools 集合）。
4. **复用现有 emit_needs_you**：不新增事件类型，ApprovalHook 通过 `emit_needs_you(needs_type="approval", ...)` 推送审批请求。
5. **响应回传**：前端通过新的 JSON-RPC 方法 `approval.respond` 回传响应，sidecar 内部维护 `approval_id → threading.Event` 映射。

### 3.2 Python 伪代码（可直接 copy）

```python
"""
strands_backend/hooks/approval_hook.py — HITL 高危命令审批 Hook
================================================================
职责：
- 拦截敏感工具调用（shell / editor 写操作 / http_request 写方法），
  通过 event_bus.emit_needs_you 推送审批请求，阻塞 agent loop 等待前端响应。
- 与工具内嵌 RiskChecker 互补：Hook 拦截工具级，RiskChecker 拦截命令级。
- 支持 trust 模式：用户选 trust 后本会话内该工具不再弹窗。

设计原则：
1. 不重复实现命令级检测（复用 RiskChecker.check）。
2. 阻塞 agent loop 用 threading.Event（超时默认 deny）。
3. 复用现有 emit_needs_you 事件（不新增事件类型）。
4. 响应回传通过 approval.respond JSON-RPC 方法。
"""
from __future__ import annotations

import logging
import threading
import time
import uuid
from typing import Any

logger = logging.getLogger("sidecar.strands_backend.hooks.approval_hook")

# Strands HookProvider 条件导入（Strands 未安装时降级为空操作）
try:
    from strands.hooks import HookProvider, HookRegistry  # type: ignore[import]
    from strands.hooks.events import BeforeToolCallEvent  # type: ignore[import]
    _HOOKS_AVAILABLE = True
except ImportError:
    _HOOKS_AVAILABLE = False
    HookProvider = object  # type: ignore[misc,assignment]
    HookRegistry = object  # type: ignore[misc,assignment]
    BeforeToolCallEvent = object  # type: ignore[misc,assignment]

# 复用现有 RiskChecker（命令级高危检测）
from strands_backend.tools import RiskChecker


# ============================================================================
# 敏感工具名单 + 写方法判定
# ============================================================================

# 始终需要审批的工具（写操作 / 系统操作）
SENSITIVE_TOOLS_ALWAYS: set[str] = {
    "shell",           # 本地 shell 执行（高危命令需确认）
    "editor",          # 文件写操作（str_replace / create / insert / undo_edit）
}

# 条件审批的工具（仅写方法需审批，GET 不审批）
SENSITIVE_TOOLS_CONDITIONAL: dict[str, set[str]] = {
    "http_request": {"POST", "PUT", "DELETE", "PATCH"},  # 写方法
}

# editor 工具中需要审批的 command 子参数
EDITOR_WRITE_COMMANDS: set[str] = {
    "str_replace", "create", "insert", "undo_edit"
}

# 默认审批超时（秒），超时默认 deny
DEFAULT_APPROVAL_TIMEOUT: int = 30


class ApprovalHook(HookProvider):
    """HITL 高危命令审批 Hook

    在 Strands Agent 调用工具前拦截敏感工具，通过 event_bus 推送审批请求，
    阻塞 agent loop 等待前端响应（approve / deny / trust）。

    Args:
        event_bus: EventBus 实例（用于 emit_needs_you）
        agent_id: Agent 标识（用于事件 source + 缓存键）
        session_id: 会话 ID（用于事件路由）
        timeout: 审批超时秒数（默认 30，超时默认 deny）
        trusted_tools: 可选，已信任的工具集合（注入时复用，跨 Agent 共享）

    用法（在 StrandsAgentAdapter._get_or_create_agent 中注入）：

        from strands_backend.hooks.approval_hook import ApprovalHook

        approval_hook = ApprovalHook(
            event_bus=self.event_bus,
            agent_id=agent_id,
            session_id=ctx.session_id,
            trusted_tools=self._trusted_tools,  # 跨 Agent 共享
        )
        agent = _StrandsAgent(
            model=self.strands_model,
            tools=all_tools,
            system_prompt=self.system_prompt,
            callback_handler=handler,
            hooks=[approval_hook],  # 新增
        )
    """

    def __init__(
        self,
        event_bus: Any,
        agent_id: str,
        session_id: str,
        timeout: int = DEFAULT_APPROVAL_TIMEOUT,
        trusted_tools: set[str] | None = None,
    ) -> None:
        self.event_bus = event_bus
        self.agent_id = agent_id
        self.session_id = session_id
        self.timeout = timeout
        # trusted_tools 跨 Agent 共享（由 StrandsAgentAdapter 持有，注入各 Hook）
        self.trusted_tools: set[str] = trusted_tools if trusted_tools is not None else set()
        # approval_id → threading.Event 映射（等待前端响应）
        self._pending: dict[str, threading.Event] = {}
        # approval_id → response 映射（"approve" / "deny" / "trust"）
        self._responses: dict[str, str] = {}
        self._lock = threading.Lock()

    # ========================================================================
    # HookProvider 协议实现
    # ========================================================================

    def register_hooks(self, registry: HookRegistry, **kwargs: Any) -> None:
        """注册 BeforeToolCallEvent 回调"""
        if not _HOOKS_AVAILABLE:
            logger.warning(
                "ApprovalHook.register_hooks: strands.hooks not available, "
                "approval disabled (degrade to no-op)"
            )
            return
        registry.add_callback(BeforeToolCallEvent, self._on_before_tool_call)

    # ========================================================================
    # BeforeToolCallEvent 回调（核心拦截逻辑）
    # ========================================================================

    def _on_before_tool_call(self, event: BeforeToolCallEvent) -> None:
        """工具调用前拦截敏感工具，发起审批

        Strands Hook 协议：
        - 抛异常 → 阻止工具调用（agent loop 收到错误）
        - 正常返回 → 继续执行工具
        - event.tool_name: 工具名
        - event.input: 工具参数 dict
        """
        tool_name = getattr(event, "tool_name", "")
        tool_input = getattr(event, "input", {}) or {}

        # 1. 检查是否需要审批
        if not self._needs_approval(tool_name, tool_input):
            return  # 不需要审批，继续执行

        # 2. 检查 trust 模式（本会话已信任的工具不再弹窗）
        if tool_name in self.trusted_tools:
            logger.debug(
                f"ApprovalHook: tool={tool_name} trusted, skipping approval"
            )
            return

        # 3. 命令级高危检测（复用 RiskChecker）
        command = tool_input.get("command", "")
        risk_result = RiskChecker.check(command) if command else None

        # 4. 生成 approval_id + 推送审批请求
        approval_id = f"approval-{uuid.uuid4().hex[:8]}"
        self._publish_approval_request(
            approval_id=approval_id,
            tool_name=tool_name,
            tool_input=tool_input,
            risk_result=risk_result,
        )

        # 5. 阻塞等待前端响应（超时默认 deny）
        response = self._wait_for_response(approval_id)

        # 6. 处理响应
        if response == "trust":
            # trust：本会话内该工具不再弹窗
            self.trusted_tools.add(tool_name)
            return  # 继续执行
        elif response == "approve":
            return  # 继续执行
        else:
            # deny / 超时
            raise ToolDeniedException(
                f"Tool {tool_name} denied by user (response={response})"
            )

    # ========================================================================
    # 审批判定
    # ========================================================================

    def _needs_approval(self, tool_name: str, tool_input: dict) -> bool:
        """判断工具调用是否需要审批"""
        # 始终审批的工具
        if tool_name in SENSITIVE_TOOLS_ALWAYS:
            # editor 特殊处理：仅写 command 需审批
            if tool_name == "editor":
                cmd = tool_input.get("command", "")
                return cmd in EDITOR_WRITE_COMMANDS
            return True

        # 条件审批的工具（按方法判定）
        if tool_name in SENSITIVE_TOOLS_CONDITIONAL:
            write_methods = SENSITIVE_TOOLS_CONDITIONAL[tool_name]
            method = tool_input.get("method", "GET").upper()
            return method in write_methods

        return False

    # ========================================================================
    # 事件发布 + 阻塞等待
    # ========================================================================

    def _publish_approval_request(
        self,
        approval_id: str,
        tool_name: str,
        tool_input: dict,
        risk_result: dict | None,
    ) -> None:
        """通过 event_bus.emit_needs_you 推送审批请求"""
        if self.event_bus is None:
            logger.warning("ApprovalHook: no event_bus, auto-deny")
            self._responses[approval_id] = "deny"
            return

        title = f"工具审批请求: {tool_name}"
        if risk_result and risk_result.get("high_risk"):
            title = f"高危命令审批: {risk_result.get('matched_rules', ['unknown'])[0]}"

        description_parts = [
            f"Agent {self.agent_id} 试图调用工具 {tool_name}",
            f"参数: {self._format_input(tool_name, tool_input)}",
        ]
        if risk_result and risk_result.get("high_risk"):
            description_parts.append(
                f"风险等级: {risk_result.get('level', 'L4')}"
            )
            description_parts.append(
                f"原因: {risk_result.get('reason', '')}"
            )

        try:
            self.event_bus.emit_needs_you(
                needs_type="approval",
                title=title,
                description="\n".join(description_parts),
                session_id=self.session_id or None,
                source=f"{self.agent_id}_agent.strands_hook.approval",
                priority="high" if (risk_result and risk_result.get("high_risk")) else "normal",
                # 附加字段（前端 AiToolApproval.tsx 用于渲染）
                approval_id=approval_id,
                tool_name=tool_name,
                tool_input=tool_input,
                risk=risk_result,
                timeout=self.timeout,
                # 响应回传协议：前端通过 approval.respond JSON-RPC 回传
                respond_method="approval.respond",
            )
        except Exception as e:
            logger.exception(f"ApprovalHook emit_needs_you failed: {e}")
            self._responses[approval_id] = "deny"

    def _wait_for_response(self, approval_id: str) -> str:
        """阻塞等待前端响应（超时默认 deny）"""
        event = threading.Event()
        with self._lock:
            self._pending[approval_id] = event

        logger.info(
            f"ApprovalHook waiting: approval_id={approval_id}, "
            f"timeout={self.timeout}s"
        )

        # 阻塞等待（agent loop 在此暂停）
        triggered = event.wait(timeout=self.timeout)

        with self._lock:
            self._pending.pop(approval_id, None)
            response = self._responses.pop(approval_id, "deny")  # 默认 deny

        if not triggered:
            logger.warning(
                f"ApprovalHook timeout: approval_id={approval_id}, "
                f"auto-deny after {self.timeout}s"
            )

        return response

    # ========================================================================
    # 响应回传（由 main.py 的 approval.respond JSON-RPC 方法调用）
    # ========================================================================

    def respond(self, approval_id: str, response: str) -> bool:
        """前端响应回传入口

        Args:
            approval_id: 审批 ID（来自 emit_needs_you 的 approval_id 字段）
            response: "approve" / "deny" / "trust"

        Returns:
            True 表示成功唤醒等待的 Hook；False 表示 approval_id 不存在或已超时
        """
        with self._lock:
            event = self._pending.get(approval_id)
            if event is None:
                logger.warning(
                    f"ApprovalHook.respond: approval_id={approval_id} "
                    f"not found (expired or unknown)"
                )
                return False
            self._responses[approval_id] = response
            event.set()  # 唤醒等待的 _wait_for_response

        logger.info(
            f"ApprovalHook responded: approval_id={approval_id}, "
            f"response={response}"
        )
        return True

    # ========================================================================
    # 辅助方法
    # ========================================================================

    @staticmethod
    def _format_input(tool_name: str, tool_input: dict) -> str:
        """格式化工具参数用于展示（截断长内容）"""
        if tool_name == "shell":
            return f"command={tool_input.get('command', '')[:200]}"
        elif tool_name == "editor":
            return (
                f"command={tool_input.get('command', '')}, "
                f"path={tool_input.get('path', '')}"
            )
        elif tool_name == "http_request":
            return (
                f"method={tool_input.get('method', 'GET')}, "
                f"url={tool_input.get('url', '')[:200]}"
            )
        return str(tool_input)[:300]


class ToolDeniedException(Exception):
    """工具被用户拒绝时抛出（被 Strands agent loop 捕获，终止该工具调用）"""
    pass


__all__ = [
    "ApprovalHook",
    "ToolDeniedException",
    "SENSITIVE_TOOLS_ALWAYS",
    "SENSITIVE_TOOLS_CONDITIONAL",
    "EDITOR_WRITE_COMMANDS",
    "DEFAULT_APPROVAL_TIMEOUT",
]
```

### 3.3 事件路径（Hook → 前端 → 回传）

```
Strands Agent 调用 shell("rm -rf /tmp/old")
   ↓
BeforeToolCallEvent 触发
   ↓
ApprovalHook._on_before_tool_call(event)
   ↓
   ├─ _needs_approval("shell", {command:"rm..."}) → True
   ├─ RiskChecker.check("rm -rf /tmp/old") → high_risk=False（不是根目录）
   ├─ _publish_approval_request(approval_id="approval-abc123", ...)
   │   ↓
   │   event_bus.emit_needs_you(
   │     needs_type="approval",
   │     approval_id="approval-abc123",
   │     tool_name="shell",
   │     tool_input={"command":"rm -rf /tmp/old"},
   │     respond_method="approval.respond",
   │     ...
   │   )
   │   ↓
   │   EventBus.publish → Rust send_notification → Tauri emit "sidecar:needs_you"
   │   ↓
   │   前端 sidecar-bridge.ts onNeedsYou callback
   │   ↓
   │   AiToolApproval.tsx 渲染审批卡片（含 Approve / Deny / Trust 按钮）
   ↓
_wait_for_response("approval-abc123") 阻塞（threading.Event.wait(30s)）
   ↓
用户点击 "Approve"
   ↓
前端 invoke("approval.respond", {approval_id:"approval-abc123", response:"approve"})
   ↓
Rust 收到 invoke → JSON-RPC request → sidecar approval.respond 方法
   ↓
ApprovalHook.respond("approval-abc123", "approve")
   ↓
self._responses["approval-abc123"] = "approve"
self._pending["approval-abc123"].set()  # 唤醒阻塞的 _wait_for_response
   ↓
_wait_for_response 返回 "approve"
   ↓
ApprovalHook._on_before_tool_call 正常返回
   ↓
Strands Agent 继续执行 shell 工具
```

### 3.4 AiToolApproval 协议 JSON Schema

**事件 payload（sidecar → 前端）**：

```json
{
  "event_type": "needs_you",
  "payload": {
    "needs_type": "approval",
    "title": "工具审批请求: shell",
    "description": "Agent main 试图调用工具 shell\n参数: command=rm -rf /tmp/old",
    "priority": "normal",
    "approval_id": "approval-abc12345",
    "tool_name": "shell",
    "tool_input": {
      "command": "rm -rf /tmp/old"
    },
    "risk": null,
    "timeout": 30,
    "respond_method": "approval.respond"
  },
  "session_id": "sess-xxx",
  "source": "main_agent.strands_hook.approval",
  "timestamp": 1785400000.0
}
```

**响应回传（前端 → sidecar，通过 Tauri invoke）**：

```typescript
// 前端调用（扩展 sidecar-bridge.ts）
await invoke("approval.respond", {
  approval_id: "approval-abc12345",
  response: "approve"  // "approve" | "deny" | "trust"
});
// 返回 { ok: boolean, message?: string }
```

**Rust 侧路由**（新增 Tauri command `approval.respond`，转发到 sidecar JSON-RPC）：

```rust
// src-tauri/src/modules/sidecar.rs（伪代码，实施时由 implementer 写）
#[tauri::command]
async fn approval_respond(
    state: State<SidecarState>,
    approval_id: String,
    response: String,
) -> Result<bool, String> {
    state.send_request("approval.respond", json!({
        "approval_id": approval_id,
        "response": response
    })).await.map(|v| v["ok"].as_bool().unwrap_or(false))
}
```

---

## 4. LimitToolCounts Hook 设计

### 4.1 设计原则

1. **按 Agent 分别计数**：现有 `StrandsAgentAdapter._agent_cache` 按 `agent_id` 缓存 Agent，LimitToolCounts 也应按 agent_id 实例化（每个 Agent 独立计数器），避免一个 Agent 耗尽配额影响其他 Agent。
2. **触发上限时抛异常**：Strands agent loop 捕获异常后终止，返回错误信息给用户（graceful stop 比 silent stop 更明确）。
3. **默认上限 50 次**：与 ops-agent 报告 §5.1.1 一致（可配置）。
4. **复用 `StrandsAgentAdapter.max_iterations` 字段**：现有 `max_iterations: int = 10` 字段直接作为 LimitToolCounts 的 `max_calls` 参数（语义从"迭代次数"变为"工具调用次数"，更精确）。
5. **不区分工具类型**：所有工具调用统一计数（简化实现，未来可扩展按工具类型分别计数）。

### 4.2 Python 伪代码（可直接 copy）

```python
"""
strands_backend/hooks/limit_tool_counts.py — 工具调用次数限制 Hook
===================================================================
职责：
- 替代 Strands 1.50.2 移除的 max_iterations 参数。
- 按 Agent 分别计数（每个 Agent 独立计数器）。
- 触发上限时抛 MaxToolCallsExceeded 异常，Strands agent loop 捕获后终止。

设计原则：
1. 按 agent_id 实例化（与 StrandsAgentAdapter._agent_cache 对齐）。
2. 触发上限抛异常（graceful stop，明确告知用户）。
3. 复用 StrandsAgentAdapter.max_iterations 字段作为默认上限。
4. 不区分工具类型（未来可扩展）。

背景：
- Strands 1.50.2 移除了 Agent.__init__() 的 max_iterations 参数。
- 官方推荐用 HookProvider + BeforeToolCallEvent 实现迭代控制。
- LimitToolCounts 是社区惯例命名（非官方 API，但实现简单可自维护）。
"""
from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("sidecar.strands_backend.hooks.limit_tool_counts")

# Strands HookProvider 条件导入
try:
    from strands.hooks import HookProvider, HookRegistry  # type: ignore[import]
    from strands.hooks.events import BeforeToolCallEvent  # type: ignore[import]
    _HOOKS_AVAILABLE = True
except ImportError:
    _HOOKS_AVAILABLE = False
    HookProvider = object  # type: ignore[misc,assignment]
    HookRegistry = object  # type: ignore[misc,assignment]
    BeforeToolCallEvent = object  # type: ignore[misc,assignment]

# 默认工具调用上限（与 StrandsAgentAdapter.max_iterations 默认值对齐）
DEFAULT_MAX_TOOL_CALLS: int = 50


class LimitToolCounts(HookProvider):
    """工具调用次数限制 Hook

    在 Strands Agent 每次调用工具前递增计数器，超过上限时抛异常终止 agent loop。

    Args:
        max_calls: 最大工具调用次数（默认 50）
        agent_id: Agent 标识（用于日志 + 计数器隔离）

    用法（在 StrandsAgentAdapter._get_or_create_agent 中注入）：

        from strands_backend.hooks.limit_tool_counts import LimitToolCounts

        limit_hook = LimitToolCounts(
            max_calls=self.max_iterations,  # 复用现有字段
            agent_id=agent_id,
        )
        agent = _StrandsAgent(
            model=self.strands_model,
            tools=all_tools,
            system_prompt=self.system_prompt,
            callback_handler=handler,
            hooks=[approval_hook, limit_hook],  # 多个 Hook 组合
        )

    设计选择（按 Agent 分别计数 vs 全局计数）：
    - 选择按 Agent 分别计数：每个 Agent 独立计数器，避免一个 Agent 耗尽配额影响其他 Agent。
    - 与 StrandsAgentAdapter._agent_cache 对齐：每个 agent_id 一个 Agent 实例 + 一个 LimitToolCounts 实例。
    - 跨 Agent 全局计数（如限制总 LLM 调用成本）可在 StrandsAgentAdapter 层实现（聚合各 Agent 计数）。

    触发上限时的行为（抛异常 vs graceful stop）：
    - 选择抛异常：Strands agent loop 捕获异常后终止，返回错误信息给用户。
    - 比 graceful stop（返回特殊值让 Agent 自然结束）更明确，避免 Agent 困惑。
    - 异常类型 MaxToolCallsExceeded 被 StrandsAgentAdapter.invoke 的 try/except 捕获，
      转为 next_step="error" + mood="error" + emit_needs_you(needs_type="error")。
    """

    def __init__(
        self,
        max_calls: int = DEFAULT_MAX_TOOL_CALLS,
        agent_id: str = "main",
    ) -> None:
        self.max_calls = max_calls
        self.agent_id = agent_id
        self.call_count: int = 0
        self._lock = __import__("threading").Lock()  # 线程安全计数器

    # ========================================================================
    # HookProvider 协议实现
    # ========================================================================

    def register_hooks(self, registry: HookRegistry, **kwargs: Any) -> None:
        """注册 BeforeToolCallEvent 回调"""
        if not _HOOKS_AVAILABLE:
            logger.warning(
                f"LimitToolCounts.register_hooks: strands.hooks not available, "
                f"limit disabled for agent={self.agent_id}"
            )
            return
        registry.add_callback(BeforeToolCallEvent, self._on_before_tool_call)

    # ========================================================================
    # BeforeToolCallEvent 回调
    # ========================================================================

    def _on_before_tool_call(self, event: BeforeToolCallEvent) -> None:
        """工具调用前递增计数器，超过上限抛异常

        Strands Hook 协议：
        - 抛异常 → 阻止工具调用 + 终止 agent loop
        - 正常返回 → 继续执行工具
        """
        with self._lock:
            self.call_count += 1
            current = self.call_count

        tool_name = getattr(event, "tool_name", "unknown")

        if current > self.max_calls:
            logger.warning(
                f"LimitToolCounts exceeded: agent={self.agent_id}, "
                f"count={current}, max={self.max_calls}, "
                f"tool={tool_name}, raising MaxToolCallsExceeded"
            )
            raise MaxToolCallsExceeded(
                f"Agent {self.agent_id} reached max tool calls "
                f"({self.max_calls}), last attempted tool: {tool_name}"
            )

        logger.debug(
            f"LimitToolCounts: agent={self.agent_id}, "
            f"count={current}/{self.max_calls}, tool={tool_name}"
        )

    # ========================================================================
    # 状态查询（调试用）
    # ========================================================================

    def get_stats(self) -> dict[str, Any]:
        """获取计数器状态（调试用）"""
        with self._lock:
            return {
                "agent_id": self.agent_id,
                "call_count": self.call_count,
                "max_calls": self.max_calls,
                "remaining": max(0, self.max_calls - self.call_count),
                "exceeded": self.call_count > self.max_calls,
            }


class MaxToolCallsExceeded(Exception):
    """工具调用次数超限异常

    被 Strands agent loop 捕获后终止，StrandsAgentAdapter.invoke 的 try/except
    捕获后转为 next_step="error" + mood="error" + emit_needs_you(needs_type="error")。
    """
    pass


__all__ = [
    "LimitToolCounts",
    "MaxToolCallsExceeded",
    "DEFAULT_MAX_TOOL_CALLS",
]
```

### 4.3 与 StrandsAgentAdapter 集成点

在 `adapter.py` 的 `_get_or_create_agent` 方法中注入两个 Hook：

```python
# adapter.py 修改示例（implementer 实施时参考）

def _get_or_create_agent(self, agent_id: str, ctx: ToolContext) -> Any:
    if agent_id in self._agent_cache:
        return self._agent_cache[agent_id]

    ops_tools = make_all_ops_tools(ctx)
    all_tools = ops_tools + self.extra_tools

    handler = TdsfStrandsCallbackHandler(
        event_bus=self.event_bus,
        agent_name=agent_id,
        session_id=ctx.session_id,
    )

    # 新增：构建 hooks 列表
    hooks: list = []
    if self._hooks_available:
        from strands_backend.hooks.approval_hook import ApprovalHook
        from strands_backend.hooks.limit_tool_counts import LimitToolCounts

        # 跨 Agent 共享 trusted_tools 集合
        if not hasattr(self, "_trusted_tools"):
            self._trusted_tools = set()

        approval_hook = ApprovalHook(
            event_bus=self.event_bus,
            agent_id=agent_id,
            session_id=ctx.session_id,
            trusted_tools=self._trusted_tools,  # 跨 Agent 共享
        )
        limit_hook = LimitToolCounts(
            max_calls=self.max_iterations,  # 复用现有字段
            agent_id=agent_id,
        )
        hooks = [approval_hook, limit_hook]

    agent = _StrandsAgent(  # type: ignore[misc]
        model=self.strands_model,
        tools=all_tools,
        system_prompt=self.system_prompt,
        callback_handler=handler,
        hooks=hooks if hooks else None,  # Strands 不可用时传 None
        # max_iterations=self.max_iterations,  # Strands 1.50.2 已移除
    )

    self._agent_cache[agent_id] = agent
    return agent
```

---

## 5. 工程量重估 + 风险评估

### 5.1 工程量重估（对照 ops-agent §5.2 修正）

| 任务 | ops-agent §5.2 估算 | 本报告重估 | 差异原因 |
|------|--------------------|-----------|---------|
| strands-agents-tools 引入 + 4 工具注入 | 0.5 人日 | **0.75 人日** | `editor` 工具有 `command` 子参数（view/str_replace/create/insert/undo_edit），需额外 wrapper 转发；`shell` 工具需复用 RiskChecker 做命令级检测 |
| ApprovalHook + 前端联动 | 1.5 人日 | **2.0 人日** | 需实现双向事件等待机制（threading.Event 阻塞 + approval.respond JSON-RPC 回传）；前端 `AiToolApproval.tsx` 需扩展 trust 按钮 + 新增 3 个工具的 TOOL_META；Rust 侧需新增 `approval.respond` Tauri command |
| LimitToolCounts Hook | 0.5 人日 | **0.5 人日** | 实现简单（计数器 + 抛异常），与 ops-agent 估算一致 |
| **P0 小计** | **2.5 人日** | **3.25 人日** | +0.75 人日（+30%） |

**重估依据**：实际代码审查发现 ApprovalHook 比预估复杂——需要双向事件等待（sidecar 阻塞 + 前端回传 + Rust 路由），ops-agent §5.2 仅估了"前端联动"但未考虑 Rust 侧 Tauri command 新增 + JSON-RPC 方法注册。LimitToolCounts 简单不变。

### 5.2 风险评估（对照 ops-agent §5.3 修正 + 新增）

| 风险 | 等级 | ops-agent §5.3 | 本报告补充 |
|------|------|----------------|-----------|
| strands-agents-tools 引入新依赖（mem0 等链式依赖） | 中 | 只装核心包，extras 按需 | **核心包本身依赖**：需在实施步骤 1 后跑 `pip install` + `pip show strands-agents-tools` 验证传递依赖列表，确认无 mem0 / browser-use 等意外依赖 |
| ApprovalHook 阻塞 agent loop，可能导致前端超时 | 中 | 设置审批超时（30s）+ 超时默认拒绝 | **新增**：Strands callback_handler 是同步调用，Hook 阻塞期间 event_bus 不再推送 tool_call started 事件，前端可能显示"工具调用中"卡住。需在 ApprovalHook 推送审批请求时同步推送 tool_call started（status="awaiting_approval"）让前端显示审批卡片 |
| swarm 多 Agent 模式 LLM 成本 | 中 | 限制 max_handoffs / max_iterations / node_timeout | P1 阶段风险，P0 不涉及 |
| k8sgpt MCP 需要 K8s 集群 | 低 | 可选功能，graceful degrade | P1 阶段风险，P0 不涉及 |
| LimitToolCounts 是社区惯例非官方 API | 低 | Hook 系统是官方稳定 API | **补充**：实际审查 Strands 1.50.2 后确认 `HookProvider` / `HookRegistry` / `BeforeToolCallEvent` 是官方稳定 API（strands.hooks 模块），LimitToolCounts 基于官方 API 实现，风险极低 |
| **新增**：AiToolApproval.tsx 不支持 trust 模式 | 中 | 未提及 | 前端需扩展 `onRespond` 签名为 `(response: "approve" \| "deny" \| "trust") => void` + 新增 "Trust this session" 按钮（amber 色） |
| **新增**：ApprovalHook 与工具内 RiskChecker 重复拦截 | 低 | 未提及 | ApprovalHook 拦截工具级（shell/editor/http_request 写方法），RiskChecker 拦截命令级（rm -rf 等），两层互补不重复。ApprovalHook 内部复用 RiskChecker.check 对 shell 工具的 command 参数做命令级检测 |
| **新增**：rust_bridge=None 时 shell 工具无法执行 | 低 | 未提及 | shell 工具是本地执行（subprocess），不依赖 rust_bridge。但需确认 sidecar 进程的 shell 权限（用户机器本地，已有权限） |

---

## 6. P0 实施步骤清单（按依赖顺序，每步可独立验证 + 五绿过）

### 步骤 1：requirements.txt 加 strands-agents-tools>=0.8.5（仅核心，不带 extras）

**文件**：`src-tauri/sidecar/requirements.txt`

**改动**：
```diff
strands-agents>=1.0,<2.0
+ strands-agents-tools>=0.8.5,<0.9  # P0 新增：4 个运维工具（shell/http_request/journal/editor），不带 extras
```

**验证**：
```bash
cd src-tauri/sidecar
pip install -r requirements.txt
pip show strands-agents-tools  # 确认版本 0.8.5+
pip show strands-agents-tools | grep Requires  # 检查传递依赖，确认无 mem0/browser-use
python -c "from strands_tools import shell, http_request, journal, editor; print('OK')"  # 验证导入
```

**五绿**：`pnpm typecheck`（无 TS 改动，应过）+ `pnpm lint`（无 TS 改动，应过）+ `pnpm test`（无前端改动，应过）+ `pnpm build:web`（应过）+ `pnpm tauri:dev`（sidecar 启动应正常，Strands 仍条件依赖）。

### 步骤 2：strands_backend/tools/ 新增 4 个工具 wrapper

**新增文件**：
- `src-tauri/sidecar/strands_backend/tools/shell_wrapper.py`
- `src-tauri/sidecar/strands_backend/tools/http_request_wrapper.py`
- `src-tauri/sidecar/strands_backend/tools/journal_wrapper.py`
- `src-tauri/sidecar/strands_backend/tools/editor_wrapper.py`

**改动**：`src-tauri/sidecar/strands_backend/tools/__init__.py` 的 `make_all_ops_tools()` 函数追加 4 个 wrapper。

**wrapper 设计原则**：
- `shell_wrapper`：包装 Strands `shell` 工具，**复用 RiskChecker** 对 `command` 参数做命令级检测（与 ssh_command 一致模式）。命中高危时 emit_needs_you + 返回 needs_approval 状态。
- `http_request_wrapper`：直接转发 Strands `http_request` 工具（写方法由 ApprovalHook 拦截，wrapper 不重复检测）。
- `journal_wrapper`：直接转发 Strands `journal` 工具（写日志安全，不拦截）。
- `editor_wrapper`：包装 Strands `editor` 工具，根据 `command` 子参数决定是否触发审批（view 不拦截，str_replace/create/insert/undo_edit 由 ApprovalHook 拦截）。

**验证**：
```bash
cd src-tauri/sidecar
python -m pytest strands_backend/tests/test_tools.py -v  # 现有测试应全过
python -c "from strands_backend.tools import make_all_ops_tools; print(len(make_all_ops_tools(__import__('strands_backend.tools', fromlist=['ToolContext']).ToolContext())))"  # 应返回 9（5 现有 + 4 新增）
```

新增测试文件：`strands_backend/tests/test_strands_tools_wrappers.py`，覆盖 4 个 wrapper 的核心路径（成功 + 高危拦截 + 异常）。

**五绿**：`pnpm typecheck` + `pnpm lint` + `pnpm test`（新增 Python 测试不影响 vitest）+ `pnpm build:web` + `pnpm tauri:dev`（CDP 验证 sidecar 启动 + Strands 工具列表含 9 个）。

### 步骤 3：strands_backend/hooks/ 新建 approval_hook.py + limit_tool_counts.py

**新增文件**：
- `src-tauri/sidecar/strands_backend/hooks/__init__.py`（导出 ApprovalHook / LimitToolCounts / MaxToolCallsExceeded / ToolDeniedException）
- `src-tauri/sidecar/strands_backend/hooks/approval_hook.py`（见本报告 §3.2 伪代码）
- `src-tauri/sidecar/strands_backend/hooks/limit_tool_counts.py`（见本报告 §4.2 伪代码）

**验证**：
```bash
cd src-tauri/sidecar
python -c "from strands_backend.hooks import ApprovalHook, LimitToolCounts; print('OK')"
python -m pytest strands_backend/tests/test_hooks.py -v  # 新增测试
```

新增测试文件：`strands_backend/tests/test_hooks.py`，覆盖：
- ApprovalHook: 敏感工具拦截 + 非敏感工具放行 + trust 模式 + 超时默认 deny + respond 回传
- LimitToolCounts: 计数器递增 + 超限抛异常 + 按 Agent 隔离

**五绿**：同步骤 2（Python 测试不影响前端五绿）。

### 步骤 4：adapter.py 注册 hooks 到 Agent(hooks=[...])

**改动文件**：`src-tauri/sidecar/strands_backend/adapter.py`

**改动点**：
1. `StrandsAgentAdapter.__init__` 新增 `trusted_tools: set[str] = field(default_factory=set)`（跨 Agent 共享）
2. `_get_or_create_agent` 方法注入 hooks（见本报告 §4.3 集成点伪代码）
3. 新增 `respond_approval(self, approval_id, response)` 方法（转发到对应 Agent 的 ApprovalHook.respond）

**新增方法**：
```python
def respond_approval(self, approval_id: str, response: str) -> bool:
    """转发审批响应到对应 Agent 的 ApprovalHook（供 main.py 的 approval.respond RPC 调用）"""
    # 遍历所有缓存的 Agent 找到对应的 ApprovalHook
    # （approval_id 全局唯一，但 Hook 实例按 agent_id 隔离）
    for agent_id, agent in self._agent_cache.items():
        hooks = getattr(agent, "hooks", []) or []
        for hook in hooks:
            if hasattr(hook, "respond") and hasattr(hook, "_pending"):
                if approval_id in hook._pending:
                    return hook.respond(approval_id, response)
    return False
```

**验证**：
```bash
cd src-tauri/sidecar
python -m pytest strands_backend/tests/test_tools.py -v  # 现有测试应全过
python -c "from strands_backend.adapter import StrandsAgentAdapter; a = StrandsAgentAdapter(event_bus=None, backend_enabled=False); print(a.get_stats())"
```

**五绿**：同步骤 3。

### 步骤 5：前端 AiToolApproval.tsx 联动协议实现

**改动文件**：
- `src/modules/ai/components/AiToolApproval.tsx` — 扩展 onRespond + 新增 3 个工具 TOOL_META + Trust 按钮
- `src/lib/sidecar-bridge.ts` — 新增 `respondApproval(approvalId, response)` 函数
- `src-tauri/src/modules/sidecar.rs` — 新增 `approval.respond` Tauri command（转发到 sidecar JSON-RPC）
- `src-tauri/capabilities/default.json` — 新增 `core:sidecar:allow-approval-respond` 权限

**AiToolApproval.tsx 改动点**：
1. `onRespond` 签名从 `(approved: boolean) => void` 扩展为 `(response: "approve" | "deny" | "trust") => void`
2. `TOOL_META` 新增：
   ```typescript
   shell: { label: "Run shell command (local)", icon: TerminalIcon },
   editor: { label: "Edit file (Strands)", icon: FileEditIcon },
   http_request: { label: "HTTP request", icon: NetworkIcon },
   ```
3. UI 新增 "Trust this session" 按钮（amber 色 variant="outline"，与 Approve variant="default" 区分）
4. PreviewBlock 新增 `shell` / `http_request` / `editor` 的预览逻辑

**sidecar-bridge.ts 改动点**：
```typescript
export async function respondApproval(
  approvalId: string,
  response: "approve" | "deny" | "trust"
): Promise<boolean> {
  return invoke("approval.respond", { approvalId, response });
}
```

**Rust sidecar.rs 改动点**：
```rust
#[tauri::command]
async fn approval_respond(
    state: State<'_, SidecarState>,
    approval_id: String,
    response: String,
) -> Result<bool, String> {
    state.send_jsonrpc_request("approval.respond", json!({
        "approval_id": approval_id,
        "response": response
    })).await
        .map(|v| v.get("ok").and_then(|ok| ok.as_bool()).unwrap_or(false))
        .map_err(|e| e.to_string())
}
```

**验证**：
```bash
pnpm typecheck  # TS 类型应过
pnpm lint       # ESLint 应过
pnpm test       # 新增前端单测：AiToolApproval 三按钮 + respondApproval 调用
pnpm build:web  # 构建应过
pnpm tauri:dev  # CDP 验证：触发审批 → 前端弹窗 → 点击 Approve/Deny/Trust → 响应回传
```

**五绿**：全部需过（本步涉及 TS/TSX/Rust 改动）。

### 步骤 6：测试 + 五绿 + commit

**测试清单**：
1. `strands_backend/tests/test_strands_tools_wrappers.py` — 4 个 wrapper 单测
2. `strands_backend/tests/test_hooks.py` — ApprovalHook + LimitToolCounts 单测
3. `strands_backend/tests/test_adapter_hooks.py` — adapter 注入 hooks + respond_approval 转发
4. `src/modules/ai/components/__tests__/AiToolApproval.test.tsx` — 三按钮 + respondApproval
5. CDP 实测脚本：`cdp-p0-hooks-approval.mjs` — 端到端验证审批链路

**五绿**：
```bash
pnpm typecheck   # tsc -p tsconfig.app.json && tsc -p tsconfig.node.json
pnpm lint         # eslint . --max-warnings 0
pnpm test         # vitest run
pnpm build:web    # tsc -p app + vite build
pnpm tauri:dev    # 桌面端实测：触发 shell("ls") → 审批弹窗 → Approve → 命令执行
```

**commit**：
```bash
git add src-tauri/sidecar/strands_backend/ src-tauri/sidecar/requirements.txt \
        src-tauri/src/modules/sidecar.rs src-tauri/capabilities/default.json \
        src/modules/ai/components/AiToolApproval.tsx src/lib/sidecar-bridge.ts
git commit -m "feat(strands): integrate strands-agents-tools 0.8.5 + ApprovalHook + LimitToolCounts

- Add strands-agents-tools>=0.8.5 to requirements.txt (core only, no extras)
- Add 4 ops tool wrappers: shell / http_request / journal / editor
- Add ApprovalHook (HITL): intercept sensitive tools, block agent loop, wait for frontend response
- Add LimitToolCounts Hook: replace removed max_iterations, per-agent counter
- Inject hooks into StrandsAgentAdapter._get_or_create_agent
- Frontend: AiToolApproval.tsx extends onRespond to support trust mode
- Frontend: sidecar-bridge.ts adds respondApproval() function
- Rust: sidecar.rs adds approval.respond Tauri command

Closes P0-1 (ApprovalHook), P0-2 (LimitToolCounts), P0-3 (4 tools)"
```

---

## 7. 引用链接

### strands-agents-tools
- PyPI 主页：https://pypi.org/project/strands-agents-tools/
- GitHub 仓库：https://github.com/strands-agents/tools
- 官方文档：https://strandsagents.com/
- Strands SDK 仓库：https://github.com/strands-agents/sdk-python

### Strands Hooks 系统
- AWS Healthcare HITL 博客（4 种 HITL 模式）：https://aws.amazon.com/cn/blogs/machine-learning/human-in-the-loop-constructs-for-agentic-workflows-in-healthcare-and-life-sciences/
- Strands 官方文档（Agent Loop）：https://strandsagents.com/docs/user-guide/concepts/agents/agent-loop/
- AWS Workshop Lab 9b（Swarm）：https://catalog.workshops.aws/strands-agents/en-US/20-multi-agent-topology/20b-swarm

### TDSF 现有架构
- 项目开发规范：`CLAUDE.md`
- 运维 agent 调研报告：`docs/reports/ops-agent-research-2026-07-30.md`
- 项目当前状态：`docs/dev-state.md`（§十五 P0-E 阶段 A 完成情况）
- 多 agent 协作规范：`docs/MULTI-AGENT-WORKFLOW.md`
- Strands 集成实施报告：`docs/reports/strands-integration-implementation-plan-2026-07-30.md`

### 现有代码（实施时参考）
- 适配层：`src-tauri/sidecar/strands_backend/adapter.py`
- 工具基础设施：`src-tauri/sidecar/strands_backend/tools/__init__.py`
- SSH 命令工具（内嵌 RiskChecker 模式参考）：`src-tauri/sidecar/strands_backend/tools/ssh_command.py`
- 模型适配：`src-tauri/sidecar/strands_backend/model_adapter.py`
- 事件总线：`src-tauri/sidecar/event_bus.py`
- 前端审批组件：`src/modules/ai/components/AiToolApproval.tsx`
- 前端 sidecar 桥：`src/lib/sidecar-bridge.ts`
- Rust sidecar 模块：`src-tauri/src/modules/sidecar.rs`
- Tauri 权限配置：`src-tauri/capabilities/default.json`
- 测试模式参考：`src-tauri/sidecar/strands_backend/tests/test_tools.py`

---

## 附录 A：ops-agent 报告 §4.1 extras 错误修正对照

| ops-agent 报告 §4.1 列出 | PyPI 实际 | 状态 |
|--------------------------|-----------|------|
| `mem0_memory` | `mem0-memory` | ✓ 存在（下划线 vs 连字符，PyPI 标准是连字符） |
| `use_browser` | **不存在** | ✗ 错误，应为 `local-chromium-browser` 和 `agent-core-browser` |
| `rss` | `rss` | ✓ 存在 |
| `use_computer` | `use-computer` | ✓ 存在 |
| `a2a-client` | `a2a-client` | ✓ 存在 |
| `agent-core-browser` | `agent-core-browser` | ✓ 存在 |
| `agent-core-code-interpreter` | `agent-core-code-interpreter` | ✓ 存在 |
| `diagram` | `diagram` | ✓ 存在 |
| `docs` | `docs` | ✓ 存在 |
| `elasticsearch-memory` | `elasticsearch-memory` | ✓ 存在 |
| `local-chromium-browser` | `local-chromium-browser` | ✓ 存在 |
| `mongodb-memory` | `mongodb-memory` | ✓ 存在 |
| `twelvelabs` | `twelvelabs` | ✓ 存在 |
| `build` / `dev` | `build` / `dev` | ✓ 存在（开发用） |

**结论**：ops-agent 报告 §4.1 列出的 `use_browser` 是错误的，实际 PyPI 没有 `use_browser` extra，浏览器功能由 `local-chromium-browser`（本地 Chromium）和 `agent-core-browser`（AWS Bedrock Agent Core 浏览器）两个 extras 提供。本报告已在 §1.2 修正。

---

> **报告完成**：2026-07-30 · subagent-A · 场景 A（纯调研，未动源代码）
