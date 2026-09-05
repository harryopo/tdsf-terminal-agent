"""
needs_you.py — needs-you 协调服务（T-P1-10）
=============================================

spec 要求（DEC-V321-07 needs-you 协调服务）：
1. **4 类型**：approval / error / question / handoff
   - approval:  Agent 请求用户审批（permission_check 触发）
   - error:     Agent 遇到无法恢复的错误，需用户介入
   - question:  Agent 需要向用户提问（澄清需求 / 选择方案）
   - handoff:   Agent 主动请求人工接管（任务超出能力边界）

2. **聚合**：所有 Agent 的 needs-you 请求聚合到统一收件箱
3. **优先级**：error > approval > question > handoff
4. **超时**：approval 5 分钟无响应自动拒绝（fail-closed，可配置；
   方案书 v3.1 Task 3.3 从 30s 扩展为 300s——审批卡含影响预测，给用户
   足够阅读时间；超时 agent 收到「审批超时，按拒绝处理」）
   - 其他类型不自动超时（保留 pending 等待用户处理）

设计要点：
1. 线程安全（threading.RLock 保护 _requests 字典）
2. 后台超时扫描线程（_timeout_thread，每 1s 扫描一次）
3. 与 event_bus 集成：创建 / 响应 / 超时都发布事件
4. 不可变结果对象（NeedsYouRequest dataclass frozen=False，
   因 status / response / responded_at 需要更新，但通过 lock 保护）
5. JSON-RPC 接口（注册到 MethodDispatcher）
6. 单元测试友好（reset_for_test / 可配置 timeout / 可注入 event_bus）

JSON-RPC 方法（注册到 MethodDispatcher）：
- needs_you.request:        通用请求接口（type 字段区分）
- needs_you.request_approval:    便捷方法（type=approval）
- needs_you.request_error:       便捷方法（type=error）
- needs_you.request_question:    便捷方法（type=question）
- needs_you.request_handoff:     便捷方法（type=handoff)
- needs_you.respond:        用户响应请求
- needs_you.list:           列出请求（按优先级排序）
- needs_you.get:            查询单个请求
- needs_you.cancel:         取消请求
- needs_you.clear_resolved: 清除已解决请求
- needs_you.stats:          统计信息
- needs_you.reset:          重置（测试用）
"""

from __future__ import annotations

import logging
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

logger = logging.getLogger("sidecar.needs_you")


# ============================================================================
# 枚举定义
# ============================================================================


class NeedsYouType(str, Enum):
    """needs-you 请求类型（4 类型）

    与 spec DEC-V321-07 对齐：
    - APPROVAL:  Agent 请求用户审批（permission_check 触发）
    - ERROR:     Agent 遇到无法恢复的错误，需用户介入
    - QUESTION:  Agent 需要向用户提问（澄清需求 / 选择方案）
    - HANDOFF:   Agent 主动请求人工接管
    """

    APPROVAL = "approval"
    ERROR = "error"
    QUESTION = "question"
    HANDOFF = "handoff"


class NeedsYouStatus(str, Enum):
    """needs-you 请求状态

    状态机：
        PENDING ──respond──► APPROVED / REJECTED / RESOLVED
        PENDING ──timeout──► TIMEOUT（仅 approval 类型）
        PENDING ──cancel───► CANCELLED
    """

    PENDING = "pending"          # 待处理
    APPROVED = "approved"        # 用户批准（主要用于 approval 类型）
    REJECTED = "rejected"        # 用户拒绝（主要用于 approval 类型）
    RESOLVED = "resolved"        # 用户已解决（用于 question / error / handoff）
    TIMEOUT = "timeout"          # 超时自动拒绝（仅 approval）
    # TDSF 魔改 (2026-08-09): 方案书 HITL 四决策
    EDITED = "edited"            # 用户修改了参数后放行（edit 决策）
    RESPONDED = "responded"      # 用户替工具回了结果（respond 决策）
    CANCELLED = "cancelled"      # Agent 主动取消


class NeedsYouPriority(str, Enum):
    """needs-you 优先级（与类型一一对应，便于扩展）

    优先级数值（越小越高）：
    - CRITICAL (0): error     —— 错误必须最先处理
    - HIGH     (1): approval  —— 审批阻塞 Agent 执行
    - NORMAL   (2): question  —— 提问可等待
    - LOW      (3): handoff   —— 接管最不紧急
    """

    CRITICAL = "critical"  # error
    HIGH = "high"          # approval
    NORMAL = "normal"      # question
    LOW = "low"            # handoff


# 类型 → 优先级映射（spec 要求：error > approval > question > handoff）
_TYPE_TO_PRIORITY: dict[NeedsYouType, NeedsYouPriority] = {
    NeedsYouType.ERROR: NeedsYouPriority.CRITICAL,
    NeedsYouType.APPROVAL: NeedsYouPriority.HIGH,
    NeedsYouType.QUESTION: NeedsYouPriority.NORMAL,
    NeedsYouType.HANDOFF: NeedsYouPriority.LOW,
}

# 优先级数值（用于排序，越小越优先）
_PRIORITY_ORDER: dict[NeedsYouPriority, int] = {
    NeedsYouPriority.CRITICAL: 0,
    NeedsYouPriority.HIGH: 1,
    NeedsYouPriority.NORMAL: 2,
    NeedsYouPriority.LOW: 3,
}


# ============================================================================
# 数据结构
# ============================================================================


@dataclass
class NeedsYouRequest:
    """needs-you 请求对象

    Attributes:
        id:           唯一标识（uuid4 hex[:12]，便于日志和前端展示）
        type:         请求类型（approval / error / question / handoff）
        title:        标题（前端卡片标题）
        description:  详细描述（前端卡片正文）
        priority:     优先级（CRITICAL / HIGH / NORMAL / LOW）
        session_id:   会话 ID（用于路由事件到对应会话）
        source:       请求来源（如 "permission_check" / "coding_agent"）
        created_at:   创建时间（time.time()）
        deadline:     截止时间（仅 approval 类型，超时自动拒绝；其他类型为 None）
        status:       当前状态
        response:     用户响应内容（pending 时为 None）
        responded_at: 响应时间（pending 时为 None）
        responded_by: 响应者标识（如 "user" / "system_timeout"）
        extra:        附加数据（如 command / risk_level / options 等）
    """

    id: str
    type: NeedsYouType
    title: str
    description: str
    priority: NeedsYouPriority
    session_id: str | None = None
    source: str | None = None
    created_at: float = field(default_factory=time.time)
    deadline: float | None = None
    status: NeedsYouStatus = NeedsYouStatus.PENDING
    response: Any = None
    responded_at: float | None = None
    responded_by: str | None = None
    extra: dict[str, Any] = field(default_factory=dict)
    # P1-1 (2026-08-01): 等待-唤醒事件。respond/超时 时 set，
    # 工具侧 wait_for_response 阻塞等待（实现真实 HITL 闭环）。
    _event: threading.Event = field(
        default_factory=threading.Event, init=False, repr=False
    )
    # approval 排队时不启动超时；晋升为当前 session 的活动项后才设置 deadline。
    _approval_timeout: float | None = field(default=None, repr=False)
    _activated_event: threading.Event = field(
        default_factory=threading.Event, init=False, repr=False
    )
    # execution_gate=True 的命令审批在用户批准后仍占用本 session 队首，
    # 直到调用方的执行 finally 显式释放，避免下一条命令在前一条运行时获批。
    _execution_pending: bool = field(default=False, init=False, repr=False)

    def to_dict(self) -> dict[str, Any]:
        """转为 dict（用于 JSON 序列化 / event_bus payload）"""
        return {
            "id": self.id,
            "type": self.type.value,
            "title": self.title,
            "description": self.description,
            "priority": self.priority.value,
            "session_id": self.session_id,
            "source": self.source,
            "created_at": self.created_at,
            "deadline": self.deadline,
            "status": self.status.value,
            "response": self.response,
            "responded_at": self.responded_at,
            "responded_by": self.responded_by,
            "extra": self.extra,
        }

    @property
    def is_pending(self) -> bool:
        """是否待处理"""
        return self.status == NeedsYouStatus.PENDING

    @property
    def is_resolved(self) -> bool:
        """是否已解决（execution_gate 的 approved 要等待执行结束）。"""
        return self.status != NeedsYouStatus.PENDING and not self._execution_pending


# ============================================================================
# 协调服务核心
# ============================================================================


class NeedsYouService:
    """needs-you 协调服务

    职责：
    1. 聚合所有 Agent 的 needs-you 请求到统一收件箱
    2. 按优先级排序（error > approval > question > handoff）
    3. 处理超时（approval 30s 无响应自动拒绝）
    4. 接收用户响应并通过 event_bus 通知对应 Agent
    5. 发布 needs_you 事件（创建 / 响应 / 超时 / 取消）

    用法：
        service = get_global_service()
        req = service.request_approval(
            title="重启 nginx",
            description="L3 风险，需审批",
            session_id="sess-123",
            source="permission_check",
            extra={"command": "sudo systemctl restart nginx", "risk_level": "L3"},
        )
        # 用户响应后
        service.respond(req.id, response={"approved": True}, responded_by="user")
    """

    def __init__(
        self,
        approval_timeout: float = 300.0,
        timeout_check_interval: float = 1.0,
        event_bus: Any | None = None,
    ):
        """初始化 needs-you 服务

        Args:
            approval_timeout:        approval 类型超时秒数（默认 300s = 5 分钟，
                                     方案书 v3.1 Task 3.3；超时 fail-closed 按拒绝处理）
            timeout_check_interval:  超时扫描间隔（默认 1s）
            event_bus:               EventBus 实例（None 时使用全局 bus）
        """
        self._requests: dict[str, NeedsYouRequest] = {}
        self._lock = threading.RLock()
        # 状态锁只保护内存状态；事件发布在状态锁外完成。transition lock 保证
        # “前一项终结事件 → 下一项 created”不会被并发响应/超时重排。
        self._transition_lock = threading.RLock()
        self._active_approvals: dict[str | None, str] = {}
        self._approval_queues: dict[str | None, deque[str]] = {}
        self._approval_timeout = approval_timeout
        self._timeout_check_interval = timeout_check_interval
        self._event_bus = event_bus  # 延迟绑定，启动时由 main.py 注入
        self._timeout_thread: threading.Thread | None = None
        self._shutdown = threading.Event()
        self._started = False

        # 统计信息
        self._stats = {
            "total_created": 0,
            "total_responded": 0,
            "total_timeout": 0,
            "total_cancelled": 0,
            "by_type": {t.value: 0 for t in NeedsYouType},
            "by_status": {s.value: 0 for s in NeedsYouStatus},
        }

    # ========================================================================
    # 配置 / 生命周期
    # ========================================================================

    def set_event_bus(self, bus: Any) -> None:
        """注入 EventBus 实例（由 main.py 在启动时调用）"""
        self._event_bus = bus
        logger.info("event_bus injected into needs_you service")

    def set_approval_timeout(self, timeout: float) -> None:
        """动态调整 approval 超时（秒）"""
        with self._lock:
            self._approval_timeout = timeout
        logger.info(f"approval_timeout updated: {timeout}s")

    def start(self) -> None:
        """启动超时扫描线程（幂等，重复调用安全）"""
        if self._started:
            return
        self._shutdown.clear()
        self._timeout_thread = threading.Thread(
            target=self._timeout_loop,
            name="needs-you-timeout",
            daemon=True,
        )
        self._timeout_thread.start()
        self._started = True
        logger.info(
            f"needs_you timeout scanner started "
            f"(interval={self._timeout_check_interval}s, "
            f"approval_timeout={self._approval_timeout}s)"
        )

    def stop(self) -> None:
        """停止超时扫描线程（幂等，重复调用安全）"""
        if not self._started:
            return
        self._shutdown.set()
        if self._timeout_thread is not None:
            self._timeout_thread.join(timeout=2.0)
            self._timeout_thread = None
        self._started = False
        logger.info("needs_you timeout scanner stopped")

    # ========================================================================
    # 请求创建 API（4 类型的便捷方法）
    # ========================================================================

    def request_approval(
        self,
        title: str,
        description: str,
        session_id: str | None = None,
        source: str | None = None,
        timeout: float | None = None,
        **extra: Any,
    ) -> NeedsYouRequest:
        """发起 approval 请求（默认 5 分钟超时自动拒绝，fail-closed）

        Args:
            title:       卡片标题
            description: 详细描述
            session_id:  会话 ID
            source:      请求来源
            timeout:     自定义超时（None 用默认 300s）
            **extra:     附加数据（经 request.to_dict()["extra"] 透传前端）。
                         Task 3.1 审批卡四层卡面约定字段：
                         - command:      命令原文（第 2 层，前端代码块渲染，永不改写）
                         - semantic:     动作语义描述（第 1 层，如「想重启服务：nginx」）
                         - explanation:  LLM 用途解释（第 3 层，可缺失）
                         - impact:       影响预测（第 4 层，command_impact.analyze 产出
                           {segments, max_risk_l, summary, denied, dangerous_construct} 或 None）
                         - risk_l:       0-4 整数（风险色带 + 会话免审按钮显隐）
        """
        return self._create_request(
            needs_type=NeedsYouType.APPROVAL,
            title=title,
            description=description,
            session_id=session_id,
            source=source,
            timeout=timeout if timeout is not None else self._approval_timeout,
            extra=dict(extra),
        )

    def request_error(
        self,
        title: str,
        description: str,
        session_id: str | None = None,
        source: str | None = None,
        **extra: Any,
    ) -> NeedsYouRequest:
        """发起 error 请求（不自动超时，必须用户处理）"""
        return self._create_request(
            needs_type=NeedsYouType.ERROR,
            title=title,
            description=description,
            session_id=session_id,
            source=source,
            timeout=None,  # error 不超时
            extra=dict(extra),
        )

    def request_question(
        self,
        title: str,
        description: str,
        session_id: str | None = None,
        source: str | None = None,
        **extra: Any,
    ) -> NeedsYouRequest:
        """发起 question 请求（不自动超时，等待用户回答）"""
        return self._create_request(
            needs_type=NeedsYouType.QUESTION,
            title=title,
            description=description,
            session_id=session_id,
            source=source,
            timeout=None,  # question 不超时
            extra=dict(extra),
        )

    def request_handoff(
        self,
        title: str,
        description: str,
        session_id: str | None = None,
        source: str | None = None,
        **extra: Any,
    ) -> NeedsYouRequest:
        """发起 handoff 请求（不自动超时，等待用户接管）"""
        return self._create_request(
            needs_type=NeedsYouType.HANDOFF,
            title=title,
            description=description,
            session_id=session_id,
            source=source,
            timeout=None,  # handoff 不超时
            extra=dict(extra),
        )

    def notify_fix_loop_exhausted(
        self,
        session_id: str,
        operation_key: str,
        retry_count: int,
        max_retry: int,
        last_error: str = "",
        task: str = "",
        source: str = "fix_loop",
    ) -> NeedsYouRequest:
        """Fix-loop 超限时创建 handoff 请求（DEC-V321-11 / T-P2-12.2）

        spec 要求：Agent 同一操作 max_retry=3，超限强制停手 + needs-you 通知。

        本方法由 agents/base.py 的 invoke() 在 is_exhausted=True 时自动调用，
        创建 type=HANDOFF 的请求，提示用户人工介入。

        Args:
            session_id:    会话 ID
            operation_key: 操作标识（task + tool_name 组合，由 build_operation_key 生成）
            retry_count:   当前重试次数（应等于 max_retry）
            max_retry:     最大重试次数（用于展示，如 3）
            last_error:    最后一次错误信息（用于诊断）
            task:          当前任务描述（人类可读）
            source:        请求来源（默认 "fix_loop"）

        Returns:
            NeedsYouRequest（type=HANDOFF，priority=LOW，无 deadline）

        用法：
            # 在 BaseAgent.invoke() 中：
            if tracker.is_exhausted(session_id, op_key):
                needs_service.notify_fix_loop_exhausted(
                    session_id=session_id,
                    operation_key=op_key,
                    retry_count=retry_count,
                    max_retry=tracker.max_retry,
                    last_error=err,
                    task=current_task,
                )
        """
        title = f"Fix-loop 重试超限（{retry_count}/{max_retry}）"
        description = (
            f"Agent 在执行任务「{task or operation_key}」时连续失败 {retry_count} 次，"
            f"已超出最大重试限制 {max_retry}，已强制停手。\n"
            f"\n"
            f"操作标识：{operation_key}\n"
            f"最后错误：{last_error or '(无)'}\n"
            f"\n"
            f"建议：\n"
            f"- 人工介入诊断失败原因\n"
            f"- 调整任务策略或参数后重新发起\n"
            f"- 检查环境依赖（权限/网络/磁盘等）"
        )
        logger.warning(
            f"needs_you notify_fix_loop_exhausted: session={session_id}, "
            f"op={operation_key}, retries={retry_count}/{max_retry}"
        )
        return self.request_handoff(
            title=title,
            description=description,
            session_id=session_id,
            source=source,
            # extra 字段便于前端按 fix_loop 类型渲染特殊样式
            fix_loop=True,
            operation_key=operation_key,
            retry_count=retry_count,
            max_retry=max_retry,
            last_error=last_error,
            task=task,
        )

    def _create_request(
        self,
        needs_type: NeedsYouType,
        title: str,
        description: str,
        session_id: str | None,
        source: str | None,
        timeout: float | None,
        extra: dict[str, Any],
    ) -> NeedsYouRequest:
        """内部统一创建请求"""
        with self._transition_lock:
            req_id = f"ny-{uuid.uuid4().hex[:12]}"
            priority = _TYPE_TO_PRIORITY[needs_type]
            req = NeedsYouRequest(
                id=req_id,
                type=needs_type,
                title=title,
                description=description,
                priority=priority,
                session_id=session_id,
                source=source,
                deadline=None,
                extra=extra,
                _approval_timeout=timeout,
            )

            with self._lock:
                # 获得状态锁时确定并发创建的线性化顺序。
                req.created_at = time.time()
                self._requests[req_id] = req
                self._stats["total_created"] += 1
                self._stats["by_type"][needs_type.value] += 1
                self._stats["by_status"][NeedsYouStatus.PENDING.value] += 1

                should_emit = True
                if needs_type == NeedsYouType.APPROVAL:
                    if self._active_approvals.get(session_id) is None:
                        self._activate_approval_locked(req)
                    else:
                        self._approval_queues.setdefault(session_id, deque()).append(req_id)
                        should_emit = False

            logger.info(
                f"needs_you created: id={req_id}, type={needs_type.value}, "
                f"priority={priority.value}, session={session_id}, "
                f"state={'active' if should_emit else 'queued'}, deadline={req.deadline}"
            )

            # 排队 approval 只有晋升为活动项后才发布 created。
            if should_emit:
                self._emit_event(
                    event_name="created",
                    req=req,
                    extra_payload={"timeout": timeout},
                )

        return req

    def _activate_approval_locked(self, req: NeedsYouRequest) -> None:
        """把 approval 设为其 session 的唯一活动项；调用方必须持有 _lock。"""
        self._active_approvals[req.session_id] = req.id
        timeout = req._approval_timeout
        req.deadline = (time.time() + timeout) if timeout is not None else None
        req._activated_event.set()

    def _finish_approval_locked(
        self,
        req: NeedsYouRequest,
    ) -> NeedsYouRequest | None:
        """移除已终结 approval，并按 FIFO 晋升同 session 下一项。"""
        if req.type != NeedsYouType.APPROVAL:
            return None

        session_id = req.session_id
        if self._active_approvals.get(session_id) == req.id:
            self._active_approvals.pop(session_id, None)
            queue = self._approval_queues.get(session_id)
            while queue:
                next_id = queue.popleft()
                next_req = self._requests.get(next_id)
                if next_req is not None and next_req.is_pending:
                    self._activate_approval_locked(next_req)
                    if not queue:
                        self._approval_queues.pop(session_id, None)
                    return next_req
            self._approval_queues.pop(session_id, None)
            return None

        # 队列中的请求只允许显式 cancel；移除后保持当前活动项不变。
        queue = self._approval_queues.get(session_id)
        if queue is not None:
            try:
                queue.remove(req.id)
            except ValueError:
                pass
            if not queue:
                self._approval_queues.pop(session_id, None)
        return None

    # ========================================================================
    # 用户响应 API
    # ========================================================================

    def respond(
        self,
        req_id: str,
        response: Any,
        responded_by: str = "user",
    ) -> NeedsYouRequest | None:
        """用户响应 needs-you 请求

        根据请求类型自动推断新状态：
        - approval + response.approved=True  → APPROVED
        - approval + response.approved=False → REJECTED
        - error/question/handoff             → RESOLVED

        Args:
            req_id:       请求 ID
            response:     用户响应内容（dict / str / bool 等）
            responded_by: 响应者标识（默认 "user"）

        Returns:
            更新后的 NeedsYouRequest，如果 req_id 不存在或已处理则返回 None
        """
        with self._transition_lock:
            with self._lock:
                req = self._requests.get(req_id)
                if req is None:
                    logger.warning(f"needs_you.respond: id={req_id} not found")
                    return None
                if req.status != NeedsYouStatus.PENDING:
                    logger.warning(
                        f"needs_you.respond: id={req_id} already {req.status.value}, "
                        f"skip respond"
                    )
                    return None
                if (
                    req.type == NeedsYouType.APPROVAL
                    and self._active_approvals.get(req.session_id) != req.id
                ):
                    logger.warning(
                        f"needs_you.respond: id={req_id} is queued behind active "
                        f"approval for session={req.session_id}, skip out-of-order respond"
                    )
                    return None

                new_status = self._infer_status_from_response(req.type, response)
                req.response = response
                req.responded_at = time.time()
                req.responded_by = responded_by
                req.status = new_status

                self._stats["total_responded"] += 1
                self._stats["by_status"][NeedsYouStatus.PENDING.value] -= 1
                self._stats["by_status"][new_status.value] += 1
                # 命令型审批只代表“允许开始执行”；保持 session 队首直到工具
                # 在 finally 中报告执行结束。普通 approval 保持原来的即时完成语义。
                if (
                    req.type == NeedsYouType.APPROVAL
                    and new_status == NeedsYouStatus.APPROVED
                    and bool(req.extra.get("execution_gate"))
                ):
                    req._execution_pending = True
                    promoted = None
                else:
                    promoted = self._finish_approval_locked(req)

            logger.info(
                f"needs_you responded: id={req_id}, status={new_status.value}, "
                f"by={responded_by}"
            )

            # 唤醒工具线程，并按“旧项终结 → 新项 created”的顺序发事件。
            req._event.set()
            self._emit_event(event_name="responded", req=req)
            if promoted is not None:
                self._emit_event(
                    event_name="created",
                    req=promoted,
                    extra_payload={"timeout": promoted._approval_timeout},
                )

        return req

    def approve(self, req_id: str, comment: str = "", responded_by: str = "user") -> NeedsYouRequest | None:
        """便捷方法：批准 approval 请求"""
        return self.respond(
            req_id=req_id,
            response={"approved": True, "comment": comment},
            responded_by=responded_by,
        )

    def reject(self, req_id: str, reason: str = "", responded_by: str = "user") -> NeedsYouRequest | None:
        """便捷方法：拒绝 approval 请求"""
        return self.respond(
            req_id=req_id,
            response={"approved": False, "reason": reason},
            responded_by=responded_by,
        )

    def complete_execution(self, req_id: str) -> NeedsYouRequest | None:
        """释放 execution_gate 审批的队首，并按 FIFO 激活下一条。

        调用方必须在 Rust SSH 调用的 ``finally`` 中调用：无论命令成功、失败、
        会话校验失败还是 IPC 抛异常，队列都不能永久卡住。
        """
        with self._transition_lock:
            with self._lock:
                req = self._requests.get(req_id)
                if req is None:
                    logger.warning(
                        f"needs_you.complete_execution: id={req_id} not found"
                    )
                    return None
                if (
                    req.type != NeedsYouType.APPROVAL
                    or req.status != NeedsYouStatus.APPROVED
                    or not req._execution_pending
                    or self._active_approvals.get(req.session_id) != req.id
                ):
                    logger.warning(
                        f"needs_you.complete_execution: id={req_id} is not an active "
                        "approved execution gate"
                    )
                    return None

                req._execution_pending = False
                promoted = self._finish_approval_locked(req)

            logger.info(f"needs_you execution finished: id={req_id}")
            self._emit_event(event_name="execution_finished", req=req)
            if promoted is not None:
                self._emit_event(
                    event_name="created",
                    req=promoted,
                    extra_payload={"timeout": promoted._approval_timeout},
                )
        return req

    def wait_for_response(
        self,
        req_id: str,
        timeout: float | None = None,
    ) -> NeedsYouRequest | None:
        """阻塞等待用户响应（P1-1，真实 HITL 闭环）

        工具侧在高危命令触发审批后调用：
            1. 请求已非 pending（已响应/已超时）→ 立即返回
            2. 请求 pending → 阻塞等待 respond / 超时扫描 唤醒
            3. 返回最终状态的 NeedsYouRequest（None = 请求不存在）

        Args:
            req_id: 请求 ID
            timeout: 调用方最大等待秒数。None 时 approval 由活动 deadline
                     终结，不让排队时间消耗审批窗口；其他类型保留
                     service 默认等待上限。

        Returns:
            最终状态的 NeedsYouRequest；请求不存在返回 None
        """
        with self._lock:
            req = self._requests.get(req_id)
            if req is None:
                logger.warning(f"needs_you.wait_for_response: id={req_id} not found")
                return None
            if not req.is_pending:
                return req
            queued = (
                req.type == NeedsYouType.APPROVAL
                and self._active_approvals.get(req.session_id) != req.id
            )
            activated_event = req._activated_event
            response_event = req._event

        if queued:
            # 排队阶段不消耗 approval 的等待窗口。cancel/reset 也会唤醒此事件。
            activated_event.wait()
            with self._lock:
                req = self._requests.get(req_id)
                if req is None or not req.is_pending:
                    return req

        # 调用方 timeout 也从激活时开始；approval 自身 deadline 仍是最终超时依据。
        # 非 approval 保留旧行为：None 仍以 service 默认值作为调用方等待上限。
        effective_timeout = (
            self._approval_timeout
            if timeout is None and req.type != NeedsYouType.APPROVAL
            else timeout
        )
        wait_deadline = (
            time.monotonic() + effective_timeout
            if effective_timeout is not None
            else None
        )
        while True:
            with self._lock:
                req = self._requests.get(req_id)
                if req is None or not req.is_pending:
                    return req
                approval_deadline = (
                    req.deadline if req.type == NeedsYouType.APPROVAL else None
                )

            remaining: float | None = None
            if approval_deadline is not None:
                remaining = max(0.0, approval_deadline - time.time())
            if wait_deadline is not None:
                caller_remaining = max(0.0, wait_deadline - time.monotonic())
                remaining = (
                    caller_remaining
                    if remaining is None
                    else min(remaining, caller_remaining)
                )

            if response_event.wait(remaining):
                continue
            if approval_deadline is not None and time.time() >= approval_deadline:
                # 不依赖扫描线程恰好先运行；竞态由 transition lock 线性化。
                self._scan_timeouts()
                continue
            with self._lock:
                return self._requests.get(req_id)

    def _infer_status_from_response(
        self,
        needs_type: NeedsYouType,
        response: Any,
    ) -> NeedsYouStatus:
        """根据请求类型和响应内容推断新状态

        TDSF 魔改 (2026-08-09): 支持方案书 HITL 四决策
        - approve → APPROVED
        - reject → REJECTED
        - edit（改参数放行）→ EDITED
        - respond（人替工具回结果）→ RESPONDED
        - trust（本会话不再询问）→ APPROVED + 会话级 trust 标记
        """
        if needs_type == NeedsYouType.APPROVAL:
            if isinstance(response, dict):
                # TDSF: 新的决策字段
                decision = str(response.get("decision", "")).lower()
                if decision == "edit":
                    return NeedsYouStatus.EDITED
                elif decision == "respond":
                    return NeedsYouStatus.RESPONDED
                elif decision == "trust":
                    return NeedsYouStatus.APPROVED  # trust 走 approved + 会话标记
                # 兼容旧格式：approved: bool
                approved = response.get("approved", False)
            elif isinstance(response, bool):
                approved = response
            else:
                approved = False
            return NeedsYouStatus.APPROVED if approved else NeedsYouStatus.REJECTED
        # error / question / handoff: 用户响应即视为已解决
        return NeedsYouStatus.RESOLVED

    # ========================================================================
    # 取消 / 清理
    # ========================================================================

    def cancel(self, req_id: str, reason: str = "") -> NeedsYouRequest | None:
        """Agent 主动取消请求

        用于 Agent 自己发现请求不再需要时（如用户已用其他方式响应）。

        Args:
            req_id:  请求 ID
            reason:  取消原因

        Returns:
            更新后的 NeedsYouRequest，如果不存在或已处理则返回 None
        """
        with self._transition_lock:
            with self._lock:
                req = self._requests.get(req_id)
                if req is None:
                    logger.warning(f"needs_you.cancel: id={req_id} not found")
                    return None
                if req.status != NeedsYouStatus.PENDING:
                    logger.warning(
                        f"needs_you.cancel: id={req_id} already {req.status.value}, "
                        f"skip cancel"
                    )
                    return None

                req.status = NeedsYouStatus.CANCELLED
                req.responded_at = time.time()
                req.responded_by = "agent_cancel"
                req.response = {"cancelled_reason": reason}

                self._stats["total_cancelled"] += 1
                self._stats["by_status"][NeedsYouStatus.PENDING.value] -= 1
                self._stats["by_status"][NeedsYouStatus.CANCELLED.value] += 1
                promoted = self._finish_approval_locked(req)

            # 队列项 waiter 可能仍在等 activation，因此两个事件都要唤醒。
            req._activated_event.set()
            req._event.set()
            logger.info(f"needs_you cancelled: id={req_id}, reason={reason}")
            self._emit_event(event_name="cancelled", req=req)
            if promoted is not None:
                self._emit_event(
                    event_name="created",
                    req=promoted,
                    extra_payload={"timeout": promoted._approval_timeout},
                )
        return req

    def clear_resolved(self) -> int:
        """清除所有已解决请求（approved / rejected / resolved / timeout / cancelled）

        Returns:
            清除的请求数量
        """
        with self._lock:
            resolved_ids = [rid for rid, r in self._requests.items() if r.is_resolved]
            for rid in resolved_ids:
                del self._requests[rid]
            count = len(resolved_ids)

        logger.info(f"needs_you cleared {count} resolved requests")
        return count

    def reset(self) -> None:
        """重置所有状态（测试用）"""
        with self._transition_lock:
            with self._lock:
                requests = list(self._requests.values())
                self._requests.clear()
                self._active_approvals.clear()
                self._approval_queues.clear()
                self._stats = {
                    "total_created": 0,
                    "total_responded": 0,
                    "total_timeout": 0,
                    "total_cancelled": 0,
                    "by_type": {t.value: 0 for t in NeedsYouType},
                    "by_status": {s.value: 0 for s in NeedsYouStatus},
                }
            for req in requests:
                req._activated_event.set()
                req._event.set()
        logger.info("needs_you service reset")

    # ========================================================================
    # 查询 API
    # ========================================================================

    def get(self, req_id: str) -> dict[str, Any] | None:
        """查询单个请求（返回 dict 副本）"""
        with self._lock:
            req = self._requests.get(req_id)
            return req.to_dict() if req else None

    def list_pending(
        self,
        session_id: str | None = None,
        needs_type: str | None = None,
    ) -> list[dict[str, Any]]:
        """列出待处理请求（按优先级排序）

        排序规则（spec 要求 error > approval > question > handoff）：
        1. 按 priority 数值升序（CRITICAL=0 < HIGH=1 < NORMAL=2 < LOW=3）
        2. 同优先级按 created_at 升序（FIFO）

        Args:
            session_id: 按 session 过滤（None 表示所有）
            needs_type: 按类型过滤（None 表示所有）

        Returns:
            排序后的请求 dict 列表
        """
        with self._lock:
            pending = [
                req for req in self._requests.values()
                if req.is_pending
                and (session_id is None or req.session_id == session_id)
                and (needs_type is None or req.type.value == needs_type)
            ]
            # 排序：priority 升序 + created_at 升序
            pending.sort(key=lambda r: (_PRIORITY_ORDER[r.priority], r.created_at))
            return [r.to_dict() for r in pending]

    def list_all(
        self,
        session_id: str | None = None,
        needs_type: str | None = None,
        status: str | None = None,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        """列出所有请求（含已解决，按创建时间倒序）"""
        with self._lock:
            results = [
                req for req in self._requests.values()
                if (session_id is None or req.session_id == session_id)
                and (needs_type is None or req.type.value == needs_type)
                and (status is None or req.status.value == status)
            ]
            results.sort(key=lambda r: r.created_at, reverse=True)
            return [r.to_dict() for r in results[:limit]]

    def get_stats(self) -> dict[str, Any]:
        """获取统计信息"""
        with self._lock:
            pending_count = sum(
                1 for r in self._requests.values() if r.is_pending
            )
            return {
                **self._stats,
                "current_pending": pending_count,
                "current_total": len(self._requests),
                "approval_timeout": self._approval_timeout,
                "scanner_started": self._started,
            }

    # ========================================================================
    # 超时扫描（后台线程）
    # ========================================================================

    def _timeout_loop(self) -> None:
        """超时扫描线程主循环（每 1s 扫描一次）"""
        logger.debug("needs_you timeout loop started")
        while not self._shutdown.is_set():
            try:
                self._scan_timeouts()
            except Exception as e:
                logger.exception(f"needs_you timeout scan error: {e}")
            # 使用 wait 而非 sleep，便于快速响应 shutdown
            self._shutdown.wait(self._timeout_check_interval)
        logger.debug("needs_you timeout loop exited")

    def _scan_timeouts(self) -> int:
        """扫描超时请求并标记为 TIMEOUT

        Returns:
            本次扫描触发超时的请求数
        """
        with self._transition_lock:
            now = time.time()
            timeout_ids: list[str] = []

            with self._lock:
                for req in self._requests.values():
                    if not req.is_pending:
                        continue
                    if req.deadline is None:
                        continue
                    if now >= req.deadline:
                        timeout_ids.append(req.id)

                if not timeout_ids:
                    return 0

                timed_out: list[tuple[NeedsYouRequest, NeedsYouRequest | None]] = []
                for rid in timeout_ids:
                    req = self._requests.get(rid)
                    if req is None or not req.is_pending:
                        continue
                    req.status = NeedsYouStatus.TIMEOUT
                    req.responded_at = now
                    req.responded_by = "system_timeout"
                    timeout_seconds = (
                        req._approval_timeout
                        if req._approval_timeout is not None
                        else self._approval_timeout
                    )
                    req.response = {
                        "timeout": True,
                        "reason": (
                            f"审批超时（{int(timeout_seconds)}s "
                            "无响应），按拒绝处理"
                        ),
                    }
                    self._stats["total_timeout"] += 1
                    self._stats["by_status"][NeedsYouStatus.PENDING.value] -= 1
                    self._stats["by_status"][NeedsYouStatus.TIMEOUT.value] += 1
                    timed_out.append((req, self._finish_approval_locked(req)))

            # 事件和等待唤醒均在状态锁外完成。
            for req, promoted in timed_out:
                logger.warning(
                    f"needs_you timeout: id={req.id}, type={req.type.value}, "
                    f"deadline={req.deadline}"
                )
                req._event.set()
                self._emit_event(event_name="timeout", req=req)
                if promoted is not None:
                    self._emit_event(
                        event_name="created",
                        req=promoted,
                        extra_payload={"timeout": promoted._approval_timeout},
                    )

            return len(timed_out)

    # ========================================================================
    # 事件发布
    # ========================================================================

    def _emit_event(self, event_name: str, req: NeedsYouRequest, extra_payload: dict | None = None) -> None:
        """发布 needs_you 事件到 event_bus

        事件 payload 结构：
        {
            "event": "created" | "responded" | "execution_finished" | "cancelled" | "timeout",
            "request": <NeedsYouRequest.to_dict()>,
            **extra_payload,
        }

        事件类型：EventType.NEEDS_YOU（前端订阅 needs_you 事件即可收到所有子事件）
        """
        if self._event_bus is None:
            return  # 测试模式或未初始化

        payload: dict[str, Any] = {
            "event": event_name,
            "request": req.to_dict(),
        }
        if extra_payload:
            payload.update(extra_payload)

        try:
            # 调用 EventBus.emit_needs_you
            # 兼容两种 EventBus：注入的对象或全局 get_global_bus()
            if hasattr(self._event_bus, "emit_needs_you"):
                self._event_bus.emit_needs_you(
                    needs_type=req.type.value,
                    title=req.title,
                    description=req.description,
                    session_id=req.session_id,
                    source=req.source or "needs_you_service",
                    priority=req.priority.value,
                    event=event_name,  # 额外字段
                    request=payload["request"],
                    **(extra_payload or {}),
                )
            else:
                # 兜底：直接 publish
                from event_bus import Event, EventType
                self._event_bus.publish(Event(
                    event_type=EventType.NEEDS_YOU.value,
                    payload=payload,
                    session_id=req.session_id,
                    source="needs_you_service",
                ))
        except Exception as e:
            logger.exception(f"needs_you event publish failed: {e}")


# ============================================================================
# 全局实例（单例）
# ============================================================================


_global_service: NeedsYouService | None = None
_global_lock = threading.Lock()


def get_global_service() -> NeedsYouService:
    """获取全局 NeedsYouService 实例（单例）"""
    global _global_service
    if _global_service is None:
        with _global_lock:
            if _global_service is None:
                _global_service = NeedsYouService()
    return _global_service


def set_event_bus(bus: Any) -> None:
    """注入 EventBus 到全局 NeedsYouService（由 main.py 启动时调用）"""
    get_global_service().set_event_bus(bus)


def start_global_service() -> None:
    """启动全局服务的超时扫描线程（由 main.py 启动时调用）"""
    get_global_service().start()


def stop_global_service() -> None:
    """停止全局服务（由 main.py 退出时调用）"""
    if _global_service is not None:
        _global_service.stop()


def reset_for_test() -> None:
    """重置全局服务（测试用）"""
    if _global_service is not None:
        _global_service.stop()
        _global_service.reset()


# ============================================================================
# JSON-RPC 方法注册
# ============================================================================


def register_methods(dispatcher: Any) -> None:
    """将 NeedsYouService 方法注册到 JSON-RPC MethodDispatcher

    注册的方法：
    - needs_you.request:           通用请求接口（type 字段区分）
    - needs_you.request_approval:  便捷方法（type=approval）
    - needs_you.request_error:     便捷方法（type=error）
    - needs_you.request_question:  便捷方法（type=question）
    - needs_you.request_handoff:   便捷方法（type=handoff)
    - needs_you.respond:           用户响应请求
    - needs_you.approve:           便捷方法：批准
    - needs_you.reject:            便捷方法：拒绝
    - needs_you.list:              列出请求（按优先级排序）
    - needs_you.list_all:          列出所有请求（含已解决）
    - needs_you.get:               查询单个请求
    - needs_you.cancel:            取消请求
    - needs_you.clear_resolved:    清除已解决请求
    - needs_you.stats:             统计信息
    - needs_you.reset:             重置（测试用）
    """
    service = get_global_service()

    # === 通用请求接口 ===
    def _request(
        type: str,
        title: str,
        description: str = "",
        session_id: str | None = None,
        source: str | None = None,
        timeout: float | None = None,
        **extra: Any,
    ) -> dict[str, Any]:
        """通用 needs-you 请求接口

        Args:
            type:        请求类型（approval / error / question / handoff）
            title:       卡片标题
            description: 详细描述
            session_id:  会话 ID
            source:      请求来源
            timeout:     自定义超时（仅 approval 生效，None 用默认 30s）
            **extra:     附加数据
        """
        try:
            needs_type = NeedsYouType(type)
        except ValueError as e:
            raise ValueError(
                f"invalid type: '{type}' "
                f"(expected one of {[t.value for t in NeedsYouType]})"
            ) from e

        if needs_type == NeedsYouType.APPROVAL:
            req = service.request_approval(
                title=title, description=description,
                session_id=session_id, source=source, timeout=timeout, **extra,
            )
        elif needs_type == NeedsYouType.ERROR:
            req = service.request_error(
                title=title, description=description,
                session_id=session_id, source=source, **extra,
            )
        elif needs_type == NeedsYouType.QUESTION:
            req = service.request_question(
                title=title, description=description,
                session_id=session_id, source=source, **extra,
            )
        else:  # HANDOFF
            req = service.request_handoff(
                title=title, description=description,
                session_id=session_id, source=source, **extra,
            )
        return req.to_dict()

    dispatcher.register("needs_you.request", _request)

    # === 便捷方法 ===
    dispatcher.register(
        "needs_you.request_approval",
        lambda **kw: service.request_approval(**kw).to_dict(),
    )
    dispatcher.register(
        "needs_you.request_error",
        lambda **kw: service.request_error(**kw).to_dict(),
    )
    dispatcher.register(
        "needs_you.request_question",
        lambda **kw: service.request_question(**kw).to_dict(),
    )
    dispatcher.register(
        "needs_you.request_handoff",
        lambda **kw: service.request_handoff(**kw).to_dict(),
    )

    # === 响应 API ===
    def _record_trust_maybe(req: "NeedsYouRequest", response: Any) -> None:
        """Task 5（方案书 v3.1 §4.5）：审批响应带 trust 意图时记会话级免审

        触发条件（任一）：response.decision == "trust" / response.sessionTrust
        为真。动作：⚡批准 → 会话只读免审（risk_l<=1）+ 命令首 token 加入
        会话免批前缀集（trust_store.record_session_trust 统一处理）。
        trust_store 归 strands_backend 层——延迟导入防模块环 + 容错不阻断响应。
        """
        try:
            if not isinstance(response, dict):
                return
            decision = str(response.get("decision", "")).lower()
            if decision != "trust" and not response.get("sessionTrust"):
                return
            from strands_backend.trust_store import record_session_trust

            extra = req.extra if isinstance(req.extra, dict) else {}
            record_session_trust(
                session_id=str(req.session_id or ""),
                command=str(extra.get("command", "") or ""),
                risk_l=extra.get("risk_l"),
            )
        except Exception as e:  # noqa: BLE001 — trust 记录失败不影响审批响应
            logger.warning(f"record_session_trust failed (non-fatal): {e}")

    def _respond(req_id: str, response: Any = None, responded_by: str = "user") -> dict[str, Any] | None:
        """用户响应请求

        Args:
            req_id:       请求 ID
            response:     响应内容（approval 期望 {"approved": bool, ...}）
            responded_by: 响应者标识
        """
        req = service.respond(req_id=req_id, response=response, responded_by=responded_by)
        if req is not None:
            _record_trust_maybe(req, response)
        return req.to_dict() if req else None

    def _approve(req_id: str, comment: str = "", responded_by: str = "user") -> dict[str, Any] | None:
        """批准 approval 请求（单次调用 service.approve，避免双调用副作用）"""
        req = service.approve(req_id, comment, responded_by)
        return req.to_dict() if req else None

    def _reject(req_id: str, reason: str = "", responded_by: str = "user") -> dict[str, Any] | None:
        """拒绝 approval 请求（单次调用 service.reject，避免双调用副作用）"""
        req = service.reject(req_id, reason, responded_by)
        return req.to_dict() if req else None

    def _cancel(req_id: str, reason: str = "") -> dict[str, Any] | None:
        """取消请求（单次调用 service.cancel，避免双调用副作用）"""
        req = service.cancel(req_id, reason)
        return req.to_dict() if req else None

    dispatcher.register("needs_you.respond", _respond)
    dispatcher.register("needs_you.approve", _approve)
    dispatcher.register("needs_you.reject", _reject)

    # === 查询 API ===
    dispatcher.register(
        "needs_you.list",
        lambda **kw: service.list_pending(**kw),
    )
    dispatcher.register(
        "needs_you.list_all",
        lambda **kw: service.list_all(**kw),
    )
    dispatcher.register(
        "needs_you.get",
        lambda req_id: service.get(req_id),
    )
    dispatcher.register("needs_you.cancel", _cancel)
    dispatcher.register(
        "needs_you.clear_resolved",
        lambda: {"cleared": service.clear_resolved()},
    )
    dispatcher.register(
        "needs_you.stats",
        lambda: service.get_stats(),
    )
    dispatcher.register(
        "needs_you.reset",
        lambda: (service.reset(), {"ok": True})[1],
    )

    logger.info(
        "registered 15 needs_you methods: "
        "request/request_approval/request_error/request_question/request_handoff/"
        "respond/approve/reject/list/list_all/get/cancel/clear_resolved/stats/reset"
    )


# ============================================================================
# 模块导出
# ============================================================================


__all__ = [
    # 枚举
    "NeedsYouType",
    "NeedsYouStatus",
    "NeedsYouPriority",
    # 数据结构
    "NeedsYouRequest",
    # 核心服务
    "NeedsYouService",
    # 全局实例
    "get_global_service",
    "set_event_bus",
    "start_global_service",
    "stop_global_service",
    "reset_for_test",
    # 注册
    "register_methods",
]


# ============================================================================
# 模块自检（python -m needs_you 可直接验证）
# ============================================================================


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="[%(levelname)s] %(name)s: %(message)s")

    print("=== needs_you.py self-test ===\n")

    service = NeedsYouService(approval_timeout=2.0, timeout_check_interval=0.5)
    service.start()

    # 创建各类请求
    r1 = service.request_handoff(title="测试 handoff", description="请接管", source="test")
    r2 = service.request_question(title="测试 question", description="请回答", source="test")
    r3 = service.request_approval(title="测试 approval", description="请审批", source="test")
    r4 = service.request_error(title="测试 error", description="出错了", source="test")

    print(f"Created 4 requests: {r1.id}, {r2.id}, {r3.id}, {r4.id}")
    print(f"\nPending (sorted by priority):")
    for r in service.list_pending():
        print(f"  [{r['priority']:>8}] {r['type']:<10} | {r['title']}")

    # 测试 approval 超时（2s）
    print(f"\nWaiting 3s for approval timeout (approval_timeout=2s)...")
    time.sleep(3.0)

    print(f"\nPending after timeout:")
    for r in service.list_pending():
        print(f"  [{r['priority']:>8}] {r['type']:<10} | status={r['status']}")

    print(f"\nStats: {service.get_stats()}")
    service.stop()
    print("\n=== self-test done ===")
