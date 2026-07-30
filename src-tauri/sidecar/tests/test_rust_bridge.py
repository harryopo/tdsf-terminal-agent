"""
tests/test_rust_bridge.py — RustBridge 反向 JSON-RPC 通道测试（TDSF P1-6）
=============================================================================

验证内容：
1. ``is_reverse_response(msg)`` ID 范围判定
   - id ≥ 1,000,000 且无 method → True
   - id < 1,000,000 → False（Rust→Python 请求的响应，由 main loop 原逻辑处理）
   - 有 method → False（请求/通知）
   - id 非整数 / 无 id → False

2. ``send_request(method, params)`` 正常流程
   - 主线程发 send_request 阻塞，子线程 dispatch_response → 主线程拿到 result
   - 验证 write_message 被调用且消息格式正确（jsonrpc/method/params/id）
   - 验证 ID 自增（1,000,000, 1,000,001, ...）
   - 验证 pending_count 在 send 期间 = 1，dispatch 后 = 0

3. 超时处理
   - 不发送响应，send_request 在 timeout 后抛 ``RustBridgeTimeout``
   - 超时后 pending 项被清理（pending_count = 0）
   - 后到的响应被 dispatch_response 识别为 orphan（返回 False，日志 warning）

4. Rust 返回 error 响应
   - dispatch_response 收到 ``{"error": {"code": -32000, "message": "..."}}``
   - send_request 抛 ``RustBridgeError``（携带 code + message）
   - pending 项被清理

5. ``stop()`` 关闭 bridge
   - stop 后所有 pending send_request 抛 ``RustBridgeShutdown``
   - stop 后新 send_request 抛 ``RustBridgeShutdown``
   - stop 是幂等的

6. ``write_message`` 失败
   - write_message 抛异常 → send_request 抛 ``RustBridgeIOError``
   - pending 项立即清理

7. ID 空间隔离验证（与 Rust 请求 ID 不冲突）
   - Python 反向请求 ID 从 1,000,000 开始
   - Rust 请求 ID 通常 < 1,000,000，is_reverse_response 正确区分

测试策略：
- 100% 离线测试，不依赖真实 Rust 进程或 stdout
- 用 Mock write_message 回调记录调用
- 用 threading 模拟 Rust 异步返回响应（dispatch_response 在子线程调用）
- 短超时（0.2s）加速超时测试，避免 30s 等待

运行：
    cd src-tauri/sidecar
    python -m pytest tests/test_rust_bridge.py -v
"""
from __future__ import annotations

import sys
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock

# 确保能 import rust_bridge
sys.path.insert(0, str(Path(__file__).parent.parent))

import pytest

from rust_bridge import (
    DEFAULT_TIMEOUT,
    JSONRPC_VERSION,
    RustBridge,
    RustBridgeError,
    RustBridgeIOError,
    RustBridgeShutdown,
    RustBridgeTimeout,
    _REVERSE_ID_START,
)


# ============================================================================
# 测试夹具
# ============================================================================

@pytest.fixture
def mock_write():
    """Mock write_message 回调"""
    return MagicMock()


@pytest.fixture
def bridge(mock_write):
    """标准 RustBridge 实例（默认 30s 超时）"""
    return RustBridge(write_message=mock_write)


@pytest.fixture
def fast_bridge(mock_write):
    """短超时 RustBridge（0.2s，加速超时测试）"""
    return RustBridge(write_message=mock_write, timeout=0.2)


# ============================================================================
# 1. is_reverse_response 判定
# ============================================================================

class TestIsReverseResponse:
    """is_reverse_response 消息判定"""

    def test_valid_reverse_response(self, bridge):
        """id ≥ 1,000,000 且无 method → True"""
        assert bridge.is_reverse_response({"jsonrpc": "2.0", "result": "ok", "id": 1_000_000})
        assert bridge.is_reverse_response({"jsonrpc": "2.0", "result": 42, "id": 1_999_999})
        assert bridge.is_reverse_response({"jsonrpc": "2.0", "error": {"code": -1, "message": "x"}, "id": 1_000_001})

    def test_rust_request_id_below_threshold(self, bridge):
        """id < 1,000,000 → False（Rust→Python 请求的响应，由 main loop 处理）"""
        assert not bridge.is_reverse_response({"jsonrpc": "2.0", "result": "ok", "id": 1})
        assert not bridge.is_reverse_response({"jsonrpc": "2.0", "result": "ok", "id": 999_999})
        assert not bridge.is_reverse_response({"jsonrpc": "2.0", "result": "ok", "id": 0})

    def test_method_present_is_request(self, bridge):
        """有 method → False（是请求/通知，不是响应）"""
        assert not bridge.is_reverse_response({
            "jsonrpc": "2.0", "method": "ping", "id": 1_000_000
        })
        assert not bridge.is_reverse_response({
            "jsonrpc": "2.0", "method": "agent.invoke", "params": {}, "id": 1_500_000
        })

    def test_id_not_int(self, bridge):
        """id 非整数 → False"""
        assert not bridge.is_reverse_response({"jsonrpc": "2.0", "result": "ok", "id": "1_000_000"})
        assert not bridge.is_reverse_response({"jsonrpc": "2.0", "result": "ok", "id": None})
        assert not bridge.is_reverse_response({"jsonrpc": "2.0", "result": "ok", "id": 1.5})

    def test_no_id(self, bridge):
        """无 id → False"""
        assert not bridge.is_reverse_response({"jsonrpc": "2.0", "result": "ok"})
        assert not bridge.is_reverse_response({"jsonrpc": "2.0", "method": "notify"})


# ============================================================================
# 2. send_request 正常流程
# ============================================================================

class TestSendRequestNormal:
    """send_request 正常流程（阻塞 + dispatch_response 唤醒）"""

    def test_send_and_receive(self, bridge, mock_write):
        """主线程发 send_request 阻塞，子线程 dispatch_response → 拿到 result"""
        result_holder = {}
        exc_holder = {}

        def worker():
            # 等主线程发出请求（write_message 被调用）
            time.sleep(0.05)
            # 从 mock_write 拿到请求消息，提取 id 构造响应
            call_args = mock_write.call_args
            sent_msg = call_args[0][0]
            req_id = sent_msg["id"]
            # 模拟 Rust 返回响应
            response = {
                "jsonrpc": JSONRPC_VERSION,
                "result": {"ok": True, "output": "Linux", "exitCode": 0},
                "id": req_id,
            }
            bridge.dispatch_response(response)

        t = threading.Thread(target=worker)
        t.start()

        # 主线程发送请求（阻塞）
        try:
            result = bridge.send_request("ssh_command", {"sessionId": 1, "command": "uname"})
            result_holder["result"] = result
        except Exception as e:
            exc_holder["exc"] = e

        t.join(timeout=2)

        assert exc_holder.get("exc") is None, f"unexpected exception: {exc_holder.get('exc')}"
        assert result_holder["result"] == {"ok": True, "output": "Linux", "exitCode": 0}

    def test_write_message_called_with_correct_format(self, bridge, mock_write):
        """验证 write_message 被调用且消息格式正确"""
        # 用线程立即响应
        def worker():
            time.sleep(0.05)
            req_id = mock_write.call_args[0][0]["id"]
            bridge.dispatch_response({"jsonrpc": JSONRPC_VERSION, "result": "ok", "id": req_id})

        t = threading.Thread(target=worker)
        t.start()
        bridge.send_request("ssh_command", {"sessionId": 1, "command": "ls"})
        t.join(timeout=2)

        # 验证 write_message 被调用一次
        mock_write.assert_called_once()
        sent_msg = mock_write.call_args[0][0]
        assert sent_msg["jsonrpc"] == JSONRPC_VERSION
        assert sent_msg["method"] == "ssh_command"
        assert sent_msg["params"] == {"sessionId": 1, "command": "ls"}
        assert "id" in sent_msg
        assert isinstance(sent_msg["id"], int)

    def test_id_increments_from_1m(self, bridge, mock_write):
        """ID 自增（1,000,000, 1,000,001, ...）"""
        ids = []

        def quick_respond():
            time.sleep(0.02)
            req_id = mock_write.call_args[0][0]["id"]
            ids.append(req_id)
            bridge.dispatch_response({"jsonrpc": JSONRPC_VERSION, "result": None, "id": req_id})

        t1 = threading.Thread(target=quick_respond)
        t1.start()
        bridge.send_request("m1", {})
        t1.join(timeout=2)

        t2 = threading.Thread(target=quick_respond)
        t2.start()
        bridge.send_request("m2", {})
        t2.join(timeout=2)

        assert len(ids) == 2
        assert ids[0] == _REVERSE_ID_START
        assert ids[1] == _REVERSE_ID_START + 1

    def test_pending_count_lifecycle(self, bridge, mock_write):
        """pending_count 在 send 期间 = 1，dispatch 后 = 0"""
        counts_during = []

        def worker():
            time.sleep(0.05)
            counts_during.append(bridge.pending_count())  # 应为 1
            req_id = mock_write.call_args[0][0]["id"]
            bridge.dispatch_response({"jsonrpc": JSONRPC_VERSION, "result": "ok", "id": req_id})

        t = threading.Thread(target=worker)
        t.start()
        assert bridge.pending_count() == 0  # 发送前
        bridge.send_request("ssh_command", {})
        t.join(timeout=2)
        assert bridge.pending_count() == 0  # 完成后
        assert counts_during == [1]


# ============================================================================
# 3. 超时处理
# ============================================================================

class TestTimeout:
    """超时处理"""

    def test_timeout_raises(self, fast_bridge):
        """不响应，send_request 在 timeout 后抛 RustBridgeTimeout"""
        with pytest.raises(RustBridgeTimeout) as exc_info:
            fast_bridge.send_request("ssh_command", {})
        assert exc_info.value.method == "ssh_command"
        assert exc_info.value.timeout == 0.2

    def test_timeout_cleans_pending(self, fast_bridge):
        """超时后 pending 项被清理"""
        with pytest.raises(RustBridgeTimeout):
            fast_bridge.send_request("ssh_command", {})
        assert fast_bridge.pending_count() == 0

    def test_late_response_is_orphan(self, fast_bridge, mock_write):
        """超时后到的响应被识别为 orphan（返回 False）"""
        # 发起请求（会超时）
        with pytest.raises(RustBridgeTimeout):
            fast_bridge.send_request("ssh_command", {})

        # 从 mock_write 拿到已超时请求的 id，模拟延迟响应
        sent_msg = mock_write.call_args[0][0]
        req_id = sent_msg["id"]
        late_response = {"jsonrpc": JSONRPC_VERSION, "result": "late", "id": req_id}

        # dispatch 应返回 False（orphan）
        result = fast_bridge.dispatch_response(late_response)
        assert result is False
        # pending 仍为 0（orphan 不创建新 pending）
        assert fast_bridge.pending_count() == 0


# ============================================================================
# 4. Rust 返回 error 响应
# ============================================================================

class TestErrorResponse:
    """Rust 返回 error 响应"""

    def test_error_response_raises(self, bridge, mock_write):
        """dispatch_response 收到 error → send_request 抛 RustBridgeError"""
        exc_holder = {}

        def worker():
            time.sleep(0.05)
            req_id = mock_write.call_args[0][0]["id"]
            error_response = {
                "jsonrpc": JSONRPC_VERSION,
                "error": {
                    "code": -32000,
                    "message": "SSH session not found",
                    "data": {"sessionId": 999},
                },
                "id": req_id,
            }
            bridge.dispatch_response(error_response)

        t = threading.Thread(target=worker)
        t.start()

        with pytest.raises(RustBridgeError) as exc_info:
            bridge.send_request("ssh_command", {"sessionId": 999, "command": "ls"})
        t.join(timeout=2)

        assert exc_info.value.code == -32000
        assert "SSH session not found" in exc_info.value.message
        assert exc_info.value.data == {"sessionId": 999}
        # pending 已清理
        assert bridge.pending_count() == 0

    def test_error_response_default_code(self, bridge, mock_write):
        """error 响应无 code 字段 → 默认 -32000"""
        def worker():
            time.sleep(0.05)
            req_id = mock_write.call_args[0][0]["id"]
            bridge.dispatch_response({
                "jsonrpc": JSONRPC_VERSION,
                "error": {"message": "unknown"},
                "id": req_id,
            })

        t = threading.Thread(target=worker)
        t.start()
        with pytest.raises(RustBridgeError) as exc_info:
            bridge.send_request("m", {})
        t.join(timeout=2)
        assert exc_info.value.code == -32000
        assert exc_info.value.message == "unknown"


# ============================================================================
# 5. stop() 关闭 bridge
# ============================================================================

class TestStop:
    """stop() 关闭 bridge"""

    def test_stop_wakes_pending(self, bridge, mock_write):
        """stop 后所有 pending send_request 抛 RustBridgeShutdown"""
        exc_holder = {}

        def stopper():
            time.sleep(0.05)
            bridge.stop()

        t = threading.Thread(target=stopper)
        t.start()

        try:
            bridge.send_request("ssh_command", {})
        except RustBridgeShutdown as e:
            exc_holder["exc"] = e
        t.join(timeout=2)

        assert exc_holder.get("exc") is not None

    def test_send_after_stop_raises(self, bridge):
        """stop 后新 send_request 立即抛 RustBridgeShutdown"""
        bridge.stop()
        with pytest.raises(RustBridgeShutdown):
            bridge.send_request("m", {})

    def test_stop_idempotent(self, bridge):
        """stop 幂等（多次调用不报错）"""
        bridge.stop()
        bridge.stop()  # 不抛异常
        assert bridge.is_shutdown()

    def test_stop_cleans_pending(self, bridge, mock_write):
        """stop 清理所有 pending"""
        def stopper():
            time.sleep(0.05)
            bridge.stop()

        t = threading.Thread(target=stopper)
        t.start()
        try:
            bridge.send_request("m", {})
        except RustBridgeShutdown:
            pass
        t.join(timeout=2)
        assert bridge.pending_count() == 0


# ============================================================================
# 6. write_message 失败
# ============================================================================

class TestWriteFailure:
    """write_message 失败"""

    def test_write_failure_raises_io_error(self, mock_write):
        """write_message 抛异常 → send_request 抛 RustBridgeIOError"""
        mock_write.side_effect = OSError("stdout closed")
        bridge = RustBridge(write_message=mock_write)

        with pytest.raises(RustBridgeIOError) as exc_info:
            bridge.send_request("m", {})
        assert "stdout closed" in str(exc_info.value)
        # pending 已清理
        assert bridge.pending_count() == 0


# ============================================================================
# 7. ID 空间隔离验证
# ============================================================================

class TestIdSpaceIsolation:
    """ID 空间隔离（与 Rust 请求 ID 不冲突）"""

    def test_reverse_id_starts_at_1m(self):
        """Python 反向请求 ID 从 1,000,000 开始"""
        assert _REVERSE_ID_START == 1_000_000

    def test_rust_response_below_1m_not_reverse(self, bridge):
        """Rust 请求 ID < 1,000,000 不被识别为反向响应"""
        # 模拟 Rust→Python 请求的响应（id=1, 2, ...）
        # 这些应该被 main loop 原逻辑处理，不是 dispatch_response
        assert not bridge.is_reverse_response({"jsonrpc": "2.0", "result": "ok", "id": 1})
        assert not bridge.is_reverse_response({"jsonrpc": "2.0", "result": "ok", "id": 999_999})

    def test_first_reverse_id_is_1m(self, bridge, mock_write):
        """第一个反向请求 ID = 1,000,000"""
        def worker():
            time.sleep(0.02)
            req_id = mock_write.call_args[0][0]["id"]
            bridge.dispatch_response({"jsonrpc": JSONRPC_VERSION, "result": None, "id": req_id})

        t = threading.Thread(target=worker)
        t.start()
        bridge.send_request("m", {})
        t.join(timeout=2)

        sent_msg = mock_write.call_args[0][0]
        assert sent_msg["id"] == 1_000_000


# ============================================================================
# 8. 默认超时与常量
# ============================================================================

class TestConstants:
    """常量验证"""

    def test_default_timeout_is_30s(self):
        """默认超时 30s（与 Rust 侧 REQUEST_TIMEOUT 对齐）"""
        assert DEFAULT_TIMEOUT == 30.0

    def test_jsonrpc_version(self):
        """JSON-RPC 版本 2.0"""
        assert JSONRPC_VERSION == "2.0"

    def test_custom_timeout(self, mock_write):
        """自定义超时生效"""
        bridge = RustBridge(write_message=mock_write, timeout=5.0)
        assert bridge._timeout == 5.0
