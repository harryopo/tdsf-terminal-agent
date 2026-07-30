"""
rust_bridge.py — Python→Rust 反向 JSON-RPC 通道（TDSF P1-3）
=============================================================

职责：
- 维护 pending 请求表（id → Event + result 槽）
- ``send_request_to_rust(method, params)`` 阻塞等待响应（30s 超时）
- ``dispatch_response(msg)`` 处理 Rust→Python 响应（id 匹配 pending）

ID 空间隔离（与 Rust 侧 reader_task 文档对齐）：
- Rust 请求 ID：1, 2, 3...（AtomicI64，从 1 开始）
- Python 反向请求 ID：1,000,000+（本模块 counter，避免与 Rust 冲突）
- Rust reader_task 路由时根据 id 数值匹配 pending_requests（Rust）
  或 pending_reverse（Python）。

线程安全：
- ``_pending`` 字典受 ``threading.Lock`` 保护
- 每个请求用 ``threading.Event`` 同步（wait/set）
- 超时自动清理（避免内存泄漏）

使用：
    from rust_bridge import RustBridge

    # 1. 在 main.py 启动时创建 bridge，注入 write_message 回调
    bridge = RustBridge(write_message_callback=write_message)

    # 2. 业务代码（如 Strands 工具）调用 send_request_to_rust 阻塞等响应
    result = bridge.send_request("ssh_command", {"sessionId": 1, "command": "ls"})

    # 3. 主循环收到消息时，先判定是否是 Rust 返回的响应：
    if bridge.is_reverse_response(msg):
        bridge.dispatch_response(msg)
    else:
        # 走原有 dispatch 逻辑
        ...

错误处理：
- 超时：抛 ``RustBridgeTimeout``（调用方决定降级策略，工具层通常返回
  ``{"status": "error", "reason": "timeout"}`` 结构化结果）
- Rust 返回 error：抛 ``RustBridgeError``（携带 code + message）
- write_message 失败：抛 ``RustBridgeIOError``

设计要点：
1. send_request_to_rust 是**阻塞**调用（最长 30s），适合 Strands 工具
   在线程内执行；不适合在主循环线程调用（会阻塞 stdin 读取）。
2. 所有阻塞在 Event.wait 的请求，在 stop() 时会被强制唤醒并抛
   RustBridgeShutdown，避免主线程退出时悬挂。
3. GC：超时请求的 Event 会被丢弃，pending 项在 dispatch_response 时
   检测到超时自动清理（lazy cleanup，不需要单独线程）。
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Any, Callable

logger = logging.getLogger("sidecar.rust_bridge")

# ============================================================================
# 常量
# ============================================================================

#: Python 反向请求 ID 起点（≥1,000,000，与 Rust 请求 ID 1,2,3... 隔离）
_REVERSE_ID_START = 1_000_000

#: 默认请求超时（30s，与 Rust 侧 REQUEST_TIMEOUT 对齐）
DEFAULT_TIMEOUT = 30.0

#: JSON-RPC 版本
JSONRPC_VERSION = "2.0"


# ============================================================================
# 异常类型
# ============================================================================

class RustBridgeError(Exception):
    """RustBridge 基础异常（Rust 返回 error 响应时抛）"""

    def __init__(self, code: int, message: str, data: Any = None) -> None:
        self.code = code
        self.message = message
        self.data = data
        super().__init__(f"[{code}] {message}")


class RustBridgeTimeout(Exception):
    """RustBridge 请求超时（30s 未收到响应）"""

    def __init__(self, method: str, timeout: float) -> None:
        self.method = method
        self.timeout = timeout
        super().__init__(f"rust_bridge request timeout: method={method} timeout={timeout}s")


class RustBridgeShutdown(Exception):
    """RustBridge 已关闭（stop() 后所有 pending 请求被强制失败）"""

    pass


class RustBridgeIOError(Exception):
    """write_message 失败（stdout 写入异常）"""

    pass


# ============================================================================
# _PendingEntry — 单个 pending 请求的同步结构
# ============================================================================

class _PendingEntry:
    """单个 pending 请求的同步结构（线程间通信）"""

    __slots__ = ("event", "result", "error", "method", "created_at")

    def __init__(self, method: str) -> None:
        self.event: threading.Event = threading.Event()
        self.result: Any = None
        self.error: RustBridgeError | None = None
        self.method: str = method
        self.created_at: float = time.time()


# ============================================================================
# RustBridge — 反向 JSON-RPC 通道
# ============================================================================

class RustBridge:
    """Python→Rust 反向 JSON-RPC 通道

    Args:
        write_message: 写消息到 stdout 的回调（main.py 注入 ``write_message``）。
                       签名 ``(msg: dict) -> None``，内部已加锁线程安全。
        timeout: 默认请求超时（秒），默认 30s。

    用法见模块 docstring。
    """

    def __init__(
        self,
        write_message: Callable[[dict], None],
        timeout: float = DEFAULT_TIMEOUT,
    ) -> None:
        self._write_message = write_message
        self._timeout = timeout

        # pending 请求表：id → _PendingEntry
        self._pending: dict[int, _PendingEntry] = {}
        self._lock = threading.Lock()

        # 反向请求 ID counter（线程安全，从 1,000,000 自增）
        self._next_id = _REVERSE_ID_START
        self._id_lock = threading.Lock()

        # shutdown 标志（stop() 后所有 send_request 立即失败）
        self._shutdown = False

    # ----------------------------------------------------------------------
    # 公共 API
    # ----------------------------------------------------------------------

    def send_request(self, method: str, params: dict[str, Any]) -> Any:
        """发起反向 JSON-RPC 请求，阻塞等待 Rust 响应

        Args:
            method: Rust 侧命令名（如 "ssh_command" / "sftp_read"）
            params: 命令参数（dict，camelCase 键，与 Tauri invoke 一致）

        Returns:
            Rust 命令的返回值（result 字段）

        Raises:
            RustBridgeShutdown: bridge 已 stop()
            RustBridgeIOError: write_message 失败
            RustBridgeTimeout: 30s 未收到响应
            RustBridgeError: Rust 返回 error 响应
        """
        if self._shutdown:
            raise RustBridgeShutdown(f"rust_bridge is shutdown, cannot send: {method}")

        # 1. 分配 ID
        with self._id_lock:
            req_id = self._next_id
            self._next_id += 1

        # 2. 注册 pending entry
        entry = _PendingEntry(method)
        with self._lock:
            self._pending[req_id] = entry

        # 3. 构造 JSON-RPC request 并发送到 stdout
        msg = {
            "jsonrpc": JSONRPC_VERSION,
            "method": method,
            "params": params,
            "id": req_id,
        }
        try:
            self._write_message(msg)
        except Exception as e:
            # write 失败，立即清理 pending 项
            with self._lock:
                self._pending.pop(req_id, None)
            logger.error(f"rust_bridge write failed: method={method} id={req_id} err={e}")
            raise RustBridgeIOError(f"write_message failed: {e}") from e

        logger.debug(f"rust_bridge sent: method={method} id={req_id}")

        # 4. 阻塞等待响应（最长 timeout 秒）
        if not entry.event.wait(timeout=self._timeout):
            # 超时：清理 pending 项
            with self._lock:
                self._pending.pop(req_id, None)
            logger.warning(
                f"rust_bridge timeout: method={method} id={req_id} "
                f"timeout={self._timeout}s"
            )
            raise RustBridgeTimeout(method, self._timeout)

        # 5. shutdown 期间被强制唤醒
        if self._shutdown:
            with self._lock:
                self._pending.pop(req_id, None)
            raise RustBridgeShutdown(f"rust_bridge shutdown during request: {method}")

        # 6. 检查 error
        if entry.error is not None:
            raise entry.error

        # 7. 返回 result
        return entry.result

    def is_reverse_response(self, msg: dict) -> bool:
        """判定消息是否是 Rust 返回的反向请求响应

        判定规则：
        - 有 ``id`` 字段（数值型）
        - 无 ``method`` 字段（响应不带 method）
        - id ≥ 1,000,000（Python 反向请求 ID 范围）

        Args:
            msg: 解析后的 JSON-RPC 消息

        Returns:
            True = 是反向请求响应，应调 dispatch_response
            False = 不是（走原有 dispatch 逻辑）
        """
        if "method" in msg:
            return False
        msg_id = msg.get("id")
        if not isinstance(msg_id, int):
            return False
        return msg_id >= _REVERSE_ID_START

    def dispatch_response(self, msg: dict) -> bool:
        """处理 Rust 返回的反向请求响应

        Args:
            msg: 解析后的 JSON-RPC 消息（已通过 is_reverse_response 判定）

        Returns:
            True = 成功分发到对应 pending 请求
            False = 没找到对应 pending（可能是超时后被清理，或 ID 错误）
        """
        msg_id = msg.get("id")
        if not isinstance(msg_id, int):
            return False

        with self._lock:
            entry = self._pending.pop(msg_id, None)

        if entry is None:
            # pending 项已被超时清理（或 ID 错误），忽略响应
            logger.warning(
                f"rust_bridge orphan response: id={msg_id} "
                f"(likely timeout cleanup or unknown id)"
            )
            return False

        # 检查 error 字段
        if "error" in msg:
            err = msg["error"]
            code = err.get("code", -32000)
            message = err.get("message", "unknown error")
            data = err.get("data")
            entry.error = RustBridgeError(code, message, data)
            logger.warning(
                f"rust_bridge error response: method={entry.method} "
                f"id={msg_id} code={code} message={message}"
            )
        else:
            entry.result = msg.get("result")
            logger.debug(
                f"rust_bridge response ok: method={entry.method} id={msg_id}"
            )

        # 唤醒等待的 send_request
        entry.event.set()
        return True

    def stop(self) -> None:
        """关闭 bridge，强制失败所有 pending 请求

        在 main.py 退出清理时调用。所有阻塞在 ``send_request`` 的线程
        会被唤醒并抛 ``RustBridgeShutdown``。
        """
        self._shutdown = True
        with self._lock:
            entries = list(self._pending.values())
            self._pending.clear()
        for entry in entries:
            entry.event.set()  # 唤醒等待线程

    def pending_count(self) -> int:
        """当前 pending 请求数量（诊断/监控用）"""
        with self._lock:
            return len(self._pending)

    def is_shutdown(self) -> bool:
        """是否已关闭"""
        return self._shutdown
