"""
tests/test_needs_you.py — needs-you 协调服务单元测试（T-P1-10.4）
================================================================

验证内容：
1. 枚举与数据结构（NeedsYouType / NeedsYouStatus / NeedsYouPriority / NeedsYouRequest）
2. 4 类型创建（approval / error / question / handoff）
3. 优先级排序（spec 要求 error > approval > question > handoff）
4. approval 30s 超时自动拒绝
5. 其他类型不自动超时
6. 用户响应（respond / approve / reject 便捷方法）
7. Agent 主动取消（cancel）
8. 清除已解决请求（clear_resolved）
9. 查询 API（list_pending / list_all / get / stats）
10. event_bus 集成（事件发布）
11. 线程安全（并发请求）
12. JSON-RPC 方法注册（15 个方法）
13. 边界情况（无效类型 / 不存在 req_id / 重复响应 / 重复取消 等）
14. 统计信息（by_type / by_status / total_*）
15. 全局单例（get_global_service / set_event_bus / start/stop_global_service）

运行：
    cd python-sidecar
    python -m pytest tests/test_needs_you.py -v
"""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock

# 确保能 import needs_you
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from needs_you import (
    NeedsYouPriority,
    NeedsYouRequest,
    NeedsYouService,
    NeedsYouStatus,
    NeedsYouType,
    _PRIORITY_ORDER,
    _TYPE_TO_PRIORITY,
    get_global_service,
    register_methods,
    reset_for_test,
    set_event_bus,
    start_global_service,
    stop_global_service,
)


# ============================================================================
# Fixtures
# ============================================================================


@pytest.fixture(autouse=True)
def reset_state():
    """每个测试前后重置全局 service，保证测试隔离"""
    reset_for_test()
    yield
    reset_for_test()


@pytest.fixture
def service():
    """提供独立的 NeedsYouService 实例（不启动超时线程，便于确定性测试）"""
    return NeedsYouService(
        approval_timeout=30.0,
        timeout_check_interval=0.1,
        event_bus=None,  # 测试模式：不发布事件
    )


@pytest.fixture
def fast_service():
    """提供快速超时的 service（approval_timeout=0.5s）"""
    return NeedsYouService(
        approval_timeout=0.5,
        timeout_check_interval=0.05,
        event_bus=None,
    )


@pytest.fixture
def mock_event_bus():
    """提供 mock EventBus，记录所有 emit_needs_you 调用"""
    bus = MagicMock()
    bus.emit_needs_you = MagicMock()
    return bus


# ============================================================================
# 1. 枚举测试
# ============================================================================


class TestNeedsYouType:
    """NeedsYouType 枚举测试"""

    def test_four_types_defined(self):
        """spec 要求 4 类型：approval / error / question / handoff"""
        assert NeedsYouType.APPROVAL.value == "approval"
        assert NeedsYouType.ERROR.value == "error"
        assert NeedsYouType.QUESTION.value == "question"
        assert NeedsYouType.HANDOFF.value == "handoff"

    def test_total_count(self):
        """恰好 4 个枚举值"""
        assert len(list(NeedsYouType)) == 4

    def test_str_enum_serializable(self):
        """str Enum 便于 JSON 序列化（与字符串值相等即可）"""
        # str Enum 关键特性：枚举值与字符串值 == 比较
        assert NeedsYouType.APPROVAL == "approval"
        assert NeedsYouType.ERROR == "error"
        # .value 始终是字符串
        assert NeedsYouType.APPROVAL.value == "approval"
        # JSON 序列化通过 .value 即可
        import json
        assert json.dumps(NeedsYouType.APPROVAL.value) == '"approval"'


class TestNeedsYouStatus:
    """NeedsYouStatus 枚举测试"""

    def test_six_statuses_defined(self):
        """6 个状态：pending / approved / rejected / resolved / timeout / cancelled"""
        assert NeedsYouStatus.PENDING.value == "pending"
        assert NeedsYouStatus.APPROVED.value == "approved"
        assert NeedsYouStatus.REJECTED.value == "rejected"
        assert NeedsYouStatus.RESOLVED.value == "resolved"
        assert NeedsYouStatus.TIMEOUT.value == "timeout"
        assert NeedsYouStatus.CANCELLED.value == "cancelled"

    def test_total_count(self):
        assert len(list(NeedsYouStatus)) == 6


class TestNeedsYouPriority:
    """NeedsYouPriority 枚举测试"""

    def test_four_priorities_defined(self):
        """4 优先级：critical / high / normal / low"""
        assert NeedsYouPriority.CRITICAL.value == "critical"
        assert NeedsYouPriority.HIGH.value == "high"
        assert NeedsYouPriority.NORMAL.value == "normal"
        assert NeedsYouPriority.LOW.value == "low"

    def test_priority_order_ascending(self):
        """spec 要求：error > approval > question > handoff
        数值越小优先级越高"""
        assert _PRIORITY_ORDER[NeedsYouPriority.CRITICAL] == 0  # error
        assert _PRIORITY_ORDER[NeedsYouPriority.HIGH] == 1      # approval
        assert _PRIORITY_ORDER[NeedsYouPriority.NORMAL] == 2    # question
        assert _PRIORITY_ORDER[NeedsYouPriority.LOW] == 3       # handoff

    def test_type_to_priority_mapping(self):
        """类型 → 优先级映射与 spec 一致"""
        assert _TYPE_TO_PRIORITY[NeedsYouType.ERROR] == NeedsYouPriority.CRITICAL
        assert _TYPE_TO_PRIORITY[NeedsYouType.APPROVAL] == NeedsYouPriority.HIGH
        assert _TYPE_TO_PRIORITY[NeedsYouType.QUESTION] == NeedsYouPriority.NORMAL
        assert _TYPE_TO_PRIORITY[NeedsYouType.HANDOFF] == NeedsYouPriority.LOW


# ============================================================================
# 2. NeedsYouRequest 数据结构测试
# ============================================================================


class TestNeedsYouRequest:
    """NeedsYouRequest dataclass 测试"""

    def test_default_values(self):
        """默认值：status=PENDING, response=None, deadline=None"""
        req = NeedsYouRequest(
            id="test-001",
            type=NeedsYouType.APPROVAL,
            title="测试",
            description="",
            priority=NeedsYouPriority.HIGH,
        )
        assert req.status == NeedsYouStatus.PENDING
        assert req.response is None
        assert req.deadline is None
        assert req.responded_at is None
        assert req.responded_by is None
        assert req.extra == {}

    def test_to_dict_serializable(self):
        """to_dict 包含所有字段，便于 JSON 序列化"""
        req = NeedsYouRequest(
            id="test-002",
            type=NeedsYouType.ERROR,
            title="出错了",
            description="详细描述",
            priority=NeedsYouPriority.CRITICAL,
            session_id="sess-1",
            source="test",
            extra={"command": "rm -rf /"},
        )
        d = req.to_dict()
        assert d["id"] == "test-002"
        assert d["type"] == "error"
        assert d["title"] == "出错了"
        assert d["priority"] == "critical"
        assert d["session_id"] == "sess-1"
        assert d["status"] == "pending"
        assert d["extra"] == {"command": "rm -rf /"}

    def test_is_pending_property(self):
        """is_pending 属性"""
        req = NeedsYouRequest(
            id="test-003", type=NeedsYouType.APPROVAL,
            title="t", description="d", priority=NeedsYouPriority.HIGH,
        )
        assert req.is_pending is True
        req.status = NeedsYouStatus.APPROVED
        assert req.is_pending is False

    def test_is_resolved_property(self):
        """is_resolved 属性：非 PENDING 都视为已解决"""
        req = NeedsYouRequest(
            id="test-004", type=NeedsYouType.APPROVAL,
            title="t", description="d", priority=NeedsYouPriority.HIGH,
        )
        assert req.is_resolved is False
        for status in [
            NeedsYouStatus.APPROVED,
            NeedsYouStatus.REJECTED,
            NeedsYouStatus.RESOLVED,
            NeedsYouStatus.TIMEOUT,
            NeedsYouStatus.CANCELLED,
        ]:
            req.status = status
            assert req.is_resolved is True


# ============================================================================
# 3. 4 类型创建测试
# ============================================================================


class TestCreateRequests:
    """4 类型创建测试"""

    def test_create_approval(self, service):
        """approval 创建：30s deadline 设置"""
        req = service.request_approval(
            title="重启 nginx",
            description="L3 风险，需审批",
            session_id="sess-1",
            source="permission_check",
            command="sudo systemctl restart nginx",
            risk_level="L3",
        )
        assert req.id.startswith("ny-")
        assert req.type == NeedsYouType.APPROVAL
        assert req.priority == NeedsYouPriority.HIGH
        assert req.session_id == "sess-1"
        assert req.source == "permission_check"
        assert req.deadline is not None
        assert req.deadline > time.time()
        assert req.deadline <= time.time() + 31  # 30s + 容差
        assert req.status == NeedsYouStatus.PENDING
        assert req.extra["command"] == "sudo systemctl restart nginx"
        assert req.extra["risk_level"] == "L3"

    def test_create_error(self, service):
        """error 创建：无 deadline，priority=CRITICAL"""
        req = service.request_error(
            title="无法恢复错误",
            description="配置文件损坏",
            source="main_agent",
        )
        assert req.type == NeedsYouType.ERROR
        assert req.priority == NeedsYouPriority.CRITICAL
        assert req.deadline is None  # error 不超时
        assert req.status == NeedsYouStatus.PENDING

    def test_create_question(self, service):
        """question 创建：无 deadline，priority=NORMAL"""
        req = service.request_question(
            title="请选择方案",
            description="A 或 B？",
            options=["A", "B"],
        )
        assert req.type == NeedsYouType.QUESTION
        assert req.priority == NeedsYouPriority.NORMAL
        assert req.deadline is None
        assert req.extra["options"] == ["A", "B"]

    def test_create_handoff(self, service):
        """handoff 创建：无 deadline，priority=LOW"""
        req = service.request_handoff(
            title="请求接管",
            description="超出能力边界",
        )
        assert req.type == NeedsYouType.HANDOFF
        assert req.priority == NeedsYouPriority.LOW
        assert req.deadline is None

    def test_custom_timeout_for_approval(self, service):
        """approval 支持自定义 timeout"""
        req = service.request_approval(
            title="快速审批",
            description="5s 超时",
            timeout=5.0,
        )
        assert req.deadline is not None
        assert req.deadline <= time.time() + 6

    def test_id_uniqueness(self, service):
        """多次创建 ID 唯一"""
        ids = set()
        for _ in range(50):
            req = service.request_approval(title="t", description="d")
            ids.add(req.id)
        assert len(ids) == 50

    def test_created_at_timestamp(self, service):
        """created_at 接近当前时间"""
        before = time.time()
        req = service.request_approval(title="t", description="d")
        after = time.time()
        assert before <= req.created_at <= after


# ============================================================================
# 4. 优先级排序测试（spec 核心要求）
# ============================================================================


class TestPriorityOrdering:
    """优先级排序测试

    spec 要求：error > approval > question > handoff
    """

    def test_priority_order_in_list_pending(self, service):
        """list_pending 按优先级排序"""
        # 故意按"反"序创建（handoff 先，error 后）
        r1 = service.request_handoff(title="h1", description="d")
        time.sleep(0.01)
        r2 = service.request_question(title="q1", description="d")
        time.sleep(0.01)
        r3 = service.request_approval(title="a1", description="d")
        time.sleep(0.01)
        r4 = service.request_error(title="e1", description="d")

        pending = service.list_pending()
        # 排序：error → approval → question → handoff
        assert pending[0]["id"] == r4.id  # error (CRITICAL)
        assert pending[1]["id"] == r3.id  # approval (HIGH)
        assert pending[2]["id"] == r2.id  # question (NORMAL)
        assert pending[3]["id"] == r1.id  # handoff (LOW)

    def test_fifo_within_same_priority(self, service):
        """同优先级按 created_at 升序（FIFO）"""
        r1 = service.request_approval(title="a1", description="d")
        time.sleep(0.05)
        r2 = service.request_approval(title="a2", description="d")
        time.sleep(0.05)
        r3 = service.request_approval(title="a3", description="d")

        pending = service.list_pending()
        approval_ids = [p["id"] for p in pending if p["type"] == "approval"]
        assert approval_ids == [r1.id, r2.id, r3.id]

    def test_filter_by_session_id(self, service):
        """list_pending 支持按 session_id 过滤"""
        service.request_approval(title="a1", description="d", session_id="sess-A")
        service.request_error(title="e1", description="d", session_id="sess-B")
        service.request_question(title="q1", description="d", session_id="sess-A")

        result_a = service.list_pending(session_id="sess-A")
        result_b = service.list_pending(session_id="sess-B")
        assert len(result_a) == 2
        assert len(result_b) == 1
        assert result_b[0]["type"] == "error"

    def test_filter_by_type(self, service):
        """list_pending 支持按 type 过滤"""
        service.request_approval(title="a1", description="d")
        service.request_error(title="e1", description="d")
        service.request_question(title="q1", description="d")

        approvals = service.list_pending(needs_type="approval")
        errors = service.list_pending(needs_type="error")
        assert len(approvals) == 1
        assert len(errors) == 1
        assert approvals[0]["type"] == "approval"
        assert errors[0]["type"] == "error"

    def test_resolved_excluded_from_pending(self, service):
        """已解决请求不出现在 pending 列表"""
        r1 = service.request_approval(title="a1", description="d")
        service.request_error(title="e1", description="d")

        # 响应 r1
        service.approve(r1.id)

        pending = service.list_pending()
        assert len(pending) == 1
        assert pending[0]["type"] == "error"


# ============================================================================
# 5. approval 超时测试
# ============================================================================


class TestApprovalTimeout:
    """approval 超时自动拒绝测试"""

    def test_approval_timeout_marks_as_timeout(self, fast_service):
        """approval 超时后状态变为 TIMEOUT"""
        fast_service.start()
        try:
            req = fast_service.request_approval(title="a", description="d")
            # 等待超时（0.5s 超时 + 0.1s 扫描间隔 + 容差）
            time.sleep(1.0)
            assert req.status == NeedsYouStatus.TIMEOUT
            assert req.responded_by == "system_timeout"
            assert req.response is not None
            assert req.response["timeout"] is True
        finally:
            fast_service.stop()

    def test_approval_timeout_updates_stats(self, fast_service):
        """超时后统计信息更新"""
        fast_service.start()
        try:
            fast_service.request_approval(title="a", description="d")
            time.sleep(1.0)
            stats = fast_service.get_stats()
            assert stats["total_timeout"] == 1
            assert stats["by_status"]["timeout"] == 1
            assert stats["by_status"]["pending"] == 0
        finally:
            fast_service.stop()

    def test_approval_not_timeout_before_deadline(self, fast_service):
        """deadline 之前不超时"""
        fast_service.start()
        try:
            req = fast_service.request_approval(title="a", description="d")
            time.sleep(0.2)  # 远小于 0.5s 超时
            assert req.status == NeedsYouStatus.PENDING
        finally:
            fast_service.stop()

    def test_approval_timeout_excluded_from_pending(self, fast_service):
        """超时后从 pending 列表移除"""
        fast_service.start()
        try:
            fast_service.request_approval(title="a", description="d")
            time.sleep(1.0)
            pending = fast_service.list_pending()
            assert len(pending) == 0
        finally:
            fast_service.stop()

    def test_user_respond_before_timeout_wins(self, fast_service):
        """用户在超时前响应，避免超时"""
        fast_service.start()
        try:
            req = fast_service.request_approval(title="a", description="d")
            # 立即响应（在 0.5s 超时之前）
            fast_service.approve(req.id)
            time.sleep(1.0)  # 等待足够时间让扫描线程跑
            # 状态应是 APPROVED，不是 TIMEOUT
            assert req.status == NeedsYouStatus.APPROVED
        finally:
            fast_service.stop()


# ============================================================================
# 6. 非 approval 类型不超时
# ============================================================================


class TestNoTimeoutForNonApproval:
    """error / question / handoff 不应自动超时"""

    def test_error_not_timeout(self, fast_service):
        fast_service.start()
        try:
            req = fast_service.request_error(title="e", description="d")
            time.sleep(1.0)  # 远超 0.5s
            assert req.status == NeedsYouStatus.PENDING
        finally:
            fast_service.stop()

    def test_question_not_timeout(self, fast_service):
        fast_service.start()
        try:
            req = fast_service.request_question(title="q", description="d")
            time.sleep(1.0)
            assert req.status == NeedsYouStatus.PENDING
        finally:
            fast_service.stop()

    def test_handoff_not_timeout(self, fast_service):
        fast_service.start()
        try:
            req = fast_service.request_handoff(title="h", description="d")
            time.sleep(1.0)
            assert req.status == NeedsYouStatus.PENDING
        finally:
            fast_service.stop()


# ============================================================================
# 7. 用户响应测试
# ============================================================================


class TestRespond:
    """respond 函数测试"""

    def test_respond_approval_approved(self, service):
        """approval + response.approved=True → APPROVED"""
        req = service.request_approval(title="a", description="d")
        result = service.respond(req.id, response={"approved": True, "comment": "ok"})
        assert result is not None
        assert result.status == NeedsYouStatus.APPROVED
        assert result.response == {"approved": True, "comment": "ok"}
        assert result.responded_by == "user"
        assert result.responded_at is not None

    def test_respond_approval_rejected(self, service):
        """approval + response.approved=False → REJECTED"""
        req = service.request_approval(title="a", description="d")
        result = service.respond(req.id, response={"approved": False, "reason": "no"})
        assert result.status == NeedsYouStatus.REJECTED

    def test_respond_approval_bool_response(self, service):
        """approval + bool response → 推断 approved"""
        req = service.request_approval(title="a", description="d")
        result = service.respond(req.id, response=True)
        assert result.status == NeedsYouStatus.APPROVED

        req2 = service.request_approval(title="a2", description="d")
        result2 = service.respond(req2.id, response=False)
        assert result2.status == NeedsYouStatus.REJECTED

    def test_respond_error_to_resolved(self, service):
        """error → RESOLVED"""
        req = service.request_error(title="e", description="d")
        result = service.respond(req.id, response="已处理")
        assert result.status == NeedsYouStatus.RESOLVED

    def test_respond_question_to_resolved(self, service):
        """question → RESOLVED"""
        req = service.request_question(title="q", description="d")
        result = service.respond(req.id, response={"answer": "选 A"})
        assert result.status == NeedsYouStatus.RESOLVED

    def test_respond_handoff_to_resolved(self, service):
        """handoff → RESOLVED"""
        req = service.request_handoff(title="h", description="d")
        result = service.respond(req.id, response="已接管")
        assert result.status == NeedsYouStatus.RESOLVED

    def test_respond_nonexistent_id(self, service):
        """不存在的 req_id 返回 None"""
        result = service.respond("nonexistent-id", response={"approved": True})
        assert result is None

    def test_respond_already_resolved(self, service):
        """已解决的请求再次响应：返回 None，状态不变"""
        req = service.request_approval(title="a", description="d")
        service.approve(req.id)
        # 再次响应
        result = service.reject(req.id, reason="change mind")
        assert result is None
        # 状态保持 APPROVED
        stored = service.get(req.id)
        assert stored["status"] == "approved"

    def test_responded_by_custom(self, service):
        """支持自定义 responded_by"""
        req = service.request_approval(title="a", description="d")
        service.respond(req.id, response={"approved": True}, responded_by="admin")
        assert req.responded_by == "admin"


# ============================================================================
# 8. 便捷方法 approve / reject 测试
# ============================================================================


class TestConvenienceMethods:
    """approve / reject 便捷方法测试"""

    def test_approve_method(self, service):
        req = service.request_approval(title="a", description="d")
        result = service.approve(req.id, comment="looks good")
        assert result.status == NeedsYouStatus.APPROVED
        assert result.response["approved"] is True
        assert result.response["comment"] == "looks good"

    def test_reject_method(self, service):
        req = service.request_approval(title="a", description="d")
        result = service.reject(req.id, reason="too risky")
        assert result.status == NeedsYouStatus.REJECTED
        assert result.response["approved"] is False
        assert result.response["reason"] == "too risky"

    def test_approve_nonexistent(self, service):
        """approve 不存在的 ID 返回 None"""
        assert service.approve("nonexistent") is None

    def test_reject_nonexistent(self, service):
        assert service.reject("nonexistent") is None


# ============================================================================
# 9. 取消请求测试
# ============================================================================


class TestCancel:
    """cancel 函数测试"""

    def test_cancel_pending_request(self, service):
        req = service.request_approval(title="a", description="d")
        result = service.cancel(req.id, reason="no longer needed")
        assert result.status == NeedsYouStatus.CANCELLED
        assert result.responded_by == "agent_cancel"
        assert result.response["cancelled_reason"] == "no longer needed"

    def test_cancel_nonexistent(self, service):
        assert service.cancel("nonexistent") is None

    def test_cancel_already_resolved(self, service):
        """已解决的请求不能取消"""
        req = service.request_approval(title="a", description="d")
        service.approve(req.id)
        result = service.cancel(req.id, reason="change mind")
        assert result is None

    def test_cancel_excludes_from_pending(self, service):
        """取消后从 pending 列表移除"""
        req = service.request_approval(title="a", description="d")
        service.cancel(req.id)
        pending = service.list_pending()
        assert len(pending) == 0

    def test_cancel_updates_stats(self, service):
        service.request_approval(title="a", description="d")
        service.cancel("ny-nonexistent")  # 不影响统计
        req = service.request_error(title="e", description="d")
        service.cancel(req.id)
        stats = service.get_stats()
        assert stats["total_cancelled"] == 1


# ============================================================================
# 10. clear_resolved 测试
# ============================================================================


class TestClearResolved:
    """clear_resolved 测试"""

    def test_clear_removes_resolved_only(self, service):
        """仅清除已解决请求，pending 保留"""
        r1 = service.request_approval(title="a1", description="d")
        r2 = service.request_error(title="e1", description="d")
        service.approve(r1.id)  # r1 变 approved

        cleared = service.clear_resolved()
        assert cleared == 1

        # r2 应仍存在
        assert service.get(r2.id) is not None
        # r1 已被清除
        assert service.get(r1.id) is None

    def test_clear_returns_zero_when_no_resolved(self, service):
        """无已解决时返回 0"""
        service.request_approval(title="a", description="d")
        assert service.clear_resolved() == 0

    def test_clear_all_statuses(self, service):
        """测试所有已解决状态都被清除"""
        r1 = service.request_approval(title="a1", description="d")
        r2 = service.request_approval(title="a2", description="d")
        r3 = service.request_error(title="e1", description="d")
        r4 = service.request_question(title="q1", description="d")
        r5 = service.request_handoff(title="h1", description="d")

        service.approve(r1.id)       # approved
        service.reject(r2.id)        # rejected
        service.respond(r3.id, response="ok")  # resolved
        service.cancel(r4.id)        # cancelled
        # r5 保持 pending

        cleared = service.clear_resolved()
        assert cleared == 4  # r1-r4
        # r5 保留
        assert service.get(r5.id) is not None


# ============================================================================
# 11. 查询 API 测试
# ============================================================================


class TestQueryAPI:
    """list_pending / list_all / get / stats 测试"""

    def test_get_existing(self, service):
        req = service.request_approval(title="a", description="d", session_id="s1")
        result = service.get(req.id)
        assert result is not None
        assert result["id"] == req.id
        assert result["type"] == "approval"

    def test_get_nonexistent(self, service):
        assert service.get("nonexistent") is None

    def test_list_all_includes_resolved(self, service):
        """list_all 包含已解决请求"""
        r1 = service.request_approval(title="a1", description="d")
        r2 = service.request_error(title="e1", description="d")
        service.approve(r1.id)

        all_reqs = service.list_all()
        assert len(all_reqs) == 2

        # 倒序（最近创建在前）
        assert all_reqs[0]["id"] == r2.id
        assert all_reqs[1]["id"] == r1.id

    def test_list_all_with_filters(self, service):
        """list_all 支持过滤"""
        service.request_approval(title="a1", description="d", session_id="s1")
        service.request_error(title="e1", description="d", session_id="s2")
        service.request_question(title="q1", description="d", session_id="s1")

        # 按 session 过滤
        s1_only = service.list_all(session_id="s1")
        assert len(s1_only) == 2

        # 按 type 过滤
        approvals = service.list_all(needs_type="approval")
        assert len(approvals) == 1
        assert approvals[0]["type"] == "approval"

        # 按 status 过滤
        r1 = service.list_all(needs_type="approval")[0]
        service.approve(r1["id"])
        approved = service.list_all(status="approved")
        assert len(approved) == 1

    def test_list_all_limit(self, service):
        """list_all 支持 limit"""
        for i in range(10):
            service.request_approval(title=f"a{i}", description="d")
        result = service.list_all(limit=5)
        assert len(result) == 5

    def test_stats_initial(self, service):
        """初始统计"""
        stats = service.get_stats()
        assert stats["total_created"] == 0
        assert stats["total_responded"] == 0
        assert stats["total_timeout"] == 0
        assert stats["total_cancelled"] == 0
        assert stats["current_pending"] == 0
        assert stats["current_total"] == 0

    def test_stats_after_operations(self, service):
        """操作后统计正确"""
        r1 = service.request_approval(title="a1", description="d")
        r2 = service.request_error(title="e1", description="d")
        r3 = service.request_question(title="q1", description="d")

        service.approve(r1.id)
        service.cancel(r3.id)

        stats = service.get_stats()
        assert stats["total_created"] == 3
        assert stats["total_responded"] == 1
        assert stats["total_cancelled"] == 1
        assert stats["current_pending"] == 1  # r2 (error) 仍 pending
        assert stats["current_total"] == 3
        assert stats["by_type"]["approval"] == 1
        assert stats["by_type"]["error"] == 1
        assert stats["by_type"]["question"] == 1
        assert stats["by_status"]["approved"] == 1
        assert stats["by_status"]["cancelled"] == 1
        assert stats["by_status"]["pending"] == 1


# ============================================================================
# 12. event_bus 集成测试
# ============================================================================


class TestEventBusIntegration:
    """event_bus 集成测试"""

    def test_create_publishes_event(self, mock_event_bus):
        """创建请求时发布 created 事件"""
        service = NeedsYouService(event_bus=mock_event_bus)
        req = service.request_approval(title="a", description="d", session_id="s1")
        # mock_event_bus.emit_needs_you 应被调用
        mock_event_bus.emit_needs_you.assert_called_once()
        call_kwargs = mock_event_bus.emit_needs_you.call_args.kwargs
        assert call_kwargs["needs_type"] == "approval"
        assert call_kwargs["title"] == "a"
        assert call_kwargs["session_id"] == "s1"
        assert call_kwargs["priority"] == "high"
        assert call_kwargs["event"] == "created"
        assert call_kwargs["request"]["id"] == req.id

    def test_respond_publishes_event(self, mock_event_bus):
        """响应请求时发布 responded 事件"""
        service = NeedsYouService(event_bus=mock_event_bus)
        req = service.request_approval(title="a", description="d")
        mock_event_bus.emit_needs_you.reset_mock()
        service.approve(req.id)
        mock_event_bus.emit_needs_you.assert_called_once()
        call_kwargs = mock_event_bus.emit_needs_you.call_args.kwargs
        assert call_kwargs["event"] == "responded"
        assert call_kwargs["request"]["status"] == "approved"

    def test_cancel_publishes_event(self, mock_event_bus):
        """取消请求时发布 cancelled 事件"""
        service = NeedsYouService(event_bus=mock_event_bus)
        req = service.request_approval(title="a", description="d")
        mock_event_bus.emit_needs_you.reset_mock()
        service.cancel(req.id, reason="test")
        mock_event_bus.emit_needs_you.assert_called_once()
        call_kwargs = mock_event_bus.emit_needs_you.call_args.kwargs
        assert call_kwargs["event"] == "cancelled"

    def test_timeout_publishes_event(self, mock_event_bus):
        """超时时发布 timeout 事件"""
        service = NeedsYouService(
            approval_timeout=0.3,
            timeout_check_interval=0.05,
            event_bus=mock_event_bus,
        )
        service.start()
        try:
            service.request_approval(title="a", description="d")
            time.sleep(0.8)
            # 至少 2 次：created + timeout
            assert mock_event_bus.emit_needs_you.call_count >= 2
            # 最后一次应是 timeout
            last_call = mock_event_bus.emit_needs_you.call_args.kwargs
            assert last_call["event"] == "timeout"
        finally:
            service.stop()

    def test_no_event_when_no_bus(self, service):
        """未注入 event_bus 时不报错（静默跳过）"""
        req = service.request_approval(title="a", description="d")
        service.approve(req.id)
        # 不应抛出异常（已通过无报错验证）


# ============================================================================
# 13. 线程安全测试
# ============================================================================


class TestThreadSafety:
    """线程安全测试"""

    def test_concurrent_create(self, service):
        """并发创建请求：无 ID 冲突"""
        ids = []
        ids_lock = threading.Lock()

        def create_one():
            req = service.request_approval(title="t", description="d")
            with ids_lock:
                ids.append(req.id)

        threads = [threading.Thread(target=create_one) for _ in range(20)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        assert len(ids) == 20
        assert len(set(ids)) == 20  # 无重复

    def test_concurrent_respond(self, service):
        """并发响应同一请求：仅一个成功"""
        req = service.request_approval(title="a", description="d")
        results = []
        results_lock = threading.Lock()

        def try_respond():
            r = service.approve(req.id)
            with results_lock:
                results.append(r)

        threads = [threading.Thread(target=try_respond) for _ in range(10)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # 只有一个成功，其他返回 None
        successful = [r for r in results if r is not None]
        assert len(successful) == 1
        assert successful[0].status == NeedsYouStatus.APPROVED

    def test_concurrent_create_and_timeout(self, fast_service):
        """并发创建 + 超时扫描：无竞争条件"""
        fast_service.start()
        try:
            def create_many():
                for _ in range(10):
                    fast_service.request_approval(title="t", description="d")

            t1 = threading.Thread(target=create_many)
            t2 = threading.Thread(target=create_many)
            t1.start()
            t2.start()
            t1.join()
            t2.join()

            # 等待所有超时
            time.sleep(1.0)
            stats = fast_service.get_stats()
            assert stats["total_created"] == 20
            assert stats["total_timeout"] == 20
        finally:
            fast_service.stop()


# ============================================================================
# 14. JSON-RPC 方法注册测试
# ============================================================================


class TestJSONRPCRegistration:
    """JSON-RPC 方法注册测试"""

    def test_register_methods(self):
        """register_methods 注册 15 个方法"""
        dispatcher = MagicMock()
        dispatcher.register = MagicMock()
        register_methods(dispatcher)

        registered_names = [call.args[0] for call in dispatcher.register.call_args_list]
        expected_methods = [
            "needs_you.request",
            "needs_you.request_approval",
            "needs_you.request_error",
            "needs_you.request_question",
            "needs_you.request_handoff",
            "needs_you.respond",
            "needs_you.approve",
            "needs_you.reject",
            "needs_you.list",
            "needs_you.list_all",
            "needs_you.get",
            "needs_you.cancel",
            "needs_you.clear_resolved",
            "needs_you.stats",
            "needs_you.reset",
        ]
        for name in expected_methods:
            assert name in registered_names, f"missing method: {name}"
        assert len(registered_names) == 15

    def test_request_method_dispatches_to_correct_type(self):
        """needs_you.request 根据 type 字段分发到对应方法"""
        dispatcher = MagicMock()
        dispatcher.register = MagicMock()
        register_methods(dispatcher)

        # 找到 _request 函数并测试
        calls = {c.args[0]: c.args[1] for c in dispatcher.register.call_args_list}
        request_fn = calls["needs_you.request"]

        # approval
        result = request_fn(type="approval", title="a", description="d")
        assert result["type"] == "approval"
        # error
        result = request_fn(type="error", title="e", description="d")
        assert result["type"] == "error"
        # question
        result = request_fn(type="question", title="q", description="d")
        assert result["type"] == "question"
        # handoff
        result = request_fn(type="handoff", title="h", description="d")
        assert result["type"] == "handoff"

    def test_request_method_invalid_type(self):
        """无效 type 抛出 ValueError"""
        dispatcher = MagicMock()
        dispatcher.register = MagicMock()
        register_methods(dispatcher)
        calls = {c.args[0]: c.args[1] for c in dispatcher.register.call_args_list}
        request_fn = calls["needs_you.request"]

        with pytest.raises(ValueError):
            request_fn(type="invalid_type", title="t", description="d")

    def test_respond_method_via_rpc(self):
        """needs_you.respond JSON-RPC 方法功能"""
        dispatcher = MagicMock()
        dispatcher.register = MagicMock()
        register_methods(dispatcher)
        calls = {c.args[0]: c.args[1] for c in dispatcher.register.call_args_list}

        # 先创建一个请求
        request_fn = calls["needs_you.request"]
        created = request_fn(type="approval", title="a", description="d")

        # 响应
        respond_fn = calls["needs_you.respond"]
        result = respond_fn(req_id=created["id"], response={"approved": True})
        assert result["status"] == "approved"

    def test_list_method_via_rpc(self):
        """needs_you.list JSON-RPC 方法返回 pending 列表"""
        dispatcher = MagicMock()
        dispatcher.register = MagicMock()
        register_methods(dispatcher)
        calls = {c.args[0]: c.args[1] for c in dispatcher.register.call_args_list}

        request_fn = calls["needs_you.request"]
        request_fn(type="approval", title="a1", description="d")
        request_fn(type="error", title="e1", description="d")

        list_fn = calls["needs_you.list"]
        pending = list_fn()
        assert len(pending) == 2
        # error 优先
        assert pending[0]["type"] == "error"

    def test_stats_method_via_rpc(self):
        """needs_you.stats JSON-RPC 方法"""
        dispatcher = MagicMock()
        dispatcher.register = MagicMock()
        register_methods(dispatcher)
        calls = {c.args[0]: c.args[1] for c in dispatcher.register.call_args_list}

        stats_fn = calls["needs_you.stats"]
        stats = stats_fn()
        assert "total_created" in stats
        assert "current_pending" in stats
        assert "approval_timeout" in stats


# ============================================================================
# 15. 边界情况测试
# ============================================================================


class TestEdgeCases:
    """边界情况测试"""

    def test_empty_title_and_description(self, service):
        """空标题和描述应允许（前端可处理）"""
        req = service.request_approval(title="", description="")
        assert req.title == ""
        assert req.description == ""

    def test_special_characters_in_title(self, service):
        """特殊字符在标题中应保留"""
        special = "测试 <script>alert('xss')</script> & 中文 emoji 🎉"
        req = service.request_approval(title=special, description="d")
        assert req.title == special

    def test_extra_dict_preserved(self, service):
        """extra 字段保留所有附加数据"""
        req = service.request_approval(
            title="a", description="d",
            command="rm -rf /",
            risk_level="L4",
            mode="agent",
            user_id="u123",
            metadata={"key": "value"},
        )
        assert req.extra["command"] == "rm -rf /"
        assert req.extra["risk_level"] == "L4"
        assert req.extra["mode"] == "agent"
        assert req.extra["user_id"] == "u123"
        assert req.extra["metadata"] == {"key": "value"}

    def test_set_approval_timeout_dynamically(self, service):
        """动态调整 approval_timeout"""
        service.set_approval_timeout(60.0)
        req = service.request_approval(title="a", description="d")
        assert req.deadline is not None
        assert req.deadline > time.time() + 55
        assert req.deadline <= time.time() + 65

    def test_start_idempotent(self, fast_service):
        """start 幂等：重复调用安全"""
        fast_service.start()
        fast_service.start()  # 重复调用
        assert fast_service._started is True
        fast_service.stop()

    def test_stop_idempotent(self, service):
        """stop 幂等：未启动时 stop 也安全"""
        service.stop()  # 未启动也调用
        service.stop()
        assert service._started is False

    def test_reset_clears_all(self, service):
        """reset 清空所有状态"""
        service.request_approval(title="a", description="d")
        service.request_error(title="e", description="d")
        service.reset()
        assert len(service.list_all()) == 0
        stats = service.get_stats()
        assert stats["total_created"] == 0


# ============================================================================
# 16. 全局单例测试
# ============================================================================


class TestGlobalService:
    """全局单例服务测试"""

    def test_get_global_service_singleton(self):
        """get_global_service 返回同一实例"""
        s1 = get_global_service()
        s2 = get_global_service()
        assert s1 is s2

    def test_set_event_bus(self, mock_event_bus):
        """set_event_bus 注入到全局 service"""
        set_event_bus(mock_event_bus)
        service = get_global_service()
        assert service._event_bus is mock_event_bus

    def test_start_stop_global_service(self):
        """start/stop_global_service 控制全局 service 生命周期"""
        start_global_service()
        service = get_global_service()
        assert service._started is True
        stop_global_service()
        assert service._started is False

    def test_reset_for_test(self):
        """reset_for_test 清理全局 service"""
        service = get_global_service()
        service.request_approval(title="a", description="d")
        assert len(service.list_all()) > 0
        reset_for_test()
        # reset_for_test 会创建新实例？不，复用同一实例
        service = get_global_service()
        assert len(service.list_all()) == 0


# ============================================================================
# 17. 完整场景测试（spec Scenario）
# ============================================================================


class TestSpecScenarios:
    """spec 中描述的场景测试"""

    def test_multi_agent_concurrent_approval(self, service):
        """spec Scenario: 多 Agent 同时请求审批

        WHEN Coding Agent 请求审批 Edit 文件
        AND  Explore Agent 请求审批 Grep 敏感文件
        THEN 两个请求都进入 needs-you 收件箱
        AND 用户集中处理
        AND 处理结果通过 event_bus 通知对应 Agent
        """
        # 两个 Agent 同时请求审批
        r1 = service.request_approval(
            title="Edit nginx.conf",
            description="Coding Agent 请求修改配置文件",
            session_id="sess-1",
            source="coding_agent",
            file="/etc/nginx/nginx.conf",
        )
        r2 = service.request_approval(
            title="Grep /etc/shadow",
            description="Explore Agent 请求搜索敏感文件",
            session_id="sess-1",
            source="explore_agent",
            pattern="root",
        )

        # 两个都在 pending
        pending = service.list_pending()
        assert len(pending) == 2

        # 用户集中处理：批准 r1，拒绝 r2
        service.approve(r1.id, comment="OK")
        service.reject(r2.id, reason="敏感文件不允许")

        # 处理结果通过 event_bus 通知（mock 验证）
        assert service.get(r1.id)["status"] == "approved"
        assert service.get(r2.id)["status"] == "rejected"

        # pending 列表清空
        assert len(service.list_pending()) == 0

    def test_permission_check_triggers_approval(self, service):
        """spec Scenario: permission_check → needs-you 审批

        WHEN Agent 准备执行 sudo systemctl restart nginx
        THEN 调用 risk tool 评估，返回 L3 + require_approval
        AND permission_check 节点拦截，发送 needs-you 审批
        """
        # 模拟 permission_check 节点构造的请求
        req = service.request_approval(
            title="执行高风险命令",
            description="L3 风险，需审批",
            session_id="sess-perm-1",
            source="permission_check",
            risk_level="L3",
            command="sudo systemctl restart nginx",
            mode="agent",
        )

        # 模拟用户审批
        service.approve(req.id, comment="批准")

        # 验证最终状态
        result = service.get(req.id)
        assert result["status"] == "approved"
        assert result["response"]["approved"] is True
        assert result["extra"]["command"] == "sudo systemctl restart nginx"
        assert result["extra"]["risk_level"] == "L3"

    def test_yolo_mode_l3_still_needs_approval(self, service):
        """spec Scenario: yolo 模式 L3 风险仍需审批（安全底线）"""
        # yolo 模式下 L3 通过 permission_check 后，仍发送 needs-you
        req = service.request_approval(
            title="yolo 模式 L3 风险命令",
            description="yolo 模式下 L3 仍需审批（安全底线）",
            session_id="sess-yolo",
            source="permission_check",
            risk_level="L3",
            mode="yolo",
        )
        assert req.type == NeedsYouType.APPROVAL
        assert req.priority == NeedsYouPriority.HIGH

    def test_approval_timeout_auto_reject(self, fast_service):
        """spec Scenario: approval 30s 无响应自动拒绝

        实际测试用 fast_service（0.5s 超时）加速
        """
        fast_service.start()
        try:
            req = fast_service.request_approval(
                title="需要审批的命令",
                description="30s 无响应自动拒绝",
                source="permission_check",
            )
            # 等待超时
            time.sleep(1.0)
            # 状态变为 TIMEOUT
            assert req.status == NeedsYouStatus.TIMEOUT
            # 响应包含超时原因
            assert req.response["timeout"] is True
        finally:
            fast_service.stop()


# ============================================================================
# 8. P1-1 等待-唤醒测试（真实 HITL 闭环）
# ============================================================================


class TestWaitForResponse:
    """wait_for_response 阻塞等待-唤醒"""

    def test_wait_wakes_on_approve(self, service):
        """respond(approve) 应唤醒等待中的 wait_for_response"""
        import threading

        req = service.request_approval(title="a", description="d")

        def respond_later():
            time.sleep(0.3)
            service.approve(req.id)

        t = threading.Thread(target=respond_later, daemon=True)
        t.start()
        resolved = service.wait_for_response(req.id, timeout=5.0)
        t.join(timeout=5.0)
        assert resolved is not None
        assert resolved.status == NeedsYouStatus.APPROVED

    def test_wait_wakes_on_reject(self, service):
        """respond(reject) 应唤醒等待中的 wait_for_response"""
        import threading

        req = service.request_approval(title="a", description="d")

        def reject_later():
            time.sleep(0.3)
            service.reject(req.id, reason="no")

        t = threading.Thread(target=reject_later, daemon=True)
        t.start()
        resolved = service.wait_for_response(req.id, timeout=5.0)
        t.join(timeout=5.0)
        assert resolved is not None
        assert resolved.status == NeedsYouStatus.REJECTED

    def test_wait_wakes_on_timeout(self, fast_service):
        """超时扫描器应唤醒等待中的 wait_for_response（超时视为拒绝）"""
        fast_service.start()
        try:
            req = fast_service.request_approval(title="a", description="d")
            resolved = fast_service.wait_for_response(req.id, timeout=5.0)
            assert resolved is not None
            assert resolved.status == NeedsYouStatus.TIMEOUT
        finally:
            fast_service.stop()

    def test_wait_returns_immediately_if_resolved(self, service):
        """请求已响应时 wait_for_response 立即返回"""
        req = service.request_approval(title="a", description="d")
        service.approve(req.id)
        resolved = service.wait_for_response(req.id, timeout=0.01)
        assert resolved.status == NeedsYouStatus.APPROVED

    def test_wait_unknown_id_returns_none(self, service):
        """未知请求 ID 返回 None"""
        assert service.wait_for_response("ny-unknown", timeout=0.01) is None
