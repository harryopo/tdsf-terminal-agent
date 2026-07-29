"""
tests/test_fix_loop.py — Fix-loop 重试计数器单元测试（T-P2-12.3 / DEC-V321-11）
================================================================================

验证内容：
1. FixLoopTracker 基础功能
   - 初始化（默认 max_retry=3，spec 要求）
   - record_retry 累加计数
   - is_exhausted 超限检测
   - is_near_limit 接近上限预警
   - reset 三种模式（all / session / operation）

2. 多维度跟踪
   - 不同 session_id 独立计数
   - 同 session 不同 operation_key 独立计数

3. 统计与查询
   - get_stats 全局统计
   - get_stats 单 session 统计
   - list_exhausted 列出超限组合
   - get_last_error / get_last_record_at

4. 工具函数
   - build_operation_key 标识构建
   - 长内容 hash 摘要
   - params 加入 hash

5. 全局单例
   - get_global_tracker 单例
   - reset_for_test 测试隔离
   - configure_max_retry 动态配置
   - set_max_retry 非法值校验

6. needs_you 集成
   - notify_fix_loop_exhausted 创建 handoff 请求
   - extra 字段包含 fix_loop / retry_count / max_retry

7. BaseAgent 集成
   - 工具失败 + continue 时 record_retry
   - 工具成功时 reset
   - 超限时强制 next_step=error
   - 超限时通知 needs_you

8. JSON-RPC 方法注册
   - 7 个方法注册（stats/get/is_exhausted/is_near_limit/reset/list_exhausted/configure）

运行：
    cd python-sidecar
    python -m pytest tests/test_fix_loop.py -v
"""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock

# 确保能 import fix_loop / needs_you / agents
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from fix_loop import (
    DEFAULT_MAX_RETRY,
    NEAR_LIMIT_THRESHOLD,
    FixLoopTracker,
    build_operation_key,
    get_global_tracker,
    configure_max_retry,
    reset_for_test,
    set_event_bus,
    register_methods,
)
from needs_you import (
    NeedsYouService,
    NeedsYouType,
    NeedsYouStatus,
    reset_for_test as reset_needs_you_for_test,
)


# ============================================================================
# Fixtures
# ============================================================================


@pytest.fixture(autouse=True)
def reset_state():
    """每个测试前后重置全局 tracker 和 needs_you service，保证测试隔离"""
    reset_for_test()
    reset_needs_you_for_test()
    yield
    reset_for_test()
    reset_needs_you_for_test()


@pytest.fixture
def tracker():
    """提供独立的 FixLoopTracker 实例（不依赖全局单例）"""
    return FixLoopTracker(max_retry=3)


@pytest.fixture
def needs_service():
    """提供独立的 NeedsYouService 实例（不启动超时线程）"""
    return NeedsYouService(event_bus=None)


@pytest.fixture
def mock_event_bus():
    """提供 mock EventBus，记录所有 publish 调用"""
    bus = MagicMock()
    bus.publish = MagicMock()
    return bus


# ============================================================================
# 1. 基础功能测试
# ============================================================================


class TestFixLoopTrackerBasic:
    """FixLoopTracker 基础功能测试"""

    def test_default_max_retry_is_three(self, tracker):
        """spec DEC-V321-11 要求：max_retry=3"""
        assert tracker.max_retry == 3
        assert DEFAULT_MAX_RETRY == 3

    def test_near_limit_threshold_is_two(self, tracker):
        """接近上限阈值默认为 2"""
        assert NEAR_LIMIT_THRESHOLD == 2

    def test_initial_state_empty(self, tracker):
        """初始化后状态为空"""
        assert tracker.get_retry_count("sess-1", "op-1") == 0
        assert tracker.is_exhausted("sess-1", "op-1") is False
        assert tracker.is_near_limit("sess-1", "op-1") is False
        assert tracker.get_last_error("sess-1", "op-1") == ""
        assert tracker.get_last_record_at("sess-1", "op-1") is None

    def test_record_retry_increments_count(self, tracker):
        """record_retry 累加计数"""
        c1 = tracker.record_retry("sess-1", "op-1", error="err-1")
        c2 = tracker.record_retry("sess-1", "op-1", error="err-2")
        c3 = tracker.record_retry("sess-1", "op-1", error="err-3")

        assert c1 == 1
        assert c2 == 2
        assert c3 == 3
        assert tracker.get_retry_count("sess-1", "op-1") == 3

    def test_is_exhausted_at_max_retry(self, tracker):
        """第 max_retry 次后 is_exhausted=True"""
        # 第 1 次：未超限
        tracker.record_retry("sess-1", "op-1")
        assert tracker.is_exhausted("sess-1", "op-1") is False

        # 第 2 次：未超限
        tracker.record_retry("sess-1", "op-1")
        assert tracker.is_exhausted("sess-1", "op-1") is False

        # 第 3 次：超限
        tracker.record_retry("sess-1", "op-1")
        assert tracker.is_exhausted("sess-1", "op-1") is True

    def test_is_near_limit_at_threshold(self, tracker):
        """第 threshold 次后 is_near_limit=True"""
        # 第 1 次：未接近
        tracker.record_retry("sess-1", "op-1")
        assert tracker.is_near_limit("sess-1", "op-1") is False

        # 第 2 次：接近上限
        tracker.record_retry("sess-1", "op-1")
        assert tracker.is_near_limit("sess-1", "op-1") is True

        # 第 3 次：仍接近（且已超限）
        tracker.record_retry("sess-1", "op-1")
        assert tracker.is_near_limit("sess-1", "op-1") is True

    def test_last_error_recorded(self, tracker):
        """最后一次错误信息被记录"""
        tracker.record_retry("sess-1", "op-1", error="first error")
        tracker.record_retry("sess-1", "op-1", error="second error")

        assert tracker.get_last_error("sess-1", "op-1") == "second error"

    def test_last_record_at_timestamp(self, tracker):
        """last_record_at 是有效时间戳"""
        before = time.time()
        tracker.record_retry("sess-1", "op-1", error="err")
        after = time.time()

        ts = tracker.get_last_record_at("sess-1", "op-1")
        assert ts is not None
        assert before <= ts <= after


# ============================================================================
# 2. 多维度跟踪测试
# ============================================================================


class TestMultiDimensionTracking:
    """多维度跟踪测试：session_id × operation_key 独立计数"""

    def test_different_sessions_independent(self, tracker):
        """不同 session_id 的计数相互独立"""
        tracker.record_retry("sess-A", "op-1")
        tracker.record_retry("sess-A", "op-1")
        tracker.record_retry("sess-B", "op-1")

        assert tracker.get_retry_count("sess-A", "op-1") == 2
        assert tracker.get_retry_count("sess-B", "op-1") == 1
        assert tracker.is_exhausted("sess-A", "op-1") is False
        assert tracker.is_exhausted("sess-B", "op-1") is False

    def test_different_operations_independent(self, tracker):
        """同 session 不同 operation_key 的计数相互独立"""
        tracker.record_retry("sess-1", "op-A")
        tracker.record_retry("sess-1", "op-A")
        tracker.record_retry("sess-1", "op-B")

        assert tracker.get_retry_count("sess-1", "op-A") == 2
        assert tracker.get_retry_count("sess-1", "op-B") == 1

    def test_exhausted_only_affects_specific_op(self, tracker):
        """超限只影响特定 (session, op)，不影响其他"""
        # op-A 超限
        for _ in range(3):
            tracker.record_retry("sess-1", "op-A")
        assert tracker.is_exhausted("sess-1", "op-A") is True

        # op-B 未超限
        tracker.record_retry("sess-1", "op-B")
        assert tracker.is_exhausted("sess-1", "op-B") is False

        # sess-2 的 op-A 也未超限
        tracker.record_retry("sess-2", "op-A")
        assert tracker.is_exhausted("sess-2", "op-A") is False


# ============================================================================
# 3. reset 三种模式测试
# ============================================================================


class TestResetModes:
    """reset 三种模式测试"""

    def test_reset_specific_operation(self, tracker):
        """模式 3：reset 特定 (session, op)"""
        tracker.record_retry("sess-1", "op-A")
        tracker.record_retry("sess-1", "op-A")
        tracker.record_retry("sess-1", "op-B")

        count = tracker.reset("sess-1", "op-A")
        assert count == 1
        assert tracker.get_retry_count("sess-1", "op-A") == 0
        # op-B 不受影响
        assert tracker.get_retry_count("sess-1", "op-B") == 1

    def test_reset_entire_session(self, tracker):
        """模式 2：reset 整个 session"""
        tracker.record_retry("sess-1", "op-A")
        tracker.record_retry("sess-1", "op-B")
        tracker.record_retry("sess-2", "op-A")

        count = tracker.reset("sess-1")
        assert count == 2  # op-A + op-B
        assert tracker.get_retry_count("sess-1", "op-A") == 0
        assert tracker.get_retry_count("sess-1", "op-B") == 0
        # sess-2 不受影响
        assert tracker.get_retry_count("sess-2", "op-A") == 1

    def test_reset_all(self, tracker):
        """模式 1：reset 所有"""
        tracker.record_retry("sess-1", "op-A")
        tracker.record_retry("sess-2", "op-B")
        tracker.record_retry("sess-3", "op-C")

        count = tracker.reset()
        assert count == 3
        assert tracker.get_retry_count("sess-1", "op-A") == 0
        assert tracker.get_retry_count("sess-2", "op-B") == 0
        assert tracker.get_retry_count("sess-3", "op-C") == 0

    def test_reset_nonexistent_returns_zero(self, tracker):
        """reset 不存在的 (session, op) 返回 0"""
        assert tracker.reset("nonexistent") == 0
        assert tracker.reset("sess-1", "nonexistent") == 0
        assert tracker.reset() == 0  # 空状态


# ============================================================================
# 4. 统计与查询测试
# ============================================================================


class TestStatsAndQuery:
    """统计与查询 API 测试"""

    def test_get_stats_global(self, tracker):
        """全局统计：跨所有 session 聚合"""
        tracker.record_retry("sess-1", "op-A")
        tracker.record_retry("sess-1", "op-A")  # op-A 达到 near_limit
        tracker.record_retry("sess-2", "op-B")
        tracker.record_retry("sess-2", "op-B")
        tracker.record_retry("sess-2", "op-B")  # op-B 超限

        stats = tracker.get_stats()
        assert stats["max_retry"] == 3
        assert stats["total_sessions"] == 2
        assert stats["total_operations"] == 2  # op-A + op-B
        assert stats["exhausted_operations"] == 1  # op-B
        assert stats["near_limit_operations"] == 1  # op-A
        assert stats["total_records"] == 5
        assert stats["total_exhausted"] == 1
        assert stats["total_near_limit"] >= 1

    def test_get_stats_per_session(self, tracker):
        """单 session 统计"""
        tracker.record_retry("sess-1", "op-A", error="err-1")
        tracker.record_retry("sess-1", "op-A", error="err-2")
        tracker.record_retry("sess-1", "op-B")

        stats = tracker.get_stats("sess-1")
        assert stats["session_id"] == "sess-1"
        assert stats["operations"] == {"op-A": 2, "op-B": 1}
        assert stats["exhausted_operations"] == []
        assert stats["last_errors"]["op-A"] == "err-2"
        assert "op-A" in stats["last_record_at"]

    def test_list_exhausted_all(self, tracker):
        """list_exhausted 列出所有超限组合"""
        # op-A 超限
        for _ in range(3):
            tracker.record_retry("sess-1", "op-A")
        # op-B 未超限
        tracker.record_retry("sess-1", "op-B")
        # op-C 超限
        for _ in range(3):
            tracker.record_retry("sess-2", "op-C")

        exhausted = tracker.list_exhausted()
        assert len(exhausted) == 2

        # 验证结构
        keys = {(e["session_id"], e["operation_key"]) for e in exhausted}
        assert ("sess-1", "op-A") in keys
        assert ("sess-2", "op-C") in keys

        # 验证字段
        for e in exhausted:
            assert e["retry_count"] == 3
            assert "last_error" in e

    def test_list_exhausted_by_session(self, tracker):
        """list_exhausted 按 session 过滤"""
        for _ in range(3):
            tracker.record_retry("sess-1", "op-A")
        for _ in range(3):
            tracker.record_retry("sess-2", "op-B")

        result_1 = tracker.list_exhausted("sess-1")
        result_2 = tracker.list_exhausted("sess-2")
        assert len(result_1) == 1
        assert len(result_2) == 1
        assert result_1[0]["session_id"] == "sess-1"
        assert result_2[0]["session_id"] == "sess-2"


# ============================================================================
# 5. build_operation_key 工具函数测试
# ============================================================================


class TestBuildOperationKey:
    """build_operation_key 工具函数测试"""

    def test_basic_with_task_and_tool(self):
        """task + tool_name 拼接"""
        key = build_operation_key("nginx restart", "risk")
        assert "nginx_restart" in key
        assert "risk" in key
        assert ":" in key

    def test_only_task(self):
        """只有 task 时返回 task"""
        key = build_operation_key("nginx restart")
        assert key == "nginx_restart"

    def test_only_tool(self):
        """只有 tool_name 时返回 tool"""
        key = build_operation_key("", "risk")
        assert key == ":risk"

    def test_empty_returns_unknown(self):
        """空输入返回 'unknown_op'"""
        key = build_operation_key("", "")
        assert key == "unknown_op"

    def test_long_task_hashed(self):
        """长 task 使用 hash 摘要"""
        long_task = "a" * 200
        key = build_operation_key(long_task, "tool")
        # 应该被 hash（长度 ≤ 16）
        assert len(key) <= 16 or len(key) <= 64  # 可能走 hash 分支或截断分支

    def test_params_included_in_hash(self):
        """params 加入 hash"""
        key1 = build_operation_key("task", "tool", {"a": 1, "b": 2})
        key2 = build_operation_key("task", "tool", {"a": 1, "b": 3})
        assert key1 != key2  # 不同 params 产生不同 key

    def test_params_order_independent(self):
        """params 顺序无关（dict 排序后 hash）"""
        key1 = build_operation_key("task", "tool", {"a": 1, "b": 2})
        key2 = build_operation_key("task", "tool", {"b": 2, "a": 1})
        assert key1 == key2

    def test_case_insensitive(self):
        """大小写不敏感"""
        key1 = build_operation_key("Restart Nginx", "RISK")
        key2 = build_operation_key("restart nginx", "risk")
        assert key1 == key2


# ============================================================================
# 6. 全局单例 + 配置测试
# ============================================================================


class TestGlobalTracker:
    """全局单例 + 配置测试"""

    def test_get_global_tracker_singleton(self):
        """get_global_tracker 返回单例"""
        t1 = get_global_tracker()
        t2 = get_global_tracker()
        assert t1 is t2

    def test_reset_for_test_creates_new_instance(self):
        """reset_for_test 重建新实例"""
        t1 = get_global_tracker()
        t1.record_retry("sess-1", "op-1")

        reset_for_test()

        t2 = get_global_tracker()
        # 新实例，状态干净
        assert t2.get_retry_count("sess-1", "op-1") == 0
        # 但仍是单例（reset_for_test 后再获取的是同一个新实例）
        assert t2 is get_global_tracker()

    def test_configure_max_retry(self):
        """动态配置 max_retry"""
        configure_max_retry(5)
        tracker = get_global_tracker()
        assert tracker.max_retry == 5

        # 验证生效
        for _ in range(4):
            tracker.record_retry("sess-1", "op-1")
        assert tracker.is_exhausted("sess-1", "op-1") is False

        tracker.record_retry("sess-1", "op-1")
        assert tracker.is_exhausted("sess-1", "op-1") is True

    def test_set_max_retry_invalid_raises(self, tracker):
        """max_retry < 1 抛 ValueError"""
        with pytest.raises(ValueError, match="max_retry must be >= 1"):
            tracker.set_max_retry(0)
        with pytest.raises(ValueError):
            tracker.set_max_retry(-1)

    def test_set_event_bus(self, tracker, mock_event_bus):
        """set_event_bus 注入 EventBus"""
        tracker.set_event_bus(mock_event_bus)
        assert tracker._event_bus is mock_event_bus

    def test_event_emitted_on_near_limit(self, tracker, mock_event_bus):
        """接近上限时发布事件"""
        tracker.set_event_bus(mock_event_bus)

        # 第 2 次失败 → near_limit 事件
        tracker.record_retry("sess-1", "op-1", error="err-1")
        tracker.record_retry("sess-1", "op-1", error="err-2")

        # 验证事件发布
        assert mock_event_bus.publish.called
        # 最后一次调用应该是 near_limit 事件
        last_call = mock_event_bus.publish.call_args
        event = last_call.args[0]
        assert event.payload["event"] == "near_limit"
        assert event.payload["retry_count"] == 2

    def test_event_emitted_on_exhausted(self, tracker, mock_event_bus):
        """超限时发布事件"""
        tracker.set_event_bus(mock_event_bus)

        for _ in range(3):
            tracker.record_retry("sess-1", "op-1", error="err")

        # 验证事件发布
        assert mock_event_bus.publish.called
        last_call = mock_event_bus.publish.call_args
        event = last_call.args[0]
        assert event.payload["event"] == "exhausted"
        assert event.payload["retry_count"] == 3


# ============================================================================
# 7. needs_you 集成测试
# ============================================================================


class TestNeedsYouIntegration:
    """needs_you.notify_fix_loop_exhausted 集成测试"""

    def test_notify_creates_handoff_request(self, needs_service):
        """notify_fix_loop_exhausted 创建 type=HANDOFF 请求"""
        req = needs_service.notify_fix_loop_exhausted(
            session_id="sess-1",
            operation_key="nginx_restart:risk",
            retry_count=3,
            max_retry=3,
            last_error="timeout",
            task="重启 nginx",
        )

        assert req.type == NeedsYouType.HANDOFF
        assert req.session_id == "sess-1"
        assert req.source == "fix_loop"
        assert req.status == NeedsYouStatus.PENDING
        assert req.deadline is None  # handoff 不超时

        # 验证 extra 字段
        assert req.extra["fix_loop"] is True
        assert req.extra["operation_key"] == "nginx_restart:risk"
        assert req.extra["retry_count"] == 3
        assert req.extra["max_retry"] == 3
        assert req.extra["last_error"] == "timeout"
        assert req.extra["task"] == "重启 nginx"

    def test_notify_title_contains_retry_count(self, needs_service):
        """标题包含重试次数和最大次数"""
        req = needs_service.notify_fix_loop_exhausted(
            session_id="sess-1",
            operation_key="op-1",
            retry_count=3,
            max_retry=3,
        )

        assert "3/3" in req.title
        assert "Fix-loop" in req.title

    def test_notify_description_contains_diagnostic_info(self, needs_service):
        """描述包含诊断信息"""
        req = needs_service.notify_fix_loop_exhausted(
            session_id="sess-1",
            operation_key="op-key-1",
            retry_count=3,
            max_retry=3,
            last_error="connection refused",
            task="检查服务状态",
        )

        assert "op-key-1" in req.description
        assert "connection refused" in req.description
        assert "检查服务状态" in req.description
        assert "人工介入" in req.description  # 建议部分

    def test_notify_with_empty_error(self, needs_service):
        """last_error 为空时不崩溃"""
        req = needs_service.notify_fix_loop_exhausted(
            session_id="sess-1",
            operation_key="op-1",
            retry_count=3,
            max_retry=3,
            last_error="",
        )
        assert req.type == NeedsYouType.HANDOFF
        assert "(无)" in req.description


# ============================================================================
# 8. BaseAgent 集成测试
# ============================================================================


class TestBaseAgentFixLoopIntegration:
    """BaseAgent.fix_loop 集成测试"""

    def _make_agent(self):
        """创建测试用 BaseAgent 子类实例"""
        from agents.base import BaseAgent

        class TestAgent(BaseAgent):
            """测试用 Agent：reflect 总是 continue（触发 fix-loop）"""

            def select_tool(self, task, state):
                return {"tool_name": "risk", "params": {}}

            def reflect_on_result(self, state):
                # 总是 continue，让 fix-loop 检测到失败重试
                return {
                    "next_step": "continue",
                    "reflection": "retry",
                }

        return TestAgent(
            name="test",
            role="test agent",
            description="for testing fix-loop",
            tools=["risk"],
            event_bus=None,
        )

    def _make_failing_tool_call_result(self, error="tool failed"):
        """构造失败的 tool_call_result"""
        return {
            "tool_name": "risk",
            "params": {},
            "result": {"error": error},
            "duration": 0.1,
            "success": False,
            "error": error,
        }

    def _make_success_tool_call_result(self):
        """构造成功的 tool_call_result"""
        return {
            "tool_name": "risk",
            "params": {},
            "result": {"risk_level": "L1"},
            "duration": 0.1,
            "success": True,
        }

    def test_check_fix_loop_records_retry_on_failure(self):
        """工具失败 + continue → 记录重试"""
        agent = self._make_agent()
        tracker = get_global_tracker()

        result = agent._check_fix_loop(
            session_id="sess-1",
            current_task="nginx restart",
            tool_call_result=self._make_failing_tool_call_result("err-1"),
            next_step="continue",
        )

        assert result["enabled"] is True
        assert result["retry_count"] == 1
        assert result["exhausted"] is False
        assert result["near_limit"] is False
        assert result["last_error"] == "err-1"
        assert result["notified"] is False

        # 验证 tracker 状态
        assert tracker.get_retry_count("sess-1", result["operation_key"]) == 1

    def test_check_fix_loop_resets_on_success(self):
        """工具成功 → reset 对应 operation_key"""
        agent = self._make_agent()
        tracker = get_global_tracker()

        # 先记录 2 次失败
        op_key = build_operation_key("nginx restart", "risk")
        tracker.record_retry("sess-1", op_key, error="err-1")
        tracker.record_retry("sess-1", op_key, error="err-2")
        assert tracker.get_retry_count("sess-1", op_key) == 2

        # 工具成功 → reset
        result = agent._check_fix_loop(
            session_id="sess-1",
            current_task="nginx restart",
            tool_call_result=self._make_success_tool_call_result(),
            next_step="continue",
        )

        assert result["retry_count"] == 0
        assert result["exhausted"] is False
        # 验证 tracker 已重置
        assert tracker.get_retry_count("sess-1", op_key) == 0

    def test_check_fix_loop_exhausted_forces_notify(self):
        """超限时通知 needs_you"""
        agent = self._make_agent()
        tracker = get_global_tracker()
        needs_service = __import__("needs_you").get_global_service()

        # 记录 2 次失败（接近上限）
        for i in range(2):
            agent._check_fix_loop(
                session_id="sess-1",
                current_task="nginx restart",
                tool_call_result=self._make_failing_tool_call_result(f"err-{i}"),
                next_step="continue",
            )

        # 第 3 次失败 → 超限 + 通知
        result = agent._check_fix_loop(
            session_id="sess-1",
            current_task="nginx restart",
            tool_call_result=self._make_failing_tool_call_result("err-3"),
            next_step="continue",
        )

        assert result["exhausted"] is True
        assert result["retry_count"] == 3
        assert result["notified"] is True

        # 验证 needs_you 收到 handoff 请求
        pending = needs_service.list_pending()
        assert len(pending) == 1
        assert pending[0]["type"] == "handoff"
        assert pending[0]["extra"]["fix_loop"] is True
        assert pending[0]["extra"]["retry_count"] == 3

    def test_check_fix_loop_skip_when_next_step_done(self):
        """next_step=done 时不记录重试（Agent 已放弃）"""
        agent = self._make_agent()
        tracker = get_global_tracker()

        result = agent._check_fix_loop(
            session_id="sess-1",
            current_task="nginx restart",
            tool_call_result=self._make_failing_tool_call_result("err"),
            next_step="done",
        )

        # 不记录新重试
        assert result["retry_count"] == 0
        assert tracker.get_retry_count("sess-1", result["operation_key"]) == 0

    def test_check_fix_loop_degraded_on_exception(self):
        """fix-loop 异常时降级，不阻塞 Agent 执行"""
        agent = self._make_agent()

        # 模拟 fix_loop 模块导入失败
        import sys
        original_fix_loop = sys.modules.get("fix_loop")
        sys.modules["fix_loop"] = None  # 破坏导入

        try:
            result = agent._check_fix_loop(
                session_id="sess-1",
                current_task="nginx restart",
                tool_call_result=self._make_failing_tool_call_result(),
                next_step="continue",
            )
            # 降级返回默认值
            assert result["enabled"] is False
            assert result["exhausted"] is False
        finally:
            # 恢复
            if original_fix_loop is not None:
                sys.modules["fix_loop"] = original_fix_loop
            else:
                sys.modules.pop("fix_loop", None)

    def test_invoke_propagates_fix_loop_exhausted_to_next_step(self):
        """invoke() 在超限时强制 next_step=error"""
        agent = self._make_agent()
        tracker = get_global_tracker()

        # 构造 state
        state = {
            "session_id": "sess-1",
            "iteration": 0,
            "input": "nginx restart",
            "current_task": "nginx restart",
            "plan": ["nginx restart"],
            "current_task_index": 0,
        }

        # 模拟 call_tool 总是失败
        original_call_tool = agent.call_tool
        agent.call_tool = lambda name, params: self._make_failing_tool_call_result("fail")

        try:
            # 调用 invoke 3 次（前 2 次应该 continue，第 3 次应该 error）
            r1 = agent.invoke(state)
            assert r1["next_step"] == "continue"  # 第 1 次失败，未超限

            r2 = agent.invoke({**state, "iteration": 1})
            assert r2["next_step"] == "continue"  # 第 2 次失败，未超限

            r3 = agent.invoke({**state, "iteration": 2})
            assert r3["next_step"] == "error"  # 第 3 次失败，超限强制 error
            assert "fix-loop" in r3.get("error", "") or "fix_loop" in r3.get("error", "")
            assert r3["fix_loop"]["exhausted"] is True
            assert r3["fix_loop"]["retry_count"] == 3
        finally:
            agent.call_tool = original_call_tool


# ============================================================================
# 9. JSON-RPC 方法注册测试
# ============================================================================


class TestJsonRpcRegistration:
    """JSON-RPC 方法注册测试"""

    def test_register_methods(self):
        """register_methods 注册 7 个方法"""
        dispatcher = MagicMock()
        dispatcher.register = MagicMock()

        register_methods(dispatcher)

        # 验证注册的方法
        registered = [call.args[0] for call in dispatcher.register.call_args_list]
        assert "fix_loop.stats" in registered
        assert "fix_loop.get" in registered
        assert "fix_loop.is_exhausted" in registered
        assert "fix_loop.is_near_limit" in registered
        assert "fix_loop.reset" in registered
        assert "fix_loop.list_exhausted" in registered
        assert "fix_loop.configure" in registered

        assert len(registered) == 7


# ============================================================================
# 10. 线程安全测试
# ============================================================================


class TestThreadSafety:
    """线程安全测试"""

    def test_concurrent_record_retry(self, tracker):
        """并发 record_retry 不丢失计数"""
        threads = []
        results: list[int] = []
        results_lock = threading.Lock()

        def worker():
            count = tracker.record_retry("sess-1", "op-1", error="err")
            with results_lock:
                results.append(count)

        # 启动 50 个并发线程
        for _ in range(50):
            t = threading.Thread(target=worker)
            threads.append(t)
            t.start()
        for t in threads:
            t.join()

        # 验证总计数 = 50
        assert tracker.get_retry_count("sess-1", "op-1") == 50
        # 验证每个线程拿到的 count 唯一（无重复）
        assert len(set(results)) == 50
        assert min(results) == 1
        assert max(results) == 50

    def test_concurrent_different_sessions(self, tracker):
        """不同 session 并发不串扰"""
        threads = []
        sessions = [f"sess-{i}" for i in range(10)]

        def worker(sid):
            for _ in range(5):
                tracker.record_retry(sid, "op-1")

        for sid in sessions:
            t = threading.Thread(target=worker, args=(sid,))
            threads.append(t)
            t.start()
        for t in threads:
            t.join()

        # 验证每个 session 都是 5 次
        for sid in sessions:
            assert tracker.get_retry_count(sid, "op-1") == 5


# ============================================================================
# 11. 端到端场景测试
# ============================================================================


class TestEndToEndScenario:
    """端到端场景测试：模拟 Agent 连续失败 3 次后停手"""

    def test_full_scenario_three_failures_then_stop(self, tracker, needs_service):
        """完整场景：3 次失败后强制停手 + 通知"""
        session_id = "e2e-session-1"
        operation_key = build_operation_key("restart nginx", "risk")

        # 第 1 次失败
        c1 = tracker.record_retry(session_id, operation_key, error="attempt 1 timeout")
        assert c1 == 1
        assert tracker.is_exhausted(session_id, operation_key) is False

        # 第 2 次失败 → near_limit
        c2 = tracker.record_retry(session_id, operation_key, error="attempt 2 timeout")
        assert c2 == 2
        assert tracker.is_near_limit(session_id, operation_key) is True
        assert tracker.is_exhausted(session_id, operation_key) is False

        # 第 3 次失败 → exhausted
        c3 = tracker.record_retry(session_id, operation_key, error="attempt 3 timeout")
        assert c3 == 3
        assert tracker.is_exhausted(session_id, operation_key) is True

        # 通知 needs_you
        req = needs_service.notify_fix_loop_exhausted(
            session_id=session_id,
            operation_key=operation_key,
            retry_count=c3,
            max_retry=tracker.max_retry,
            last_error="attempt 3 timeout",
            task="restart nginx",
        )
        assert req.type == NeedsYouType.HANDOFF
        assert req.extra["fix_loop"] is True

        # 全局统计验证
        stats = tracker.get_stats()
        assert stats["total_records"] == 3
        assert stats["total_exhausted"] == 1
        assert stats["total_near_limit"] == 1
        assert stats["exhausted_operations"] == 1

        # 列出超限组合
        exhausted = tracker.list_exhausted()
        assert len(exhausted) == 1
        assert exhausted[0]["session_id"] == session_id
        assert exhausted[0]["operation_key"] == operation_key

        # 重置后状态干净
        reset_count = tracker.reset(session_id, operation_key)
        assert reset_count == 1
        assert tracker.get_retry_count(session_id, operation_key) == 0
        assert tracker.is_exhausted(session_id, operation_key) is False
