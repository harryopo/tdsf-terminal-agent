"""
strands_backend/tests/test_retry_policy.py —— P3：重试只留一个主人
==================================================================

审计事实（2026-09-19 用录制型 transport 实测，见 outputs 里的一次性实验）：
一次 429 会让 **单个模型调用点** 发出 18 个 HTTP 请求、白等 124 秒——因为退避
被两层同时做，互相放大：

  - strands SDK：``ModelRetryStrategy`` 默认 max_attempts=6，退避 4→8→16→32→64s
  - openai/anthropic HTTP 客户端：``max_retries=2``（429 / 5xx 各自再打一次）

6 × 3 = 18，而两边都只看得见自己那一份预算。收口后的契约（本文件钉住）：

  1. **只有 SDK 做退避**：HTTP 客户端 ``max_retries=0``。
  2. 单个模型调用点 ≤3 个 HTTP 请求（实际 2：1 次原始 + 1 次重试）。
  3. 一次 invoke（含 max_tokens 续跑与 T3/T7 追加轮）总请求数有上限，
     超了就 **显式报错**，不再静默重试（用户 2026-09-19 拍板：宁可报错）。
  4. 墙钟仍由 adapter 的 600s idle watchdog 负责（不给回合总时长加第二把刀，
     否则健康的长任务会被误杀）。

运行：
    cd src-tauri/sidecar
    .venv/Scripts/python -m pytest strands_backend/tests/test_retry_policy.py -q
"""
from __future__ import annotations

import asyncio
import importlib.util
import sys
from pathlib import Path
from typing import Any
from unittest.mock import MagicMock

import httpx
import openai
import pytest

_SIDECAR_DIR = Path(__file__).resolve().parents[2]
if str(_SIDECAR_DIR) not in sys.path:
    sys.path.insert(0, str(_SIDECAR_DIR))

_STRANDS_AVAILABLE = importlib.util.find_spec("strands") is not None
requires_strands = pytest.mark.skipif(
    not _STRANDS_AVAILABLE, reason="strands-agents 未安装（条件依赖），跳过真实重试链"
)

if _STRANDS_AVAILABLE:
    from strands import Agent as _Agent
    from strands.hooks import BeforeModelCallEvent
    from strands.models.openai import OpenAIModel


# ============================================================================
# 录制型 transport：把真实发出的 HTTP 请求一条条数下来
# ============================================================================


class _Recorder:
    """返回固定状态码的假端点，并记录每次到达的请求。"""

    def __init__(self, status: int, body: dict[str, Any]) -> None:
        self.status = status
        self.body = body
        self.urls: list[str] = []

    def handler(self, request: httpx.Request) -> httpx.Response:
        self.urls.append(str(request.url))
        return httpx.Response(self.status, json=self.body)


_BODY_429 = {"error": {"message": "ratelimited", "type": "rate_limit_exceeded", "code": "rate_limit_exceeded"}}
_BODY_400 = {"error": {"message": "invalid model name", "type": "invalid_request_error"}}


def _model_from_production_args(recorder: _Recorder) -> Any:
    """用 **生产同一份** client_args 造模型，只把网络换成假端点。

    关键点：不手写 timeout / max_retries——那样测的是测试自己的配置。这里先走
    ``create_strands_model``（工厂是 max_retries 的唯一写处），再往同一份参数里
    塞 MockTransport，于是"HTTP 层会不会自己重试"这件事由生产配置决定。
    """
    from core.llm_config import LLMConfig
    from strands_backend.model_adapter import create_strands_model

    prod = create_strands_model(
        LLMConfig(
            provider="openai",
            api_key="sk-test",
            base_url="http://test.local/v1",
            model="fake-model",
            temperature=0.2,
            max_tokens=256,
        )
    )
    assert prod is not None, "create_strands_model 返回 None（strands/openai 未装？）"
    client_args = dict(prod.client_args)
    client_args["http_client"] = httpx.AsyncClient(
        transport=httpx.MockTransport(recorder.handler)
    )
    return OpenAIModel(client=openai.AsyncOpenAI(**client_args), **prod.config)


def _make_adapter(model: Any) -> Any:
    """真 StrandsAgentAdapter（bus/bridge 用 MagicMock，网络才是被测对象）。"""
    from strands_backend.adapter import StrandsAgentAdapter

    bus = MagicMock()
    bus.emit_agent_message = MagicMock(return_value=1)
    bus.emit_mood_change = MagicMock(return_value=1)
    bus.emit_tool_call = MagicMock(return_value=1)
    bus.emit_needs_you = MagicMock(return_value=1)
    bus.emit_agent_switch = MagicMock(return_value=1)
    adapter = StrandsAgentAdapter(
        event_bus=bus,
        rust_bridge=MagicMock(),
        backend_enabled=True,
        strands_model=model,
    )
    adapter._strands_available = True
    adapter._model_available = True
    return adapter


# ============================================================================
# 1. 端到端：一次 429 风暴里，单个模型调用点最多发几个 HTTP 请求
# ============================================================================


@requires_strands
def test_429_storm_sends_bounded_requests_per_call_site():
    """真实 adapter + 真实 openai 客户端打 429：单点请求数必须 ≤3（收口前实测 18）"""
    recorder = _Recorder(429, _BODY_429)
    adapter = _make_adapter(_model_from_production_args(recorder))

    adapter.invoke("main", "你好", {"session_id": "p3-storm"})

    # 这一个回合只有 1 个模型调用点（没有工具可绕），请求数即该点的重试扇出。
    assert len(recorder.urls) <= 3, (
        f"单个模型调用点发出 {len(recorder.urls)} 个 HTTP 请求——退避还是两个主人"
        f"（SDK max_attempts × HTTP max_retries 互相放大）"
    )


@requires_strands
def test_429_storm_surfaces_as_error_instead_of_retrying_forever():
    """额度用尽后要把失败暴露出来：用户可见的错误，而不是继续打"""
    recorder = _Recorder(429, _BODY_429)
    adapter = _make_adapter(_model_from_production_args(recorder))

    result = adapter.invoke("main", "你好", {"session_id": "p3-storm-err"})

    assert result["mood"] == "error", f"429 风暴后应报错，实际返回 {result!r}"


@requires_strands
def test_rate_limited_turn_names_the_rate_limit_instead_of_a_wrong_cause():
    """收口后限流会真的露出来（这正是约定的代价），所以那句话必须说对原因。

    不能再套"网络连接失败或超时"那句——那是 T9.2 给传输错误的措辞。用户按错的
    诊断去查网线，就白查了（P6 同一条教训：失败要分种）。
    """
    recorder = _Recorder(429, _BODY_429)
    adapter = _make_adapter(_model_from_production_args(recorder))

    result = adapter.invoke("main", "你好", {"session_id": "p3-429-copy"})

    assert result.get("degraded") is True
    assert result.get("degraded_reason") == "llm_rate_limited", result
    assert "限流" in result["observation"], result["observation"]
    assert "网络连接失败" not in result["observation"]
    # 与传输错误同口径：给气泡不给 needs_you 报错卡，会话历史留着可继续
    assert adapter.event_bus.emit_needs_you.call_count == 0
    assert result.get("next_step") == "done"


@requires_strands
def test_rate_limit_markers_and_their_boundaries():
    """分类只认限流特征：别的 4xx 与编程错误不算“稍后再试就好”"""
    from strands_backend.adapter import _LLM_RATE_LIMIT_MARKERS, StrandsAgentAdapter

    is_rate_limit = StrandsAgentAdapter._is_llm_rate_limit_error
    for marker in _LLM_RATE_LIMIT_MARKERS:  # 每个特征都得被认到，不许挂空
        assert is_rate_limit(Exception(f"Error calling model: {marker.upper()}")), marker
    assert not is_rate_limit(Exception("Error code: 401 - invalid api key"))
    assert not is_rate_limit(ValueError("bad input"))


@requires_strands
def test_client_side_error_is_not_retried_at_all():
    """400 这类"重试也不会好"的错误：一个请求都不许多发（防 is_retryable 放宽过头）"""
    recorder = _Recorder(400, _BODY_400)
    adapter = _make_adapter(_model_from_production_args(recorder))

    adapter.invoke("main", "你好", {"session_id": "p3-400"})

    assert len(recorder.urls) == 1, f"客户端错误被重试了 {len(recorder.urls)} 次"


# ============================================================================
# 2. 策略本身：可重试集合 + 单回合预算
# ============================================================================


@requires_strands
def test_only_throttling_and_transient_network_errors_are_retried():
    from strands.types.exceptions import ModelThrottledException

    from strands_backend.retry_policy import build_retry_policy

    policy = build_retry_policy()
    assert policy.is_retryable(ModelThrottledException("429")) is True
    assert policy.is_retryable(openai.APIConnectionError(request=MagicMock())) is True
    assert policy.is_retryable(openai.APITimeoutError(request=MagicMock())) is True
    # 非重试类：业务错误 / 编程错误一律不碰
    assert policy.is_retryable(ValueError("boom")) is False
    status_error = MagicMock(spec=openai.APIStatusError)
    status_error.status_code = 400
    assert policy.is_retryable(status_error) is False


@requires_strands
def test_turn_budget_stops_sending_requests_once_exhausted():
    """单回合模型请求数超过预算后，下一次调用点直接抛错（不再发请求）"""
    from strands.types.exceptions import ModelThrottledException

    from strands_backend.retry_policy import (
        TURN_MODEL_CALL_BUDGET,
        ModelCallBudgetExceeded,
        build_retry_policy,
    )

    policy = build_retry_policy()
    agent = _Agent(model=MagicMock(), tools=[], retry_strategy=policy)

    async def _fire() -> None:
        for _ in range(TURN_MODEL_CALL_BUDGET):
            await agent.hooks.invoke_callbacks_async(
                BeforeModelCallEvent(agent=agent, invocation_state={})
            )

    asyncio.run(_fire())  # 预算内不报错
    assert policy.turn_model_calls == TURN_MODEL_CALL_BUDGET

    with pytest.raises(ModelCallBudgetExceeded):
        asyncio.run(
            agent.hooks.invoke_callbacks_async(
                BeforeModelCallEvent(agent=agent, invocation_state={})
            )
        )
    # 预算错误不能反过来被重试（否则又是一条自增长的循环）
    assert policy.is_retryable(ModelCallBudgetExceeded("over budget")) is False
    assert not isinstance(ModelCallBudgetExceeded("x"), ModelThrottledException)

    policy.reset_turn_budget()
    assert policy.turn_model_calls == 0
    asyncio.run(
        agent.hooks.invoke_callbacks_async(
            BeforeModelCallEvent(agent=agent, invocation_state={})
        )
    )


@requires_strands
def test_retry_policy_is_the_only_owner_of_backoff_delays():
    """退避时序也归 SDK 一层：单点最多 1 次等待，等待时长由策略常量决定"""
    from strands_backend.retry_policy import (
        MODEL_CALL_MAX_ATTEMPTS,
        RETRY_MAX_DELAY_SECS,
        build_retry_policy,
    )

    policy = build_retry_policy()
    assert MODEL_CALL_MAX_ATTEMPTS <= 3
    delays = [policy._calculate_delay(i) for i in range(4)]
    assert max(delays) <= RETRY_MAX_DELAY_SECS
    # 6 次尝试累积到 124s 是收口前的形态；现在最多只可能等待 (max_attempts-1) 次
    assert (MODEL_CALL_MAX_ATTEMPTS - 1) * RETRY_MAX_DELAY_SECS <= 10
