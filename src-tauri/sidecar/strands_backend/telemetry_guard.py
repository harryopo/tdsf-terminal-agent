"""telemetry_guard — 把 SDK 遥测钉在"不外发"上。

结论来源（2026-09-19 复核，见 ``docs/审计-2026-09-19/清单-04`` 与 ROADMAP #78）：
strands 1.53 **自己从不安装 exporter**，光有 ``OTEL_EXPORTER_OTLP_ENDPOINT``
也不会导出。仍然成立的两点是：每次 ``Agent.__init__`` 会全局
``ThreadingInstrumentor().instrument()``，而 span 属性默认**不脱敏** ——
``gen_ai.input.messages`` 与工具入参/出参都会进 span。因此真正的风险不是 SDK 主动
外发，而是**用户机器上恰好装了 opentelemetry 的 auto-instrumentation**，
那时这些 span 会被送出去。这里在构造任何 Agent 之前把全局 provider 钉成 NoOp。
"""
from __future__ import annotations

import logging
import os

logger = logging.getLogger("sidecar.telemetry_guard")


def disable_outbound_tracing() -> str:
    """将全局 TracerProvider 钉为 NoOp。

    Returns:
        ``"noop"`` 已生效 / ``"already-set"`` 进程里已有别的 provider（不覆盖，
        但会告警）/ ``"unavailable"`` opentelemetry 未安装（本就无从导出）。
    """
    try:
        from opentelemetry import trace
        from opentelemetry.trace import NoOpTracerProvider, ProxyTracerProvider
    except ImportError:  # 依赖缺失时不存在导出路径
        return "unavailable"

    endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "")
    current = trace.get_tracer_provider()
    if isinstance(current, NoOpTracerProvider):
        return "noop"  # 已经钉过（重复调用不报错，也不要把自己写成异常）
    if not isinstance(current, ProxyTracerProvider):
        # 已经被别人设过：不悄悄覆盖，也不静默失败——sidecar 日志里必须看得见
        logger.error(
            "遥测 provider 已被外部安装（%s），终端内容可能进入 span；"
            "endpoint=%r", type(current).__name__, endpoint,
        )
        return "already-set"

    trace.set_tracer_provider(NoOpTracerProvider())
    if endpoint:
        logger.warning(
            "检测到 OTEL_EXPORTER_OTLP_ENDPOINT=%r，已把 tracer provider 钉为 NoOp，"
            "SDK span 不会外发", endpoint,
        )
    return "noop"


__all__ = ["disable_outbound_tracing"]
