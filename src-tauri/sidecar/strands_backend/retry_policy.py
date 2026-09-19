"""
strands_backend/retry_policy.py —— 模型请求退避的唯一主人（P3, 2026-09-19）
============================================================================

**修的是什么问题**

收口前一次 429 限流会让 **单个模型调用点** 发出 18 个 HTTP 请求、白等 124 秒
（``strands_backend/tests/test_retry_policy.py`` 用录制型 transport 实测过）。
原因是退避同时有两个主人，且各自只看得见自己的预算：

+---------------------+----------------------------+---------------------------+
| 层                  | 收口前                      | 收口后                     |
+=====================+============================+============================+
| openai/anthropic    | ``max_retries=2``           | ``max_retries=0``（不再退避）|
| HTTP 客户端         | 429/5xx/连接错误各再打 2 次  | 一次请求就一次             |
+---------------------+----------------------------+---------------------------+
| strands SDK         | ``ModelRetryStrategy`` 默认 | ``TdsfRetryPolicy``         |
| (ModelRetryStrategy)| max_attempts=6，退避         | max_attempts=2，退避 4s 一次 |
|                     | 4→8→16→32→64s（累计 124s）  |                            |
+---------------------+----------------------------+---------------------------+
| 单回合总量          | 无人统计：调用点 ≈51、续跑   | ``TURN_MODEL_CALL_BUDGET`` |
|                     | ×3 → 约 2700 请求的最坏形态  | 硬上限，超了显式报错        |
+---------------------+----------------------------+---------------------------+

**为什么主人是 SDK 而不是 HTTP 客户端**

只有 strands 这一层知道"这是第几个调用点、这一回合已经打了多少请求、工具循环还
剩多少额度"；httpx/OpenAI SDK 只看得见单个请求。让下层做退避，上层就无法记账。

**墙钟不在这里管**

单次请求 300s 超时（``model_adapter`` 的 ``client_args["timeout"]``）+ 回合内连续
无事件 600s 由 ``adapter.py`` 的 idle watchdog 负责。这里刻意**不加**第二把墙钟刀：
一次健康的长任务（50 次工具调用）本来就可能跑十几分钟，按回合总时长掐表会把好任务
误杀，而它并不是本条缺陷的一部分。

**用户可见后果（2026-09-19 已确认接受）**

以前被静默重试掩盖的失败，现在更多以错误气泡露出来——宁可报错，不要无主的地重试。
"""
from __future__ import annotations

import importlib
import logging
from typing import Any

logger = logging.getLogger("sidecar.strands_backend.retry_policy")

# ============================================================================
# 预算常量（改这里即可改契约；测试按这些数字断言）
# ============================================================================

#: 单个模型调用点最多几次模型尝试（1 原始 + N-1 重试）。
#: 因为 HTTP 层 max_retries=0，1 次尝试 == 1 个 HTTP 请求。
MODEL_CALL_MAX_ATTEMPTS = 2

#: 首次重试前等待秒数。只有 1 次重试，所以这也是单点最坏等待。
RETRY_INITIAL_DELAY_SECS = 4

#: 退避上限。max_attempts=2 时用不到封顶，留着防将来放开尝试数。
RETRY_MAX_DELAY_SECS = 4

#: 一次 invoke（含 max_tokens 续跑、T3/T7 追加轮）允许的模型请求总数。
#: 口径：工具调用上限 50（ToolCallLimitHook）⇒ 正常回合 ≈51 个请求，
#: 余量给退避；超过即认定失控，直接报错，不再靠"反正会退避"硬撑。
TURN_MODEL_CALL_BUDGET = 80

#: 可以重试的 HTTP 状态码：限流 + 网关/服务侧瞬时故障（不含 400/401/403/404）
RETRYABLE_STATUS_CODES: frozenset[int] = frozenset({408, 429, 500, 502, 503, 504})


class ModelCallBudgetExceeded(RuntimeError):
    """单回合模型请求数超过 ``TURN_MODEL_CALL_BUDGET``。

    刻意 **不是** ``ModelThrottledException`` 的子类：预算用尽后再重试就是
    自我放大，必须让退避策略判定为"不可重试"，把错误直接抛给用户。
    """


# ============================================================================
# Strands 条件导入（缺包时导入本模块不能报错，否则整个测试收集期中断）
# ============================================================================

try:  # pragma: no cover - 取决于环境
    from strands.event_loop._retry import ModelRetryStrategy as _ModelRetryStrategy
    from strands.hooks import BeforeModelCallEvent as _BeforeModelCallEvent
    from strands.types.exceptions import ModelThrottledException as _ModelThrottledException

    _RETRY_API_AVAILABLE = True
except ImportError:  # pragma: no cover
    _ModelRetryStrategy = object  # type: ignore[misc, assignment]
    _BeforeModelCallEvent = None  # type: ignore[assignment]
    _ModelThrottledException = None  # type: ignore[assignment]
    _RETRY_API_AVAILABLE = False


def _sdk_exception_types(module_name: str, attrs: tuple[str, ...]) -> tuple[type, ...]:
    """取 provider SDK 的异常类型；SDK 未安装就返回空元组（不报错）。

    退避判定必须能在"只有 openai"或"只有 anthropic"的环境里工作——sidecar 的
    .venv 就没有装 anthropic。
    """
    try:
        module = importlib.import_module(module_name)
    except ImportError:
        return ()
    found = [t for t in (getattr(module, a, None) for a in attrs) if isinstance(t, type)]
    return tuple(found)


# ``APIConnectionError`` 是 ``APITimeoutError`` 的父类，一次覆盖"连不上/超时"两类。
# 这类错误失败得很快（不是 300s 超时），重试一次的代价远低于直接报给用户。
_CONNECTION_ERRORS: tuple[type, ...] = _sdk_exception_types(
    "openai", ("APIConnectionError",)
) + _sdk_exception_types("anthropic", ("APIConnectionError",))

_STATUS_ERRORS: tuple[type, ...] = _sdk_exception_types(
    "openai", ("APIStatusError",)
) + _sdk_exception_types("anthropic", ("APIStatusError",))


class TdsfRetryPolicy(_ModelRetryStrategy):  # type: ignore[misc, valid-type]
    """strands ``ModelRetryStrategy`` 的收口版：尝试数收紧 + 单回合请求预算。

    只重写两个点（都是 SDK 文档指定的扩展位）：

    - ``is_retryable``：SDK 默认只认限流。HTTP 层重试归零后，连接失败/超时这类
      "重试一次几乎免费"的错误也得由这里接管，否则会被一并砍掉。
    - ``register_hooks``：额外挂一个 ``BeforeModelCallEvent`` 回调做单回合计数。
      该事件每次模型尝试前触发一次，所以在 max_retries=0 的前提下
      **事件数 == HTTP 请求数**，预算才是可数的。
    """

    def __init__(self) -> None:
        if not _RETRY_API_AVAILABLE:
            raise RuntimeError("strands-agents 未安装，无法构造退避策略")
        super().__init__(
            max_attempts=MODEL_CALL_MAX_ATTEMPTS,
            initial_delay=RETRY_INITIAL_DELAY_SECS,
            max_delay=RETRY_MAX_DELAY_SECS,
        )
        self._turn_model_calls = 0

    # -- 单回合预算 ---------------------------------------------------------

    @property
    def turn_model_calls(self) -> int:
        """本次 invoke 已放出的模型请求数（含重试）。"""
        return self._turn_model_calls

    def reset_turn_budget(self) -> None:
        """每次 invoke 开始清零（与 ToolCallLimitHook.reset 同一时机）。"""
        self._turn_model_calls = 0

    def register_hooks(self, registry: Any, **kwargs: Any) -> None:
        super().register_hooks(registry, **kwargs)
        registry.add_callback(_BeforeModelCallEvent, self._count_model_call)

    def _count_model_call(self, event: Any) -> None:
        self._turn_model_calls += 1
        if self._turn_model_calls > TURN_MODEL_CALL_BUDGET:
            logger.error(
                f"[p3] model call budget exceeded: {self._turn_model_calls} > "
                f"{TURN_MODEL_CALL_BUDGET}，停止本回合"
            )
            raise ModelCallBudgetExceeded(
                f"本回合模型请求次数已达上限（{TURN_MODEL_CALL_BUDGET} 次），"
                "已停止继续请求以免放大限流。请稍后重试，或检查模型服务的限流额度。"
            )

    # -- 可重试集合 ---------------------------------------------------------

    def is_retryable(self, exception: Exception) -> bool:
        if _RETRY_API_AVAILABLE and isinstance(exception, _ModelThrottledException):
            return True
        if _CONNECTION_ERRORS and isinstance(exception, _CONNECTION_ERRORS):
            return True
        if _STATUS_ERRORS and isinstance(exception, _STATUS_ERRORS):
            return getattr(exception, "status_code", None) in RETRYABLE_STATUS_CODES
        return False


def build_retry_policy() -> Any:
    """返回一个新的退避策略实例（**每个 Agent 实例一个**，不要跨实例共用）。

    策略内部有"当前调用点已尝试几次"的状态，两个 Agent 共用会互相吃掉对方的额度。
    strands 未安装时返回 None —— 交给 SDK 的 ``retry_strategy=None`` 语义
    （max_attempts=1，即完全不重试），不会出现"没有主人却自己退避"的状态。
    """
    if not _RETRY_API_AVAILABLE:
        logger.warning(
            "build_retry_policy: strands 未安装，退避策略置空（不重试，也不由别处代管）"
        )
        return None
    return TdsfRetryPolicy()


__all__ = [
    "MODEL_CALL_MAX_ATTEMPTS",
    "RETRY_INITIAL_DELAY_SECS",
    "RETRY_MAX_DELAY_SECS",
    "TURN_MODEL_CALL_BUDGET",
    "RETRYABLE_STATUS_CODES",
    "ModelCallBudgetExceeded",
    "TdsfRetryPolicy",
    "build_retry_policy",
]
