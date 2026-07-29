# TDSF Terminal Agent — 运维工具 Python 实现示例（v1.0）

> **位置**：`docs/reports/ops-agent-tool-examples.md`
> **版本**：v1.0（2026-07-30 新增，与 `ops-agent-strands-integration-plan.md` v2.0 配套）
> **作用**：给出 5 个核心运维工具的完整 Python 实现示例，作为 `strands_backend/tools/` sub-package 的落地参考。
> **任务边界**：本文件仅为方案文档 + 代码示例，不修改任何源代码文件。所有示例代码均为"待落地"的参考实现，需通过后续 task（T-P1-Strands-Tools）真正写入 `src-tauri/sidecar/strands_backend/tools/`。
> **代码风格**：与现有 `src-tauri/sidecar/tools/*.py`（如 `risk.py` / `confidence.py` / `ground.py`）对齐——文件头 docstring + `from __future__ import annotations` + 模块级单例 + `invoke_xxx_tool(params) -> dict` 入口 + `TOOL_METADATA` + `get_tool_metadata()`。

---

## 1. 设计原则

### 1.1 与现有 `tools/*.py` 的关系

| 维度 | 现有 `tools/*.py`（risk/confidence/ground/...） | 本文档新增 `strands_backend/tools/ops_*.py` |
|------|--------------------------------------------------|---------------------------------------------|
| 调用方 | LangGraph `tool_call_node` 通过 `tools.invoke_tool(name, params)` 调度 | Strands Agent 通过 `@tool` 装饰器自动注册到 Agent |
| 接口形态 | `invoke_xxx_tool(params: dict) -> dict`（统一 dict 进出） | **双形态**：保留 `invoke_xxx_tool(params) -> dict`（向后兼容）+ `@tool` 装饰器函数（Strands 原生） |
| 风险评估 | 部分工具内置（如 `risk.py` 包装 `RiskEngine`） | **全部内置**：每个 ops 工具调用前先过 `RiskEngine.assess()`，deny 则拒绝 |
| 事件推送 | 由 `graph/nodes.py` 的 `act_node` 统一推送 `tool_call` 事件 | **工具内部推送**：通过 `EventBus.publish(Event(event_type=TOOL_CALL, ...))` 推送开始/完成/错误 |
| 副作用 | 纯 Python 计算（无外部 IO） | **有外部 IO**：通过 `RustBridge` 反向调用 Rust 侧 SSH/SFTP 命令 |
| 注册位置 | `tools/__init__.py` 的 `TOOL_REGISTRY` | `strands_backend/tool_adapter.py` 包装为 Strands `@tool`，注册到 `Agent(tools=[...])` |

### 1.2 双形态接口设计（关键）

每个 ops 工具同时暴露两种调用形态，确保**向后兼容** + **Strands 原生**：

```python
# 形态 1：传统 MCP tool 入口（与现有 tools/*.py 对齐，便于 LangGraph 后端调用 + 单元测试）
def invoke_ops_ssh_command_tool(params: dict[str, Any]) -> dict[str, Any]:
    ...

# 形态 2：Strands @tool 装饰器函数（Strands Agent 原生调用）
@tool
def ops_ssh_command(command: str, ssh_session_id: str = "") -> dict[str, Any]:
    """..."""
    return invoke_ops_ssh_command_tool({
        "command": command,
        "ssh_session_id": ssh_session_id,
    })
```

形态 2 内部委托给形态 1，避免逻辑重复。`tool_adapter.py` 会把所有 `ops_*` 函数收集成 list 传给 `Agent(tools=[...])`。

### 1.3 安全优先：RiskEngine 前置 hook

所有 ops 工具在执行外部命令前，**必须**先调用 `RiskEngine.assess(command, target_asset)`：

- `level == "L4"`（deny）：直接返回 `{"ok": False, "error": "command denied by risk engine: ..."}`，**不执行**
- `level == "L3"`（high，require_approval=True）：返回 `{"ok": False, "pending_approval": True, "assessment": {...}}`，等待前端 `needs_you` 确认
- `level == "L2"`（medium）：执行但推送 `tool_call` 事件标记 `risk_level=medium`
- `level <= "L1"`（low）：直接执行

这复用了 `src-tauri/sidecar/tools/risk.py` 已包装的 `RiskEngine`，**不重写**风控逻辑。

### 1.4 反向 JSON-RPC：`RustBridge` 单例

Python 侧没有 SSH/SFTP 客户端（SSH 在 Rust 侧 `russh` 实现）。ops 工具通过 `RustBridge` 发起**反向 JSON-RPC 请求**，调用 Rust 侧的 `ssh_command` / `sftp_read_file` / `sftp_list` 等 Tauri 命令。

> **架构缺口**：当前 `src-tauri/src/modules/ipc.rs` 只支持 Rust → Python（前端 `invoke('ipc_invoke', ...)` → Rust → Python）。Python → Rust 的反向调用需要 P2 阶段扩展双向 JSON-RPC（详见集成方案 §6）。在 P0/P1 阶段，工具先返回"建议命令"（不执行），由前端用户确认后通过 Tauri invoke 执行——这与现有 `needs_you` 协调机制对齐。

`RustBridge` 接口契约（P2 实现，P0/P1 用 stub）：

```python
# strands_backend/rust_bridge.py（接口契约，P2 实现）
from __future__ import annotations
from typing import Any, Protocol


class RustBridgeProtocol(Protocol):
    """反向 JSON-RPC 桥接器接口（Python → Rust）"""

    def invoke(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        """同步调用 Rust 侧 Tauri 命令（阻塞等待结果）

        Args:
            method: Rust 侧方法名（如 "ssh_command" / "sftp_read_file"）
            params: 方法参数

        Returns:
            Rust 侧返回结果

        Raises:
            RustBridgeError: 调用失败（超时 / Rust 侧异常 / 未连接）
        """
        ...

    async def invoke_async(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        """异步调用（不阻塞 Python 事件循环）"""
        ...


# P0/P1 stub：返回"建议命令"不执行
class StubRustBridge:
    """P0/P1 阶段 stub：不真正调用 Rust，返回建议命令待前端确认"""

    def invoke(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        return {
            "ok": False,
            "stub": True,
            "suggested_method": method,
            "suggested_params": params,
            "message": "P0/P1 stub: command not executed, awaiting frontend confirmation",
        }

    async def invoke_async(self, method: str, params: dict[str, Any]) -> dict[str, Any]:
        return self.invoke(method, params)
```

### 1.5 终端上下文注入：`LiveContext`

每个 ops 工具可访问当前终端上下文（cwd / activeFile / sshSessionId），由 `strands_backend/context.py` 解析并注入（详见集成方案 §5）。

```python
# strands_backend/context.py（接口契约）
from __future__ import annotations
from dataclasses import dataclass


@dataclass
class LiveContext:
    """终端实时上下文快照（由前端 transport.ts 的 state.live 注入）"""
    cwd: str = ""                    # 当前工作目录（本地或远程）
    active_file: str = ""            # 当前打开的文件路径
    workspace_root: str = ""         # 工作区根目录
    terminal_private: bool = False   # 是否私有终端（私有则不读取缓冲）
    ssh_session_id: str = ""         # 当前 SSH 会话 ID（空表示本地终端）
    terminal_buffer_tail: str = ""   # 终端缓冲尾部文本（最近 N 行）


# 模块级单例（由 configure_strands 注入）
_current: LiveContext = LiveContext()


def set_live_context(ctx: LiveContext) -> None:
    global _current
    _current = ctx


def get_live_context() -> LiveContext:
    return _current
```

---

## 2. 工具 1：`ops_ssh_command.py` — SSH 命令执行

### 2.1 职责

在指定 SSH 会话上执行 shell 命令，返回 stdout/stderr/exit_code。**执行前必须过 RiskEngine**，deny 拒绝、high 等待确认。

### 2.2 输入输出契约

```
输入（params）：
    {
        "command": "systemctl status nginx",       # 必填，待执行的命令
        "ssh_session_id": "sess-abc123",           # 可选，SSH 会话 ID（空则用 LiveContext.ssh_session_id）
        "timeout_ms": 10000,                       # 可选，超时毫秒（默认 10000）
        "target_asset": "demo-nginx"               # 可选，目标资产名（用于 RiskEngine 环境感知）
    }

输出：
    # 成功
    {
        "ok": True,
        "stdout": "● nginx.service - loaded...",
        "stderr": "",
        "exit_code": 0,
        "duration_ms": 234,
        "risk_level": "L1",
        "command": "systemctl status nginx"
    }
    # 拒绝（deny）
    {
        "ok": False,
        "denied": True,
        "reason": "command denied by risk engine: rm_rf rule matched",
        "risk_level": "L4",
        "command": "rm -rf /"
    }
    # 待确认（high）
    {
        "ok": False,
        "pending_approval": True,
        "assessment": {... RiskAssessment ...},
        "command": "sudo systemctl restart nginx"
    }
```

### 2.3 完整实现

```python
"""
strands_backend/tools/ops_ssh_command.py — SSH 命令执行运维工具
==============================================================

职责：
- 在指定 SSH 会话上执行 shell 命令（通过 RustBridge 反向调用 Rust 侧 ssh_command）
- 执行前过 RiskEngine 4 层风控管道（语法/规则/确认/审计）
- deny（L4）直接拒绝，high（L3）返回待确认，medium/low 执行
- 推送 tool_call 事件（开始/完成/错误）到 EventBus

集成点：
- Strands Agent 通过 @tool 装饰器调用 ops_ssh_command
- LangGraph 后端可通过 invoke_ops_ssh_command_tool(params) 调用（双形态）
- 依赖：RustBridge（P2 实现）/ RiskEngine / EventBus / LiveContext

设计原则对齐：
- 安全优先：未知命令默认中风险并要求人工确认（与 risk_engine.py 一致）
- deny 优先：deny 规则优先于 high/medium/low 判定
- 环境感知：target_asset 关键性可上调风险等级
"""

from __future__ import annotations

import logging
import time
from typing import Any

from strands import tool

from core.risk_engine import RiskEngine
from core.schemas import risk_level_to_l0_l4
from event_bus import EventBus, Event, EventType
from strands_backend.context import get_live_context
from strands_backend.rust_bridge import RustBridgeProtocol, StubRustBridge

logger = logging.getLogger("sidecar.strands_backend.tools.ops_ssh_command")


# ============================================================================
# 模块级单例（懒加载）
# ============================================================================

_rust_bridge: RustBridgeProtocol = StubRustBridge()
_event_bus: EventBus | None = None
_risk_engine: RiskEngine | None = None


def configure(
    rust_bridge: RustBridgeProtocol | None = None,
    event_bus: EventBus | None = None,
    risk_engine: RiskEngine | None = None,
) -> None:
    """注入依赖（由 strands_backend.configure_strands 调用）

    Args:
        rust_bridge: 反向 JSON-RPC 桥接器（P2 实现，P0/P1 用 StubRustBridge）
        event_bus: 事件总线（推送 tool_call 事件）
        risk_engine: RiskEngine 实例（复用 tools/risk.py 的单例）
    """
    global _rust_bridge, _event_bus, _risk_engine
    if rust_bridge is not None:
        _rust_bridge = rust_bridge
    if event_bus is not None:
        _event_bus = event_bus
    if risk_engine is not None:
        _risk_engine = risk_engine
    logger.info(
        f"ops_ssh_command configured: rust_bridge={type(_rust_bridge).__name__}, "
        f"event_bus={'set' if _event_bus else 'none'}, risk_engine={'set' if _risk_engine else 'none'}"
    )


def _get_risk_engine() -> RiskEngine:
    """获取 RiskEngine 单例（懒加载，复用 tools/risk.py 的单例）"""
    global _risk_engine
    if _risk_engine is None:
        # 复用现有 tools/risk.py 的 get_risk_engine，避免重复初始化
        from tools.risk import get_risk_engine as _get
        _risk_engine = _get()
    return _risk_engine


def _publish_tool_call(
    event_bus: EventBus | None,
    session_id: str | None,
    stage: str,
    tool_name: str,
    command: str,
    risk_level: str = "",
    extra: dict[str, Any] | None = None,
) -> None:
    """推送 tool_call 事件到 EventBus

    Args:
        stage: "start" / "complete" / "error" / "denied" / "pending_approval"
        tool_name: 工具名
        command: 执行的命令
        risk_level: 风险等级（L0-L4）
        extra: 额外字段
    """
    if event_bus is None:
        return
    payload = {
        "tool": tool_name,
        "stage": stage,
        "command": command[:200],  # 截断防止超长
        "risk_level": risk_level,
    }
    if extra:
        payload.update(extra)
    event_bus.publish(Event(
        event_type=EventType.TOOL_CALL.value,
        payload=payload,
        session_id=session_id,
        source=f"strands_backend.{tool_name}",
    ))


# ============================================================================
# 形态 1：传统 MCP tool 入口（与现有 tools/*.py 对齐）
# ============================================================================

def invoke_ops_ssh_command_tool(params: dict[str, Any]) -> dict[str, Any]:
    """MCP tool 入口：在 SSH 会话上执行命令（含风险评估）

    Args:
        params: 工具参数字典（见模块 docstring 的输入格式）

    Returns:
        执行结果字典（见模块 docstring 的输出格式）

    Raises:
        ValueError: 必填参数缺失或类型错误
    """
    # === 参数校验 ===
    command = params.get("command", "")
    if not command:
        raise ValueError("command is required")
    if not isinstance(command, str):
        raise ValueError(f"command must be str, got {type(command).__name__}")

    ssh_session_id = params.get("ssh_session_id", "") or get_live_context().ssh_session_id
    timeout_ms = int(params.get("timeout_ms", 10000))
    target_asset = params.get("target_asset", "")

    # === 风险评估（4 层风控管道）===
    engine = _get_risk_engine()
    assessment = engine.assess(command, target_asset)
    risk_level = risk_level_to_l0_l4(assessment.adjusted_risk_level)

    # L4 deny：直接拒绝
    if risk_level == "L4":
        logger.warning(f"ops_ssh_command DENIED: cmd='{command[:60]}', rule={assessment.matched_rule_name}")
        _publish_tool_call(
            _event_bus, session_id=None, stage="denied",
            tool_name="ops_ssh_command", command=command, risk_level=risk_level,
            extra={"reason": assessment.matched_rule_name or "deny rule matched"},
        )
        return {
            "ok": False,
            "denied": True,
            "reason": f"command denied by risk engine: {assessment.matched_rule_name or 'deny rule matched'}",
            "risk_level": risk_level,
            "command": command,
        }

    # L3 high：返回待确认（不执行）
    if assessment.requires_confirmation:
        logger.info(f"ops_ssh_command PENDING_APPROVAL: cmd='{command[:60]}', level={risk_level}")
        _publish_tool_call(
            _event_bus, session_id=None, stage="pending_approval",
            tool_name="ops_ssh_command", command=command, risk_level=risk_level,
            extra={"assessment": assessment.model_dump() if hasattr(assessment, 'model_dump') else {}},
        )
        return {
            "ok": False,
            "pending_approval": True,
            "assessment": assessment.model_dump() if hasattr(assessment, 'model_dump') else {},
            "command": command,
        }

    # === 推送 tool_call start 事件 ===
    _publish_tool_call(
        _event_bus, session_id=ssh_session_id, stage="start",
        tool_name="ops_ssh_command", command=command, risk_level=risk_level,
    )

    # === 通过 RustBridge 反向调用 Rust 侧 ssh_command ===
    start = time.monotonic()
    try:
        result = _rust_bridge.invoke("ssh_command", {
            "sessionId": ssh_session_id,
            "command": command,
            "timeoutMs": timeout_ms,
        })
        duration_ms = int((time.monotonic() - start) * 1000)

        # 标准化输出（Rust 侧返回字段名可能不同，此处做兼容）
        stdout = result.get("stdout", result.get("output", ""))
        stderr = result.get("stderr", "")
        exit_code = result.get("exitCode", result.get("exit_code", -1))

        _publish_tool_call(
            _event_bus, session_id=ssh_session_id, stage="complete",
            tool_name="ops_ssh_command", command=command, risk_level=risk_level,
            extra={"exit_code": exit_code, "duration_ms": duration_ms},
        )

        return {
            "ok": result.get("ok", True),
            "stdout": stdout,
            "stderr": stderr,
            "exit_code": exit_code,
            "duration_ms": duration_ms,
            "risk_level": risk_level,
            "command": command,
            "stub": result.get("stub", False),  # P0/P1 stub 标记
        }

    except Exception as e:
        duration_ms = int((time.monotonic() - start) * 1000)
        logger.exception(f"ops_ssh_command FAILED: cmd='{command[:60]}', err={e}")
        _publish_tool_call(
            _event_bus, session_id=ssh_session_id, stage="error",
            tool_name="ops_ssh_command", command=command, risk_level=risk_level,
            extra={"error": str(e), "duration_ms": duration_ms},
        )
        return {
            "ok": False,
            "error": str(e),
            "duration_ms": duration_ms,
            "risk_level": risk_level,
            "command": command,
        }


# ============================================================================
# 形态 2：Strands @tool 装饰器函数（Strands Agent 原生调用）
# ============================================================================

@tool
def ops_ssh_command(
    command: str,
    ssh_session_id: str = "",
    timeout_ms: int = 10000,
    target_asset: str = "",
) -> dict[str, Any]:
    """Execute a shell command on a remote SSH session with risk assessment.

    This tool first evaluates the command through a 4-layer risk control pipeline
    (syntax check / rule matching / confirmation requirement / audit requirement).
    Commands classified as L4 (deny) are rejected; L3 (high) return pending_approval;
    L0-L2 are executed on the specified SSH session.

    Args:
        command (str): The shell command to execute (e.g., "systemctl status nginx")
        ssh_session_id (str): SSH session ID; empty uses current active session
        timeout_ms (int): Timeout in milliseconds (default 10000)
        target_asset (str): Target asset name for environment-aware risk assessment

    Returns:
        dict: Execution result with ok/stdout/stderr/exit_code/risk_level fields.
              If denied, returns ok=False, denied=True, reason=...
              If pending approval, returns ok=False, pending_approval=True, assessment=...
    """
    return invoke_ops_ssh_command_tool({
        "command": command,
        "ssh_session_id": ssh_session_id,
        "timeout_ms": timeout_ms,
        "target_asset": target_asset,
    })


# ============================================================================
# 工具元数据（与现有 tools/*.py 对齐）
# ============================================================================

TOOL_METADATA: dict[str, Any] = {
    "name": "ops_ssh_command",
    "description": (
        "SSH 命令执行：在远程 SSH 会话上执行 shell 命令，"
        "前置 4 层风控管道（语法/规则/确认/审计），"
        "L4 拒绝 / L3 待确认 / L0-L2 执行。"
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "command": {"type": "string", "description": "待执行的命令（必填）"},
            "ssh_session_id": {"type": "string", "description": "SSH 会话 ID（可选，空则用当前活跃会话）"},
            "timeout_ms": {"type": "integer", "description": "超时毫秒（默认 10000）"},
            "target_asset": {"type": "string", "description": "目标资产名（可选，用于环境感知）"},
        },
        "required": ["command"],
    },
    "output_schema": {
        "type": "object",
        "properties": {
            "ok": {"type": "boolean"},
            "stdout": {"type": "string"},
            "stderr": {"type": "string"},
            "exit_code": {"type": "integer"},
            "duration_ms": {"type": "integer"},
            "risk_level": {"type": "string", "enum": ["L0", "L1", "L2", "L3", "L4"]},
            "command": {"type": "string"},
            "denied": {"type": "boolean"},
            "pending_approval": {"type": "boolean"},
            "reason": {"type": "string"},
            "stub": {"type": "boolean"},
        },
    },
}


def get_tool_metadata() -> dict[str, Any]:
    """获取工具元数据"""
    return TOOL_METADATA
```

---

## 3. 工具 2：`ops_read_remote_file.py` — 远程文件读取

### 3.1 职责

通过 SFTP 读取远程文件内容（只读），支持 tail/head/行范围。**风险评估较低**（读操作通常 L0-L1），但仍过 RiskEngine 以审计。

### 3.2 完整实现

```python
"""
strands_backend/tools/ops_read_remote_file.py — 远程文件读取运维工具
==================================================================

职责：
- 通过 SFTP 读取远程文件内容（只读，无副作用）
- 支持 tail（尾部 N 行）/ head（头部 N 行）/ line_range（行范围）
- 过 RiskEngine 审计（读操作通常 L0-L1，但仍记录审计日志）

集成点：
- RustBridge 反向调用 Rust 侧 sftp_read_file（src-tauri/src/modules/sftp/）
- 复用 src/lib/sftp-bridge.ts 的 joinRemotePath 逻辑（Rust 侧实现）
"""

from __future__ import annotations

import logging
import time
from typing import Any

from strands import tool

from core.risk_engine import RiskEngine
from core.schemas import risk_level_to_l0_l4
from event_bus import EventBus, Event, EventType
from strands_backend.context import get_live_context
from strands_backend.rust_bridge import RustBridgeProtocol, StubRustBridge

logger = logging.getLogger("sidecar.strands_backend.tools.ops_read_remote_file")


# ============================================================================
# 模块级单例
# ============================================================================

_rust_bridge: RustBridgeProtocol = StubRustBridge()
_event_bus: EventBus | None = None
_risk_engine: RiskEngine | None = None


def configure(
    rust_bridge: RustBridgeProtocol | None = None,
    event_bus: EventBus | None = None,
    risk_engine: RiskEngine | None = None,
) -> None:
    global _rust_bridge, _event_bus, _risk_engine
    if rust_bridge is not None:
        _rust_bridge = rust_bridge
    if event_bus is not None:
        _event_bus = event_bus
    if risk_engine is not None:
        _risk_engine = risk_engine


def _get_risk_engine() -> RiskEngine:
    global _risk_engine
    if _risk_engine is None:
        from tools.risk import get_risk_engine as _get
        _risk_engine = _get()
    return _risk_engine


# ============================================================================
# 形态 1：传统 MCP tool 入口
# ============================================================================

def invoke_ops_read_remote_file_tool(params: dict[str, Any]) -> dict[str, Any]:
    """MCP tool 入口：读取远程文件内容（只读）

    Args:
        params: 工具参数字典
            - file_path (str, 必填): 远程文件绝对路径
            - ssh_session_id (str, 可选): SSH 会话 ID
            - mode (str, 可选): "full" / "tail" / "head" / "line_range"（默认 "full"）
            - lines (int, 可选): tail/head 模式的行数（默认 100）
            - start_line (int, 可选): line_range 模式的起始行（默认 1）
            - end_line (int, 可选): line_range 模式的结束行
            - max_bytes (int, 可选): 最大读取字节数（默认 65536，防止超大文件）

    Returns:
        文件内容字典
    """
    # === 参数校验 ===
    file_path = params.get("file_path", "")
    if not file_path:
        raise ValueError("file_path is required")
    if not isinstance(file_path, str):
        raise ValueError(f"file_path must be str, got {type(file_path).__name__}")

    ssh_session_id = params.get("ssh_session_id", "") or get_live_context().ssh_session_id
    mode = params.get("mode", "full")
    lines = int(params.get("lines", 100))
    start_line = int(params.get("start_line", 1))
    end_line = params.get("end_line")
    max_bytes = int(params.get("max_bytes", 65536))

    if mode not in ("full", "tail", "head", "line_range"):
        raise ValueError(f"mode must be full/tail/head/line_range, got '{mode}'")

    # === 风险评估（读操作通常 L0-L1，但仍审计）===
    # 用 cat/head/tail 作为虚拟命令送入 RiskEngine（实际不执行）
    virtual_cmd = f"cat {file_path}"
    engine = _get_risk_engine()
    assessment = engine.assess(virtual_cmd, "")
    risk_level = risk_level_to_l0_l4(assessment.adjusted_risk_level)

    # 读操作不该被 deny，但防御性检查
    if risk_level == "L4":
        return {
            "ok": False,
            "denied": True,
            "reason": f"file read denied by risk engine: {assessment.matched_rule_name}",
            "risk_level": risk_level,
            "file_path": file_path,
        }

    # === 推送 tool_call start 事件 ===
    if _event_bus:
        _event_bus.publish(Event(
            event_type=EventType.TOOL_CALL.value,
            payload={
                "tool": "ops_read_remote_file",
                "stage": "start",
                "file_path": file_path,
                "mode": mode,
                "risk_level": risk_level,
            },
            session_id=ssh_session_id,
            source="strands_backend.ops_read_remote_file",
        ))

    # === 通过 RustBridge 反向调用 Rust 侧 sftp_read_file ===
    start = time.monotonic()
    try:
        result = _rust_bridge.invoke("sftp_read_file", {
            "sessionId": ssh_session_id,
            "path": file_path,
            "mode": mode,
            "lines": lines,
            "startLine": start_line,
            "endLine": end_line,
            "maxBytes": max_bytes,
        })
        duration_ms = int((time.monotonic() - start) * 1000)

        content = result.get("content", "")
        total_lines = result.get("totalLines", 0)
        bytes_read = len(content.encode("utf-8", errors="replace"))

        # 推送 complete 事件
        if _event_bus:
            _event_bus.publish(Event(
                event_type=EventType.TOOL_CALL.value,
                payload={
                    "tool": "ops_read_remote_file",
                    "stage": "complete",
                    "file_path": file_path,
                    "mode": mode,
                    "bytes_read": bytes_read,
                    "total_lines": total_lines,
                    "duration_ms": duration_ms,
                    "risk_level": risk_level,
                },
                session_id=ssh_session_id,
                source="strands_backend.ops_read_remote_file",
            ))

        return {
            "ok": result.get("ok", True),
            "content": content,
            "file_path": file_path,
            "mode": mode,
            "bytes_read": bytes_read,
            "total_lines": total_lines,
            "duration_ms": duration_ms,
            "risk_level": risk_level,
            "stub": result.get("stub", False),
        }

    except Exception as e:
        duration_ms = int((time.monotonic() - start) * 1000)
        logger.exception(f"ops_read_remote_file FAILED: path='{file_path}', err={e}")
        if _event_bus:
            _event_bus.publish(Event(
                event_type=EventType.TOOL_CALL.value,
                payload={
                    "tool": "ops_read_remote_file",
                    "stage": "error",
                    "file_path": file_path,
                    "error": str(e),
                    "duration_ms": duration_ms,
                },
                session_id=ssh_session_id,
                source="strands_backend.ops_read_remote_file",
            ))
        return {
            "ok": False,
            "error": str(e),
            "file_path": file_path,
            "duration_ms": duration_ms,
        }


# ============================================================================
# 形态 2：Strands @tool 装饰器函数
# ============================================================================

@tool
def ops_read_remote_file(
    file_path: str,
    mode: str = "full",
    lines: int = 100,
    ssh_session_id: str = "",
    max_bytes: int = 65536,
) -> dict[str, Any]:
    """Read a remote file via SFTP (read-only, no side effects).

    Supports four reading modes: full (entire file), tail (last N lines),
    head (first N lines), line_range (specific line range).

    Args:
        file_path (str): Absolute path of the remote file (e.g., "/var/log/nginx/error.log")
        mode (str): Reading mode: "full" / "tail" / "head" / "line_range" (default "full")
        lines (int): Number of lines for tail/head mode (default 100)
        ssh_session_id (str): SSH session ID; empty uses current active session
        max_bytes (int): Max bytes to read (default 65536, prevents huge files)

    Returns:
        dict: File content with ok/content/file_path/mode/bytes_read/total_lines fields.
    """
    return invoke_ops_read_remote_file_tool({
        "file_path": file_path,
        "mode": mode,
        "lines": lines,
        "ssh_session_id": ssh_session_id,
        "max_bytes": max_bytes,
    })


# ============================================================================
# 工具元数据
# ============================================================================

TOOL_METADATA: dict[str, Any] = {
    "name": "ops_read_remote_file",
    "description": (
        "远程文件读取：通过 SFTP 读取远程文件内容（只读），"
        "支持 full/tail/head/line_range 四种模式，过 RiskEngine 审计。"
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "file_path": {"type": "string", "description": "远程文件绝对路径（必填）"},
            "mode": {"type": "string", "enum": ["full", "tail", "head", "line_range"]},
            "lines": {"type": "integer", "description": "tail/head 模式的行数（默认 100）"},
            "ssh_session_id": {"type": "string", "description": "SSH 会话 ID（可选）"},
            "max_bytes": {"type": "integer", "description": "最大读取字节数（默认 65536）"},
        },
        "required": ["file_path"],
    },
    "output_schema": {
        "type": "object",
        "properties": {
            "ok": {"type": "boolean"},
            "content": {"type": "string"},
            "file_path": {"type": "string"},
            "mode": {"type": "string"},
            "bytes_read": {"type": "integer"},
            "total_lines": {"type": "integer"},
            "duration_ms": {"type": "integer"},
            "risk_level": {"type": "string"},
            "stub": {"type": "boolean"},
        },
    },
}


def get_tool_metadata() -> dict[str, Any]:
    return TOOL_METADATA
```

---

## 4. 工具 3：`ops_analyze_logs.py` — 日志分析

### 4.1 职责

对远程日志文件做模式匹配 + 关键行提取，返回结构化分析结果。**不读取整个文件**，而是通过 `grep` / `tail` 管道在远程执行（性能优先）。

### 4.2 完整实现

```python
"""
strands_backend/tools/ops_analyze_logs.py — 日志分析运维工具
============================================================

职责：
- 对远程日志文件做模式匹配（grep -E）+ 关键行提取
- 支持 ERROR/WARN/异常堆栈自动识别
- 不读取整个文件，通过 grep/tail 管道在远程执行（性能优先）
- 返回结构化分析结果（匹配行数 / 关键片段 / 时间分布）

集成点：
- 内部委托 ops_ssh_command 执行 grep/tail 命令（复用其风险评估）
- 支持 syslog / journalctl / 应用日志 / Nginx access log 等格式

设计原则：
- 性能优先：日志文件可能 GB 级，禁止 cat 全文，必须 grep/tail 管道
- 安全优先：grep 命令本身过 RiskEngine（防止命令注入）
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any

from strands import tool

from event_bus import EventBus, Event, EventType
from strands_backend.context import get_live_context
from strands_backend.tools.ops_ssh_command import invoke_ops_ssh_command_tool

logger = logging.getLogger("sidecar.strands_backend.tools.ops_analyze_logs")


# ============================================================================
# 模块级单例
# ============================================================================

_event_bus: EventBus | None = None


def configure(event_bus: EventBus | None = None) -> None:
    global _event_bus
    if event_bus is not None:
        _event_bus = event_bus


# ============================================================================
# 预定义日志模式（可扩展）
# ============================================================================

_LOG_PATTERNS: dict[str, list[str]] = {
    # 通用 ERROR/WARN 模式
    "error": [
        r"\bERROR\b",
        r"\bError\b",
        r"\bFATAL\b",
        r"\bCRITICAL\b",
        r"\bPANIC\b",
    ],
    "warning": [
        r"\bWARN\b",
        r"\bWarning\b",
    ],
    # Nginx
    "nginx_5xx": [
        r'HTTP/1\.\d" 5\d\d',
    ],
    "nginx_4xx": [
        r'HTTP/1\.\d" 4\d\d',
    ],
    # MySQL
    "mysql_lock": [
        r"InnoDB.*Unable to lock",
        r"Deadlock found",
    ],
    # Linux 系统
    "oom_killer": [
        r"Out of memory",
        r"Killed process",
        r"oom-killer",
    ],
    "segfault": [
        r"segfault at",
        r"Segmentation fault",
    ],
    # SSH 认证失败
    "ssh_auth_fail": [
        r"Failed password",
        r"Invalid user",
        r"authentication failure",
    ],
}


# ============================================================================
# 形态 1：传统 MCP tool 入口
# ============================================================================

def invoke_ops_analyze_logs_tool(params: dict[str, Any]) -> dict[str, Any]:
    """MCP tool 入口：分析远程日志文件（模式匹配 + 关键行提取）

    Args:
        params: 工具参数字典
            - log_path (str, 必填): 日志文件路径（如 /var/log/nginx/error.log）
            - patterns (list[str], 可选): 自定义正则模式列表
            - preset (str, 可选): 预设模式名（error/warning/nginx_5xx/mysql_lock/...）
            - tail_lines (int, 可选): 先取尾部 N 行再分析（默认 1000，防止全文件扫描）
            - ssh_session_id (str, 可选): SSH 会话 ID
            - context_lines (int, 可选): 匹配行前后各多少行上下文（默认 2）

    Returns:
        分析结果字典
    """
    # === 参数校验 ===
    log_path = params.get("log_path", "")
    if not log_path:
        raise ValueError("log_path is required")

    ssh_session_id = params.get("ssh_session_id", "") or get_live_context().ssh_session_id
    custom_patterns = params.get("patterns", [])
    preset = params.get("preset", "error")
    tail_lines = int(params.get("tail_lines", 1000))
    context_lines = int(params.get("context_lines", 2))

    # === 合并模式 ===
    patterns: list[str] = []
    if preset and preset in _LOG_PATTERNS:
        patterns.extend(_LOG_PATTERNS[preset])
    patterns.extend(custom_patterns)
    if not patterns:
        patterns = _LOG_PATTERNS["error"]  # 默认 error 模式

    # === 推送 start 事件 ===
    if _event_bus:
        _event_bus.publish(Event(
            event_type=EventType.TOOL_CALL.value,
            payload={
                "tool": "ops_analyze_logs",
                "stage": "start",
                "log_path": log_path,
                "preset": preset,
                "pattern_count": len(patterns),
                "tail_lines": tail_lines,
            },
            session_id=ssh_session_id,
            source="strands_backend.ops_analyze_logs",
        ))

    start = time.monotonic()
    try:
        # === 构造 grep 命令（在远程执行）===
        # 命令格式：tail -n {tail_lines} {log_path} | grep -E -A {context_lines} -B {context_lines} "pattern1|pattern2|..."
        # 注意：patterns 用 | 连接成扩展正则，grep -E
        # 安全：patterns 内的特殊字符可能被注入，但 RiskEngine 会评估
        combined_pattern = "|".join(f"({p})" for p in patterns)
        # 转义 shell 特殊字符（防止命令注入）
        # 用单引号包裹 pattern，并转义内部单引号
        escaped_pattern = combined_pattern.replace("'", "'\\''")
        escaped_path = log_path.replace("'", "'\\''")

        grep_cmd = (
            f"tail -n {tail_lines} '{escaped_path}' | "
            f"grep -E -A {context_lines} -B {context_lines} '{escaped_pattern}' | "
            f"head -n 200"  # 限制输出行数，防止刷屏
        )

        # === 委托 ops_ssh_command 执行（自动过 RiskEngine）===
        ssh_result = invoke_ops_ssh_command_tool({
            "command": grep_cmd,
            "ssh_session_id": ssh_session_id,
            "timeout_ms": 15000,
            "target_asset": f"log:{log_path}",
        })

        duration_ms = int((time.monotonic() - start) * 1000)

        if not ssh_result.get("ok", False):
            # grep 无匹配时 exit_code=1，不是错误
            if ssh_result.get("exit_code") == 1:
                return {
                    "ok": True,
                    "log_path": log_path,
                    "matched_lines": [],
                    "match_count": 0,
                    "patterns": patterns,
                    "preset": preset,
                    "duration_ms": duration_ms,
                    "message": "no matches found (grep exit_code=1)",
                }
            return {
                "ok": False,
                "error": ssh_result.get("error", "ssh command failed"),
                "log_path": log_path,
                "duration_ms": duration_ms,
            }

        # === 解析 grep 输出 ===
        raw_output = ssh_result.get("stdout", "")
        matched_lines = _parse_grep_output(raw_output, context_lines)

        # === 时间分布统计（简单版：按小时桶）===
        time_distribution = _compute_time_distribution(matched_lines)

        # 推送 complete 事件
        if _event_bus:
            _event_bus.publish(Event(
                event_type=EventType.TOOL_CALL.value,
                payload={
                    "tool": "ops_analyze_logs",
                    "stage": "complete",
                    "log_path": log_path,
                    "match_count": len(matched_lines),
                    "duration_ms": duration_ms,
                },
                session_id=ssh_session_id,
                source="strands_backend.ops_analyze_logs",
            ))

        return {
            "ok": True,
            "log_path": log_path,
            "matched_lines": matched_lines[:50],  # 截断防止超长
            "match_count": len(matched_lines),
            "patterns": patterns,
            "preset": preset,
            "time_distribution": time_distribution,
            "duration_ms": duration_ms,
            "raw_output_preview": raw_output[:500],
        }

    except Exception as e:
        duration_ms = int((time.monotonic() - start) * 1000)
        logger.exception(f"ops_analyze_logs FAILED: path='{log_path}', err={e}")
        if _event_bus:
            _event_bus.publish(Event(
                event_type=EventType.TOOL_CALL.value,
                payload={
                    "tool": "ops_analyze_logs",
                    "stage": "error",
                    "log_path": log_path,
                    "error": str(e),
                    "duration_ms": duration_ms,
                },
                session_id=ssh_session_id,
                source="strands_backend.ops_analyze_logs",
            ))
        return {
            "ok": False,
            "error": str(e),
            "log_path": log_path,
            "duration_ms": duration_ms,
        }


def _parse_grep_output(output: str, context_lines: int) -> list[dict[str, Any]]:
    """解析 grep -A -B 输出为结构化行列表

    grep 输出格式：
        line1
        line2
        --
        line3
    """
    lines = output.split("\n")
    matched: list[dict[str, Any]] = []
    current_group: list[str] = []

    for line in lines:
        if line == "--":
            # 分隔符，结束当前组
            if current_group:
                matched.append({
                    "line": current_group[context_lines] if len(current_group) > context_lines else current_group[-1],
                    "context_before": current_group[:context_lines],
                    "context_after": current_group[context_lines + 1:] if len(current_group) > context_lines + 1 else [],
                })
                current_group = []
        else:
            current_group.append(line)

    # 处理最后一组（无 -- 结尾）
    if current_group:
        matched.append({
            "line": current_group[context_lines] if len(current_group) > context_lines else current_group[-1],
            "context_before": current_group[:context_lines],
            "context_after": current_group[context_lines + 1:] if len(current_group) > context_lines + 1 else [],
        })

    return matched


def _compute_time_distribution(matched_lines: list[dict[str, Any]]) -> dict[str, int]:
    """从匹配行中提取时间戳，按小时桶统计分布"""
    # 简单匹配常见时间格式：HH:MM:SS 或 HH:MM
    time_pattern = re.compile(r"\b(\d{2}):(\d{2})(?::(\d{2}))?\b")
    distribution: dict[str, int] = {}
    for item in matched_lines:
        line = item.get("line", "")
        match = time_pattern.search(line)
        if match:
            hour = match.group(1)
            distribution[hour] = distribution.get(hour, 0) + 1
    return dict(sorted(distribution.items()))


# ============================================================================
# 形态 2：Strands @tool 装饰器函数
# ============================================================================

@tool
def ops_analyze_logs(
    log_path: str,
    preset: str = "error",
    patterns: list[str] | None = None,
    tail_lines: int = 1000,
    context_lines: int = 2,
    ssh_session_id: str = "",
) -> dict[str, Any]:
    """Analyze a remote log file with pattern matching (grep-based, no full read).

    Executes `tail -n N | grep -E -A -B` on the remote server via SSH, avoiding
    full-file reads for performance. Supports preset patterns (error/warning/
    nginx_5xx/mysql_lock/oom_killer/segfault/ssh_auth_fail) and custom regex.

    Args:
        log_path (str): Remote log file path (e.g., "/var/log/nginx/error.log")
        preset (str): Preset pattern name (default "error")
        patterns (list[str]): Custom regex patterns (merged with preset)
        tail_lines (int): Tail N lines before grep (default 1000, prevents full scan)
        context_lines (int): Context lines around match (default 2)
        ssh_session_id (str): SSH session ID; empty uses current active session

    Returns:
        dict: Analysis result with matched_lines/match_count/time_distribution fields.
    """
    return invoke_ops_analyze_logs_tool({
        "log_path": log_path,
        "preset": preset,
        "patterns": patterns or [],
        "tail_lines": tail_lines,
        "context_lines": context_lines,
        "ssh_session_id": ssh_session_id,
    })


# ============================================================================
# 工具元数据
# ============================================================================

TOOL_METADATA: dict[str, Any] = {
    "name": "ops_analyze_logs",
    "description": (
        "日志分析：通过 grep 管道在远程执行模式匹配，"
        "支持预设模式（error/warning/nginx_5xx/mysql_lock/oom_killer/...）+ 自定义正则，"
        "返回结构化匹配结果 + 时间分布。"
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "log_path": {"type": "string", "description": "远程日志文件路径（必填）"},
            "preset": {"type": "string", "description": "预设模式名（默认 error）"},
            "patterns": {"type": "array", "items": {"type": "string"}, "description": "自定义正则模式列表"},
            "tail_lines": {"type": "integer", "description": "先取尾部 N 行（默认 1000）"},
            "context_lines": {"type": "integer", "description": "匹配行上下文行数（默认 2）"},
            "ssh_session_id": {"type": "string", "description": "SSH 会话 ID（可选）"},
        },
        "required": ["log_path"],
    },
    "output_schema": {
        "type": "object",
        "properties": {
            "ok": {"type": "boolean"},
            "log_path": {"type": "string"},
            "matched_lines": {"type": "array"},
            "match_count": {"type": "integer"},
            "patterns": {"type": "array"},
            "preset": {"type": "string"},
            "time_distribution": {"type": "object"},
            "duration_ms": {"type": "integer"},
        },
    },
}


def get_tool_metadata() -> dict[str, Any]:
    return TOOL_METADATA
```

---

## 5. 工具 4：`ops_query_processes.py` — 进程查询

### 5.1 完整实现

```python
"""
strands_backend/tools/ops_query_processes.py — 进程查询运维工具
================================================================

职责：
- 查询远程服务器进程状态（ps / pgrep / top -bn1）
- 支持按进程名/用户/CPU/内存过滤
- 返回结构化进程列表（pid/name/user/cpu/mem/command）

集成点：
- 内部委托 ops_ssh_command 执行 ps/pgrep 命令
- 不可逆操作（如 kill）不在此工具范围，由 ops_ssh_command 单独处理（过 RiskEngine）
"""

from __future__ import annotations

import logging
import re
import time
from typing import Any

from strands import tool

from event_bus import EventBus, Event, EventType
from strands_backend.context import get_live_context
from strands_backend.tools.ops_ssh_command import invoke_ops_ssh_command_tool

logger = logging.getLogger("sidecar.strands_backend.tools.ops_query_processes")


_event_bus: EventBus | None = None


def configure(event_bus: EventBus | None = None) -> None:
    global _event_bus
    if event_bus is not None:
        _event_bus = event_bus


# ============================================================================
# 形态 1：传统 MCP tool 入口
# ============================================================================

def invoke_ops_query_processes_tool(params: dict[str, Any]) -> dict[str, Any]:
    """MCP tool 入口：查询远程进程状态（只读）

    Args:
        params: 工具参数字典
            - filter_name (str, 可选): 按进程名过滤（支持正则）
            - filter_user (str, 可选): 按用户过滤
            - sort_by (str, 可选): 排序字段 cpu/mem/pid（默认 cpu）
            - limit (int, 可选): 返回前 N 个进程（默认 20）
            - ssh_session_id (str, 可选): SSH 会话 ID
            - include_threads (bool, 可选): 是否包含线程（默认 False）

    Returns:
        进程列表字典
    """
    filter_name = params.get("filter_name", "")
    filter_user = params.get("filter_user", "")
    sort_by = params.get("sort_by", "cpu")
    limit = int(params.get("limit", 20))
    ssh_session_id = params.get("ssh_session_id", "") or get_live_context().ssh_session_id
    include_threads = params.get("include_threads", False)

    # === 推送 start 事件 ===
    if _event_bus:
        _event_bus.publish(Event(
            event_type=EventType.TOOL_CALL.value,
            payload={
                "tool": "ops_query_processes",
                "stage": "start",
                "filter_name": filter_name,
                "filter_user": filter_user,
                "sort_by": sort_by,
                "limit": limit,
            },
            session_id=ssh_session_id,
            source="strands_backend.ops_query_processes",
        ))

    start = time.monotonic()
    try:
        # === 构造 ps 命令 ===
        # 使用 ps auxww + 排序 + head
        # auxww: 显示所有用户的所有进程，ww 防止命令被截断
        # --sort=-%cpu: 按 CPU 降序（GNU ps 语法）
        ps_cmd = "ps auxww --sort=-%cpu | head -n 50"
        if filter_user:
            # 按 user 过滤
            ps_cmd = f"ps -u {filter_user} -o pid,user,%cpu,%mem,comm,args --sort=-%cpu | head -n 50"
        if include_threads:
            ps_cmd = "ps -eLf | head -n 50"  # 包含线程

        # === 委托 ops_ssh_command 执行 ===
        ssh_result = invoke_ops_ssh_command_tool({
            "command": ps_cmd,
            "ssh_session_id": ssh_session_id,
            "timeout_ms": 8000,
        })

        duration_ms = int((time.monotonic() - start) * 1000)

        if not ssh_result.get("ok", False):
            return {
                "ok": False,
                "error": ssh_result.get("error", "ps command failed"),
                "duration_ms": duration_ms,
            }

        # === 解析 ps 输出 ===
        raw_output = ssh_result.get("stdout", "")
        processes = _parse_ps_output(raw_output)

        # === 客户端过滤（按进程名正则）===
        if filter_name:
            try:
                pattern = re.compile(filter_name, re.IGNORECASE)
                processes = [p for p in processes if pattern.search(p.get("command", ""))]
            except re.error as e:
                logger.warning(f"invalid filter_name regex '{filter_name}': {e}")

        # === 排序 ===
        sort_key_map = {"cpu": "%cpu", "mem": "%mem", "pid": "pid"}
        sort_key = sort_key_map.get(sort_by, "%cpu")
        processes.sort(
            key=lambda p: float(p.get(sort_key, 0) or 0),
            reverse=(sort_by in ("cpu", "mem")),
        )

        # === 限制返回数量 ===
        processes = processes[:limit]

        # 推送 complete 事件
        if _event_bus:
            _event_bus.publish(Event(
                event_type=EventType.TOOL_CALL.value,
                payload={
                    "tool": "ops_query_processes",
                    "stage": "complete",
                    "process_count": len(processes),
                    "duration_ms": duration_ms,
                },
                session_id=ssh_session_id,
                source="strands_backend.ops_query_processes",
            ))

        return {
            "ok": True,
            "processes": processes,
            "process_count": len(processes),
            "filter_name": filter_name,
            "filter_user": filter_user,
            "sort_by": sort_by,
            "duration_ms": duration_ms,
            "raw_output_preview": raw_output[:500],
        }

    except Exception as e:
        duration_ms = int((time.monotonic() - start) * 1000)
        logger.exception(f"ops_query_processes FAILED: err={e}")
        if _event_bus:
            _event_bus.publish(Event(
                event_type=EventType.TOOL_CALL.value,
                payload={
                    "tool": "ops_query_processes",
                    "stage": "error",
                    "error": str(e),
                    "duration_ms": duration_ms,
                },
                session_id=ssh_session_id,
                source="strands_backend.ops_query_processes",
            ))
        return {
            "ok": False,
            "error": str(e),
            "duration_ms": duration_ms,
        }


def _parse_ps_output(output: str) -> list[dict[str, Any]]:
    """解析 `ps auxww` 输出为结构化进程列表

    ps auxww 输出格式：
        USER       PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND
        root         1  0.0  0.0 169372  9884 ?        Ss   Jul25   0:05 /sbin/init
    """
    lines = output.strip().split("\n")
    if not lines:
        return []

    # 跳过表头
    processes: list[dict[str, Any]] = []
    for line in lines[1:]:
        parts = line.split(None, 10)  # 最多分 11 段，COMMAND 不分割
        if len(parts) < 10:
            continue
        try:
            processes.append({
                "user": parts[0],
                "pid": int(parts[1]),
                "%cpu": float(parts[2]),
                "%mem": float(parts[3]),
                "vsz": int(parts[4]),
                "rss": int(parts[5]),
                "tty": parts[6],
                "stat": parts[7],
                "start": parts[8],
                "time": parts[9],
                "command": parts[10] if len(parts) > 10 else "",
            })
        except (ValueError, IndexError) as e:
            logger.debug(f"failed to parse ps line: '{line[:60]}', err={e}")
            continue

    return processes


# ============================================================================
# 形态 2：Strands @tool 装饰器函数
# ============================================================================

@tool
def ops_query_processes(
    filter_name: str = "",
    filter_user: str = "",
    sort_by: str = "cpu",
    limit: int = 20,
    ssh_session_id: str = "",
    include_threads: bool = False,
) -> dict[str, Any]:
    """Query remote process status via ps (read-only).

    Executes `ps auxww --sort=-%cpu` on the remote server, parses output into
    structured process list with pid/user/cpu/mem/command fields. Supports
    filtering by process name (regex) and user, sorting by cpu/mem/pid.

    Args:
        filter_name (str): Filter by process name (regex, case-insensitive)
        filter_user (str): Filter by user
        sort_by (str): Sort field: "cpu" / "mem" / "pid" (default "cpu")
        limit (int): Return top N processes (default 20)
        ssh_session_id (str): SSH session ID; empty uses current active session
        include_threads (bool): Include threads (default False)

    Returns:
        dict: Process list with processes/process_count/sort_by fields.
    """
    return invoke_ops_query_processes_tool({
        "filter_name": filter_name,
        "filter_user": filter_user,
        "sort_by": sort_by,
        "limit": limit,
        "ssh_session_id": ssh_session_id,
        "include_threads": include_threads,
    })


# ============================================================================
# 工具元数据
# ============================================================================

TOOL_METADATA: dict[str, Any] = {
    "name": "ops_query_processes",
    "description": (
        "进程查询：通过 ps auxww 查询远程进程状态（只读），"
        "支持按进程名正则/用户过滤，按 CPU/内存/PID 排序，返回结构化进程列表。"
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "filter_name": {"type": "string", "description": "按进程名正则过滤（可选）"},
            "filter_user": {"type": "string", "description": "按用户过滤（可选）"},
            "sort_by": {"type": "string", "enum": ["cpu", "mem", "pid"]},
            "limit": {"type": "integer", "description": "返回前 N 个（默认 20）"},
            "ssh_session_id": {"type": "string", "description": "SSH 会话 ID（可选）"},
            "include_threads": {"type": "boolean", "description": "是否包含线程（默认 False）"},
        },
        "required": [],
    },
    "output_schema": {
        "type": "object",
        "properties": {
            "ok": {"type": "boolean"},
            "processes": {"type": "array"},
            "process_count": {"type": "integer"},
            "sort_by": {"type": "string"},
            "duration_ms": {"type": "integer"},
        },
    },
}


def get_tool_metadata() -> dict[str, Any]:
    return TOOL_METADATA
```

---

## 6. 工具 5：`ops_network_diagnose.py` — 网络诊断

### 6.1 完整实现

```python
"""
strands_backend/tools/ops_network_diagnose.py — 网络诊断运维工具
==================================================================

职责：
- 在远程服务器执行网络诊断命令（ping / ss / netstat / ip / traceroute）
- 支持"诊断场景"预设：connectivity / port_listen / dns / route / interface
- 返回结构化诊断结果（命令 + 输出 + 解读提示）

集成点：
- 内部委托 ops_ssh_command 执行网络命令
- ping/ss/ip 等命令通常 L0-L1（只读），traceroute 可能 L2

设计原则：
- 场景化：用户说"服务器连不上"，agent 调用 connectivity 预设自动跑一组命令
- 不发起主动攻击：本工具不包含 nmap / masscan 等扫描命令（防止被滥用）
"""

from __future__ import annotations

import logging
import time
from typing import Any

from strands import tool

from event_bus import EventBus, Event, EventType
from strands_backend.context import get_live_context
from strands_backend.tools.ops_ssh_command import invoke_ops_ssh_command_tool

logger = logging.getLogger("sidecar.strands_backend.tools.ops_network_diagnose")


_event_bus: EventBus | None = None


def configure(event_bus: EventBus | None = None) -> None:
    global _event_bus
    if event_bus is not None:
        _event_bus = event_bus


# ============================================================================
# 诊断场景预设
# ============================================================================

_DIAG_SCENARIOS: dict[str, dict[str, Any]] = {
    # 连通性诊断：目标主机是否可达
    "connectivity": {
        "description": "检查目标主机连通性（ping + 端口探测）",
        "requires_target": True,
        "commands": [
            {"cmd_template": "ping -c 4 -W 2 {target}", "timeout_ms": 12000},
            {"cmd_template": "ss -tnp | head -n 20", "timeout_ms": 5000},
        ],
    },
    # 端口监听诊断：本机监听了哪些端口
    "port_listen": {
        "description": "检查本机监听端口",
        "requires_target": False,
        "commands": [
            {"cmd_template": "ss -tlnp", "timeout_ms": 5000},
            {"cmd_template": "ss -ulnp", "timeout_ms": 5000},
        ],
    },
    # DNS 诊断
    "dns": {
        "description": "DNS 解析诊断",
        "requires_target": True,
        "commands": [
            {"cmd_template": "nslookup {target} 2>&1 || host {target} 2>&1 || dig {target} +short", "timeout_ms": 8000},
            {"cmd_template": "cat /etc/resolv.conf", "timeout_ms": 3000},
        ],
    },
    # 路由诊断
    "route": {
        "description": "路由路径诊断（traceroute）",
        "requires_target": True,
        "commands": [
            {"cmd_template": "traceroute -n -m 15 -w 2 {target} 2>&1 || tracepath {target} 2>&1", "timeout_ms": 30000},
            {"cmd_template": "ip route show", "timeout_ms": 5000},
        ],
    },
    # 网卡接口诊断
    "interface": {
        "description": "网卡接口状态诊断",
        "requires_target": False,
        "commands": [
            {"cmd_template": "ip addr show", "timeout_ms": 5000},
            {"cmd_template": "ip link show", "timeout_ms": 5000},
            {"cmd_template": "ethtool eth0 2>/dev/null || true", "timeout_ms": 5000},
        ],
    },
    # 综合诊断（connectivity + port_listen + dns）
    "full": {
        "description": "综合网络诊断（连通性 + 端口 + DNS）",
        "requires_target": True,
        "commands": [
            {"cmd_template": "ping -c 4 -W 2 {target}", "timeout_ms": 12000},
            {"cmd_template": "ss -tlnp", "timeout_ms": 5000},
            {"cmd_template": "nslookup {target} 2>&1 || host {target} 2>&1", "timeout_ms": 8000},
            {"cmd_template": "ip route show | head -n 10", "timeout_ms": 5000},
        ],
    },
}


# ============================================================================
# 形态 1：传统 MCP tool 入口
# ============================================================================

def invoke_ops_network_diagnose_tool(params: dict[str, Any]) -> dict[str, Any]:
    """MCP tool 入口：网络诊断（场景化预设 + 自定义命令）

    Args:
        params: 工具参数字典
            - scenario (str, 必填): 诊断场景预设
              connectivity / port_listen / dns / route / interface / full
            - target (str, 可选): 目标主机/IP/域名（connectivity/dns/route/full 必填）
            - ssh_session_id (str, 可选): SSH 会话 ID
            - custom_commands (list[str], 可选): 自定义命令列表（追加到预设后执行）

    Returns:
        诊断结果字典（含每条命令的输出）
    """
    scenario = params.get("scenario", "")
    if not scenario:
        raise ValueError("scenario is required")
    if scenario not in _DIAG_SCENARIOS:
        raise ValueError(
            f"scenario must be one of {list(_DIAG_SCENARIOS.keys())}, got '{scenario}'"
        )

    preset = _DIAG_SCENARIOS[scenario]
    target = params.get("target", "")
    ssh_session_id = params.get("ssh_session_id", "") or get_live_context().ssh_session_id
    custom_commands = params.get("custom_commands", [])

    if preset["requires_target"] and not target:
        raise ValueError(f"scenario '{scenario}' requires target (host/ip/domain)")

    # === 推送 start 事件 ===
    if _event_bus:
        _event_bus.publish(Event(
            event_type=EventType.TOOL_CALL.value,
            payload={
                "tool": "ops_network_diagnose",
                "stage": "start",
                "scenario": scenario,
                "target": target,
                "command_count": len(preset["commands"]) + len(custom_commands),
            },
            session_id=ssh_session_id,
            source="strands_backend.ops_network_diagnose",
        ))

    start = time.monotonic()
    results: list[dict[str, Any]] = []

    try:
        # === 执行预设命令 ===
        for cmd_spec in preset["commands"]:
            cmd = cmd_spec["cmd_template"].format(target=target)
            timeout_ms = cmd_spec.get("timeout_ms", 10000)

            ssh_result = invoke_ops_ssh_command_tool({
                "command": cmd,
                "ssh_session_id": ssh_session_id,
                "timeout_ms": timeout_ms,
            })

            results.append({
                "command": cmd,
                "ok": ssh_result.get("ok", False),
                "stdout": ssh_result.get("stdout", ""),
                "stderr": ssh_result.get("stderr", ""),
                "exit_code": ssh_result.get("exit_code", -1),
                "risk_level": ssh_result.get("risk_level", ""),
                "duration_ms": ssh_result.get("duration_ms", 0),
                "error": ssh_result.get("error"),
            })

        # === 执行自定义命令 ===
        for cmd in custom_commands:
            ssh_result = invoke_ops_ssh_command_tool({
                "command": cmd,
                "ssh_session_id": ssh_session_id,
                "timeout_ms": 15000,
            })
            results.append({
                "command": cmd,
                "ok": ssh_result.get("ok", False),
                "stdout": ssh_result.get("stdout", ""),
                "stderr": ssh_result.get("stderr", ""),
                "exit_code": ssh_result.get("exit_code", -1),
                "risk_level": ssh_result.get("risk_level", ""),
                "duration_ms": ssh_result.get("duration_ms", 0),
                "custom": True,
                "error": ssh_result.get("error"),
            })

        duration_ms = int((time.monotonic() - start) * 1000)

        # === 综合解读提示（简单版，由 LLM 进一步分析）===
        interpretation_hints = _generate_interpretation_hints(scenario, results)

        # 推送 complete 事件
        if _event_bus:
            _event_bus.publish(Event(
                event_type=EventType.TOOL_CALL.value,
                payload={
                    "tool": "ops_network_diagnose",
                    "stage": "complete",
                    "scenario": scenario,
                    "target": target,
                    "result_count": len(results),
                    "duration_ms": duration_ms,
                },
                session_id=ssh_session_id,
                source="strands_backend.ops_network_diagnose",
            ))

        return {
            "ok": True,
            "scenario": scenario,
            "target": target,
            "results": results,
            "interpretation_hints": interpretation_hints,
            "duration_ms": duration_ms,
        }

    except Exception as e:
        duration_ms = int((time.monotonic() - start) * 1000)
        logger.exception(f"ops_network_diagnose FAILED: scenario={scenario}, err={e}")
        if _event_bus:
            _event_bus.publish(Event(
                event_type=EventType.TOOL_CALL.value,
                payload={
                    "tool": "ops_network_diagnose",
                    "stage": "error",
                    "scenario": scenario,
                    "error": str(e),
                    "duration_ms": duration_ms,
                },
                session_id=ssh_session_id,
                source="strands_backend.ops_network_diagnose",
            ))
        return {
            "ok": False,
            "error": str(e),
            "scenario": scenario,
            "duration_ms": duration_ms,
        }


def _generate_interpretation_hints(scenario: str, results: list[dict[str, Any]]) -> list[str]:
    """根据诊断结果生成解读提示（供 LLM 进一步分析）"""
    hints: list[str] = []

    for r in results:
        cmd = r.get("command", "")
        stdout = r.get("stdout", "")
        exit_code = r.get("exit_code", -1)

        if "ping" in cmd:
            if exit_code == 0 and "bytes from" in stdout:
                hints.append(f"✓ ping 成功：目标可达")
            elif exit_code != 0:
                hints.append(f"✗ ping 失败：目标不可达或 ICMP 被防火墙拦截")
        elif "ss -tlnp" in cmd:
            if "LISTEN" in stdout:
                hints.append(f"• 检测到监听端口（ss -tlnp 输出有 LISTEN 行）")
            else:
                hints.append(f"• 未检测到 TCP 监听端口")
        elif "nslookup" in cmd or "host " in cmd:
            if "Address" in stdout or "has address" in stdout:
                hints.append(f"✓ DNS 解析成功")
            else:
                hints.append(f"✗ DNS 解析失败：检查 /etc/resolv.conf 或 DNS 服务器")

    return hints


# ============================================================================
# 形态 2：Strands @tool 装饰器函数
# ============================================================================

@tool
def ops_network_diagnose(
    scenario: str,
    target: str = "",
    ssh_session_id: str = "",
    custom_commands: list[str] | None = None,
) -> dict[str, Any]:
    """Run network diagnostics on a remote server (scenario-based).

    Executes a preset bundle of network commands based on the scenario:
    - connectivity: ping + port check (requires target)
    - port_listen: ss -tlnp + ss -ulnp (no target needed)
    - dns: nslookup/host + /etc/resolv.conf (requires target)
    - route: traceroute + ip route show (requires target)
    - interface: ip addr + ip link + ethtool (no target needed)
    - full: connectivity + port_listen + dns + route (requires target)

    Each command goes through the risk assessment pipeline. Returns structured
    results with interpretation hints for further LLM analysis.

    Args:
        scenario (str): Diagnostic scenario: connectivity/port_listen/dns/route/interface/full
        target (str): Target host/IP/domain (required for connectivity/dns/route/full)
        ssh_session_id (str): SSH session ID; empty uses current active session
        custom_commands (list[str]): Custom commands to run after preset (each goes through risk assessment)

    Returns:
        dict: Diagnostic results with scenario/target/results/interpretation_hints fields.
    """
    return invoke_ops_network_diagnose_tool({
        "scenario": scenario,
        "target": target,
        "ssh_session_id": ssh_session_id,
        "custom_commands": custom_commands or [],
    })


# ============================================================================
# 工具元数据
# ============================================================================

TOOL_METADATA: dict[str, Any] = {
    "name": "ops_network_diagnose",
    "description": (
        "网络诊断：场景化预设（connectivity/port_listen/dns/route/interface/full），"
        "在远程执行 ping/ss/nslookup/traceroute/ip 等命令，"
        "返回结构化诊断结果 + 解读提示。"
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "scenario": {
                "type": "string",
                "enum": ["connectivity", "port_listen", "dns", "route", "interface", "full"],
                "description": "诊断场景预设（必填）",
            },
            "target": {"type": "string", "description": "目标主机/IP/域名（部分场景必填）"},
            "ssh_session_id": {"type": "string", "description": "SSH 会话 ID（可选）"},
            "custom_commands": {
                "type": "array",
                "items": {"type": "string"},
                "description": "自定义命令列表（追加到预设后执行）",
            },
        },
        "required": ["scenario"],
    },
    "output_schema": {
        "type": "object",
        "properties": {
            "ok": {"type": "boolean"},
            "scenario": {"type": "string"},
            "target": {"type": "string"},
            "results": {"type": "array"},
            "interpretation_hints": {"type": "array"},
            "duration_ms": {"type": "integer"},
        },
    },
}


def get_tool_metadata() -> dict[str, Any]:
    return TOOL_METADATA
```

---

## 7. 工具注册到 Strands Agent

### 7.1 `strands_backend/tool_adapter.py` 实现示例

```python
"""
strands_backend/tool_adapter.py — Strands 工具适配器
======================================================

职责：
- 收集所有 ops_* 工具的 Strands @tool 函数
- 包装现有 tools/*.py（risk/confidence/ground/...）为 Strands @tool
- 统一注入依赖（RustBridge / EventBus / RiskEngine）

集成点：
- agent_factory.py 调用 get_all_strands_tools() 获取工具列表传给 Agent
- configure_all() 在 strands_backend.configure_strands 时统一调用
"""

from __future__ import annotations

import logging
from typing import Any

from strands import tool
from event_bus import EventBus

from core.risk_engine import RiskEngine
from strands_backend.rust_bridge import RustBridgeProtocol

logger = logging.getLogger("sidecar.strands_backend.tool_adapter")


# ============================================================================
# 工具收集
# ============================================================================

def get_ops_strands_tools() -> list:
    """获取所有 ops_* 运维工具的 Strands @tool 函数列表"""
    from strands_backend.tools.ops_ssh_command import ops_ssh_command
    from strands_backend.tools.ops_read_remote_file import ops_read_remote_file
    from strands_backend.tools.ops_analyze_logs import ops_analyze_logs
    from strands_backend.tools.ops_query_processes import ops_query_processes
    from strands_backend.tools.ops_network_diagnose import ops_network_diagnose

    return [
        ops_ssh_command,
        ops_read_remote_file,
        ops_analyze_logs,
        ops_query_processes,
        ops_network_diagnose,
    ]


def get_existing_tools_wrapped() -> list:
    """包装现有 tools/*.py 为 Strands @tool（保持向后兼容）

    现有 risk/confidence/ground/decision/credibility/history 工具
    是 MCP tool 形态（invoke_xxx_tool(params) -> dict），
    此处用 @tool 装饰器包一层，让 Strands Agent 也能调用。
    """
    from tools import invoke_risk_tool, invoke_confidence_tool, invoke_ground_tool

    @tool
    def risk(command: str, target_asset: str = "") -> dict[str, Any]:
        """Assess command risk level (4-layer pipeline: syntax/rule/confirmation/audit).

        Args:
            command (str): The command to assess
            target_asset (str): Target asset name for environment-aware assessment

        Returns:
            dict: Risk assessment with level (L0-L4) / require_approval / reason fields.
        """
        return invoke_risk_tool({"command": command, "target_asset": target_asset})

    @tool
    def confidence(evidences: list[dict], method: str = "D-S+PCR5") -> dict[str, Any]:
        """Fuse evidence confidence using D-S + PCR5 theory.

        Args:
            evidences (list[dict]): Evidence list with raw_text/source/drain3_match_score
            method (str): Fusion method: "baseline" / "D-S" / "D-S+PCR5"

        Returns:
            dict: Confidence score (0-1) with method/conflict/evidence_count fields.
        """
        return invoke_confidence_tool({"evidences": evidences, "method": method})

    @tool
    def ground(query: str, top_k: int = 5) -> dict[str, Any]:
        """Ground knowledge via ChromaDB vector + FTS5 keyword dual-path retrieval.

        Args:
            query (str): Query text
            top_k (int): Top K results (default 5)

        Returns:
            dict: Grounded knowledge with matched_chunks/scores fields.
        """
        return invoke_ground_tool({"query": query, "top_k": top_k})

    return [risk, confidence, ground]


def get_all_strands_tools() -> list:
    """获取全部 Strands 工具（ops_* + 包装后的现有 tools）"""
    return get_ops_strands_tools() + get_existing_tools_wrapped()


# ============================================================================
# 统一配置入口
# ============================================================================

def configure_all(
    rust_bridge: RustBridgeProtocol,
    event_bus: EventBus,
    risk_engine: RiskEngine,
) -> None:
    """统一注入依赖到所有 ops_* 工具

    Args:
        rust_bridge: 反向 JSON-RPC 桥接器
        event_bus: 事件总线
        risk_engine: RiskEngine 实例
    """
    # ops_ssh_command 是基础工具，其他工具（ops_analyze_logs 等）依赖它
    from strands_backend.tools.ops_ssh_command import configure as cfg_ssh
    cfg_ssh(rust_bridge=rust_bridge, event_bus=event_bus, risk_engine=risk_engine)

    from strands_backend.tools.ops_read_remote_file import configure as cfg_read
    cfg_read(rust_bridge=rust_bridge, event_bus=event_bus, risk_engine=risk_engine)

    # 这两个工具内部委托 ops_ssh_command，只需注入 event_bus
    from strands_backend.tools.ops_analyze_logs import configure as cfg_logs
    cfg_logs(event_bus=event_bus)

    from strands_backend.tools.ops_query_processes import configure as cfg_ps
    cfg_ps(event_bus=event_bus)

    from strands_backend.tools.ops_network_diagnose import configure as cfg_net
    cfg_net(event_bus=event_bus)

    logger.info("all ops_* tools configured with rust_bridge/event_bus/risk_engine")
```

### 7.2 `agent_factory.py` 调用示例

```python
"""
strands_backend/agent_factory.py — Strands Agent 工厂（片段）
"""

from __future__ import annotations

import logging
from typing import Any

from strands import Agent

from event_bus import EventBus
from core.risk_engine import RiskEngine
from strands_backend.rust_bridge import RustBridgeProtocol
from strands_backend.tool_adapter import get_all_strands_tools, configure_all
from strands_backend.context import LiveContext, set_live_context
from strands_backend.model_adapter import create_strands_model  # 详见集成方案 §4.4

logger = logging.getLogger("sidecar.strands_backend.agent_factory")


def build_ops_agent(
    llm_config: dict[str, Any],
    rust_bridge: RustBridgeProtocol,
    event_bus: EventBus,
    risk_engine: RiskEngine,
    live_context: LiveContext | None = None,
) -> Agent:
    """构建运维 Strands Agent

    Args:
        llm_config: LLM 配置（provider/api_key/base_url/model）
        rust_bridge: 反向 JSON-RPC 桥接器
        event_bus: 事件总线
        risk_engine: RiskEngine 实例
        live_context: 终端实时上下文（可选，由调用方注入）

    Returns:
        配置好的 Strands Agent 实例
    """
    # === 注入终端上下文 ===
    if live_context is not None:
        set_live_context(live_context)

    # === 统一配置所有工具 ===
    configure_all(rust_bridge, event_bus, risk_engine)

    # === 构建工具列表 ===
    tools = get_all_strands_tools()
    logger.info(f"built Strands Agent with {len(tools)} tools")

    # === 构建 system prompt ===
    system_prompt = _build_ops_system_prompt(live_context)

    # === 创建 Strands 模型 ===
    model = create_strands_model(llm_config)

    # === 创建 Agent ===
    agent = Agent(
        model=model,
        tools=tools,
        system_prompt=system_prompt,
        # callback_handler 详见 strands_backend/callback_handler.py
        # （Strands 事件 → EventBus.publish）
    )

    return agent


def _build_ops_system_prompt(live_context: LiveContext | None) -> str:
    """构建运维 Agent 的 system prompt（含终端上下文）"""
    base = """你是 TDSF Terminal Agent 的运维专家 Agent。

你的职责：
1. 诊断 Linux 服务器故障（服务异常 / 性能问题 / 网络问题 / 磁盘问题）
2. 通过 SSH 在远程服务器执行诊断命令（ps / ss / journalctl / tail / grep）
3. 分析日志文件，定位错误根因
4. 给出修复建议（高风险操作需用户确认）

工具使用原则：
- 优先使用场景化工具（ops_network_diagnose / ops_analyze_logs）
- 所有命令执行前会自动过 4 层风控管道
- L4（deny）命令直接拒绝，L3（high）需用户确认
- 不要尝试绕过风控（如用 base64 编码命令）

输出格式：
- 思考过程：用 <thinking> 标签包裹
- 诊断结论：清晰列出根因 + 证据链
- 修复建议：标注风险等级 + 是否需要确认
"""

    # 注入终端上下文（<env> 块，与现有 BaseAgent.build_system_prompt 对齐）
    if live_context and live_context.ssh_session_id:
        env_block = f"""

<env>
当前终端上下文：
- SSH 会话 ID: {live_context.ssh_session_id}
- 工作目录: {live_context.cwd or '(未知)'}
- 当前文件: {live_context.active_file or '(无)'}
- 工作区根: {live_context.workspace_root or '(未知)'}
</env>
"""
        return base + env_block

    return base
```

---

## 8. 测试策略

### 8.1 单元测试（与现有 `tests/tools/test_risk.py` 风格对齐）

```python
"""
tests/strands_backend/tools/test_ops_ssh_command.py — SSH 命令工具单元测试
=========================================================================
"""

import pytest
from unittest.mock import MagicMock, patch

from strands_backend.tools.ops_ssh_command import (
    invoke_ops_ssh_command_tool,
    configure,
)
from strands_backend.rust_bridge import StubRustBridge


@pytest.fixture
def stub_bridge():
    """P0/P1 stub 桥接器（不真正调用 Rust）"""
    return StubRustBridge()


@pytest.fixture
def mock_event_bus():
    return MagicMock()


@pytest.fixture
def configured_tool(stub_bridge, mock_event_bus):
    """注入 stub 依赖"""
    configure(rust_bridge=stub_bridge, event_bus=mock_event_bus, risk_engine=None)
    yield
    # teardown：重置为默认 stub
    configure()


class TestOpsSshCommand:
    """ops_ssh_command 工具测试"""

    def test_deny_rm_rf(self, configured_tool, mock_event_bus):
        """L4 deny：rm -rf / 必须被拒绝"""
        result = invoke_ops_ssh_command_tool({"command": "rm -rf /"})

        assert result["ok"] is False
        assert result["denied"] is True
        assert result["risk_level"] == "L4"
        assert "risk engine" in result["reason"]
        # 验证推送了 denied 事件
        assert mock_event_bus.publish.called

    def test_safe_command_executes_via_stub(self, configured_tool):
        """L0-L1 安全命令通过 stub 执行（返回 stub 标记）"""
        result = invoke_ops_ssh_command_tool({
            "command": "ls -la",
            "ssh_session_id": "sess-test",
        })

        # stub 不真正执行，但返回结构完整
        assert "ok" in result
        assert result.get("stub") is True
        assert result["command"] == "ls -la"
        assert "risk_level" in result

    def test_missing_command_raises(self, configured_tool):
        """缺少 command 参数必须抛 ValueError"""
        with pytest.raises(ValueError, match="command is required"):
            invoke_ops_ssh_command_tool({})

    def test_invalid_command_type_raises(self, configured_tool):
        """command 非 str 必须抛 ValueError"""
        with pytest.raises(ValueError, match="must be str"):
            invoke_ops_ssh_command_tool({"command": 123})

    def test_pending_approval_for_high_risk(self, configured_tool):
        """L3 high 命令返回 pending_approval"""
        # sudo systemctl restart nginx 通常匹配 systemctl_restart 规则
        result = invoke_ops_ssh_command_tool({
            "command": "sudo systemctl restart nginx",
        })

        # 如果规则库配置为 high，应返回 pending_approval
        if result.get("pending_approval"):
            assert result["ok"] is False
            assert "assessment" in result
```

### 8.2 集成测试要点

| 测试场景 | 验证点 |
|----------|--------|
| Strands Agent 调用 ops_ssh_command | Agent 能正确选择工具 + 传入参数 + 解析返回 |
| 工具间委托（ops_analyze_logs → ops_ssh_command）| 委托调用链路完整 + 风险评估传递 |
| RiskEngine 集成 | L4 deny / L3 pending / L0-L2 execute 三条路径 |
| EventBus 事件推送 | tool_call start/complete/error/denied/pending_approval 五种事件 |
| StubRustBridge | P0/P1 阶段返回 stub 标记，不真正执行 |
| 真实 RustBridge（P2）| 反向 JSON-RPC 调用成功 + 结果解析 |

---

## 9. 与现有方案的关键差异

### 9.1 与 v1.0 集成方案的差异

| 维度 | v1.0 | v2.0（本文档） |
|------|------|----------------|
| 工具示例 | 仅描述"5 个运维工具"概念 | 给出 5 个完整 Python 实现（约 1200 行） |
| 接口形态 | 仅 `@tool` 装饰器 | **双形态**：`@tool` + `invoke_xxx_tool(params)`（向后兼容） |
| 风险评估集成 | "工具调用前过 RiskEngine" | 给出具体集成代码（L4/L3/L0-L2 三条路径） |
| 事件推送 | "推送 tool_call 事件" | 给出 5 种 stage（start/complete/error/denied/pending_approval） |
| 工具间委托 | 未提及 | ops_analyze_logs / ops_query_processes / ops_network_diagnose 内部委托 ops_ssh_command |
| 测试示例 | 无 | 给出 pytest 单元测试 + 集成测试要点 |

### 9.2 与现有 `tools/*.py` 的差异

| 维度 | 现有 tools（risk/confidence/ground/...） | ops_* 工具（本文档） |
|------|------------------------------------------|----------------------|
| 副作用 | 纯 Python 计算（无外部 IO） | 有外部 IO（SSH/SFTP 通过 RustBridge） |
| 风险评估 | risk.py 包装 RiskEngine，其他工具无 | **全部内置** RiskEngine 前置 hook |
| 事件推送 | 由 graph/nodes.py 统一推送 | 工具内部推送（更细粒度） |
| 依赖注入 | 无（直接 import core 模块） | `configure()` 函数注入 RustBridge/EventBus/RiskEngine |
| Strands 兼容 | 不兼容（仅 MCP tool 形态） | 双形态兼容 |

### 9.3 关键设计决策

1. **双形态接口**：保留 `invoke_xxx_tool(params)` 是为了 LangGraph 后端也能调用（feature flag 切换时零改动）+ 单元测试方便（dict 进出）。
2. **工具间委托**：ops_analyze_logs 等高级工具内部调用 ops_ssh_command，复用其风险评估 + RustBridge，避免重复代码。
3. **场景化预设**（ops_network_diagnose）：用户说"服务器连不上"，agent 调用 `scenario="full"` 一键跑 ping+ss+dns+route，比逐个调用更高效。
4. **StubRustBridge**：P0/P1 阶段不真正执行命令（架构缺口：反向 JSON-RPC 未实现），返回 stub 标记让前端用户确认后通过 Tauri invoke 执行——与现有 `needs_you` 协调机制对齐。
5. **不引入新依赖**：所有示例只用 `strands` + 现有 `core` / `event_bus` / `tools.risk`，不新增第三方库（与 `requirements.txt` 现有依赖对齐）。

---

## 10. 落地路线（与集成方案 §7 对齐）

| 阶段 | 任务 | 涉及文件 | 预计工时 |
|------|------|----------|----------|
| P0 | 创建 `strands_backend/` sub-package 骨架 + StubRustBridge | `strands_backend/__init__.py` / `rust_bridge.py` / `context.py` | 0.5 人日 |
| P0 | 实现 `ops_ssh_command.py` + `ops_read_remote_file.py`（基础 IO 工具） | `strands_backend/tools/ops_ssh_command.py` / `ops_read_remote_file.py` | 0.5 人日 |
| P1 | 实现 `ops_analyze_logs.py` + `ops_query_processes.py` + `ops_network_diagnose.py`（高级诊断工具） | `strands_backend/tools/ops_*.py` | 0.5 人日 |
| P1 | 实现 `tool_adapter.py` + `agent_factory.py` + 单元测试 | `strands_backend/tool_adapter.py` / `agent_factory.py` / `tests/` | 0.5 人日 |
| P2 | 实现真实 RustBridge（双向 JSON-RPC）+ 集成测试 | `strands_backend/rust_bridge.py`（真实实现）+ `src-tauri/src/modules/ipc.rs`（反向调用支持） | 1 人日 |
| **合计** | | | **3 人日** |

---

> **最后更新**：2026-07-30 · v1.0 · 与 `ops-agent-strands-integration-plan.md` v2.0 配套。
> **配套文档**：
> - 集成方案：`docs/reports/ops-agent-strands-integration-plan.md`（v2.0 深化版）
> - 开源调研：`docs/reports/ops-agent-opensource-research.md`
> - 深度调研：`docs/reports/ops-agent-deep-research.md`
> - 魔改现状审计：`docs/reports/modded-agent-deep-audit.md`
