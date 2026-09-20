"""访问 strands 私有字段的唯一入口（P2 遗留收口）。

为什么要单独一个文件：下面这些下划线字段**不属于 SDK 的公开契约**，
升级版本就可能改名（本项目已经被 strands 的版本漂移咬过一次：#77）。
它们原先散在 `adapter._refresh_agent_runtime` 里，最坏的表现不是报错而是
**静默功能缺失** —— 比如插件贡献的 `retrieve_offloaded_content` 丢了，
超大工具结果就变成读不回来的外部引用；日志里一个字都不会有。

收在一处之后：
1. SDK 改名只需要动这一个文件；
2. "字段整个不存在"（= 改名了）统一打 ERROR，不再和"存在但为空"（= 正常）混成同一条路径；
3. `tests/test_strands_priv.py` 用**真 SDK 对象**钉住字段名（约定：框架裁决的环节必须用真对象测）。
"""

from __future__ import annotations

import logging
from typing import Any

logger = logging.getLogger("sidecar.strands_backend.strands_priv")

#: Agent 上挂着插件注册表的属性名
PLUGIN_REGISTRY_ATTR = "_plugin_registry"
#: 插件注册表里真正存插件的 dict
PLUGINS_ATTR = "_plugins"
#: ToolRegistry 里存已注册工具的 dict（process_tools 写入的目标）
TOOL_MAP_ATTR = "registry"
#: ToolRegistry 里存动态工具名的 set
DYNAMIC_TOOLS_ATTR = "dynamic_tools"
#: 插件对象上暴露自带工具的属性
PLUGIN_TOOLS_ATTR = "tools"


def iter_plugin_tools(agent: Any) -> list[Any]:
    """收集插件贡献的工具，供工具集重填时一并带回去。

    返回空列表有两种含义，必须分得开：
    - 属性存在但确实没插件 → 正常（静默，debug 级）
    - 属性根本不存在 → SDK 改了私有字段名，这次刷新会**丢掉全部插件工具**，
      属于必须让人看见的降级（error 级）
    """
    if not hasattr(agent, PLUGIN_REGISTRY_ATTR):
        logger.error(
            "strands Agent 上没有 %r —— SDK 私有字段可能已改名，"
            "本次工具集刷新会丢掉插件贡献的全部工具"
            "（例如 ContextOffloader 的 retrieve_offloaded_content，"
            "届时超大工具结果将变成读不回来的外部引用）。"
            "修法：更新 strands_priv.PLUGIN_REGISTRY_ATTR。",
            PLUGIN_REGISTRY_ATTR,
        )
        return []

    registry = getattr(agent, PLUGIN_REGISTRY_ATTR)
    if registry is None:
        # 构造 Agent 时没传 plugins：正常路径，不是漂移
        logger.debug("agent 未启用插件，无插件工具可带回")
        return []

    plugins = getattr(registry, PLUGINS_ATTR, None)
    if plugins is None:
        logger.error(
            "strands 插件注册表上没有 %r —— SDK 私有字段可能已改名，"
            "修法：更新 strands_priv.PLUGINS_ATTR。",
            PLUGINS_ATTR,
        )
        return []

    collected: list[Any] = []
    for plugin in dict(plugins).values():
        collected.extend(getattr(plugin, PLUGIN_TOOLS_ATTR, ()) or ())
    return collected


def replace_registered_tools(tool_registry: Any, tools: list[Any]) -> None:
    """用 ``tools`` 整体替换已注册工具集。

    刻意保留 ToolRegistry 对象本身再清空 dict：`_ToolCaller` / event_loop 都是
    每次 invoke 从 ``agent.tool_registry`` 动态取，换对象会让它们拿着旧的。
    字段缺失时**让它抛**（宁可这一轮报错，也不要留下"以为换了其实没换"的半套工具集）。
    """
    tool_map = getattr(tool_registry, TOOL_MAP_ATTR)
    tool_map.clear()
    dynamic = getattr(tool_registry, DYNAMIC_TOOLS_ATTR)
    dynamic.clear()
    tool_registry.process_tools(tools)
