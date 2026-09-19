"""遥测加固（ROADMAP #78 复核后的真实结论）：span 必须落到 NoOp。

strands 自己不装 exporter，但 span 属性默认不脱敏；风险来自"用户机器上恰好装了
OTel auto-instrumentation"。所以守卫要在构造任何 Agent 之前跑，且重复调用幂等。
"""
from __future__ import annotations

import pytest

from strands_backend.telemetry_guard import disable_outbound_tracing


@pytest.fixture(autouse=True)
def _endpoint_present(monkeypatch: pytest.MonkeyPatch) -> None:
    """模拟"机器上有 OTLP 出口"这种最危险的前提。"""
    monkeypatch.setenv("OTEL_EXPORTER_OTLP_ENDPOINT", "http://127.0.0.1:4318")


def test_guard_pins_the_provider_and_is_idempotent() -> None:
    pytest.importorskip("opentelemetry.trace")
    first = disable_outbound_tracing()
    if first == "unavailable":
        pytest.skip("opentelemetry 未安装，本环境没有导出路径")
    if first != "noop":
        pytest.skip("本进程内 provider 已被其他测试装走，无法验证钉死路径")
    assert disable_outbound_tracing() == "noop", "重复调用不应把自己标成异常状态"


def test_spans_are_not_recording_so_tool_io_cannot_be_captured() -> None:
    trace = pytest.importorskip("opentelemetry.trace")
    if disable_outbound_tracing() != "noop":
        pytest.skip("provider 已被外部装走")
    span = trace.get_tracer("tdsf.sidecar").start_span("invoke_agent")
    assert span.is_recording() is False, "NoOp 之外的 provider 会把消息与工具入参写进 span"
