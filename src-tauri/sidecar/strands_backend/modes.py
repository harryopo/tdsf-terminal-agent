"""
strands_backend/modes.py — Agent 三模式信任体系（P0-A1，方案书 v3.1）
====================================================================

定义 AgentMode 三模式（observe / confirm / auto）与 parse_mode 解析函数：
- AgentMode 随 ``agent.invoke`` JSON-RPC 传参下发（state.live.agentMode 或
  state.mode，前端模式切换器 → IPC → sidecar；P0-A1 后端约定）
- 缺省 / 非法 → confirm（中间态最安全，spec「老会话兼容」场景）+ 降级
  warning 日志（同一原始值进程级仅记一次，防每条 invoke 刷屏）
- 模式 × 风险映射矩阵（decide）见 ``core/decision_engine.py``——本模块只
  负责模式定义与解析，不承载决策逻辑
"""
from __future__ import annotations

import logging
from enum import Enum
from typing import Any

logger = logging.getLogger("sidecar.strands_backend.modes")


class AgentMode(str, Enum):
    """Agent 信任模式（方案书 v3.1 §3.2 模式 × 权限映射矩阵）

    Attributes:
        OBSERVE: 只读观察——一切写/执行类操作 fail-closed 拒绝（工具集
            schema 级裁剪为只读白名单）
        CONFIRM: 确认——L0-L1 放行，L2-L4 逐条审批（缺省模式）
        AUTO: 自动——L0-L2 放行，L3/L4 永远确认（升级确认卡）
    """

    OBSERVE = "observe"
    CONFIRM = "confirm"
    AUTO = "auto"


# 已警告过的非法/缺省原始值（进程级去重：「老会话兼容」场景未携带 mode
# 字段时按 confirm 执行且只记录一次降级日志，而非每条 invoke 刷一条）
_warned_raw_modes: set[str] = set()


def parse_mode(value: Any, default: str = "confirm") -> AgentMode:
    """解析模式参数（非法/缺省 → default + 降级 warning 一次）

    Args:
        value: 前端下发的模式原始值（AgentMode 实例 / "observe|confirm|auto"
            大小写不敏感 / 其他任意值含 None）
        default: 非法/缺省时的回退模式名（默认 confirm——中间态最安全；
            default 本身也非法时最终回落 CONFIRM）

    Returns:
        AgentMode 实例
    """
    if isinstance(value, AgentMode):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        try:
            return AgentMode(normalized)
        except ValueError:
            pass
    # 非法/缺省：降级 warning 同一原始值仅记一次
    key = "" if value is None else str(value)
    if key not in _warned_raw_modes:
        _warned_raw_modes.add(key)
        logger.warning(
            f"invalid or missing agent mode {value!r}, fallback to {default!r}"
        )
    try:
        return AgentMode(str(default).strip().lower())
    except ValueError:
        return AgentMode.CONFIRM


__all__ = [
    "AgentMode",
    "parse_mode",
]
