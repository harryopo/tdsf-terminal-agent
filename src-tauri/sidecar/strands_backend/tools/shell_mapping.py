"""
strands_backend/tools/shell_mapping.py — 工具→Shell 命令映射统一入口（A2）
============================================================================

职责：
- 提供 ``resolve_shell_command(tool_name, params)`` 统一映射解析入口。
- 查找工具的 ``to_shell_command`` 映射函数并调用，返回等价 shell 命令字符串。
- 映射失败 fail-closed 返回 None（该工具走原有后端执行路径）。

设计：
- 纯函数，无副作用，便于单测和教学模式终端调用。
- 延迟解析映射函数（importlib），避免循环依赖。
- 所有映射函数签名统一为 ``to_shell_command(params: dict) -> str | None``。

A2 阶段（2026-09-04）：
- 支持 7 个终端可执行工具：ssh_command / network_diagnose / inspect_processes /
  analyze_logs / read_remote_file / config_diff / performance_analyze。
- 非终端工具（knowledge_search / suggest_command / todo_write 等）
  未注册 to_shell_command，resolve_shell_command 返回 None。
"""
from __future__ import annotations

import importlib
import logging
from typing import Any, Callable

from strands_backend.tools.registry import TOOL_REGISTRY

logger = logging.getLogger("sidecar.strands_backend.tools.shell_mapping")

# 映射函数缓存（避免重复 importlib 解析）
_shell_command_fn_cache: dict[str, Callable[[dict[str, Any]], str | None]] = {}


def _resolve_shell_command_fn(tool_name: str) -> Callable[[dict[str, Any]], str | None] | None:
    """延迟解析工具的 to_shell_command 映射函数

    Args:
        tool_name: 注册表中的工具名称

    Returns:
        映射函数引用；未注册或解析失败返回 None
    """
    # 缓存命中
    if tool_name in _shell_command_fn_cache:
        return _shell_command_fn_cache[tool_name]

    spec = TOOL_REGISTRY.get(tool_name)
    if spec is None or spec.to_shell_command is None:
        return None

    # 按 "module:attr" 点路径解析
    module_name, _, attr = spec.to_shell_command.partition(":")
    if not module_name or not attr:
        logger.warning(f"shell_mapping: invalid to_shell_command path for {tool_name}: {spec.to_shell_command!r}")
        return None

    try:
        module = importlib.import_module(module_name)
        fn = getattr(module, attr, None)
        if fn is None or not callable(fn):
            logger.warning(f"shell_mapping: to_shell_command not callable for {tool_name}: {attr!r}")
            return None
        _shell_command_fn_cache[tool_name] = fn
        return fn
    except (ImportError, AttributeError) as e:
        logger.warning(f"shell_mapping: failed to resolve {tool_name}: {e}")
        return None


def resolve_shell_command(tool_name: str, params: dict[str, Any]) -> str | None:
    """统一映射解析入口。查找工具的 to_shell_command 映射并调用。

    映射失败返回 None（fail-closed，该工具走原有后端执行路径）。

    Args:
        tool_name: 注册表中的工具名称（与 @tool 函数名一致）
        params: 工具参数 dict（与调用工具时的参数一致）

    Returns:
        等价 shell 命令字符串；映射失败返回 None
    """
    fn = _resolve_shell_command_fn(tool_name)
    if fn is None:
        return None

    try:
        result = fn(params)
        # 确保返回值类型安全
        if isinstance(result, str) and result.strip():
            return result
        return None
    except Exception as e:
        # fail-closed：任何异常都返回 None，不抛出
        logger.debug(f"shell_mapping: {tool_name} mapping failed: {e}")
        return None


def has_shell_mapping(tool_name: str) -> bool:
    """检查工具是否注册了 shell 命令映射

    Args:
        tool_name: 注册表中的工具名称

    Returns:
        True 表示该工具有注册的映射函数
    """
    fn = _resolve_shell_command_fn(tool_name)
    return fn is not None


__all__ = [
    "resolve_shell_command",
    "has_shell_mapping",
]
