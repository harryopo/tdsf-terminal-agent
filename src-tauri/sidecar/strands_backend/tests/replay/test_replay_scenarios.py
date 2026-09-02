"""
strands_backend/tests/replay/test_replay_scenarios.py — T8 场景回放集（P2 收官）
==================================================================================================

spec: add-agent-loop-closure Task 8（8.1 重放器 / 8.2 五场景 / 8.3 pytest mark replay）

把 scenarios/*.jsonl 里录制的会话重放进 StrandsAgentAdapter 的真实事件循环
（假 LLM + mock RustBridge 供录制结果，不联网、不真 SSH），断言闭环行为：
工具选择与顺序、schema 级模式隔离、上下文连续性、熔断、追加回环、上下文分区。

运行：
    cd src-tauri/sidecar
    python -m pytest strands_backend/tests/replay -m replay -q
"""
from __future__ import annotations

import os
import sys

import pytest

_SIDECAR_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
if _SIDECAR_DIR not in sys.path:
    sys.path.insert(0, _SIDECAR_DIR)

from strands_backend.tests.replay.replay import (  # noqa: E402 — sys.path 先行注入
    SCENARIOS_DIR,
    load_scenario,
    replay,
    run_checks,
)

try:
    from strands.models.model import Model  # noqa: F401

    _STRANDS_AVAILABLE = True
except ImportError:
    _STRANDS_AVAILABLE = False

pytestmark = [
    pytest.mark.skipif(not _STRANDS_AVAILABLE, reason="strands-agents 未安装，跳过回放"),
    pytest.mark.replay,
]

# 方案书 v4.0 §1.2 钦定的五场景（8.2）
SCENARIO_FILES = [
    "s1_mode_continuity.jsonl",
    "s2_tool_cap_breaker.jsonl",
    "s3_todo_longtask.jsonl",
    "s4_verify_followup.jsonl",
    "s5_memory_recall.jsonl",
]


@pytest.mark.parametrize("filename", SCENARIO_FILES)
def test_scenario_expectations_hold(filename: str) -> None:
    """重放场景并逐条核对 expect.checks——任何一条不满足即失败并列出原因"""
    outcome = replay(load_scenario(SCENARIOS_DIR / filename))
    assert not outcome.turns[0].result.get("degraded"), (
        f"{filename} 回放被降级，场景无效: "
        f"{outcome.turns[0].result.get('degraded_reason')} / "
        f"{str(outcome.turns[0].result.get('observation'))[:120]}"
    )
    assert run_checks(outcome) == []


@pytest.mark.xfail(
    strict=True,
    reason=(
        "已知缺陷（2026-09-02 T8 实测）：ToolCallLimitHook 在真实 strands 事件流下看不到工具失败——"
        "ops 工具返回的 dict 无 content 键，strands tools/decorator.py:693-700 一律包成 status=success；"
        "且 ToolResult 是 TypedDict（运行时 dict），adapter 用 getattr(result,'status') 取值恒为 success。"
        "故「同一工具连续失败 3 次熔断」不触发，仅「总调用数超上限」有效。"
        "修复后本用例会 XPASS 报错——届时把它摘掉标记转成常规断言。"
    ),
)
def test_consecutive_failure_breaker_is_known_gap() -> None:
    """S2b：同一工具连续失败应熔断（当前不成立，见 reason）"""
    outcome = replay(load_scenario(SCENARIOS_DIR / "s2b_consecutive_failure_breaker.jsonl"))
    assert run_checks(outcome) == []
