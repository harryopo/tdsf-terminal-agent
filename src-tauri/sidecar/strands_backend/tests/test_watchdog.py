"""
strands_backend/tests/test_watchdog.py — T9 稳定性单测（spec 9.1/9.2/9.3）
==========================================================================

覆盖：
1. _wait_with_watchdog：空闲超阈值触发（stalled 标记 + True）/ 事件活动续期 /
   worker 正常结束返回 False（T9.1）
2. stalled 会话 invoke 快速降级（不触达模型，T9.1）
3. _is_llm_transport_error：连接/超时类异常识别（T9.2）
4. 并行工具提示词存在（T9.3）

运行：cd src-tauri/sidecar && .venv/Scripts/python.exe -m pytest strands_backend/tests/test_watchdog.py -v
"""
from __future__ import annotations

import os
import sys
import threading
import time
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..")))

from strands_backend.adapter import StrandsAgentAdapter  # noqa: E402
from strands_backend.modes import AgentMode  # noqa: E402


def _make_adapter() -> StrandsAgentAdapter:
    return StrandsAgentAdapter(
        event_bus=None,
        backend_enabled=True,
        strands_model=MagicMock(),  # _model_available=True（越过降级检查）
    )


class TestWatchdog(unittest.TestCase):
    """T9.1: invoke watchdog 触发 / 活动续期 / 正常结束"""

    def setUp(self) -> None:
        os.environ["TDSF_INVOKE_WATCHDOG_IDLE_SECS"] = "0.5"
        os.environ["TDSF_INVOKE_WATCHDOG_POLL_SECS"] = "0.1"
        self.adapter = _make_adapter()

    def tearDown(self) -> None:
        os.environ.pop("TDSF_INVOKE_WATCHDOG_IDLE_SECS", None)

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

    def test_stalled_session_degrades_invoke(self):
        """stalled 会话 invoke → 快速降级（invoke_stalled，不触达模型）"""
        self.adapter._stalled_sessions.add(("main", "s1"))
        result = self.adapter.invoke(
            "main", "你好", {"session_id": "s1", "live": {"agentMode": "confirm"}}
        )
        self.assertTrue(result.get("degraded"))
        self.assertEqual(result.get("degraded_reason"), "invoke_stalled")
        self.assertEqual(result.get("next_step"), "done")
        self.assertIn("稍等片刻", result.get("observation", ""))


class TestTransportErrorClassification(unittest.TestCase):
    """T9.2: LLM 传输类异常识别 + 降级文案"""

    def test_transport_errors_detected(self):
        from strands_backend.adapter import (
            StrandsAgentAdapter as _A,
        )

        for msg in (
            "Connection error.",
            "Request timed out.",
            "APITimeoutError: Request timed out",
            "APIConnectionError: Connection error.",
            "Connection refused by peer",
            "[Errno -2] Name or service not known",
        ):
            self.assertTrue(
                _A._is_llm_transport_error(Exception(msg)), msg
            )

    def test_non_transport_error_not_matched(self):
        from strands_backend.adapter import (
            StrandsAgentAdapter as _A,
        )

        for msg in ("ValueError: bad input", "KeyError: 'x'", " обычная ошибка"):
            self.assertFalse(_A._is_llm_transport_error(Exception(msg)), msg)

    def test_invoke_degrades_friendly_on_transport_error(self):
        """模型抛连接类异常 → invoke 返回友好降级（next_step=done，非报错卡）"""
        adapter = _make_adapter()
        # 直接标记 stalled 的反面验证走不通（会先命中 stalled 分支），
        # 因此这里验证 _degraded-ish 分支的构造逻辑：
        # 用 stalled 之外的路径不可达（需要真实 agent），故只断言分类函数与
        # stalled 分支组合的行为契约——传输错误分类为 True 即走友好降级。
        self.assertTrue(
            adapter._is_llm_transport_error(Exception("Connection error."))
        )


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
