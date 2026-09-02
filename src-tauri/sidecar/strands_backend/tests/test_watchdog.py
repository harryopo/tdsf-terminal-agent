"""
strands_backend/tests/test_watchdog.py — T9 稳定性单测（spec 9.1/9.2/9.3）
==========================================================================

覆盖：
1. _wait_with_watchdog：空闲超阈值触发（stalled 标记 + True）/ 事件活动续期 /
   worker 正常结束返回 False（T9.1）
2. invoke() 超时全链路（T9.1）：worker 挂起 → 有界等待返回降级响应 +
   stalled 标记 + agent_log watchdog_timeout 落盘 + worker 自然结束后解除标记
3. stalled 会话 invoke 快速降级（不触达模型，T9.1）
4. 活跃信号（handler._stats.events_received）结构漂移时的告警与兜底（T9.1）
5. _is_llm_transport_error：全部 11 个传输错误特征识别 + 非传输错误不误判（T9.2）
6. invoke() 传输错误全链路（T9.2）：模型抛连接类异常 → 友好降级、
   next_step=done、**不推 needs_you 报错卡**
7. 并行工具提示词存在（T9.3）

注：2/6 两组是真走 invoke() 的链路测试（只替换 _get_or_create_agent 返回的
Agent 实例，worker 起停 / watchdog 有界等待 / 异常传播 / 降级分类 / 事件落盘
全部走生产代码）——此前用例只断言分类函数本身，属假绿（ROADMAP #45）。

运行：cd src-tauri/sidecar && .venv/Scripts/python.exe -m pytest strands_backend/tests/test_watchdog.py -v
"""
from __future__ import annotations

import os
import sys
import threading
import time
import unittest
from unittest.mock import MagicMock, patch

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from strands_backend.adapter import (  # noqa: E402
    _LLM_TRANSPORT_ERROR_MARKERS,
    StrandsAgentAdapter,
)
from strands_backend.modes import AgentMode  # noqa: E402


def _make_adapter() -> StrandsAgentAdapter:
    return StrandsAgentAdapter(
        event_bus=None,
        backend_enabled=True,
        strands_model=MagicMock(),  # _model_available=True（越过降级检查）
    )


def _wait_until(predicate, timeout: float = 5.0) -> bool:
    """轮询等待条件成立（替代固定 sleep——CI 上线程调度不确定）"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(0.02)
    return predicate()


class _FakeHandler:
    """真实回调 handler 的最小替身：只提供 watchdog 读取的活跃信号"""

    def __init__(self) -> None:
        self._stats = {"events_received": 0}


class _HangingAgent:
    """模型挂起型假 Agent：__call__ 睡眠且从不产生回调事件"""

    def __init__(self, hang_secs: float, finished: threading.Event) -> None:
        self.callback_handler = _FakeHandler()
        self.messages: list = []
        self._hang_secs = hang_secs
        self._finished = finished

    def __call__(self, prompt: str) -> str:
        time.sleep(self._hang_secs)
        self._finished.set()
        return "迟到的响应（watchdog 已弃管，本轮结果不被采纳）"


class _RaisingAgent:
    """模型抛异常型假 Agent（验证 invoke 的异常传播 + 降级分类链路）"""

    def __init__(self, exc: BaseException) -> None:
        self.callback_handler = _FakeHandler()
        self.messages: list = []
        self._exc = exc

    def __call__(self, prompt: str) -> str:
        raise self._exc


class TestWatchdog(unittest.TestCase):
    """T9.1: invoke watchdog 触发 / 活动续期 / 正常结束"""

    def setUp(self) -> None:
        os.environ["TDSF_INVOKE_WATCHDOG_IDLE_SECS"] = "0.5"
        os.environ["TDSF_INVOKE_WATCHDOG_POLL_SECS"] = "0.1"
        self.adapter = _make_adapter()

    def tearDown(self) -> None:
        os.environ.pop("TDSF_INVOKE_WATCHDOG_IDLE_SECS", None)
        os.environ.pop("TDSF_INVOKE_WATCHDOG_POLL_SECS", None)

    def test_watchdog_fires_on_idle(self):
        """worker 长时间无事件增量 → 超时 True + stalled 标记"""
        stats = {"events_received": 0}
        worker_started = threading.Event()

        def _stalled_worker():
            worker_started.wait(timeout=2)
            time.sleep(2.0)  # 超过 0.5s 阈值且无任何事件增量

        worker = threading.Thread(target=_stalled_worker, daemon=True)
        worker.start()
        worker_started.set()

        fired = self.adapter._wait_with_watchdog(
            worker, lambda: stats["events_received"], "main", "s1"
        )
        self.assertTrue(fired)
        self.assertIn(("main", "s1"), self.adapter._stalled_sessions)

    def test_watchdog_passes_with_activity(self):
        """事件持续增量 → 不触发；worker 正常结束 → False"""
        stats = {"events_received": 0}
        stop = threading.Event()

        def _active_worker():
            # 模拟流式：每 100ms 一个事件增量，共 1s 后结束
            for _ in range(10):
                if stop.is_set():
                    break
                time.sleep(0.1)
                stats["events_received"] += 1

        worker = threading.Thread(target=_active_worker, daemon=True)
        worker.start()
        fired = self.adapter._wait_with_watchdog(
            worker, lambda: stats["events_received"], "main", "s2"
        )
        stop.set()
        self.assertFalse(fired)
        self.assertNotIn(("main", "s2"), self.adapter._stalled_sessions)

    def test_threshold_env_override_below_legacy_clamp(self):
        """阈值下限只钳到 0.05s：亚秒级覆盖生效（旧实现钳在 1.0s 使超时链无法测）"""
        os.environ["TDSF_INVOKE_WATCHDOG_IDLE_SECS"] = "0.3"
        os.environ["TDSF_INVOKE_WATCHDOG_POLL_SECS"] = "0.05"
        from strands_backend.adapter import _watchdog_thresholds

        idle, poll = _watchdog_thresholds()
        self.assertAlmostEqual(idle, 0.3, places=3)
        self.assertAlmostEqual(poll, 0.05, places=3)

    def test_threshold_falls_back_on_garbage_env(self):
        """环境变量为非法值 → 回退生产默认（600s / 5s），不抛异常"""
        os.environ["TDSF_INVOKE_WATCHDOG_IDLE_SECS"] = "abc"
        os.environ["TDSF_INVOKE_WATCHDOG_POLL_SECS"] = ""
        from strands_backend.adapter import (
            INVOKE_WATCHDOG_IDLE_SECS,
            INVOKE_WATCHDOG_POLL_SECS,
            _watchdog_thresholds,
        )

        idle, poll = _watchdog_thresholds()
        self.assertEqual(idle, float(INVOKE_WATCHDOG_IDLE_SECS))
        self.assertEqual(poll, float(INVOKE_WATCHDOG_POLL_SECS))


class TestWatchdogInvokeChain(unittest.TestCase):
    """T9.1: invoke() 超时全链路（降级响应体 + 落盘 + stalled 解除）"""

    HANG_SECS = 1.5

    def setUp(self) -> None:
        # 亚秒阈值 + 短轮询：worker 挂起 1.5s 期间 watchdog 必然先超时
        os.environ["TDSF_INVOKE_WATCHDOG_IDLE_SECS"] = "0.3"
        os.environ["TDSF_INVOKE_WATCHDOG_POLL_SECS"] = "0.05"
        self.adapter = _make_adapter()

    def tearDown(self) -> None:
        os.environ.pop("TDSF_INVOKE_WATCHDOG_IDLE_SECS", None)
        os.environ.pop("TDSF_INVOKE_WATCHDOG_POLL_SECS", None)

    def test_invoke_watchdog_timeout_degrades_and_unstalls(self):
        """挂起 → 有界等待返回超时降级；stalled 标记解除后恢复常规链路"""
        finished = threading.Event()
        agent = _HangingAgent(self.HANG_SECS, finished)
        self.adapter._get_or_create_agent = lambda *a, **k: agent

        with patch("strands_backend.agent_log.log_event") as mock_log:
            start = time.time()
            result = self.adapter.invoke(
                "main",
                "帮我看看 nginx 为什么起不来",
                {"session_id": "s-wd", "live": {"agentMode": "confirm"}},
            )
            elapsed = time.time() - start

        # 1. 调用方线程没有等满 worker 的挂起时长（有界等待，非阻塞到底）
        self.assertLess(elapsed, self.HANG_SECS, f"watchdog 未提前返回: {elapsed:.2f}s")

        # 2. 降级响应体契约（前端据此显示友好提示而非崩掉的报错卡）
        self.assertTrue(result.get("degraded"))
        self.assertEqual(result.get("degraded_reason"), "invoke_watchdog_timeout")
        self.assertEqual(result.get("next_step"), "done")
        self.assertEqual(result.get("mood"), "error")
        self.assertEqual(result.get("intermediate_results"), [])

        # 3. 超时文案随阈值推导（回归护栏：曾硬编码"10 分钟"与真实阈值脱节）
        observation = result.get("observation", "")
        self.assertIn("0.3 秒", observation)
        self.assertIn("没有任何输出", observation)
        self.assertNotIn("10 分钟", observation)

        # 4. 会话被标记为挂起（弃管 worker 仍持 agent_lock，下一轮快速降级）
        self.assertIn(("main", "s-wd"), self.adapter._stalled_sessions)

        # 5. watchdog_timeout 事件落盘（agent_log 流水可复盘）
        event_names = [c.args[1] for c in mock_log.call_args_list]
        self.assertIn("watchdog_timeout", event_names)
        wd_call = next(
            c for c in mock_log.call_args_list if c.args[1] == "watchdog_timeout"
        )
        self.assertEqual(wd_call.args[0], "s-wd")
        self.assertIn("超时", wd_call.args[2])

        # 6. worker 自然结束 → stalled 标记自行解除（不永久卡死会话）
        self.assertTrue(finished.wait(timeout=10), "worker 未按预期跑完")
        self.assertTrue(
            _wait_until(lambda: ("main", "s-wd") not in self.adapter._stalled_sessions),
            "worker 结束后 stalled 标记未解除",
        )

    def test_invoke_watchdog_warns_when_activity_signal_missing(self):
        """handler._stats 结构漂移（读不到 int events_received）→ 记 WARNING 后仍有界兜底"""
        os.environ["TDSF_INVOKE_WATCHDOG_IDLE_SECS"] = "0.2"

        class _NoStatsAgent:
            callback_handler = object()  # 无 _stats：活跃信号不可用
            messages: list = []

            def __call__(self, prompt: str) -> str:
                time.sleep(1.0)
                return "late"

        self.adapter._get_or_create_agent = lambda *a, **k: _NoStatsAgent()

        with patch("strands_backend.agent_log.log_event"):
            # 注意：适配层 logger 注册名带 sidecar. 前缀，按 root 捕获才稳
            with self.assertLogs(level="WARNING") as captured:
                result = self.adapter.invoke(
                    "main", "你好", {"session_id": "s-drift"}
                )

        self.assertEqual(result.get("degraded_reason"), "invoke_watchdog_timeout")
        self.assertTrue(
            any("activity signal unavailable" in m for m in captured.output),
            f"未记录活跃信号漂移 WARNING: {captured.output}",
        )


class TestStalledSessionFastDegrade(unittest.TestCase):
    """T9.1: stalled 会话下一轮 invoke 快速降级（不触达模型）"""

    def tearDown(self) -> None:
        os.environ.pop("TDSF_INVOKE_WATCHDOG_IDLE_SECS", None)
        os.environ.pop("TDSF_INVOKE_WATCHDOG_POLL_SECS", None)

    def test_stalled_session_degrades_invoke(self):
        """stalled 会话 invoke → 快速降级（invoke_stalled，不触达模型）"""
        self.adapter = _make_adapter()
        self.adapter._stalled_sessions.add(("main", "s1"))
        result = self.adapter.invoke(
            "main", "你好", {"session_id": "s1", "live": {"agentMode": "confirm"}}
        )
        self.assertTrue(result.get("degraded"))
        self.assertEqual(result.get("degraded_reason"), "invoke_stalled")
        self.assertEqual(result.get("next_step"), "done")
        self.assertIn("稍等片刻", result.get("observation", ""))


class TestTransportErrorClassification(unittest.TestCase):
    """T9.2: LLM 传输类异常识别（全部 11 个特征）+ 非传输错误不误判"""

    def test_all_markers_detected(self):
        """逐个覆盖 _LLM_TRANSPORT_ERROR_MARKERS（大小写不敏感）"""
        self.assertEqual(
            len(_LLM_TRANSPORT_ERROR_MARKERS),
            11,
            f"特征清单数量变化: {len(_LLM_TRANSPORT_ERROR_MARKERS)}",
        )
        for marker in _LLM_TRANSPORT_ERROR_MARKERS:
            self.assertTrue(
                StrandsAgentAdapter._is_llm_transport_error(
                    Exception(f"Error calling model: {marker.upper()}")
                ),
                f"特征 {marker!r} 未被识别",
            )

    def test_real_world_transport_messages_detected(self):
        """openai/anthropic SDK 真实报错文案（含异常类名）识别为传输类"""
        for msg in (
            "Connection error.",
            "Request timed out.",
            "APITimeoutError: Request timed out",
            "APIConnectionError: Connection error.",
            "Connection refused by peer",
            "[Errno -2] Name or service not known",
            "dial tcp: getaddrinfo failed",
        ):
            self.assertTrue(
                StrandsAgentAdapter._is_llm_transport_error(Exception(msg)), msg
            )

    def test_non_transport_error_not_matched(self):
        for msg in ("ValueError: bad input", "KeyError: 'x'", " обычная ошибка"):
            self.assertFalse(StrandsAgentAdapter._is_llm_transport_error(Exception(msg)), msg)


class TestTransportErrorInvokeChain(unittest.TestCase):
    """T9.2: invoke() 传输错误全链路（友好降级、对话不中断、不推报错卡）"""

    def tearDown(self) -> None:
        os.environ.pop("TDSF_INVOKE_WATCHDOG_IDLE_SECS", None)
        os.environ.pop("TDSF_INVOKE_WATCHDOG_POLL_SECS", None)

    def test_invoke_degrades_friendly_on_transport_error(self):
        """模型抛连接类异常 → invoke 返回友好降级（next_step=done，非报错卡）"""
        adapter = _make_adapter()
        adapter._get_or_create_agent = lambda *a, **k: _RaisingAgent(
            Exception("Connection error.")
        )

        with patch.object(
            StrandsAgentAdapter, "_emit_needs_you_for_error"
        ) as mock_needs_you:
            with patch("strands_backend.agent_log.log_event"):
                result = adapter.invoke(
                    "main",
                    "检查磁盘占用",
                    {"session_id": "s-t92", "live": {"agentMode": "confirm"}},
                )

        self.assertTrue(result.get("degraded"))
        self.assertEqual(result.get("degraded_reason"), "llm_transport_error")
        self.assertEqual(result.get("next_step"), "done")
        self.assertEqual(result.get("degraded_message"), "Connection error.")
        observation = result.get("observation", "")
        self.assertIn("AI 服务暂时不可用", observation)
        self.assertIn("稍后重试", observation)
        # 关键契约：传输类错误不推 needs_you 报错卡（那是流程性失败专用）
        mock_needs_you.assert_not_called()

    def test_invoke_non_transport_error_still_pushes_needs_you(self):
        """非传输类异常 → 仍走报错卡 + next_step=error（不误吞真实故障）"""
        adapter = _make_adapter()
        adapter._get_or_create_agent = lambda *a, **k: _RaisingAgent(
            ValueError("工具参数不合法")
        )

        with patch.object(
            StrandsAgentAdapter, "_emit_needs_you_for_error"
        ) as mock_needs_you:
            with patch("strands_backend.agent_log.log_event"):
                result = adapter.invoke("main", "查一下", {"session_id": "s-t92b"})

        self.assertEqual(result.get("degraded_reason"), "invoke_error")
        self.assertEqual(result.get("next_step"), "error")
        mock_needs_you.assert_called_once()


class TestParallelToolPrompt(unittest.TestCase):
    """T9.3: 并行工具提示词存在（吃 ConcurrentToolExecutor 红利）"""

    def test_parallel_hint_in_default_prompt(self):
        from strands_backend.adapter import _DEFAULT_SYSTEM_PROMPT

        self.assertIn("并行发起", _DEFAULT_SYSTEM_PROMPT)
        self.assertIn("有依赖的才串行", _DEFAULT_SYSTEM_PROMPT)

    def test_prompt_budget_unbroken(self):
        """并行提示词加入后系统提示仍在 4000 字符预算内"""
        from strands_backend.adapter import _compose_system_prompt

        prompt = _compose_system_prompt(AgentMode.OBSERVE, teach=True)
        self.assertLess(len(prompt), 4000, f"prompt 过长: {len(prompt)}")


if __name__ == "__main__":
    unittest.main()
